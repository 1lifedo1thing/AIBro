"""Device-local ordinary-note drafts, separate from workspace/sync/Wiki data.

The server holds WorkspaceStore.lock around these calls so visibility checks
and writes share the workspace transaction. A second, filesystem lock makes
draft CAS safe across store instances, including independent backend processes.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

from comparison_drafts import DraftError, _is_private, _private_project


# Three 1,000,000-character fields (original/current/AI candidate) can need
# 18 MB with JSON escaping. 24 MiB leaves room for candidate metadata without
# persisting full revision history: base is a SHA-256 conflict marker.
MAX_BYTES = 24 * 1024 * 1024
MAX_CONTENT = 1_000_000
MAX_TITLE = 240
MAX_FOLDER = 500
SAFE_ID = re.compile(r"^[^\x00-\x1f\x7f`]{1,200}$")
BASE = re.compile(r"^sha256:[0-9a-f]{64}$")
REQUIRED = {"id", "base", "originalTitle", "originalContent", "originalFolderPath", "title", "content", "folderPath"}
OPTIONAL = {"appliedAiDraft", "retainedDraft"}


def validate_id(identifier):
    if not isinstance(identifier, str) or not SAFE_ID.fullmatch(identifier):
        raise DraftError("笔记草稿标识无效。")
    try:
        identifier.encode("utf-8")
    except UnicodeError as error:
        raise DraftError("笔记草稿标识编码无效。") from error
    return identifier


def decode_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("non-finite value")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def validate_session(session, identifier):
    if not isinstance(session, dict) or not REQUIRED <= set(session) or set(session) - REQUIRED - OPTIONAL:
        raise DraftError("笔记草稿会话格式无效。")
    if session.get("id") != identifier:
        raise DraftError("笔记草稿与请求的笔记标识不一致。")
    if not isinstance(session.get("base"), str) or not BASE.fullmatch(session["base"]):
        raise DraftError("笔记草稿基准版本必须是 SHA-256 标记。")
    for key, limit, label in (("title", MAX_TITLE, "标题"), ("originalTitle", MAX_TITLE, "原始标题"),
                              ("content", MAX_CONTENT, "正文"), ("originalContent", MAX_CONTENT, "原始正文"),
                              ("folderPath", MAX_FOLDER, "目录"), ("originalFolderPath", MAX_FOLDER, "原始目录")):
        if not isinstance(session[key], str):
            raise DraftError(f"笔记草稿{label}格式无效。")
        if len(session[key]) > limit:
            raise DraftError(f"笔记草稿{label}最多 {limit:,} 个字符，未截断或保存。", 413, "draft_too_large")
    if "appliedAiDraft" in session and not isinstance(session["appliedAiDraft"], str):
        raise DraftError("笔记草稿的 AI 候选标记格式无效。")
    if "retainedDraft" in session and type(session["retainedDraft"]) is not bool:
        raise DraftError("笔记草稿保留状态无效。")
    return session


def _matches(state, collection, identifier):
    return [item for item in state.get(collection, []) if isinstance(item, dict) and item.get("id") == identifier] if identifier else []


def _active(value):
    return (not any(value.get(field) for field in ("archived", "archivedAt", "deleted", "deletedAt"))
            and value.get("status") not in ("archived", "deleted"))


def blocked_reason(state, identifier):
    """Recheck current note/project and all known run/conversation origins."""
    if not isinstance(state, dict):
        return "unavailable"
    notes = _matches(state, "notes", identifier)
    if len(notes) != 1:
        return "private" if any(_is_private(note) for note in notes) else "unavailable"
    note = notes[0]
    if _is_private(note):
        return "private"
    if not _active(note):
        return "unavailable"
    if note.get("projectId"):
        projects = _matches(state, "projects", note["projectId"])
        if _private_project(state, note["projectId"]):
            return "private"
        if len(projects) != 1 or not _active(projects[0]):
            return "unavailable"
    runs = _matches(state, "agentRuns", note.get("agentRunId"))
    if len(runs) > 1 or any(_is_private(run) or _private_project(state, run.get("projectId")) for run in runs):
        return "private"
    conversation_ids = {note.get("sourceConversationId"), *(run.get("conversationId") for run in runs)} - {None, ""}
    for conversation_id in conversation_ids:
        conversations = _matches(state, "conversations", conversation_id)
        if len(conversations) > 1 or any(_is_private(value) or _private_project(state, value.get("projectId")) for value in conversations):
            return "private"
    return None


class NoteDraftStore:
    def __init__(self, directory, load_state, atomic_write=None):
        self.root = Path(directory)
        self.directory = self.root / ".note-drafts"
        self.load_state = load_state
        self._atomic_write = atomic_write or self.atomic_write

    def path_for(self, identifier):
        validate_id(identifier)
        return self.directory / (hashlib.sha256(identifier.encode("utf-8")).hexdigest() + ".json")

    @staticmethod
    def _safe(metadata, directory=False, private=True):
        expected = stat.S_ISDIR if directory else stat.S_ISREG
        return expected(metadata.st_mode) and metadata.st_uid == os.getuid() and (directory or metadata.st_nlink == 1) and (not private or not metadata.st_mode & 0o077)

    @contextmanager
    def _directory(self, create=False):
        descriptor = None
        try:
            # The workspace itself may use ordinary directory permissions; the
            # private child and every file we read/write must be owner-only.
            if self.root.is_symlink() or self.root.exists() and (not self._safe(self.root.lstat(), directory=True, private=False) or self.root.lstat().st_mode & 0o022):
                raise OSError("invalid workspace directory")
            if create:
                self.root.mkdir(parents=True, exist_ok=True)
                try:
                    self.directory.mkdir(mode=0o700)
                except FileExistsError:
                    pass
                else:
                    parent_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        os.fsync(parent_fd)
                    finally:
                        os.close(parent_fd)
            if not self.directory.exists() and not self.directory.is_symlink():
                yield None
                return
            descriptor = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            if not self._safe(os.fstat(descriptor), directory=True):
                raise OSError("invalid draft directory")
        except OSError as error:
            if descriptor is not None:
                os.close(descriptor)
            raise DraftError("笔记草稿存储目录或权限异常，原文件未修改。", 500, "draft_storage_path") from error
        try:
            yield descriptor
        finally:
            if descriptor is not None:
                os.close(descriptor)

    @contextmanager
    def _lock(self):
        with self._directory(create=True) as directory_fd:
            descriptor = None
            try:
                # macOS can return ENOENT for one concurrent openat(O_CREAT)
                # caller. Exclusive creation followed by opening the existing
                # inode is deterministic and also avoids following a link.
                try:
                    descriptor = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
                except FileExistsError:
                    descriptor = os.open(".lock", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                if not self._safe(os.fstat(descriptor)):
                    raise OSError("invalid lock file")
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            except OSError as error:
                if descriptor is not None:
                    os.close(descriptor)
                raise DraftError("笔记草稿锁定文件或权限异常，原文件未修改。", 500, "draft_storage_path") from error
            try:
                yield
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

    @staticmethod
    def atomic_write(path, raw):
        """Replace only after file fsync; acknowledge only after directory fsync."""
        path = Path(path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        temporary = ".write-" + secrets.token_hex(16)
        descriptor = None
        try:
            if not NoteDraftStore._safe(os.fstat(directory_fd), directory=True):
                raise OSError("invalid draft directory")
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = None
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path.name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            os.fsync(directory_fd)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
            os.close(directory_fd)

    def _read(self, identifier):
        empty = {"version": 1, "id": identifier, "revision": 0, "session": None, "updatedAt": None}
        with self._directory() as directory_fd:
            if directory_fd is None:
                return empty
            try:
                descriptor = os.open(self.path_for(identifier).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            except FileNotFoundError:
                return empty
            except OSError as error:
                raise DraftError("笔记草稿存储路径异常，原文件未修改。", 500, "draft_storage_path") from error
            metadata = os.fstat(descriptor)
            if not self._safe(metadata):
                os.close(descriptor)
                raise DraftError("笔记草稿文件或权限异常，原文件未修改。", 500, "draft_storage_path")
            try:
                with os.fdopen(descriptor, "rb") as handle:
                    if metadata.st_size > MAX_BYTES:
                        raise ValueError("oversized file")
                    raw = handle.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise ValueError("oversized file")
                record = decode_json(raw)
                if (not isinstance(record, dict) or set(record) != {"version", "id", "revision", "session", "updatedAt"}
                        or type(record.get("version")) is not int or record["version"] != 1 or record.get("id") != identifier
                        or type(record.get("revision")) is not int or not 1 <= record["revision"] <= 2**53 - 1
                        or type(record.get("updatedAt")) is not int or record["updatedAt"] < 0):
                    raise ValueError("invalid record")
                if record["session"] is not None:
                    validate_session(record["session"], identifier)
                return record
            except DraftError as error:
                if error.code == "draft_storage_path":
                    raise
                raise DraftError("笔记草稿存储内容损坏；原文件已保留。", 500, "draft_storage_corrupt") from error
            except (OSError, ValueError, TypeError, UnicodeError, RecursionError) as error:
                raise DraftError("笔记草稿存储无法读取；原文件已保留。", 500, "draft_storage_corrupt") from error

    def get(self, identifier):
        validate_id(identifier)
        record = self._read(identifier)
        reason = blocked_reason(self.load_state(), identifier)
        return {"revision": record["revision"], "session": None if reason else record["session"], "updatedAt": record["updatedAt"], **({"blocked": reason} if reason else {})}

    def put(self, identifier, payload):
        validate_id(identifier)
        if (not isinstance(payload, dict) or set(payload) != {"revision", "session"}
                or type(payload.get("revision")) is not int or not 0 <= payload["revision"] < 2**53 - 1):
            raise DraftError("笔记草稿保存请求格式无效。")
        session = payload["session"]
        if session is not None:
            validate_session(session, identifier)
        # Privacy is checked before creating even a private persistence directory.
        reason = blocked_reason(self.load_state(), identifier)
        if session is not None and reason:
            raise DraftError("私密或无痕笔记只能在当前窗口保留草稿。" if reason == "private" else "笔记或所属项目已删除、归档或不可访问，草稿未写入。", 403 if reason == "private" else 409, "draft_" + reason)
        with self._lock():
            current = self._read(identifier)
            if payload["revision"] != current["revision"]:
                raise DraftError("另一窗口已更新这篇笔记的草稿；请保留当前文字并重新载入草稿。", 409, "draft_conflict")
            reason = blocked_reason(self.load_state(), identifier)
            if session is not None and reason:
                raise DraftError("私密或无痕笔记只能在当前窗口保留草稿。" if reason == "private" else "笔记或所属项目已删除、归档或不可访问，草稿未写入。", 403 if reason == "private" else 409, "draft_" + reason)
            record = {"version": 1, "id": identifier, "revision": current["revision"] + 1, "session": session, "updatedAt": int(time.time() * 1000)}
            try:
                raw = json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            except (ValueError, TypeError, UnicodeError) as error:
                raise DraftError("笔记草稿文字编码无效，未保存。") from error
            if len(raw) > MAX_BYTES:
                raise DraftError("笔记草稿超过 24 MiB 本机恢复上限（含原稿、现稿和 AI 候选），未截断或保存。", 413, "draft_too_large")
            try:
                self._atomic_write(self.path_for(identifier), raw)
            except OSError as error:
                raise DraftError("笔记草稿未确认写入磁盘；请保留当前编辑内容并重试。", 503, "draft_write_failed") from error
        return {"revision": record["revision"], "session": session, "updatedAt": record["updatedAt"], "cleared": session is None}
