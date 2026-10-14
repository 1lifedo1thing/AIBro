'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createConnectionSyncClient } = require('../app/connection-sync-client');
const { createConnectionVault } = require('../app/connection-vault');
const root = path.resolve(__dirname, '..');
const clone = value => structuredClone(value);
const cryptoVault = createConnectionVault(crypto.webcrypto);
const origin = 'https://sync.example.test';

// Actual Python production store, fresh temporary SQLite, synthetic authenticated
// identities. No socket, real account, native credential or content-sync store.
const python = String.raw`
import json,sqlite3,sys
from contextlib import contextmanager
sys.path.insert(0,sys.argv[2])
from connection_sync_store import ConnectionSyncStore,ConnectionSyncError
@contextmanager
def database():
 db=sqlite3.connect(sys.argv[1])
 try: yield db
 finally: db.close()
def verify(db,identity):
 if set(identity)!={'accountId','sessionId'}: raise ValueError()
 return identity
store=ConnectionSyncStore(database,'https://sync.example.test',verify)
for line in sys.stdin:
 try:
  m=json.loads(line); op=m['operation']; args=[m['identity']]
  if op in ('initialize','register'):args += [m['deviceSecret'],m['payload']]
  elif op=='status':args += [m['deviceId'],m['deviceSecret']]
  elif op in ('read','owner_state'):args += [m['deviceId'],m['deviceSecret'],m['payload']['epoch']]
  else:args += [m['deviceId'],m['deviceSecret'],m['payload']]
  result={'status':200,'body':getattr(store,op)(*args)}
 except ConnectionSyncError as e: result={'status':e.status,'body':{'code':e.code}}
 except Exception as e: result={'status':500,'body':{'code':type(e).__name__}}
 print(json.dumps(result,separators=(',',':')),flush=True)
`;

