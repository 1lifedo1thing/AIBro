'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, identity } = require('../app/local-document-draft-store.js');
const ref = { projectId: 'project-a', candidateId: 'candidate-a', path: 'notes/中文.md' };
const session = (content = '\ufeff# exact\r\n中文 🌱\rline\n') => ({ ...ref, id: identity(ref), version: 'a'.repeat(64), baseContent: '\ufeff# base\r\n', content, mode: 'edit' });
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(extra = {}) {
  let record = { revision: 0, session: null, updatedAt: null, ...extra }, lost = false;
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (options.method !== 'POST') return clone(record);
    const payload = JSON.parse(options.body);
    if (payload.revision !== record.revision) throw Object.assign(Error('conflict'), { code: 'draft_conflict' });
    record = { revision: record.revision + 1, session: payload.session, updatedAt: Date.now(), ...extra };
    if (lost) { lost = false; throw Error('response lost after fsync'); }
    return clone(record);
  };
  return { request, calls, read: () => clone(record), replace: value => { record = clone(value); }, loseAck: () => { lost = true; } };
}
function client(server, onStatus = () => {}) { return create({ ref, request: server.request, onStatus, delay: 1_000_000 }); }

test('routes each exact document, strips runtime extras and preserves full raw recovery content', async () => {
  const server = fixture(), store = client(server);
  await store.load();
  const value = { ...session(), recoveryContent: '\r\nconflicting complete original\r\n', retainedDraft: true, scroll: { top: 81.5, left: 0 }, selection: { start: 2, end: 4, direction: 'backward' } };
  store.schedule({ ...value, editor: { fakeDOM: true } });
  assert.equal(await store.flush(), true);
  assert.deepEqual(server.read().session, value);
  assert.ok(server.calls.every(call => call.url === '/__local-document-draft?id=' + encodeURIComponent(identity(ref))));
  const reopened = client(server); assert.deepEqual((await reopened.load()).session, value);
  assert.equal(reopened.getStatus().state, 'saved');
  store.dispose(); reopened.dispose();
});

test('content larger than disk apply limit is never silently truncated in transport', async () => {
  const server = fixture(), store = client(server); await store.load();
  const value = session('中'.repeat(1_500_000)); store.schedule(value);
  assert.equal(await store.flush(), true); assert.equal(server.read().session.content, value.content);
  store.dispose();
});

test('stale window conflict preserves its pending text and cannot overwrite acknowledged winner', async () => {
  const server = fixture(), first = client(server), second = client(server);
  await first.load(); await second.load();
  first.schedule(session('first')); assert.equal(await first.flush(), true);
  second.schedule(session('second')); assert.equal(await second.flush(), false);
  assert.equal(second.getStatus().state, 'conflict'); assert.equal(second.hasPending(), true);
  assert.equal(await second.flush({ retry: true }), false); assert.equal(server.read().session.content, 'first');
  first.dispose(); second.dispose();
});

