'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createConnectionVault, normalizeContext, normalizeProfile, LIMITS } = require('../app/connection-vault');

// All keys and records in this file are synthetic. No local vault, network, or native App is opened.
const vault = createConnectionVault(crypto.webcrypto);
const context = () => ({ serverOrigin: 'https://sync.example.test', accountId: 'account_fixture', profileId: 'profile_fixture', epoch: 2, version: 7 });
const profile = () => ({ format: 'aibro.connection-profile.v1', purpose: 'chat', provider: 'openai-compatible',
  authKind: 'api-key', apiFormat: 'chat-completions', baseUrl: 'https://private-provider.example.test/v1',
  model: 'synthetic-unique-model-047', apiKey: 'synthetic-not-a-real-key-5cb04d827167' });
const b64 = value => Buffer.from(value).toString('base64url');
const bytes = value => Buffer.from(value, 'base64url');
function flip(value) { const buffer = bytes(value); buffer[0] ^= 1; return b64(buffer); }
function aadProfile(binding) { return Buffer.from(JSON.stringify(['aibro.connection-profile-sealed.v1', 'A256GCM', binding])); }
function aadWrap(binding, sender, recipient) {
  return Buffer.from(JSON.stringify(['aibro.connection-key-wrap.v1', 'P256-HKDF-SHA256-A256GCM', binding, sender, recipient]));
}
function nodeDecrypt(key, envelope, aad) {
  const encrypted = bytes(envelope.ciphertext);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes(envelope.nonce));
  decipher.setAAD(aad); decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
}
function independentlySeal(clear, key, binding) {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aadProfile(binding));
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
  return { format: 'aibro.connection-profile-sealed.v1', suite: 'A256GCM', context: binding, nonce: b64(nonce), ciphertext: b64(encrypted) };
}
async function fixture() {
  const sender = await vault.generateDeviceKeyPair(), recipient = await vault.generateDeviceKeyPair();
  const key = vault.generateConfigurationKey(), binding = context();
  const envelope = await vault.wrapConfigurationKey({ configurationKey: key, senderPrivateJwk: sender.privateJwk,
    recipientPublicJwk: recipient.publicJwk, context: binding });
  return { sender, recipient, key, binding, envelope };
}

test('RFC 7638 fingerprint canonicalizes key ordering and validates the curve point', async () => {
  const device = await vault.generateDeviceKeyPair();
  const { crv, kty, x, y } = device.publicJwk;
  const independent = crypto.createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest('base64url');
  assert.equal(device.fingerprint, independent);
  assert.equal(await vault.fingerprintPublicKey({ y, x, kty, crv, key_ops: [], ext: true }), independent);
  assert.equal(device.fingerprint.length, 43);
  assert.equal(Object.hasOwn(device.publicJwk, 'd'), false);
  assert.equal(bytes(device.privateJwk.d).length, 32);
  assert.notEqual((await vault.generateDeviceKeyPair()).fingerprint, device.fingerprint);
  await assert.rejects(vault.fingerprintPublicKey({ ...device.publicJwk, x: b64(Buffer.alloc(32)), y: b64(Buffer.alloc(32)) }), { code: 'INVALID_KEY' });
  await assert.rejects(vault.fingerprintPublicKey(device.privateJwk), { code: 'INVALID_SCHEMA' });
});

test('device key wrapping roundtrip also agrees with independent Node ECDH, HKDF and GCM', async () => {
  const f = await fixture();
  const unwrapped = await vault.unwrapConfigurationKey({ envelope: f.envelope, recipientPrivateJwk: f.recipient.privateJwk,
    trustedSenderPublicJwk: f.sender.publicJwk, expectedContext: f.binding });
  assert.deepEqual(unwrapped, f.key);
  const shared = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: f.recipient.privateJwk, format: 'jwk' }),
    publicKey: crypto.createPublicKey({ key: f.sender.publicJwk, format: 'jwk' })
  });
  const aad = aadWrap(f.binding, f.sender.fingerprint, f.recipient.fingerprint);
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, bytes(f.envelope.salt), aad, 32));
  assert.deepEqual(nodeDecrypt(key, f.envelope, aad), Buffer.from(f.key));
  assert.equal(bytes(f.envelope.salt).length, 32);
  assert.equal(bytes(f.envelope.nonce).length, 12);
  assert.equal(bytes(f.envelope.ciphertext).length, 48);
  assert.equal(JSON.stringify(f.envelope).includes(f.sender.privateJwk.d), false);
  assert.equal(JSON.stringify(f.envelope).includes(f.recipient.privateJwk.d), false);
  assert.equal(JSON.stringify(f.envelope).includes(b64(f.key)), false);
});

