const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TaskContext = require('../app/task-context');
const anchor = { now: '2026-09-11T17:05:06.000Z', timeZone: 'Asia/Shanghai' };
const conversation = (extra = {}) => ({ id: 'c', workspace: 'auto', messages: [], ...extra });
const task = (id, extra = {}) => ({ id, title: `任务 ${id}`, status: 'todo', priority: 'medium', workspace: '日常', dueAt: null, ...extra });
const rows = context => context.text.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
const build = (state, conv, options = {}) => TaskContext.build(state, conv, { ...anchor, ...options });

test('UMD exposes its pure API in the browser without requiring Node', () => {
  const context = vm.createContext({ Intl });
  vm.runInContext(fs.readFileSync(require.resolve('../app/task-context'), 'utf8'), context);
  assert.equal(typeof context.TaskContext.build, 'function'); assert.equal(typeof context.TaskContext.assertUnchanged, 'function'); assert.equal(typeof context.TaskContext.refreshForReview, 'function');
});

test('an unbound follow-up receives only its own tasks and successful result references, recent result first', () => {
  const state = { projects: [{ id: 'p', workspace: '日常' }], tasks: [task('own', { sourceConversationId: 'c' }), task('message', { projectId: 'p' }), task('run'), task('failed'), task('other', { sourceConversationId: 'other' })],
    agentRuns: [{ id: 'done', conversationId: 'c', status: 'completed', finishedAt: '2026-09-11T16:00:00Z', results: [{ type: 'task', id: 'run', operation: 'updated' }] },
      { id: 'bad', conversationId: 'c', status: 'failed', results: [{ type: 'task', id: 'failed' }] },
      { id: 'other-run', conversationId: 'other', status: 'completed', results: [{ type: 'task', id: 'other' }] }] };
  const conv = conversation({ messages: [{ at: '2026-09-11T15:00:00Z', results: [{ type: 'task', id: 'message' }, { type: 'note', id: 'other' }] }] });
  const before = JSON.stringify(state); const context = build(state, conv, { goal: '它的 ddl 是下周五' });
  assert.deepEqual(context.taskIds, ['run', 'message', 'own']); assert.deepEqual(rows(context).map(row => row.id), context.taskIds);
  assert.match(context.text, /多个候选且指代不明时先询问/); assert.equal(JSON.stringify(state), before);
});

test('bound project stays strict even when old messages and exact titles mention another project', () => {
  const state = { projects: [{ id: 'p', workspace: '课程' }, { id: 'q', workspace: '科研' }], tasks: [task('p', { projectId: 'p', workspace: '日常' }), task('q', { projectId: 'q', sourceConversationId: 'c', title: '另一项目的研究任务' }), task('loose', { sourceConversationId: 'c' })] };
  const context = build(state, conversation({ projectId: 'p', workspace: '科研', messages: [{ results: [{ type: 'task', id: 'q' }] }] }), { goal: '把另一项目的研究任务改为周五' });
  assert.deepEqual(context.taskIds, ['p']); assert.equal(rows(context)[0].workspace, '课程');
});

test('exact unique complete title can resolve an unbound task, but fragments and duplicate titles cannot', () => {
  const state = { projects: [{ id: 'p', workspace: '课程' }, { id: 'q', workspace: '科研' }], tasks: [task('one', { title: '完成智能控制实验报告', projectId: 'p' }), task('two', { title: '提交论文', projectId: 'p' }), task('three', { title: '提交论文', projectId: 'q' })] };
  assert.deepEqual(build(state, conversation(), { goal: '请把「完成智能控制实验报告」的截止日期改成明天' }).taskIds, ['one']);
  for (const goal of ['实验报告改成明天', '提交论文改成明天', '它周五到期']) assert.deepEqual(build(state, conversation(), { goal }).taskIds, []);
  assert.deepEqual(build(state, conversation({ workspace: '科研' }), { goal: '完成智能控制实验报告改成明天' }).taskIds, []);
});

test('title matching does not confuse Latin word substrings or a shorter task with a named longer one', () => {
  const state = { tasks: [task('a', { title: 'Review paper' }), task('b', { title: 'Review paper appendix' }), task('c', { title: '论文整理' }), task('d', { title: '论文整理计划' })] };
  assert.deepEqual(build(state, conversation(), { goal: 'Preview paper tomorrow' }).taskIds, []);
  assert.deepEqual(build(state, conversation(), { goal: 'Review paper appendix tomorrow' }).taskIds, ['b']);
  assert.deepEqual(build(state, conversation(), { goal: '把论文整理计划设为明天完成' }).taskIds, ['d']);
});

