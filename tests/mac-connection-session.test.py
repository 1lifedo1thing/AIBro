"""Protected Mac cloud sessions + fixed transport; synthetic HTTP and real flock.

The independent process models the session-lock part of a native CAS commit.
Swift's encrypted whole-bundle CAS has its own native test; this is not App QA.
"""
from concurrent.futures import ThreadPoolExecutor
import http.client
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
from cloud_sync import CloudSync, CloudSyncError, CloudClient, CredentialStore
from cloud_server import CloudStore, CloudHTTPServer


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


support = load('isolated_cloud_sync_support', ROOT / 'tests/cloud-sync.test.py')
ORIGIN = 'https://sync.example.test'
CHILD = r'''
import json,sys
from pathlib import Path
from cloud_sync import CredentialStore
root,expected=sys.argv[1:]
store=CredentialStore(root)
with store.locked():
    session=store.load()
    valid=bool(session and session.get('connectionSession',{}).get('generation')==expected)
    print('locked' if valid else 'stale',flush=True)
    if valid:
        if sys.stdin.readline().strip()!='commit': raise SystemExit(2)
        # A harmless marker stands for the native commit point under this lock.
        (Path(root)/'synthetic-cas-commit').write_text('committed')
'''


class MacConnectionSessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = "const c=require('./app/connection-vault').createConnectionVault(require('node:crypto').webcrypto);c.generateDeviceKeyPair().then(x=>process.stdout.write(JSON.stringify({publicJwk:x.publicJwk,fingerprint:x.fingerprint})));"
        cls.key = json.loads(subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True,
            check=True, text=True, timeout=15).stdout)
        cls.server_temp = tempfile.TemporaryDirectory(prefix='aibro-local-router-')
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': cls.server_temp.name, 'AI_WORKSTATION_PORT': '0'}):
            cls.local_module = load('isolated_mac_connection_server', ROOT / 'app/server.py')

    @classmethod
    def tearDownClass(cls):
        cls.local_module.EXTERNAL_NOTIFICATIONS.close()
        cls.server_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-mac-connection-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = CloudStore(self.root / 'remote', connection_origin=ORIGIN)
        self.remote.add_user('synthetic-owner', 'public-synthetic-passphrase-only')
        self.http = CloudHTTPServer(('127.0.0.1', 0), self.remote, web_origins=[])
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addCleanup(self.http.server_close); self.addCleanup(self.http.shutdown)
        self.url = 'http://127.0.0.1:' + str(self.http.server_port)
        self.store = support.MemoryStore()
        self.workspace = support.Workspace(self.root / 'local', self.store)
        self.store.workspace = self.workspace
        self.manager = CloudSync(self.root / 'local', self.store, self.workspace, start_worker=False)
        self.addCleanup(self.manager.close)
        self.login()
        self.secret = secrets.token_urlsafe(32)

    def login(self):
        return self.manager.connect({'serverUrl': self.url, 'username': 'synthetic-owner',
            'password': 'public-synthetic-passphrase-only', 'deviceName': 'Synthetic Mac',
            'mergeConfirmed': True, 'autoSync': False})

    def enable(self):
        initial = self.manager.connections_capabilities({})
        return self.manager.connections_capabilities({'confirmedOrigin': ORIGIN, 'session': initial['session']})

    def request(self, caps, operation='initialize', payload=None):
        return {'session': {**caps['session'], 'serverOrigin': caps['origin']}, 'operation': operation,
            'deviceId': self.key['fingerprint'], 'deviceSecret': self.secret,
            'payload': {'publicJwk': self.key['publicJwk']} if payload is None else payload}

    def local_server(self):
        module = self.local_module
        class Handler(module.Handler):
            def log_message(self, *args): pass
        server = module.LoopbackHTTPServer(('127.0.0.1', 0), Handler)
        replacement = patch.object(module, 'cloud_service', lambda: self.manager)
        replacement.start(); self.addCleanup(replacement.stop)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        return server

    def call(self, server, path, payload=None, *, method='POST', origin=True, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        try:
            headers = {'Content-Type': 'application/json'}
            if origin: headers['Origin'] = 'http://127.0.0.1:' + str(server.server_port)
            data = raw if raw is not None else json.dumps({} if payload is None else payload)
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally: connection.close()

    def child(self, generation):
        process = subprocess.Popen([sys.executable, '-c', CHILD, str(self.root / 'local'), generation],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**os.environ, 'PYTHONPATH': str(ROOT / 'app'), 'PYTHONDONTWRITEBYTECODE': '1'})
        def cleanup():
            if process.poll() is None: process.kill()
            process.communicate(timeout=5)
        self.addCleanup(cleanup)
        return process

    def test_real_http_pinning_initialize_and_remote_error_wrapper(self):
        server = self.local_server()
        code, initial = self.call(server, '/__cloud/connections/capabilities')
        self.assertEqual((code, initial['supported'], initial['usable'], initial['requiresConfirmation']), (200, True, False, True))
        with self.assertRaisesRegex(CloudSyncError, '核对'):
            self.manager.connections_transport(self.request(initial))
        code, caps = self.call(server, '/__cloud/connections/capabilities', {'confirmedOrigin': ORIGIN, 'session': initial['session']})
        self.assertEqual((code, caps['usable'], caps['requiresConfirmation']), (200, True, False))
        self.assertNotEqual(initial['session']['sessionGeneration'], caps['session']['sessionGeneration'])
        code, result = self.call(server, '/__cloud/connections/transport', self.request(caps))
        self.assertEqual((code, result['status'], result['body']['status']), (200, 200, 'owner'))
        invalid = self.request(caps, 'read', {'epoch': 999})
        code, result = self.call(server, '/__cloud/connections/transport', invalid)
        self.assertEqual((code, result), (200, {'status': 409, 'body': {}}))
        public = json.dumps([initial, caps, result, self.manager.status()])
        self.assertNotIn(self.secret, public)
        self.assertNotIn(self.manager.credentials.load()['accessToken'], public)
        self.assertEqual(self.manager.credentials.path.stat().st_mode & 0o777, 0o600)

    def test_local_route_rejects_nonorigin_unknown_operation_duplicate_fields_and_unbounded_body(self):
        server = self.local_server(); caps = self.enable()
        path = '/__cloud/connections/transport'
        self.assertEqual(self.call(server, path, self.request(caps), origin=False)[0], 403)
        self.assertEqual(self.call(server, path, method='GET')[0], 400)
        self.assertEqual(self.call(server, path + '?url=https://other.example.test', self.request(caps))[0], 400)
        self.assertEqual(self.call(server, '/__cloud/connections/arbitrary')[0], 404)
        self.assertEqual(self.call(server, path, raw='{"session":{},"session":{}}')[0], 400)
        self.assertEqual(self.call(server, path, raw='{"session":NaN}')[0], 400)
        self.assertEqual(self.call(server, '/__cloud/connections/capabilities', {'session': None, 'confirmedOrigin': ORIGIN})[0], 400)
        for operation in ['../auth/logout', 'https://other.example.test', {}, None]:
            request = self.request(caps); request['operation'] = operation
            self.assertEqual(self.call(server, path, request)[0], 400)
        request = self.request(caps); request['payload'] = {'x': 'a' * (2 * 1024 * 1024)}
        self.assertEqual(self.call(server, path, request)[0], 400)
        self.assertEqual(self.manager.connections_transport(self.request(caps))['body']['status'], 'owner')

    def test_capability_origin_change_requires_confirmation_and_404_keeps_content_sync(self):
        caps = self.enable(); generation = caps['session']['sessionGeneration']
        self.remote.connections.origin = 'https://changed.example.test'
        changed = self.manager.connections_capabilities({})
        self.assertEqual((changed['usable'], changed['requiresConfirmation']), (False, True))
        self.assertNotEqual(generation, changed['session']['sessionGeneration'])
        self.assertEqual(self.manager.credentials.load()['connectionSession']['serverOrigin'], ORIGIN)
        with self.assertRaises(CloudSyncError):
            self.manager.connections_capabilities({'confirmedOrigin': 'https://changed.example.test', 'session': caps['session']})
        # A real HTTP 404 for the capabilities path, while regular pull remains available.
        from cloud_server import CloudHandler
        original = CloudHandler.do_GET
        def old_server(handler):
            if handler.path == '/v1/sync/capabilities':
                handler.send_response(404); handler.send_header('Content-Length', '0'); handler.end_headers()
            else: original(handler)
        with patch.object(CloudHandler, 'do_GET', old_server):
            old = self.manager.connections_capabilities({})
            self.assertEqual((old['supported'], old['usable'], old['origin']), (False, False, None))
            self.manager.sync_once()
        self.assertEqual(self.workspace.applied[-1][0:2], ([], 0))
        self.assertEqual(self.manager.credentials.load()['connectionSession']['serverOrigin'], ORIGIN)

    def test_logout_discards_late_success_and_prevents_stale_relogin_or_preference_write(self):
        caps = self.enable()
        started, release = threading.Event(), threading.Event()
        class SlowClient(CloudClient):
            def request(inner, method, path, *args, **kwargs):
                result = super().request(method, path, *args, **kwargs)
                if path == '/v1/connections/initialize':
                    started.set()
                    if not release.wait(5): raise AssertionError('Synthetic response was not released')
                return result
        self.manager._client_factory = SlowClient
        second = CloudSync(self.root / 'local', self.store, self.workspace, start_worker=False)
        self.addCleanup(second.close)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.manager.connections_transport, self.request(caps))
            self.assertTrue(started.wait(5))
            try: self.manager.disconnect()
            finally: release.set()
            with self.assertRaises(CloudSyncError) as error: pending.result(timeout=5)
        self.assertEqual(error.exception.code, 'CANCELLED')
        with self.assertRaises(CloudSyncError): second._set_auto(True)
        self.assertIsNone(self.manager.credentials.load())
        self.manager._client_factory = CloudClient
        self.login(); self.enable()
        with self.assertRaises(CloudSyncError): self.manager.connections_transport(self.request(caps))

    def test_directory_flock_orders_native_commit_then_logout_and_rejects_reverse_order(self):
        caps = self.enable(); generation = caps['session']['sessionGeneration']
        process = self.child(generation)
        self.assertEqual(process.stdout.readline().strip(), 'locked')
        started = threading.Event()
        def logout(): started.set(); return self.manager.disconnect()
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(logout)
            self.assertTrue(started.wait(1))
            # The separate process holds the same directory inode lock.
            self.assertFalse(result.done())
            process.stdin.write('commit\n'); process.stdin.flush()
            process.wait(timeout=5); self.assertEqual(process.returncode, 0)
            result.result(timeout=5)
        marker = self.root / 'local' / 'synthetic-cas-commit'
        self.assertEqual(marker.read_text(), 'committed')
        self.assertIsNone(self.manager.credentials.load())
        marker.unlink()
        late = self.child(generation)
        self.assertEqual(late.stdout.readline().strip(), 'stale')
        late.wait(timeout=5)
        self.assertFalse(marker.exists())

    def test_same_token_aba_failed_adoption_and_401_rotate_generation_without_secret_output(self):
        caps = self.enable(); before = self.manager.credentials.load()
        def fail_binding(_): raise ValueError('synthetic bind failure')
        with patch.object(self.store, 'bind_target', fail_binding), self.assertRaises(ValueError): self.login()
        restored = self.manager.credentials.load()
        self.assertEqual(restored['accessToken'], before['accessToken'])
        self.assertFalse(restored['connectionSession']['usable'])
        self.assertNotEqual(restored['connectionSession']['generation'], before['connectionSession']['generation'])
        with self.assertRaises(CloudSyncError): self.manager.connections_transport(self.request(caps))
        # Reopening with the same bearer still cannot resurrect a captured fence:
        # model explicit local removal/re-adoption (the remote bearer is synthetic).
        with self.manager._lock, self.manager.credentials.locked():
            self.manager.credentials.clear()
            repeated = {**restored, 'connectionSession': self.manager.credentials.metadata(ORIGIN)}
            self.manager.credentials.save(repeated); self.manager._session = repeated
        with self.assertRaises(CloudSyncError): self.manager.connections_transport(self.request(caps))
        caps = self.enable()
        # Revoke this synthetic bearer remotely, then use the ordinary content path.
        CloudClient(self.url, restored['accessToken']).request('POST', '/v1/auth/logout')
        with self.assertRaises(CloudSyncError): self.manager.devices()
        invalidated = self.manager.credentials.load()
        self.assertFalse(invalidated['connectionSession']['usable'])
        self.assertNotEqual(invalidated['connectionSession']['generation'], caps['session']['sessionGeneration'])
        self.assertEqual(self.manager.status()['errorCode'], 'HTTP_401')
        self.assertNotIn(restored['accessToken'], self.manager.status()['error'])

    def test_protected_session_rejects_symlink_hardlink_and_unsafe_mode(self):
        credentials = self.manager.credentials
        original = credentials.path.read_bytes()
        external = self.root / 'external-synthetic.json'; external.write_bytes(original); external.chmod(0o600)
        credentials.path.unlink(); credentials.path.symlink_to(external)
        with self.assertRaises(CloudSyncError): credentials.clear()
        self.assertEqual(external.read_bytes(), original)
        credentials.path.unlink(); os.link(external, credentials.path)
        with self.assertRaises(CloudSyncError): credentials.save({'accessToken': 'public-only'})
        self.assertEqual(external.read_bytes(), original)
        credentials.path.unlink(); credentials.path.write_bytes(original); credentials.path.chmod(0o644)
        with self.assertRaises(CloudSyncError): credentials.load()
        credentials.path.chmod(0o600)


if __name__ == '__main__': unittest.main()
