"""Synthetic live-delivery budget tests. Never start the installed Codex."""
import gc
import errno
import json
import os
from pathlib import Path
import queue
import stat
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import codex_bridge
from codex_bridge import CodexBridge, public_notification
from stream_event_buffer import StreamEventBuffer, StreamBufferError, StreamBufferClosed


def event(method='item/agentMessage/delta', thread='thread', turn_id='turn', **params):
    return {'method': method, 'params': {'threadId': thread, 'turnId': turn_id, **params}}


class FakeBridge(CodexBridge):
    def __init__(self, directory):
        super().__init__(directory, command=[])
        self.calls = []

    def rpc(self, method, params):
        self.calls.append((method, params))
        if method == 'thread/start': return {'thread': {'id': 'thread'}}
        if method == 'turn/start': return {'turn': {'id': 'turn'}}
        raise AssertionError(method)

    def _request(self, method, params, timeout=15):
        self.calls.append((method, params))
        return {}


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ai-bro-buffer-test-')
        self.addCleanup(self.temp.cleanup)

    def buffer(self, **kwargs):
        value = StreamEventBuffer(directory=self.temp.name, **kwargs)
        self.addCleanup(value.close)
        return value

    def bridge(self, **budgets):
        bridge = FakeBridge(Path(self.temp.name))
        self.addCleanup(bridge.close)
        buffer = self.buffer(**budgets)
        with patch.object(codex_bridge, 'StreamEventBuffer', return_value=buffer):
            stream = bridge.respond('synthetic', [])
            self.assertEqual(next(stream)['type'], 'response.in_progress')
            self.assertEqual(next(stream)['type'], 'response.in_progress')
        self.addCleanup(stream.close)
        return bridge, buffer, stream

    def test_fifo_spills_instead_of_truncating_or_waiting_for_consumer(self):
        value = self.buffer(max_events=2, max_bytes=256)
        records = [{'index': i, 'delta': str(i) + '中' * 3000} for i in range(80)]
        for item in records: self.assertTrue(value.put(item))
        stats = value.inspect()
        self.assertLessEqual(stats['memory_events'], 2)
        self.assertLessEqual(stats['memory_bytes'], 256)
        self.assertEqual(stats['pending_events'], len(records))
        self.assertGreater(stats['pending_disk_bytes'], 256)
        self.assertEqual([value.get(timeout=.1) for _ in records], records)
        with self.assertRaises(queue.Empty): value.get(timeout=.001)

    def test_count_budget_and_byte_budget_independently_force_spill(self):
        for budgets, item in [({'max_events': 2, 'max_bytes': 65536}, {'text': 'x'}),
                              ({'max_events': 200, 'max_bytes': 128}, {'text': 'x' * 100})]:
            value = self.buffer(**budgets)
            for _ in range(10): self.assertTrue(value.put(item))
            stats = value.inspect()
            self.assertLessEqual(stats['memory_events'], budgets['max_events'])
            self.assertLessEqual(stats['memory_bytes'], budgets['max_bytes'])
            self.assertGreater(stats['pending_disk_bytes'], 0)
            self.assertEqual([value.get() for _ in range(10)], [item] * 10)

    def test_private_permissions_anonymous_file_and_cancel_cleanup(self):
        value = self.buffer(max_events=0)
        directory = Path(value._directory.name)
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.fstat(value._file.fileno()).st_mode), 0o600)
        value.put({'text': 'private-public-answer'})
        self.assertEqual(list(directory.iterdir()), [])
        value.close()
        self.assertFalse(directory.exists())
        self.assertFalse(value.put({'text': 'after close'}))
        self.assertEqual(value.inspect()['memory_bytes'], 0)

    def test_raw_tool_and_private_reasoning_are_projected_before_memory_and_disk(self):
        bridge, buffer, stream = self.bridge(max_events=0)
        secret = 'MUST_NOT_PERSIST_' + 'x' * 1024 * 1024
        bridge._notification(event('item/completed', item={'id': 'tool', 'type': 'mcpToolCall', 'tool': 'read',
                                                         'arguments': secret, 'result': secret, 'error': {'message': secret}}))
        bridge._notification(event('item/reasoning/textDelta', delta=secret, opaque=secret))
        bridge._notification(event('item/unknown', payload=secret))
        size = buffer.inspect()['written_disk_bytes']
        self.assertLess(size, 1024)
        raw = os.pread(buffer._file.fileno(), size, 0)
        self.assertNotIn(b'MUST_NOT_PERSIST', raw)
        first, second = buffer.get(), buffer.get()
        self.assertEqual(first['params']['_public_activity']['status'], 'failed')
        self.assertEqual(second['params']['delta'], ' ')
        self.assertEqual(buffer.qsize(), 0)

    def test_sources_are_preserved_without_raw_results(self):
        projected = public_notification(event('item/completed', item={'id': 'web', 'type': 'webSearch',
            'results': [{'url': 'https://example.com/paper', 'title': 'Title', 'content': 'PRIVATE'}],
            'action': {'type': 'openPage', 'url': 'https://example.com/page', 'query': 'PRIVATE'}}))
        self.assertEqual(len(projected['params']['_public_sources']), 2)
        self.assertNotIn('PRIVATE', json.dumps(projected))

    def test_invalid_explicit_turn_id_cannot_be_erased_into_a_valid_nested_id(self):
        for invalid in (1, [], {}, '', 'x' * 161):
            self.assertIsNone(public_notification(event(turn_id=invalid, turn={'id': 'turn'}, delta='must reject')))
            self.assertIsNone(public_notification(event(turn={'id': invalid}, delta='must reject')))
        for value in (None, 'turn'):
            self.assertIsNotNone(public_notification(event(turn_id=value, turn={'id': 'turn'}, delta='valid')))
        mismatch = public_notification(event(turn_id='wrong-turn', turn={'id': 'turn'}, delta='reject downstream'))
        self.assertEqual(mismatch['params']['turnId'], 'wrong-turn')

    def test_stdout_loop_does_not_keep_the_last_raw_payload_while_idle(self):
        import inspect
        bridge, buffer, stream = self.bridge(max_events=0)
        class Lines:
            done = False
            def __iter__(self): return self
            def __next__(iterator):
                if not iterator.done:
                    iterator.done = True
                    return json.dumps(event('item/completed', item={'id': 'tool', 'type': 'mcpToolCall', 'result': 'PRIVATE' * 100000}))
                waiting_frame = inspect.currentframe().f_back
                self.assertIsNone(waiting_frame.f_locals.get('message'))
                self.assertIsNone(waiting_frame.f_locals.get('line'))
                raise StopIteration
        class Process:
            stdout = Lines()
        bridge._read(Process())

    def test_full_final_answer_and_terminal_order_survive_many_spilled_events(self):
        bridge, buffer, stream = self.bridge(max_events=1, max_bytes=128)
        bridge._notification(event('item/started', item={'id': 'answer', 'type': 'agentMessage', 'phase': 'final_answer'}))
        chunks = [('中😀' + str(i) + 'x' * 8192) for i in range(100)]
        for text in chunks: bridge._notification(event(itemId='answer', delta=text))
        expected = ''.join(chunks)
        bridge._notification(event('item/completed', item={'id': 'answer', 'type': 'agentMessage', 'phase': 'final_answer', 'text': expected}))
        bridge._notification(event('turn/completed', turn={'id': 'turn', 'status': 'completed'}))
        result = list(stream)
        self.assertEqual(''.join(item['delta'] for item in result if item['type'] == 'response.output_text.delta'), expected)
        self.assertEqual(result[-1], {'type': 'response.completed', 'response': {'output_text': expected}})
        self.assertNotIn('turn/interrupt', [name for name, _ in bridge.calls])
        self.assertEqual(sum(name == 'turn/start' for name, _ in bridge.calls), 1)
        self.assertTrue(buffer.inspect()['closed'])
        self.assertEqual(bridge.subscribers, {})

    def test_disk_failure_drains_prior_events_then_reports_real_failure_no_retry(self):
        bridge, buffer, stream = self.bridge(max_events=1, max_bytes=256)
        bridge._notification(event(itemId='answer', delta='received partial'))
        with patch.object(buffer, '_write_all', side_effect=OSError(errno.ENOSPC, 'PRIVATE PATH / secret body')):
            bridge._notification(event(itemId='answer', delta='later content'))
        bridge._notification(event('turn/completed', turn={'id': 'turn', 'status': 'completed'}))
        result = list(stream)
        self.assertEqual(result[-1]['type'], 'response.failed')
        self.assertEqual(result[-1]['error']['code'], 'codex_stream_storage_failed')
        self.assertNotIn('PRIVATE PATH', json.dumps(result))
        self.assertFalse(any(item['type'] == 'response.completed' for item in result))
        self.assertEqual(sum(name == 'turn/start' for name, _ in bridge.calls), 1)
        self.assertEqual(sum(name == 'turn/interrupt' for name, _ in bridge.calls), 1)

    def test_failed_record_does_not_publish_partial_bytes(self):
        value = self.buffer(max_events=0)
        self.assertTrue(value.put({'index': 1}))
        original = value._write_all
        def partial(fd, data, offset):
            original(fd, data[:1], offset)
            raise OSError('disk full')
        with patch.object(value, '_write_all', side_effect=partial): self.assertFalse(value.put({'index': 2}))
        self.assertEqual(value.get(), {'index': 1})
        with self.assertRaises(StreamBufferError): value.get()

    def test_read_failure_is_terminal_and_redacted(self):
        value = self.buffer(max_events=0)
        value.put({'text': 'answer'})
        with patch.object(value, '_read_exact', side_effect=OSError('secret local path')):
            with self.assertRaises(StreamBufferError) as raised: value.get()
        self.assertNotIn('secret', str(raised.exception))

    def test_spool_creation_failure_never_starts_model(self):
        bridge = FakeBridge(Path(self.temp.name))
        with patch.object(codex_bridge, 'StreamEventBuffer', side_effect=StreamBufferError()):
            result = list(bridge.respond('synthetic', []))
        self.assertEqual(result[0]['type'], 'response.failed')
        self.assertEqual(bridge.calls, [])

    def test_blocked_consumer_does_not_block_producer_or_other_subscriber(self):
        first, second = self.buffer(max_events=0), self.buffer(max_events=0)
        bridge = FakeBridge(Path(self.temp.name))
        bridge.subscribers = {'slow': first, 'fast': second}
        first.put(event(thread='slow', delta='old'))
        reading, release = threading.Event(), threading.Event()
        original = first._read_exact
        def slow_read(*args):
            reading.set()
            self.assertTrue(release.wait(2))
            return original(*args)
        received = []
        with patch.object(first, '_read_exact', side_effect=slow_read):
            worker = threading.Thread(target=lambda: received.append(first.get()), daemon=True)
            worker.start()
            self.assertTrue(reading.wait(1))
            try:
                bridge._notification(event(thread='slow', delta='new'))
                bridge._notification(event(thread='fast', delta='fast answer'))
                self.assertEqual(second.get(timeout=.2)['params']['delta'], 'fast answer')
                self.assertTrue(bridge.state_lock.acquire(timeout=.2))
                bridge.state_lock.release()
            finally:
                release.set(); worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(received[0]['params']['delta'], 'old')
        self.assertEqual(first.get()['params']['delta'], 'new')

    def test_backlogged_subscriber_does_not_prevent_rpc_response_routing(self):
        bridge, buffer, stream = self.bridge(max_events=1, max_bytes=128)
        for index in range(200): bridge._notification(event(itemId='answer', delta=str(index)))
        waiting = queue.Queue(maxsize=1)
        bridge.pending[7] = waiting
        class Process:
            stdout = iter([json.dumps({'id': 7, 'result': {'interrupted': True}})])
        bridge._read(Process())
        self.assertTrue(waiting.get(timeout=.1)['result']['interrupted'])

    def test_close_racing_a_disk_read_never_delivers_or_decrements_closed_queue(self):
        value = self.buffer(max_events=0)
        value.put({'text': 'answer'})
        reading, release = threading.Event(), threading.Event()
        original = value._read_exact
        def paused(*args):
            reading.set()
            self.assertTrue(release.wait(2))
            return original(*args)
        failures, results = [], []
        def consume():
            try: results.append(value.get())
            except Exception as error: failures.append(error)
        with patch.object(value, '_read_exact', side_effect=paused):
            worker = threading.Thread(target=consume, daemon=True)
            worker.start(); self.assertTrue(reading.wait(1))
            value.close(); release.set(); worker.join(2)
        self.assertEqual(results, [])
        self.assertIsInstance(failures[0], StreamBufferClosed)
        self.assertEqual(value.qsize(), 0)
        with self.assertRaises(StreamBufferClosed): value.get(timeout=.01)

    def test_close_during_write_is_not_blocked_by_producer_and_never_publishes(self):
        value = self.buffer(max_events=0)
        writing, release = threading.Event(), threading.Event()
        original = value._write_all
        def paused(*args):
            writing.set()
            self.assertTrue(release.wait(2))
            return original(*args)
        accepted = []
        with patch.object(value, '_write_all', side_effect=paused):
            worker = threading.Thread(target=lambda: accepted.append(value.put({'text': 'answer'})), daemon=True)
            worker.start(); self.assertTrue(writing.wait(1))
            value.close(); release.set(); worker.join(2)
        self.assertEqual(accepted, [False])
        self.assertEqual(value.qsize(), 0)
        self.assertEqual(value.inspect()['pending_disk_bytes'], 0)

    def test_generator_close_and_exception_release_spool_and_interrupt_once(self):
        for exception in (False, True):
            bridge, buffer, stream = self.bridge(max_events=0)
            bridge._notification(event(delta='partial'))
            directory = Path(buffer._directory.name)
            if exception:
                with self.assertRaisesRegex(RuntimeError, 'synthetic disconnect'):
                    stream.throw(RuntimeError('synthetic disconnect'))
            else: stream.close()
            self.assertTrue(buffer.inspect()['closed'])
            self.assertFalse(directory.exists())
            self.assertEqual(bridge.subscribers, {})
            self.assertEqual(sum(name == 'turn/interrupt' for name, _ in bridge.calls), 1)

    def test_runtime_eof_is_ordered_failure_and_cleans_spool(self):
        bridge, buffer, stream = self.bridge(max_events=0)
        bridge._notification(event(delta='legacy partial'))
        directory = Path(buffer._directory.name)
        class Process:
            stdout = iter([])
        process = Process()
        bridge.process = process
        bridge._read(process)
        bridge.process = None
        result = list(stream)
        self.assertEqual(result[-1]['type'], 'response.failed')
        self.assertEqual(result[-1]['error']['code'], 'codex_unavailable')
        self.assertFalse(directory.exists())

    def test_bridge_close_wakes_reader_and_immediately_releases_spool(self):
        bridge, buffer, stream = self.bridge(max_events=0)
        directory = Path(buffer._directory.name)
        bridge._notification(event(delta='partial'))
        bridge.close()
        self.assertFalse(directory.exists())
        result = list(stream)
        self.assertEqual(result[-1]['type'], 'response.failed')
        self.assertEqual(result[-1]['error']['code'], 'codex_unavailable')

    def test_close_before_turn_start_cannot_restart_the_runtime(self):
        bridge = FakeBridge(Path(self.temp.name))
        stream = bridge.respond('synthetic', [])
        self.addCleanup(stream.close)
        next(stream)
        buffer = bridge.subscribers['thread']
        directory = Path(buffer._directory.name)
        bridge.close()
        result = list(stream)
        self.assertEqual(result[-1]['type'], 'response.failed')
        self.assertEqual([name for name, _ in bridge.calls], ['thread/start'])
        self.assertFalse(directory.exists())

    def test_old_generator_cleanup_does_not_address_a_new_runtime(self):
        bridge, buffer, stream = self.bridge()
        bridge.close()
        replacement = self.buffer()
        bridge.subscribers['thread'] = replacement
        list(stream)
        self.assertIs(bridge.subscribers['thread'], replacement)
        self.assertFalse(replacement.inspect()['closed'])
        self.assertNotIn('turn/interrupt', [name for name, _ in bridge.calls])
        self.assertNotIn('thread/unsubscribe', [name for name, _ in bridge.calls])

    def test_disk_io_does_not_hold_bridge_shared_state_lock(self):
        bridge, buffer, stream = self.bridge(max_events=0)
        original = buffer._write_all
        def check(*args):
            self.assertTrue(bridge.state_lock.acquire(timeout=.1))
            bridge.state_lock.release()
            return original(*args)
        with patch.object(buffer, '_write_all', side_effect=check):
            bridge._notification(event(delta='answer'))

    def test_burst_retained_memory_is_bounded_with_large_raw_tool_payloads(self):
        bridge, buffer, stream = self.bridge()
        gc.collect(); tracemalloc.start()
        baseline = tracemalloc.get_traced_memory()[0]
        try:
            for index in range(2048):
                bridge._notification(event('item/completed', item={'id': str(index), 'type': 'mcpToolCall', 'tool': 'read',
                    'result': {'content': [{'type': 'text', 'text': f'{index:08x}' + 'x' * 4088}]}}))
            gc.collect()
            retained = tracemalloc.get_traced_memory()[0] - baseline
            self.assertLess(retained, 512 * 1024)
            self.assertLessEqual(buffer.inspect()['memory_events'], 64)
            self.assertLessEqual(buffer.inspect()['memory_bytes'], 256 * 1024)
            self.assertEqual(buffer.qsize(), 2048)
            print(json.dumps({'case': '2048x4KiB tool results', 'retained_python_bytes': retained, **buffer.inspect()}))
        finally: tracemalloc.stop()

    def test_actual_answer_delta_backlog_is_bounded_without_losing_bytes(self):
        bridge, buffer, stream = self.bridge()
        gc.collect(); tracemalloc.start()
        baseline = tracemalloc.get_traced_memory()[0]
        try:
            for index in range(2048):
                bridge._notification(event(itemId='answer', delta=f'{index:08x}' + 'x' * 4088))
            gc.collect()
            retained = tracemalloc.get_traced_memory()[0] - baseline
            self.assertLess(retained, 512 * 1024)
            self.assertLessEqual(buffer.inspect()['memory_bytes'], 256 * 1024)
            print(json.dumps({'case': '2048x4KiB actual answer deltas', 'retained_python_bytes': retained, **buffer.inspect()}))
            for index in range(2048):
                delta = buffer.get()['params']['delta']
                self.assertEqual(delta, f'{index:08x}' + 'x' * 4088)
        finally: tracemalloc.stop()


if __name__ == '__main__': unittest.main(verbosity=2)