async function server(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aibro-connection-client-'));
  const database = path.join(dir, 'synthetic.sqlite');
  const process = spawn('python3', ['-u', '-c', python, database, path.join(root, 'app')],
    { env: { ...processEnv(), PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = []; let stderr = '';
  process.stderr.on('data', data => { stderr += data.toString(); });
  readline.createInterface({ input: process.stdout }).on('line', line => {
    const item = pending.shift(); if (item) item.resolve(JSON.parse(line));
  });
  process.on('exit', code => { for (const item of pending.splice(0)) item.reject(Error('synthetic store process ended ' + code + ': ' + stderr)); });
  t.after(async () => { process.stdin.end(); await new Promise(resolve => process.once('close', resolve)); await rm(dir, { recursive: true, force: true }); });
  const calls = [];
  return { calls, database, async transport(request) {
    calls.push(clone(request));
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      process.stdin.write(JSON.stringify({ ...request, identity: { accountId: request.session.accountId, sessionId: request.session.sessionId } }) + '\n');
    });
  } };
}
function processEnv() { return { PATH: process.env.PATH, HOME: process.env.HOME }; }
function profile(purpose = 'chat', key = 'synthetic-API-key-only', model = 'synthetic-model') {
  return { format: 'aibro.connection-profile.v1', purpose, provider: 'openai-compatible', authKind: 'api-key',
    apiFormat: { chat: 'chat-completions', embedding: 'embeddings', speech: 'audio-transcriptions' }[purpose],
    baseUrl: 'https://synthetic-provider.example/v1', model, apiKey: key };
}
function device(server, sessionId, accountId = 'account_fixture') {
  let session = { serverOrigin: origin, accountId, sessionId, generation: 1 };
  const entries = new Map(), writes = []; let rejectWrite = null, beforeWrite = null;
  const key = value => JSON.stringify(value);
  const vault = {
    async read(binding) { return clone(entries.get(key(binding)) || { revision: 0, value: null }); },
    async compareAndSwap(request) {
      if (beforeWrite) await beforeWrite(request);
      if (JSON.stringify(request.sessionFence) !== JSON.stringify(session)) return false;
      const old = entries.get(key(request.binding)) || { revision: 0, value: null };
      if (old.revision !== request.expectedRevision || rejectWrite?.(request)) return false;
      entries.set(key(request.binding), { revision: old.revision + 1, value: clone(request.value) }); writes.push(clone(request.value));
      return true;
    }
  };
  let transport = request => server.transport(request);
  const construct = () => createConnectionSyncClient({ cryptoProvider: crypto.webcrypto, atomicVault: vault,
    currentSession: () => session, transport: request => transport(request) });
  return { client: construct(), vault, writes, construct,
    changeSession: changes => { session = { ...session, ...changes, generation: session.generation + 1 }; },
    intercept: fn => { transport = fn; }, beforeWrite: fn => { beforeWrite = fn; }, rejectWrite: fn => { rejectWrite = fn; },
    async state() { return (await vault.read({ serverOrigin: session.serverOrigin, accountId: session.accountId })).value; },
    async saved(account = accountId) { return (await vault.read({ serverOrigin: origin, accountId: account })).value; }
  };
}
async function paired(t, withProfiles = true) {
  const cloud = await server(t), owner = device(cloud, 'owner_session'), phone = device(cloud, 'phone_session');
  const ownerInfo = await owner.client.initializeOwner();
  if (withProfiles) await owner.client.saveProfiles(['chat', 'embedding', 'speech'].map(purpose => ({ profileId: purpose, profile: profile(purpose) })));
  const phoneInfo = await phone.client.registerPending();
  await phone.client.pinOwner({ publicJwk: ownerInfo.publicJwk, confirmedFingerprint: ownerInfo.deviceId });
  await owner.client.approveDevice({ deviceId: phoneInfo.deviceId, confirmedFingerprint: phoneInfo.deviceId });
  await phone.client.pull();
  return { cloud, owner, phone, ownerInfo, phoneInfo };
}

test('actual Python store: initialize, three complete profiles, fingerprint pairing, phone decrypt and atomic activation', async t => {
  const f = await paired(t);
  const owner = await f.owner.state(), phone = await f.phone.state();
  assert.deepEqual(phone.activeProfiles, Object.fromEntries(['chat', 'embedding', 'speech'].map(p => [p, profile(p)])));
  assert.equal(phone.trustedOwner.fingerprint, f.ownerInfo.deviceId);
  assert.notEqual(phone.device.secret, phone.profiles.chat.key);
  assert.notEqual(owner.device.secret, owner.profiles.chat.key);
  const wire = f.cloud.calls.filter(c => ['commit', 'approve'].includes(c.operation)).map(c => c.payload);
  const body = JSON.stringify(wire);
  for (const secret of ['synthetic-API-key-only', 'synthetic-provider.example', owner.device.privateJwk.d, phone.device.privateJwk.d]) assert.equal(body.includes(secret), false);
  assert.equal((await readFile(f.cloud.database)).includes(Buffer.from('synthetic-API-key-only')), false);
  const info = JSON.stringify(await f.phone.client.pairingInfo());
  assert.equal(info.includes(phone.device.secret), false); assert.equal(info.includes('apiKey'), false);
});

test('pending phone cannot pull plaintext, approve itself or save profiles', async t => {
  const cloud = await server(t), owner = device(cloud, 'owner'), phone = device(cloud, 'phone');
  await owner.client.initializeOwner(); await phone.client.registerPending();
  assert.equal((await phone.client.pull()).pendingApproval, true);
  assert.deepEqual((await phone.state()).activeProfiles, {});
  await assert.rejects(phone.client.saveProfiles([{ profileId: 'chat', profile: profile() }]), { code: 'OWNER_ONLY' });
  const state = await phone.state();
  const response = await cloud.transport({ operation: 'commit', session: { accountId: 'account_fixture', sessionId: 'phone' },
    deviceId: state.device.fingerprint, deviceSecret: state.device.secret, payload: {} });
  assert.equal(response.status, 403);
});

test('both fingerprints require explicit exact match and existing owner cannot be silently replaced', async t => {
  const cloud = await server(t), owner = device(cloud, 'owner'), phone = device(cloud, 'phone');
  const a = await owner.client.initializeOwner(), b = await phone.client.registerPending();
  await assert.rejects(phone.client.pinOwner({ publicJwk: a.publicJwk, confirmedFingerprint: b.deviceId }), { code: 'PAIRING_MISMATCH' });
  await assert.rejects(owner.client.approveDevice({ deviceId: b.deviceId, confirmedFingerprint: a.deviceId }), { code: 'PAIRING_MISMATCH' });
  await phone.client.pinOwner({ publicJwk: a.publicJwk, confirmedFingerprint: a.deviceId });
  const stranger = await cryptoVault.generateDeviceKeyPair();
  await assert.rejects(phone.client.pinOwner({ publicJwk: stranger.publicJwk, confirmedFingerprint: stranger.fingerprint }), { code: 'PAIRING_MISMATCH' });
});

test('untrusted response owner key is not used, and unpinned approved phone does not activate', async t => {
  const cloud = await server(t), owner = device(cloud, 'owner'), phone = device(cloud, 'phone');
  await owner.client.initializeOwner(); await owner.client.saveProfiles([{ profileId: 'chat', profile: profile() }]);
  const p = await phone.client.registerPending(); await owner.client.approveDevice({ deviceId: p.deviceId, confirmedFingerprint: p.deviceId });
  await assert.rejects(phone.client.pull(), { code: 'UNPAIRED' });
  assert.deepEqual((await phone.state()).activeProfiles, {});
});

test('failed local freeze sends no commit; failed activation leaves old whole bundle plus durable retry', async t => {
  const f = await paired(t), old = clone((await f.owner.state()).activeProfiles);
  f.owner.rejectWrite(r => !!r.value.pending);
  const before = f.cloud.calls.filter(c => c.operation === 'commit').length;
  await assert.rejects(f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile('chat', 'candidate-key') }]), { code: 'LOCAL_CONFLICT' });
  assert.equal(f.cloud.calls.filter(c => c.operation === 'commit').length, before);
  f.owner.rejectWrite(r => !r.value.pending && r.value.activeProfiles.chat?.apiKey === 'candidate-key');
  await assert.rejects(f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile('chat', 'candidate-key') }]), { code: 'LOCAL_CONFLICT' });
  assert.deepEqual((await f.owner.state()).activeProfiles, old);
  assert.ok((await f.owner.state()).pending);
  f.owner.rejectWrite(null);
  await f.owner.construct().retryPending();
  assert.equal((await f.owner.state()).activeProfiles.chat.apiKey, 'candidate-key');
  await f.phone.client.pull(); assert.equal((await f.phone.state()).activeProfiles.chat.apiKey, 'candidate-key');
});

