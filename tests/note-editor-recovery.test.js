'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const Recovery = require('../app/note-editor-recovery.js');
const NoteDraftStore = require('../app/note-draft-store.js');
const Editor = require('../app/note-editor.js');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const note = (id = 'note /?中文', patch = {}) => ({ id, title: 'Original title', content: 'Original body', folderPath: '研究/笔记', workspace: '日常', updatedAt: 1, ...patch });
const state = notes => ({ notes: notes || [note()] });
const edit = (document, content, patch = {}) => ({ ...Editor.begin(state([document]), document.id), content, ...patch });
async function encoded(session) {
  const result = clone(session);
  result.base = 'sha256:' + Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(result.base))).toString('hex');
  return result;
}

// Model the actual HTTP response / CAS boundary while leaving hashing, debounce,
// failed acknowledgement reads and draft hydration to the production stores.
function service() {
  const records = new Map(), blocked = new Map(), reads = [], posts = [], queues = [];
  let readFailure = '', writeFailure = '', clock = 1000;
  const record = id => clone(records.get(id) || { revision: 0, session: null, updatedAt: null });
  const response = (ok, result) => ({ ok, json: async () => clone(result) });
  async function fetch(route, options) {
    assert.equal(options.credentials, 'same-origin'); assert.ok(options.signal instanceof AbortSignal);
    const url = new URL(route, 'http://fixture.invalid'); assert.equal(url.pathname, '/__note-draft');
    const id = url.searchParams.get('id'), write = options.method === 'POST';
    if (write) posts.push({ id, ...JSON.parse(options.body) }); else reads.push(id);
    const index = queues.findIndex(item => item.id === id && item.write === write);
    if (index >= 0) { const gate = queues.splice(index, 1)[0]; gate.started.resolve(); await gate.promise; }
    if (!write) {
      if (readFailure) throw Error(readFailure);
      return response(true, blocked.has(id) ? { ...record(id), session: null, blocked: blocked.get(id) } : record(id));
    }
    const body = JSON.parse(options.body), current = record(id);
    if (writeFailure) return response(false, { message: writeFailure, code: 'draft_storage_write' });
    if (body.session && blocked.has(id)) return response(false, { message: 'Private note drafts stay in memory.', code: 'draft_blocked' });
    if (body.revision !== current.revision) return response(false, { message: 'Another window updated the local draft.', code: 'draft_conflict' });
    const next = { revision: current.revision + 1, session: body.session, updatedAt: ++clock };
    records.set(id, next); return response(true, { ...next, cleared: body.session === null });
  }
  return { fetch, reads, posts, record, seed(id, session, revision = 4) { records.set(id, { revision, session: clone(session), updatedAt: ++clock }); },
    block(id, reason = 'private') { blocked.set(id, reason); }, failReads(message = '') { readFailure = message; }, failWrites(message = '') { writeFailure = message; },
    holdRead(id) { const gate = { ...deferred(), started: deferred(), id, write: false }; queues.push(gate); return gate; },
    holdWrite(id) { const gate = { ...deferred(), started: deferred(), id, write: true }; queues.push(gate); return gate; } };
}
function windowFixture(t, server, initialState = state(), options = {}) {
  const stores = [], disposed = new Set(), views = [], restored = [], notices = [], loading = [], clipboard = [];
  let currentState = initialState, session = null, copyFailure = '', destroyed = false;
  const hooks = { getState: () => currentState, getSession: () => session, begin: Editor.begin, dirty: Editor.dirty, normalizeBase: Editor.normalizeBase, legacyBases: Editor.legacyBases,
    onRestore(value) { restored.push(clone(value)); session = value ? clone(value) : Editor.begin(currentState, session.id); },
    onLoading(value) { loading.push(value); }, notice(message) { notices.push(message); } };
  const env = { crypto: options.crypto || webcrypto, fetch: server.fetch,
    NoteDraftStore: { create(config) { const store = (options.store || NoteDraftStore).create({ ...config, delay: 2147483647 });
      const dispose = store.dispose; store.dispose = () => { disposed.add(store); return dispose(); }; stores.push(store); return store; } },
    navigator: { clipboard: { async writeText(value) { if (copyFailure) throw Error(copyFailure); clipboard.push(value); } } },
    HalaskaUI: { mount(host, name, props) { assert.equal(name, 'NoteDraftRecovery'); views.push(props); host.mounted = true; return {
      update(next) { views.push(next); }, unmount() { host.mounted = false; } }; } } };
  const recovery = (options.recovery || Recovery).create(hooks, env);
  function destroy() { if (destroyed) return; destroyed = true; recovery.unmount(); stores.forEach(store => store.dispose()); }
  t.after(destroy);
  return { recovery, restored, notices, loading, clipboard, stores, disposed, views, destroy,
    mount(id = currentState.notes[0].id, existing) { session = existing || Editor.begin(currentState, id); return recovery.mount({}, id); },
    session: () => session, state: () => currentState, ui: () => views.at(-1),
    change(patch, remember = true) { Object.assign(session, patch); if (remember) recovery.remember(session); },
    setSession(value) { session = value; }, failCopy(message) { copyFailure = message; },
    commit(now = 5000) { const change = Editor.prepare(currentState, session, now); if (change.changed) Object.assign(change.note, change.after); session = Editor.begin(currentState, session.id); return change; } };
}

