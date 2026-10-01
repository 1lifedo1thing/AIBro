const test = require('node:test');
const assert = require('node:assert/strict');
const Tree = require('../app/document-file-tree.js');
const Catalog = require('../app/document-files.js');
const fixture = () => ({ projects: [{ id: 'p', name: 'Project', localFolder: { id: 'root', name: 'Local' } }], notes: [{ id: 'n', title: 'Guide.md', folderPath: 'Docs/API', projectId: 'p' }],
  imports: [{ id: 'a', name: 'Lecture.pdf', projectId: 'p' }], conversations: [{ id: 'c', projectId: 'p', title: 'Chat', messages: [{ role: 'user', attachmentIds: ['a'], fileReferences: [{ type: 'note', id: 'n' }] }] }], agentRuns: [], ui: {} });
const allNodes = nodes => nodes.flatMap(node => [node, ...allNodes(node.children || [])]);
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options = {}) {
  const state = fixture(), opens = [], notices = [], requests = [];
  let scope = Tree.resolveScope(state, state.conversations[0]), props, updates = 0, mounts = 0, disposed = 0;
  const controller = Tree.create({ state: () => state, scope: () => scope, catalog: Catalog, host: {},
    mount(host, name, input) { mounts++; props = input; assert.equal(name, 'DocumentFiles'); return { update(next) { updates++; props = { ...props, ...next }; }, unmount() { disposed++; } }; },
    open: async (...args) => { opens.push(args); if (options.open && await options.open(args, state) === false) return false; state.previewRecord = { type: args[0], id: args[1] }; return true; }, toast: message => notices.push(message),
    request: async (url, body) => { requests.push({ url, body }); return options.request ? options.request(body) : { entries: [], nextOffset: null }; }, add: options.add });
  controller.sync();
  return { state, controller, opens, notices, requests, get props() { return props; }, counts: () => ({ mounts, updates, disposed }), setScope: next => { scope = next; controller.sync(); }, row: id => allNodes(props.nodes).find(node => node.id === id) };
}

test('hierarchy retains typed identities and stable folder paths without copying bodies', () => {
  const state = fixture(), data = Catalog.build({ state, conversationId: 'c' });
  const tree = Tree.hierarchy(data.groups), nodes = allNodes(tree);
  assert.equal(nodes.filter(node => node.folder).length, 3);
  assert.equal(nodes.find(node => node.id === 'n').key, JSON.stringify(['note', 'n']));
  const again = Tree.hierarchy(data.groups); assert.deepEqual(again, tree);
  assert.equal(nodes.find(node => node.id === 'n').content, undefined);
});

test('standalone conversation and real document scopes do not inherit the previous project route', () => {
  const state = fixture(); state.currentProjectId = 'p';
  const independent = { id: 'independent', title: 'Independent', messages: [] };
  assert.equal(Tree.resolveScope(state, independent).conversationId, 'independent');
  assert.equal(Tree.resolveScope(state, independent).projectId, null);
  assert.equal(Tree.resolveScope(state, state.conversations[0], 'wiki', false), null);
  state.previewRecord = { type: 'note', id: 'n' };
  assert.equal(Tree.resolveScope(state, independent, 'wiki', true).projectId, 'p');
  assert.equal(Tree.resolveScope(state, independent, 'wiki', true).conversationId, null);
  state.notes.push({ id: 'free', title: 'Free', workspace: 'Daily' }); state.previewRecord.id = 'free';
  assert.equal(Tree.resolveScope(state, independent, 'wiki', true).key, 'library');
  state.projects[0].private = true; state.previewRecord.id = 'n';
  assert.equal(Tree.resolveScope(state, independent, 'wiki', true), null);
});

