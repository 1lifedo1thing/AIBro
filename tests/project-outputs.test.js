const test = require('node:test');
const assert = require('node:assert/strict');
const Outputs = require('../app/project-outputs.js');
const fixture = () => ({
  projects: [{ id: 'p', name: 'Project', localFolder: { id: 'root' } }, { id: 'q', name: 'Other' }],
  conversations: [{ id: 'c', projectId: 'p', title: 'Research', messages: [] }, { id: 'd', projectId: 'p', title: 'Writing', messages: [] }],
  notes: [{ id: 'n', title: 'Summary.md', projectId: 'p', content: 'SECRET BODY' }],
  imports: [{ id: 'pdf', name: 'Report.pdf', projectId: 'p' }],
  tasks: [{ id: 'task', title: 'Check references', projectId: 'p' }], papers: [{ id: 'paper', title: 'Paper analysis', projectId: 'p' }],
  agentRuns: [], trash: []
});
const run = (id = 'r', extra = {}) => ({ id, projectId: 'p', conversationId: 'c', status: 'completed', finishedAt: 100, ...extra });
const edit = (id = 'e', extra = {}) => ({ id, projectId: 'p', candidateId: 'root', path: 'docs/result.md', status: 'pending', ...extra });
const build = (state, options = {}) => Outputs.build({ state, projectId: 'p', ...options });

