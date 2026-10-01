"""Local-only comparison draft slot: restart, CAS, privacy and failure checks."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import comparison_drafts as drafts
from sync_store import project


def sample_session():
    sources = []
    for identifier in ('source-a', 'source-b'):
        sources.append({
            'key': f'note:{identifier}', 'kind': 'note', 'id': identifier,
            'title': identifier, 'projectId': None, 'workspace': '科研',
            'sourceVersion': '1:abc:def', 'capturedAt': 1234, 'excerpt': 'Exact source text.',
            'excerptOffset': 0, 'excerptLabel': 'note-content', 'totalCharacters': len('Exact source text.'),
            'truncated': False, 'metadata': {'authors': [], 'year': '', 'venue': '', 'doi': '', 'url': '', 'pageCount': 0},
        })
    return {'data': {
        'version': 2, 'mode': 'research', 'question': '', 'scope': '',
        'researchStatus': 'draft', 'claims': [], 'openQuestions': '',
        'language': 'zh', 'title': '', 'projectId': None, 'workspace': '科研',
        'sources': sources,
        'criteria': [{'id': 'criterion-1', 'label': '证据与适用条件', 'cells': {
            'note:source-a': {'quote': 'quote no longer matching', 'judgment': '', 'relation': 'unclassified', 'reviewedStamp': ''},
            'note:source-b': {'quote': '', 'judgment': '', 'relation': 'unclassified', 'reviewedStamp': ''},
        }}],
        'selectedKey': '', 'conclusion': '',
    }, 'noteId': None, 'base': None}


class ComparisonDraftPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='comparison-drafts-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.state = {'notes': [], 'imports': [], 'papers': [], 'projects': [], 'agentRuns': [], 'conversations': []}
        self.store = drafts.ComparisonDraftStore(self.directory, lambda: self.state)

    def put(self, revision, session):
        return self.store.put({'revision': revision, 'session': session})

    def test_initial_save_survives_restart_and_stays_out_of_sync_projection(self):
        session = sample_session()
        saved = self.put(0, session)
        self.assertEqual(saved['revision'], 1)
        reopened = drafts.ComparisonDraftStore(self.directory, lambda: self.state)
        self.assertEqual(reopened.get()['session'], session)
        # Draft storage is a separate file, absent from every sync entity.
        self.assertEqual(project(self.state), {})
        self.assertTrue((self.directory / 'comparison-draft.json').is_file())
        self.assertEqual((self.directory / 'comparison-draft.json').stat().st_mode & 0o777, 0o600)

    def test_compare_and_swap_rejects_stale_window_and_keeps_latest(self):
        first, second = sample_session(), sample_session()
        first['data']['question'] = 'Window one'
        second['data']['question'] = 'Window two'
        self.put(0, first)
        with self.assertRaises(drafts.DraftError) as caught:
            self.put(0, second)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, 'draft_conflict'))
        self.assertEqual(self.store.get()['session']['data']['question'], 'Window one')

    def test_clear_is_durable_monotonic_tombstone(self):
        self.put(0, sample_session())
        cleared = self.put(1, None)
        self.assertTrue(cleared['cleared'])
        reopened = drafts.ComparisonDraftStore(self.directory, lambda: self.state)
        self.assertEqual(reopened.get()['revision'], 2)
        self.assertIsNone(reopened.get()['session'])
        with self.assertRaises(drafts.DraftError) as caught:
            reopened.put({'revision': 1, 'session': sample_session()})
        self.assertEqual(caught.exception.code, 'draft_conflict')
        reopened.put({'revision': 2, 'session': sample_session()})
        self.assertEqual(reopened.get()['revision'], 3)

    def test_private_source_redacts_on_get_and_blocks_save_but_allows_clear(self):
        self.put(0, sample_session())
        self.state['notes'] = [{'id': 'source-a', 'private': True}]
        blocked = self.store.get()
        self.assertEqual((blocked['session'], blocked['blocked'], blocked['revision']), (None, 'private', 1))
        with self.assertRaises(drafts.DraftError) as caught:
            self.put(1, sample_session())
        self.assertEqual((caught.exception.status, caught.exception.code), (403, 'draft_private'))
        self.assertEqual(self.put(1, None)['revision'], 2)

    def test_private_project_and_existing_note_owner_are_checked(self):
        self.state['projects'] = [{'id': 'project-a', 'private': True}]
        session = sample_session()
        session['data']['projectId'] = 'project-a'
        with self.assertRaises(drafts.DraftError) as caught:
            self.put(0, session)
        self.assertEqual(caught.exception.code, 'draft_private')
        self.state['projects'] = [{'id': 'project-a', 'private': True}]
        session = sample_session(); session['data']['sources'][0]['projectId'] = 'project-a'
        with self.assertRaises(drafts.DraftError) as caught:
            self.put(0, session)
        self.assertEqual(caught.exception.code, 'draft_private')
        self.state['projects'] = []
        session = sample_session(); session['noteId'] = 'owner'
        self.state['notes'] = [{'id': 'owner', 'ephemeral': True}]
        with self.assertRaises(drafts.DraftError) as caught:
            self.put(0, session)
        self.assertEqual(caught.exception.code, 'draft_private')

    def test_ambiguous_source_identity_with_any_private_duplicate_is_blocked(self):
        session = sample_session()
        self.put(0, session)
        self.state['notes'] = [{'id': 'source-a'}, {'id': 'source-a', 'incognito': True}]
        self.assertEqual((self.store.get()['session'], self.store.get()['blocked']), (None, 'private'))

    def test_invalid_or_oversize_data_does_not_replace_previous_draft(self):
        original = sample_session()
        self.put(0, original)
        oversized = sample_session()
        oversized['data']['question'] = 'x' * 2001
        with self.assertRaises(drafts.DraftError):
            self.put(1, oversized)
        malformed = sample_session(); malformed['data']['sources'][0]['key'] = 'note:elsewhere'
        with self.assertRaises(drafts.DraftError):
            self.put(1, malformed)
        self.assertEqual(self.store.get()['session'], original)

    def test_failed_fsync_write_keeps_old_payload_and_ack_is_not_fabricated(self):
        self.put(0, sample_session())
        changed = sample_session(); changed['data']['question'] = 'New version'
        def fail_write(_path, _raw):
            raise OSError('fsync failed')
        failing = drafts.ComparisonDraftStore(self.directory, lambda: self.state, fail_write)
        with self.assertRaises(drafts.DraftError) as caught:
            failing.put({'revision': 1, 'session': changed})
        self.assertEqual((caught.exception.status, caught.exception.code), (503, 'draft_write_failed'))
        self.assertEqual(self.store.get()['revision'], 1)
        self.assertEqual(self.store.get()['session']['data']['question'], '')

    def test_corrupt_file_and_symlink_are_reported_without_reset_or_following(self):
        path = self.directory / 'comparison-draft.json'
        path.write_text('{bad json')
        with self.assertRaises(drafts.DraftError) as caught:
            self.store.get()
        self.assertEqual(caught.exception.code, 'draft_storage_corrupt')
        self.assertEqual(path.read_text(), '{bad json')
        path.unlink()
        outside = self.directory / 'outside.json'; outside.write_text('{"untouched":true}')
        path.symlink_to(outside)
        with self.assertRaises(drafts.DraftError) as caught:
            self.store.get()
        self.assertEqual(caught.exception.code, 'draft_storage_path')
        self.assertEqual(outside.read_text(), '{"untouched":true}')

    def test_http_endpoint_checks_get_and_post_origins_and_uses_dynamic_port(self):
        with tempfile.TemporaryDirectory(prefix='comparison-draft-server-') as temporary:
            with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': temporary, 'AI_WORKSTATION_ASSET_DIR': str(ROOT / 'app')}):
                spec = importlib.util.spec_from_file_location('comparison_draft_endpoint_server', ROOT / 'app' / 'server.py')
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            isolated = module.WorkspaceStore(Path(temporary) / 'store')
            module.STORE = isolated
            module.COMPARISON_DRAFTS = drafts.ComparisonDraftStore(isolated.directory, isolated.load)

            class QuietHandler(module.Handler):
                def log_message(self, *_): pass

            httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
            worker = threading.Thread(target=httpd.serve_forever, daemon=True); worker.start()
            self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close(), worker.join(timeout=2)))
            origin = f'http://127.0.0.1:{httpd.server_port}'

            def request(method, headers=None, body=None):
                req = Request(origin + '/__comparison-draft', data=body, headers=headers or {}, method=method)
                try:
                    with urlopen(req, timeout=3) as response: return response.status, json.loads(response.read())
                except HTTPError as response:
                    return response.code, json.loads(response.read())

            status, payload = request('GET', {'Origin': 'https://attacker.invalid'})
            self.assertEqual((status, payload['code']), (403, 'draft_origin_denied'))
            status, payload = request('POST', {'Origin': origin, 'Content-Type': 'application/json'}, json.dumps({'revision': 0, 'session': sample_session()}).encode())
            self.assertEqual((status, payload['revision']), (200, 1))
            status, payload = request('POST', {'Content-Type': 'application/json'}, json.dumps({'revision': 1, 'session': None}).encode())
            self.assertEqual((status, payload['code']), (403, 'draft_origin_denied'))
            status, payload = request('GET', {'Origin': origin})
            self.assertEqual((status, payload['revision'], payload['session'] is not None), (200, 1, True))


if __name__ == '__main__':
    unittest.main()
