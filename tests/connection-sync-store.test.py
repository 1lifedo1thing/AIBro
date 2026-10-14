"""Real SQLite + production WebCrypto envelopes, isolated synthetic accounts only."""

import base64
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import connection_sync_store as module

ORIGIN = 'https://sync.example.test'
NODE = r'''
const fs=require('node:fs'),crypto=require('node:crypto');
const vault=require('./app/connection-vault.js').createConnectionVault(crypto.webcrypto);
const p=JSON.parse(fs.readFileSync(0,'utf8'));
(async()=>{
  if(p.mode==='devices')return Promise.all(Array.from({length:p.count},()=>vault.generateDeviceKeyPair()));
  if(p.mode==='wrap')return vault.wrapConfigurationKey({configurationKey:Buffer.from(p.key,'base64url'),senderPrivateJwk:p.owner.privateJwk,recipientPublicJwk:p.recipient.publicJwk,context:p.context});
  if(p.mode==='decrypt'){
    const key=await vault.unwrapConfigurationKey({envelope:p.row.wrap,recipientPrivateJwk:p.device.privateJwk,trustedSenderPublicJwk:p.owner.publicJwk,expectedContext:p.context});
    return vault.decryptProfile({envelope:p.row.envelope,configurationKey:key,expectedContext:p.context});
  }
  if(p.mode==='bundles')return Promise.all(p.contexts.map(async context=>{
    const key=vault.generateConfigurationKey();
    const profile={format:'aibro.connection-profile.v1',purpose:'chat',provider:'openai-compatible',authKind:'api-key',apiFormat:'responses',baseUrl:'https://provider.example.test/v1',model:'synthetic-'+context.version,apiKey:'synthetic-api-key-not-real-047'};
    const envelope=await vault.encryptProfile({profile,configurationKey:key,context});
    const wraps=await Promise.all(p.recipients.map(recipient=>vault.wrapConfigurationKey({configurationKey:key,senderPrivateJwk:p.owner.privateJwk,recipientPublicJwk:recipient.publicJwk,context})));
    return {envelope,wraps,key:Buffer.from(key).toString('base64url')};
  }));
  throw Error('unknown synthetic fixture mode');
})().then(result=>process.stdout.write(JSON.stringify(result))).catch(()=>{process.stderr.write('Synthetic crypto fixture failed');process.exitCode=1;});
'''


def crypto(payload):
    result = subprocess.run(['node', '-e', NODE], input=json.dumps(payload), text=True,
                            capture_output=True, cwd=ROOT, timeout=20)
    if result.returncode:
        raise AssertionError('Synthetic WebCrypto fixture failed (no secret output)')
    return json.loads(result.stdout)


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


class ConnectionStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.devices = crypto({'mode': 'devices', 'count': 18})

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-connection-store-')
        self.path = Path(self.temp.name) / 'isolated.sqlite'
        self.secrets = [b64(os.urandom(32)) for _ in self.devices]
        self.keys = {}
        self.auth_calls = []
        with self.db() as db:
            db.execute('CREATE TABLE qa_sessions(session_id TEXT PRIMARY KEY, account_id TEXT, live INTEGER)')
            db.executemany('INSERT INTO qa_sessions VALUES(?,?,1)', [('session_' + str(i), 'account_a') for i in range(18)])
            db.executemany('INSERT INTO qa_sessions VALUES(?,?,1)', [('relogin', 'account_a'), ('stranger', 'account_a'), ('other', 'account_b')])
        self.store = module.ConnectionSyncStore(self.db, ORIGIN, self.verify_session)
        self.owner = self.devices[0]

    def tearDown(self):
        self.temp.cleanup()

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, isolation_level=None, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            yield connection
        finally:
            connection.close()

    def verify_session(self, db, identity):
        self.auth_calls.append(db.in_transaction)
        row = db.execute('SELECT * FROM qa_sessions WHERE session_id=? AND live=1', (identity,)).fetchone()
        if row is None:
            raise RuntimeError('must-never-surface-' + str(identity))
        return {'accountId': row['account_id'], 'sessionId': row['session_id']}

    def initialize(self):
        return self.store.initialize('session_0', self.secrets[0], {'publicJwk': self.owner['publicJwk']})

    def actor(self, index=0, session=None):
        return (session or 'session_' + str(index), self.devices[index]['fingerprint'], self.secrets[index])

    def register(self, index):
        return self.store.register('session_' + str(index), self.secrets[index], {'publicJwk': self.devices[index]['publicJwk']})

    def state(self, epoch=1, index=0):
        return self.store.read(*self.actor(index), epoch)

    def revision(self):
        return self.store.status(*self.actor())['revision']

    def context(self, profile_id='chat', version=1, epoch=1, account='account_a'):
        return {'serverOrigin': ORIGIN, 'accountId': account, 'profileId': profile_id, 'epoch': epoch, 'version': version}

    def bundles(self, contexts, recipients=(0,)):
        bundles = crypto({'mode': 'bundles', 'contexts': contexts, 'owner': self.owner,
                          'recipients': [self.devices[i] for i in recipients]})
        values = []
        for context, bundle in zip(contexts, bundles):
            self.keys[(context['profileId'], context['epoch'], context['version'])] = bundle['key']
            values.append({'profileId': context['profileId'], 'baseVersion': context['version'] - 1,
                           'version': context['version'], 'deleted': False,
                           'envelope': bundle['envelope'], 'wraps': bundle['wraps']})
        return values

    def value(self, profile_id='chat', version=1, epoch=1, recipients=(0,)):
        return self.bundles([self.context(profile_id, version, epoch)], recipients)[0]

    def request(self, profiles, op='op_save', epoch=1, revision=None):
        return {'opId': op, 'expectedEpoch': epoch, 'expectedRevision': self.revision() if revision is None else revision, 'profiles': profiles}

    def commit(self, profiles, op='op_save', epoch=1):
        return self.store.commit(*self.actor(), self.request(profiles, op, epoch))

    def approve_request(self, index=1, op='op_approve'):
        current = self.state()
        wraps = []
        for row in current['profiles']:
            if row['deleted']:
                continue
            context = row['envelope']['context']
            wraps.append(crypto({'mode': 'wrap', 'key': self.keys[(row['profileId'], row['epoch'], row['version'])],
                                 'owner': self.owner, 'recipient': self.devices[index], 'context': context}))
        return {'opId': op, 'expectedEpoch': current['epoch'], 'expectedRevision': current['revision'],
                'deviceId': self.devices[index]['fingerprint'], 'wraps': wraps}

    def approved_pair(self, third=False):
        self.initialize()
        self.commit([self.value()])
        self.register(1)
        self.store.approve(*self.actor(), self.approve_request())
        if third:
            self.register(2)
            self.store.approve(*self.actor(), self.approve_request(2, 'op_approve_third'))

    def rotation(self, values, revoked=(1,)):
        return {'opId': 'op_rotate', 'expectedEpoch': 1, 'expectedRevision': self.revision(),
                'newEpoch': 2, 'revokeDeviceIds': [self.devices[i]['fingerprint'] for i in revoked], 'profiles': values}

    def all_rows(self):
        with self.db() as db:
            return {name: [tuple(row) for row in db.execute('SELECT * FROM ' + name + ' ORDER BY rowid')]
                    for name in ('connection_vaults', 'connection_devices', 'connection_profiles', 'connection_wraps', 'connection_receipts')}

    def rejects(self, call, code=None):
        before = self.all_rows()
        with self.assertRaises(module.ConnectionSyncError) as error:
            call()
        if code is not None:
            self.assertEqual(error.exception.code, code)
        self.assertEqual(self.all_rows(), before, 'Rejected operation must not modify any vault table')
        for secret in self.secrets:
            self.assertNotIn(secret, str(error.exception))
        return error.exception

    def test_atomic_first_owner_and_fingerprint_matches_webcrypto(self):
        result = self.initialize()
        self.assertEqual(result, {'epoch': 1, 'revision': 1, 'deviceId': self.owner['fingerprint'], 'status': 'owner'})
        before = self.all_rows()
        self.assertEqual(self.initialize(), result)
        self.assertEqual(self.all_rows(), before)
        self.rejects(lambda: self.store.initialize(*('session_1', self.secrets[1], {'publicJwk': self.devices[1]['publicJwk']})), 'conflict')

    def test_concurrent_initialization_has_exactly_one_fixed_owner(self):
        barrier = threading.Barrier(2)
        def attempt(index):
            barrier.wait()
            try:
                return self.store.initialize('session_' + str(index), self.secrets[index], {'publicJwk': self.devices[index]['publicJwk']})['deviceId']
            except module.ConnectionSyncError as error:
                self.assertEqual(error.code, 'conflict')
                return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, (0, 1)))
        self.assertEqual(sum(value is not None for value in results), 1)
        self.assertEqual(len(self.all_rows()['connection_devices']), 1)
        self.assertTrue(all(self.auth_calls))

    def test_public_key_is_not_authentication_and_relogin_requires_same_secret(self):
        self.initialize()
        self.rejects(lambda: self.store.register('stranger', self.secrets[1], {'publicJwk': self.owner['publicJwk']}), 'unauthorized')
        self.rejects(lambda: self.store.owner_state(*self.actor(session='stranger'), 1), 'unauthorized')
        self.rejects(lambda: self.store.read('session_0', self.owner['fingerprint'], b64(os.urandom(32)), 1), 'unauthorized')
        result = self.store.register('relogin', self.secrets[0], {'publicJwk': self.owner['publicJwk']})
        self.assertEqual((result['status'], result['revision']), ('owner', 1))
        self.assertEqual(self.store.read(*self.actor(session='relogin'), 1)['profiles'], [])
        self.rejects(lambda: self.store.read(*self.actor(), 1), 'unauthorized')
        self.assertEqual(self.store.register('relogin', self.secrets[0], {'publicJwk': self.owner['publicJwk']}), result)

    def test_pending_devices_cannot_read_list_approve_write_or_rotate(self):
        self.initialize(); self.commit([self.value()]); result = self.register(1)
        self.assertEqual(result['status'], 'pending')
        self.assertEqual(set(self.store.status(*self.actor(1))), {'epoch', 'revision', 'deviceId', 'status'})
        for call in (lambda: self.store.read(*self.actor(1), 1), lambda: self.store.owner_state(*self.actor(1), 1),
                     lambda: self.store.commit(*self.actor(1), {}), lambda: self.store.approve(*self.actor(1), {}),
                     lambda: self.store.rotate_and_revoke(*self.actor(1), {})):
            self.rejects(call, 'forbidden')

    def test_approval_requires_all_profiles_and_reads_only_own_wrap(self):
        self.initialize(); self.commit(self.bundles([self.context('chat'), self.context('speech')]))
        self.register(1)
        request = self.approve_request()
        bad = copy.deepcopy(request); bad['wraps'].pop()
        self.rejects(lambda: self.store.approve(*self.actor(), bad), 'conflict')
        wrong = copy.deepcopy(request); wrong['wraps'][0]['recipientFingerprint'] = self.owner['fingerprint']
        self.rejects(lambda: self.store.approve(*self.actor(), wrong), 'conflict')
        self.store.approve(*self.actor(), request)
        read = self.state(index=1)
        self.assertNotIn('devices', read)
        for row in read['profiles']:
            self.assertEqual(row['wrap']['recipientFingerprint'], self.devices[1]['fingerprint'])
            self.assertNotIn('wraps', row)
            decoded = crypto({'mode': 'decrypt', 'row': row, 'device': self.devices[1], 'owner': self.owner,
                              'context': self.context(row['profileId'])})
            self.assertEqual(decoded['apiKey'], 'synthetic-api-key-not-real-047')

    def test_profile_version_cas_retry_and_changed_op_id_rejection(self):
        self.approved_pair()
        value = self.value(version=2, recipients=(0, 1))
        request = self.request([value], 'version_two')
        competing = self.request([self.value(version=2, recipients=(0, 1))], 'competitor')
        receipt = self.store.commit(*self.actor(), request)
        before = self.all_rows()
        replay = self.store.commit(*self.actor(), request)
        self.assertEqual(replay, {**receipt, 'replayed': True})
        self.assertEqual(self.all_rows(), before)
        self.rejects(lambda: self.store.commit(*self.actor(), competing), 'conflict')
        changed = copy.deepcopy(request); changed['profiles'][0]['envelope']['nonce'] = b64(os.urandom(12))
        self.rejects(lambda: self.store.commit(*self.actor(), changed), 'conflict')
        self.assertEqual(self.state(index=1)['profiles'][0]['version'], 2)

    def test_missing_duplicate_foreign_wraps_and_old_aad_are_rejected(self):
        self.approved_pair()
        good = self.request([self.value(version=2, recipients=(0, 1))], 'validate_wrap_update')
        mutations = []
        missing = copy.deepcopy(good); missing['profiles'][0]['wraps'].pop(); mutations.append(missing)
        duplicate = copy.deepcopy(good); duplicate['profiles'][0]['wraps'][1] = duplicate['profiles'][0]['wraps'][0]; mutations.append(duplicate)
        foreign = copy.deepcopy(good); foreign['profiles'][0]['wraps'][1]['recipientFingerprint'] = self.devices[2]['fingerprint']; mutations.append(foreign)
        old = copy.deepcopy(good); old['profiles'][0]['envelope']['context']['version'] = 1; mutations.append(old)
        wrong_account = copy.deepcopy(good); wrong_account['profiles'][0]['envelope']['context']['accountId'] = 'account_b'; mutations.append(wrong_account)
        wrong_origin = copy.deepcopy(good); wrong_origin['profiles'][0]['wraps'][0]['context']['serverOrigin'] = 'https://elsewhere.example.test'; mutations.append(wrong_origin)
        for request in mutations:
            self.rejects(lambda request=request: self.store.commit(*self.actor(), request), 'conflict')
        self.store.commit(*self.actor(), good)
        self.assertEqual(self.state(index=1)['profiles'][0]['version'], 2)

    def test_approved_reader_cannot_write_approve_rotate_or_list_devices(self):
        self.approved_pair()
        for call in (lambda: self.store.owner_state(*self.actor(1), 1),
                     lambda: self.store.commit(*self.actor(1), {}),
                     lambda: self.store.approve(*self.actor(1), {}),
                     lambda: self.store.rotate_and_revoke(*self.actor(1), {})):
            self.rejects(call, 'forbidden')

    def test_approval_status_failure_rolls_back_all_new_wraps(self):
        self.initialize(); self.commit(self.bundles([self.context('chat'), self.context('speech')]))
        self.register(1)
        request = self.approve_request()
        with self.db() as db:
            db.execute("CREATE TRIGGER fail_approval BEFORE UPDATE OF status ON connection_devices WHEN NEW.status='approved' BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        self.rejects(lambda: self.store.approve(*self.actor(), request), 'store_unavailable')
        self.assertEqual(self.store.status(*self.actor(1))['status'], 'pending')
        with self.db() as db: db.execute('DROP TRIGGER fail_approval')
        self.store.approve(*self.actor(), request)
        self.assertEqual(len(self.state(index=1)['profiles']), 2)

    def test_commit_wrap_write_failure_rolls_back_profile_revision_and_receipt(self):
        self.approved_pair()
        request = self.request([self.value(version=2, recipients=(0, 1))], 'rollback_commit')
        with self.db() as db:
            db.execute("CREATE TRIGGER fail_wrap BEFORE INSERT ON connection_wraps WHEN NEW.device_id='" + self.devices[1]['fingerprint'] + "' BEGIN SELECT RAISE(ABORT,'must-not-surface-secret'); END")
        error = self.rejects(lambda: self.store.commit(*self.actor(), request), 'store_unavailable')
        self.assertNotIn('must-not-surface', str(error))
        self.assertTrue(error.__suppress_context__)
        with self.db() as db: db.execute('DROP TRIGGER fail_wrap')
        self.store.commit(*self.actor(), request)
        self.assertEqual(self.state()['profiles'][0]['version'], 2)

    def test_rotation_is_one_transaction_and_remaining_device_can_decrypt(self):
        self.approved_pair(third=True)
        request = self.rotation([self.value(version=2, epoch=2, recipients=(0, 2))])
        with self.db() as db:
            db.execute("CREATE TRIGGER fail_revoke BEFORE UPDATE OF status ON connection_devices WHEN NEW.status='revoked' BEGIN SELECT RAISE(ABORT,'synthetic-rollback'); END")
        self.rejects(lambda: self.store.rotate_and_revoke(*self.actor(), request), 'store_unavailable')
        with self.db() as db: db.execute('DROP TRIGGER fail_revoke')
        result = self.store.rotate_and_revoke(*self.actor(), request)
        self.assertEqual(result['epoch'], 2)
        self.rejects(lambda: self.state(epoch=1), 'conflict')
        self.rejects(lambda: self.state(epoch=2, index=1), 'unauthorized')
        self.rejects(lambda: self.register(1), 'forbidden')
        read = self.state(epoch=2, index=2)
        row = read['profiles'][0]
        decoded = crypto({'mode': 'decrypt', 'row': row, 'device': self.devices[2], 'owner': self.owner,
                          'context': self.context(version=2, epoch=2)})
        self.assertEqual(decoded['model'], 'synthetic-2')
        with self.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM connection_wraps WHERE device_id=?', (self.devices[1]['fingerprint'],)).fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(DISTINCT epoch) FROM connection_profiles').fetchone()[0], 1)

    def test_rotation_rejects_partial_set_relabelled_cipher_and_owner_removal(self):
        self.approved_pair(third=True)
        self.commit([self.value('speech', recipients=(0, 1, 2))], 'second_profile')
        values = self.bundles([self.context('chat', 2, 2), self.context('speech', 2, 2)], (0, 2))
        request = self.rotation(values)
        missing = copy.deepcopy(request); missing['profiles'].pop()
        self.rejects(lambda: self.store.rotate_and_revoke(*self.actor(), missing), 'conflict')
        relabelled = copy.deepcopy(request)
        relabelled['profiles'][0]['envelope']['ciphertext'] = self.state()['profiles'][0]['envelope']['ciphertext']
        self.rejects(lambda: self.store.rotate_and_revoke(*self.actor(), relabelled), 'conflict')
        owner = copy.deepcopy(request); owner['revokeDeviceIds'] = [self.owner['fingerprint']]
        self.rejects(lambda: self.store.rotate_and_revoke(*self.actor(), owner), 'conflict')
        incorrect_members = copy.deepcopy(request); incorrect_members['profiles'][0]['wraps'].pop()
        self.rejects(lambda: self.store.rotate_and_revoke(*self.actor(), incorrect_members), 'conflict')
        self.store.rotate_and_revoke(*self.actor(), request)

    def test_old_epoch_receipts_and_rotation_retries_fail_closed(self):
        self.initialize(); original = self.request([self.value()], 'original')
        self.store.commit(*self.actor(), original); self.register(1)
        self.store.approve(*self.actor(), self.approve_request())
        rotation = self.rotation([self.value(version=2, epoch=2)])
        self.store.rotate_and_revoke(*self.actor(), rotation)
        self.rejects(lambda: self.store.commit(*self.actor(), original), 'conflict')
        self.rejects(lambda: self.store.rotate_and_revoke(*self.actor(), rotation), 'conflict')

    def test_lost_rotation_ack_is_recovered_only_by_current_epoch_owner_hash(self):
        self.approved_pair(third=True)
        self.register(3)
        request = self.rotation([self.value(version=2, epoch=2, recipients=(0, 2))])
        receipt = self.store.rotate_and_revoke(*self.actor(), request)
        digest = hashlib.sha256(module._json(['rotate', request]).encode()).hexdigest()
        query = {'epoch': 2, 'opId': request['opId'], 'requestHash': digest}
        before = self.all_rows()
        self.store = module.ConnectionSyncStore(self.db, ORIGIN, self.verify_session)
        result = self.store.operation_result(*self.actor(), query)
        self.assertEqual(result, {'status': 'committed', 'epoch': 2, 'revision': receipt['revision'], 'receipt': receipt})
        self.assertEqual(self.all_rows(), before)
        self.rejects(lambda: self.store.operation_result(*self.actor(), {**query, 'requestHash': '0' * 64}), 'conflict')
        self.rejects(lambda: self.store.operation_result(*self.actor(), {**query, 'epoch': 1}), 'conflict')
        self.rejects(lambda: self.store.operation_result(*self.actor(1), query), 'unauthorized')
        self.rejects(lambda: self.store.operation_result(*self.actor(2), query), 'forbidden')
        self.rejects(lambda: self.store.operation_result(*self.actor(3), query), 'forbidden')
        self.rejects(lambda: self.store.operation_result(*self.actor(session='stranger'), query), 'unauthorized')
        for op_id in ('unknown_operation', 'op_save'):
            unknown = self.store.operation_result(*self.actor(), {**query, 'opId': op_id})
            self.assertEqual(unknown, {'status': 'unknown', 'epoch': 2, 'revision': receipt['revision'], 'opId': op_id})
        self.store.register('relogin', self.secrets[0], {'publicJwk': self.owner['publicJwk']})
        self.assertEqual(self.store.operation_result(*self.actor(session='relogin'), query), result)
        with self.db() as db: db.execute("UPDATE qa_sessions SET live=0 WHERE session_id='relogin'")
        self.rejects(lambda: self.store.operation_result(*self.actor(session='relogin'), query), 'unauthorized')

    def test_tombstones_survive_rotation_and_restore_with_new_version(self):
        self.approved_pair()
        deleted = {'profileId': 'chat', 'baseVersion': 1, 'version': 2, 'deleted': True, 'envelope': None, 'wraps': []}
        self.commit([deleted], 'delete_profile')
        self.assertEqual(self.state(index=1)['profiles'][0]['wrap'], None)
        missing = self.rotation([])
        self.rejects(lambda: self.store.rotate_and_revoke(*self.actor(), missing), 'conflict')
        rotated = {**deleted, 'baseVersion': 2, 'version': 3}
        self.store.rotate_and_revoke(*self.actor(), self.rotation([rotated]))
        self.commit([self.value(version=4, epoch=2)], 'restore_profile', epoch=2)
        self.assertFalse(self.state(epoch=2)['profiles'][0]['deleted'])

    def test_cross_account_isolation_even_with_same_public_device_key(self):
        self.initialize(); self.commit([self.value()])
        self.store.initialize('other', self.secrets[3], {'publicJwk': self.owner['publicJwk']})
        self.rejects(lambda: self.store.read('other', self.owner['fingerprint'], self.secrets[0], 1), 'unauthorized')
        self.assertEqual(self.store.read('other', self.owner['fingerprint'], self.secrets[3], 1)['profiles'], [])
        request = {'opId': 'cross_account', 'expectedEpoch': 1, 'expectedRevision': 1, 'profiles': [self.value()]}
        self.rejects(lambda: self.store.commit('other', self.owner['fingerprint'], self.secrets[3], request), 'conflict')
        self.assertEqual(len(self.state()['profiles']), 1)

    def test_session_revalidation_runs_inside_transaction_even_for_replay(self):
        self.initialize(); request = self.request([self.value()]); self.store.commit(*self.actor(), request)
        with self.db() as db: db.execute("UPDATE qa_sessions SET live=0 WHERE session_id='session_0'")
        error = self.rejects(lambda: self.store.commit(*self.actor(), request), 'unauthorized')
        self.assertNotIn('session_0', str(error))
        self.assertNotIn('must-never-surface', str(error))
        self.assertTrue(error.__suppress_context__)
        self.assertTrue(all(self.auth_calls))

    def test_strict_plaintext_unknown_fields_sizes_encoding_and_types(self):
        self.initialize(); value = self.value(); good = self.request([value])
        variants = []
        for field, replacement in [('apiKey', 'forbidden-plaintext'), ('privateJwk', self.owner['privateJwk'])]:
            item = copy.deepcopy(good); item[field] = replacement; variants.append(item)
        for patch_value in ({'apiKey': 'forbidden-plaintext'}, {'nonce': 'bad'}, {'nonce': value['envelope']['nonce'] + '='},
                            {'ciphertext': b64(b'x' * (module.MAX_PROFILE_BYTES + 17))}, {'suite': 'none'},
                            {'format': 'aibro.connection-profile.v1'}):
            item = copy.deepcopy(good); item['profiles'][0]['envelope'].update(patch_value); variants.append(item)
        item = copy.deepcopy(good); item['profiles'][0]['deleted'] = 0; variants.append(item)
        item = copy.deepcopy(good); item['profiles'][0]['version'] = True; variants.append(item)
        item = copy.deepcopy(good); item['profiles'][0]['wraps'][0]['privateKey'] = 'forbidden'; variants.append(item)
        item = copy.deepcopy(good); item['profiles'][0]['wraps'][0]['ciphertext'] = b64(b'x' * 47); variants.append(item)
        item = copy.deepcopy(good); item['huge'] = 'x' * module.MAX_REQUEST_BYTES; variants.append(item)
        for item in variants:
            self.rejects(lambda item=item: self.store.commit(*self.actor(), item), 'invalid_request')

    def test_invalid_public_curve_private_key_secret_and_origin_rejected(self):
        invalid = {**self.owner['publicJwk'], 'x': b64(bytes(32)), 'y': b64(bytes(32))}
        for key in (invalid, self.owner['privateJwk'], {**self.owner['publicJwk'], 'key_ops': ['deriveBits']}, {**self.owner['publicJwk'], 'extra': 'secret'}):
            self.rejects(lambda key=key: self.store.initialize('session_0', self.secrets[0], {'publicJwk': key}), 'invalid_request')
        for secret in ('', self.secrets[0] + '=', b64(bytes(31)), None):
            self.rejects(lambda secret=secret: self.store.initialize('session_0', secret, {'publicJwk': self.owner['publicJwk']}), 'unauthorized')
        for origin in ('http://remote.example.test', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test?key=secret'):
            with self.assertRaises(module.ConnectionSyncError):
                module.ConnectionSyncStore(self.db, origin, self.verify_session)

    def test_device_limit_and_no_implicit_revived_identity(self):
        self.initialize()
        for index in range(1, 16): self.register(index)
        self.rejects(lambda: self.register(16), 'capacity')
        self.store.rotate_and_revoke(*self.actor(), self.rotation([], revoked=(1,)))
        self.rejects(lambda: self.register(1), 'forbidden')
        self.rejects(lambda: self.register(16), 'capacity')
        self.assertEqual(len(self.all_rows()['connection_devices']), 16)

    def test_profile_limit_includes_tombstones_and_batch_is_atomic(self):
        self.initialize()
        values = self.bundles([self.context('profile_' + str(i)) for i in range(32)])
        self.commit(values)
        deleted = {'profileId': 'profile_0', 'baseVersion': 1, 'version': 2, 'deleted': True, 'envelope': None, 'wraps': []}
        self.commit([deleted], 'delete_at_capacity')
        self.rejects(lambda: self.commit([self.value('profile_overflow')], 'overflow'), 'capacity')
        self.commit([self.value('profile_0', version=3)], 'reuse_explicit_id')
        self.assertEqual(len(self.state()['profiles']), 32)

    def test_hash_only_storage_and_no_auth_secrets_in_read_responses(self):
        self.approved_pair()
        with self.db() as db:
            hashes = [row[0] for row in db.execute('SELECT secret_hash FROM connection_devices')]
        self.assertIn(hashlib.sha256(base64.urlsafe_b64decode(self.secrets[0] + '=')).hexdigest(), hashes)
        wire = json.dumps(self.store.owner_state(*self.actor(), 1)) + json.dumps(self.state(index=1))
        stored = self.path.read_bytes()
        for private in [*self.secrets, self.owner['privateJwk']['d'], 'synthetic-api-key-not-real-047', *self.keys.values()]:
            self.assertNotIn(private, wire)
            self.assertNotIn(private.encode(), stored)
        self.assertNotIn('secret_hash', wire)
        self.assertNotIn('session_id', wire)
        self.store = module.ConnectionSyncStore(self.db, ORIGIN, self.verify_session)
        self.assertEqual(self.state(index=1)['profiles'][0]['version'], 1)

    def test_expired_receipt_window_still_rejects_old_version_replay(self):
        self.initialize()
        with patch.object(module, 'MAX_RECEIPTS', 2):
            values = self.bundles([self.context(version=i) for i in range(1, 5)])
            first = None
            for value in values:
                request = self.request([value], 'op_' + str(value['version']))
                if first is None: first = request
                self.store.commit(*self.actor(), request)
            self.assertEqual(len(self.all_rows()['connection_receipts']), 2)
            self.rejects(lambda: self.store.commit(*self.actor(), first), 'conflict')


if __name__ == '__main__':
    unittest.main(verbosity=2)