test('only the approved sender and intended recipient can unwrap the configuration key', async () => {
  const f = await fixture(), stranger = await vault.generateDeviceKeyPair();
  const options = { envelope: f.envelope, recipientPrivateJwk: f.recipient.privateJwk,
    trustedSenderPublicJwk: f.sender.publicJwk, expectedContext: f.binding };
  await assert.rejects(vault.unwrapConfigurationKey({ ...options, trustedSenderPublicJwk: stranger.publicJwk }), { code: 'DEVICE_MISMATCH' });
  await assert.rejects(vault.unwrapConfigurationKey({ ...options, recipientPrivateJwk: stranger.privateJwk }), { code: 'DEVICE_MISMATCH' });
  await assert.rejects(vault.unwrapConfigurationKey({ ...options, trustedSenderPublicJwk: undefined }), { code: 'INVALID_SCHEMA' });
  // Editing the fingerprints cannot turn an untrusted sender into the already paired sender.
  const substituted = { ...f.envelope, senderFingerprint: stranger.fingerprint };
  await assert.rejects(vault.unwrapConfigurationKey({ ...options, envelope: substituted, trustedSenderPublicJwk: stranger.publicJwk }), { code: 'AUTHENTICATION_FAILED' });
});

test('all implemented purpose/provider/format combinations encrypt the entire profile', async () => {
  const cases = [
    ['chat', 'openai-compatible', 'chat-completions'], ['chat', 'openai-compatible', 'responses'],
    ['embedding', 'openai-compatible', 'embeddings'], ['speech', 'openai-compatible', 'audio-transcriptions'],
    ['chat', 'anthropic-api', 'anthropic-messages'], ['speech', 'aliyun', 'aliyun-multimodal']
  ];
  for (const [purpose, provider, apiFormat] of cases) {
    const original = { ...profile(), purpose, provider, apiFormat };
    const key = vault.generateConfigurationKey(), binding = context();
    const envelope = await vault.encryptProfile({ profile: original, configurationKey: key, context: binding });
    const restored = await vault.decryptProfile({ envelope, configurationKey: key, expectedContext: binding });
    assert.deepEqual(restored, original);
    assert.deepEqual(JSON.parse(nodeDecrypt(key, envelope, aadProfile(binding)).toString('utf8')), original);
    assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'context', 'format', 'nonce', 'suite']);
    const serialized = JSON.stringify(envelope);
    for (const secretValue of [original.baseUrl, original.apiKey, original.model]) assert.equal(serialized.includes(secretValue), false);
    for (const field of ['provider', 'apiKey', 'model', 'baseUrl', 'purpose', 'authKind']) assert.equal(Object.hasOwn(envelope, field), false);
  }
});

test('speech language survives authenticated encryption and remains optional and purpose-scoped', async () => {
  for (const provider of ['aliyun', 'openai-compatible']) {
    const speech = { ...profile(), purpose: 'speech', provider,
      apiFormat: provider === 'aliyun' ? 'aliyun-multimodal' : 'audio-transcriptions' };
    assert.equal(Object.hasOwn(normalizeProfile(speech), 'language'), false);
    for (const language of ['', 'zh', 'en-US']) {
      const original = { ...speech, language }, key = vault.generateConfigurationKey(), binding = context();
      const envelope = await vault.encryptProfile({ profile: original, configurationKey: key, context: binding });
      assert.deepEqual(await vault.decryptProfile({ envelope, configurationKey: key, expectedContext: binding }), original);
      assert.equal(Object.hasOwn(envelope, 'language'), false);
    }
    for (const language of [null, [], {}, 1, ' zh', 'zh ', 'zh\n', 'zh\0', '中文', 'en_US', 'a'.repeat(17)]) {
      assert.throws(() => normalizeProfile({ ...speech, language }), { code: 'INVALID_SCHEMA' });
    }
  }
  for (const purpose of ['chat', 'embedding']) {
    assert.throws(() => normalizeProfile({ ...profile(), purpose, apiFormat: purpose === 'chat' ? 'chat-completions' : 'embeddings', language: '' }), { code: 'INVALID_SCHEMA' });
  }
  for (const patch of [{ purpose: 'chat', apiFormat: 'chat-completions' }, { purpose: 'embedding', apiFormat: 'embeddings' },
    { purpose: 'speech', apiFormat: 'audio-transcriptions' }, { purpose: 'speech', apiFormat: 'qwen-asr-chat' }]) {
    assert.throws(() => normalizeProfile({ ...profile(), provider: 'aliyun', ...patch }), { code: 'INVALID_SCHEMA' });
  }
});

