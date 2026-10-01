"""Conflict review CAS using actual SQLite/file publication, never real SSH."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
DEFAULT_FIXTURE = tempfile.TemporaryDirectory(prefix='cloud-conflict-module-')
os.environ['AI_WORKSTATION_DATA_DIR'] = str(Path(DEFAULT_FIXTURE.name) / 'unused')
import server
from cloud_sync import CloudSync, CloudSyncError
from sync_store import SyncStore, ConflictRevisionError


def note(body):
    return {'id': 'n', 'title': '审阅内容', 'content': body}


def change(data, version, kind='notes', identifier='n'):
    return {'entityType': kind, 'entityId': identifier, 'data': data,
            'version': version, 'deleted': data is None}


def rows(store):
    with store.db() as db:
        return {table: [tuple(row) for row in db.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                for table in ('meta', 'entities', 'outbox', 'sent', 'conflicts')}


class StoreRevisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cloud-conflict-cas-')
        self.addCleanup(self.temp.cleanup)
        self.store = SyncStore(Path(self.temp.name))
        self.store.capture({'notes': [note('base')], '_revision': 1})
        self.store.ack([{**op, 'version': 1} for op in self.store.pending()])
        self.store.capture({'notes': [note('reviewed local')], '_revision': 2})
        self.store.apply_changes([change(note('reviewed remote'), 2)], 2)
        self.reviewed = self.store.conflicts()[0]

    def assert_stale(self, choice):
        before = rows(self.store)
        with self.assertRaises(ConflictRevisionError) as error:
            self.store.resolve_conflict(self.reviewed['id'], choice, self.reviewed['revision'])
        self.assertEqual((error.exception.code, error.exception.status), ('CONFLICT_CHANGED', 409))
        self.assertEqual(rows(self.store), before)

    def test_revision_stable_across_reads_restart_and_unrelated_change(self):
        revision = self.reviewed['revision']
        self.assertRegex(revision, r'^[a-f0-9]{64}$')
        self.assertEqual(SyncStore(self.store.directory).conflicts()[0]['revision'], revision)
        state = self.store.snapshot(); state['tasks'] = [{'id': 'other', 'title': 'Unrelated'}]
        self.store.capture(state)
        self.assertEqual(self.store.conflicts()[0]['revision'], revision)

    def test_new_remote_version_same_conflict_id_rejects_both_stale_choices(self):
        self.store.apply_changes([change(note('unseen cloud v3'), 3)], 3)
        current = self.store.conflicts()[0]
        self.assertEqual(current['id'], self.reviewed['id'])
        self.assertNotEqual(current['revision'], self.reviewed['revision'])
        for choice in ('local', 'remote'):
            self.assert_stale(choice)
        self.store.resolve_conflict(current['id'], 'remote', current['revision'])
        self.assertEqual(self.store.snapshot()['notes'][0]['content'], 'unseen cloud v3')
        self.assertEqual(self.store.conflicts(), [])

    def test_new_local_edit_rejects_stale_remote_and_local_choices(self):
        state = self.store.snapshot(); state['notes'][0]['content'] = 'unseen local'
        self.store.capture(state)
        for choice in ('remote', 'local'):
            self.assert_stale(choice)
        current = self.store.conflicts()[0]
        self.store.resolve_conflict(current['id'], 'local', current['revision'])
        self.assertEqual(self.store.pending()[0]['data']['content'], 'unseen local')

    def test_local_deletion_and_remote_tombstone_each_invalidate_revision(self):
        self.store.capture({'notes': []})
        self.assert_stale('remote')
        deleted_revision = self.store.conflicts()[0]['revision']
        self.store.apply_changes([change(None, 3)], 3)
        # Identical deletion converges and removes the conflict; the old review
        # must still be rejected rather than creating any replacement data.
        self.assert_stale('local')
        self.assertNotEqual(deleted_revision, self.reviewed['revision'])

    def test_same_cloud_body_new_version_still_invalidates_token(self):
        self.store.apply_changes([change(note('reviewed remote'), 3)], 3)
        self.assert_stale('remote')

    def test_remote_deletion_invalidates_review_without_publishing(self):
        self.store.apply_changes([change(None, 3)], 3)
        current = self.store.conflicts()[0]
        self.assertIsNone(current['remote'])
        callback = unittest.mock.Mock()
        with self.assertRaises(ConflictRevisionError):
            self.store.resolve_conflict(self.reviewed['id'], 'remote', self.reviewed['revision'], before_commit=callback)
        callback.assert_not_called()
        self.store.resolve_conflict(current['id'], 'remote', current['revision'])
        self.assertEqual(self.store.snapshot()['notes'], [])

    def test_invalid_or_absent_revision_never_changes_database(self):
        before = rows(self.store)
        for invalid in (None, '', 123, {}, 'a' * 63, 'A' * 64, 'a' * 64 + '\n'):
            with self.subTest(invalid=invalid), self.assertRaises(ConflictRevisionError) as error:
                self.store.resolve_conflict(self.reviewed['id'], 'remote', invalid)
            self.assertEqual((error.exception.code, error.exception.status), ('INVALID_CONFLICT_REVISION', 400))
            self.assertEqual(rows(self.store), before)

    def test_token_from_different_conflict_cannot_authorize_choice(self):
        self.store.capture({'notes': [note('reviewed local'), {'id': 'other', 'content': 'local'}]})
        self.store.apply_changes([change({'id': 'other', 'content': 'cloud'}, 1, identifier='other')], 3)
        other = next(item for item in self.store.conflicts() if item['entityId'] == 'other')
        with self.assertRaises(ConflictRevisionError):
            self.store.resolve_conflict(other['id'], 'remote', self.reviewed['revision'])

    def test_callback_failure_rolls_back_and_review_can_be_retried(self):
        before = rows(self.store)
        def fail(_): raise OSError('synthetic publication failure')
        with self.assertRaises(OSError):
            self.store.resolve_conflict(self.reviewed['id'], 'remote', self.reviewed['revision'], before_commit=fail)
        self.assertEqual(rows(self.store), before)
        self.store.resolve_conflict(self.reviewed['id'], 'remote', self.reviewed['revision'])
        self.assertEqual(self.store.snapshot()['notes'][0]['content'], 'reviewed remote')


class DownloadRaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cloud-conflict-blob-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.workspace = server.WorkspaceStore(self.directory)
        self.store = self.workspace.sync
        self.local_raw = b'local original file'
        self.remote_raw = b'reviewed remote original file'
        self.remote_hash = hashlib.sha256(self.remote_raw).hexdigest()
        self.new_raw = b'new remote original file'
        self.new_hash = hashlib.sha256(self.new_raw).hexdigest()
        self.workspace.save_file('i', self.local_raw, 'base.pdf', 'application/pdf')
        self.store.capture({'imports': [{'id': 'i', 'name': 'base.pdf'}], '_revision': 1})
        self.store.ack([{**op, 'version': 1} for op in self.store.pending()])
        state = self.store.snapshot(); state['imports'][0]['name'] = 'reviewed local.pdf'
        self.store.capture(state)
        self.store.apply_changes([self.remote_change()], 2)
        self.reviewed = self.store.conflicts()[0]
        self.downloads = []; self.during_download = None
        test = self
        class Client:
            def download_blob(self, digest):
                test.downloads.append(digest)
                callback, test.during_download = test.during_download, None
                if callback: callback()
                return {test.remote_hash: test.remote_raw, test.new_hash: test.new_raw}[digest]
        self.manager = CloudSync(self.directory, self.store, self.workspace,
                                 client_factory=lambda *_: Client(), start_worker=False)
        self.addCleanup(self.manager.close)
        self.manager._session = {'serverUrl': 'https://fixture.invalid', 'accessToken': 'test-only',
                                 'account': {'id': 'fixture'}, 'device': {'id': 'fixture'}}

    def remote_change(self, newer=False):
        return change({'id': 'i', 'name': 'new remote.pdf' if newer else 'reviewed remote.pdf',
                       'blobHash': self.new_hash if newer else self.remote_hash},
                      3 if newer else 2, kind='imports', identifier='i')

    def resolve(self, reviewed=None):
        entry = reviewed or self.reviewed
        return self.manager.resolve(entry['id'], 'remote', entry['revision'])

    def assert_preserved(self):
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.local_raw)
        self.assertEqual(len(self.store.conflicts()), 1)
        self.assertEqual(list(self.directory.glob('.cloud-undo-*')), [])
        self.assertEqual(list((self.directory / 'cloud-downloads').glob('batch-*')), [])

    def test_stale_initial_review_rejects_before_downloading(self):
        self.store.apply_changes([self.remote_change(newer=True)], 3)
        before = rows(self.store)
        with self.assertRaises(CloudSyncError) as error: self.resolve()
        self.assertEqual((error.exception.code, error.exception.status), ('CONFLICT_CHANGED', 409))
        self.assertEqual(self.downloads, [])
        self.assertEqual(rows(self.store), before)
        self.assert_preserved()

    def test_local_edit_during_download_rejected_by_final_transaction(self):
        def local_edit():
            state = self.store.snapshot(); state['imports'][0]['name'] = 'unseen local.pdf'
            self.store.capture(state)
        self.during_download = local_edit
        with self.assertRaises(CloudSyncError) as error: self.resolve()
        self.assertEqual((error.exception.code, error.exception.status), ('CONFLICT_CHANGED', 409))
        self.assertEqual(self.downloads, [self.remote_hash])
        self.assertEqual(self.store.snapshot()['imports'][0]['name'], 'unseen local.pdf')
        self.assert_preserved()
        latest = self.manager.conflicts()['conflicts'][0]
        self.resolve(latest)
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.remote_raw)
        self.assertEqual(self.store.conflicts(), [])

    def test_remote_change_during_download_does_not_publish_wrong_blob(self):
        self.during_download = lambda: self.store.apply_changes([self.remote_change(newer=True)], 3)
        with self.assertRaises(CloudSyncError) as error: self.resolve()
        self.assertEqual(error.exception.code, 'CONFLICT_CHANGED')
        self.assertEqual(self.store.conflicts()[0]['remote']['blobHash'], self.new_hash)
        self.assert_preserved()
        self.resolve(self.manager.conflicts()['conflicts'][0])
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.new_raw)
        self.assertEqual(self.store.snapshot()['imports'][0]['name'], 'new remote.pdf')

    def test_conflict_resolved_during_download_cannot_reapply_old_review(self):
        self.during_download = lambda: self.store.resolve_conflict(self.reviewed['id'], 'local', self.reviewed['revision'])
        with self.assertRaises(CloudSyncError) as error: self.resolve()
        self.assertEqual((error.exception.code, error.exception.status), ('CONFLICT_CHANGED', 409))
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.local_raw)
        self.assertEqual(self.store.conflicts(), [])
        self.assertEqual(self.store.pending()[0]['data']['name'], 'reviewed local.pdf')

    def test_actual_publication_failure_rolls_back_and_same_review_can_retry(self):
        original_write = self.workspace.atomic_write
        def fail_metadata(path, data):
            if Path(path).name == 'i.meta.json': raise OSError('synthetic write failure')
            return original_write(path, data)
        before = rows(self.store)
        with patch.object(self.workspace, 'atomic_write', side_effect=fail_metadata):
            with self.assertRaises(OSError): self.resolve()
        self.assertEqual(rows(self.store), before)
        self.assert_preserved()
        self.resolve()
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.remote_raw)

    def test_missing_revision_rejected_without_download(self):
        with self.assertRaises(CloudSyncError) as error:
            self.manager.resolve(self.reviewed['id'], 'remote')
        self.assertEqual((error.exception.code, error.exception.status), ('INVALID_CONFLICT_REVISION', 400))
        self.assertEqual(self.downloads, [])

    def test_cancelled_after_download_cleans_stage_without_publishing(self):
        stage_blobs = self.manager._stage_blobs
        def staged_then_cancelled(*args):
            result = stage_blobs(*args)
            self.manager._epoch += 1
            return result
        with patch.object(self.manager, '_stage_blobs', side_effect=staged_then_cancelled):
            with self.assertRaises(CloudSyncError) as error: self.resolve()
        self.assertEqual(error.exception.code, 'CANCELLED')
        self.assertFalse(self.manager._sync_lock.locked())
        self.assert_preserved()

    def test_production_http_handler_forwards_revision_and_preserves_error_codes(self):
        replies = []
        def post(payload):
            handler = SimpleNamespace(command='POST', valid_auth_origin=lambda **_: True,
                                      read_body=lambda _: json.dumps(payload).encode(),
                                      send_json=lambda data, status=200: replies.append((status, data)))
            with patch.object(server, 'cloud_service', return_value=self.manager):
                server.Handler.do_cloud(handler, '/__cloud/resolve')
            return replies[-1]
        status, error = post({'id': self.reviewed['id'], 'choice': 'remote'})
        self.assertEqual((status, error['code']), (400, 'INVALID_CONFLICT_REVISION'))
        self.store.apply_changes([self.remote_change(newer=True)], 3)
        status, error = post({'id': self.reviewed['id'], 'choice': 'remote', 'revision': self.reviewed['revision']})
        self.assertEqual((status, error['code']), (409, 'CONFLICT_CHANGED'))
        self.assert_preserved()
        current = self.manager.conflicts()['conflicts'][0]
        status, result = post({'id': current['id'], 'choice': 'remote', 'revision': current['revision']})
        self.assertEqual(status, 200)
        self.assertEqual(result['conflicts'], 0)
        self.assertEqual(self.workspace.file_path('i').read_bytes(), self.new_raw)


if __name__ == '__main__':
    unittest.main()