test('a cold reconstruction restores actual locally acknowledged fields without committing the note', async t => {
  const server = service(), first = windowFixture(t, server);
  await first.mount(); first.change({ title: 'Draft title', content: 'Draft body\n中文', folderPath: '草稿/新目录' });
  assert.equal(await first.recovery.flushAll(), true);
  const persisted = server.record(note().id);
  assert.match(persisted.session.base, /^sha256:[a-f0-9]{64}$/); assert.equal(first.state().notes[0].content, 'Original body');
  first.destroy();
  const reopened = windowFixture(t, server); await reopened.mount();
  assert.equal(reopened.session().title, 'Draft title'); assert.equal(reopened.session().content, 'Draft body\n中文');
  assert.equal(reopened.session().folderPath, '草稿/新目录'); assert.equal(reopened.ui().restored, true);
  assert.equal(reopened.session().base, Editor.begin(reopened.state(), note().id).base);
  assert.equal(reopened.state().notes[0].content, 'Original body'); assert.equal(server.posts.length, 1);
});

test('formal note save clears recovery state and cold reopening cannot revive the committed draft', async t => {
  const server = service(), first = windowFixture(t, server); await first.mount();
  first.change({ content: 'Explicitly committed body' }); await first.recovery.flushAll();
  first.commit(); assert.equal(await first.recovery.saved(note().id), true);
  assert.equal(server.record(note().id).session, null); assert.equal(first.ui().cleanupPending, false);
  const savedState = clone(first.state()); first.destroy();
  const reopened = windowFixture(t, server, savedState); await reopened.mount();
  assert.equal(reopened.session().content, 'Explicitly committed body'); assert.equal(Editor.dirty(reopened.session()), false);
  assert.equal(reopened.restored.length, 0); assert.equal(reopened.ui().restored, false);
});

test('failed post-save cleanup retries only the tombstone and preserves the already committed body', async t => {
  const server = service(), first = windowFixture(t, server); await first.mount();
  first.change({ content: 'Committed before cleanup' }); await first.recovery.flushAll(); first.commit();
  const committed = clone(first.state()), before = server.posts.length;
  server.failWrites('Disk full while clearing recovery record');
  assert.equal(await first.recovery.saved(note().id), false);
  assert.equal(first.ui().cleanupPending, true); assert.equal(server.record(note().id).session.content, 'Committed before cleanup');
  server.failWrites(); assert.equal(await first.ui().onRetry(), true);
  assert.equal(server.record(note().id).session, null); assert.equal(first.ui().cleanupPending, false);
  assert.deepEqual(first.state(), committed); assert.ok(server.posts.slice(before).every(post => post.session === null));
});

