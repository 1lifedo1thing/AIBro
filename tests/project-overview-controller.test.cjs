const test = require('node:test');
const assert = require('node:assert/strict');
const Overview = require('../app/project-overview.js');
const Outputs = require('../app/project-outputs.js');

function fixture() {
  return {
    projects: [{ id: 'a', name: 'Research', description: 'A real project', localFolder: { id: 'folder' } }, { id: 'b', name: 'Other' }],
    conversations: [{ id: 'ca', projectId: 'a', title: 'Reading', messages: [] }, { id: 'cb', projectId: 'b', messages: [] }],
    tasks: [
      { id: 'done', projectId: 'a', status: 'done', title: 'Finished', dueAt: '2026-09-01' },
      { id: 'late', projectId: 'a', status: 'blocked', title: 'Later task', dueAt: '2026-10-05', updatedAt: 900 },
      { id: 'earlier-old', projectId: 'a', status: 'todo', title: 'Earlier old', dueAt: '2026-10-01', updatedAt: 100 },
      { id: 'earlier-new', projectId: 'a', status: 'in_progress', title: 'Earlier new', dueAt: '2026-10-01', updatedAt: 200, description: 'SECRET TASK BODY' },
      { id: 'undated', projectId: 'a', title: 'No deadline', updatedAt: 999 },
      { id: 'other-task', projectId: 'b', title: 'Other project task' }
    ],
    notes: [
      { id: 'n', projectId: 'a', title: 'Saved document', content: 'SECRET NOTE BODY' },
      ...['daily', 'plan', 'long'].map(type => ({ id: type, projectId: 'a', projectMemoryType: type, title: `Record ${type}`, content: 'SECRET MEMORY BODY' })),
      { id: 'ordinary', projectId: 'a', projectMemoryType: 'future-type', folderPath: 'records/daily', title: 'daily' },
      { id: 'nb', projectId: 'b', title: 'Other output' }
    ],
    imports: [{ id: 'pdf', projectId: 'a', name: 'Paper.pdf', text: 'SECRET FILE BODY' }],
    papers: [{ id: 'paper', projectId: 'a', title: 'Paper', content: 'SECRET PAPER BODY' }],
    agentRuns: [
      { id: 'ra', projectId: 'a', conversationId: 'ca', status: 'completed', finishedAt: 2000, results: [{ type: 'note', id: 'n', operation: 'created' }], localFileEdits: [{ id: 'edit', projectId: 'a', candidateId: 'folder', path: 'docs/proposal.md', status: 'partial', updatedAt: 3000, content: 'SECRET PROPOSAL BODY' }] },
      { id: 'rb', projectId: 'b', conversationId: 'cb', status: 'completed', finishedAt: 1000, results: [{ type: 'note', id: 'nb' }] },
      { id: 'empty', projectId: 'a', conversationId: 'ca', status: 'completed', response: 'A claimed output without a receipt' }
    ], trash: []
  };
}
const build = (state, options = {}) => Overview.build({ state, projectId: 'a', ...options });
const counts = model => [model.taskCount, model.doneCount, model.sourceCount, model.recordCount, model.outputCount, model.reviewCount];

test('overview composes real output receipts and complete typed counts using metadata only', () => {
  const state = fixture(), before = JSON.stringify(state);
  const model = build(state, { formatDate: value => `due:${value}`, formatRelative: value => `updated:${value}` });
  assert.equal(model.available, true); assert.equal(model.description, 'A real project');
  assert.deepEqual(counts(model), [5, 1, 4, 3, 2, 1]);
  assert.deepEqual(model.tasks.map(row => row.id), ['earlier-new', 'earlier-old', 'late']);
  assert.equal(model.tasks[0].dueLabel, 'due:2026-10-01');
  assert.equal(model.tasks[0].statusLabel, '进行中');
  const actual = Outputs.build({ state, projectId: 'a' });
  assert.deepEqual(model.outputs.map(row => row.key), actual.items.slice(0, 4).map(row => row.key));
  assert.deepEqual(model.outputs.map(row => row.review), [true, false]);
  assert.equal(model.outputs[0].statusLabel, '部分应用');
  assert.equal(model.outputs[0].updatedLabel, 'updated:3000');
  assert.doesNotMatch(JSON.stringify(model), /SECRET|claimed output|conversationId|agentRunId|candidateId/);
  assert.equal(JSON.stringify(state), before);
});