test('archived/deleted tasks, missing or inactive parents, and duplicate IDs never enter context', () => {
  const state = { projects: [{ id: 'old', archived: true }, { id: 'duplicate' }, { id: 'duplicate' }], tasks: [task('a', { archived: true }), task('b', { deletedAt: 1 }), task('c', { status: 'deleted' }), task('d', { projectId: 'old' }), task('e', { projectId: 'missing' }), task('f', { projectId: 'duplicate' }), task('same'), task('same')] };
  state.tasks.forEach(item => { item.sourceConversationId = 'c'; });
  assert.deepEqual(build(state, conversation()).taskIds, []);
  assert.deepEqual(build(state, conversation({ projectId: 'missing' })).taskIds, []);
  state.tasks.push(task('live', { sourceConversationId: 'c' }));
  assert.deepEqual(build(state, conversation({ archived: true })).taskIds, []);
  state.conversations = [conversation({ deletedAt: 1 })]; assert.deepEqual(build(state, conversation()).taskIds, []);
});

test('pending and failed message results cannot impersonate a successful task result', () => {
  const state = { tasks: [task('pending'), task('failed')], agentRuns: [{ id: 'bad', conversationId: 'c', status: 'failed' }] };
  const context = build(state, conversation({ messages: [{ pendingRunId: 'pending-run', results: [{ type: 'task', id: 'pending' }] }, { runId: 'bad', results: [{ type: 'task', id: 'failed' }] }] }));
  assert.deepEqual(context.taskIds, []);
});

test('task rows contain actual fields, source identifiers and checklist while excluding unrelated credentials', () => {
  const item = task('t', { sourceConversationId: 'c', title: '签证材料', dueAt: '2026-09-18T09:30:00+08:00', startAt: '2026-09-17', description: '先核对官方清单', checklist: [{ id: 'check', text: '准备照片', done: true }], sourceAttachmentIds: ['pdf'], updatedAt: 7 });
  const context = build({ tasks: [item], settings: { apiKey: 'SECRET' }, imports: [{ id: 'pdf', rawBase64: 'PRIVATE_BYTES' }] }, conversation());
  const row = rows(context)[0];
  for (const key of ['id', 'title', 'dueAt', 'startAt', 'description', 'updatedAt', 'sourceAttachmentIds', 'checklist']) assert.deepEqual(row[key], item[key]);
  assert.doesNotMatch(context.text, /SECRET|PRIVATE_BYTES/); assert.equal(typeof context.snapshots.t.task, 'string');
});

test('budget is strict and snapshots authorize only task IDs whose complete JSON rows were output', () => {
  const state = { tasks: Array.from({ length: 25 }, (_, index) => task(`t${index}`, { sourceConversationId: 'c', title: '报告😀'.repeat(100), description: '长正文'.repeat(3000), checklist: Array.from({ length: 40 }, () => ({ text: '步骤'.repeat(100), done: false })) })) };
  for (const maxChars of [0, 1, 100, 250, 500, 800, 1500, 8000]) {
    const context = build(state, conversation(), { maxChars });
    assert.ok(context.text.length <= maxChars, `${context.text.length} > ${maxChars}`);
    assert.deepEqual(rows(context).map(row => row.id), context.taskIds);
    assert.deepEqual(Object.keys(context.snapshots).sort(), [...context.taskIds].sort());
    assert.ok(context.taskIds.length < 25);
    if (context.taskIds.length) assert.equal(rows(context)[0].truncated, true);
  }
});

test('date anchor uses this message instant in Shanghai rather than its UTC calendar day', () => {
  const context = build({}, conversation());
  assert.match(context.text, /2026-09-12T01:05:06\+08:00/); assert.match(context.text, /时区 Asia\/Shanghai/); assert.match(context.text, /相对日期以此为准/);
  assert.match(build({}, conversation(), { timeZone: 'Invalid/Zone' }).text, /2026-09-11T17:05:06\+00:00.*UTC（无效时区已回退）/);
});

test('time anchor computes DST and fractional UTC offsets correctly', () => {
  assert.match(build({}, conversation(), { now: '2026-07-01T12:00:00Z', timeZone: 'America/New_York' }).text, /2026-07-01T08:00:00-04:00/);
  assert.match(build({}, conversation(), { now: '2026-01-01T12:00:00Z', timeZone: 'America/New_York' }).text, /2026-01-01T07:00:00-05:00/);
  assert.match(build({}, conversation(), { now: '2026-07-01T12:00:00Z', timeZone: 'Asia/Kathmandu' }).text, /2026-07-01T17:45:00\+05:45/);
});

test('optimistic task check tolerates object-key order and metadata timestamps but rejects changed content', () => {
  const state = { tasks: [task('t', { sourceConversationId: 'c', updatedAt: 1 })] };
  const context = build(state, conversation()); const actions = [{ type: 'update_task', taskId: 't', patch: { dueAt: '2026-09-20' } }];
  state.tasks[0].updatedAt = 100; state.tasks[0].createdAt = 99;
  state.tasks[0] = Object.fromEntries(Object.entries(state.tasks[0]).reverse());
  assert.equal(TaskContext.assertUnchanged(state, actions, context.snapshots), true);
  state.tasks[0].description = '用户新写的说明';
  assert.throws(() => TaskContext.assertUnchanged(state, actions, context.snapshots), error => error.code === 'CANCELLED' && /等待期间已修改.*请重新发送/.test(error.message));
});

