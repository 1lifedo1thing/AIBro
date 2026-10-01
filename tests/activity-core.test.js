const test = require('node:test');
const assert = require('node:assert/strict');
const Activity = require('../app/activity-core.js');

test('aggregates a cross-month window by local calendar date', () => {
  const state = {
    projects: [{ id: 'archived', workspace: '课程', archived: true }, { id: 'active', workspace: '科研' }],
    tasks: [
      { id: 't1', completedAt: '2026-02-28', workspace: '科研' },
      { id: 't2', completedAt: '2026-03-01T14:00:00', projectId: 'active' },
      { id: 't3', completedAt: '2026-03-01', projectId: 'archived' },
      { id: 't4', completedAt: '2026-03-02', archived: true }
    ],
    notes: [{ id: 'n1', createdAt: '2026-03-01', workspace: '科研' }, { id: 'n2', createdAt: '2026-02-28', projectId: 'archived' }],
    imports: [{ id: 'i1', createdAt: '2026-03-01', workspace: '课程' }, { id: 'i2', createdAt: '2026-02-27', workspace: '日常' }]
  };
  const result = Activity.aggregate(state, { now: new Date(2026, 2, 3, 12), days: 7 });
  assert.deepEqual(result.keys, ['2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03']);
  assert.deepEqual(result.series.map(day => [day.tasks, day.materials]), [[0, 0], [0, 0], [0, 1], [1, 0], [1, 2], [0, 0], [0, 0]]);
  assert.deepEqual(result.totals, { tasks: 2, materials: 3 });
});

test('workspace filter changes chart totals while progress remains attributable', () => {
  const state = { projects: [], tasks: [{ id: 'course-task', completedAt: '2026-09-09', workspace: '课程' }], notes: [{ id: 'research-note', createdAt: '2026-09-09', workspace: '科研' }], imports: [{ id: 'daily-import', createdAt: '2026-09-09', workspace: '日常' }] };
  const all = Activity.aggregate(state, { now: new Date(2026, 8, 10), days: 7 });
  assert.equal(all.totals.tasks + all.totals.materials, 3);
  assert.deepEqual(all.workspaces['课程'], { workspace: '课程', tasks: 1, materials: 0, total: 1, daysActive: 1 });
  const course = Activity.aggregate(state, { now: new Date(2026, 8, 10), days: 7, workspace: '课程' });
  assert.equal(course.totals.tasks, 1); assert.equal(course.totals.materials, 0); assert.equal(course.workspaces['课程'].total, 1); assert.equal(course.workspaces['科研'].total, 0);
});

test('invalid dates and unsupported workspace values do not create phantom activity', () => {
  const result = Activity.aggregate({ projects: [], tasks: [{ id: 'invalid-date', completedAt: 'garbage' }, { id: 'fallback-workspace', completedAt: '2026-09-10', workspace: 'other' }], notes: [], imports: [] }, { now: new Date(2026, 8, 10), days: 7, workspace: 'other' });
  assert.equal(result.workspace, null); assert.equal(result.totals.tasks, 1); assert.equal(result.workspaces['日常'].total, 1);
});

test('project analytics exclude other projects and reopened tasks with stale completion timestamps', () => {
  const state = {
    projects: [{ id: 'selected', workspace: '科研' }, { id: 'other', workspace: '科研' }],
    tasks: [
      { id: 'done', projectId: 'selected', workspace: '日常', status: 'done', completedAt: '2026-09-10' },
      { id: 'reopened', projectId: 'selected', status: 'todo', completedAt: '2026-09-10' },
      { id: 'other', projectId: 'other', status: 'done', completedAt: '2026-09-10' },
      { id: 'loose', workspace: '科研', status: 'done', completedAt: '2026-09-10' }
    ],
    notes: [{ id: 'selected-note', projectId: 'selected', createdAt: '2026-09-09' }, { id: 'other-note', projectId: 'other', createdAt: '2026-09-08' }]
  };
  const result = Activity.aggregate(state, { now: new Date(2026, 8, 10), workspace: '科研', projectId: 'selected' });
  assert.deepEqual(result.totals, { tasks: 1, materials: 1 });
  assert.equal(result.workspaces['科研'].daysActive, 2);
  assert.equal(result.workspaces['日常'].daysActive, 0);
});

