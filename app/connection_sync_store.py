"""Account-isolated opaque connection vault; no HTTP routes or secret decryption.

The caller supplies a DB context-manager factory and a verify_session(db, identity)
callback. The callback MUST revalidate a live cloud session inside this transaction
and return {accountId, sessionId}; neither field may come from an untrusted body.
Device secrets are canonical base64url encodings of 32 client-generated random
bytes, submitted separately from synchronized payloads over the authenticated TLS
channel. Only SHA256(raw_secret) is stored. Fingerprints identify, never authorize.

An owner is fixed at the account's first initialization. "Mac owner" describes the
client entry point, not hardware attestation. A server cannot prove that an opaque
ciphertext uses a new key or contains an allowed plaintext. Trusted clients must
encrypt/rotate correctly and verify AEAD context plus locally pinned owner keys.
"""

import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import re
import sqlite3
from urllib.parse import urlsplit


MAX_DEVICES = 16  # Includes revoked identities: no silent resurrection or eviction.
MAX_PROFILES = 32  # Includes tombstones; an existing ID can be explicitly restored.
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_PROFILE_BYTES = 24576
MAX_RECEIPTS = 256
MAX_REVISION = 9007199254740991
SEALED = 'aibro.connection-profile-sealed.v1'
WRAPPED = 'aibro.connection-key-wrap.v1'
WRAP_SUITE = 'P256-HKDF-SHA256-A256GCM'


class ConnectionSyncError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


