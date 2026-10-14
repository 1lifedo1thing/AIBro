"""Real isolated HTTP/cloud authentication -> opaque vault, never real credentials."""
import base64
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
from cloud_server import CloudStore, CloudHTTPServer, APIError


class ConnectionHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = "const c=require('./app/connection-vault').createConnectionVault(require('node:crypto').webcrypto); Promise.all([c.generateDeviceKeyPair(),c.generateDeviceKeyPair()]).then(x=>process.stdout.write(JSON.stringify(x)));"
        cls.keys = json.loads(subprocess.run(['node', '-e', script], cwd=ROOT,
            capture_output=True, text=True, check=True, timeout=15).stdout)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-http-connections-')
        self.addCleanup(self.temp.cleanup)
        self.store = CloudStore(self.temp.name, connection_origin='https://sync.example.test')
        self.store.add_user('synthetic-owner', 'synthetic-passphrase-only')
        self.store.add_user('synthetic-other', 'synthetic-other-passphrase')
        self.server = CloudHTTPServer(('127.0.0.1', 0), self.store, web_origins=[])
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.tokens = []
        for name in ('owner', 'reader'):
            status, result = self.call('/v1/auth/login', {'username': 'synthetic-owner',
                'password': 'synthetic-passphrase-only', 'deviceName': name})
            self.assertEqual(status, 200)
            self.tokens.append(result['accessToken'])
        self.secrets = [base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=') for _ in range(2)]

    def call(self, path, payload=None, *, token=None, device=None, secret=None, method=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        self.addCleanup(connection.close)
        h = {'Content-Type': 'application/json', **(headers or {})}
        if token is not None: h['Authorization'] = 'Bearer ' + token
        if device is not None: h['X-AIBro-Connection-Device'] = device
        if secret is not None: h['X-AIBro-Connection-Secret'] = secret
        connection.request(method or ('GET' if payload is None else 'POST'), path,
            body=None if payload is None else json.dumps(payload), headers=h)
        response = connection.getresponse()
        result = json.loads(response.read())
        return response.status, result

    def operation(self, op, payload, index=0, **kw):
        return self.call('/v1/connections/' + op, payload, token=self.tokens[index],
            device=self.keys[index]['fingerprint'], secret=self.secrets[index], **kw)

    def initialize(self):
        code, body = self.operation('initialize', {'publicJwk': self.keys[0]['publicJwk']})
        self.assertEqual(code, 200)
        self.assertEqual(body['status'], 'owner')
        return body

    def test_opt_in_capabilities_owner_pending_and_legacy_sync(self):
        code, caps = self.call('/v1/sync/capabilities', token=self.tokens[0])
        self.assertEqual(code, 200)
        self.assertEqual(caps['encryptedConnectionProfiles']['origin'], 'https://sync.example.test')
        self.initialize()
        code, reader = self.operation('register', {'publicJwk': self.keys[1]['publicJwk']}, 1)
        self.assertEqual((code, reader['status']), (200, 'pending'))
        self.assertEqual(self.operation('read', {'epoch': 1}, 1)[0], 403)
        self.assertEqual(self.operation('owner_state', {'epoch': 1}, 1)[0], 403)
        code, owner = self.operation('owner_state', {'epoch': 1})
        self.assertEqual(code, 200)
        self.assertEqual(len(owner['devices']), 2)
        serialized = json.dumps(owner)
        for secret in self.secrets + self.tokens: self.assertNotIn(secret, serialized)
        code, content = self.call('/v1/sync/push', {'operations': []}, token=self.tokens[0])
        self.assertEqual((code, content), (200, {'accepted': [], 'conflicts': []}))

    def test_two_credentials_cross_account_and_transactional_session_revalidation(self):
        self.initialize()
        args = dict(device=self.keys[0]['fingerprint'], secret=self.secrets[0])
        self.assertEqual(self.call('/v1/connections/status', {}, **args)[0], 401)
        self.assertEqual(self.call('/v1/connections/status', {}, token=self.tokens[0],
            device=self.keys[0]['fingerprint'], secret=self.secrets[1])[0], 401)
        status, other = self.call('/v1/auth/login', {'username': 'synthetic-other',
            'password': 'synthetic-other-passphrase', 'deviceName': 'other-account'})
        self.assertEqual(status, 200)
        self.assertEqual(self.call('/v1/connections/status', {}, token=other['accessToken'], **args)[0], 401)
        captured = self.store.authenticate('Bearer ' + self.tokens[0])
        self.assertEqual(self.call('/v1/auth/logout', {}, token=self.tokens[0])[0], 200)
        with self.assertRaises(APIError) as caught:
            self.store.connections.status(captured, self.keys[0]['fingerprint'], self.secrets[0])
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(self.operation('status', {})[0], 401)

    def test_strict_route_payload_headers_and_public_origin_binding(self):
        self.initialize()
        self.assertEqual(self.operation('status', {'apiKey': 'synthetic-do-not-accept'})[0], 400)
        self.assertEqual(self.operation('status?epoch=1', {})[0], 400)
        self.assertEqual(self.operation('status', {}, method='GET')[0], 400)
        self.assertEqual(self.operation('status', {}, headers={'Origin': 'https://hostile.example'})[0], 403)
        self.assertEqual(self.operation('status', {}, headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.operation('unsupported', {})[0], 404)
        self.assertEqual(self.call('/v1/connections/status', {}, token=self.tokens[0])[0], 401)
        # A claimed request Host cannot change the AEAD origin configured by the operator.
        code, caps = self.call('/v1/sync/capabilities', token=self.tokens[0], headers={'Host': 'different.example'})
        self.assertEqual((code, caps['encryptedConnectionProfiles']['origin']), (200, 'https://sync.example.test'))

    def test_default_service_has_no_connection_feature_or_tables(self):
        with tempfile.TemporaryDirectory(prefix='aibro-http-legacy-') as directory:
            legacy = CloudStore(directory)
            self.assertIsNone(legacy.connections)
            self.assertNotIn('encryptedConnectionProfiles', legacy.capabilities())
            with legacy.db() as db:
                self.assertFalse(db.execute("SELECT name FROM sqlite_master WHERE name LIKE 'connection_%'").fetchall())
            previous, self.server.store = self.server.store, legacy
            try:
                legacy.add_user('synthetic', 'synthetic-legacy-passphrase')
                status, login = self.call('/v1/auth/login', {'username': 'synthetic',
                    'password': 'synthetic-legacy-passphrase', 'deviceName': 'legacy'})
                self.assertEqual(status, 200)
                self.assertEqual(self.call('/v1/connections/status', {}, token=login['accessToken'])[0], 404)
            finally:
                self.server.store = previous


if __name__ == '__main__':
    unittest.main()