test('refreshes keep one island and ignore streamed response text while selecting only actual opened records', async () => {
  const h = setup(); assert.equal(h.props.mode, 'conversation');
  for (let n = 0; n < 100; n++) { h.state.conversations[0].messages[0].text = 'stream ' + n; h.controller.sync(); }
  assert.deepEqual(h.counts(), { mounts: 1, updates: 0, disposed: 0 });
  await h.props.onOpen(h.row('n')); assert.deepEqual(h.opens.map(args => args.slice(0, 3)), [['note', 'n', undefined]]);
  assert.deepEqual(h.opens[0][3], { type: 'note', id: 'n', provided: false, conversationId: 'c', documentScope: {scope:'conversation',conversationId:'c',projectId:'p',localDirectory:false} });
  assert.equal(h.opens[0][4](), true);
  assert.equal(h.props.selectedKey, JSON.stringify(['note', 'n']));
});

test('mode and directory disclosure never invoke reader navigation, while per-owner state survives switching', () => {
  const h = setup(), folder = h.props.nodes[0];
  h.props.onToggle(folder); h.props.onQuery('Guide'); h.props.onFocus('remember'); h.props.onScroll(120);
  const owner = h.controller.snapshot().scope;
  h.setScope({ key: 'conversation:other', conversationId: 'other', projectId: null, name: 'Other' });
  h.setScope(owner);
  assert.equal(h.props.query, 'Guide'); assert.equal(h.props.focusedKey, 'remember'); assert.equal(h.props.scrollTop, 120);
  h.props.onQuery(''); assert.equal(h.props.nodes[0].expanded, false);
  h.props.onMode('all'); assert.equal(h.opens.length, 0); assert.equal(h.props.mode, 'all');
});

test('null scope clears visible metadata without destroying or replacing reader state', () => {
  const h = setup(); h.state.previewRecord = { type: 'note', id: 'n' };
  h.setScope(null); assert.equal(h.props.nodes.length, 0); assert.equal(h.props.onOpen, undefined);
  assert.deepEqual(h.state.previewRecord, { type: 'note', id: 'n' }); assert.equal(h.counts().mounts, 1);
});

test('click revalidates deleted and private rows and does not navigate stale captured references', async () => {
  const h = setup(), stale = h.row('n'); h.state.notes[0].private = true;
  assert.equal(await h.props.onOpen(stale), false); assert.equal(h.opens.length, 0); assert.equal(h.notices.length, 1);
  delete h.state.notes[0].private; h.state.notes[0].deletedAt = 1;
  await h.props.onOpen(stale); assert.equal(h.opens.length, 0);
});

test('asynchronous navigation rechecks the full conversation and message provenance after draft flush', async () => {
  for (const revoke of [state => { state.conversations[0].private = true; }, state => { state.conversations[0].deletedAt = 1; },
    state => { state.conversations[0].messages[0].private = true; }, state => { state.conversations[0].messages[0].fileReferences = []; }]) {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const h = setup({ open: async args => { assert.equal(args[4](), true); await wait; return args[4](); } });
    h.state.previewRecord = { type: 'note', id: 'previous' };
    const opening = h.props.onOpen(h.row('n'));
    revoke(h.state); release();
    assert.equal(await opening, false);
    assert.deepEqual(h.state.previewRecord, { type: 'note', id: 'previous' });
  }
});

test('run provenance reaches persistent source guard and a later private source blocks the pending open', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const h = setup({ open: async args => { await wait; return args[4](); } });
  h.state.conversations[0].messages = [];
  h.state.agentRuns = [{ id: 'r', conversationId: 'c', projectId: 'p', fileReferences: [{ type: 'note', id: 'n' }] }]; h.controller.sync();
  const opening = h.props.onOpen(h.row('n'));
  assert.deepEqual(h.opens[0][3], { type: 'note', id: 'n', provided: false, conversationId: 'c', runId: 'r', documentScope: {scope:'conversation',conversationId:'c',projectId:'p',localDirectory:false} });
  h.state.agentRuns[0].fileReferences[0].private = true; release();
  assert.equal(await opening, false); assert.equal(h.state.previewRecord, undefined);
});

test('scope and mode changes cancel an older pending file open', async () => {
  for (const change of [h => h.setScope({ key: 'project:p', projectId: 'p', conversationId: null, name: 'Project' }), h => h.props.onMode('all')]) {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const h = setup({ open: async args => { await wait; return args[4](); } });
    const opening = h.props.onOpen(h.row('n'));
    change(h); release();
    assert.equal(await opening, false); assert.equal(h.state.previewRecord, undefined);
  }
});

