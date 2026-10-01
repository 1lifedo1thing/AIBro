"""SSH management tests use only temporary directories and synthetic service runners."""
import contextlib
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from cloud_ssh import config, read_tunnel, ssh_args, CloudSSH, LABEL
import cloud_ssh_remote as remote
from cloud_sync import CloudSyncError


class SSHTests(unittest.TestCase):
    def test_config_and_ssh_argv_do_not_accept_commands(self):
        for target in ['-oProxyCommand=x', 'host;touch x', 'host\n', 'a@@b', '$(id)', 'host/dir']:
            if target == 'host\n': continue  # surrounding whitespace is trimmed like the UI
            with self.subTest(target=target), self.assertRaises(CloudSyncError): config({'target':target})
        args=ssh_args({'target':'research-alias','sshPort':2222})
        self.assertIn('StrictHostKeyChecking=yes',args); self.assertIn('BatchMode=yes',args)
        self.assertEqual(args[-2:],['-p','2222'])
        self.assertNotIn('-i',args)

    def test_existing_launchagent_is_read_without_changes(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d).resolve()/'tunnel.plist'
            raw=plistlib.dumps({'Label':LABEL,'ProgramArguments':['/usr/bin/ssh','-N','-T','-L','127.0.0.1:18787:127.0.0.1:8787','user@host']})
            path.write_bytes(raw)
            self.assertEqual(read_tunnel(path),{'target':'user@host','sshPort':0,'localPort':18787,'remotePort':8787})
            self.assertEqual(path.read_bytes(),raw)

    def test_identity_and_cursor_checks_reject_another_or_stale_database(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();self.database(root)
            remote.account_check(root,'account',5)
            for account,cursor in [('other',0),('account',7)]:
                with self.assertRaises(ValueError):remote.account_check(root,account,cursor)

    def test_target_cannot_overwrite_or_contain_original_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve()/'source';root.mkdir()
            link=Path(d).resolve()/'link';link.symlink_to(root,target_is_directory=True)
            for target in [str(root),str(root/'nested'),d,str(link/'new'),'../relative']:
                with self.subTest(target=target),self.assertRaises(ValueError):remote.destination(root,target)
            self.assertEqual(remote.destination(root,str(Path(d).resolve()/'new')),Path(d).resolve()/'new')

    @staticmethod
    def database(path):
        path.mkdir(exist_ok=True)
        with sqlite3.connect(path/'cloud.sqlite3') as db:
            db.execute('CREATE TABLE accounts (id TEXT, change_seq INTEGER)')
            db.execute('INSERT INTO accounts VALUES (?,?)',('account',6))
        (path/'attachment').write_bytes(b'synthetic file content')

    def run_move(self,fail_health=False):
        with tempfile.TemporaryDirectory() as d:
            home=Path(d).resolve();source=home/'source';target=home/'new';self.database(source)
            before=remote.manifest(source)
            folder=home/'.config/systemd/user'/f'{remote.UNIT}.d';folder.mkdir(parents=True)
            override=folder/'90-aibro-storage.conf';old=b'[Service]\n# previous config\n';override.write_bytes(old)
            commands=[]
            def control(*args):commands.append(args);return '0' if args[0]=='show' else ''
            def deployment(*args):
                current=target if str(target).encode() in override.read_bytes() else source
                return {'dataPath':str(current),'databasePath':str(current/'cloud.sqlite3'),'remotePort':8787,'active':True,'argv':['/usr/bin/python3','/opt/cloud_server.py','--data-dir',str(source),'serve','--host','127.0.0.1','--port','8787']}
            class Opener:
                def open(self,*a,**k):
                    if fail_health:raise OSError('simulated')
                    from io import BytesIO
                    return BytesIO(b'{"protocol":1}')
            with patch.object(remote.Path,'home',return_value=home),patch.object(remote,'control',side_effect=control),patch.object(remote,'deployment',side_effect=deployment),patch.object(remote.urllib.request,'build_opener',return_value=Opener()):
                payload={'accountId':'account','cursor':5,'expectedPath':str(source),'dataPath':str(target)}
                if fail_health:
                    with self.assertRaisesRegex(ValueError,'恢复旧服务'):remote.relocate(payload)
                    self.assertEqual(override.read_bytes(),old)
                else:
                    result=remote.relocate(payload);self.assertEqual(result['dataPath'],str(target));self.assertEqual(result['previousPath'],str(source))
                self.assertEqual(remote.manifest(source),before)
                self.assertEqual((target/'attachment').read_bytes(),b'synthetic file content')
                self.assertIn(('stop',remote.UNIT),commands)
                self.assertEqual(commands[-1],('start',remote.UNIT))

    def test_copy_checksum_and_switch_preserves_original(self):self.run_move()
    def test_failed_health_restores_old_override_and_keeps_both_copies(self):self.run_move(True)

    def test_systemd_quoting_is_not_shell_interpolation(self):
        self.assertEqual(remote.systemd_arg('/home/u/a%$b'), '"/home/u/a%%$$b"')

    def test_failed_tunnel_reconnect_restores_previous_configuration(self):
        from types import SimpleNamespace
        import threading
        with tempfile.TemporaryDirectory() as d:
            service=SimpleNamespace(_sync_lock=threading.Lock())
            launches=[]; loaded=True; failed=False
            def runner(args,**kwargs):
                nonlocal loaded,failed
                launches.append(args[1])
                if args[1]=='print': return SimpleNamespace(returncode=0 if loaded else 113)
                if args[1]=='bootout': loaded=False
                if args[1]=='bootstrap':
                    if not failed: failed=True;return SimpleNamespace(returncode=1)
                    loaded=True
                return SimpleNamespace(returncode=0)
            manager=CloudSSH(service,home=Path(d).resolve(),runner=runner)
            manager.path.parent.mkdir(parents=True)
            original=plistlib.dumps({'Label':LABEL,'ProgramArguments':['/usr/bin/ssh','-N','-L','127.0.0.1:18787:127.0.0.1:8787','old-host']})
            manager.path.write_bytes(original)
            with patch.object(manager,'_bound',return_value={'accountId':'fixture'}),patch.object(manager,'_remote',return_value={'remotePort':8787}):
                with self.assertRaisesRegex(CloudSyncError,'还原旧配置'):manager.save({'config':{'target':'new-host'}})
            self.assertEqual(manager.path.read_bytes(),original)
            self.assertEqual(launches,['print','bootout','print','bootstrap','bootout','print','bootstrap','print'])
            self.assertFalse(service._sync_lock.locked());self.assertFalse(manager.lock.locked())
            self.assertEqual(len(list(manager.path.parent.glob('*.backup-*'))),1)

    def test_move_requires_confirmation_before_any_action(self):
        with tempfile.TemporaryDirectory() as d:
            ssh=CloudSSH(None,home=d,runner=lambda *a,**k:self.fail('must not run commands'))
            with self.assertRaisesRegex(CloudSyncError,'确认'):ssh.move({})

    def test_move_attempt_identity_survives_completion_and_changes_on_same_path_retry(self):
        from types import SimpleNamespace
        import threading

        with tempfile.TemporaryDirectory() as d:
            source, destination = '/srv/fixture/source', '/srv/fixture/destination'
            settings = {'autoSync': True}
            service = SimpleNamespace(
                _sync_lock=threading.Lock(),
                status=lambda: {**settings, 'target': {'serverUrl': 'http://127.0.0.1:18787', 'accountId': 'fixture-account'}},
                settings=lambda patch: settings.update(patch),
            )
            deferred, requests = [], []

            class DeferredThread:
                def __init__(self, *, target, daemon, name):
                    deferred.append(target)

                def start(self):
                    pass

            def runner(args, **kwargs):
                self.assertEqual(args[0], '/usr/bin/ssh')
                payload = json.loads(kwargs['input'])
                self.assertIn(payload['action'], ('move', 'move-status'))
                self.assertEqual(payload['expectedPath'], source)
                self.assertEqual(payload['dataPath'], destination)
                requests.append(payload)
                if len(requests) == 1:
                    return SimpleNamespace(returncode=1, stdout='', stderr='synthetic first-attempt failure')
                return SimpleNamespace(returncode=0, stdout=json.dumps({
                    'ok': True, 'remotePort': 8787, 'dataPath': source if payload['action'] == 'move-status' else destination,
                    'databasePath': destination + '/cloud.sqlite3', 'active': True,
                    'job': {'id': payload['jobId'], 'source': source, 'destination': destination,
                            'state': 'error' if payload['action'] == 'move-status' else 'completed',
                            'phase': 'rejected' if payload['action'] == 'move-status' else 'verified', 'message': 'synthetic result'},
                }))

            manager = CloudSSH(service, home=Path(d).resolve(), runner=runner)
            manager.path.parent.mkdir(parents=True)
            manager.path.write_bytes(plistlib.dumps({
                'Label': LABEL,
                'ProgramArguments': ['/usr/bin/ssh', '-N', '-L', '127.0.0.1:18787:127.0.0.1:8787', 'fixture-host'],
            }))
            manager.remote_info = {'dataPath': source, 'remotePort': 8787}
            payload = {'confirmed': True, 'expectedPath': source, 'dataPath': destination}
            attempt_ids = []

            with patch('cloud_ssh.threading.Thread', DeferredThread):
                for terminal_state in ['uncertain', 'completed']:
                    running = manager.move(payload)['job']
                    self.assertEqual(running['state'], 'running')
                    self.assertRegex(running['id'], r'^[a-f0-9]{32}$')
                    self.assertNotIn(running['id'], attempt_ids)
                    attempt_ids.append(running['id'])
                    self.assertTrue(manager.lock.locked())
                    self.assertTrue(service._sync_lock.locked())
                    self.assertEqual(len(deferred), 1)

                    deferred.pop()()
                    terminal = manager.status()['job']
                    self.assertEqual(terminal['state'], terminal_state)
                    self.assertEqual(terminal['id'], running['id'])
                    self.assertEqual((terminal['source'], terminal['destination']), (source, destination))
                    self.assertFalse(manager.lock.locked())
                    self.assertFalse(service._sync_lock.locked())
                    if terminal_state == 'uncertain':
                        with self.assertRaisesRegex(CloudSyncError, '尚未确认'): manager.move(payload)
                        manager.reconcile({'jobId': running['id']})
                        manager.remote_info = {'dataPath': source, 'remotePort': 8787}

            self.assertEqual(len(requests), 3)
            self.assertEqual(manager.remote_info['dataPath'], destination)

if __name__=='__main__':unittest.main()
