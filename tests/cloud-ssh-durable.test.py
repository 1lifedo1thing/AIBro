"""Durable SSH migration: only isolated files and synthetic SSH/service calls."""
import contextlib
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from cloud_ssh import CloudSSH, LABEL, JOURNAL_LIMIT
from cloud_sync import CloudSync, CloudSyncError
import cloud_ssh_remote as remote


class DeferredThread:
    pending = []
    def __init__(self, *, target, daemon, name): self.target = target
    def start(self): self.pending.append(self.target)


class DurableSSHTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-ssh-durable-'); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve(); self.home = self.base / 'home'; self.home.mkdir()
        self.target = {'serverUrl': 'http://127.0.0.1:18787', 'accountId': 'fixture-account'}
        self.auto = True; self.requests = []; self.reply = 'lost'; self.cursor = 5
        self.service = SimpleNamespace(directory=self.base / 'workspace', _sync_lock=threading.Lock(),
            status=lambda: {'target': dict(self.target), 'cursor': self.cursor, 'autoSync': self.auto}, settings=self.settings)
        self.manager = self.new_manager()
        self.manager.path.parent.mkdir(parents=True)
        self.manager.path.write_bytes(plistlib.dumps({'Label': LABEL, 'ProgramArguments': [
            '/usr/bin/ssh', '-N', '-L', '127.0.0.1:18787:127.0.0.1:8787', 'fixture-host']}))
        self.source = '/srv/aibro-source'; self.destination = '/srv/aibro-destination'
        self.manager.remote_info = {'dataPath': self.source, 'remotePort': 8787}
        self.addCleanup(DeferredThread.pending.clear)

    def settings(self, payload): self.auto = payload['autoSync']
    def new_manager(self): return CloudSSH(self.service, home=self.home, runner=self.runner)
    def payload(self): return {'confirmed': True, 'expectedPath': self.source, 'dataPath': self.destination}
    def receipt(self, request, **changes):
        state = 'error' if self.reply == 'error' else 'completed'
        path = self.source if state == 'error' else self.destination
        job = {'id': request['jobId'], 'source': request['expectedPath'], 'destination': request['dataPath'],
               'state': state, 'phase': 'rejected' if state == 'error' else 'verified', 'message': 'fixture receipt'}
        job.update(changes)
        return {'ok': True, 'remotePort': 8787, 'dataPath': path, 'active': True, 'job': job}

    def runner(self, argv, **kwargs):
        self.assertEqual(argv[0], '/usr/bin/ssh'); request = json.loads(kwargs['input']); self.requests.append(request)
        if self.reply == 'lost': raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
        if callable(self.reply): value = self.reply(request)
        else: value = self.receipt(request)
        return SimpleNamespace(returncode=0, stdout=json.dumps(value))

    def start(self):
        with patch('cloud_ssh.threading.Thread', DeferredThread): return self.manager.move(self.payload())['job']
    def finish(self): DeferredThread.pending.pop(0)()
    def lost(self):
        job = self.start(); self.finish(); self.assertEqual(self.manager.status()['job']['state'], 'uncertain'); return job

    def test_initialization_and_status_do_not_create_files_or_call_ssh(self):
        self.assertFalse(self.manager.journal_directory.exists())
        for _ in range(2): self.manager.status()
        self.assertFalse(self.manager.journal_directory.exists()); self.assertEqual(self.requests, [])

    def test_intent_is_durable_and_private_before_pause_and_dispatch(self):
        checked = []
        def pause(payload):
            saved = json.loads(self.manager.journal_path.read_bytes())['job']
            checked.append(saved)
            self.assertEqual(saved['restoreAuto'], True)
            self.assertEqual(saved['identity']['accountId'], self.target['accountId'])
            self.assertEqual(saved['state'], 'running'); self.assertEqual(self.requests, [])
            self.settings(payload)
        self.service.settings = pause
        job = self.start()
        self.assertEqual(len(checked), 1); self.assertEqual(job['id'], checked[0]['id'])
        self.assertEqual(self.manager.journal_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.manager.journal_directory.stat().st_mode & 0o777, 0o700)
        self.assertNotIn('identity', job); self.assertNotIn('accountId', json.dumps(self.manager.status()))
        self.finish()

    def test_actual_new_instance_recovers_uncertain_and_only_explicit_status_uses_ssh(self):
        job = self.lost(); raw = self.manager.journal_path.read_bytes()
        recovered = self.new_manager()
        self.assertEqual(recovered.status()['job']['id'], job['id']); self.assertEqual(recovered.status()['job']['state'], 'uncertain')
        self.assertEqual(len(self.requests), 1); self.assertEqual(recovered.journal_path.read_bytes(), raw)
        self.reply = 'completed'; self.cursor = 8
        result = recovered.reconcile({'jobId': job['id']})
        self.assertEqual(result['job']['state'], 'completed'); self.assertFalse(self.auto)
        self.assertEqual(self.requests[-1]['action'], 'move-status'); self.assertEqual(self.requests[-1]['cursor'], 5)
        self.assertEqual(self.new_manager().status()['job']['state'], 'completed')

    def test_inflight_on_restart_displays_uncertain_without_rewriting_or_replaying(self):
        job = self.start(); before = self.manager.journal_path.read_bytes()
        restarted = self.new_manager()
        self.assertEqual(restarted.status()['job']['state'], 'uncertain')
        self.assertEqual(restarted.status()['job']['id'], job['id'])
        self.assertEqual(restarted.journal_path.read_bytes(), before); self.assertEqual(self.requests, [])
        with self.assertRaises(CloudSyncError): restarted.reconcile({'jobId': job['id']})
        self.finish()

    def test_pending_job_blocks_new_manager_mutations_before_network(self):
        job = self.lost(); restarted = self.new_manager(); restarted.remote_info = self.manager.remote_info
        valid_connect = {'mergeConfirmed': True, 'config': {'target': 'other'}, 'accountId': 'fixture-account', 'deviceName': 'fixture'}
        for fn, payload in [(restarted.move, self.payload()), (restarted.save, {'config': {'target': 'other'}}),
                            (restarted.probe, {'config': {'target': 'other'}}), (restarted.inspect, {}), (restarted.connect, valid_connect)]:
            with self.subTest(action=fn.__name__), self.assertRaises(CloudSyncError): fn(payload)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(restarted.status()['job']['id'], job['id'])

    def test_flock_blocks_other_instance_even_before_a_job_exists(self):
        other = self.new_manager()
        with self.manager.operation_guard():
            with self.assertRaises(CloudSyncError):
                with other.operation_guard(): self.fail('must not obtain shared lease')
        with other.operation_guard(): pass

    def test_wrong_id_or_paths_and_malformed_receipts_remain_blocked(self):
        job = self.lost()
        for change in ({'id': 'f' * 32}, {'source': '/srv/other'}, {'destination': '/srv/other'}, {'phase': None}, {'state': 'done'}):
            self.reply = lambda request, change=change: self.receipt(request, **change)
            with self.subTest(change=change), self.assertRaises(CloudSyncError): self.manager.reconcile({'jobId': job['id']})
            self.assertEqual(self.manager.status()['job']['state'], 'uncertain')
            with self.assertRaises(CloudSyncError): self.manager.assert_not_pending()

    def test_unhealthy_or_historical_terminal_receipt_does_not_release_guard(self):
        job = self.lost()
        for changes in ({'active': False}, {'dataPath': '/srv/other'}, {'remotePort': 9999}, {'dataPath': None}):
            self.reply = lambda request, changes=changes: {**self.receipt(request), **changes}
            with self.subTest(changes=changes), self.assertRaises(CloudSyncError): self.manager.reconcile({'jobId': job['id']})
            with self.assertRaises(CloudSyncError): self.manager.assert_not_pending()

    def test_reconcile_uses_saved_config_when_launchagent_disappears(self):
        job = self.lost(); self.manager.path.unlink(); self.reply = 'completed'
        result = self.new_manager().reconcile({'jobId': job['id']})
        self.assertIsNone(result['config']); self.assertEqual(result['job']['config']['target'], 'fixture-host')
        self.assertEqual(result['job']['state'], 'completed')

    def test_reconcile_refuses_changed_binding_without_ssh(self):
        job = self.lost(); self.target['accountId'] = 'another-account'; before = self.manager.journal_path.read_bytes()
        with self.assertRaises(CloudSyncError): self.manager.reconcile({'jobId': job['id']})
        self.assertEqual(len(self.requests), 1); self.assertEqual(before, self.manager.journal_path.read_bytes())

    def test_corrupt_oversized_or_nonprivate_journal_fails_closed_without_replacement(self):
        self.lost(); valid = self.manager.journal_path.read_bytes()
        for raw, mode in [(b'{broken', 0o600), (b' ' * (JOURNAL_LIMIT + 1), 0o600), (valid, 0o644)]:
            self.manager.journal_path.write_bytes(raw); self.manager.journal_path.chmod(mode)
            restarted = self.new_manager(); job = restarted.status()['job']
            self.assertEqual(job['state'], 'uncertain'); self.assertNotIn('id', job)
            with self.assertRaises(CloudSyncError): restarted.save({'config': {'target': 'other'}})
            self.assertEqual(restarted.journal_path.read_bytes(), raw)
        self.assertEqual(len(self.requests), 1)

    def test_symlink_journal_and_lock_are_never_followed(self):
        self.manager.journal_directory.mkdir(parents=True, mode=0o700)
        unrelated = self.base / 'unrelated'; unrelated.write_bytes(b'keep')
        self.manager.journal_path.symlink_to(unrelated)
        restarted = self.new_manager()
        with self.assertRaises(CloudSyncError): restarted.assert_not_pending()
        self.assertEqual(unrelated.read_bytes(), b'keep')
        self.manager.journal_path.unlink(); self.manager.operation_path.symlink_to(unrelated)
        with self.assertRaises(CloudSyncError):
            with self.manager.operation_guard(): self.fail('unsafe lock')
        self.assertEqual(unrelated.read_bytes(), b'keep')

    def test_thread_start_failure_proves_not_dispatched_and_releases_both_locks(self):
        with patch('cloud_ssh.threading.Thread.start', side_effect=RuntimeError('fixture cannot start')):
            with self.assertRaises(RuntimeError): self.manager.move(self.payload())
        job = self.manager.status()['job']
        self.assertEqual((job['state'], job['phase']), ('error', 'not-dispatched'))
        self.assertEqual(self.requests, []); self.assertFalse(self.manager.lock.locked()); self.assertFalse(self.service._sync_lock.locked())
        with self.new_manager().operation_guard(): pass

    def test_journal_write_failure_never_dispatches(self):
        with patch.object(self.manager, '_persist', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.manager.move(self.payload())
        self.assertEqual(self.requests, []); self.assertTrue(self.auto)
        self.assertFalse(self.manager.lock.locked()); self.assertFalse(self.service._sync_lock.locked())

    def test_invalid_paths_are_rejected_before_journal_or_pause(self):
        for destination in ('/srv/new/', '/srv/../new', '/srv/new\nline', self.source + '/nested', '/srv', '/srv//new'):
            with self.subTest(destination=destination), self.assertRaises(CloudSyncError):
                self.manager.move({**self.payload(), 'dataPath': destination})
            self.assertFalse(self.manager.journal_path.exists())
            self.assertTrue(self.auto); self.assertEqual(self.requests, [])

    def test_service_closed_during_pause_never_dispatches(self):
        self.service._epoch = 1
        def check(epoch):
            if epoch != self.service._epoch: raise CloudSyncError('cancelled', 'CANCELLED')
        self.service._check_epoch = check
        def pause(payload):
            self.settings(payload); self.service._epoch += 1
        self.service.settings = pause
        with self.assertRaises(CloudSyncError): self.manager.move(self.payload())
        self.assertEqual(self.requests, [])
        self.assertEqual(self.manager.status()['job']['phase'], 'not-dispatched')
        self.assertFalse(self.manager.lock.locked()); self.assertFalse(self.service._sync_lock.locked())

    def test_terminal_persistence_failure_remains_blocked_and_restart_reconciles(self):
        self.reply = 'completed'; job = self.start()
        with patch.object(self.manager, '_persist', side_effect=OSError('disk full')): self.finish()
        self.assertEqual(self.manager.status()['job']['state'], 'uncertain')
        with self.assertRaises(CloudSyncError): self.manager.assert_not_pending()
        restarted = self.new_manager()
        self.assertEqual(restarted.status()['job']['state'], 'uncertain')
        self.assertEqual(restarted.reconcile({'jobId': job['id']})['job']['state'], 'completed')

    def test_completed_error_history_survives_restart_and_new_attempt(self):
        self.reply = 'error'; first = self.start(); self.finish()
        restarted = self.new_manager(); self.assertEqual(restarted.status()['job']['state'], 'error')
        self.reply = 'completed'; second = self.start(); self.finish()
        stored = json.loads(self.manager.journal_path.read_bytes())
        self.assertEqual(stored['history'][0]['id'], first['id'])
        self.assertEqual(stored['history'][0]['state'], 'error'); self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(self.new_manager().status()['job']['state'], 'completed')

    def test_real_remote_protocol_lost_reply_then_restart_reconciles_without_copy_or_restart(self):
        remote_home = self.base / 'remote-home'; remote_home.mkdir()
        source = remote_home / 'source'; source.mkdir(); destination = remote_home / 'destination'
        with sqlite3.connect(source / 'cloud.sqlite3') as db:
            db.execute('CREATE TABLE accounts (id TEXT, change_seq INTEGER)')
            db.execute('INSERT INTO accounts VALUES (?, ?)', ('fixture-account', 6))
        (source / 'attachment').write_bytes(b'fixture attachment')
        self.source, self.destination = str(source), str(destination)
        self.manager.remote_info = {'dataPath': self.source, 'remotePort': 8787}
        override = remote_home / '.config/systemd/user' / (remote.UNIT + '.d') / '90-aibro-storage.conf'
        override.parent.mkdir(parents=True)
        commands = []; requests = []; replies = []
        def control(*args): commands.append(args); return '0' if args[0] == 'show' else ''
        def deployment(account=None, cursor=0):
            current = destination if override.exists() and str(destination).encode() in override.read_bytes() else source
            remote.account_check(current, account or 'fixture-account', cursor)
            return {'dataPath': str(current), 'databasePath': str(current / 'cloud.sqlite3'), 'remotePort': 8787, 'active': True,
                    'argv': ['python3', '/opt/cloud_server.py', '--data-dir', str(source), 'serve']}
        def integrated_runner(argv, **kwargs):
            request = json.loads(kwargs['input']); requests.append(request)
            if request['action'] == 'move':
                try: result = remote.move_job(request)
                except Exception as error:
                    replies.append(str(error)); raise
                replies.append(result)
                self.assertEqual(result['job']['state'], 'completed', result)
                raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
            return SimpleNamespace(returncode=0, stdout=json.dumps({'ok': True, **remote.move_status(request)}))
        with patch.object(remote.Path, 'home', return_value=remote_home), patch.object(remote, 'deployment', side_effect=deployment), \
             patch.object(remote, 'control', side_effect=control), patch.object(remote, 'health', return_value=None):
            self.manager.runner = integrated_runner
            job = self.start(); self.finish()
            self.assertEqual(self.manager.status()['job']['state'], 'uncertain')
            self.assertTrue((destination / 'attachment').exists(), replies)
            self.assertEqual((destination / 'attachment').read_bytes(), b'fixture attachment')
            after_move = list(commands)
            restarted = self.new_manager(); restarted.runner = integrated_runner
            result = restarted.reconcile({'jobId': job['id']})
            self.assertEqual(result['job']['state'], 'completed'); self.assertEqual(commands, after_move)
            self.assertEqual([request['action'] for request in requests], ['move', 'move-status'])
            self.assertFalse(self.auto)


class SyncGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-ssh-sync-guard-'); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve(); self.target = {'serverUrl': 'http://127.0.0.1:18787', 'accountId': 'fixture-account'}
        store = SimpleNamespace(status=lambda: {'target': self.target, 'cursor': 3, 'pending': 0, 'conflicts': 0})
        self.service = CloudSync(self.base, store, SimpleNamespace(lock=threading.RLock), start_worker=False,
                                 client_factory=lambda *args, **kwargs: self.fail('must not contact cloud'))
        self.addCleanup(self.service.close)
        self.service.ssh = CloudSSH(self.service, home=self.base / 'home', runner=lambda *args, **kwargs: self.fail('must not SSH'))
        self.service._session = {'serverUrl': self.target['serverUrl'], 'account': {'id': 'fixture-account'}, 'device': {'id': 'fixture-device'}, 'accessToken': 'synthetic-test-token', 'autoSync': True}
        self.service.credentials.save = lambda session: 'fixture'
        self.service._auto = True
        self.record = {'id': 'b' * 32, 'state': 'uncertain', 'phase': 'copying', 'message': 'fixture unknown',
            'source': '/srv/source', 'destination': '/srv/destination', 'restoreAuto': True,
            'identity': {**self.target, 'cursor': 3},
            'config': {'target': 'fixture-host', 'sshPort': 0, 'localPort': 18787, 'remotePort': 8787}}
        with self.service.ssh.operation_guard(): self.service.ssh._persist(self.record)

    def test_pending_guards_manual_automatic_connect_enable_and_resolution(self):
        calls = [self.service.sync_now, self.service.sync_once, lambda: self.service.settings({'autoSync': True}),
                 lambda: self.service.connect({'mergeConfirmed': True, 'serverUrl': self.target['serverUrl'], 'username': 'fixture', 'password': 'fixture', 'deviceName': 'fixture'}),
                 lambda: self.service.resolve('fixture', 'remote', 'a' * 64)]
        for call in calls:
            with self.assertRaises(CloudSyncError): call()
            self.assertFalse(self.service._sync_lock.locked())
        self.assertFalse(self.service._requested)
        self.service.settings({'autoSync': False}); self.assertFalse(self.service._auto)

    def test_guard_is_checked_after_sync_lock_acquisition(self):
        self.service.ssh._record = None; self.service.ssh.job = None
        # Disk journal is authoritative even when this object has stale memory.
        with self.assertRaises(CloudSyncError): self.service.sync_once()
        self.assertEqual(self.service.ssh.job['id'], self.record['id'])

    def test_new_cloud_service_pauses_auto_without_rewriting_journal_or_credentials(self):
        raw = self.service.ssh.journal_path.read_bytes()
        with patch('cloud_sync.CredentialStore.load', return_value=self.service._session), \
             patch('cloud_sync.CredentialStore.save', side_effect=AssertionError('read must not write')):
            restarted = CloudSync(self.base, self.service.store, self.service.workspace, start_worker=False)
            self.addCleanup(restarted.close)
            self.assertFalse(restarted.status()['autoSync'])
            self.assertEqual(restarted.ssh.journal_path.read_bytes(), raw)
            with self.assertRaises(CloudSyncError): restarted.sync_once()

    def test_connection_close_after_health_does_not_login_or_adopt(self):
        self.service.ssh._persist({**self.record, 'state': 'completed', 'phase': 'verified'})
        client = SimpleNamespace(health=self.service.close, request=lambda *a, **k: self.fail('closed service must not log in'))
        self.service._client_factory = lambda *a, **k: client
        with self.assertRaises(CloudSyncError) as caught:
            self.service.connect({'mergeConfirmed': True, 'serverUrl': self.target['serverUrl'], 'username': 'fixture', 'password': 'fixture', 'deviceName': 'fixture'})
        self.assertEqual(caught.exception.code, 'CANCELLED'); self.assertFalse(self.service._sync_lock.locked())
        with self.service.ssh.operation_guard(): pass

    def reconcile(self):
        record = self.record
        value = {'ok': True, 'remotePort': 8787, 'dataPath': record['destination'], 'active': True,
                 'job': {key: record[key] for key in ('id', 'source', 'destination')}}
        value['job'].update(state='completed', phase='verified', message='fixture healthy completion')
        self.service.ssh.runner = lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=json.dumps(value))
        return self.service.ssh.reconcile({'jobId': record['id']})

    def test_confirmed_recovery_clears_only_maintenance_error_and_returns_paused_status(self):
        self.service._last_code = 'SSH_MOVE_PENDING'; self.service._last_error = 'fixture pending'
        result = self.reconcile()
        self.assertEqual(result['job']['state'], 'completed')
        self.assertEqual(result['cloudStatus']['state'], 'paused')
        self.assertFalse(result['cloudStatus']['autoSync'])
        self.assertIsNone(result['cloudStatus']['errorCode']); self.assertIsNone(result['cloudStatus']['error'])

    def test_confirmed_recovery_preserves_unrelated_authentication_error(self):
        self.service._last_code = 'HTTP_401'; self.service._last_error = 'fixture login expired'
        result = self.reconcile()
        self.assertEqual(result['job']['state'], 'completed')
        self.assertEqual(result['cloudStatus']['state'], 'auth_required')
        self.assertEqual(result['cloudStatus']['errorCode'], 'HTTP_401')
        self.assertEqual(result['cloudStatus']['error'], 'fixture login expired')


if __name__ == '__main__': unittest.main()