class ConnectionSyncStore:
    """Independent SQLite tables, suitable for the existing cloud DB factory.

    Every API requires a freshly verified cloud session. All APIs except initial
    registration additionally require the stable device ID and its deviceSecret.
    Re-register with the same public key and secret to bind a new cloud session;
    doing so invalidates the old session binding without transferring ownership.
    MAX_RECEIPTS gives bounded exact retry receipts; older retries still fail CAS.
    """

    def __init__(self, db_factory, server_origin, verify_session, error_cls=ConnectionSyncError):
        self.db_factory = db_factory
        self.verify_session = verify_session
        self.error_cls = error_cls
        if not callable(db_factory) or not callable(verify_session):
            raise ValueError('A database factory and live-session verifier are required')
        self.origin = self._origin(server_origin)
        with self.db_factory() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS connection_vaults (
                    account_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
                    epoch INTEGER NOT NULL CHECK(epoch>=1), revision INTEGER NOT NULL CHECK(revision>=1)
                );
                CREATE TABLE IF NOT EXISTS connection_devices (
                    account_id TEXT NOT NULL, device_id TEXT NOT NULL, public_jwk TEXT NOT NULL,
                    secret_hash TEXT NOT NULL, session_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('owner','pending','approved','revoked')),
                    PRIMARY KEY(account_id,device_id),
                    FOREIGN KEY(account_id) REFERENCES connection_vaults(account_id)
                );
                CREATE TABLE IF NOT EXISTS connection_profiles (
                    account_id TEXT NOT NULL, profile_id TEXT NOT NULL, epoch INTEGER NOT NULL,
                    version INTEGER NOT NULL CHECK(version>=1), deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
                    envelope TEXT, PRIMARY KEY(account_id,profile_id),
                    FOREIGN KEY(account_id) REFERENCES connection_vaults(account_id)
                );
                CREATE TABLE IF NOT EXISTS connection_wraps (
                    account_id TEXT NOT NULL, profile_id TEXT NOT NULL, device_id TEXT NOT NULL,
                    envelope TEXT NOT NULL, PRIMARY KEY(account_id,profile_id,device_id),
                    FOREIGN KEY(account_id,profile_id) REFERENCES connection_profiles(account_id,profile_id),
                    FOREIGN KEY(account_id,device_id) REFERENCES connection_devices(account_id,device_id)
                );
                CREATE TABLE IF NOT EXISTS connection_receipts (
                    account_id TEXT NOT NULL, op_id TEXT NOT NULL, epoch INTEGER NOT NULL,
                    revision INTEGER NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL,
                    PRIMARY KEY(account_id,op_id),
                    FOREIGN KEY(account_id) REFERENCES connection_vaults(account_id)
                );
            ''')

    def _fail(self, code='invalid_request'):
        status, message = {
            'invalid_request': (400, '连接配置请求格式无效。'),
            'unauthorized': (401, '连接设备认证失败。'),
            'forbidden': (403, '连接设备尚未获准执行此操作。'),
            'conflict': (409, '连接配置版本或设备状态已变化，请重新读取。'),
            'not_initialized': (409, '连接配置尚未初始化。'),
            'capacity': (409, '连接配置存储数量已达上限。'),
            'store_unavailable': (503, '连接配置暂时无法保存。'),
        }[code]
        raise self.error_cls(status, code, message) from None

    def _fields(self, value, required, optional=()):
        if type(value) is not dict or set(value) - set(required) - set(optional) or set(required) - set(value):
            self._fail()

    def _id(self, value):
        if type(value) is not str or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', value) is None:
            self._fail()
        return value

    def _revision(self, value, zero=False):
        if type(value) is not int or not (0 if zero else 1) <= value <= MAX_REVISION:
            self._fail()
        return value

    def _next(self, value):
        if value >= MAX_REVISION:
            self._fail('capacity')
        return value + 1

    def _b64(self, value, minimum, maximum=None):
        maximum = minimum if maximum is None else maximum
        if type(value) is not str or not (minimum * 4 + 2) // 3 <= len(value) <= (maximum * 4 + 2) // 3:
            self._fail()
        if re.fullmatch(r'[A-Za-z0-9_-]+', value) is None:
            self._fail()
        try:
            raw = base64.urlsafe_b64decode(value + '=' * ((4 - len(value) % 4) % 4))
        except (ValueError, TypeError):
            self._fail()
        if not minimum <= len(raw) <= maximum or base64.urlsafe_b64encode(raw).decode().rstrip('=') != value:
            self._fail()
        return raw

    def _secret_hash(self, secret):
        try:
            raw = self._b64(secret, 32)
        except self.error_cls:
            self._fail('unauthorized')
        return hashlib.sha256(raw).hexdigest()

    def _origin(self, value):
        if type(value) is not str or len(value) > 2048 or re.search(r'[\s\\?#]', value):
            self._fail()
        try:
            p = urlsplit(value)
            host, port = p.hostname, p.port
            if (p.scheme not in ('http', 'https') or not host or p.username is not None or p.password is not None
                    or p.path not in ('', '/') or (port is not None and not 1 <= port <= 65535)):
                self._fail()
            if p.scheme == 'http' and host not in ('localhost', '127.0.0.1', '::1'):
                self._fail()
            host = host.encode('idna').decode().lower()
            host = '[' + host + ']' if ':' in host else host
            suffix = '' if port is None or (p.scheme, port) in (('https', 443), ('http', 80)) else ':' + str(port)
            return p.scheme + '://' + host + suffix
        except (ValueError, UnicodeError):
            self._fail()

    def _public_key(self, value):
        self._fields(value, ('crv', 'kty', 'x', 'y'), ('ext', 'key_ops'))
        if value['crv'] != 'P-256' or value['kty'] != 'EC' or ('ext' in value and value['ext'] is not True):
            self._fail()
        if 'key_ops' in value and (type(value['key_ops']) is not list or value['key_ops']):
            self._fail()
        x, y = (int.from_bytes(self._b64(value[k], 32), 'big') for k in ('x', 'y'))
        # SEC/NIST P-256 public point validation only, not an ECDH implementation.
        prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
        coefficient = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b
        if x >= prime or y >= prime or (y * y - (x * x * x - 3 * x + coefficient)) % prime:
            self._fail()
        key = {k: value[k] for k in ('crv', 'kty', 'x', 'y')}
        fingerprint = base64.urlsafe_b64encode(hashlib.sha256(_json(key).encode()).digest()).decode().rstrip('=')
        return key, fingerprint

    def _payload(self, value):
        try:
            text = _json(value)
            if len(text.encode()) > MAX_REQUEST_BYTES:
                self._fail()
            return json.loads(text)  # Snapshot caller-owned nested objects before SQL writes.
        except (ValueError, TypeError, RecursionError, UnicodeError):
            self._fail()

    @contextmanager
    def _transaction(self, identity):
        try:
            with self.db_factory() as db:
                db.row_factory = sqlite3.Row
                db.execute('PRAGMA foreign_keys=ON')
                db.execute('BEGIN IMMEDIATE')
                try:
                    try:
                        verified = self.verify_session(db, identity)
                        self._fields(verified, ('accountId', 'sessionId'))
                        account = self._id(verified['accountId'])
                        session = self._id(verified['sessionId'])
                    except Exception:
                        self._fail('unauthorized')
                    yield db, account, session
                    db.commit()
                except BaseException:
                    db.rollback()
                    raise
        except sqlite3.Error:
            self._fail('store_unavailable')

    def _vault(self, db, account):
        row = db.execute('SELECT * FROM connection_vaults WHERE account_id=?', (account,)).fetchone()
        if row is None:
            self._fail('not_initialized')
        return row

    def _device(self, db, account, session, device_id, secret, owner=False, pending=False):
        digest = self._secret_hash(secret)
        # Bad/missing identities, hashes and session bindings share one generic error.
        row = db.execute('SELECT * FROM connection_devices WHERE account_id=? AND device_id=?', (account, device_id if type(device_id) is str else '')).fetchone()
        stored = row['secret_hash'] if row is not None else '0' * 64
        if not hmac.compare_digest(stored, digest) or row is None or row['session_id'] != session:
            self._fail('unauthorized')
        if row['status'] == 'revoked' or (owner and row['status'] != 'owner') or (not pending and row['status'] == 'pending'):
            self._fail('forbidden')
        return row

    def _status(self, vault, device):
        return {'epoch': vault['epoch'], 'revision': vault['revision'], 'deviceId': device['device_id'], 'status': device['status']}

    def _enroll(self, identity, secret, payload, initialize):
        with self._transaction(identity) as (db, account, session):
            data = self._payload(payload)
            self._fields(data, ('publicJwk',))
            key, device_id = self._public_key(data['publicJwk'])
            digest = self._secret_hash(secret)
            vault = db.execute('SELECT * FROM connection_vaults WHERE account_id=?', (account,)).fetchone()
            if vault is None:
                if not initialize:
                    self._fail('not_initialized')
                db.execute('INSERT INTO connection_vaults VALUES(?,?,1,1)', (account, device_id))
                db.execute('INSERT INTO connection_devices VALUES(?,?,?,?,?,?)', (account, device_id, _json(key), digest, session, 'owner'))
            else:
                device = db.execute('SELECT * FROM connection_devices WHERE account_id=? AND device_id=?', (account, device_id)).fetchone()
                if device is not None:
                    if not hmac.compare_digest(device['secret_hash'], digest):
                        self._fail('unauthorized')
                    if device['status'] == 'revoked':
                        self._fail('forbidden')
                    if initialize and device['status'] != 'owner':
                        self._fail('conflict')
                    db.execute('UPDATE connection_devices SET session_id=? WHERE account_id=? AND device_id=?', (session, account, device_id))
                else:
                    if initialize:
                        self._fail('conflict')
                    if db.execute('SELECT count(*) FROM connection_devices WHERE account_id=?', (account,)).fetchone()[0] >= MAX_DEVICES:
                        self._fail('capacity')
                    db.execute('INSERT INTO connection_devices VALUES(?,?,?,?,?,?)', (account, device_id, _json(key), digest, session, 'pending'))
                    db.execute('UPDATE connection_vaults SET revision=? WHERE account_id=?', (self._next(vault['revision']), account))
            vault = self._vault(db, account)
            device = self._device(db, account, session, device_id, secret, pending=True)
            return self._status(vault, device)

    def initialize(self, identity, device_secret, payload):
        return self._enroll(identity, device_secret, payload, True)

    def register(self, identity, device_secret, payload):
        return self._enroll(identity, device_secret, payload, False)

    def status(self, identity, device_id, device_secret):
        with self._transaction(identity) as (db, account, session):
            device = self._device(db, account, session, device_id, device_secret, pending=True)
            return self._status(self._vault(db, account), device)

    def _epoch(self, vault, epoch):
        self._revision(epoch)
        if epoch != vault['epoch']:
            self._fail('conflict')

    def _read(self, db, account, vault, device):
        result = self._status(vault, device)
        result['ownerFingerprint'] = vault['owner_id']
        result['profiles'] = []
        for row in db.execute('SELECT * FROM connection_profiles WHERE account_id=? ORDER BY profile_id', (account,)):
            wrap = db.execute('SELECT envelope FROM connection_wraps WHERE account_id=? AND profile_id=? AND device_id=?', (account, row['profile_id'], device['device_id'])).fetchone()
            if not row['deleted'] and wrap is None:
                self._fail('store_unavailable')
            result['profiles'].append({'profileId': row['profile_id'], 'version': row['version'], 'epoch': row['epoch'],
                                       'deleted': bool(row['deleted']), 'envelope': json.loads(row['envelope']) if row['envelope'] else None,
                                       'wrap': json.loads(wrap['envelope']) if wrap else None})
        return result

    def read(self, identity, device_id, device_secret, epoch):
        with self._transaction(identity) as (db, account, session):
            device = self._device(db, account, session, device_id, device_secret)
            vault = self._vault(db, account)
            self._epoch(vault, epoch)
            return self._read(db, account, vault, device)

    def owner_state(self, identity, device_id, device_secret, epoch):
        with self._transaction(identity) as (db, account, session):
            device = self._device(db, account, session, device_id, device_secret, owner=True)
            vault = self._vault(db, account)
            self._epoch(vault, epoch)
            result = self._read(db, account, vault, device)
            result['devices'] = [{'deviceId': row['device_id'], 'status': row['status'], 'publicJwk': json.loads(row['public_jwk'])}
                                 for row in db.execute('SELECT * FROM connection_devices WHERE account_id=? ORDER BY device_id', (account,))]
            return result

    def operation_result(self, identity, device_id, device_secret, payload):
        """Read a current-epoch receipt after an uncertain write, never replay it.

        requestHash = SHA256(compact recursively key-sorted JSON([kind, payload])).
        Wire payload strings are ASCII; kind is commit, approve, or rotate. An
        unknown/pruned/older-epoch result must leave the client's pending write
        intact. This endpoint does not authorize activation of unverified data.
        """
        with self._transaction(identity) as (db, account, session):
            self._device(db, account, session, device_id, device_secret, owner=True)
            vault = self._vault(db, account)
            data = self._payload(payload)
            self._fields(data, ('epoch', 'opId', 'requestHash'))
            self._epoch(vault, data['epoch'])
            self._id(data['opId'])
            if type(data['requestHash']) is not str or re.fullmatch(r'[0-9a-f]{64}', data['requestHash']) is None:
                self._fail()
            row = db.execute('SELECT * FROM connection_receipts WHERE account_id=? AND op_id=?', (account, data['opId'])).fetchone()
            result = {'epoch': vault['epoch'], 'revision': vault['revision']}
            if row is None or row['epoch'] != vault['epoch']:
                return {**result, 'status': 'unknown', 'opId': data['opId']}
            if not hmac.compare_digest(row['request_hash'], data['requestHash']):
                self._fail('conflict')
            return {**result, 'status': 'committed', 'receipt': json.loads(row['result'])}

    def _context(self, context, account, profile_id, epoch, version):
        self._fields(context, ('serverOrigin', 'accountId', 'profileId', 'epoch', 'version'))
        self._revision(context['epoch']); self._revision(context['version'])
        if context != {'serverOrigin': self.origin, 'accountId': account, 'profileId': profile_id, 'epoch': epoch, 'version': version}:
            self._fail('conflict')

    def _sealed(self, envelope, account, profile_id, epoch, version):
        self._fields(envelope, ('format', 'suite', 'context', 'nonce', 'ciphertext'))
        if envelope['format'] != SEALED or envelope['suite'] != 'A256GCM':
            self._fail()
        self._context(envelope['context'], account, profile_id, epoch, version)
        self._b64(envelope['nonce'], 12)
        self._b64(envelope['ciphertext'], 17, MAX_PROFILE_BYTES + 16)

    def _wrap(self, envelope, account, profile_id, epoch, version, owner, recipients):
        self._fields(envelope, ('format', 'suite', 'context', 'senderFingerprint', 'recipientFingerprint', 'salt', 'nonce', 'ciphertext'))
        if envelope['format'] != WRAPPED or envelope['suite'] != WRAP_SUITE:
            self._fail()
        self._context(envelope['context'], account, profile_id, epoch, version)
        self._b64(envelope['senderFingerprint'], 32); self._b64(envelope['recipientFingerprint'], 32)
        if envelope['senderFingerprint'] != owner or envelope['recipientFingerprint'] not in recipients:
            self._fail('conflict')
        self._b64(envelope['salt'], 32); self._b64(envelope['nonce'], 12); self._b64(envelope['ciphertext'], 48)
        return envelope['recipientFingerprint']

    def _start_operation(self, db, account, vault, data, kind):
        self._id(data['opId'])
        self._epoch(vault, data['expectedEpoch'])  # Even known receipts cannot authorize old-epoch replay.
        self._revision(data['expectedRevision'])
        digest = hashlib.sha256(_json([kind, data]).encode()).hexdigest()
        row = db.execute('SELECT * FROM connection_receipts WHERE account_id=? AND op_id=?', (account, data['opId'])).fetchone()
        if row is not None:
            if not hmac.compare_digest(row['request_hash'], digest):
                self._fail('conflict')
            return digest, {**json.loads(row['result']), 'replayed': True}
        if vault['revision'] != data['expectedRevision']:
            self._fail('conflict')
        return digest, None

    def _finish_operation(self, db, account, vault, data, digest, epoch=None):
        epoch = vault['epoch'] if epoch is None else epoch
        revision = self._next(vault['revision'])
        db.execute('UPDATE connection_vaults SET epoch=?,revision=? WHERE account_id=?', (epoch, revision, account))
        result = {'epoch': epoch, 'revision': revision, 'opId': data['opId'], 'replayed': False}
        db.execute('INSERT INTO connection_receipts VALUES(?,?,?,?,?,?)', (account, data['opId'], epoch, revision, digest, _json(result)))
        db.execute('DELETE FROM connection_receipts WHERE account_id=? AND op_id NOT IN (SELECT op_id FROM connection_receipts WHERE account_id=? ORDER BY revision DESC LIMIT ?)', (account, account, MAX_RECEIPTS))
        return result

    def _members(self, db, account):
        return {r['device_id'] for r in db.execute("SELECT device_id FROM connection_devices WHERE account_id=? AND status IN ('owner','approved')", (account,))}

    def _profiles(self, db, account):
        return {r['profile_id']: r for r in db.execute('SELECT * FROM connection_profiles WHERE account_id=?', (account,))}

    def _updates(self, values, account, vault, current, members, epoch, rotation=False):
        if type(values) is not list or len(values) > MAX_PROFILES or (not rotation and not values):
            self._fail()
        normalized, seen = [], set()
        for value in values:
            self._fields(value, ('profileId', 'baseVersion', 'version', 'deleted', 'envelope', 'wraps'))
            profile_id = self._id(value['profileId'])
            if profile_id in seen:
                self._fail()
            seen.add(profile_id)
            old = current.get(profile_id)
            base = self._revision(value['baseVersion'], zero=True)
            self._revision(value['version'])
            if base != (old['version'] if old else 0) or value['version'] != self._next(base):
                self._fail('conflict')
            if type(value['deleted']) is not bool or type(value['wraps']) is not list or len(value['wraps']) > MAX_DEVICES:
                self._fail()
            if rotation and (old is None or value['deleted'] != bool(old['deleted'])):
                self._fail('conflict')
            if value['deleted']:
                if old is None or value['envelope'] is not None or value['wraps']:
                    self._fail()
            else:
                self._sealed(value['envelope'], account, profile_id, epoch, value['version'])
                if old and not old['deleted']:
                    previous = json.loads(old['envelope'])
                    # Reject a metadata-only relabeling. This does not prove key freshness.
                    if previous['ciphertext'] == value['envelope']['ciphertext'] or previous['nonce'] == value['envelope']['nonce']:
                        self._fail('conflict')
                wrapped = [self._wrap(w, account, profile_id, epoch, value['version'], vault['owner_id'], members) for w in value['wraps']]
                if len(wrapped) != len(set(wrapped)) or set(wrapped) != members:
                    self._fail('conflict')
            normalized.append(value)
        if rotation and seen != set(current):
            self._fail('conflict')
        if len(set(current) | seen) > MAX_PROFILES:
            self._fail('capacity')
        return normalized

    def _write_profiles(self, db, account, epoch, values):
        for value in values:
            profile_id = value['profileId']
            db.execute('INSERT INTO connection_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,profile_id) DO UPDATE SET epoch=excluded.epoch,version=excluded.version,deleted=excluded.deleted,envelope=excluded.envelope',
                       (account, profile_id, epoch, value['version'], int(value['deleted']), _json(value['envelope']) if value['envelope'] else None))
            db.execute('DELETE FROM connection_wraps WHERE account_id=? AND profile_id=?', (account, profile_id))
            for wrap in value['wraps']:
                db.execute('INSERT INTO connection_wraps VALUES(?,?,?,?)', (account, profile_id, wrap['recipientFingerprint'], _json(wrap)))

    def commit(self, identity, device_id, device_secret, payload):
        with self._transaction(identity) as (db, account, session):
            self._device(db, account, session, device_id, device_secret, owner=True)
            vault = self._vault(db, account)
            data = self._payload(payload)
            self._fields(data, ('opId', 'expectedEpoch', 'expectedRevision', 'profiles'))
            digest, replay = self._start_operation(db, account, vault, data, 'commit')
            if replay is not None:
                return replay
            values = self._updates(data['profiles'], account, vault, self._profiles(db, account), self._members(db, account), vault['epoch'])
            self._write_profiles(db, account, vault['epoch'], values)
            return self._finish_operation(db, account, vault, data, digest)

    def approve(self, identity, device_id, device_secret, payload):
        with self._transaction(identity) as (db, account, session):
            self._device(db, account, session, device_id, device_secret, owner=True)
            vault = self._vault(db, account)
            data = self._payload(payload)
            self._fields(data, ('opId', 'expectedEpoch', 'expectedRevision', 'deviceId', 'wraps'))
            digest, replay = self._start_operation(db, account, vault, data, 'approve')
            if replay is not None:
                return replay
            target = db.execute('SELECT * FROM connection_devices WHERE account_id=? AND device_id=?', (account, data['deviceId'] if type(data['deviceId']) is str else '')).fetchone()
            if target is None or target['status'] != 'pending':
                self._fail('conflict')
            current = {k: v for k, v in self._profiles(db, account).items() if not v['deleted']}
            if type(data['wraps']) is not list or len(data['wraps']) != len(current):
                self._fail('conflict')
            seen = set()
            for wrap in data['wraps']:
                if type(wrap) is not dict or type(wrap.get('context')) is not dict:
                    self._fail()
                profile_id = wrap['context'].get('profileId')
                if type(profile_id) is not str or profile_id not in current or profile_id in seen:
                    self._fail('conflict')
                seen.add(profile_id)
                self._wrap(wrap, account, profile_id, vault['epoch'], current[profile_id]['version'], vault['owner_id'], {target['device_id']})
            for wrap in data['wraps']:
                db.execute('INSERT INTO connection_wraps VALUES(?,?,?,?)', (account, wrap['context']['profileId'], target['device_id'], _json(wrap)))
            db.execute("UPDATE connection_devices SET status='approved' WHERE account_id=? AND device_id=?", (account, target['device_id']))
            return self._finish_operation(db, account, vault, data, digest)

    def rotate_and_revoke(self, identity, device_id, device_secret, payload):
        with self._transaction(identity) as (db, account, session):
            self._device(db, account, session, device_id, device_secret, owner=True)
            vault = self._vault(db, account)
            data = self._payload(payload)
            self._fields(data, ('opId', 'expectedEpoch', 'expectedRevision', 'newEpoch', 'revokeDeviceIds', 'profiles'))
            digest, replay = self._start_operation(db, account, vault, data, 'rotate')
            if replay is not None:
                return replay
            self._revision(data['newEpoch'])
            if data['newEpoch'] != self._next(vault['epoch']):
                self._fail('conflict')
            revoked = data['revokeDeviceIds']
            if type(revoked) is not list or not 1 <= len(revoked) < MAX_DEVICES or any(type(x) is not str for x in revoked) or len(set(revoked)) != len(revoked):
                self._fail()
            for target_id in revoked:
                target = db.execute('SELECT status FROM connection_devices WHERE account_id=? AND device_id=?', (account, target_id)).fetchone()
                if target is None or target['status'] not in ('approved', 'pending'):
                    self._fail('conflict')
            members = self._members(db, account) - set(revoked)
            values = self._updates(data['profiles'], account, vault, self._profiles(db, account), members, data['newEpoch'], rotation=True)
            self._write_profiles(db, account, data['newEpoch'], values)
            for target_id in revoked:
                db.execute("UPDATE connection_devices SET status='revoked',session_id='' WHERE account_id=? AND device_id=?", (account, target_id))
                db.execute('DELETE FROM connection_wraps WHERE account_id=? AND device_id=?', (account, target_id))
            return self._finish_operation(db, account, vault, data, digest, data['newEpoch'])