test('invalid calendar dates cannot roll forward into a real activity day', () => {
  assert.equal(Activity.dateKey('2026-02-31'), null);
  assert.equal(Activity.dateKey('2026-13-01'), null);
  assert.equal(Activity.dateKey('2026-00-10'), null);
  const result = Activity.aggregate({ imports: [{ id: 'invalid-import', createdAt: '2026-02-31' }] }, { now: new Date(2026, 2, 5) });
  assert.equal(result.totals.materials, 0);
});

test('workspace totals and active-day counts obey the same archived and workspace filters', () => {
  const result = Activity.aggregate({ projects: [{ id: 'old', workspace: '课程', archived: true }], notes: [
    { id: 'old-note', projectId: 'old', createdAt: '2026-09-10' },
    { id: 'daily-note', workspace: '日常', createdAt: '2026-09-10' },
    { id: 'course-note', workspace: '课程', createdAt: '2026-09-10' }
  ] }, { workspace: '课程', now: new Date(2026, 8, 10) });
  assert.equal(result.workspaces['日常'].total, 0); assert.equal(result.workspaces['日常'].daysActive, 0);
  assert.equal(result.workspaces['课程'].total, 1); assert.equal(result.workspaces['课程'].daysActive, 1);
});

test('archiving, deleting and restoring a project changes every current activity total without deleting its records', () => {
  const project = { id: 'durable', workspace: '科研' };
  const state = { projects: [project],
    tasks: [{ id: 'task', projectId: project.id, status: 'done', completedAt: '2026-09-10' }],
    notes: [{ id: 'note', projectId: project.id, createdAt: '2026-09-10' }],
    imports: [{ id: 'pdf', projectId: project.id, createdAt: '2026-09-09' }]
  };
  const retained = JSON.stringify([state.tasks, state.notes, state.imports]);
  const now = new Date(2026, 8, 10);
  const assertTotals = (expected) => {
    for (const scope of [{}, { workspace: '科研' }, { projectId: project.id, workspace: '科研' }]) {
      const result = Activity.aggregate(state, { ...scope, now });
      assert.deepEqual(result.totals, expected);
      assert.equal(result.workspaces['科研'].total, expected.tasks + expected.materials);
      assert.equal(result.workspaces['科研'].daysActive, expected.materials ? 2 : 0);
    }
  };
  assertTotals({ tasks: 1, materials: 2 });
  project.archived = true;
  assertTotals({ tasks: 0, materials: 0 });
  project.archived = false; project.deletedAt = Date.now();
  assertTotals({ tasks: 0, materials: 0 });
  delete project.deletedAt; state.projects = [];
  assertTotals({ tasks: 0, materials: 0 });
  state.projects = [project];
  assertTotals({ tasks: 1, materials: 2 });
  assert.equal(JSON.stringify([state.tasks, state.notes, state.imports]), retained);
});