test('no tasks does not hide existing sources or real saved and review outputs', () => {
  const state = fixture(); state.tasks = [];
  const model = build(state);
  assert.equal(model.available, true); assert.equal(model.taskCount, 0); assert.deepEqual(model.tasks, []);
  assert.equal(model.sourceCount, 4); assert.equal(model.outputCount, 2); assert.equal(model.outputs.length, 2);
  state.agentRuns = []; assert.equal(build(state).sourceCount, 4);
  assert.equal(build(state).outputCount, 0, 'ordinary resources do not manufacture an output receipt');
});

test('recent output preview is bounded to four rows while saved and review totals stay complete', () => {
  const state = fixture();
  for (let index = 0; index < 5; index++) {
    state.notes.push({ id: `extra-${index}`, projectId: 'a', title: `Extra ${index}` });
    state.agentRuns.push({ id: `extra-run-${index}`, projectId: 'a', conversationId: 'ca', finishedAt: 4000 + index, status: 'completed', results: [{ type: 'note', id: `extra-${index}` }] });
  }
  const model = build(state);
  assert.equal(model.outputCount, 7); assert.equal(model.reviewCount, 1); assert.equal(model.outputs.length, 4);
  assert.deepEqual(model.outputs.map(row => row.title), ['Extra 4', 'Extra 3', 'Extra 2', 'Extra 1']);
});

test('real citation ancestry filters direct, captured and retired private records from all source and task counts', () => {
  const state = fixture();
  state.conversations.push({ id: 'private-chat', private: true });
  state.agentRuns.push({ id: 'private-run', conversationId: 'private-chat' });
  state.trash.push({ data: { runs: [{ id: 'retired-run', private: true }], conversations: [{ id: 'retired-chat', incognito: true }] } });
  const hidden = [{ private: true }, { ephemeral: true }, { incognito: true }, { provenance: { origin: { private: true } } },
    { sourceConversationId: 'private-chat' }, { agentRunId: 'private-run' }, { provenance: { origin: { runId: 'retired-run' } } },
    { conversationId: 'retired-chat' }, { deletedAt: 1 }, { archivedAt: 1 }, { hidden: true }];
  for (const collection of ['tasks', 'notes', 'imports', 'papers']) {
    for (const [index, fields] of hidden.entries()) state[collection].push({ id: `${collection}-${index}`, projectId: 'a', title: 'SECRET HIDDEN TITLE', ...fields });
    state[collection].push({ id: `duplicate-${collection}`, projectId: 'a', title: 'SECRET DUPLICATE' }, { id: `duplicate-${collection}`, projectId: 'a', title: 'SECRET DUPLICATE' });
    state[collection].push({ projectId: 'a', title: 'SECRET NO ID' });
  }
  const model = build(state);
  assert.deepEqual(counts(model), [5, 1, 4, 3, 2, 1]);
  assert.doesNotMatch(JSON.stringify(model), /SECRET/);
});

test('private, deleted, duplicate and retired-private project owners expose no description or rows', () => {
  for (const mutate of [
    state => { state.projects[0].private = true; },
    state => { state.projects[0].deletedAt = 1; },
    state => { state.projects[0].archived = true; },
    state => { state.projects.push({ ...state.projects[0] }); },
    state => { state.trash.push({ data: { projects: [{ id: 'a', incognito: true }] } }); },
    state => { state.projects[0].provenance = { origin: { private: true } }; }
  ]) {
    const state = fixture(); mutate(state); const model = build(state);
    assert.equal(model.available, false); assert.deepEqual(counts(model), [0, 0, 0, 0, 0, 0]);
    assert.equal(model.description, ''); assert.deepEqual(model.tasks, []); assert.deepEqual(model.outputs, []);
  }
});