test('a cold start after a successful note save and failed cleanup removes its identical recovery body', async t => {
  const server = service(), first = windowFixture(t, server); await first.mount();
  first.change({ content: 'Committed once' }); await first.recovery.flushAll(); first.commit();
  server.failWrites('cleanup failed'); assert.equal(await first.recovery.saved(note().id), false);
  const committed = clone(first.state()); first.destroy(); server.failWrites();
  const reopened = windowFixture(t, server, committed); await reopened.mount();
  assert.equal(server.record(note().id).session, null); assert.equal(reopened.restored.length, 0);
  assert.deepEqual(reopened.state(), committed); assert.equal(Editor.dirty(reopened.session()), false);
});

test('two windows preserve the winning draft and require copy / explicit two-stage reload to replace the losing editor', async t => {
  const server = service(), first = windowFixture(t, server), second = windowFixture(t, server);
  await first.mount(); await second.mount(); second.change({ content: 'Other window wins' }); await second.recovery.flushAll();
  first.change({ title: 'My unsaved title', content: 'My unsaved body' }); assert.equal(await first.recovery.flushAll(), false);
  assert.equal(first.ui().state, 'conflict'); assert.equal(server.record(note().id).session.content, 'Other window wins');
  await first.ui().onCopy(); assert.deepEqual(first.clipboard, ['# My unsaved title\n\nMy unsaved body']);
  const reads = server.reads.length, posts = server.posts.length;
  first.ui().onReload(); assert.equal(first.ui().confirmReplace, true); assert.equal(server.reads.length, reads);
  first.ui().onCancelReload(); assert.equal(first.ui().confirmReplace, false); assert.equal(first.session().content, 'My unsaved body');
  first.ui().onReload(); await first.ui().onConfirmReload();
  assert.equal(first.session().content, 'Other window wins'); assert.equal(first.ui().confirmReplace, false);
  assert.equal(server.posts.length, posts); assert.equal(server.record(note().id).session.content, 'Other window wins');
});

test('a read completed after navigation never changes another editor and still restores on returning to the original note', async t => {
  const server = service(), a = note('a'), b = note('b', { content: 'B original' });
  server.seed(a.id, await encoded(edit(a, 'A previous draft')));
  const window = windowFixture(t, server, state([a, b])), gate = server.holdRead(a.id);
  const openingA = window.mount(a.id); await gate.started.promise;
  await window.mount(b.id); gate.resolve(); await openingA;
  assert.equal(window.session().id, b.id); assert.equal(window.session().content, 'B original'); assert.equal(window.restored.length, 0);
  await window.mount(a.id);
  assert.equal(window.session().content, 'A previous draft'); assert.equal(window.ui().restored, true);
  assert.equal(server.record(a.id).session.content, 'A previous draft'); assert.equal(server.posts.length, 0);
});

test('an unresolved in-memory conflict in a background note prevents a successful exit flush', async t => {
  const server = service(), a = note('a'), b = note('b');
  server.seed(a.id, await encoded(edit(a, 'Previously stored A draft')));
  const window = windowFixture(t, server, state([a, b]));
  assert.equal(await window.mount(a.id, edit(a, 'A current window draft')), false);
  assert.equal(window.ui().state, 'conflict'); assert.equal(window.session().content, 'A current window draft');
  await window.mount(b.id);
  assert.equal(await window.recovery.flushAll(), false);
  assert.equal(server.record(a.id).session.content, 'Previously stored A draft'); assert.equal(server.posts.length, 0);
});

test('private notes never persist draft content and still expose the live editor to explicit copy', async t => {
  const server = service(); server.block(note().id);
  const window = windowFixture(t, server); await window.mount(); window.change({ content: 'Only this private window' });
  assert.equal(await window.recovery.flushAll(), false); assert.equal(server.posts.length, 0); assert.equal(window.ui().blocked, 'private');
  await window.ui().onCopy(); assert.equal(window.clipboard[0], '# Original title\n\nOnly this private window');
  assert.equal(window.session().content, 'Only this private window');
});