test('dropped commit ACK and restart resend identical frozen body, never re-encrypt or double-increment', async t => {
  const f = await paired(t); let lost = false;
  f.owner.intercept(async request => { const response = await f.cloud.transport(request); if (request.operation === 'commit' && !lost) { lost = true; throw Error('synthetic dropped response'); } return response; });
  await assert.rejects(f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile('chat', 'updated-key') }]), { code: 'NETWORK' });
  const pending = clone((await f.owner.state()).pending);
  assert.equal((await f.owner.state()).activeProfiles.chat.apiKey, 'synthetic-API-key-only');
  await assert.rejects(f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile() }]), { code: 'PENDING' });
  await f.owner.construct().retryPending();
  const attempts = f.cloud.calls.filter(c => c.operation === 'commit').slice(-2);
  assert.deepEqual(attempts[0].payload, attempts[1].payload);
  assert.deepEqual(attempts[1].payload, pending.payload);
  assert.equal((await f.owner.state()).profiles.chat.version, 2);
});

test('late old account/session responses never commit or activate', async t => {
  const f = await paired(t); const previous = clone(await f.phone.state());
  await f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile('chat', 'late-key') }]);
  f.phone.intercept(async request => { const response = await f.cloud.transport(request); if (request.operation === 'read') f.phone.changeSession({ accountId: 'other_account', sessionId: 'other_session' }); return response; });
  await assert.rejects(f.phone.client.pull(), { code: 'STALE_SESSION' });
  assert.deepEqual(await f.phone.saved(), previous);
  assert.equal(await f.phone.state(), null);
});