test('ordinary project resources, answers and completed status never manufacture outputs', () => {
  const state = fixture(); state.agentRuns.push(run('r', { response: 'I saved Summary.md' }));
  assert.equal(build(state).items.length, 0); assert.equal(build(state).completedWithoutOutput, 1);
  assert.deepEqual(build(state).counts, { all: 0, saved: 0, review: 0 });
});
test('durable run and message refs dedupe by typed identity and retain all source conversations', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n', operation: 'created' }], fileChanges: [{ type: 'note', id: 'n' }] }), run('other', { conversationId: 'd', finishedAt: 200, results: [{ type: 'note', id: 'n' }] }));
  state.conversations[0].messages.push({ id: 'answer', role: 'assistant', runId: 'r', results: [{ type: 'note', id: 'n' }] });
  const data = build(state); assert.equal(data.items.length, 1); assert.equal(data.items[0].origins.length, 2); assert.equal(data.items[0].source.conversationId, 'd');
  assert.deepEqual(data.items[0].open, { kind: 'note', id: 'n' }); assert.equal(data.completedWithoutOutput, 0);
});
test('note/import/task/paper are all actual outputs and shared ids remain distinct', () => {
  const state = fixture(); state.imports[0].id = 'n'; state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }, { type: 'import', id: 'n' }, { type: 'task', id: 'task' }, { type: 'paper', id: 'paper' }] }));
  assert.equal(build(state).items.length, 4); assert.equal(new Set(build(state).items.map(item => item.key)).size, 4);
});
test('matched references and reverted, removed or unavailable outputs are not saved results', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n', operation: 'matched' }, { type: 'import', id: 'pdf', undoneAt: 20 }, { type: 'task', id: 'missing' }, { type: 'paper', id: 'paper', operation: 'deleted' }] }));
  assert.equal(build(state).items.length, 0); assert.equal(build(state).completedWithoutOutput, 1);
});
test('current draft is reviewable while an earlier generated saved note remains independently accessible', () => {
  const state = fixture(); state.notes[0].aiDraft = { content: 'DRAFT SECRET', provenance: { origin: { runId: 'next' } } };
  state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n', operation: 'created' }] }), run('next', { conversationId: 'd', finishedAt: 200, results: [{ type: 'note', id: 'n', operation: 'drafted' }], fileChanges: [{ type: 'note', id: 'n', operation: 'drafted' }] }));
  const data = build(state); assert.equal(data.counts.saved, 1); assert.equal(data.counts.review, 1);
  assert.deepEqual(data.items.find(item => item.group === 'review').review, { kind: 'review', runId: 'next', editId: 'n' });
  delete state.notes[0].aiDraft; assert.equal(build(state).counts.review, 0); assert.equal(build(state).counts.saved, 1);
});
test('superseded note proposal does not open a newer draft from an older run', () => {
  const state = fixture(); state.notes[0].aiDraft = { provenance: { origin: { runId: 'new' } } };
  for (const id of ['old', 'new']) state.agentRuns.push(run(id, { results: [{ type: 'note', id: 'n', operation: 'drafted' }] }));
  assert.deepEqual(build(state).items.map(item => item.source.runId), ['new']);
});
test('local proposals retain precise identities, including two proposals for the same path', () => {
  const state = fixture(); state.agentRuns.push(run('r', { localFileEdits: [edit('one'), edit('two', { status: 'partial' })] }));
  const data = build(state); assert.equal(data.counts.review, 2); assert.equal(new Set(data.items.map(item => item.key)).size, 2);
  assert.deepEqual(new Set(data.items.map(item => item.review.editId)), new Set(['one', 'two'])); assert.ok(data.items.every(item => !item.open));
});
test('applied local files are saved references; directories only open their actual change record', () => {
  const state = fixture(); state.agentRuns.push(run('r', { localFileEdits: [edit('file', { status: 'applied', afterVersion: 'sha' }), edit('folder', { status: 'applied', operation: 'mkdir', path: 'new-folder' })] }));
  const data = build(state); assert.equal(data.counts.saved, 2);
  assert.equal(data.items.find(item => !item.directory).open.kind, 'local-file'); assert.equal(data.items.find(item => item.directory).open, null);
  assert.equal(data.items.find(item => !item.directory).version, 'sha');
});
test('dismissed, undone, disconnected, invalid and duplicate local proposals are omitted', () => {
  const state = fixture(); state.agentRuns.push(run('r', { localFileEdits: [edit('1', { status: 'dismissed' }), edit('2', { status: 'undone' }), edit('3', { candidateId: 'old' }), edit('4', { path: '../outside.md' }), edit('5'), edit('5')] }));
  assert.equal(build(state).items.length, 0);
});
test('result ownership follows the actual current project, not a stale ref or title', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n', projectId: 'p' }] })); state.notes[0].projectId = 'q';
  assert.equal(build(state).items.length, 0);
  state.notes[0].projectId = 'p'; state.agentRuns[0].projectId = 'q'; assert.equal(build(state).items.length, 1);
});
test('deleted, archived, hidden, duplicate and trashed records cannot enter the index', () => {
  const changes = [s => { s.notes[0].deletedAt = 1; }, s => { s.notes[0].archived = true; }, s => { s.notes[0].hidden = true; }, s => { s.notes.push({ ...s.notes[0] }); }, s => { s.trash.push({ data: { notes: [{ id: 'n' }] } }); }];
  for (const change of changes) { const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }] })); change(state); assert.equal(build(state).items.length, 0); }
});
test('private/deleted/duplicate run or conversation cannot create outputs or no-output history', () => {
  for (const change of [s => { s.agentRuns[0].private = true; }, s => { s.conversations[0].private = true; }, s => { s.agentRuns[0].deletedAt = 1; }, s => { s.conversations[0].archivedAt = 1; }, s => { s.agentRuns.push({ ...s.agentRuns[0] }); }, s => { s.conversations.push({ ...s.conversations[0] }); }]) {
    const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }] })); change(state); assert.equal(build(state).items.length, 0); assert.equal(build(state).noOutputRuns.length, 0);
  }
});
test('private provenance redacts an aggregate shared result even if a public run also references it', () => {
  const state = fixture(); state.agentRuns.push(run('public', { results: [{ type: 'note', id: 'n' }] }), run('secret', { private: true, results: [{ type: 'note', id: 'n' }] }));
  const data = build(state); assert.equal(data.items.length, 0); assert.doesNotMatch(JSON.stringify(data), /Summary\.md|secret/);
});
test('record provenance privacy follows deleted ancestors in trash', () => {
  const state = fixture(); state.notes[0].provenance = { origin: { runId: 'private-deleted' } }; state.trash.push({ data: { agentRuns: [run('private-deleted', { private: true })] } });
  state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }] })); assert.equal(build(state).items.length, 0);
});
test('message-only durable outputs work, while user supplied or mismatched-run result objects do not', () => {
  const state = fixture(); state.conversations[0].messages.push({ id: 'good', role: 'assistant', results: [{ type: 'note', id: 'n' }] }, { id: 'user', role: 'user', results: [{ type: 'import', id: 'pdf' }] });
  state.agentRuns.push(run('foreign', { conversationId: 'd' })); state.conversations[0].messages.push({ id: 'wrong', role: 'assistant', runId: 'foreign', results: [{ type: 'paper', id: 'paper' }] });
  assert.deepEqual(build(state).items.map(item => item.id), ['n']);
});
test('recorded durable provenance restores outputs without transient result chips', () => {
  const state = fixture(); state.agentRuns.push(run()); state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r', at: 50 } };
  assert.deepEqual(build(state).items.map(item => item.id), ['n']);
  state.notes[0].provenance.output.id = 'other'; assert.equal(build(state).items.length, 0);
});
test('clearing only a completed run log retains the saved artifact, current conversation and durable source receipt', () => {
  const state = fixture(); state.agentRuns.push(run());
  state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r', at: 50 } };
  state.conversations[0].messages.push({ id: 'answer', role: 'assistant', runId: 'r', results: [{ type: 'note', id: 'n', operation: 'created' }] });
  assert.equal(build(state).counts.saved, 1);
  state.agentRuns = [];
  const before = JSON.stringify(state), data = build(state);
  assert.equal(data.counts.saved, 1); assert.equal(data.counts.review, 0);
  assert.deepEqual(data.items[0].open, { kind: 'note', id: 'n' });
  assert.equal(data.items[0].source.conversationId, 'c'); assert.equal(data.items[0].source.runId, null);
  assert.equal(data.items[0].source.recordedRunId, 'r'); assert.equal(data.items[0].at, 50);
  assert.equal(JSON.stringify(state), before);
});
test('archiving or removing a source conversation keeps its exact saved project artifact with no false navigation', () => {
  for (const lifecycle of ['archived', 'deleted', 'purged']) {
    const state = fixture(); state.agentRuns.push(run());
    state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r', at: 50 } };
    if (lifecycle === 'archived') state.conversations[0].archived = true;
    else {
      const conversation = state.conversations.shift(), oldRun = state.agentRuns.shift();
      if (lifecycle === 'deleted') state.trash.push({ type: 'conversation', data: { conversations: [conversation], runs: [oldRun] } });
    }
    const before = JSON.stringify(state), data = build(state);
    assert.equal(data.counts.saved, 1, lifecycle); assert.equal(data.counts.review, 0, lifecycle);
    assert.deepEqual(data.items[0].open, { kind: 'note', id: 'n' });
    const origin = data.items[0].source;
    assert.equal(origin.conversationAvailable, false); assert.equal(origin.runAvailable, false);
    assert.equal(origin.conversationId, null); assert.equal(origin.runId, null);
    assert.equal(origin.recordedConversationId, 'c'); assert.equal(origin.recordedRunId, 'r');
    assert.equal(origin.conversationTitle, '原对话不可用');
    assert.equal(JSON.stringify(state), before);
  }
});
test('retired source privacy and ambiguous ancestry block saved output receipts including the legacy runs key', () => {
  const mutations = [
    s => { s.trash[0].data.conversations[0].private = true; },
    s => { s.trash[0].data.runs[0].private = true; },
    s => { s.trash[0].data.agentRuns = s.trash[0].data.runs; delete s.trash[0].data.runs; s.trash[0].data.agentRuns[0].ephemeral = true; },
    s => { s.notes[0].provenance.origin.private = true; s.trash = []; },
    s => { s.notes[0].projectId = 'q'; s.projects[0].private = true; },
    s => { s.trash[0].data.runs[0].conversationId = 'other-conversation'; },
    s => { s.trash[0].data.runs.push({ ...s.trash[0].data.runs[0] }); },
    s => { s.trash[0].data.agentRuns = [{ ...s.trash[0].data.runs[0] }]; },
    s => { s.conversations.push({ ...s.trash[0].data.conversations[0] }); },
    s => { s.trash[0].data.conversations.push({ ...s.trash[0].data.conversations[0] }); },
    s => { s.notes[0].private = true; }, s => { s.notes[0].deletedAt = 1; },
    s => { s.trash[0].data.notes = [{ ...s.notes[0] }]; }, s => { s.notes.push({ ...s.notes[0] }); },
  ];
  for (const mutate of mutations) {
    const state = fixture(), conversation = state.conversations.shift();
    state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
    state.trash.push({ type: 'conversation', data: { conversations: [conversation], runs: [run()] } });
    mutate(state);
    for (const projectId of ['p', 'q']) {
      const data = build(state, { projectId });
      assert.equal(data.items.length, 0, mutate.toString());
      assert.doesNotMatch(JSON.stringify(data.items), /Summary|Research/);
    }
  }
});
test('restoring public source records restores only their real links and moving the saved artifact uses its current project', () => {
  const state = fixture(), conversation = state.conversations.shift(), execution = run();
  state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
  state.trash.push({ type: 'conversation', data: { conversations: [conversation], runs: [execution] } });
  assert.equal(build(state).items[0].source.conversationAvailable, false);
  state.notes[0].projectId = 'q'; state.projects[0].archived = true;
  assert.equal(build(state).items.length, 0);
  assert.deepEqual(build(state, { projectId: 'q' }).items[0].open, { kind: 'note', id: 'n' });
  state.projects[0].archived = false; state.trash = []; state.conversations.unshift(conversation); state.agentRuns.push(execution);
  const restored = build(state, { projectId: 'q' });
  assert.equal(restored.counts.saved, 1); assert.equal(restored.items[0].source.conversationId, 'c'); assert.equal(restored.items[0].source.runId, 'r');
  assert.equal(restored.items[0].source.conversationAvailable, true); assert.equal(restored.items[0].source.runAvailable, true);
  assert.equal(restored.items[0].projectId, 'q');
});
test('missing sources cannot promote a draft or a local proposal and known undo receipts stay excluded', () => {
  const state = fixture(), conversation = state.conversations.shift();
  state.notes[0].aiDraft = { provenance: { version: 1, output: { type: 'note', id: 'n', variant: 'draft' }, operation: 'drafted', origin: { recorded: true, conversationId: 'c', runId: 'r' } } };
  state.trash.push({ type: 'conversation', data: { conversations: [conversation], runs: [run('r', { localFileEdits: [edit('pending'), edit('applied', { status: 'applied' })] })] } });
  assert.equal(build(state).items.length, 0);
  state.notes[0].provenance = { ...state.notes[0].aiDraft.provenance, output: { type: 'note', id: 'n', variant: 'body' } };
  assert.equal(build(state).counts.saved, 1); assert.equal(build(state).counts.review, 0);
  state.trash[0].data.runs[0].fileChanges = [{ type: 'note', id: 'n', undoneAt: 2 }];
  assert.equal(build(state).items.length, 0);
});
test('historical receipt fallback never substitutes an alias or samples document and source bodies', () => {
  const state = fixture(); state.conversations.shift();
  state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
  for (const field of ['content', 'text', 'pages']) Object.defineProperty(state.notes[0], field, { configurable: true, get() { throw Error('Unexpected body read'); } });
  assert.equal(build(state).counts.saved, 1);
  const previous = global.NoteConsolidation;
  try {
    state.notes.push({ id: 'other-note', title: 'Unrelated saved body', projectId: 'p' });
    global.NoteConsolidation = { resolveId: (_, id) => id === 'n' ? 'other-note' : id };
    assert.equal(build(state).items.length, 0);
  } finally { if (previous === undefined) delete global.NoteConsolidation; else global.NoteConsolidation = previous; }
});
test('saved receipts after log cleanup still enforce exact identities, current ownership and ancestor visibility', () => {
  const changes = [
    s => { s.notes[0].deletedAt = 1; }, s => { s.notes[0].archived = true; }, s => { s.notes[0].hidden = true; },
    s => { s.notes.push({ ...s.notes[0] }); }, s => { s.trash.push({ data: { notes: [{ id: 'n' }] } }); },
    s => { s.notes[0].private = true; }, s => { s.notes[0].aiDraft = { private: true }; },
    s => { s.notes[0].provenance.origin.private = true; }, s => { s.notes[0].projectId = 'q'; },
    s => { s.projects[0].archived = true; }, s => { s.projects[0].private = true; },
    s => { s.conversations[0].private = true; },
    s => { s.conversations.push({ ...s.conversations[0] }); }, s => { s.trash.push({ data: { conversations: [{ id: 'c' }] } }); },
    s => { s.agentRuns.push(run('r', { private: true })); },
    s => { s.agentRuns.push(run(), run()); }, s => { s.agentRuns.push(run('r', { conversationId: 'd' })); },
    s => { s.trash.push({ data: { agentRuns: [run('r', { private: true })] } }); }, s => { s.trash.push({ data: { runs: [run('r', { private: true })] } }); },
    s => { delete s.notes[0].provenance; }, s => { s.notes[0].provenance.origin.recorded = false; },
    s => { s.notes[0].provenance.output.id = 'other'; }, s => { s.notes[0].provenance.output.variant = 'draft'; },
    s => { s.notes[0].provenance.operation = 'deleted'; }, s => { s.notes[0].projectMemoryType = 'daily'; },
  ];
  for (const change of changes) {
    const state = fixture();
    state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r', at: 50 } };
    change(state); assert.equal(build(state).items.length, 0, change.toString());
  }
});
test('cleanup preserves exact saved task and paper receipts and adopted bodies but never resurrects uncommitted drafts', () => {
  const state = fixture();
  for (const [type, record] of [['note', state.notes[0]], ['paper', state.papers[0]], ['task', state.tasks[0]]]) {
    record.provenance = { version: 1, output: { type, id: record.id, variant: 'body' }, operation: type === 'note' ? 'drafted' : 'created', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
  }
  state.notes[0].aiDraft = { provenance: { version: 1, output: { type: 'note', id: 'n', variant: 'draft' }, operation: 'drafted', origin: { recorded: true, conversationId: 'c', runId: 'draft-run' } } };
  assert.deepEqual(build(state).counts, { all: 3, saved: 3, review: 0 });
  state.notes[0].projectId = 'q';
  assert.equal(build(state).counts.saved, 2); assert.equal(build(state, { projectId: 'q' }).counts.saved, 1);
  delete state.notes[0].provenance;
  assert.equal(build(state, { projectId: 'q' }).items.length, 0);
});
test('query matches visible metadata and source titles; status filter retains honest total counts', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }], localFileEdits: [edit()] }));
  assert.equal(build(state, { query: 'summary Research' }).items.length, 1);
  assert.equal(build(state, { filter: 'review' }).items.length, 1); assert.equal(build(state, { filter: 'review' }).counts.all, 2);
  assert.equal(build(state, { query: 'SECRET BODY' }).items.length, 0);
});
test('no document body, response or filesystem data is read, cloned or changed', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }] }));
  for (const object of [...state.notes, ...state.imports, ...state.agentRuns]) for (const field of ['content', 'text', 'pages', 'response']) Object.defineProperty(object, field, { configurable: true, get() { throw Error('Body read: ' + field); } });
  const before = state.notes[0].title; const old = global.fetch; global.fetch = () => { throw Error('Unexpected fetch'); };
  try { assert.equal(build(state).items.length, 1); assert.equal(state.notes[0].title, before); } finally { global.fetch = old; }
});
function controller(state) {
  let props, id = 'p', calls = [], unmounted = false;
  const options = { state: () => state, projectId: () => id, mount: (_, name, value) => { assert.equal(name, 'ProjectOutputs'); props = value; return { update: value => { props = value; }, unmount: () => { unmounted = true; } }; },
    onOpen: (...args) => { calls.push(args); return true; }, onReview: (...args) => { calls.push(args); return true; }, onOpenConversation: (...args) => { calls.push(args); return true; }, onOpenRun: (...args) => { calls.push(args); return true; } };
  const mounted = Outputs.mount({}, options); return { mounted, get props() { return props; }, calls, setProject: value => { id = value; }, get unmounted() { return unmounted; } };
}
test('controller opens the exact output and supplies an aggregate restart guard', async () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }] })); const control = controller(state);
  const anchor = { marker: 'clicked output button' };
  await control.props.onOpen(control.props.items[0].key, anchor); const args = control.calls[0]; assert.equal(args[0], 'note'); assert.equal(args[1], 'n'); assert.equal(args[4](), true);
  assert.deepEqual(args[3].projectOutput, { projectId: 'p', key: control.props.items[0].key });
  assert.equal(args[5].anchor, anchor);
  assert.deepEqual(args[5].origin, { view: 'project', projectId: 'p', section: 'outputs' });
  state.notes[0].private = true; assert.equal(args[4](), false); control.mounted.dispose(); assert.equal(control.unmounted, true);
});
test('log cleanup keeps document opening and actual host restore guards valid without an invalid run link', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const state = fixture(); state.agentRuns.push(run());
  state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
  const control = controller(state), before = control.props, key = before.items[0].key;
  await before.onRun(key, 0); const runGuard = control.calls[0][1]; assert.equal(runGuard(), true);
  state.agentRuns = []; assert.equal(runGuard(), false);
  assert.equal(await before.onRun(key, 0), false); assert.equal(control.calls.length, 1);
  control.mounted.sync();
  assert.equal(control.props.items[0].source.runId, null);
  assert.equal(await control.props.onOpen(key), true);
  const args = control.calls[1], savedSource = JSON.parse(JSON.stringify(args[3]));
  assert.equal(savedSource.runId, undefined); assert.equal(savedSource.conversationId, 'c'); assert.equal(args[4](), true);
  const hostSource = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
  const start = hostSource.indexOf('function previewSourceAvailable('), end = hostSource.indexOf('\nfunction documentTabSource(', start);
  assert.ok(start >= 0 && end > start);
  const host = vm.createContext({ state, window: { ProjectOutputs: Outputs, CitationEvidence: require('../app/citation-evidence.js') } });
  vm.runInContext(hostSource.slice(start, end), host);
  assert.equal(host.previewSourceAvailable(savedSource), true);
  assert.equal(host.previewSourceAvailable({ ...savedSource, runId: 'r' }), true, 'A tab saved before log cleanup still resolves the durable project output');
  await control.props.onSource(key, 0); assert.equal(control.calls.at(-1)[0], 'c');
  state.notes[0].private = true;
  assert.equal(args[4](), false); assert.equal(host.previewSourceAvailable(savedSource), false);
  control.mounted.dispose();
});
test('source archive/delete callbacks cannot navigate while saved artifact guards survive and recheck restored privacy', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), state = fixture(); state.agentRuns.push(run());
  state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
  const control = controller(state), before = control.props, key = before.items[0].key;
  await before.onSource(key, 0); const oldSourceGuard = control.calls[0][1];
  await before.onRun(key, 0); const oldRunGuard = control.calls[1][1];
  state.conversations[0].archived = true;
  assert.equal(oldSourceGuard(), false); assert.equal(oldRunGuard(), false);
  assert.equal(await before.onSource(key, 0), false); assert.equal(await before.onRun(key, 0), false); assert.equal(control.calls.length, 2);
  control.mounted.sync(); assert.equal(await control.props.onOpen(key), true);
  const args = control.calls[2], source = JSON.parse(JSON.stringify(args[3]));
  assert.equal(source.conversationId, undefined); assert.equal(source.runId, undefined);
  assert.equal(source.sourceConversationId, 'c'); assert.equal(source.agentRunId, 'r'); assert.equal(args[4](), true);
  const code = fs.readFileSync(require.resolve('../app/app.js'), 'utf8'), start = code.indexOf('function previewSourceAvailable('), end = code.indexOf('\nfunction documentTabSource(', start);
  const host = vm.createContext({ state, window: { ProjectOutputs: Outputs, CitationEvidence: require('../app/citation-evidence.js') } });
  vm.runInContext(code.slice(start, end), host); assert.equal(host.previewSourceAvailable(source), true);
  state.trash.push({ type: 'conversation', data: { conversations: [state.conversations.shift()], runs: [state.agentRuns.shift()] } });
  assert.equal(args[4](), true); assert.equal(host.previewSourceAvailable(source), true);
  state.trash[0].data.runs[0].private = true;
  assert.equal(args[4](), false); assert.equal(host.previewSourceAvailable(source), false);
  state.trash[0].data.runs[0].private = false;
  const bundle = state.trash.shift(); state.conversations.unshift({ ...bundle.data.conversations[0], archived: false }); state.agentRuns.push(bundle.data.runs[0]);
  control.mounted.sync(); assert.equal(await control.props.onSource(key, 0), true); assert.equal(await control.props.onRun(key, 0), true);
  state.notes[0].projectId = 'q'; assert.equal(args[4](), false); assert.equal(host.previewSourceAvailable(source), false);
  control.mounted.dispose();
});
test('stale callback cannot cross project boundaries or open removed proposals', async () => {
  const state = fixture(); state.agentRuns.push(run('r', { localFileEdits: [edit()] })); const control = controller(state), callback = control.props.onReview, key = control.props.items[0].key;
  control.setProject('q'); await callback(key); assert.equal(control.calls.length, 0);
  control.setProject('p'); await callback(key); assert.equal(control.calls.length, 1); const guard = control.calls[0][3]; assert.equal(guard(), true);
  state.agentRuns[0].localFileEdits[0].status = 'dismissed'; assert.equal(guard(), false);
});
test('search and filter preferences survive a scoped sync without copying bodies into React', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }] })); const control = controller(state);
  control.props.onQuery('Summary'); control.props.onFilter('saved'); control.mounted.sync(); assert.equal(control.props.query, 'Summary'); assert.equal(control.props.filter, 'saved');
  assert.doesNotMatch(JSON.stringify(control.props), /SECRET BODY/); control.setProject('q'); control.mounted.sync(); assert.equal(control.props.query, ''); control.setProject('p'); control.mounted.sync(); assert.equal(control.props.query, 'Summary');
});
test('large output sets paginate without discarding results', () => {
  const state = fixture(); state.notes = Array.from({ length: 91 }, (_, i) => ({ id: 'n' + i, title: 'Note ' + i, projectId: 'p' })); state.agentRuns.push(run('r', { results: state.notes.map(note => ({ type: 'note', id: note.id })) }));
  const control = controller(state); assert.equal(control.props.total, 91); assert.equal(control.props.items.length, 40); assert.equal(control.props.pages, 3); control.props.onPage(2); assert.equal(control.props.items.length, 11);
});