test('deadline, checklist, source and project changes during approval all cancel instead of overwriting', () => {
  for (const mutate of [t => { t.dueAt = '2027-01-01'; }, t => { t.checklist[0].done = true; }, t => { t.sourceAttachmentIds.push('other'); }, t => { t.projectId = 'q'; }]) {
    const state = { projects: [{ id: 'p', workspace: '日常' }, { id: 'q', workspace: '日常' }], tasks: [task('t', { sourceConversationId: 'c', projectId: 'p', checklist: [{ text: '准备', done: false }], sourceAttachmentIds: ['pdf'] })] };
    const context = build(state, conversation()); mutate(state.tasks[0]);
    assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: 't' }], context.snapshots), { code: 'CANCELLED' });
  }
});

test('deletion, archival, duplicate IDs and parent lifecycle changes invalidate the same snapshot', () => {
  for (const mutate of [s => { s.tasks = []; }, s => { s.tasks[0].archived = true; }, s => { s.tasks.push({ ...s.tasks[0] }); }, s => { s.projects[0].archived = true; }, s => { s.projects = []; }, s => { s.projects[0].workspace = '课程'; }]) {
    const state = { projects: [{ id: 'p', workspace: '日常' }], tasks: [task('t', { projectId: 'p' })] };
    const context = build(state, conversation({ projectId: 'p' })); mutate(state);
    assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: 't' }], context.snapshots), { code: 'CANCELLED' });
  }
});

test('unknown task references require a valid context ID, while unrelated actions are unaffected', () => {
  const state = { tasks: [task('t')] };
  assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: 't' }], {}), { code: 'TASK_CONTEXT' });
  assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: '__proto__' }], {}), { code: 'TASK_CONTEXT' });
  assert.equal(TaskContext.assertUnchanged(state, [{ type: 'create_task', title: '新任务' }, { type: 'update_note', noteId: 'n' }], {}), true);
});

function reviewFixture() {
  const state = { projects: [{ id: 'p', name: 'Original project', workspace: '日常' }, { id: 'q', workspace: '日常' }],
    tasks: [task('t', { projectId: 'p', checklist: [{ text: 'Original step', done: false }] }), task('other', { projectId: 'p' })] };
  const context = build(state, conversation({ projectId: 'p' }));
  return { state, context, actions: [{ type: 'update_task', taskId: 't', patch: { priority: 'high' } }] };
}

test('explicit review refreshes only targeted content and keeps original allowed IDs and snapshots intact', () => {
  const { state, context, actions } = reviewFixture(), baseline = JSON.stringify(context);
  state.tasks[0].description = 'New human content'; state.tasks[0].checklist[0].done = true; state.tasks[0].status = 'in_progress';
  state.tasks[1].description = 'Unrelated human content'; state.projects[0].name = 'Renamed within the same space';
  const beforeState = JSON.stringify(state);
  assert.throws(() => TaskContext.assertUnchanged(state, actions, context.snapshots), { code: 'CANCELLED' });
  const refreshed = TaskContext.refreshForReview(state, actions, context.snapshots);
  assert.notEqual(refreshed, context.snapshots); assert.notEqual(refreshed.t, context.snapshots.t);
  assert.deepEqual(Object.keys(refreshed), context.taskIds); assert.equal(refreshed.other, context.snapshots.other);
  assert.equal(TaskContext.assertUnchanged(state, actions, refreshed), true);
  assert.throws(() => TaskContext.assertUnchanged(state, [{ type: 'update_task', taskId: 'other' }], refreshed), { code: 'CANCELLED' });
  assert.equal(JSON.stringify(context), baseline); assert.equal(JSON.stringify(state), beforeState);
  state.tasks[0].description = 'Changed again after review';
  assert.throws(() => TaskContext.assertUnchanged(state, actions, refreshed), { code: 'CANCELLED' });
});

test('explicit deletion review may acknowledge changed content but still uses strict CAS afterwards', () => {
  const { state, context } = reviewFixture(), actions = [{ type: 'delete_task', taskId: 't' }];
  state.tasks[0].dueAt = '2027-01-01'; state.tasks[0].sourceAttachmentIds = ['new-source'];
  const refreshed = TaskContext.refreshForReview(state, actions, context.snapshots);
  assert.equal(TaskContext.assertUnchanged(state, actions, refreshed), true);
  state.tasks[0].dueAt = '2027-01-02'; assert.throws(() => TaskContext.assertUnchanged(state, actions, refreshed), { code: 'CANCELLED' });
});