test('native commit-point session fence blocks a change after JS precheck', async t => {
  const f = await paired(t), previous = clone(await f.phone.state());
  await f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile('chat', 'late-key') }]);
  f.phone.beforeWrite(async request => { if (request.value.activeProfiles.chat?.apiKey === 'late-key') f.phone.changeSession({ sessionId: 'new_session' }); });
  await assert.rejects(f.phone.client.pull(), { code: 'STALE_SESSION' });
  assert.deepEqual(await f.phone.saved(), previous);
});

test('new cloud session rebinds only the same device secret and key; wrong secret cannot impersonate fingerprint', async t => {
  const f = await paired(t), previous = await f.phone.state();
  f.phone.changeSession({ sessionId: 'phone_session_new' });
  await f.phone.client.pull(); const next = await f.phone.state();
  assert.deepEqual(next.device, previous.device);
  const bad = await f.cloud.transport({ operation: 'register', session: { accountId: 'account_fixture', sessionId: 'attacker_session' },
    deviceId: previous.device.fingerprint, deviceSecret: Buffer.alloc(32, 2).toString('base64url'), payload: { publicJwk: previous.device.publicJwk } });
  assert.equal(bad.status, 401);
  await f.phone.client.pull();
});

test('rollback revision/version and same-version ciphertext replacement are rejected without activation', async t => {
  const f = await paired(t);
  await f.phone.client.pull();
  await f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile('chat', 'newest') }]);
  await f.phone.client.pull(); const latest = clone(await f.phone.state());
  f.phone.intercept(async request => { const response = await f.cloud.transport(request); if (request.operation === 'status') response.body.revision--; return response; });
  await assert.rejects(f.phone.client.pull(), { code: 'ROLLBACK' });
  f.phone.intercept(async request => { const response = await f.cloud.transport(request); if (request.operation === 'read') { response.body.profiles.find(p => p.profileId === 'chat').version--; } return response; });
  await assert.rejects(f.phone.client.pull(), { code: 'ROLLBACK' });
  f.phone.intercept(async request => {
    const response = await f.cloud.transport(request);
    if (request.operation === 'read') {
      const envelope = response.body.profiles[0].envelope;
      envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
    }
    return response;
  });
  await assert.rejects(f.phone.client.pull(), { code: 'ROLLBACK' });
  assert.deepEqual(await f.phone.state(), latest);
});

test('404 is a scoped unsupported result; existing active profiles stay usable and no content API is called', async t => {
  const f = await paired(t), old = clone(await f.phone.state());
  f.phone.intercept(async () => ({ status: 404, body: {} }));
  await assert.rejects(f.phone.client.pull(), { code: 'UNSUPPORTED' });
  assert.deepEqual(await f.phone.state(), old);
  assert.ok(f.cloud.calls.every(c => !String(c.operation).includes('/v1/sync')));
});

test('rotation generates new keys and ciphertext for every live profile and only remaining recipients can decrypt', async t => {
  const f = await paired(t), before = clone(await f.owner.state());
  const survivor = device(f.cloud, 'survivor_session'), info = await survivor.client.registerPending();
  await survivor.client.pinOwner({ publicJwk: f.ownerInfo.publicJwk, confirmedFingerprint: f.ownerInfo.deviceId });
  await f.owner.client.approveDevice({ deviceId: info.deviceId, confirmedFingerprint: info.deviceId });
  await survivor.client.pull();
  await f.owner.client.rotateAndRevoke([f.phoneInfo.deviceId]);
  const after = await f.owner.state();
  assert.equal(after.epoch, before.epoch + 1);
  for (const profileId of ['chat', 'embedding', 'speech']) {
    assert.notEqual(after.profiles[profileId].key, before.profiles[profileId].key);
    assert.notEqual(after.profiles[profileId].hash, before.profiles[profileId].hash);
    assert.equal(after.profiles[profileId].version, before.profiles[profileId].version + 1);
  }
  const rotation = f.cloud.calls.find(c => c.operation === 'rotate_and_revoke');
  assert.ok(rotation.payload.profiles.every(p => p.wraps.length === 2 && p.wraps.every(w => w.recipientFingerprint !== f.phoneInfo.deviceId)));
  await assert.rejects(f.phone.client.pull(), error => ['AUTH', 'FORBIDDEN'].includes(error.code));
  await survivor.client.pull(); assert.deepEqual((await survivor.state()).activeProfiles, before.activeProfiles);
});

