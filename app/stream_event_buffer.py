"""FIFO for one live subscriber, with a bounded RAM prefix and private spill.

This is temporary delivery storage, not a restart/replay journal. The producer
never waits for the consumer to make room. Spill uses synchronous local file
I/O outside the bridge's shared lock; it does not promise nonblocking disks.
"""
from collections import deque
import json
import os
import queue
import struct
import tempfile
import threading
import time


class StreamBufferError(Exception):
    """Fixed public failure; never include source events or filesystem paths."""
    code = 'codex_stream_storage_failed'

    def __init__(self):
        super().__init__('本机暂时无法保存或读取生成中的内容，本次生成未完成。已收到的内容保留，请检查可用磁盘空间后再试。')


class StreamBufferClosed(StreamBufferError):
    code = 'codex_unavailable'

    def __init__(self):
        Exception.__init__(self, 'OpenAI 本地连接已关闭，请重新连接。')


class StreamEventBuffer:
    def __init__(self, max_events=64, max_bytes=256 * 1024, directory=None):
        if not isinstance(max_events, int) or max_events < 0 or not isinstance(max_bytes, int) or max_bytes < 0:
            raise ValueError('Invalid delivery memory budget')
        self.max_events, self.max_bytes = max_events, max_bytes
        self._condition = threading.Condition()
        self._producer = threading.Lock()
        self._consumer = threading.Lock()
        self._memory = deque()
        self._memory_bytes = 0
        self._spilling = False
        self._written = self._read = self._count = 0
        self._closed = self._failed = False
        self._directory = self._file = None
        try:
            self._directory = tempfile.TemporaryDirectory(prefix='ai-bro-stream-', dir=directory)
            os.chmod(self._directory.name, 0o700)
            # TemporaryFile is unlinked on opening on macOS/POSIX. Even a hard
            # process exit releases its data; only an empty private dir may
            # remain. No credential/raw runtime notification enters this file.
            self._file = tempfile.TemporaryFile(mode='w+b', dir=self._directory.name)
            os.fchmod(self._file.fileno(), 0o600)
        except (OSError, ValueError):
            self.close()
            raise StreamBufferError() from None

    def _fail(self):
        with self._condition:
            self._failed = True
            self._condition.notify_all()

    @staticmethod
    def _write_all(fd, data, offset):
        view = memoryview(data)
        while view:
            written = os.pwrite(fd, view, offset)
            if written <= 0: raise OSError('Short stream write')
            view = view[written:]
            offset += written

    @staticmethod
    def _read_exact(fd, size, offset):
        parts = []
        while size:
            part = os.pread(fd, min(size, 1024 * 1024), offset)
            if not part: raise OSError('Short stream read')
            parts.append(part)
            size -= len(part)
            offset += len(part)
        return b''.join(parts)

    def put(self, event):
        """Accept in FIFO order without waiting for consumption; false on fault.

        The serialized current event is transient and can exceed the cache
        budget. It then goes directly to disk: a valid answer is never cut to
        a display limit. The upstream JSON-line parser still owns that frame.
        """
        with self._producer:
            with self._condition:
                if self._closed or self._failed: return False
            try:
                encoded = json.dumps(event, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                with self._condition:
                    if self._closed or self._failed: return False
                    if not self._spilling and len(self._memory) < self.max_events and self._memory_bytes + len(encoded) <= self.max_bytes:
                        self._memory.append(encoded)
                        self._memory_bytes += len(encoded)
                        self._count += 1
                        self._condition.notify()
                        return True
                    self._spilling = True
                    fd = os.dup(self._file.fileno())
                    offset = self._written
                try:
                    self._write_all(fd, struct.pack('!Q', len(encoded)), offset)
                    self._write_all(fd, encoded, offset + 8)
                finally:
                    os.close(fd)
                with self._condition:
                    if self._closed: return False
                    # A partial record is never published to the consumer.
                    self._written = offset + 8 + len(encoded)
                    self._count += 1
                    self._condition.notify()
                return True
            except (OSError, ValueError, TypeError, OverflowError):
                self._fail()
                return False

    def get(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._consumer:
            with self._condition:
                while not self._count:
                    if self._failed: raise StreamBufferError()
                    if self._closed: raise StreamBufferClosed()
                    remaining = None if deadline is None else deadline - time.monotonic()
                    if remaining is not None and remaining <= 0: raise queue.Empty()
                    self._condition.wait(remaining)
                if self._memory:
                    encoded = self._memory.popleft()
                    self._memory_bytes -= len(encoded)
                    self._count -= 1
                    fd = None
                else:
                    try: fd = os.dup(self._file.fileno())
                    except (OSError, ValueError):
                        self._failed = True
                        raise StreamBufferError() from None
                    offset, end = self._read, self._written
            try:
                if fd is not None:
                    length = struct.unpack('!Q', self._read_exact(fd, 8, offset))[0]
                    if length > end - offset - 8: raise OSError('Invalid stream record')
                    encoded = self._read_exact(fd, length, offset + 8)
                event = json.loads(encoded)
                with self._condition:
                    if self._closed: raise StreamBufferClosed()
                    if fd is not None:
                        self._read = offset + 8 + length
                        self._count -= 1
                return event
            except (OSError, ValueError, TypeError, struct.error):
                self._fail()
                raise StreamBufferError() from None
            finally:
                if fd is not None: os.close(fd)

    def inspect(self):
        with self._condition:
            return {'memory_events': len(self._memory), 'memory_bytes': self._memory_bytes,
                    'max_events': self.max_events, 'max_bytes': self.max_bytes,
                    'pending_events': self._count, 'pending_disk_bytes': 0 if self._closed else self._written - self._read,
                    'written_disk_bytes': self._written, 'failed': self._failed, 'closed': self._closed}

    def qsize(self):
        with self._condition: return self._count

    def close(self):
        with self._condition:
            if self._closed: return
            self._closed = True
            self._memory.clear()
            self._memory_bytes = self._count = 0
            owned_file, owned_directory = self._file, self._directory
            self._file = self._directory = None
            self._condition.notify_all()
        if owned_file is not None: owned_file.close()
        if owned_directory is not None: owned_directory.cleanup()