test('viewing the latest note with retainedDraft never clears the previously retained unsaved copy', async t => {
  const server = service(), original = note(); server.seed(original.id, await encoded(edit(original, 'Keep this copy')));
  const window = windowFixture(t, server); await window.mount();
  window.setSession({ ...Editor.begin(window.state(), original.id), retainedDraft: true });
  window.recovery.remember(window.session()); await window.recovery.flushAll();
  assert.equal(server.record(original.id).session.content, 'Keep this copy'); assert.equal(server.posts.length, 0);
});

test('failed initial reads followed by retry cannot overwrite a previously unknown local draft', async t => {
  const server = service(), original = note(); server.seed(original.id, await encoded(edit(original, 'Unknown previous draft')));
  server.failReads('temporarily unavailable'); const window = windowFixture(t, server);
  assert.equal(await window.mount(), false); window.change({ content: 'Typed despite read failure' });
  server.failReads(); assert.equal(await window.ui().onRetry(), false);
  assert.equal(server.posts.length, 0); assert.equal(server.record(original.id).session.content, 'Unknown previous draft');
  assert.equal(window.session().content, 'Typed despite read failure'); assert.equal(window.ui().state, 'conflict');
});

test('retry after a failed first read can restore the previous draft when no new edits were made', async t => {
  const server = service(), original = note(); server.seed(original.id, await encoded(edit(original, 'Previous recoverable draft')));
  server.failReads('temporarily unavailable'); const window = windowFixture(t, server);
  assert.equal(await window.mount(), false); server.failReads();
  assert.equal(await window.ui().onRetry(), true);
  assert.equal(window.session().content, 'Previous recoverable draft'); assert.equal(window.ui().restored, true);
  assert.equal(server.posts.length, 0);
});

test('reopening an already cleaned slot never replays its previously loaded recovery result', async t => {
  const server = service(), original = note(); server.seed(original.id, await encoded(edit(original, 'Once saved draft')));
  const window = windowFixture(t, server); await window.mount(); window.commit();
  assert.equal(await window.recovery.saved(original.id), true); window.recovery.unmount();
  const restoredCount = window.restored.length; await window.mount(original.id);
  assert.equal(window.restored.length, restoredCount); assert.equal(Editor.dirty(window.session()), false);
  assert.equal(window.ui().restored, false); assert.equal(server.record(original.id).session, null);
});

test('exit flush captures the immediate current input even before debounce or remember runs', async t => {
  const server = service(), window = windowFixture(t, server); await window.mount();
  window.change({ content: 'Last keystroke before quit', title: 'Immediate title' }, false);
  assert.equal(server.posts.length, 0); assert.equal(await window.recovery.flushAll(), true);
  assert.equal(server.record(note().id).session.content, 'Last keystroke before quit');
  assert.equal(server.record(note().id).session.title, 'Immediate title');
});

test('undoing a restored draft to its unchanged original clears the old recovery record', async t => {
  const server = service(), original = note(); server.seed(original.id, await encoded(edit(original, 'Previously changed')));
  const window = windowFixture(t, server); await window.mount();
  window.change({ content: window.session().originalContent });
  assert.equal(Editor.dirty(window.session()), false); assert.equal(await window.recovery.flushAll(), true);
  assert.equal(server.record(original.id).session, null);
});

test('undo against a changed note baseline retains the conflicting local draft for review', async t => {
  const server = service(), original = note(); server.seed(original.id, await encoded(edit(original, 'Draft from old note')));
  const latest = note(original.id, { content: 'Newer committed content', updatedAt: 9 });
  const window = windowFixture(t, server, state([latest])); await window.mount();
  assert.match(window.session().base, /^sha256:/); assert.throws(() => Editor.prepare(window.state(), window.session()), /其他操作修改/);
  window.change({ content: 'Intermediate edit' }); window.change({ content: window.session().originalContent });
  await window.recovery.flushAll();
  assert.notEqual(server.record(original.id).session, null);
  assert.equal(server.record(original.id).session.content, 'Original body');
  assert.equal(window.state().notes[0].content, 'Newer committed content');
  assert.throws(() => Editor.prepare(window.state(), window.session()), /其他操作修改/);
});