test('adopted draft becomes a saved output only with persisted body provenance', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n', operation: 'drafted' }], fileChanges: [{ type: 'note', id: 'n', operation: 'drafted' }] }));
  assert.equal(build(state).items.length, 0);
  state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'drafted', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
  assert.equal(build(state).counts.saved, 1); assert.equal(build(state).counts.review, 0);
});
test('local edit patch and content bodies are never enumerated when building the index', () => {
  const state = fixture(), proposal = edit();
  for (const field of ['content', 'patch']) Object.defineProperty(proposal, field, { enumerable: true, get() { throw Error('Read local edit ' + field); } });
  state.agentRuns.push(run('r', { localFileEdits: [proposal] })); assert.equal(build(state).counts.review, 1);
});

test('a durable draft without a historical diff opens the current note for review instead of an empty review', async () => {
  const state = fixture(); state.notes[0].aiDraft = { provenance: { origin: { runId: 'r' } } }; state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n', operation: 'drafted' }] }));
  const control = controller(state), row = control.props.items[0]; assert.equal(row.group, 'review'); assert.equal(row.review, null);
  await control.props.onReview(row.key); assert.equal(control.calls[0][0], 'note'); assert.equal(control.calls[0][1], 'n'); assert.equal(control.calls[0][4](), true);
});