test('unassigned active content remains visible, while orphaned and independently archived records do not', () => {
  const state = {
    projects: [{ id: 'active', workspace: '课程' }],
    tasks: [
      { id: 'unassigned-task', status: 'done', completedAt: '2026-09-10', workspace: '日常' },
      { id: 'orphan-task', status: 'done', completedAt: '2026-09-10', projectId: 'missing' },
      { id: 'archived-task', status: 'done', completedAt: '2026-09-10', projectId: 'active', archived: true }
    ],
    notes: [
      { id: 'unassigned-note', createdAt: '2026-09-10', workspace: '日常' },
      { id: 'orphan-note', createdAt: '2026-09-10', projectId: 'missing' },
      { id: 'deleted-note', createdAt: '2026-09-10', projectId: 'active', deletedAt: 1 }
    ],
    imports: [
      { id: 'unassigned-import', createdAt: '2026-09-10', projectId: null, workspace: '日常' },
      { id: 'orphan-import', createdAt: '2026-09-10', projectId: 'missing' },
      { id: 'archived-import', createdAt: '2026-09-10', projectId: 'active', archived: true }
    ]
  };
  const result = Activity.aggregate(state, { now: new Date(2026, 8, 10) });
  assert.deepEqual(result.totals, { tasks: 1, materials: 2 });
  assert.equal(result.workspaces['课程'].total, 0);
  assert.equal(result.workspaces['日常'].total, 3);
});

test('archiving or removing an originating conversation does not erase active project knowledge from analytics', () => {
  const state = {
    projects: [{ id: 'research', workspace: '科研' }],
    conversations: [{ id: 'reading', projectId: 'research', archived: true }],
    notes: [{ id: 'analysis', sourceConversationId: 'reading', projectId: 'research', createdAt: '2026-09-10' }],
    imports: [{ id: 'paper', conversationId: 'reading', projectId: 'research', createdAt: '2026-09-10' }]
  };
  const before = JSON.stringify(state);
  const options = { now: new Date(2026, 8, 10) };
  assert.deepEqual(Activity.aggregate(state, options).totals, { tasks: 0, materials: 2 });
  assert.equal(JSON.stringify(state), before);
  state.conversations = [];
  assert.deepEqual(Activity.aggregate(state, options).totals, { tasks: 0, materials: 2 });
});

test('day drilldown uses exactly the aggregate eligibility rules and excludes note bodies', () => {
  const state = {projects:[{id:'a',workspace:'课程'},{id:'b',workspace:'科研'}], tasks:[{id:'t',projectId:'a',status:'done',completedAt:'2026-09-10'}], imports:[{id:'i',projectId:'a',name:'课件.pdf',createdAt:'2026-09-10'},{id:'other',projectId:'b',createdAt:'2026-09-10'}], notes:[{id:'n',projectId:'a',title:'知识',content:'private body',createdAt:'2026-09-10'}]};
  const before=JSON.stringify(state), result=Activity.aggregate(state,{projectId:'a',now:new Date(2026,8,10)}), day=result.series.at(-1);
  assert.deepEqual(day.entries.map(item=>[item.type,item.id]),[['task','t'],['note','n'],['import','i']]);
  assert.equal(day.entries.length,day.tasks+day.materials); assert.doesNotMatch(JSON.stringify(day.entries),/private body/); assert.equal(JSON.stringify(state),before);
});