test('review cannot acknowledge moved tasks, task spaces or parent spaces including standalone moves', () => {
  for (const mutate of [
    s => { s.tasks[0].projectId = 'q'; }, s => { s.tasks[0].projectId = null; },
    s => { s.tasks[0].workspace = '课程'; }, s => { s.projects[0].workspace = '课程'; }
  ]) {
    const { state, context, actions } = reviewFixture(); mutate(state);
    assert.throws(() => TaskContext.refreshForReview(state, actions, context.snapshots), { code: 'CANCELLED' });
  }
  const state = { projects: [{ id: 'p', workspace: '日常' }], tasks: [task('t', { sourceConversationId: 'c' })] };
  const context = build(state, conversation()), actions = [{ type: 'update_task', taskId: 't' }];
  state.tasks[0].description = 'Current standalone content';
  assert.equal(TaskContext.assertUnchanged(state, actions, TaskContext.refreshForReview(state, actions, context.snapshots)), true);
  state.tasks[0].projectId = 'p'; assert.throws(() => TaskContext.refreshForReview(state, actions, context.snapshots), { code: 'CANCELLED' });
});

test('review rejects all inactive, missing and duplicate task or project identities', () => {
  for (const collection of ['tasks', 'projects']) for (const invalidate of [
    items => { items.shift(); }, items => { items.push({ ...items[0] }); },
    ...['archived', 'archivedAt', 'deleted', 'deletedAt'].map(field => items => { items[0][field] = 1; }),
    items => { items[0].status = 'archived'; }, items => { items[0].status = 'deleted'; }
  ]) {
    const { state, context, actions } = reviewFixture(); invalidate(state[collection]);
    assert.throws(() => TaskContext.refreshForReview(state, actions, context.snapshots), { code: 'CANCELLED' });
  }
});

test('review cannot add a newly visible task, inherit an allowed ID, or accept a malformed baseline', () => {
  const { state, context, actions } = reviewFixture(); state.tasks.push(task('new', { projectId: 'p' }));
  assert.throws(() => TaskContext.refreshForReview(state, [{ type: 'update_task', taskId: 'new' }], context.snapshots), { code: 'TASK_CONTEXT' });
  assert.throws(() => TaskContext.refreshForReview(state, actions, Object.create(context.snapshots)), { code: 'TASK_CONTEXT' });
  for (const baseline of [null, { task: '{broken', project: null }, { task: 'null', project: null }, { task: '{}', project: null },
    { ...context.snapshots.t, task: JSON.stringify({ ...state.tasks[0], id: 'other' }) },
    { ...context.snapshots.t, project: null }, { ...context.snapshots.t, project: { id: 'q', workspace: '日常' } }
  ]) assert.throws(() => TaskContext.refreshForReview(state, actions, { t: baseline }), { code: 'TASK_CONTEXT' });
});

test('invalid later target leaves earlier refresh candidates, original snapshots and state unchanged', () => {
  const { state, context, actions } = reviewFixture(); state.tasks[0].description = 'May be reread'; state.tasks[1].projectId = 'q';
  actions.push({ type: 'delete_task', taskId: 'other' });
  const beforeState = JSON.stringify(state), beforeContext = JSON.stringify(context);
  assert.throws(() => TaskContext.refreshForReview(state, actions, context.snapshots), { code: 'CANCELLED' });
  assert.equal(JSON.stringify(state), beforeState); assert.equal(JSON.stringify(context), beforeContext);
  assert.throws(() => TaskContext.assertUnchanged(state, [actions[0]], context.snapshots), { code: 'CANCELLED' });
});

test('unrelated actions never refresh snapshots and prototype-like own IDs remain data keys', () => {
  const { state, context } = reviewFixture(); state.tasks[0].description = 'Not acknowledged';
  const unchanged = TaskContext.refreshForReview(state, [{ type: 'create_task', title: 'New' }, { type: 'update_note', noteId: 't' }], context.snapshots);
  assert.deepEqual(unchanged, context.snapshots); assert.equal(unchanged.t, context.snapshots.t);
  const special = { tasks: [task('__proto__', { sourceConversationId: 'c' })] }, original = build(special, conversation());
  special.tasks[0].description = 'Current text'; const actions = [{ type: 'update_task', taskId: '__proto__' }];
  const refreshed = TaskContext.refreshForReview(special, actions, original.snapshots);
  assert.equal(Object.getPrototypeOf(refreshed), Object.prototype); assert.equal(Object.hasOwn(refreshed, '__proto__'), true);
  assert.equal(TaskContext.assertUnchanged(special, actions, refreshed), true);
  assert.throws(() => TaskContext.refreshForReview(special, actions, {}), { code: 'TASK_CONTEXT' });
});
