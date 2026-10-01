const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Planning = require('../app/planning-workbench.js');
const Activity = require('../app/activity-core.js');
const Evidence = require('../app/citation-evidence.js');

const now = new Date(2026, 9, 1, 12).getTime();
const base = () => ({
  projects: [{ id: 'p', name: 'Public project', workspace: '日常' }],
  notes: [{ id: 'shared', title: 'Public note', projectId: 'p', createdAt: now }],
  imports: [{ id: 'shared', name: 'Public original', projectId: 'p', createdAt: now }],
  tasks: [{ id: 'shared', title: 'Public task', projectId: 'p', status: 'done', completedAt: now, dueAt: '2026-10-01' }],
  conversations: [], agentRuns: [], trash: []
});
const container = () => ({ classList: { add() {} }, contains: () => true, innerHTML: '' });
const click = (host, type, id) => host.onclick({ target: { closest: () => ({ hasAttribute: () => false, dataset: { planningOpen: type, planningId: id } }) } });

test('planning controller and activity aggregation hide private provenance, identities and project owners consistently', () => {
  const state = base();
  state.conversations.push({ id: 'private-chat', private: true });
  state.agentRuns.push({ id: 'private-run', conversationId: 'private-chat' });
  state.trash.push({ data: { conversations: [{ id: 'retired-chat', incognito: true }] } });
  state.projects.push({ id: 'hidden-project', name: 'HIDDEN project', provenance: { origin: { private: true } } },
    { id: 'duplicate-project', name: 'HIDDEN project duplicate A' }, { id: 'duplicate-project', name: 'HIDDEN project duplicate B' });
  const patches = [
    { private: true }, { ephemeral: true }, { incognito: true },
    { provenance: { origin: { private: true } } },
    { sourceConversationId: 'private-chat' }, { agentRunId: 'private-run' },
    { conversationId: 'retired-chat' }, { projectId: 'hidden-project' }, { projectId: 'duplicate-project' },
    { archivedAt: 1 }, { deleted: true }, { wikiFileError: 'missing' }
  ];
  for (const collection of ['notes', 'imports', 'tasks']) {
    patches.forEach((patch, i) => state[collection].push({ id: `hidden-${i}`, title: `HIDDEN ${collection} ${i}`, projectId: 'p', createdAt: now, completedAt: now, status: 'done', dueAt: '2026-10-01', ...patch }));
    state[collection].push(...['A', 'B'].map(suffix => ({ id: 'duplicate', title: `HIDDEN duplicate ${suffix}`, projectId: 'p', createdAt: now, completedAt: now, status: 'done' })));
  }
  const before = JSON.stringify(state), host = container();
  Planning.init({ getState: () => state, now: () => now });
  const model = Planning.render(host);
  assert.deepEqual(model.counts, { total: 1, done: 1, todo: 0, in_progress: 0, blocked: 0, overdue: 0, notes: 1, imports: 1, projects: 1 });
  assert.deepEqual(model.graph.nodes.map(node => [node.type, node.id]), [['project', 'p'], ['task', 'shared'], ['note', 'shared'], ['import', 'shared']]);
  assert.equal(model.timeline.length, 1);
  assert.doesNotMatch(host.innerHTML, /HIDDEN/);
  assert.match(host.innerHTML, /1 个项目 · 1 个任务 · 1 条知识 · 1 份资料/);
  const activity = Activity.aggregate(state, { now });
  assert.deepEqual(activity.totals, { tasks: 1, materials: 2 });
  assert.equal(activity.series.at(-1).entries.length, 3);
  assert.doesNotMatch(JSON.stringify(activity), /HIDDEN/);
  assert.equal(JSON.stringify(state), before);
});

test('public unassigned documents and durable knowledge outlive public source conversations', () => {
  const state = base();
  state.conversations.push({ id: 'old-public', archived: true });
  for (const collection of ['notes', 'imports', 'tasks']) {
    state[collection][0].sourceConversationId = 'old-public';
    state[collection].push({ id: 'unassigned', title: 'Unassigned public', createdAt: now, completedAt: now, status: 'done' });
  }
  const verify = () => {
    const model = Planning.derive(state, {}, { now });
    assert.equal(model.counts.notes, 2); assert.equal(model.counts.imports, 2); assert.equal(model.counts.total, 2);
    assert.equal(model.graph.unassigned.length, 3);
    assert.deepEqual(Activity.aggregate(state, { now }).totals, { tasks: 2, materials: 4 });
  };
  verify(); state.conversations = []; verify();
});

test('planning node callbacks recheck current typed access before opening stale graph buttons', () => {
  for (const [type, collection] of [['note', 'notes'], ['import', 'imports'], ['task', 'tasks'], ['project', 'projects']]) {
    const state = base(), host = container(), opened = [], toasts = [];
    Planning.init({ getState: () => state, now: () => now, openEntity: (...args) => opened.push(args), toast: value => toasts.push(value) });
    Planning.render(host);
    const id = type === 'project' ? 'p' : 'shared';
    click(host, type, id); assert.deepEqual(opened, [[type, id]], `${type} public opens`);
    state[collection][0].provenance = { origin: { private: true } };
    click(host, type, id); assert.equal(opened.length, 1, `${type} private source cannot open`);
    delete state[collection][0].provenance;
    state[collection].push({ ...state[collection][0] });
    click(host, type, id); assert.equal(opened.length, 1, `${type} ambiguous identity cannot open`);
    assert.equal(toasts.length, 2);
  }
});

test('browser modules resolve a late privacy dependency and create one context per aggregation', () => {
  const context = vm.createContext({ Date, URL, console });
  const load = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', name), 'utf8'), context, { filename: name });
  load('activity-core.js'); load('planning-workbench.js');
  const state = base();
  assert.equal(context.PlanningWorkbench.derive(state, {}, { now }).counts.notes, 0);
  assert.equal(context.WorkstationActivityCore.aggregate(state, { now }).totals.materials, 0);
  let contexts = 0;
  context.CitationEvidence = { createAccessContext(owner) { contexts++; return Evidence.createAccessContext(owner); } };
  const model = context.PlanningWorkbench.derive(state, {}, { now });
  assert.equal(model.counts.notes, 1); assert.equal(contexts, 1);
  const aggregate = context.WorkstationActivityCore.aggregate(state, { now });
  assert.equal(aggregate.totals.materials, 2); assert.equal(contexts, 2);
  state.notes[0].provenance = { origin: { private: true } };
  assert.equal(context.PlanningWorkbench.derive(state, {}, { now }).counts.notes, 0);
  assert.equal(context.WorkstationActivityCore.aggregate(state, { now }).totals.materials, 1);
  assert.equal(contexts, 4, 'each later action rebuilds its access index from current state');
});

test('unavailable or ambiguous selected project is not silently treated as an unassigned scope', () => {
  for (const patch of [{ private: true }, { provenance: { origin: { private: true } } }, { deletedAt: 1 }, { archivedAt: 1 }]) {
    const state = base(); Object.assign(state.projects[0], patch);
    const model = Planning.derive(state, { projectId: 'p' }, { now });
    assert.equal(model.validScope, false); assert.deepEqual(model.graph.nodes, []);
    assert.deepEqual(Activity.aggregate(state, { projectId: 'p', now }).totals, { tasks: 0, materials: 0 });
  }
  const state = base(); state.projects.push({ ...state.projects[0] });
  assert.equal(Planning.derive(state, { projectId: 'p' }, { now }).validScope, false);
  assert.deepEqual(Activity.aggregate(state, { projectId: 'p', now }).totals, { tasks: 0, materials: 0 });
});