test('real evidence ancestry excludes private records from totals, every day and workspace without mutating history', () => {
  const variants = [
    { private: true }, { ephemeral: true }, { incognito: true },
    { provenance: { origin: { private: true } } },
    { sourceConversationId: 'private-conversation' },
    { agentRunId: 'private-run' },
    { provenance: { origin: { runId: 'retired-run' } } },
    { conversationId: 'retired-conversation' },
    { agentRunId: 'retired-project-run' }
  ];
  const state = {
    projects: [{ id: 'public', workspace: '科研' }],
    conversations: [{ id: 'private-conversation', private: true }],
    agentRuns: [{ id: 'private-run', incognito: true }, { id: 'retired-project-run', projectId: 'retired-project' }],
    trash: [{ data: {
      runs: [{ id: 'retired-run', private: true }],
      conversations: [{ id: 'retired-conversation', ephemeral: true }],
      projects: [{ id: 'retired-project', private: true }]
    } }]
  };
  for (const collection of ['tasks', 'notes', 'imports']) {
    const base = { projectId: 'public', createdAt: '2026-09-10', completedAt: '2026-09-10', status: collection === 'tasks' ? 'done' : undefined };
    state[collection] = [{ ...base, id: `safe-${collection}`, title: `Public ${collection}` }, ...variants.map((fields, index) => ({ ...base, ...fields, id: `${collection}-${index}`, title: `SECRET ${collection} ${index}` }))];
  }
  const before = JSON.stringify(state);
  for (const scope of [{}, { projectId: 'public' }, { workspace: '科研' }]) {
    const result = Activity.aggregate(state, { ...scope, now: new Date(2026, 8, 10) });
    assert.deepEqual(result.totals, { tasks: 1, materials: 2 });
    assert.deepEqual(result.series.at(-1).entries.map(row => [row.type, row.id]), [['task', 'safe-tasks'], ['note', 'safe-notes'], ['import', 'safe-imports']]);
    for (const day of result.series) assert.equal(day.entries.length, day.tasks + day.materials);
    assert.deepEqual(result.workspaces['科研'], { workspace: '科研', tasks: 1, materials: 2, total: 3, daysActive: 1 });
    assert.equal(Object.values(result.workspaces).reduce((sum, item) => sum + item.total, 0), 3);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
  assert.equal(JSON.stringify(state), before);
});

test('duplicate typed and project identities fail closed while the same id across types remains public and unassigned', () => {
  const state = { projects: [{ id: 'ambiguous', workspace: '科研' }, { id: 'ambiguous', workspace: '科研' }] };
  for (const collection of ['tasks', 'notes', 'imports']) {
    const base = { createdAt: '2026-09-10', completedAt: '2026-09-10', status: collection === 'tasks' ? 'done' : undefined };
    state[collection] = [
      { ...base, id: 'shared', title: `Public ${collection}` },
      { ...base, id: 'duplicate', title: 'SECRET first duplicate' },
      { ...base, id: 'duplicate', title: 'SECRET second duplicate' },
      { ...base, id: 'ambiguous-owner', projectId: 'ambiguous', title: 'SECRET ambiguous project' },
      { ...base, title: 'SECRET missing identity' }
    ];
  }
  const result = Activity.aggregate(state, { now: new Date(2026, 8, 10) });
  assert.deepEqual(result.totals, { tasks: 1, materials: 2 });
  assert.deepEqual(result.series.at(-1).entries.map(row => [row.type, row.id]), [['task', 'shared'], ['note', 'shared'], ['import', 'shared']]);
  assert.deepEqual(result.workspaces['日常'], { workspace: '日常', tasks: 1, materials: 2, total: 3, daysActive: 1 });
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('aggregation rebuilds its evidence context when a retained origin becomes private', () => {
  const state = { notes: [{ id: 'note', title: 'Previously public', createdAt: '2026-09-10', provenance: { origin: { conversationId: 'origin' } } }], conversations: [{ id: 'origin' }] };
  const options = { now: new Date(2026, 8, 10) };
  assert.equal(Activity.aggregate(state, options).totals.materials, 1);
  state.conversations[0].private = true;
  const result = Activity.aggregate(state, options);
  assert.deepEqual(result.totals, { tasks: 0, materials: 0 });
  assert.ok(result.series.every(day => day.entries.length === 0));
  assert.doesNotMatch(JSON.stringify(result), /Previously public/);
});

test('browser core fails closed before evidence loads and resolves the real late-loaded module', () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../app/activity-core.js'), 'utf8'), context);
  const state = { notes: [{ id: 'public', createdAt: '2026-09-10' }, { id: 'private', createdAt: '2026-09-10', provenance: { origin: { private: true } } }] };
  const options = { now: '2026-09-10' };
  assert.equal(context.WorkstationActivityCore.aggregate(state, options).totals.materials, 0);
  vm.runInContext(fs.readFileSync(require.resolve('../app/citation-evidence.js'), 'utf8'), context);
  const result = context.WorkstationActivityCore.aggregate(state, options);
  assert.equal(result.totals.materials, 1);
  assert.equal(result.series.at(-1).entries[0].id, 'public');
});