test('exact note memory types define records; same ids across entity types remain distinct public sources', () => {
  const state = fixture();
  state.imports[0].id = 'n'; state.imports[0].projectMemoryType = 'daily';
  state.papers[0].id = 'n'; state.papers[0].projectMemoryType = 'plan';
  const model = build(state);
  assert.equal(model.sourceCount, 4); assert.equal(model.recordCount, 3);
  assert.equal(build(state, { projectId: 'b' }).sourceCount, 1);
});

test('pending deadlines sort before undated tasks without treating invalid dates as real deadlines', () => {
  const state = fixture(); state.tasks = [
    { id: 'invalid', projectId: 'a', title: 'Invalid', dueAt: '2026-02-31', updatedAt: 1 },
    { id: 'none', projectId: 'a', title: 'Undated', updatedAt: 300 },
    { id: 'real', projectId: 'a', title: 'Real', dueAt: '2026-10-10', updatedAt: 1 },
    { id: 'done', projectId: 'a', status: 'done', dueAt: '2026-01-01' }
  ];
  const model = build(state);
  assert.deepEqual(model.tasks.map(row => row.id), ['real', 'none', 'invalid']);
  assert.equal(model.tasks[2].dueLabel, ''); assert.equal(model.doneCount, 1);
});

test('unknown legacy task statuses produce scalar fallback labels without inherited object properties', () => {
  const state = fixture(); state.tasks = [{ id: 'legacy', projectId: 'a', title: 'Legacy', status: '__proto__' }];
  const model = build(state);
  assert.equal(model.taskCount, 1); assert.equal(model.doneCount, 0);
  assert.equal(model.tasks[0].statusLabel, '待开始');
  assert.ok(Object.values(model.tasks[0]).every(value => typeof value === 'string'));
});

test('English interface labels do not translate user titles or descriptions', () => {
  const previous = global.WorkstationI18n;
  global.WorkstationI18n = { getLanguage: () => 'en' };
  try {
    const state = fixture(); state.tasks[3].title = '真实任务'; state.projects[0].description = '原始描述';
    const model = build(state);
    assert.equal(model.tasks[0].title, '真实任务'); assert.equal(model.tasks[0].statusLabel, 'In progress');
    assert.equal(model.description, '原始描述'); assert.equal(model.outputs[0].statusLabel, 'Partially applied');
    assert.equal(model.outputs[0].typeLabel, 'File');
  } finally { global.WorkstationI18n = previous; }
});

function harness(overrides = {}) {
  let state = fixture(), projectId = 'a', props;
  const lifecycle = [], calls = [], toasts = [], host = { isConnected: true };
  const hooks = Object.fromEntries(['onTask', 'onOutput', 'onNavigate', 'onAddSources', 'onAddTask', 'onStart'].map(name => [name, (...args) => { calls.push([name, ...args]); return true; }]));
  const control = Overview.mount(host, { state: () => state, projectId: () => projectId, ...hooks,
    toast: text => toasts.push(text), mount: (container, name, value) => {
      assert.equal(container, host); assert.equal(name, 'ProjectOverview'); props = value; lifecycle.push('mount');
      return { update(value) { props = value; lifecycle.push('update'); }, unmount() { lifecycle.push('unmount'); } };
    }, ...overrides });
  return { control, calls, lifecycle, toasts, host, get state() { return state; }, get props() { return props; },
    switch(id) { projectId = id; control.sync(); }, replace(value) { state = value; control.sync(); } };
}