test('tombstones survive pull and rotation, cannot be omitted to revive or lose old profile history', async t => {
  const f = await paired(t);
  await f.owner.client.saveProfiles([{ profileId: 'speech', profile: null }]);
  await f.phone.client.pull(); assert.equal((await f.phone.state()).activeProfiles.speech, undefined);
  f.phone.intercept(async request => { const response = await f.cloud.transport(request); if (request.operation === 'read') response.body.profiles = response.body.profiles.filter(p => p.profileId !== 'speech'); return response; });
  await assert.rejects(f.phone.client.pull(), { code: 'ROLLBACK' });
  await f.owner.client.rotateAndRevoke([f.phoneInfo.deviceId]);
  assert.equal((await f.owner.state()).profiles.speech.deleted, true);
  assert.equal((await f.owner.state()).profiles.speech.epoch, 2);
});

test('dropped rotation ACK resumes via current-epoch exact-hash receipt, never rekeys a second time', async t => {
  const f = await paired(t); let dropped = false;
  const before = clone(await f.owner.state());
  f.owner.intercept(async request => {
    const response = await f.cloud.transport(request);
    if (request.operation === 'rotate_and_revoke' && !dropped) { dropped = true; throw Error('synthetic lost rotation ACK'); }
    return response;
  });
  await assert.rejects(f.owner.client.rotateAndRevoke([f.phoneInfo.deviceId]), { code: 'NETWORK' });
  const pending = clone((await f.owner.state()).pending);
  assert.equal((await f.owner.state()).epoch, before.epoch);
  assert.deepEqual((await f.owner.state()).activeProfiles, before.activeProfiles);
  await f.owner.construct().retryPending();
  const after = await f.owner.state();
  assert.equal(after.pending, null); assert.equal(after.epoch, before.epoch + 1);
  assert.deepEqual(after.profiles, pending.candidate.profiles);
  const lookups = f.cloud.calls.filter(c => c.operation === 'operation_result');
  assert.equal(lookups.length, 1); assert.equal(lookups[0].payload.epoch, 2);
  assert.match(lookups[0].payload.requestHash, /^[0-9a-f]{64}$/);
  const attempts = f.cloud.calls.filter(c => c.operation === 'rotate_and_revoke');
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].payload, attempts[1].payload);
});

test('unknown/pruned or mismatched rotation receipt retains immutable pending and old activation', async t => {
  const f = await paired(t); let dropped = false;
  f.owner.intercept(async request => {
    const response = await f.cloud.transport(request);
    if (request.operation === 'rotate_and_revoke' && !dropped) { dropped = true; throw Error('synthetic lost ACK'); }
    return response;
  });
  await assert.rejects(f.owner.client.rotateAndRevoke([f.phoneInfo.deviceId]), { code: 'NETWORK' });
  const pendingState = clone(await f.owner.state());
  f.owner.intercept(async request => {
    const response = await f.cloud.transport(request);
    if (request.operation === 'operation_result') return { status: 200, body: { status: 'unknown', epoch: response.body.epoch, revision: response.body.revision, opId: request.payload.opId } };
    return response;
  });
  await assert.rejects(f.owner.construct().retryPending(), { code: 'CONFLICT' });
  const observed = clone(await f.owner.state());
  assert.deepEqual(observed.pending, pendingState.pending);
  assert.deepEqual(observed.activeProfiles, pendingState.activeProfiles);
  assert.equal(observed.epoch, 2);
  assert.equal(observed.revision, pendingState.pending.payload.expectedRevision + 1);
  f.owner.intercept(async request => {
    if (request.operation === 'operation_result') request.payload.requestHash = '0'.repeat(64);
    return f.cloud.transport(request);
  });
  await assert.rejects(f.owner.construct().retryPending(), { code: 'CONFLICT' });
  assert.deepEqual(await f.owner.state(), observed);
});