test('a moved saved note appears under its current project with the original conversation linked', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n', operation: 'created' }] })); state.notes[0].projectId = 'q';
  assert.equal(build(state).items.length, 0); const other = build(state, { projectId: 'q' }); assert.equal(other.items.length, 1); assert.equal(other.items[0].source.conversationId, 'c'); assert.equal(other.noOutputRuns.length, 0);
});
test('cross-project saved artifacts aggregate without requiring the chat to move', () => {
  const state = fixture(); state.notes[0].projectId = 'q'; state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n', operation: 'created' }] }));
  state.conversations[0].messages.push({ id: 'a', role: 'assistant', runId: 'r', results: [{ type: 'note', id: 'n' }] });
  const data = build(state, { projectId: 'q' }); assert.equal(data.items.length, 1); assert.equal(data.items[0].origins.length, 1); assert.equal(data.completedWithoutOutput, 0);
  state.conversations[0].private = true; assert.equal(build(state, { projectId: 'q' }).items.length, 0);
});
test('durable body provenance follows a moved artifact into its target project', () => {
  const state = fixture(); state.notes[0].projectId = 'q'; state.agentRuns.push(run());
  state.notes[0].provenance = { version: 1, output: { type: 'note', id: 'n', variant: 'body' }, operation: 'created', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
  assert.equal(build(state, { projectId: 'q' }).counts.saved, 1); assert.equal(build(state).counts.saved, 0);
});
test('local edits still require their exact project scope when saved artifacts cross projects', () => {
  const state = fixture(); state.projects[1].localFolder = { id: 'qroot' }; state.agentRuns.push(run('r', { localFileEdits: [edit('bad', { projectId: 'q', candidateId: 'qroot', status: 'applied' })] }));
  assert.equal(build(state, { projectId: 'q' }).items.length, 0);
});

test('source buttons retain the displayed conversation and run when origins reorder before click', async () => {
  const state = fixture(); state.agentRuns.push(run('old', { conversationId: 'c', finishedAt: 100, results: [{ type: 'note', id: 'n' }] }), run('new', { conversationId: 'd', finishedAt: 200, results: [{ type: 'note', id: 'n' }] }));
  const control = controller(state), shown = control.props, key = shown.items[0].key;
  assert.deepEqual(shown.items[0].origins.map(source => source.runId), ['new', 'old']);
  state.agentRuns[0].finishedAt = 300;
  await shown.onSource(key, 0); assert.equal(control.calls[0][0], 'd');
  await shown.onRun(key, 0); assert.equal(control.calls[1][0], 'new');
  assert.equal(control.calls[0][1](), true); assert.equal(control.calls[1][1](), true);
});
test('a removed displayed source never falls back to another origin at the same index', async () => {
  const state = fixture(); state.agentRuns.push(run('old', { conversationId: 'c', finishedAt: 100, results: [{ type: 'note', id: 'n' }] }), run('new', { conversationId: 'd', finishedAt: 200, results: [{ type: 'note', id: 'n' }] }));
  const control = controller(state), shown = control.props, key = shown.items[0].key;
  state.agentRuns = state.agentRuns.filter(value => value.id !== 'new');
  assert.equal(await shown.onSource(key, 0), false); assert.equal(await shown.onRun(key, 0), false); assert.equal(control.calls.length, 0);
  assert.equal(await shown.onSource(key, 90), false); assert.equal(control.calls.length, 0);
});
test('message-only source identity cannot silently change to a different message in the same conversation', async () => {
  const state = fixture(); state.conversations[0].messages.push({ id: 'original', role: 'assistant', createdAt: 100, results: [{ type: 'note', id: 'n' }] });
  const control = controller(state), shown = control.props, key = shown.items[0].key;
  await shown.onSource(key, 0); const guard = control.calls[0][1]; assert.equal(guard(), true);
  state.conversations[0].messages = [{ id: 'replacement', role: 'assistant', createdAt: 200, results: [{ type: 'note', id: 'n' }] }];
  assert.equal(guard(), false); assert.equal(await shown.onSource(key, 0), false); assert.equal(control.calls.length, 1);
});
test('source asynchronous guard rejects deletion, project change and disposal after dispatch', async () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }] }));
  const control = controller(state), shown = control.props, key = shown.items[0].key;
  await shown.onRun(key, 0); const guard = control.calls[0][1]; assert.equal(guard(), true);
  state.agentRuns[0].results = []; assert.equal(guard(), false); state.agentRuns[0].results = [{ type: 'note', id: 'n' }];
  control.setProject('q'); assert.equal(guard(), false); control.setProject('p'); assert.equal(guard(), true);
  control.mounted.dispose(); assert.equal(guard(), false);
});
test('no-output run callbacks keep run identity when the visible list reorders', async () => {
  const state = fixture(); state.agentRuns.push(run('old', { finishedAt: 100 }), run('new', { conversationId: 'd', finishedAt: 200 }));
  const control = controller(state), shown = control.props, selectedRunId = shown.noOutputRuns[0].runId;
  state.agentRuns[0].finishedAt = 300;
  await shown.onEmptyRun(selectedRunId); assert.equal(control.calls[0][0], 'new'); assert.equal(control.calls[0][1](), true);
  state.agentRuns = state.agentRuns.filter(value => value.id !== 'new');
  assert.equal(control.calls[0][1](), false); assert.equal(await shown.onEmptyRun(selectedRunId), false); assert.equal(control.calls.length, 1);
});
test('no-output run callbacks reject a reassigned origin and newly delivered output', async () => {
  const state = fixture(); state.agentRuns.push(run()); const control = controller(state), shown = control.props;
  state.agentRuns[0].conversationId = 'd'; assert.equal(await shown.onEmptyRun('r'), false);
  state.agentRuns[0].conversationId = 'c'; await shown.onEmptyRun('r'); const guard = control.calls[0][1]; assert.equal(guard(), true);
  state.agentRuns[0].results = [{ type: 'note', id: 'n' }]; assert.equal(guard(), false); assert.equal(await shown.onEmptyRun('r'), false);
});
test('old output callbacks cannot follow a moved record into another selected project', async () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [{ type: 'note', id: 'n' }] })); const control = controller(state), shown = control.props, key = shown.items[0].key;
  state.notes[0].projectId = 'q'; control.setProject('q');
  assert.equal(build(state, { projectId: 'q' }).items.length, 1);
  assert.equal(await shown.onOpen(key), false); assert.equal(await shown.onSource(key, 0), false); assert.equal(control.calls.length, 0);
});

