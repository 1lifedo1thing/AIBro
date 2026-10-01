const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
function harness({ statusFailure = false } = {}) {
  const requests = [], timers = [], revisions = [], warnings = [];
  const context = vm.createContext({
    window: {CloudSyncUI: {reconcileAppliedRevision() {
      revisions.push(context.getCloudAppliedRevision());
      if (statusFailure) throw new Error('Synthetic status render failure');
    }}},
    state: { notes: [{ id: 'note', content: 'New human text' }], imports: [] },
    STORAGE_KEY: 'isolated-note-persistence', console: {warn: (...args) => warnings.push(args)},
    localStorage: { getItem: () => '', setItem() {} },
    purgeTrash: { syncPaused: false },
    showSyncConflict() {},
    fetch: (_url, options) => new Promise(resolve => requests.push({ snapshot: JSON.parse(options.body), resolve })),
    setTimeout: (fn, delay) => { const entry = { fn, delay }; timers.push(entry); return entry; },
    clearTimeout: entry => { if (entry) entry.cancelled = true; }
  });
  vm.runInContext(`
    let storageHydrated = true, serverSaveInFlight = false, serverSaveQueued = false;
    let serverConflict = false, serverSaveTimer = null, serverSavePromise = null, serverSaveFailure = null;
    let localEditVersion = 0;
    function save() { state._pendingLocalSave = true; localEditVersion++; serverSaveQueued = true; }
  `, context);
  const receiptStart = source.indexOf('function rememberCloudAppliedRevision(');
  const receiptEnd = source.indexOf('\nfunction adoptCloudSnapshot(', receiptStart);
  assert.ok(receiptStart >= 0 && receiptEnd > receiptStart, 'Use the actual production revision receipt and status notification functions');
  vm.runInContext(source.slice(receiptStart, receiptEnd), context);
  const start = source.indexOf('function persistServerSnapshot(');
  const end = source.indexOf('const save =', start);
  assert.ok(start >= 0 && end > start, 'Use the actual production persistence functions');
  vm.runInContext(source.slice(start, end), context);
  return { context, requests, timers, revisions, warnings, save: () => vm.runInContext('saveDocumentDurably()', context), read: expression => vm.runInContext(expression, context) };
}

test('document persistence waits for the actual HTTP acknowledgement instead of timing out an in-flight write', async () => {
  const h = harness(); let settled = false;
  const pending = h.save().then(result => { settled = true; return result; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].snapshot.notes[0].content, 'New human text');
  assert.equal(h.timers.some(timer => timer.delay === 2500), false);
  assert.equal(h.read('serverSaveInFlight'), true);
  assert.deepEqual(h.revisions, [], 'No applied receipt is announced before the response');
  h.requests[0].resolve({ ok: true, status: 200, json: async () => ({ revision: 9 }) });
  assert.equal(await pending, true);
  assert.equal(h.read('state._pendingLocalSave'), undefined);
  assert.equal(h.read('state._revision'), 9);
  assert.deepEqual(h.revisions, [null, 9], 'The receipt becomes readable only after the acknowledged write leaves flight');
  assert.deepEqual(h.warnings, []);
});

test('a completed persistence error queues a new version after the editor can roll back its optimistic mutation', async () => {
  const h = harness();
  const pending = h.save();
  const rejection = assert.rejects(pending, /数据库暂时无法保存/);
  h.requests[0].resolve({ ok: false, status: 500, json: async () => ({}) });
  await rejection;
  assert.equal(h.read('serverSaveInFlight'), false);
  assert.deepEqual(h.revisions, [null], 'A failed write cannot announce an applied revision');
  const originalVersion = h.read('localEditVersion');
  h.context.state.notes[0].content = 'Previous stored text'; // The editor's guarded rollback.
  const afterRollback = h.timers.find(timer => timer.delay === 0 && !timer.cancelled);
  assert.ok(afterRollback);
  afterRollback.fn();
  assert.equal(h.read('localEditVersion'), originalVersion + 1);
  assert.equal(h.read('state._pendingLocalSave'), true);
  assert.equal(h.read('serverSaveQueued'), true);
  assert.equal(h.context.state.notes[0].content, 'Previous stored text');
});

test('a sync status rendering error cannot reject an acknowledged document write or queue an editor rollback', async () => {
  const h = harness({statusFailure: true}), pending = h.save();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ok: true, status: 200, json: async () => ({revision: 11})});
  assert.equal(await pending, true);
  assert.equal(h.read('state._revision'), 11);
  assert.equal(h.read('persistServerSnapshot.committedVersion'), h.read('localEditVersion'));
  assert.equal(h.read('serverSaveFailure'), null);
  assert.equal(h.read('serverSaveQueued'), false);
  assert.equal(h.read('state._pendingLocalSave'), undefined);
  assert.deepEqual(h.revisions, [null, 11]);
  assert.equal(h.warnings.length, 2);
  assert.ok(h.warnings.every(args => args.length === 1 && /sync status display will refresh later/.test(args[0])));
  assert.equal(h.timers.some(timer => timer.delay === 0 && !timer.cancelled), false);
});

test('independent research follow-up permits its actual prior note without new attachments, resolving merged IDs but excluding unrelated notes', () => {
  const NoteConsolidation = require('../app/note-consolidation');
  const state = {
    projects: [{ id: 'other-project', workspace: '科研' }],
    notes: [
      { id: 'main', title: 'Independent paper', workspace: '科研', mergedNoteIds: ['fragment'] },
      { id: 'unrelated', title: 'Other project', workspace: '科研', projectId: 'other-project' },
      { id: 'archived', title: 'Archived', workspace: '科研', archived: true }
    ]
  };
  const context = vm.createContext({
    state, window: { NoteConsolidation }, NoteConsolidation,
    run: { projectId: null }, attachmentsBefore: [], fileContext: { snapshots: [] },
    conversation: { messages: [{ results: [{ type: 'note', id: 'fragment' }, { type: 'note', id: 'archived' }] }] },
    visibleNote: note => !note.archived
  });
  vm.runInContext(source.slice(source.indexOf('function dedupeResultEntries('), source.indexOf('function groupedEntities(')), context);
  vm.runInContext(source.slice(source.indexOf('function activeResultRecord('), source.indexOf('function conversationProjectIds(')), context);
  const start = source.indexOf('    const recentNoteIds =');
  const end = source.indexOf('\n    instruction +=', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  assert.deepEqual(Array.from(context.run.noteContextIds), ['main']);
});