test('caller mutation after save invocation does not alter frozen profile or pairing key', async t => {
  const cloud = await server(t), owner = device(cloud, 'owner'), phone = device(cloud, 'phone');
  const info = await owner.client.initializeOwner();
  const changes = [{ profileId: 'chat', profile: profile('chat', 'intended-key') }];
  const save = owner.client.saveProfiles(changes); changes[0].profile.apiKey = 'late-key'; await save;
  assert.equal((await owner.state()).activeProfiles.chat.apiKey, 'intended-key');
  await phone.client.registerPending();
  const input = { publicJwk: clone(info.publicJwk), confirmedFingerprint: info.deviceId };
  const pin = phone.client.pinOwner(input); input.publicJwk.x = 'late-invalid'; await pin;
  assert.deepEqual((await phone.state()).trustedOwner.publicJwk, info.publicJwk);
});

test('bad schema batch writes no server profile; constructor-like ID is treated as an ordinary own key', async t => {
  const cloud = await server(t), owner = device(cloud, 'owner'); await owner.client.initializeOwner();
  await assert.rejects(owner.client.saveProfiles([{ profileId: 'chat', profile: profile() }, { profileId: 'bad', profile: { ...profile(), token: 'must-reject' } }]));
  assert.equal(cloud.calls.filter(c => c.operation === 'commit').length, 0);
  await owner.client.saveProfiles([{ profileId: 'constructor', profile: profile() }]);
  assert.equal((await owner.state()).activeProfiles.constructor.apiKey, 'synthetic-API-key-only');
});

async function commitNewerRemoteProfile(f) {
  const local = await f.owner.state();
  const auth = clone(f.cloud.calls.find(c => c.operation === 'initialize'));
  const current = await f.cloud.transport({ ...auth, operation: 'status', payload: {} });
  const directory = await f.cloud.transport({ ...auth, operation: 'owner_state', payload: { epoch: current.body.epoch } });
  const old = local.pending.candidate.profiles.chat;
  const context = { serverOrigin: origin, accountId: auth.session.accountId, profileId: 'chat',
    epoch: current.body.epoch, version: old.version + 1 };
  const configurationKey = Buffer.from(old.key, 'base64url');
  const envelope = await cryptoVault.encryptProfile({ profile: profile('chat', 'newer-remote-key'), configurationKey, context });
  const wraps = await Promise.all(directory.body.devices.filter(d => ['owner', 'approved'].includes(d.status)).map(d =>
    cryptoVault.wrapConfigurationKey({ configurationKey, senderPrivateJwk: local.device.privateJwk, recipientPublicJwk: d.publicJwk, context })));
  const result = await f.cloud.transport({ ...auth, operation: 'commit', payload: { opId: 'synthetic_newer_remote_commit',
    expectedEpoch: current.body.epoch, expectedRevision: current.body.revision,
    profiles: [{ profileId: 'chat', baseVersion: old.version, version: context.version, deleted: false, envelope, wraps }] } });
  assert.equal(result.status, 200);
  return result.body;
}

test('review: forged server approved recipient never receives an outgoing configuration wrap', async t => {
  const f = await paired(t), attacker = await cryptoVault.generateDeviceKeyPair();
  const before = f.cloud.calls.filter(c => ['commit', 'rotate_and_revoke'].includes(c.operation)).length;
  f.owner.intercept(async request => {
    const response = await f.cloud.transport(request);
    if (request.operation === 'owner_state') response.body.devices.push({ deviceId: attacker.fingerprint,
      publicJwk: attacker.publicJwk, status: 'approved' });
    return response;
  });
  await assert.rejects(f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile('chat', 'must-not-leave-for-attacker') }]), { code: 'UNTRUSTED_RECIPIENT' });
  await assert.rejects(f.owner.client.rotateAndRevoke([f.phoneInfo.deviceId]), { code: 'UNTRUSTED_RECIPIENT' });
  assert.equal(f.cloud.calls.filter(c => ['commit', 'rotate_and_revoke'].includes(c.operation)).length, before);
  assert.equal((await f.owner.state()).pending, null);
});