test('real ProjectMemory settlement with no results produces no deliverables despite daily/plan side effects', () => {
  const Memory = require('../app/project-memory.js'), state = fixture();
  const execution = run('memory-only', { startedAt: new Date(2026, 8, 30, 10).getTime(), results: [], goal: 'Explain the material without creating a document.' });
  state.agentRuns.push(execution);
  execution.memoryNoteIds = Memory.settle(state, execution).map(note => note.id);
  assert.ok(execution.memoryNoteIds.length >= 2);
  assert.ok(execution.memoryNoteIds.some(id => state.notes.find(note => note.id === id).projectMemoryType === 'daily'));
  assert.ok(execution.memoryNoteIds.some(id => state.notes.find(note => note.id === id).projectMemoryType === 'plan'));
  const data = build(state);
  assert.deepEqual(data.counts, { all: 0, saved: 0, review: 0 });
  assert.equal(data.completedWithoutOutput, 1); assert.equal(data.noOutputRuns[0].runId, 'memory-only');
});
test('real pending long-term memory proposal never labels its existing body as a saved result', () => {
  const Memory = require('../app/project-memory.js'), state = fixture();
  state.conversations[0].messages.push({ id: 'u', role: 'user', text: 'Use Chinese for this project.' });
  const execution = run('memory-proposal', { startedAt: new Date(2026, 8, 30, 11).getTime(), results: [], userMessageId: 'u', memoryUpdates: [{ type: 'preference', text: 'Use Chinese.', quote: 'Use Chinese for this project.', conversationId: 'c', messageId: 'u' }] });
  state.agentRuns.push(execution);
  execution.memoryNoteIds = Memory.settle(state, execution).map(note => note.id);
  const long = Memory.find(state, 'p', 'long');
  assert.equal(long.aiDraft.reason, 'project-memory-proposal'); assert.equal(long.aiDraft.sourceConversationId, 'c'); assert.equal(long.aiDraft.provenance, undefined);
  assert.ok(execution.memoryNoteIds.includes(long.id));
  const data = build(state); assert.equal(data.counts.saved, 0); assert.equal(data.counts.review, 0); assert.equal(data.completedWithoutOutput, 1);
  assert.doesNotMatch(JSON.stringify(data.items), /长期记忆|项目计划|进展日记/);
  assert.ok(long.aiDraft); // Indexing did not discard the actual pending memory.
});
test('memory results, fileChanges, message chips and provenance cannot promote system records to user outputs', () => {
  const Memory = require('../app/project-memory.js'), state = fixture(), execution = run('r', { results: [] }); state.agentRuns.push(execution);
  execution.memoryNoteIds = Memory.settle(state, execution).map(note => note.id);
  const plan = Memory.find(state, 'p', 'plan'), ref = { type: 'note', id: plan.id, operation: 'updated' };
  execution.results = [ref]; execution.fileChanges = [ref];
  state.conversations[0].messages.push({ id: 'a', role: 'assistant', runId: 'r', results: [ref] });
  plan.provenance = { version: 1, output: { type: 'note', id: plan.id, variant: 'body' }, operation: 'updated', origin: { recorded: true, conversationId: 'c', runId: 'r' } };
  assert.deepEqual(build(state).counts, { all: 0, saved: 0, review: 0 }); assert.equal(build(state).completedWithoutOutput, 1);
});
test('memoryNoteIds alone is not output evidence even if a legacy entry points at an ordinary note', () => {
  const state = fixture(); state.agentRuns.push(run('r', { results: [], memoryNoteIds: ['n'] }));
  assert.equal(build(state).items.length, 0); assert.equal(build(state).completedWithoutOutput, 1);
  state.agentRuns[0].results = [{ type: 'note', id: 'n', operation: 'created' }]; assert.equal(build(state).counts.saved, 1);
});
test('real saved artifacts and review proposals remain visible alongside automatic memory settlement', () => {
  const Memory = require('../app/project-memory.js'), state = fixture();
  state.notes.push({ id: 'draft-note', title: 'Proposed review.md', projectId: 'p', content: 'Original', aiDraft: { content: 'Proposed', provenance: { origin: { runId: 'r' } } } });
  const execution = run('r', { results: [{ type: 'note', id: 'n', operation: 'created' }, { type: 'note', id: 'draft-note', operation: 'drafted' }], fileChanges: [{ type: 'note', id: 'draft-note', operation: 'drafted' }], localFileEdits: [edit('proposal')] });
  state.agentRuns.push(execution); execution.memoryNoteIds = Memory.settle(state, execution).map(note => note.id);
  const data = build(state); assert.deepEqual(data.counts, { all: 3, saved: 1, review: 2 }); assert.equal(data.completedWithoutOutput, 0);
  assert.ok(data.items.some(item => item.id === 'n' && item.group === 'saved'));
  assert.ok(data.items.some(item => item.id === 'draft-note' && item.review?.editId === 'draft-note'));
  assert.ok(data.items.some(item => item.review?.editId === 'proposal'));
  assert.ok(data.items.every(item => !execution.memoryNoteIds.includes(item.id)));
});