test('clipboard failure leaves current input and the competing stored draft intact', async t => {
  const server = service(), window = windowFixture(t, server); await window.mount();
  window.change({ content: 'Still in editor' }); window.failCopy('Clipboard permission unavailable');
  assert.equal(await window.ui().onCopy(), false); assert.match(window.notices.at(-1), /Clipboard permission/);
  assert.equal(window.session().content, 'Still in editor'); assert.equal(server.posts.length, 0);
});

const sortedJSON = value => JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
const richBaseline = () => note(undefined, {
  sourceAttachmentIds: ['second', 'first'], sourceNoteIds: ['related'],
  revisionHistory: [{ title: 'Prior title', content: 'Prior body', updatedAt: 0, savedAt: 1, userEdited: false,
    provenance: { run: { startedAt: 4, id: 'previous-run' }, output: { variant: 'body', id: 'previous-output' } } }],
  provenance: { run: { startedAt: 5, id: 'run' }, output: { variant: 'body', id: 'output' } },
  wikiSourceLinks: { z: { title: 'Z', id: 'z' }, a: { title: 'A', id: 'a' } }
});

test('cold recovery after persisted object-key sorting can save the complete draft and retain nested metadata', async t => {
  const server = service(), first = windowFixture(t, server, state([richBaseline()]));
  await first.mount(); first.change({ content: 'New draft\r\n完整正文😀', title: 'New draft title' });
  assert.equal(await first.recovery.flushAll(), true);
  const diskState = sortedJSON(first.state()); first.destroy();
  const reopened = windowFixture(t, server, diskState); await reopened.mount();
  assert.equal(reopened.session().base, Editor.begin(diskState, note().id).base);
  assert.equal(reopened.session().content, 'New draft\r\n完整正文😀');
  const oldProvenance = clone(diskState.notes[0].provenance);
  assert.equal(reopened.commit().changed, true);
  assert.deepEqual(diskState.notes[0].provenance, oldProvenance);
  assert.equal(diskState.notes[0].revisionHistory.at(-1).content, 'Original body');
  assert.equal(await reopened.recovery.saved(note().id), true);
  assert.equal(server.record(note().id).session, null);
});

test('cold recovery still rejects actual content, metadata and array-order changes after canonicalization', async t => {
  for (const mutate of [
    value => { value.content += '\nexternal edit'; },
    value => { value.revisionHistory[0].provenance.run.id = 'different-run'; },
    value => { value.provenance.output.id = 'different-output'; },
    value => { value.sourceAttachmentIds.reverse(); },
    value => { value.wikiSourceLinks.z.id = 'different-link'; }
  ]) {
    const server = service(), original = richBaseline(), first = windowFixture(t, server, state([original]));
    await first.mount(); first.change({ content: 'Must retain this draft' }); await first.recovery.flushAll();
    const diskState = sortedJSON(first.state()); first.destroy(); mutate(diskState.notes[0]);
    const reopened = windowFixture(t, server, diskState); await reopened.mount();
    const before = clone(diskState);
    assert.match(reopened.session().base, /^sha256:/);
    assert.throws(() => reopened.commit(), /其他操作修改/);
    assert.deepEqual(diskState, before);
    assert.equal(reopened.session().content, 'Must retain this draft');
    assert.equal(server.record(note().id).session.content, 'Must retain this draft');
  }
});

test('a complete legacy raw baseline normalizes on restore without weakening any metadata comparison', async t => {
  const server = service(), original = richBaseline(), legacy = edit(original, 'Legacy raw draft');
  legacy.base = Editor.legacyBases(state([original]), original.id)[0];
  assert.notEqual(legacy.base, Editor.begin(state([original]), original.id).base);
  server.seed(original.id, legacy);
  const reopened = windowFixture(t, server, sortedJSON(state([original]))); await reopened.mount();
  assert.equal(reopened.session().base, Editor.begin(reopened.state(), original.id).base);
  assert.equal(reopened.commit().after.content, 'Legacy raw draft');
});

