"""SSH account authorization: only synthetic SSH/launchctl, real isolated HTTP/SQLite."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
if not hasattr(hashlib, 'scrypt'):
    for candidate in ('python3.13', 'python3.12', 'python3.11'):
        executable = shutil.which(candidate)
        if executable and subprocess.run([executable, '-c', 'import hashlib;raise SystemExit(not hasattr(hashlib,"scrypt"))'], capture_output=True).returncode == 0:
            os.execv(executable, [executable, *sys.argv])
    raise SystemExit('Tests require Python with scrypt')
import cloud_ssh_remote as remote
from cloud_ssh import CloudSSH, LABEL, discover_hosts
from cloud_sync import CloudSync, CloudSyncError, CredentialStore
from cloud_server import CloudStore, CloudHTTPServer


class Store:
    def __init__(self): self.target = None; self.cursor = 0
    def status(self): return {'target': self.target, 'cursor': self.cursor, 'pending': 4, 'conflicts': 0}
    def bind_target(self, target):
        if self.target and self.target != target: raise ValueError('mismatched target')
        self.target = dict(target)


class Workspace:
    def __init__(self): self.lock = threading.RLock


class ConnectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-ssh-connect-'); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve(); self.home = self.base / 'home'; self.home.mkdir()
        self.remote = CloudStore(self.base / 'remote')
        self.account = self.remote.add_user('fixture', 'test-only-password-42!', initial=True)
        self.other = self.remote.add_user('second', 'test-only-password-42!')
        self.http = CloudHTTPServer(('127.0.0.1', 0), self.remote)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addCleanup(self.http.server_close); self.addCleanup(self.http.shutdown)
        self.store = Store(); self.manager = CloudSync(self.base / 'local', self.store, Workspace(), start_worker=False)
        self.addCleanup(self.manager.close)
        self.loaded = False; self.launches = []; self.calls = []; self.after_authorize = None; self.fail_bootstrap = False
        self.ssh = CloudSSH(self.manager, home=self.home, runner=self.runner); self.manager.ssh = self.ssh
        self.config = {'target': 'fixture-host', 'localPort': self.http.server_port, 'remotePort': 8787, 'sshPort': 0}

    def deployment(self, account_id=None, cursor=0):
        if account_id: remote.account_check(self.remote.directory, account_id, cursor)
        return {'dataPath': str(self.remote.directory), 'databasePath': str(self.remote.path), 'remotePort': 8787, 'active': True, 'service': remote.UNIT, 'argv': ['python3', 'cloud_server.py']}

    def runner(self, argv, **kwargs):
        if argv[0] == '/usr/bin/ssh':
            self.assertIn('StrictHostKeyChecking=yes', argv); self.assertIn('BatchMode=yes', argv); self.assertIn('ClearAllForwardings=yes', argv)
            payload = json.loads(kwargs['input']); self.calls.append(payload)
            try:
                with patch.object(remote, 'deployment', side_effect=self.deployment):
                    if payload['action'] == 'probe': result = remote.probe(payload)
                    elif payload['action'] in ('authorize-device', 'revoke-device'):
                        result = remote.device_action(payload, revoke=payload['action'] == 'revoke-device')
                        if payload['action'] == 'authorize-device' and self.after_authorize: self.after_authorize()
                    else: raise AssertionError(payload['action'])
                return SimpleNamespace(returncode=0, stdout=json.dumps({'ok': True, **result}))
            except ValueError as error: return SimpleNamespace(returncode=0, stdout=json.dumps({'ok': False, 'error': str(error)}))
        self.assertEqual(argv[0], '/bin/launchctl'); self.launches.append(argv[1])
        if argv[1] == 'print': return SimpleNamespace(returncode=0 if self.loaded else 113)
        if argv[1] == 'bootout': self.loaded = False
        elif argv[1] == 'bootstrap':
            if self.fail_bootstrap: self.fail_bootstrap = False; return SimpleNamespace(returncode=1)
            self.loaded = True
        return SimpleNamespace(returncode=0)

    def payload(self, **changes):
        return {'config': self.config, 'accountId': self.account['id'], 'deviceName': 'Fixture Mac', 'mergeConfirmed': True, 'autoSync': False, **changes}

    def active_tokens(self):
        with self.remote.db() as db: return db.execute('SELECT COUNT(*) FROM tokens').fetchone()[0]

    def old_tunnel(self):
        self.ssh.path.parent.mkdir(parents=True)
        value = {'Label': LABEL, 'ProgramArguments': ['/usr/bin/ssh', '-N', '-L', f'127.0.0.1:{self.config["localPort"]}:127.0.0.1:8787', 'old-host'], 'KeepAlive': True}
        self.ssh.path.write_bytes(plistlib.dumps(value)); self.ssh.path.chmod(0o600); self.loaded = True
        return self.ssh.path.read_bytes()

    def test_probe_lists_metadata_without_authorization_or_local_writes(self):
        before = self.remote.path.read_bytes()
        result = self.ssh.probe({'config': self.config})
        self.assertEqual({a['id'] for a in result['remote']['accounts']}, {self.account['id'], self.other['id']})
        self.assertEqual(self.active_tokens(), 0); self.assertFalse(self.ssh.path.exists()); self.assertEqual(self.launches, [])
        self.assertEqual(self.remote.path.read_bytes(), before)
        self.assertFalse(self.manager.status()['connected'])

    def test_first_connection_creates_tunnel_and_real_authenticated_device_without_password(self):
        result = self.ssh.connect(self.payload())
        self.assertTrue(result['status']['connected']); self.assertEqual(result['status']['account']['id'], self.account['id'])
        self.assertTrue(self.ssh.path.is_file()); self.assertTrue(self.loaded)
        self.assertEqual(self.active_tokens(), 1); self.assertEqual(result['status']['pending'], 4)
        token = self.manager._session['accessToken']
        self.assertNotIn(token, json.dumps(result)); self.assertNotIn(token, json.dumps(self.calls)); self.assertNotIn('tokenHash', json.dumps(self.ssh.status()))
        self.assertEqual(self.manager.devices()['devices'][0]['current'], True)
        self.assertEqual(self.manager.credentials.path.stat().st_mode & 0o777, 0o600)
        self.manager.revoke(self.manager._session['device']['id']); self.assertFalse(self.manager.status()['connected'])
        self.assertEqual(self.active_tokens(), 0)

    def test_bound_recovery_preserves_localhost_url_account_and_cursor(self):
        self.store.target = {'serverUrl': f'http://localhost:{self.http.server_port}', 'accountId': self.account['id']}
        result = self.ssh.probe({'config': self.config}); self.assertEqual(result['remote']['accounts'], [self.account])
        connected = self.ssh.connect(self.payload())
        self.assertEqual(connected['status']['serverUrl'], self.store.target['serverUrl']); self.assertEqual(self.store.cursor, 0)
        with self.assertRaisesRegex(CloudSyncError, '原云端账号'): self.ssh.connect(self.payload(accountId=self.other['id']))

    def test_stale_account_or_port_mismatch_never_authorizes(self):
        self.store.target = {'serverUrl': f'http://127.0.0.1:{self.http.server_port}', 'accountId': self.account['id']}; self.store.cursor = 1
        with self.assertRaisesRegex(CloudSyncError, '更旧'): self.ssh.connect(self.payload())
        with self.assertRaisesRegex(CloudSyncError, '本机端口'): self.ssh.probe({'config': {**self.config, 'localPort': self.http.server_port + 1}})
        self.assertEqual(self.active_tokens(), 0); self.assertFalse(self.ssh.path.exists())

    def test_explicit_confirmation_and_account_are_required_before_ssh(self):
        for changes in ({'mergeConfirmed': False}, {'accountId': None}, {'deviceName': '\n'}):
            with self.assertRaises(CloudSyncError): self.ssh.connect(self.payload(**changes))
        self.assertEqual(self.calls, [])

    def test_cancel_during_authorization_revokes_device_and_never_reconnects(self):
        self.after_authorize = self.manager.disconnect
        with self.assertRaisesRegex(CloudSyncError, '取消'): self.ssh.connect(self.payload())
        self.assertFalse(self.manager.status()['connected']); self.assertEqual(self.active_tokens(), 0)
        self.assertFalse(self.ssh.path.exists()); self.assertFalse(self.manager.credentials.path.exists())

    def test_failed_local_credential_save_revokes_and_restores_original_tunnel(self):
        original = self.old_tunnel()
        with patch.object(self.manager.credentials, 'save', side_effect=OSError('synthetic disk error')):
            with self.assertRaises(CloudSyncError): self.ssh.connect(self.payload())
        self.assertEqual(self.ssh.path.read_bytes(), original); self.assertTrue(self.loaded)
        self.assertEqual(self.active_tokens(), 0); self.assertFalse(self.manager.status()['connected']); self.assertIsNone(self.store.target)

    def test_failed_bootstrap_restores_old_tunnel_and_revokes(self):
        original = self.old_tunnel(); self.fail_bootstrap = True
        with self.assertRaisesRegex(CloudSyncError, '启动失败'): self.ssh.connect(self.payload())
        self.assertEqual(self.ssh.path.read_bytes(), original); self.assertTrue(self.loaded); self.assertEqual(self.active_tokens(), 0)

    def test_failed_rollback_bootout_preserves_running_job_configuration(self):
        runner = self.runner
        def fail_bootout(argv, **kwargs):
            if argv[:2] == ['/bin/launchctl', 'bootout']:
                self.launches.append('bootout-denied'); return SimpleNamespace(returncode=1)
            return runner(argv, **kwargs)
        with patch.object(self.ssh, 'runner', side_effect=fail_bootout), patch.object(self.manager.credentials, 'save', side_effect=OSError('synthetic disk error')):
            with self.assertRaises(CloudSyncError) as caught: self.ssh.connect(self.payload())
        self.assertEqual(caught.exception.code, 'SSH_ROLLBACK')
        self.assertTrue(self.loaded); self.assertTrue(self.ssh.path.is_file())
        self.assertEqual(plistlib.loads(self.ssh.path.read_bytes())['ProgramArguments'][-1], self.config['target'])
        self.assertEqual(self.active_tokens(), 0); self.assertFalse(self.manager.status()['connected'])
        # The retained job is still recognized and can be reused on retry.
        self.assertTrue(self.ssh.connect(self.payload())['status']['connected'])

    def test_unknown_rollback_job_status_preserves_plist(self):
        runner = self.runner
        def unknown_after_bootout(argv, **kwargs):
            if argv[:2] == ['/bin/launchctl', 'print'] and 'bootout' in self.launches:
                return SimpleNamespace(returncode=5)
            return runner(argv, **kwargs)
        with patch.object(self.ssh, 'runner', side_effect=unknown_after_bootout), patch.object(self.manager.credentials, 'save', side_effect=OSError('synthetic disk error')):
            with self.assertRaises(CloudSyncError) as caught: self.ssh.connect(self.payload())
        self.assertEqual(caught.exception.code, 'SSH_ROLLBACK'); self.assertTrue(self.ssh.path.is_file())
        self.assertFalse(self.loaded); self.assertEqual(self.active_tokens(), 0)

    def test_failed_bootout_with_confirmed_absent_job_can_finish_rollback(self):
        runner = self.runner
        def failed_after_stop(argv, **kwargs):
            result = runner(argv, **kwargs)
            return SimpleNamespace(returncode=1) if argv[:2] == ['/bin/launchctl', 'bootout'] else result
        with patch.object(self.ssh, 'runner', side_effect=failed_after_stop), patch.object(self.manager.credentials, 'save', side_effect=OSError('synthetic disk error')):
            with self.assertRaises(CloudSyncError) as caught: self.ssh.connect(self.payload())
        self.assertEqual(caught.exception.code, 'SSH_CONNECT_FAILED')
        self.assertFalse(self.loaded); self.assertFalse(self.ssh.path.exists()); self.assertEqual(self.active_tokens(), 0)

    def test_failed_switch_bootout_does_not_overwrite_original_job(self):
        original = self.old_tunnel(); runner = self.runner
        def fail_bootout(argv, **kwargs):
            if argv[:2] == ['/bin/launchctl', 'bootout']:
                self.launches.append('bootout-denied'); return SimpleNamespace(returncode=1)
            return runner(argv, **kwargs)
        with patch.object(self.ssh, 'runner', side_effect=fail_bootout):
            with self.assertRaises(CloudSyncError) as caught: self.ssh.connect(self.payload())
        self.assertEqual(caught.exception.code, 'SSH_ROLLBACK'); self.assertEqual(self.ssh.path.read_bytes(), original)
        self.assertTrue(self.loaded); self.assertNotIn('bootstrap', self.launches); self.assertEqual(self.active_tokens(), 0)

    def test_unknown_initial_job_status_prevents_authorization(self):
        runner = self.runner
        def unknown(argv, **kwargs):
            if argv[:2] == ['/bin/launchctl', 'print']: return SimpleNamespace(returncode=5)
            return runner(argv, **kwargs)
        with patch.object(self.ssh, 'runner', side_effect=unknown):
            with self.assertRaises(CloudSyncError) as caught: self.ssh.connect(self.payload())
        self.assertEqual(caught.exception.code, 'SSH_JOB_STATUS'); self.assertEqual(self.active_tokens(), 0)
        self.assertFalse(self.ssh.path.exists()); self.assertEqual([item['action'] for item in self.calls], ['probe'])

    def test_maintenance_rejects_unrecognized_existing_launchagent(self):
        self.ssh.path.parent.mkdir(parents=True)
        original = plistlib.dumps({'Label': 'unrelated', 'ProgramArguments': ['/bin/true']})
        self.ssh.path.write_bytes(original)
        with patch.object(self.ssh, '_bound', return_value={'accountId': self.account['id']}), patch.object(self.ssh, '_remote', return_value={}):
            with self.assertRaisesRegex(CloudSyncError, '未覆盖'): self.ssh.save({'config': self.config})
        self.assertEqual(self.ssh.path.read_bytes(), original); self.assertEqual(self.launches, [])

    def test_maintenance_rollback_also_preserves_unstopped_replacement(self):
        original = self.old_tunnel(); runner = self.runner
        def fail_second_bootout(argv, **kwargs):
            if argv[:2] == ['/bin/launchctl', 'bootout'] and 'bootout' in self.launches:
                self.launches.append('bootout-denied'); return SimpleNamespace(returncode=1)
            return runner(argv, **kwargs)
        with patch.object(self.ssh, 'runner', side_effect=fail_second_bootout), patch.object(self.ssh, '_bound', return_value={'accountId': self.account['id']}), patch.object(self.ssh, '_remote', return_value={}), patch('cloud_sync.CloudClient.health', side_effect=CloudSyncError('synthetic health failure')), patch('cloud_ssh.time.sleep'):
            with self.assertRaises(CloudSyncError) as caught: self.ssh.save({'config': self.config})
        self.assertEqual(caught.exception.code, 'SSH_ROLLBACK'); self.assertTrue(self.loaded)
        self.assertNotEqual(self.ssh.path.read_bytes(), original)
        self.assertEqual(plistlib.loads(self.ssh.path.read_bytes())['ProgramArguments'][-1], self.config['target'])
        self.assertEqual(next(self.ssh.path.parent.glob('*.backup-*')).read_bytes(), original)

    def test_wrong_real_http_endpoint_returns_401_and_rolls_back_new_tunnel(self):
        other_store = CloudStore(self.base / 'other-server')
        other_http = CloudHTTPServer(('127.0.0.1', 0), other_store)
        threading.Thread(target=other_http.serve_forever, daemon=True).start()
        try:
            payload = self.payload(config={**self.config, 'localPort': other_http.server_port})
            with self.assertRaises(CloudSyncError) as caught: self.ssh.connect(payload)
            self.assertEqual(caught.exception.code, 'HTTP_401')
            self.assertEqual(self.active_tokens(), 0); self.assertFalse(self.ssh.path.exists()); self.assertIsNone(self.store.target)
        finally: other_http.shutdown(); other_http.server_close()

    def test_unrecognized_existing_launchagent_is_never_overwritten(self):
        self.ssh.path.parent.mkdir(parents=True); original = plistlib.dumps({'Label': 'unrelated', 'ProgramArguments': ['/bin/true']})
        self.ssh.path.write_bytes(original)
        with self.assertRaisesRegex(CloudSyncError, '未覆盖'): self.ssh.connect(self.payload())
        self.assertEqual(self.ssh.path.read_bytes(), original); self.assertEqual(self.active_tokens(), 0)

    def test_schema_permissions_and_symlink_rejected_without_new_device(self):
        self.remote.path.chmod(0o644)
        with self.assertRaisesRegex(CloudSyncError, '私有'): self.ssh.probe({'config': self.config})
        self.remote.path.chmod(0o600)
        with self.remote.db() as db: db.execute('PRAGMA user_version=2')
        with self.assertRaisesRegex(CloudSyncError, '版本'): self.ssh.connect(self.payload())
        self.assertEqual(self.active_tokens(), 0)
        with self.remote.db() as db: db.execute('PRAGMA user_version=1')
        moved = self.remote.path.with_suffix('.old'); self.remote.path.rename(moved); self.remote.path.symlink_to(moved)
        with self.assertRaisesRegex(CloudSyncError, '符号链接'): self.ssh.probe({'config': self.config})

    def test_disconnect_during_local_save_does_not_reattach(self):
        save = self.manager.credentials.save
        def cancelling_save(value):
            result = save(value); self.manager.disconnect(); return result
        with patch.object(self.manager.credentials, 'save', side_effect=cancelling_save):
            with self.assertRaises(CloudSyncError) as caught: self.ssh.connect(self.payload())
        self.assertEqual(caught.exception.code, 'CANCELLED')
        self.assertEqual(self.active_tokens(), 0); self.assertFalse(self.manager.status()['connected'])
        self.assertFalse(self.manager.credentials.path.exists()); self.assertFalse(self.ssh.path.exists())

    def test_timed_out_authorization_is_cleaned_by_known_device_and_hash(self):
        def lost_reply(): raise subprocess.TimeoutExpired('synthetic ssh', 1)
        self.after_authorize = lost_reply
        with self.assertRaises(CloudSyncError): self.ssh.connect(self.payload())
        self.assertEqual(self.active_tokens(), 0); self.assertFalse(self.manager.status()['connected'])
        self.assertEqual([call['action'] for call in self.calls], ['probe', 'authorize-device', 'revoke-device'])

    def test_remote_process_owner_and_missing_service_are_checked(self):
        with patch.object(remote, 'control', side_effect=subprocess.CalledProcessError(3, 'systemctl')):
            with self.assertRaisesRegex(ValueError, '先部署'): remote.deployment()
        real_path = Path
        proc = SimpleNamespace(stat=lambda: SimpleNamespace(st_uid=os.getuid() + 1))
        with patch.object(remote, 'control', side_effect=['active', '456']), patch.object(remote, 'Path', side_effect=lambda value: proc if str(value) == '/proc/456' else real_path(value)):
            with self.assertRaisesRegex(ValueError, '进程不属于'): remote.deployment()

    def test_cleanup_only_revokes_matching_attempt_not_another_device(self):
        self.ssh.connect(self.payload()); existing = self.manager._session.copy()
        other = {**self.calls[1], 'deviceId': existing['device']['id'], 'tokenHash': '0' * 64}
        with patch.object(remote, 'deployment', side_effect=self.deployment): remote.device_action(other, revoke=True)
        self.assertEqual(self.active_tokens(), 1)
        self.assertTrue(self.manager.devices()['devices'][0]['current'])


class LocalConfigurationTests(unittest.TestCase):
    def test_discovery_reads_literal_hosts_and_includes_never_executes_match(self):
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw).resolve(); ssh = home / '.ssh'; ssh.mkdir()
            (ssh / 'parts').mkdir()
            (ssh / 'config').write_text('Host first *.example !bad\n HostName private-target\n IdentityFile ~/.ssh/id_rsa\nInclude parts/*\nMatch exec "touch should-never-exist"\nHost second\n')
            (ssh / 'parts/hosts').write_text('Host=third\nInclude config\nHost first\n')
            with patch('subprocess.run', side_effect=AssertionError('no subprocess during discovery')):
                self.assertEqual(discover_hosts(home), [{'target': a, 'label': a} for a in ['first', 'second', 'third']])
            self.assertFalse((home / 'should-never-exist').exists())

    def test_session_store_never_uses_keyring_and_legacy_requires_reauthorization(self):
        with tempfile.TemporaryDirectory() as raw:
            store = CredentialStore(raw)
            class Forbidden:
                def __getattr__(self, _): raise AssertionError('must not access keyring')
            store._keyring = Forbidden()
            self.assertEqual(store.save({'accessToken': 'fixture-token'}), 'protected-file')
            self.assertEqual(store.load()['accessToken'], 'fixture-token'); store.clear()
            store._write({'credentialStorage': 'macos-keychain'})
            with self.assertRaises(CloudSyncError) as caught: store.load()
            self.assertEqual(caught.exception.code, 'SSH_REAUTH_REQUIRED'); store.clear()


if __name__ == '__main__': unittest.main()
