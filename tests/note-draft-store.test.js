const test = require('node:test'), assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { create } = require('../app/note-draft-store.js');
const Editor = require('../app/note-editor.js');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const note = { id: 'note /?中文', title: 'Original', content: 'Body', updatedAt: 1, workspace: '日常' };
const session = content => ({ ...Editor.begin({ notes: [note] }, note.id), content });
function fixture(options = {}) {
  let disk = options.disk || { revision: 0, session: null }, failure = '', readGate, writeGate, reads = 0;
  const posts = [], routes = [], statuses = [];
  const request = async (route, opts) => {
    routes.push(route);
    if (opts.method !== 'POST') {
      reads++;
      const gate = readGate; readGate = null; if (gate) await gate.promise;
      if (failure === 'offline') throw Error('offline');
      return copy(disk);
    }
    const body = JSON.parse(opts.body); posts.push(body);
    const gate = writeGate; writeGate = null; if (gate) await gate.promise;
    if (failure === 'offline' || failure === 'disk-full') throw Error(failure);
    if (body.revision !== disk.revision) throw Object.assign(Error('another window updated this draft'), { code: 'draft_conflict' });
    disk = { revision: disk.revision + 1, session: body.session, updatedAt: Date.now() };
    if (failure === 'lost-reply') { failure = ''; throw Error('reply was lost'); }
    return copy(disk);
  };
  const store = create({ id: note.id, request, crypto: webcrypto, delay: 99999, onStatus: state => statuses.push(state), ...options.store });
  return { store, request, posts, routes, statuses, disk: () => copy(disk), reads: () => reads,
    set: value => { disk = value; }, fail: value => { failure = value; },
    blockRead: () => { readGate = deferred(); return readGate; }, blockWrite: () => { writeGate = deferred(); return writeGate; } };
}
function delayedCrypto() {
  const gates = [], inputs = [];
  return { gates, inputs, crypto: { subtle: { digest: (name, data) => { const gate = deferred(); gates.push(gate); inputs.push(new TextDecoder().decode(data)); return gate.promise.then(() => webcrypto.subtle.digest(name, data)); } } } };
}
test('persists per-note draft fields with a SHA-256 base and hydrates only the exact current note', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); await f.store.load();
  const edit = { ...session('Changed'), secret: 'discard this field', folderPath: 'Research', appliedAiDraft: '{"content":"AI"}', retainedDraft: true };
  f.store.schedule(edit); assert.equal(await f.store.flush(), true);
  assert.equal(f.disk().session.secret, undefined); assert.match(f.disk().session.base, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(f.disk().session.base, edit.base); assert.equal(edit.base, session('Changed').base);
  assert.ok(f.routes.every(route => route === '/__note-draft?id=' + encodeURIComponent(note.id)));
  assert.equal((await f.store.hydrate(f.disk().session, edit.base)).base, edit.base);
  const newer = { ...note, updatedAt: 2 };
  const conflicted = await f.store.hydrate(f.disk().session, Editor.begin({ notes: [newer] }, note.id).base);
  assert.match(conflicted.base, /^sha256:/); assert.throws(() => Editor.prepare({ notes: [newer] }, conflicted), /其他操作修改/);
});
test('same base is hashed once across edits and hydration; already hashed bases are preserved', async t => {
  let hashes = 0;
  const f = fixture({ store: { crypto: { subtle: { digest: (...args) => { hashes++; return webcrypto.subtle.digest(...args); } } } } });
  t.after(() => f.store.dispose()); await f.store.load();
  f.store.schedule(session('one')); await f.store.flush(); f.store.schedule(session('two')); await f.store.flush();
  const stored = f.disk().session; await f.store.hydrate(stored, session('').base);
  f.store.schedule({ ...stored, content: 'three' }); await f.store.flush();
  assert.equal(hashes, 1); assert.equal(f.disk().session.base, stored.base);
});
test('encoding coalesces newer input without dispatching or acknowledging an obsolete snapshot', async t => {
  const crypto = delayedCrypto(), f = fixture({ store: { crypto: crypto.crypto } }); t.after(() => f.store.dispose());
  await f.store.load(); f.store.schedule(session('one')); const flushing = f.store.flush(); await tick();
  f.store.schedule(session('latest')); assert.equal(f.posts.length, 0); assert.equal(f.store.getStatus().state, 'saving');
  crypto.gates[0].resolve(); assert.equal(await flushing, true);
  assert.equal(f.posts.length, 1); assert.equal(f.disk().session.content, 'latest'); assert.equal(crypto.gates.length, 1);
});
test('clear during encoding invalidates the encoded write and awaits a real tombstone acknowledgement', async t => {
  const crypto = delayedCrypto(), f = fixture({ store: { crypto: crypto.crypto } }); t.after(() => f.store.dispose());
  await f.store.load(); f.store.schedule(session('never dispatch')); const flushing = f.store.flush(); await tick();
  const clear = f.store.clear();
  assert.equal(await clear, true); assert.equal(await flushing, true);
  assert.deepEqual(f.posts.map(post => post.session), [null]); assert.equal(f.disk().revision, 1);
  crypto.gates[0].resolve(); await tick(); assert.equal(f.posts.length, 1);
});
test('clear waits for an already dispatched write then uses its acknowledged revision', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); await f.store.load(); const gate = f.blockWrite();
  f.store.schedule(session('first')); const writing = f.store.flush();
  while (!f.posts.length) await tick(); const cleared = f.store.clear(); assert.equal(f.posts.length, 1); gate.resolve();
  assert.deepEqual(await Promise.all([writing, cleared]), [true, true]);
  assert.deepEqual(f.posts.map(post => [post.revision, post.session?.content ?? null]), [[0, 'first'], [1, null]]);
});
test('a newer input after clear wins and an older acknowledgement cannot show it as saved', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); await f.store.load();
  f.store.schedule(session('old')); await f.store.flush(); const gate = f.blockWrite();
  const clearing = f.store.clear(); while (f.posts.length < 2) await tick();
  f.store.schedule(session('new after clear')); const states = f.statuses.length; gate.resolve();
  await clearing; assert.equal(f.disk().session.content, 'new after clear');
  assert.ok(f.statuses.slice(states, -1).every(status => status.state !== 'idle' && status.state !== 'saved'));
});
test('lost replies reconcile through the existing CAS transport without replaying writes', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); await f.store.load(); f.fail('lost-reply');
  f.store.schedule(session('committed')); assert.equal(await f.store.flush(), true);
  assert.equal(f.posts.length, 1); assert.equal(f.disk().revision, 1); assert.equal(f.store.hasPending(), false);
});
test('two windows conflict, failed reload retains input, and only explicit successful reload adopts the other draft', async t => {
  const f = fixture(), other = create({ id: note.id, request: f.request, crypto: webcrypto, delay: 99999 });
  t.after(() => { f.store.dispose(); other.dispose(); }); await f.store.load(); await other.load();
  other.schedule(session('other')); await other.flush(); f.store.schedule(session('mine')); assert.equal(await f.store.flush(), false);
  assert.equal(f.store.getStatus().state, 'conflict'); assert.equal(await f.store.clear(), false); assert.equal(f.disk().session.content, 'other');
  f.fail('offline'); await assert.rejects(f.store.reload(), /offline/); assert.equal(f.store.hasPending(), true);
  f.fail(''); const restored = await f.store.reload(); assert.equal(restored.session.content, 'other'); assert.equal(f.store.hasPending(), false);
  assert.equal(f.store.getStatus().state, 'saved');
});
test('failed initial reads cannot authorize overwriting an existing draft', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); f.fail('offline'); await assert.rejects(f.store.load(), /offline/);
  f.store.schedule(session('new')); f.set({ revision: 8, session: session('saved earlier') }); f.fail('');
  assert.equal(await f.store.flush({ retry: true }), false); assert.equal(f.posts.length, 0);
  assert.equal(f.store.getStatus().state, 'conflict'); assert.equal(f.store.hasPending(), true);
});
test('a repeated ordinary load cannot replace previously typed pending input', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); await f.store.load(); f.store.schedule(session('pending'));
  await assert.rejects(f.store.load(), /pending input/); assert.equal(f.store.hasPending(), true);
  assert.equal(await f.store.flush({ retry: true }), true); assert.equal(f.disk().session.content, 'pending');
});
test('private drafts stay unavailable to new writes and can only be explicitly cleared', async t => {
  const f = fixture({ disk: { revision: 7, session: null, blocked: 'private' } }); t.after(() => f.store.dispose());
  const loaded = await f.store.load(); assert.equal(loaded.blocked, 'private');
  f.store.schedule(session('must stay in memory')); assert.equal(await f.store.flush({ retry: true }), false);
  assert.equal(f.posts.length, 0); assert.equal(f.store.getStatus().state, 'unavailable');
  assert.equal(await f.store.clear(), true); assert.equal(f.disk().revision, 8);
});
test('a delayed read cannot replace typed input or clear its pending save', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); const gate = f.blockRead(); const loading = f.store.load();
  f.store.schedule(session('typed during loading')); gate.resolve(); await assert.rejects(loading, /input changed/);
  assert.equal(f.store.hasPending(), true); assert.equal(await f.store.flush({ retry: true }), true); assert.equal(f.disk().session.content, 'typed during loading');
});
test('late initial read containing a previous draft requires conflict resolution, never silent overwrite', async t => {
  const f = fixture({ disk: { revision: 5, session: session('previous') } }); t.after(() => f.store.dispose());
  const gate = f.blockRead(); const loading = f.store.load(); f.store.schedule(session('typed now')); gate.resolve();
  await assert.rejects(loading, /input changed/); assert.equal(await f.store.flush({ retry: true }), false);
  assert.equal(f.posts.length, 0); assert.equal(f.disk().session.content, 'previous');
});
test('parallel reads and retries remain single flight without late redundant writes', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); const gate = f.blockRead();
  const first = f.store.load(), second = f.store.load(); assert.equal(f.reads(), 1); gate.resolve(); await Promise.all([first, second]);
  const writeGate = f.blockWrite(); f.fail('disk-full'); f.store.schedule(session('first'));
  const failed = f.store.flush(); while (!f.posts.length) await tick();
  const retryA = f.store.flush({ retry: true }), retryB = f.store.flush({ retry: true });
  writeGate.resolve(); assert.equal(await failed, false); f.fail('');
  await Promise.all([retryA, retryB]);
  if (f.store.hasPending()) await f.store.flush({ retry: true });
  f.store.schedule(session('later')); assert.equal(await f.store.flush(), true);
  assert.equal(f.disk().session.content, 'later'); assert.equal(f.posts.filter(post => post.session.content === 'later').length, 1);
  assert.equal(f.store.hasPending(), false);
});
test('failed encoding retains latest input for retry and never sends raw version history', async t => {
  let fail = true;
  const f = fixture({ store: { crypto: { subtle: { digest: (...args) => fail ? Promise.reject(Error('hash unavailable')) : webcrypto.subtle.digest(...args) } } } });
  t.after(() => f.store.dispose()); await f.store.load(); f.store.schedule(session('keep me'));
  assert.equal(await f.store.flush(), false); assert.equal(f.store.getStatus().state, 'error'); assert.equal(f.posts.length, 0);
  f.store.schedule(session('latest too')); fail = false; assert.equal(await f.store.flush({ retry: true }), true);
  assert.equal(f.disk().session.content, 'latest too'); assert.match(f.disk().session.base, /^sha256:/);
});
test('clear failure stays pending and can be retried without reviving old encoded input', async t => {
  const f = fixture(); t.after(() => f.store.dispose()); await f.store.load(); f.store.schedule(session('old')); await f.store.flush();
  f.fail('disk-full'); assert.equal(await f.store.clear(), false); assert.equal(f.store.hasPending(), true);
  f.fail(''); assert.equal(await f.store.flush({ retry: true }), true); assert.equal(f.disk().session, null);
});
test('dispose cancels undispatched encoding and suppresses late status callbacks', async () => {
  const crypto = delayedCrypto(), f = fixture({ store: { crypto: crypto.crypto } });
  await f.store.load(); f.store.schedule(session('never sent')); const flushing = f.store.flush(); await tick(); f.store.dispose();
  const count = f.statuses.length; crypto.gates[0].resolve(); assert.equal(await flushing, false);
  assert.equal(f.posts.length, 0); assert.equal(f.statuses.length, count);
});