test('withdrawn proposals and disconnected local roots are rechecked after pending navigation', async () => {
  let release;
  let wait = new Promise(resolve => { release = resolve; });
  const h = setup({ open: async args => { await wait; return args[4](); }, request: () => ({ entries: [{ name: 'file.md', path: 'file.md', type: 'file', supported: true }], nextOffset: null }) });
  const edit = { id: 'edit', projectId: 'p', candidateId: 'root', path: 'new.md', status: 'pending' };
  h.state.agentRuns = [{ id: 'r', conversationId: 'c', projectId: 'p', localFileEdits: [edit] }]; h.controller.sync();
  const reviewOpening = h.props.onOpen(h.row(Catalog.localId(edit)));
  edit.status = 'dismissed'; release(); assert.equal(await reviewOpening, false);
  wait = new Promise(resolve => { release = resolve; });
  h.props.onMode('all'); h.props.onToggle(h.props.nodes.find(node => node.local)); await tick();
  const fileOpening = h.props.onOpen(h.props.nodes.find(node => node.local).children[0]);
  h.state.projects[0].localFolder.id = 'replacement'; release();
  assert.equal(await fileOpening, false); assert.equal(h.state.previewRecord, undefined);
});

test('pending file creation opens its review, multiple proposals retain their explicit target, and withdrawn proposals cannot open', async () => {
  const h = setup();
  const edit = { id: 'edit', projectId: 'p', candidateId: 'root', path: 'new.md', status: 'pending' };
  h.state.agentRuns = [{ id: 'r', conversationId: 'c', projectId: 'p', localFileEdits: [edit] }, { id: 'r2', conversationId: 'c', projectId: 'p', localFileEdits: [{ ...edit, id: 'edit2' }] }]; h.controller.sync();
  const row = h.row(Catalog.localId(edit)); assert.equal(row.open, null);
  await h.props.onOpen(row); assert.deepEqual(h.opens[0].slice(0, 3), ['local-review', 'r', 'edit']);
  assert.equal(h.opens[0][3], undefined, 'pending creates must not require an existing file record');
  await h.props.onReview(row, row.reviews[1]); assert.deepEqual(h.opens[1].slice(0, 3), ['local-review', 'r2', 'edit2']);
  h.state.agentRuns[1].localFileEdits[0].status = 'dismissed';
  assert.equal(await h.props.onReview(row, row.reviews[1]), false); assert.equal(h.opens.length, 2);
});

test('clicking the second note proposal opens that exact file within its shared run', async () => {
  const h = setup(); h.state.notes.push({ id: 'second', title: 'Second.md', projectId: 'p' });
  for (const note of h.state.notes) note.aiDraft = { provenance: { origin: { runId: 'r' } } };
  h.state.agentRuns = [{ id: 'r', conversationId: 'c', projectId: 'p', fileChanges: h.state.notes.map(note => ({ type: 'note', id: note.id, operation: 'drafted' })) }];
  h.controller.sync();
  await h.props.onOpen(h.row('second')); assert.deepEqual(h.opens[0].slice(0, 3), ['review', 'r', 'second']);
  await h.props.onOpen(h.row('n')); assert.deepEqual(h.opens[1].slice(0, 3), ['review', 'r', 'n']);
});

