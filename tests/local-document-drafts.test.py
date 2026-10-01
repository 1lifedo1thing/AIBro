"""Local Markdown recovery is private, version-bound and never writes disk files."""
import copy
import hashlib
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
from urllib.parse import quote
from urllib.request import Request, urlopen
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import local_document_drafts as drafts
from local_projects import LocalProjects


def cas_worker(directory, state, identifier, session, start, results):
    store = drafts.LocalDocumentDraftStore(directory, lambda: state, LocalProjects(directory))
    start.wait(5)
    try:
        results.put(store.put(identifier, {'revision': 0, 'session': session})['revision'])
    except drafts.DraftError as error:
        results.put(error.code)


class LocalDraftsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='localdocument-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / 'workspace'; self.workspace.mkdir()
        self.folder = self.root / 'connected'; self.folder.mkdir()
        self.file = self.folder / '文档.md'; self.file.write_bytes(b'\xef\xbb\xbf# Original\r\n\rline\n')
        self.original = self.file.read_bytes()
        self.projects = LocalProjects(self.workspace)
        self.connection = self.projects.connect(str(self.folder))
        self.candidate = self.connection['candidate']['id']
        self.state = {'projects': [{'id': 'project-a', 'localFolder': {'id': self.candidate}}], 'conversations': []}
        self.identifier = drafts.document_id('project-a', self.candidate, '文档.md')
        self.session = {'id': self.identifier, 'projectId': 'project-a', 'candidateId': self.candidate, 'path': '文档.md',
                        'version': hashlib.sha256(self.original).hexdigest(), 'baseContent': '\ufeff# Original\r\n\rline\n',
                        'content': '\ufeff# Exact\r\n\r中文 🌱\n', 'mode': 'edit',
                        'selection': {'start': 2, 'end': 4, 'direction': 'backward'}, 'scroll': {'top': 40.5, 'left': 0}}
        self.store = drafts.LocalDocumentDraftStore(self.workspace, lambda: self.state, self.projects)

    def put(self, revision=0, session=None):
        return self.store.put(self.identifier, {'revision': revision, 'session': session})

    def error(self, code, action):
        with self.assertRaises(drafts.DraftError) as caught:
            action()
        self.assertEqual(caught.exception.code, code)

    def test_exact_raw_version_bookmark_restart_and_no_workspace_or_disk_mutation(self):
        before = copy.deepcopy(self.state)
        self.assertFalse(self.store.directory.exists())
        self.assertEqual(self.store.get(self.identifier)['revision'], 0)
        self.assertFalse(self.store.directory.exists())
        self.put(session=self.session)
        reopened = drafts.LocalDocumentDraftStore(self.workspace, lambda: self.state, LocalProjects(self.workspace))
        self.assertEqual(reopened.get(self.identifier)['session'], self.session)
        self.assertEqual(self.file.read_bytes(), self.original)
        self.assertEqual(self.state, before)
        self.assertEqual(stat.S_IMODE(self.store.directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.store.path_for(self.identifier).stat().st_mode), 0o600)
        self.assertFalse((self.workspace / 'workspace.json').exists())

    def test_full_large_draft_has_no_note_or_file_application_cap(self):
        self.session['content'] = '\ufeff' + '中文\r\n' * 600_000
        self.assertGreater(len(self.session['content'].encode()), 4 * 1024 * 1024)
        self.put(session=self.session)
        self.assertEqual(self.store.get(self.identifier)['session']['content'], self.session['content'])
        self.assertEqual(self.file.read_bytes(), self.original)

    def test_cas_tombstone_prevents_late_resurrection(self):
        self.put(session=self.session)
        self.assertEqual(self.put(1, None)['revision'], 2)
        self.error('draft_conflict', lambda: self.put(1, self.session))
        self.assertIsNone(self.store.get(self.identifier)['session'])
        self.assertNotIn('Exact', self.store.path_for(self.identifier).read_text())

    def test_separate_process_cas_has_one_winner(self):
        context = multiprocessing.get_context('spawn')
        start, results = context.Event(), context.Queue()
        workers = [context.Process(target=cas_worker, args=(str(self.workspace), self.state, self.identifier, self.session, start, results)) for _ in range(2)]
        for worker in workers:
            worker.start()
            self.addCleanup(lambda process=worker: process.kill() if process.is_alive() else None)
        start.set()
        received = [results.get(timeout=10) for _ in workers]
        for worker in workers:
            worker.join(5); self.assertEqual(worker.exitcode, 0)
        self.assertCountEqual(received, [1, 'draft_conflict'])

    def test_deleted_underlying_file_keeps_recoverable_draft_and_immutable_base(self):
        self.put(session=self.session)
        self.file.unlink()
        result = self.store.get(self.identifier)
        self.assertEqual((result['recoveryOnly'], result['unavailable'], result['session']), (True, 'missing', self.session))
        updated = {**self.session, 'content': 'Recovered draft still editable'}
        self.assertEqual(self.put(1, updated)['revision'], 2)
        self.error('draft_base_conflict', lambda: self.put(2, {**updated, 'version': 'f' * 64}))
        self.assertFalse(self.file.exists())

    def test_file_deleted_before_first_debounce_does_not_lose_open_text(self):
        self.file.unlink()
        self.assertEqual(self.put(session=self.session)['revision'], 1)
        self.assertEqual(self.store.get(self.identifier)['session'], self.session)
        self.assertFalse(self.file.exists())

    def test_revoked_candidate_and_changed_binding_recover_existing_only(self):
        self.put(session=self.session)
        self.projects.disconnect(self.connection['root']['id'])
        result = self.store.get(self.identifier)
        self.assertEqual((result['recoveryOnly'], result['unavailable']), (True, 'disconnected'))
        self.assertEqual(result['session'], self.session)
        self.assertEqual(self.put(1, {**self.session, 'content': 'Keep typing'})['revision'], 2)
        self.state['projects'][0]['localFolder'] = {'id': 'new-candidate'}
        self.assertEqual(self.store.get(self.identifier)['unavailable'], 'changed_binding')
        self.put(2, None)
        self.error('draft_unavailable', lambda: self.put(3, self.session))
        self.assertIsNone(self.store.get(self.identifier)['session'])

    def test_disk_change_keeps_original_version_and_draft_never_overwrites_it(self):
        self.put(session=self.session)
        changed = b'# Changed by another editor\n'; self.file.write_bytes(changed)
        self.put(1, {**self.session, 'content': '# Draft continues'})
        self.assertEqual(self.store.get(self.identifier)['session']['version'], hashlib.sha256(self.original).hexdigest())
        self.assertEqual(self.file.read_bytes(), changed)

    def test_private_project_prevents_new_storage_and_redacts_existing(self):
        for flag in ('private', 'incognito', 'ephemeral'):
            self.state['projects'][0][flag] = True
            self.error('draft_private', lambda: self.put(session=self.session))
            self.assertFalse(self.store.directory.exists())
            self.assertIsNone(self.store.get(self.identifier)['session'])
            del self.state['projects'][0][flag]
        self.put(session=self.session)
        self.state['projects'][0]['private'] = True
        self.assertEqual(self.store.get(self.identifier)['blocked'], 'private')
        self.assertIsNone(self.store.get(self.identifier)['session'])
        self.put(1, None)

    def test_project_deletion_archive_ambiguity_and_origin_privacy(self):
        self.put(session=self.session)
        project = copy.deepcopy(self.state['projects'][0])
        for projects in ([], [{**project, 'archived': True}], [{**project, 'deleted': True}], [project, project]):
            self.state['projects'] = projects
            self.assertIsNone(self.store.get(self.identifier)['session'])
            self.assertTrue(self.store.get(self.identifier)['blocked'])
        self.state['projects'] = [project]
        self.state['conversations'] = [{'id': 'conv-a', 'projectId': 'project-a'}]
        value = {**self.session, 'sourceConversationId': 'conv-a'}
        self.put(1, value)
        self.state['conversations'][0]['incognito'] = True
        self.assertIsNone(self.store.get(self.identifier)['session'])
        self.error('draft_private', lambda: self.put(2, self.session))
        self.put(2, None)

    def test_privacy_rechecked_after_waiting_for_lock(self):
        from contextlib import contextmanager
        original = self.store._lock
        @contextmanager
        def lock():
            with original():
                self.state['projects'][0]['private'] = True
                yield
        with patch.object(self.store, '_lock', lock):
            self.error('draft_private', lambda: self.put(session=self.session))
        self.assertFalse(self.store.path_for(self.identifier).exists())

    def test_strict_identity_path_and_session_schema(self):
        for path in ('../escape.md', '/absolute.md', 'secrets/key.md', '.env', 'bad\\file.md', 'bad%2f.md', 'unknown.pdf'):
            identifier = drafts.document_id('project-a', self.candidate, path)
            self.error('draft_invalid', lambda: self.store.get(identifier))
        self.error('draft_invalid', lambda: self.store.get(json.dumps(['project-a', self.candidate, '文档.md'])))
        values = [dict(self.session, projectId='other'), dict(self.session, version='wrong'), dict(self.session, extra='not allowed'),
                  dict(self.session, content='\ud800'), dict(self.session, mode='unknown'),
                  dict(self.session, selection={'start': 0, 'end': 10_000, 'direction': 'none'}),
                  dict(self.session, scroll={'top': True, 'left': 0})]
        for value in values:
            self.error('draft_invalid', lambda: self.put(session=value))
        self.assertFalse(self.store.directory.exists())

    def test_new_draft_cannot_follow_symlink_or_hardlink_or_wrong_candidate(self):
        outside = self.root / 'outside.md'; outside.write_text('outside')
        self.file.unlink(); self.file.symlink_to(outside)
        self.error('draft_unavailable', lambda: self.put(session=self.session))
        self.file.unlink(); os.link(outside, self.file)
        self.error('draft_unavailable', lambda: self.put(session=self.session))
        self.assertEqual(outside.read_text(), 'outside')
        self.state['projects'][0]['localFolder']['id'] = 'different'
        self.error('draft_unavailable', lambda: self.put(session=self.session))

    def test_storage_links_corruption_and_permissions_preserve_original_record(self):
        self.put(session=self.session)
        path = self.store.path_for(self.identifier)
        original = path.read_bytes()
        outside = self.root / 'outside'; outside.write_bytes(original); outside.chmod(0o600)
        path.unlink(); path.symlink_to(outside)
        self.error('draft_storage_path', lambda: self.store.get(self.identifier))
        self.error('draft_storage_path', lambda: self.put(1, None))
        path.unlink(); os.link(outside, path)
        self.error('draft_storage_path', lambda: self.store.get(self.identifier))
        path.unlink(); path.write_bytes(original); path.chmod(0o644)
        self.error('draft_storage_path', lambda: self.store.get(self.identifier))
        path.chmod(0o600); path.write_text('{"version":1,"version":1}')
        self.error('draft_storage_corrupt', lambda: self.put(1, None))
        self.assertEqual(path.read_text(), '{"version":1,"version":1}')
        self.assertEqual(outside.read_bytes(), original)

    def test_failed_fsync_preserves_old_record_and_directory_failure_is_unacknowledged(self):
        self.put(session=self.session)
        path = self.store.path_for(self.identifier); original = path.read_bytes()
        with patch('note_drafts.os.fsync', side_effect=OSError('disk failure')):
            self.error('draft_write_failed', lambda: self.put(1, {**self.session, 'content': 'new content'}))
        self.assertEqual(path.read_bytes(), original)
        real_fsync = os.fsync
        def fail_directory(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError('directory fsync failure')
            real_fsync(descriptor)
        with patch('note_drafts.os.fsync', fail_directory):
            self.error('draft_write_failed', lambda: self.put(1, {**self.session, 'content': 'unacknowledged'}))
        self.assertEqual(self.store.get(self.identifier)['revision'], 2)
        self.error('draft_conflict', lambda: self.put(1, self.session))


class LocalDraftHTTPTests(LocalDraftsTests):
    # Only HTTP-specific methods belong to this subclass; avoid repeating all
    # filesystem tests while retaining the real connected-folder fixture.
    @classmethod
    def setUpClass(cls):
        cls.module_temp = tempfile.TemporaryDirectory(prefix='localdraft-http-module-')
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': cls.module_temp.name, 'AI_WORKSTATION_ASSET_DIR': str(ROOT / 'app')}):
            spec = importlib.util.spec_from_file_location('local_document_test_server', ROOT / 'app' / 'server.py')
            cls.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        cls.module_temp.cleanup()

    def setUp(self):
        super().setUp()
        self.workspace_store = self.module.WorkspaceStore(self.workspace)
        self.workspace_store.path.write_text(json.dumps(self.state))
        self.module.STORE = self.workspace_store
        self.module.LOCAL_DOCUMENT_DRAFTS = drafts.LocalDocumentDraftStore(self.workspace, self.workspace_store.load, self.projects)
        module = self.module
        class QuietHandler(module.Handler):
            def log_message(self, *_): pass
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.worker = threading.Thread(target=self.httpd.serve_forever, daemon=True); self.worker.start()
        self.addCleanup(lambda: (self.httpd.shutdown(), self.httpd.server_close(), self.worker.join(timeout=2)))
        self.origin = f'http://127.0.0.1:{self.httpd.server_port}'

    def request(self, method='GET', query=None, body=None, headers=None):
        if query is None: query = '?id=' + quote(self.identifier, safe='')
        request = Request(self.origin + '/__local-document-draft' + query, data=body,
                          headers=headers if headers is not None else {'Origin': self.origin, 'Content-Type': 'application/json'}, method=method)
        try:
            with urlopen(request, timeout=5) as response:
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                return response.status, json.loads(response.read())
        except HTTPError as response:
            return response.code, json.loads(response.read())

    def test_http_roundtrip_lock_cas_and_clear(self):
        held = []
        real_get = self.module.LOCAL_DOCUMENT_DRAFTS.get
        def get(identifier):
            held.append(self.workspace_store._lock_state.held)
            return real_get(identifier)
        with patch.object(self.module.LOCAL_DOCUMENT_DRAFTS, 'get', get):
            self.assertEqual(self.request()[1]['revision'], 0)
        self.assertEqual(held, [True])
        status, result = self.request('POST', body=json.dumps({'revision': 0, 'session': self.session}).encode())
        self.assertEqual((status, result['session']), (200, self.session))
        self.assertEqual(self.request()[1]['session'], self.session)
        self.assertEqual(self.request('POST', body=b'{"revision":0,"session":null}')[0], 409)
        self.assertEqual(self.request('POST', body=b'{"revision":1,"session":null}')[1]['revision'], 2)
        self.assertEqual(self.file.read_bytes(), self.original)

    def test_http_exact_origin_and_strict_framing(self):
        for method in ('GET', 'POST'):
            for headers in ({'Origin': 'https://attacker.invalid'}, {'Origin': self.origin, 'Host': 'attacker.invalid'}, {'Origin': self.origin, 'Sec-Fetch-Site': 'cross-site'}):
                self.assertEqual(self.request(method, headers=headers, body=b'{}' if method == 'POST' else None)[0], 403)
        for query in ('', '?id=', '?id=x&id=y', '?id=x&extra=1'):
            self.assertEqual(self.request(query=query)[0], 400)
        for body in (b'[]', b'{bad', b'{"revision":0,"revision":1,"session":null}', b'{"revision":NaN,"session":null}'):
            self.assertEqual(self.request('POST', body=body)[0], 400)
        self.assertEqual(self.request('POST', body=b'{}', headers={'Origin': self.origin, 'Content-Type': 'text/plain'})[0], 415)


# unittest inherits test methods. Keep the shared setup without duplicating
# backend tests or pretending that repetitions add HTTP coverage.
for _name in tuple(vars(LocalDraftsTests)):
    if _name.startswith('test_'):
        setattr(LocalDraftHTTPTests, _name, None)

if __name__ == '__main__':
    unittest.main()