test('fresh profile and wrap encryptions use independently random nonces and salts', async () => {
  const f = await fixture(), nonces = new Set(), salts = new Set();
  for (let n = 0; n < 24; n++) {
    const sealed = await vault.encryptProfile({ profile: profile(), configurationKey: f.key, context: f.binding });
    assert.equal(bytes(sealed.nonce).length, 12); assert.equal(nonces.has(sealed.nonce), false); nonces.add(sealed.nonce);
    const wrapped = await vault.wrapConfigurationKey({ configurationKey: f.key, senderPrivateJwk: f.sender.privateJwk,
      recipientPublicJwk: f.recipient.publicJwk, context: f.binding });
    assert.equal(nonces.has(wrapped.nonce), false); nonces.add(wrapped.nonce);
    assert.equal(salts.has(wrapped.salt), false); salts.add(wrapped.salt);
  }
});

for (const [field, changed] of [['serverOrigin', 'https://other-sync.example.test'], ['accountId', 'other_account'],
  ['profileId', 'other_profile'], ['epoch', 3], ['version', 8]]) {
  test(`profile and wrapped key authenticate ${field}, including edited external metadata`, async () => {
    const f = await fixture(), other = { ...f.binding, [field]: changed };
    const envelope = await vault.encryptProfile({ profile: profile(), configurationKey: f.key, context: f.binding });
    await assert.rejects(vault.decryptProfile({ envelope, configurationKey: f.key, expectedContext: other }), { code: 'CONTEXT_MISMATCH' });
    await assert.rejects(vault.decryptProfile({ envelope: { ...envelope, context: other }, configurationKey: f.key, expectedContext: other }), { code: 'AUTHENTICATION_FAILED' });
    const unwrap = { recipientPrivateJwk: f.recipient.privateJwk, trustedSenderPublicJwk: f.sender.publicJwk, expectedContext: other };
    await assert.rejects(vault.unwrapConfigurationKey({ ...unwrap, envelope: f.envelope }), { code: 'CONTEXT_MISMATCH' });
    await assert.rejects(vault.unwrapConfigurationKey({ ...unwrap, envelope: { ...f.envelope, context: other } }), { code: 'AUTHENTICATION_FAILED' });
  });
}

test('tampering with ciphertext, nonce or HKDF salt fails authentication', async () => {
  const f = await fixture();
  const envelope = await vault.encryptProfile({ profile: profile(), configurationKey: f.key, context: f.binding });
  for (const field of ['ciphertext', 'nonce']) await assert.rejects(vault.decryptProfile({
    envelope: { ...envelope, [field]: flip(envelope[field]) }, configurationKey: f.key, expectedContext: f.binding
  }), { code: 'AUTHENTICATION_FAILED' });
  await assert.rejects(vault.decryptProfile({ envelope, configurationKey: vault.generateConfigurationKey(), expectedContext: f.binding }), { code: 'AUTHENTICATION_FAILED' });
  for (const field of ['ciphertext', 'nonce', 'salt']) await assert.rejects(vault.unwrapConfigurationKey({
    envelope: { ...f.envelope, [field]: flip(f.envelope[field]) }, recipientPrivateJwk: f.recipient.privateJwk,
    trustedSenderPublicJwk: f.sender.publicJwk, expectedContext: f.binding
  }), { code: 'AUTHENTICATION_FAILED' });
});