test('a legacy SHA matching the current note complete old signature is safely upgraded', async t => {
  const server = service(), original = richBaseline(), legacy = edit(original, 'Legacy hashed draft');
  legacy.base = Editor.legacyBases(state([original]), original.id)[0];
  server.seed(original.id, await encoded(legacy));
  const reopened = windowFixture(t, server, state([clone(original)])); await reopened.mount();
  assert.equal(reopened.session().base, Editor.begin(reopened.state(), original.id).base);
  assert.equal(reopened.commit().after.content, 'Legacy hashed draft');
});

test('an unprovable legacy SHA after key sorting retains its draft rather than guessing the missing metadata', async t => {
  const server = service(), original = richBaseline(), legacy = edit(original, 'Keep all legacy text');
  legacy.base = Editor.legacyBases(state([original]), original.id)[0];
  const stored = await encoded(legacy); server.seed(original.id, stored);
  const current = sortedJSON(state([original])), reopened = windowFixture(t, server, current); await reopened.mount();
  assert.equal(reopened.session().base, stored.base);
  assert.equal(reopened.session().originalContent, current.notes[0].content);
  assert.throws(() => reopened.commit(), /旧版.*无法确认完整版本/);
  assert.equal(reopened.session().content, 'Keep all legacy text');
  assert.equal(server.record(original.id).session.base, stored.base);
  assert.equal(server.record(original.id).session.content, 'Keep all legacy text');
});

// Observe the actual private Maps without adding a production diagnostics API.
function measuredModule(filename) {
  const maps = [], module = { exports: {} };
  class MeasuredMap extends Map { constructor(...args) { super(...args); maps.push(this); } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app', filename), 'utf8'), {
    module, Map: MeasuredMap, require: name => require(path.join(__dirname, '../app', name)),
    AbortController, TextEncoder, setTimeout, clearTimeout
  }, { filename });
  return { api: module.exports, maps };
}

test('eight formally saved and unmounted notes release their recovery slots and full-base hash caches', async t => {
  const recovery = measuredModule('note-editor-recovery.js'), store = measuredModule('note-draft-store.js');
  const server = service(), notes = Array.from({ length: 8 }, (_, index) => note('saved-' + index, { content: '基线内容'.repeat(1000) }));
  const window = windowFixture(t, server, state(notes), { recovery: recovery.api, store: store.api });
  for (const document of notes) {
    await window.mount(document.id); window.change({ content: document.content + '\nSaved addition' });
    assert.equal(await window.recovery.flushAll(), true);
    window.commit(); assert.equal(await window.recovery.saved(document.id), true);
    assert.equal(window.disposed.has(window.stores.at(-1)), false, 'active editor keeps its usable store');
    window.recovery.unmount();
  }
  assert.equal(recovery.maps[0].size, 0, 'no inactive clean recovery slots');
  assert.equal(window.disposed.size, 8);
  assert.equal(store.maps.reduce((count, map) => count + map.size, 0), 0, 'disposed stores retain no raw version bases');
  assert.ok(notes.every(document => server.record(document.id).session === null));
  await window.mount(notes[0].id);
  assert.equal(window.stores.length, 9, 'reopening creates a fresh non-disposed store');
  window.change({ content: 'Reopened and edited again' }); assert.equal(await window.recovery.flushAll(), true);
  assert.equal(server.record(notes[0].id).session.content, 'Reopened and edited again');
});

test('unmounted dirty, pending and failed-cleanup slots stay usable until a formal save and clear succeed', async t => {
  const server = service(), window = windowFixture(t, server);
  await window.mount(); window.change({ content: 'Pending edit' }); window.recovery.unmount();
  assert.equal(window.disposed.size, 0); assert.equal(await window.recovery.flushAll(), true);
  assert.equal(window.disposed.size, 0, 'acknowledged recovery is still an unsaved note');
  const draft = clone(window.session()); await window.mount(note().id, draft);
  assert.equal(window.stores.length, 1); window.commit(); server.failWrites('cleanup unavailable');
  assert.equal(await window.recovery.saved(note().id), false); window.recovery.unmount();
  assert.equal(window.disposed.size, 0); assert.equal(server.record(note().id).session.content, 'Pending edit');
  server.failWrites(); assert.equal(await window.recovery.flushAll(), true);
  assert.equal(window.disposed.size, 1); assert.equal(server.record(note().id).session, null);
});