test('controller preserves a same-owner root and retires every old callback across project and state owner changes', async () => {
  const h = harness(), old = h.props;
  h.state.projects[0].description = 'Updated'; h.control.sync();
  assert.deepEqual(h.lifecycle, ['mount', 'update']);
  h.switch('b'); h.switch('a');
  assert.deepEqual(h.lifecycle, ['mount', 'update', 'unmount', 'mount', 'unmount', 'mount']);
  const staleActions = async props => {
    await props.onTask(props.tasks[0].id); await props.onOutput(props.outputs[0].key); await props.onNavigate('knowledge');
    await props.onAddSources(); await props.onAddTask(); await props.onStart();
  };
  await staleActions(old); assert.equal(h.calls.length, 0);
  const ownerOld = h.props; h.replace(fixture()); await staleActions(ownerOld); assert.equal(h.calls.length, 0);
  const current = h.props; await current.onStart(); assert.equal(h.calls[0][0], 'onStart');
  h.control.dispose(); const length = h.lifecycle.length;
  await staleActions(current); h.control.sync(); h.control.update({ projectId: 'b' });
  assert.equal(h.calls.length, 1); assert.equal(h.lifecycle.length, length);
});

test('task and output callbacks pass exact anchors and current guards that recheck live privacy and ownership', async () => {
  const h = harness(), anchor = { node: 'actual-button' }, taskId = h.props.tasks[0].id, outputKey = h.props.outputs[0].key;
  await h.props.onTask(taskId, anchor); await h.props.onOutput(outputKey, anchor);
  assert.equal(h.calls[0][1], taskId); assert.equal(h.calls[0][3], anchor); assert.equal(h.calls[0][2](), true);
  assert.equal(h.calls[1][1], outputKey); assert.equal(h.calls[1][3], anchor); assert.equal(h.calls[1][2](), true);
  h.state.tasks.find(task => task.id === taskId).provenance = { origin: { private: true } };
  h.state.agentRuns[0].private = true;
  assert.equal(h.calls[0][2](), false); assert.equal(h.calls[1][2](), false);
  await h.props.onTask(taskId, anchor); await h.props.onOutput(outputKey, anchor);
  assert.equal(h.calls.length, 2); h.control.dispose();
});

test('unshown target ids and invalid navigation sections cannot invoke hooks; project privacy blocks all actions', async () => {
  const h = harness();
  await h.props.onTask('other-task'); await h.props.onTask('undated'); await h.props.onOutput('made-up');
  await h.props.onNavigate('records'); await h.props.onNavigate('__proto__'); assert.equal(h.calls.length, 0);
  await h.props.onNavigate('knowledge'); assert.equal(h.calls[0][1], 'knowledge'); assert.equal(h.calls[0][2](), true);
  h.state.projects[0].private = true; assert.equal(h.calls[0][2](), false);
  await h.props.onNavigate('tasks'); await h.props.onAddSources(); await h.props.onAddTask(); await h.props.onStart();
  assert.equal(h.calls.length, 1); h.control.dispose();
});

test('detached hosts cannot open old content and old asynchronous failures do not toast in another epoch', async () => {
  const h = harness(); h.host.isConnected = false;
  await h.props.onTask(h.props.tasks[0].id); await h.props.onStart(); assert.equal(h.calls.length, 0); h.control.dispose();
  let reject;
  const pending = new Promise((resolve, fail) => { reject = fail; });
  const asyncHost = harness({ onStart: () => pending });
  const action = asyncHost.props.onStart(); asyncHost.switch('b'); asyncHost.switch('a');
  const count = asyncHost.lifecycle.length; reject(new Error('old failure')); assert.equal(await action, false);
  assert.deepEqual(asyncHost.toasts, []); assert.equal(asyncHost.lifecycle.length, count); asyncHost.control.dispose();
});

test('current business callback failures report an error without manufacturing an operation', async () => {
  const h = harness({ onAddTask: () => { throw new Error('Unable to open task editor'); } });
  assert.equal(await h.props.onAddTask(), false); assert.deepEqual(h.toasts, ['Unable to open task editor']);
  assert.deepEqual(h.calls, []); h.control.dispose();
});