test('rejects unknown profiles, subscription credentials, cookie bundles and invalid API combinations', () => {
  const bad = [
    { format: 'aibro.connection-profile.v2' }, { provider: 'claude-subscription' }, { provider: 'unknown' },
    { provider: {} }, { purpose: 'ucas' }, { purpose: [] }, { authKind: 'oauth' }, { authKind: 'browser-cookie' },
    { apiFormat: 'future' }, { purpose: 'embedding' }, { purpose: 'speech', apiFormat: 'chat-completions' },
    { provider: 'anthropic-api', apiFormat: 'responses' }, { provider: 'anthropic-api', purpose: 'embedding', apiFormat: 'embeddings' },
    { refreshToken: 'synthetic-refresh' }, { cookie: 'session=fake' }, { headers: { Authorization: 'synthetic' } },
    { apiKey: 'sk-ant-oat01-synthetic' }, { apiKey: 'sk-ant-ort01-synthetic' }, { apiKey: 'sk-ant-sid01-synthetic' },
    { apiKey: 'sessionKey=synthetic' }, { apiKey: 'session=synthetic' }, { apiKey: '__Secure-session=synthetic' },
    { apiKey: 'session=synthetic; other=synthetic' }, { apiKey: 'Bearer synthetic' },
    { apiKey: '{"token":"synthetic"}' }, { apiKey: 'synthetic\nheader' }, { apiKey: '' },
    { model: ' ' }, { model: ' trailing ' }, { apiKey: 'a'.repeat(LIMITS.apiKeyBytes + 1) }, { model: '界'.repeat(100) },
    { baseUrl: 'http://insecure.example.test/v1' }, { baseUrl: 'https://user:password@example.test/v1' },
    { baseUrl: 'https://api.example.test/v1?key=synthetic' }, { baseUrl: 'https://api.example.test/v1#secret' },
    { baseUrl: 'https://api.example.test/v1?' }, { baseUrl: 'https://api.example.test/v1#' },
    { baseUrl: 'file:///tmp/key' }
  ];
  for (const patch of bad) assert.throws(() => normalizeProfile({ ...profile(), ...patch }), { code: 'INVALID_SCHEMA' });
  assert.throws(() => normalizeProfile({ ...profile(), apiKey: '"'.repeat(13000) }), { code: 'INVALID_SCHEMA' });
});