test('a cleanup acknowledgement arriving after unmount releases only its inactive clean slot', async t => {
  const server = service(), a = note('a'), b = note('b'), window = windowFixture(t, server, state([a, b]));
  await window.mount(a.id); window.change({ content: 'A committed' }); await window.recovery.flushAll(); window.commit();
  const gate = server.holdWrite(a.id), clearing = window.recovery.saved(a.id); await gate.started.promise;
  await window.mount(b.id); window.change({ content: 'B pending' });
  assert.equal(window.disposed.size, 0); gate.resolve(); assert.equal(await clearing, true);
  assert.equal(window.disposed.has(window.stores[0]), true); assert.equal(window.disposed.has(window.stores[1]), false);
  assert.equal(window.session().content, 'B pending'); assert.equal(await window.recovery.flushAll(), true);
  assert.equal(server.record(b.id).session.content, 'B pending');
});

test('continued input after a successful save invalidates clean-slot release until the new edit is committed', async t => {
  const server = service(), window = windowFixture(t, server);
  await window.mount(); window.change({ content: 'First committed body' }); await window.recovery.flushAll(); window.commit();
  assert.equal(await window.recovery.saved(note().id), true);
  window.change({ title: '继续输入中文', content: 'Second unsaved body' }); const draft = clone(window.session());
  window.recovery.unmount(); assert.equal(window.disposed.size, 0);
  assert.equal(await window.recovery.flushAll(), true); assert.equal(server.record(note().id).session.content, 'Second unsaved body');
  await window.mount(note().id, draft); assert.equal(window.stores.length, 1);
  window.commit(); assert.equal(await window.recovery.saved(note().id), true);
  window.recovery.unmount(); assert.equal(window.disposed.size, 1);
});

test('returning to edit the same note during cleanup prevents its late acknowledgement from disposing newer input', async t => {
  const server = service(), a = note('a'), b = note('b'), window = windowFixture(t, server, state([a, b]));
  await window.mount(a.id); window.change({ content: 'A committed' }); await window.recovery.flushAll(); window.commit();
  const gate = server.holdWrite(a.id), clearing = window.recovery.saved(a.id); await gate.started.promise;
  await window.mount(b.id); await window.mount(a.id); window.change({ title: '新标题', content: 'Later input after save' });
  gate.resolve(); assert.equal(await clearing, false); assert.equal(window.disposed.size, 0);
  window.recovery.unmount(); assert.equal(window.disposed.size, 0);
  assert.equal(await window.recovery.flushAll(), true);
  assert.equal(server.record(a.id).session.content, 'Later input after save');
  assert.equal(server.record(a.id).session.title, '新标题');
});

test('a superseded hash completing after clean-slot disposal cannot refill caches or mutate a reopened editor', async t => {
  const measured = measuredModule('note-draft-store.js'), gate = deferred(), started = deferred(); let hashes = 0;
  const crypto = { subtle: { digest(name, data) {
    if (++hashes !== 1) return webcrypto.subtle.digest(name, data);
    started.resolve(); return gate.promise.then(() => webcrypto.subtle.digest(name, data));
  } } };
  const server = service(), window = windowFixture(t, server, state(), { store: measured.api, crypto });
  await window.mount(); window.change({ content: 'Saved while recovery hash is pending' });
  const flushing = window.recovery.flushAll(); await started.promise;
  window.commit(); assert.equal(await window.recovery.saved(note().id), true); assert.equal(await flushing, true);
  window.recovery.unmount(); assert.equal(window.disposed.size, 1); assert.equal(measured.maps[0].size, 0);
  await window.mount(); window.change({ content: 'New editor draft' }); assert.equal(await window.recovery.flushAll(), true);
  const posts = server.posts.length, views = window.views.length;
  gate.resolve(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(measured.maps[0].size, 0); assert.equal(server.posts.length, posts); assert.equal(window.views.length, views);
  assert.equal(server.record(note().id).session.content, 'New editor draft'); assert.equal(window.disposed.has(window.stores[1]), false);
});