test('lost acknowledgement reconciles identical fsynced revision without replaying writes', async () => {
  const server = fixture(), store = client(server); await store.load(); server.loseAck();
  store.schedule(session()); assert.equal(await store.flush(), true);
  assert.equal(store.revision(), 1); assert.equal(server.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(store.hasPending(), false); store.dispose();
});

test('clear queued behind an inflight write is durable and late write cannot resurrect it', async () => {
  const server = fixture(), gate = deferred(), entered = deferred(); let pause = true;
  const store = create({ ref, delay: 1_000_000, request: async (...args) => {
    if (args[1].method === 'POST' && pause) { pause = false; entered.resolve(); await gate.promise; }
    return server.request(...args);
  } });
  await store.load(); store.schedule(session('old')); const save = store.flush(); await entered.promise;
  const clear = store.clear(); gate.resolve();
  assert.equal(await save, true); assert.equal(await clear, true);
  assert.equal(server.read().revision, 2); assert.equal(server.read().session, null);
  assert.equal(store.hasPending(), false); store.dispose();
});

test('typing while initial read is delayed cannot be erased by stale load adoption', async () => {
  const server = fixture(), gate = deferred(), entered = deferred(); let once = true;
  const store = create({ ref, delay: 1_000_000, request: async (...args) => {
    if (once) { once = false; entered.resolve(); await gate.promise; }
    return server.request(...args);
  } });
  const load = store.load(); await entered.promise; store.schedule(session('typed during load')); gate.resolve();
  await assert.rejects(load, /input changed/); assert.equal(store.hasPending(), true);
  assert.equal(await store.flush({ retry: true }), true); assert.equal(server.read().session.content, 'typed during load');
  store.dispose();
});

test('failed explicit reload never drops pending text', async () => {
  const server = fixture(); let fail = false;
  const store = create({ ref, delay: 1_000_000, request: (...args) => {
    if (fail && args[1].method !== 'POST') return Promise.reject(Error('offline'));
    return server.request(...args);
  } });
  await store.load(); store.schedule(session('unsaved')); fail = true;
  await assert.rejects(store.reload(), /offline/); assert.equal(store.hasPending(), true);
  fail = false; assert.equal(await store.flush({ retry: true }), true); assert.equal(server.read().session.content, 'unsaved');
  store.dispose();
});

test('a saved disconnected draft stays recoverable and status does not claim disk save', async () => {
  const server = fixture({ recoveryOnly: true, unavailable: 'disconnected' });
  server.replace({ revision: 1, session: session('recover me'), updatedAt: 1, recoveryOnly: true, unavailable: 'disconnected' });
  const store = client(server); const value = await store.load();
  assert.equal(value.session.content, 'recover me'); assert.equal(store.getStatus().recoveryOnly, true);
  store.schedule(session('recovery still editable')); assert.equal(await store.flush(), true);
  assert.equal(store.getStatus().unavailable, 'disconnected'); store.dispose();
});

test('dispose suppresses late status and further queued writes from old view lifetime', async () => {
  const server = fixture(), gate = deferred(), entered = deferred(); const statuses = [];
  const store = create({ ref, delay: 1_000_000, onStatus: value => statuses.push(value), request: async (...args) => {
    if (args[1].method === 'POST') { entered.resolve(); await gate.promise; }
    return server.request(...args);
  } });
  await store.load(); store.schedule(session('already dispatched')); const saving = store.flush(); await entered.promise;
  store.schedule(session('must not dispatch after disposal')); store.dispose(); const count = statuses.length;
  gate.resolve(); assert.equal(await saving, false);
  assert.equal(statuses.length, count); assert.equal(server.read().session.content, 'already dispatched');
  assert.equal(server.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('private blocked read does not expose or overwrite a retained private record', async () => {
  const server = fixture(); let privateScope = false;
  const store = create({ ref, delay: 1_000_000, request: (...args) => {
    if (privateScope && args[1].method !== 'POST') return Promise.resolve({ revision: 1, session: null, updatedAt: 1, blocked: 'private' });
    if (privateScope && args[1].method === 'POST' && JSON.parse(args[1].body).session) return Promise.reject(Object.assign(Error('private'), { code: 'draft_private' }));
    return server.request(...args);
  } });
  await store.load(); store.schedule(session('public before privacy')); await store.flush(); privateScope = true;
  assert.equal((await store.reload()).session, null); assert.equal(store.getStatus().blocked, 'private');
  store.schedule(session('private input')); assert.equal(await store.flush({ retry: true }), false);
  assert.equal(server.read().session.content, 'public before privacy'); assert.equal(store.hasPending(), true);
  assert.equal(await store.clear(), true); assert.equal(server.read().session, null); store.dispose();
});

test('mismatched document identities are rejected before scheduling', async () => {
  const server = fixture(), store = client(server); await store.load();
  assert.throws(() => store.schedule({ ...session(), path: 'other.md' }), /different document/);
  assert.equal(store.hasPending(), false); store.dispose();
});