test('an unconfirmed legacy draft opens its historical diff and a current draft keeps its own default target', async () => {
  const h = setup(); h.state.notes[0].aiDraft = { content: 'legacy draft' };
  const old = { id: 'r', conversationId: 'c', projectId: 'p', fileChanges: [{ type: 'note', id: 'n', operation: 'drafted' }] };
  h.state.agentRuns = [old]; h.controller.sync();
  assert.equal(h.row('n').group, 'history');
  await h.props.onOpen(h.row('n')); assert.deepEqual(h.opens[0].slice(0, 3), ['review', 'r', 'n']);
  h.state.notes[0].aiDraft.provenance = { origin: { runId: 'new-run' } };
  h.state.conversations[0].messages.push({ role: 'agent', runId: 'r', results: [{ type: 'note', id: 'n', operation: 'drafted' }] });
  h.state.agentRuns.push({ ...old, id: 'new-run', startedAt: 30 }); h.controller.sync();
  assert.equal(h.row('n').group, 'review');
  await h.props.onOpen(h.row('n')); assert.deepEqual(h.opens[1].slice(0, 3), ['review', 'new-run', 'n']);
  await h.props.onReview(h.row('n'), h.row('n').reviews.find(review => review.runId === 'r'));
  assert.deepEqual(h.opens[2].slice(0, 3), ['review', 'r', 'n']);
});

test('directory metadata loads only on disclosure and respects pagination without closing the reader', async () => {
  const h = setup({ request: body => ({ entries: body.offset ? [{ name: 'second.md', path: 'second.md', type: 'file', supported: true }] : [{ name: 'first.md', path: 'first.md', type: 'file', supported: true }], nextOffset: body.offset ? null : 1 }) });
  h.props.onMode('all'); assert.equal(h.requests.length, 0);
  const folder = h.props.nodes.find(node => node.local); h.props.onToggle(folder); await tick();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/__local/files');
  let root = h.props.nodes.find(node => node.local); assert.equal(root.children.length, 1);
  await h.props.onLoadMore(root); root = h.props.nodes.find(node => node.local); assert.equal(root.children.length, 2);
  await h.props.onOpen(root.children[1]); assert.deepEqual(h.opens[0].slice(0, 3), ['local-file', JSON.stringify(['p', 'root', 'second.md']), undefined]);
  assert.deepEqual(h.opens[0][3], { type: 'local', projectId: 'p', candidateId: 'root', path: 'second.md', provided: false, documentScope: {scope:'all',conversationId:'c',projectId:'p',localDirectory:true} });
});

test('stale directory responses cannot reveal disconnected roots; refresh invalidates in-flight data', async () => {
  const pending = [], h = setup({ request: () => new Promise(resolve => pending.push(resolve)) });
  h.props.onMode('all'); h.props.onToggle(h.props.nodes.find(node => node.local)); await tick();
  h.props.onRefresh(); await tick(); assert.equal(pending.length, 2);
  pending[0]({ entries: [{ name: 'stale.md', path: 'stale.md', type: 'file' }], nextOffset: null }); await tick();
  assert.equal(allNodes(h.props.nodes).some(node => node.name === 'stale.md'), false);
  h.state.projects[0].private = true; h.controller.sync();
  pending[1]({ entries: [{ name: 'secret.md', path: 'secret.md', type: 'file' }], nextOffset: null }); await tick();
  assert.equal(allNodes(h.props.nodes).some(node => node.name === 'secret.md'), false);
  assert.equal(h.props.nodes.some(node => node.local), false);
});

test('failed directory reads expose retry and retain the current document', async () => {
  let calls = 0; const h = setup({ request: () => { if (!calls++) throw Error('offline'); return { entries: [], nextOffset: null }; } });
  h.state.previewRecord = { type: 'note', id: 'n' }; h.props.onMode('all'); h.props.onToggle(h.props.nodes.find(node => node.local)); await tick();
  const node = h.props.nodes.find(node => node.local); assert.equal(node.error, 'offline');
  await h.props.onRetry(node); assert.equal(h.props.nodes.find(node => node.local).loaded, true);
  assert.deepEqual(h.state.previewRecord, { type: 'note', id: 'n' });
});

test('dispose retires pending responses and island exactly once', async () => {
  let respond; const h = setup({ request: () => new Promise(resolve => { respond = resolve; }) });
  h.props.onMode('all'); h.props.onToggle(h.props.nodes.find(node => node.local)); await tick(); const updates = h.counts().updates;
  h.controller.dispose(); respond({ entries: [{ name: 'late', path: 'late', type: 'file' }], nextOffset: null }); await tick();
  assert.equal(h.counts().updates, updates); assert.equal(h.counts().disposed, 1);
});
