"""Regression checks for durable SSH boundaries; temporary synthetic data only."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

fixture_spec = importlib.util.spec_from_file_location('cloud_sync_audit_fixtures', Path(__file__).with_name('cloud-sync.test.py'))
fixtures = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixtures)
from cloud_ssh import CloudSSH


class DurableBoundaryAudit(unittest.TestCase):
    def test_contradictory_terminal_journal_never_unlocks_sync_after_restart(self):
        for state, phase in [('completed', 'prepared'), ('error', 'copying'), ('error', 'verified')]:
            with self.subTest(state=state, phase=phase), tempfile.TemporaryDirectory(prefix='aibro-ssh-receipt-audit-') as temporary:
                root = Path(temporary)
                folder = root / '.cloud-ssh-maintenance'; folder.mkdir(mode=0o700)
                record = {'id': 'a' * 32, 'state': state, 'phase': phase,
                          'source': '/srv/source', 'destination': '/srv/destination',
                          'config': {'target': 'fixture', 'sshPort': 0, 'localPort': 18787, 'remotePort': 8787},
                          'identity': {'accountId': 'fixture', 'cursor': 0, 'serverUrl': 'http://127.0.0.1:18787'},
                          'restoreAuto': False, 'autoSyncPaused': True, 'message': 'synthetic contradictory receipt'}
                journal = folder / 'job.json'
                journal.write_text(json.dumps({'version': 1, 'job': record, 'history': []})); journal.chmod(0o600)
                before = journal.read_bytes()
                manager = CloudSSH(SimpleNamespace(directory=root), home=root,
                                   runner=lambda *args, **kwargs: self.fail('journal inspection must not dispatch SSH'))
                self.assertEqual(manager.job['state'], 'uncertain')
                with self.assertRaises(fixtures.CloudSyncError): manager.assert_not_pending()
                self.assertEqual(journal.read_bytes(), before, 'invalid evidence must be retained, not silently repaired')

    def test_nonempty_sync_releases_workspace_operation_lock_and_can_sync_again(self):
        with tempfile.TemporaryDirectory(prefix='aibro-ssh-lock-audit-') as temporary:
            directory = Path(temporary)
            store = fixtures.MemoryStore()
            workspace = fixtures.Workspace(directory, store)
            store.workspace = workspace
            remote = fixtures.Remote()
            manager = fixtures.CloudSync(directory, store, workspace, client_factory=remote.factory, start_worker=False)
            manager.credentials._keyring = None
            self.addCleanup(manager.close)
            descriptors = []
            acquire = manager.ssh._acquire_operation

            def tracked_acquire(*args, **kwargs):
                descriptor = acquire(*args, **kwargs)
                descriptors.append(descriptor)
                return descriptor

            manager.ssh._acquire_operation = tracked_acquire
            manager.connect({'serverUrl': 'https://sync.example.test', 'username': 'synthetic',
                             'password': 'synthetic-only', 'deviceName': 'Fixture',
                             'mergeConfirmed': True, 'autoSync': False})
            store.operations = [{'opId': 'op-fixture', 'entityType': 'notes', 'entityId': 'fixture-note',
                                 'action': 'upsert', 'value': {'content': 'temporary test data'}}]
            try:
                manager.sync_once()
                self.assertEqual([row['opId'] for row in store.acknowledged], ['op-fixture'])
                self.assertFalse(manager._sync_lock.locked(), 'completed upload must release its in-process lock')
                with manager.ssh.operation_guard():
                    pass
                manager.sync_now()
                manager.sync_once()
                self.assertFalse(manager._sync_lock.locked())
            finally:
                # Also clean descriptors when exercising the historical leak.
                for descriptor in set(descriptors):
                    try: os.close(descriptor)
                    except OSError: pass


if __name__ == '__main__':
    unittest.main()
