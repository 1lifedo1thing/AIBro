"""Ordinary-note recovery: private multislot storage and actual HTTP contract."""
import copy
import hashlib
import http.client
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import note_drafts as drafts
from sync_store import project


def state():
    return {'notes': [{'id': 'note-a', 'title': 'Approved A', 'content': 'Approved body'}, {'id': 'note-b', 'title': 'Approved B'}],
            'projects': [], 'agentRuns': [], 'conversations': []}


def session(identifier='note-a', content='An exact draft\n\n**Unicode 🌱 中文**'):
    return {'id': identifier, 'base': 'sha256:' + hashlib.sha256(b'approved version').hexdigest(),
            'originalTitle': 'Approved A', 'originalContent': 'Approved body', 'originalFolderPath': '',
            'title': 'Draft title', 'content': content, 'folderPath': 'Research/Notes'}


def cas_worker(directory, ready, start, results, text):
    store = drafts.NoteDraftStore(directory, state)
    ready.put(True)
    start.wait(5)
    try:
        results.put(store.put('note-a', {'revision': 0, 'session': session(content=text)})['revision'])
    except drafts.DraftError as error:
        results.put(error.code)


class NoteDraftPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='note-drafts-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = state()
        self.store = drafts.NoteDraftStore(self.root, lambda: self.state)

    def put(self, revision=0, value=None, identifier='note-a'):
        return self.store.put(identifier, {'revision': revision, 'session': value})

    def error(self, expected, action):
        with self.assertRaises(drafts.DraftError) as caught:
            action()
        self.assertEqual(caught.exception.code, expected)
        return caught.exception

    def test_initial_read_has_no_storage_side_effect(self):
        self.assertEqual(self.store.get('note-a'), {'revision': 0, 'session': None, 'updatedAt': None})
        self.assertEqual(list(self.root.iterdir()), [])

    def test_multiple_slots_survive_restart_without_workspace_or_sync_mutation(self):
        before = copy.deepcopy(self.state)
        approved = project(self.state)
        self.put(value=session())
        self.put(value=session('note-b', 'Second exact body'), identifier='note-b')
        reopened = drafts.NoteDraftStore(self.root, lambda: self.state)
        self.assertEqual(reopened.get('note-a')['session'], session())
        self.assertEqual(reopened.get('note-b')['session']['content'], 'Second exact body')
        self.assertEqual(self.state, before)
        self.assertEqual(project(self.state), approved)
        self.assertEqual({path.name for path in self.root.iterdir()}, {'.note-drafts'})
        self.assertEqual(stat.S_IMODE(self.store.directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.store.path_for('note-a').stat().st_mode), 0o600)

    def test_revision_is_per_note_and_clear_is_durable_tombstone(self):
        self.put(value=session())
        self.put(value=session('note-b'), identifier='note-b')
        result = self.put(1, None)
        self.assertEqual((result['revision'], result['session'], result['cleared']), (2, None, True))
        reopened = drafts.NoteDraftStore(self.root, lambda: self.state)
        self.assertIsNone(reopened.get('note-a')['session'])
        self.assertEqual(reopened.get('note-a')['revision'], 2)
        self.assertEqual(reopened.get('note-b')['revision'], 1)
        self.error('draft_conflict', lambda: reopened.put('note-a', {'revision': 1, 'session': session()}))

    def test_separate_process_cas_has_exactly_one_winner(self):
        context = multiprocessing.get_context('spawn')
        ready, results, start = context.Queue(), context.Queue(), context.Event()
        workers = [context.Process(target=cas_worker, args=(str(self.root), ready, start, results, text)) for text in ['first', 'second']]
        for worker in workers:
            worker.start()
            self.addCleanup(lambda process=worker: process.kill() if process.is_alive() else None)
        for _ in workers:
            self.assertTrue(ready.get(timeout=8))
        start.set()
        received = [results.get(timeout=8) for _ in workers]
        for worker in workers:
            worker.join(8)
            self.assertEqual(worker.exitcode, 0)
        self.assertCountEqual(received, [1, 'draft_conflict'])
        self.assertIn(self.store.get('note-a')['session']['content'], ('first', 'second'))

    def test_stale_second_instance_cannot_replace_first(self):
        second = drafts.NoteDraftStore(self.root, lambda: self.state)
        self.put(value=session(content='first'))
        self.error('draft_conflict', lambda: second.put('note-a', {'revision': 0, 'session': session(content='second')}))
        self.assertEqual(second.get('note-a')['session']['content'], 'first')

    def test_private_note_never_creates_storage(self):
        for field in ('private', 'incognito', 'ephemeral'):
            with self.subTest(field=field):
                self.state['notes'][0][field] = True
                self.error('draft_private', lambda: self.put(value=session()))
                self.assertEqual(self.store.get('note-a')['blocked'], 'private')
                self.assertEqual(list(self.root.iterdir()), [])
                del self.state['notes'][0][field]

    def test_current_privacy_redacts_saved_body_and_allows_explicit_clear(self):
        self.put(value=session())
        self.state['notes'][0]['private'] = True
        blocked = self.store.get('note-a')
        self.assertEqual((blocked['revision'], blocked['session'], blocked['blocked']), (1, None, 'private'))
        self.error('draft_private', lambda: self.put(1, session(content='new body')))
        self.assertEqual(self.put(1, None)['revision'], 2)
        self.assertNotIn('An exact draft', self.store.path_for('note-a').read_text())

    def test_missing_archived_deleted_and_ambiguous_note_are_unavailable(self):
        self.put(value=session())
        for changes in ([], [{'id': 'note-a', 'archived': True}], [{'id': 'note-a', 'deletedAt': 12}], [{'id': 'note-a'}, {'id': 'note-a'}]):
            with self.subTest(changes=changes):
                self.state['notes'] = changes
                self.assertEqual(self.store.get('note-a')['blocked'], 'unavailable')
                self.assertIsNone(self.store.get('note-a')['session'])
                self.error('draft_unavailable', lambda: self.put(1, session()))
        self.assertEqual(self.put(1, None)['revision'], 2)

    def test_project_privacy_and_access_are_checked(self):
        self.state['notes'][0]['projectId'] = 'project-a'
        for project_value, reason in ((None, 'unavailable'), ({'id': 'project-a', 'archived': True}, 'unavailable'),
                                      ({'id': 'project-a', 'deletedAt': 1}, 'unavailable'), ({'id': 'project-a', 'private': True}, 'private')):
            with self.subTest(reason=reason, project=project_value):
                self.state['projects'] = [] if project_value is None else [project_value]
                self.error('draft_' + reason, lambda: self.put(value=session()))
                self.assertEqual(self.store.get('note-a')['blocked'], reason)

    def test_lifecycle_markers_preserve_old_recovery_bytes_but_block_new_writes(self):
        self.state['notes'][0]['projectId'] = 'project-a'
        self.state['projects'] = [{'id': 'project-a'}]
        self.put(value=session())
        saved_bytes = self.store.path_for('note-a').read_bytes()
        for collection in ('notes', 'projects'):
            for marker in ({'archivedAt': 123}, {'deleted': True}, {'status': 'archived'}, {'status': 'deleted'}):
                with self.subTest(collection=collection, marker=marker):
                    record = self.state[collection][0]
                    record.update(marker)
                    blocked = self.store.get('note-a')
                    self.assertEqual((blocked['revision'], blocked['session'], blocked['blocked']), (1, None, 'unavailable'))
                    self.error('draft_unavailable', lambda: self.put(1, session(content='Must not replace retained text')))
                    self.assertEqual(self.store.path_for('note-a').read_bytes(), saved_bytes)
                    for field in marker:
                        del record[field]
                    self.assertEqual(self.store.get('note-a')['session'], session(), 'reactivating the owner must expose the retained recovery draft')

    def test_unassigned_note_still_persists_without_a_project(self):
        for index, project_id in enumerate((None, '')):
            with self.subTest(project_id=project_id):
                self.state['notes'][0]['projectId'] = project_id
                self.assertEqual(self.put(index, session())['revision'], index + 1)
                self.assertEqual(self.store.get('note-a')['session'], session())

    def test_project_lifecycle_is_rechecked_after_waiting_for_draft_lock(self):
        self.state['notes'][0]['projectId'] = 'project-a'
        self.state['projects'] = [{'id': 'project-a'}]
        original = self.store._lock
        from contextlib import contextmanager
        @contextmanager
        def changed_lock():
            with original():
                self.state['projects'][0]['archivedAt'] = 123
                yield
        with patch.object(self.store, '_lock', changed_lock):
            self.error('draft_unavailable', lambda: self.put(value=session()))
        self.assertFalse(self.store.path_for('note-a').exists())

    def test_direct_conversation_and_run_origin_privacy_are_both_checked(self):
        self.state['notes'][0].update({'sourceConversationId': 'conversation-direct', 'agentRunId': 'run-a'})
        self.state['agentRuns'] = [{'id': 'run-a', 'conversationId': 'conversation-run'}]
        for identifier in ('conversation-direct', 'conversation-run'):
            self.state['conversations'] = [{'id': identifier, 'incognito': True}]
            self.error('draft_private', lambda: self.put(value=session()))
        self.state['conversations'] = []
        self.state['agentRuns'][0]['private'] = True
        self.error('draft_private', lambda: self.put(value=session()))

    def test_source_conversation_private_project_is_checked(self):
        self.state['notes'][0]['sourceConversationId'] = 'conversation-a'
        self.state['conversations'] = [{'id': 'conversation-a', 'projectId': 'private-project'}]
        self.state['projects'] = [{'id': 'private-project', 'ephemeral': True}]
        self.error('draft_private', lambda: self.put(value=session()))

    def test_privacy_is_rechecked_after_waiting_for_draft_lock(self):
        original = self.store._lock
        from contextlib import contextmanager
        @contextmanager
        def changed_lock():
            with original():
                self.state['notes'][0]['private'] = True
                yield
        with patch.object(self.store, '_lock', changed_lock):
            self.error('draft_private', lambda: self.put(value=session()))
        self.assertFalse(self.store.path_for('note-a').exists())

    def test_schema_rejects_unknown_missing_id_hash_and_boolean_fields(self):
        invalid = []
        item = session(); item['unknown'] = 1; invalid.append(item)
        item = session(); del item['originalFolderPath']; invalid.append(item)
        item = session('note-b'); invalid.append(item)
        item = session(); item['base'] = 'raw revision history'; invalid.append(item)
        item = session(); item['retainedDraft'] = 1; invalid.append(item)
        item = session(); item['appliedAiDraft'] = {}; invalid.append(item)
        for item in invalid:
            with self.subTest(item=list(item)):
                self.error('draft_invalid', lambda: self.put(value=item))
        for payload in ({'revision': True, 'session': session()}, {'revision': -1, 'session': None}, {'revision': 0, 'session': None, 'extra': True}):
            self.error('draft_invalid', lambda: self.store.put('note-a', payload))

    def test_optional_ai_candidate_and_retained_flag_roundtrip_exactly(self):
        item = session(); item.update({'appliedAiDraft': '{"title":"AI", "content":"Exact\\ntext"}', 'retainedDraft': True})
        self.put(value=item)
        self.assertEqual(self.store.get('note-a')['session'], item)

    def test_existing_content_limits_fail_without_truncating_previous_record(self):
        self.put(value=session())
        previous = self.store.path_for('note-a').read_bytes()
        for key, limit in (('title', 240), ('originalTitle', 240), ('content', 1_000_000), ('originalContent', 1_000_000), ('folderPath', 500), ('originalFolderPath', 500)):
            with self.subTest(key=key):
                item = session(); item[key] = 'x' * (limit + 1)
                self.error('draft_too_large', lambda: self.put(1, item))
                self.assertEqual(self.store.path_for('note-a').read_bytes(), previous)

    def test_full_record_limit_is_explicit_and_retains_previous(self):
        self.put(value=session())
        previous = self.store.path_for('note-a').read_bytes()
        item = session(); item['appliedAiDraft'] = 'x' * 5000
        with patch.object(drafts, 'MAX_BYTES', 4096):
            error = self.error('draft_too_large', lambda: self.put(1, item))
        self.assertIn('24 MiB', str(error))
        self.assertEqual(self.store.path_for('note-a').read_bytes(), previous)

    def test_hash_filename_never_uses_identifier_as_path(self):
        identifier = '../../strange/笔记'
        self.state['notes'].append({'id': identifier})
        self.put(value=session(identifier), identifier=identifier)
        path = self.store.path_for(identifier)
        self.assertEqual(path.parent, self.store.directory)
        self.assertEqual(path.name, hashlib.sha256(identifier.encode()).hexdigest() + '.json')
        self.assertEqual(self.store.get(identifier)['session']['id'], identifier)
        for identifier in ('', '\x00bad', 'x' * 201, 'bad\x7f', '\ud800'):
            self.error('draft_invalid', lambda: self.store.get(identifier))

    def test_fsync_failure_before_replace_preserves_old_and_leaves_no_temporary_file(self):
        self.put(value=session())
        previous = self.store.path_for('note-a').read_bytes()
        with patch.object(drafts.os, 'fsync', side_effect=OSError('synthetic fsync failure')):
            error = self.error('draft_write_failed', lambda: self.put(1, session(content='not durable')))
        self.assertEqual(error.status, 503)
        self.assertEqual(self.store.path_for('note-a').read_bytes(), previous)
        self.assertEqual(sorted(path.name for path in self.store.directory.iterdir()), sorted(['.lock', self.store.path_for('note-a').name]))

    def test_directory_fsync_failure_does_not_claim_save_acknowledged(self):
        self.put(value=session())
        real_fsync = drafts.os.fsync
        def fail_directory(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError('directory fsync unavailable')
            return real_fsync(descriptor)
        with patch.object(drafts.os, 'fsync', fail_directory):
            self.error('draft_write_failed', lambda: self.put(1, session(content='unconfirmed')))
        # Rename already happened. A retry must reload/CAS, never receive a
        # false success or roll the valid latest bytes back to a stale revision.
        self.assertEqual(self.store.get('note-a')['revision'], 2)
        self.error('draft_conflict', lambda: self.put(1, session(content='blind retry')))

    def test_corrupt_or_misbound_record_is_preserved_and_cannot_be_reset_by_clear(self):
        self.put(value=session())
        path = self.store.path_for('note-a')
        for raw in ('{broken', '{"version":1,"version":1}', json.dumps({'version': 1, 'id': 'other-note', 'revision': 1, 'session': None, 'updatedAt': 1})):
            with self.subTest(raw=raw):
                path.write_text(raw)
                self.error('draft_storage_corrupt', lambda: self.store.get('note-a'))
                self.error('draft_storage_corrupt', lambda: self.put(1, None))
                self.assertEqual(path.read_text(), raw)

    def test_symlink_and_hardlink_records_are_not_followed_or_replaced(self):
        self.put(value=session())
        path = self.store.path_for('note-a'); original = path.read_bytes()
        outside = self.root / 'outside'; outside.write_bytes(original); outside.chmod(0o600)
        for link in ('symbolic', 'hard'):
            path.unlink()
            if link == 'symbolic': path.symlink_to(outside)
            else: os.link(outside, path)
            self.error('draft_storage_path', lambda: self.store.get('note-a'))
            self.error('draft_storage_path', lambda: self.put(1, None))
            self.assertEqual(outside.read_bytes(), original)

    def test_insecure_record_fifo_directory_and_symlink_storage_are_rejected(self):
        self.put(value=session())
        path = self.store.path_for('note-a'); path.chmod(0o644)
        self.error('draft_storage_path', lambda: self.store.get('note-a'))
        path.unlink(); os.mkfifo(path, 0o600)
        self.error('draft_storage_path', lambda: self.store.get('note-a'))
        path.unlink(); path.mkdir(mode=0o700)
        self.error('draft_storage_path', lambda: self.store.get('note-a'))
        path.rmdir(); (self.store.directory / '.lock').unlink(); self.store.directory.rmdir()
        outside = self.root / 'outside'; outside.mkdir(mode=0o700)
        self.store.directory.symlink_to(outside, target_is_directory=True)
        self.error('draft_storage_path', lambda: self.store.get('note-a'))
        self.error('draft_storage_path', lambda: self.put(value=session()))
        self.assertEqual(list(outside.iterdir()), [])

    def test_insecure_directory_and_linked_lock_are_rejected(self):
        self.store.directory.mkdir(mode=0o755)
        self.error('draft_storage_path', lambda: self.put(value=session()))
        self.store.directory.chmod(0o700)
        outside = self.root / 'outside'; outside.write_text('unchanged'); outside.chmod(0o600)
        (self.store.directory / '.lock').symlink_to(outside)
        self.error('draft_storage_path', lambda: self.put(value=session()))
        self.assertEqual(outside.read_text(), 'unchanged')


class NoteDraftHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='note-draft-http-')
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': cls.temp.name, 'AI_WORKSTATION_ASSET_DIR': str(ROOT / 'app')}):
            spec = importlib.util.spec_from_file_location('note_draft_test_server', ROOT / 'app' / 'server.py')
            cls.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='note-draft-http-store-')
        self.addCleanup(self.temp.cleanup)
        self.state = state()
        self.store = self.module.WorkspaceStore(Path(self.temp.name))
        self.store.path.write_text(json.dumps(self.state))
        self.module.STORE = self.store
        self.module.NOTE_DRAFTS = drafts.NoteDraftStore(self.store.directory, self.store.load)
        module = self.module
        class QuietHandler(module.Handler):
            def log_message(self, *_): pass
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.worker = threading.Thread(target=self.httpd.serve_forever, daemon=True); self.worker.start()
        self.addCleanup(lambda: (self.httpd.shutdown(), self.httpd.server_close(), self.worker.join(timeout=2)))
        self.origin = f'http://127.0.0.1:{self.httpd.server_port}'

    def request(self, method='GET', query='?id=note-a', body=None, headers=None):
        request = Request(self.origin + '/__note-draft' + query, data=body, headers=headers if headers is not None else {'Origin': self.origin, 'Content-Type': 'application/json'}, method=method)
        try:
            with urlopen(request, timeout=4) as response:
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                return response.status, json.loads(response.read())
        except HTTPError as response:
            return response.code, json.loads(response.read())

    def test_http_roundtrip_cas_and_monotonic_clear(self):
        self.assertEqual(self.request()[1]['revision'], 0)
        status, value = self.request('POST', body=json.dumps({'revision': 0, 'session': session()}).encode())
        self.assertEqual((status, value['revision'], value['session']), (200, 1, session()))
        self.assertEqual(self.request()[1]['session'], session())
        status, value = self.request('POST', body=json.dumps({'revision': 0, 'session': None}).encode())
        self.assertEqual((status, value['code']), (409, 'draft_conflict'))
        status, value = self.request('POST', body=json.dumps({'revision': 1, 'session': None}).encode())
        self.assertEqual((status, value['revision'], value['session']), (200, 2, None))

    def test_http_exact_origin_host_and_fetch_site_guards(self):
        for method in ('GET', 'POST'):
            for headers in ({'Origin': 'https://attacker.invalid'}, {'Origin': self.origin, 'Host': 'attacker.invalid'}, {'Origin': self.origin, 'Sec-Fetch-Site': 'cross-site'}):
                status, value = self.request(method, headers=headers, body=b'{}' if method == 'POST' else None)
                self.assertEqual((status, value['code']), (403, 'draft_origin_denied'))
        self.assertEqual(self.request('POST', headers={'Content-Type': 'application/json'}, body=b'{}')[0], 403)

    def test_http_strict_query_body_and_content_type(self):
        for query in ('', '?id=', '?id=note-a&id=note-b', '?id=note-a&extra=1', '?id=%00'):
            self.assertEqual(self.request(query=query)[0], 400)
        for body in (b'[]', b'{bad', b'{"revision":0,"session":null,"extra":true}', b'{"revision":0,"revision":1,"session":null}', b'{"revision":NaN,"session":null}'):
            status, value = self.request('POST', body=body)
            self.assertEqual((status, value['code']), (400, 'draft_invalid'))
        self.assertEqual(self.request('POST', body=b'{}', headers={'Origin': self.origin, 'Content-Type': 'text/plain'})[0], 415)

    def test_http_state_change_redacts_content_and_clear_remains_available(self):
        self.request('POST', body=json.dumps({'revision': 0, 'session': session()}).encode())
        self.state['notes'][0]['private'] = True
        self.store.path.write_text(json.dumps(self.state))
        self.assertEqual(self.request()[1]['blocked'], 'private')
        self.assertIsNone(self.request()[1]['session'])
        status, value = self.request('POST', body=json.dumps({'revision': 1, 'session': session()}).encode())
        self.assertEqual((status, value['code']), (403, 'draft_private'))
        self.assertNotIn('Approved body', json.dumps(value))
        self.assertEqual(self.request('POST', body=b'{"revision":1,"session":null}')[1]['revision'], 2)

    def test_http_declared_oversized_body_is_rejected_before_read(self):
        client = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=3)
        self.addCleanup(client.close)
        client.request('POST', '/__note-draft?id=note-a', body=None, headers={'Origin': self.origin, 'Content-Type': 'application/json', 'Content-Length': str(drafts.MAX_BYTES + 1025)})
        response = client.getresponse(); value = json.loads(response.read())
        self.assertEqual((response.status, value['code']), (413, 'draft_too_large'))
        self.assertFalse(self.module.NOTE_DRAFTS.directory.exists())

    def test_http_calls_are_inside_workspace_lock(self):
        real_get, real_put = self.module.NOTE_DRAFTS.get, self.module.NOTE_DRAFTS.put
        held = []
        def get(identifier):
            held.append(self.store._lock_state.held)
            return real_get(identifier)
        def put(identifier, payload):
            held.append(self.store._lock_state.held)
            return real_put(identifier, payload)
        with patch.object(self.module.NOTE_DRAFTS, 'get', get), patch.object(self.module.NOTE_DRAFTS, 'put', put):
            self.request()
            self.request('POST', body=json.dumps({'revision': 0, 'session': session()}).encode())
        self.assertEqual(held, [True, True])


if __name__ == '__main__':
    unittest.main()