test('strict context and JWK schema reject unbounded, noncanonical and ambiguous input', async () => {
  const badContext = [{ version: 0 }, { epoch: -1 }, { version: 1.5 }, { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { accountId: '../account' }, { profileId: '' }, { accountId: 'a'.repeat(129) }, { extra: true },
    { serverOrigin: 'https://sync.example.test/path' }, { serverOrigin: 'http://sync.example.test' },
    { serverOrigin: 'https://sync.example.test?key=x' }, { serverOrigin: 'https://sync.example.test/#x' }];
  for (const patch of badContext) assert.throws(() => normalizeContext({ ...context(), ...patch }), { code: 'INVALID_SCHEMA' });
  assert.deepEqual(normalizeContext({ ...context(), serverOrigin: 'https://SYNC.example.test:443/' }), context());
  assert.equal(normalizeProfile({ ...profile(), baseUrl: 'http://127.0.0.1:1234/v1/' }).baseUrl, 'http://127.0.0.1:1234/v1');
  const device = await vault.generateDeviceKeyPair();
  for (const patch of [{ crv: 'P-384' }, { kty: 'RSA' }, { x: device.publicJwk.x + '=' },
    { y: 'a'.repeat(100000) }, { ext: false }, { key_ops: ['encrypt'] }, { kid: 'untrusted' }]) {
    await assert.rejects(vault.fingerprintPublicKey({ ...device.publicJwk, ...patch }));
  }
  const accessor = { ...profile() };
  Object.defineProperty(accessor, 'apiKey', { enumerable: true, get() { assert.fail('must not evaluate input accessor'); } });
  assert.throws(() => normalizeProfile(accessor), { code: 'INVALID_SCHEMA' });
  assert.throws(() => normalizeProfile(Object.assign(Object.create({ injected: true }), profile())), { code: 'INVALID_SCHEMA' });
});

test('strict envelope size, encoding and fields reject hidden plaintext or unsupported formats', async () => {
  const key = vault.generateConfigurationKey(), binding = context();
  const envelope = await vault.encryptProfile({ profile: profile(), configurationKey: key, context: binding });
  for (const patch of [{ apiKey: profile().apiKey }, { format: 'future' }, { suite: 'AES-CBC' },
    { nonce: b64(Buffer.alloc(11)) }, { nonce: envelope.nonce + '=' }, { ciphertext: b64(Buffer.alloc(16)) },
    { ciphertext: 'a'.repeat((LIMITS.profileBytes + 16) * 2) }, { ciphertext: envelope.ciphertext + '\n' }]) {
    await assert.rejects(vault.decryptProfile({ envelope: { ...envelope, ...patch }, configurationKey: key, expectedContext: binding }), { code: 'INVALID_SCHEMA' });
  }
  for (const invalid of [new Uint8Array(31), new Uint8Array(33), [1, 2, 3], b64(key)]) {
    await assert.rejects(vault.encryptProfile({ profile: profile(), configurationKey: invalid, context: binding }), { code: 'INVALID_KEY' });
  }
});

test('key-wrap schema refuses extra key material, future suites and malformed encodings', async () => {
  const f = await fixture();
  const options = { recipientPrivateJwk: f.recipient.privateJwk, trustedSenderPublicJwk: f.sender.publicJwk, expectedContext: f.binding };
  for (const patch of [{ privateJwk: f.sender.privateJwk }, { format: 'future' }, { suite: 'ECDH-only' },
    { salt: b64(Buffer.alloc(31)) }, { nonce: b64(Buffer.alloc(13)) }, { ciphertext: b64(Buffer.alloc(47)) },
    { ciphertext: f.envelope.ciphertext + '=' }, { senderFingerprint: 'a'.repeat(1000) }, { recipientFingerprint: '' }]) {
    await assert.rejects(vault.unwrapConfigurationKey({ ...options, envelope: { ...f.envelope, ...patch } }), { code: 'INVALID_SCHEMA' });
  }
  const incomplete = { ...f.envelope }; delete incomplete.context;
  await assert.rejects(vault.unwrapConfigurationKey({ ...options, envelope: incomplete }), { code: 'INVALID_SCHEMA' });
});

test('authenticated plaintext still must satisfy profile schema and UTF-8, without echoing its content', async () => {
  const key = vault.generateConfigurationKey(), binding = context();
  for (const clear of [Buffer.from('{"cookie":"synthetic-sensitive-cookie"}'),
    Buffer.from(JSON.stringify({ ...profile(), authKind: 'oauth' })), Buffer.from([0xff, 0x80, 0x20]), Buffer.from('not json')]) {
    await assert.rejects(vault.decryptProfile({ envelope: independentlySeal(clear, key, binding), configurationKey: key, expectedContext: binding }), error => {
      assert.equal(error.code, 'INVALID_SCHEMA');
      assert.doesNotMatch(error.message, /synthetic|cookie|token|not json/); return true;
    });
  }
});

test('asynchronous encryption snapshots caller data and does not mutate caller keys or profiles', async () => {
  const key = vault.generateConfigurationKey(), keyBefore = new Uint8Array(key), original = profile(), binding = context();
  const task = vault.encryptProfile({ profile: original, configurationKey: key, context: binding });
  original.model = 'changed-after-call'; binding.accountId = 'changed_after_call'; key.fill(0);
  const envelope = await task;
  assert.deepEqual(await vault.decryptProfile({ envelope, configurationKey: keyBefore, expectedContext: context() }), profile());
  const stableKey = vault.generateConfigurationKey(), copy = new Uint8Array(stableKey), stableProfile = Object.freeze(profile());
  await vault.encryptProfile({ profile: stableProfile, configurationKey: stableKey, context: Object.freeze(context()) });
  assert.deepEqual(stableKey, copy); assert.deepEqual(stableProfile, profile());
});

test('missing WebCrypto fails closed with no storage or insecure cipher fallback', () => {
  for (const missing of [null, {}, { subtle: {} }, { subtle: {}, getRandomValues() {} }]) {
    assert.throws(() => createConnectionVault(missing), { code: 'CRYPTO_UNAVAILABLE' });
  }
});
