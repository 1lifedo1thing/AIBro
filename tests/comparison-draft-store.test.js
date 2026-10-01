const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../app/comparison-draft-store.js');
const Compare = require('../app/source-comparison.js');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  let disk = { revision: 0, session: null }, fail = '', release, block = false;
  const calls = [], statuses = [];
  const request = async (_, options) => {
    if (options.method !== 'POST') { if (fail === 'offline') throw Error('offline'); return clone(disk); }
    const body = JSON.parse(options.body); calls.push(body);
    if (block) { block = false; await new Promise(resolve => { release = resolve; }); }
    if (['offline', 'disk-full'].includes(fail)) throw Error(fail);
    if (body.revision !== disk.revision) throw Object.assign(Error('changed in another window'), { code: 'draft_conflict' });
    disk = { revision: disk.revision + 1, session: body.session, updatedAt: Date.now() };
    if (fail === 'lost-response') { fail = ''; throw Error('response lost'); }
    return clone(disk);
  };
  const store = create({ request, delay: 99999, onStatus: status => statuses.push(status) });
  return { store, request, calls, statuses, disk: () => disk, set: value => { disk = value; }, fail: value => { fail = value; }, block: () => { block = true; }, release: () => release() };
}
test('autosave coalesces edits and acknowledges only the latest durable revision', async () => {
  const f = fixture(); await f.store.load(); f.store.schedule({ text: 'first' }); f.store.schedule({ text: 'last' });
  assert.equal(f.store.getStatus().state, 'saving'); assert.equal(await f.store.flush(), true);
  assert.equal(f.calls.length, 1); assert.equal(f.disk().session.text, 'last'); assert.equal(f.store.getStatus().state, 'saved'); f.store.dispose();
});
test('edits during a write survive in the next serialized write', async () => {
  const f = fixture(); await f.store.load(); f.block(); f.store.schedule({ text: 'first' }); const pending = f.store.flush();
  f.store.schedule({ text: 'typed during fsync' }); f.release(); assert.equal(await pending, true);
  assert.deepEqual(f.calls.map(c => c.revision), [0, 1]); assert.equal(f.disk().session.text, 'typed during fsync'); f.store.dispose();
});
test('a lost acknowledgement is reconciled without duplicating the write', async () => {
  const f = fixture(); await f.store.load(); f.fail('lost-response'); f.store.schedule({ text: 'committed' });
  assert.equal(await f.store.flush(), true); assert.equal(f.calls.length, 1); assert.equal(f.store.revision(), 1); f.store.dispose();
});
test('two windows cannot replace each other and explicit reload retrieves the surviving draft', async () => {
  const f = fixture(), other = create({ request: f.request, delay: 99999 }); await f.store.load(); await other.load();
  other.schedule({ text: 'other window' }); await other.flush(); f.store.schedule({ text: 'this window' });
  assert.equal(await f.store.flush(), false); assert.equal(f.store.getStatus().state, 'conflict');
  assert.equal(await f.store.clear(), false); assert.equal(f.disk().session.text, 'other window');
  const result = await f.store.reload(); assert.equal(result.session.text, 'other window'); assert.equal(f.store.hasPending(), false); f.store.dispose(); other.dispose();
});
test('storage failure preserves current input for retry and is never shown as saved', async () => {
  const f = fixture(); await f.store.load(); f.fail('disk-full'); f.store.schedule({ text: 'keep this' });
  assert.equal(await f.store.flush(), false); assert.equal(f.store.getStatus().state, 'error');
  f.store.schedule({ text: 'keep latest too' }); f.fail(''); assert.equal(await f.store.flush({ retry: true }), true);
  assert.equal(f.disk().session.text, 'keep latest too'); f.store.dispose();
});
test('parallel retries stay serialized and cannot report a false conflict after a newer edit', async () => {
  let disk = { revision: 0, session: null }, releaseFailure, releaseDuplicate;
  const writes = [];
  const store = create({ delay: 99999, request: async (_, options) => {
    if (options.method !== 'POST') return clone(disk);
    const body = JSON.parse(options.body); writes.push(body);
    if (writes.length === 1) { await new Promise(resolve => { releaseFailure = resolve; }); throw Error('temporary write failure'); }
    // A duplicate retry would be delayed until after the following edit is
    // durable. Its stale response must never overwrite the current status.
    if (body.revision === 0 && writes.length > 2) await new Promise(resolve => { releaseDuplicate = resolve; });
    if (body.revision !== disk.revision) throw Object.assign(Error('changed in another window'), { code: 'draft_conflict' });
    disk = { revision: disk.revision + 1, session: body.session };
    return clone(disk);
  } });
  try {
    await store.load(); store.schedule({ text: 'first edit' });
    const failed = store.flush(), retryA = store.flush({ retry: true }), retryB = store.flush({ retry: true });
    releaseFailure(); await retryA;
    store.schedule({ text: 'newer edit' }); assert.equal(await store.flush(), true);
    releaseDuplicate?.(); await Promise.all([failed, retryB]);
    assert.deepEqual(writes.map(write => write.revision), [0, 0, 1]);
    assert.equal(disk.session.text, 'newer edit');
    assert.equal(store.getStatus().state, 'saved');
    assert.equal(store.hasPending(), false);
  } finally { releaseDuplicate?.(); store.dispose(); }
});
test('failed initial read does not authorize overwriting an existing local draft', async () => {
  const f = fixture(); f.fail('offline'); await assert.rejects(f.store.load()); f.store.schedule({ text: 'new input' });
  f.fail(''); f.set({ revision: 3, session: { text: 'existing draft' } });
  assert.equal(await f.store.flush({ retry: true }), false); assert.equal(f.store.getStatus().state, 'conflict'); assert.equal(f.calls.length, 0); f.store.dispose();
});
test('input scheduled during a delayed reload is retained and requires a real write', async () => {
  let offline = true, release, delayed = false, disk = { revision: 0, session: null }, posts = 0;
  const store = create({ delay: 99999, request: async (_, options) => {
    if (options.method !== 'POST') {
      if (offline) throw Error('offline');
      if (delayed) { delayed = false; await new Promise(resolve => { release = resolve; }); }
      return clone(disk);
    }
    posts++; const body = JSON.parse(options.body); disk = { revision: disk.revision + 1, session: body.session }; return clone(disk);
  } });
  try {
    await assert.rejects(store.load()); offline = false; delayed = true;
    const loading = store.reload(); store.schedule({ text: 'typed during read' }); release();
    await assert.rejects(loading, /input changed/); assert.equal(store.hasPending(), true);
    assert.equal(await store.flush({ retry: true }), true); assert.equal(posts, 1); assert.equal(disk.session.text, 'typed during read');
  } finally { store.dispose(); }
});
test('parallel recovery retries serialize the initial read before writing', async () => {
  let offline = true, release, delayed = false, disk = { revision: 0, session: null }, reads = 0, posts = 0;
  const store = create({ delay: 99999, request: async (_, options) => {
    if (options.method !== 'POST') {
      if (offline) throw Error('offline'); reads++;
      if (delayed) { delayed = false; await new Promise(resolve => { release = resolve; }); }
      return clone(disk);
    }
    posts++; const body = JSON.parse(options.body); assert.equal(body.revision, disk.revision);
    disk = { revision: disk.revision + 1, session: body.session }; return clone(disk);
  } });
  try {
    await assert.rejects(store.load()); offline = false; delayed = true; store.schedule({ text: 'recovered' });
    const first = store.flush({ retry: true }), second = store.flush({ retry: true });
    assert.equal(reads, 1); release(); assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(posts, 1); assert.equal(store.getStatus().state, 'saved');
  } finally { store.dispose(); }
});
test('failed conflict reload retains pending input, and clear uses a durable tombstone', async () => {
  const f = fixture(); await f.store.load(); f.store.schedule({ text: 'pending' }); f.fail('offline');
  await assert.rejects(f.store.reload()); assert.equal(f.store.hasPending(), true); f.fail(''); await f.store.flush();
  assert.equal(await f.store.clear(), true); assert.equal(f.disk().session, null); assert.equal(f.disk().revision, 2); f.store.dispose();
});
test('private draft bodies stay blocked until an explicit clear', async () => {
  const f = fixture(); f.set({ revision: 7, session: null, blocked: 'private' });
  const current = await f.store.load(); assert.equal(current.session, null); assert.equal(f.store.getStatus().blocked, 'private');
  assert.equal(await f.store.clear(), true); assert.equal(f.disk().revision, 8); assert.equal(f.store.getStatus().blocked, null); f.store.dispose();
});
test('incomplete comparison inputs survive draft serialization without weakening final save validation', () => {
  const state = { notes: ['a', 'b'].map(id => ({ id, title: id, content: 'source '+id, workspace: '科研' })), projects: [] };
  const data = Compare.begin(state, ['a','b'].map(id => ({ kind: 'note', id })));
  data.title = ''; data.criteria[0].label = ''; data.criteria[0].cells['note:a'].quote = 'half typed quote'; data.secret = 'must not persist';
  const saved = Compare.draftSession({ data, noteId: null, base: null });
  assert.equal(saved.data.title, ''); assert.equal(saved.data.criteria[0].cells['note:a'].quote, 'half typed quote'); assert.equal(saved.data.secret, undefined);
  assert.throws(() => Compare.validate(saved.data), /标题/);
});