for (const operation of ['commit', 'rotate_and_revoke']) {
  test(`review: ${operation} ACK loss cannot activate an older candidate after a newer real server commit`, async t => {
    const f = await paired(t), oldActive = clone((await f.owner.state()).activeProfiles); let dropped = false;
    f.owner.intercept(async request => {
      const response = await f.cloud.transport(request);
      if (request.operation === operation && !dropped) { dropped = true; throw Error('synthetic lost ACK'); }
      return response;
    });
    await assert.rejects(operation === 'commit'
      ? f.owner.client.saveProfiles([{ profileId: 'chat', profile: profile('chat', 'older-candidate-key') }])
      : f.owner.client.rotateAndRevoke([f.phoneInfo.deviceId]), { code: 'NETWORK' });
    const pending = clone((await f.owner.state()).pending);
    const latest = await commitNewerRemoteProfile(f);
    await assert.rejects(f.owner.construct().retryPending(), { code: 'CONFLICT' });
    const after = await f.owner.state();
    assert.deepEqual(after.pending, pending);
    assert.deepEqual(after.activeProfiles, oldActive);
    assert.equal(after.revision, latest.revision);
    assert.equal(after.epoch, latest.epoch);
    // The observed head survives restart and relogin without changing the
    // frozen payload. A subsequent older status cannot undo that knowledge.
    f.owner.changeSession({ sessionId: 'owner_relogin_after_conflict' });
    f.owner.intercept(async request => {
      const response = await f.cloud.transport(request);
      if (request.operation === 'status') response.body.revision--;
      return response;
    });
    await assert.rejects(f.owner.construct().retryPending(), { code: 'ROLLBACK' });
    assert.equal((await f.owner.state()).revision, latest.revision);
    assert.deepEqual((await f.owner.state()).pending, pending);
    assert.deepEqual((await f.owner.state()).activeProfiles, oldActive);
  });
}

test('native fence reaches local read/CAS only and prevents late same-session activation', async t => {
  const cloud = await server(t);
  let session = { serverOrigin: origin, accountId: 'native_account', sessionId: 'native_session',
    generation: 1, nativeFence: Buffer.alloc(32, 7).toString('base64url') };
  let saved = { revision: 0, value: null }; const reads = [], writes = [];
  const local = {
    async read(binding, options) { reads.push(clone(options.sessionFence)); return clone(saved); },
    async compareAndSwap(request) {
      writes.push(clone(request.sessionFence));
      if (!sameSession(request.sessionFence, session) || request.expectedRevision !== saved.revision) return false;
      saved = { revision: saved.revision + 1, value: clone(request.value) }; return true;
    }
  };
  const construct = transport => createConnectionSyncClient({ cryptoProvider: crypto.webcrypto, atomicVault: local,
    currentSession: () => session, transport });
  const client = construct(request => cloud.transport(request));
  await client.initializeOwner();
  assert.ok(reads.length && writes.length);
  assert.ok([...reads, ...writes].every(fence => fence.nativeFence === session.nativeFence));
  assert.ok(cloud.calls.every(request => !Object.hasOwn(request.session, 'nativeFence') && !Object.hasOwn(request.payload, 'nativeFence')));
  const previous = clone(saved);
  const stale = construct(async request => {
    const response = await cloud.transport(request);
    if (request.operation === 'owner_state') session = { ...session, nativeFence: Buffer.alloc(32, 8).toString('base64url') };
    return response;
  });
  await assert.rejects(stale.ownerState(), { code: 'STALE_SESSION' });
  assert.deepEqual(saved, previous);
  session.nativeFence = 'invalid';
  await assert.rejects(async () => client.pairingInfo(), { code: 'INVALID' });
});
function sameSession(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
