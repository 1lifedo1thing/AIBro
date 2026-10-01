const test = require('node:test');
const assert = require('node:assert/strict');
const Activity = require('../app/activity-center.js');
const state = () => ({ ui: {}, projects: [{ id: 'p', name: 'Project' }], conversations: [{ id: 'c', title: 'Conversation', projectId: 'p', messages: [] }], agentRuns: [], tasks: [], notes: [] });
const run = (s, id = 'r', status = 'running', startedAt = 100) => { const value = { id, conversationId: 'c', goal: 'A real task', status, startedAt }; s.agentRuns.push(value); return value; };
const capture = s => Activity.capture(s, { now: 1000 });
const event = s => s.ui.activityCenter.events.at(-1);
const finish = (s, item, status = 'completed') => { item.status = status; item.finishedAt = 1500; return capture(s); };

test('first enable establishes a durable baseline without replaying historical runs', () => {
  const s = state(); run(s, 'old', 'completed'); run(s, 'pending', 'awaiting-approval');
  assert.deepEqual(capture(s), { changed: true, added: 0, baseline: true }); assert.equal(Activity.unreadCount(s), 0);
  const reloaded = JSON.parse(JSON.stringify(s)); assert.equal(capture(reloaded).added, 0); assert.equal(capture(reloaded).changed, false);
});
test('recorded active run completion survives an offline reload and is captured only once', () => {
  const s = state(), r = run(s); capture(s);
  const reloaded = JSON.parse(JSON.stringify(s)); reloaded.agentRuns[0].status = 'completed'; reloaded.agentRuns[0].finishedAt = 1300;
  assert.equal(capture(reloaded).added, 1); assert.equal(event(reloaded).occurredAt, 1300); assert.equal(capture(reloaded).added, 0);
  assert.equal(capture(JSON.parse(JSON.stringify(reloaded))).added, 0); assert.equal(s.agentRuns[0], r);
});
test('new runs finished while the UI was closed are captured; awaiting-save is not a success event', () => {
  const s = state(); capture(s); const r = run(s, 'later', 'awaiting-save', 1100); capture(s);
  assert.equal(Activity.unreadCount(s), 0); assert.equal(finish(s, r).added, 1); assert.equal(event(s).kind, 'completed');
});
test('an optimistic completed approval never notifies before its durable acknowledgement', () => {
  const s = state(), r = run(s, 'r', 'awaiting-approval'); capture(s); r.status = 'completed'; r.finishedAt = 1400; r.approvalReceipt = { savePending: true };
  assert.equal(capture(s).added, 0); assert.equal(Activity.unreadCount(s), 0);
  r.status = 'awaiting-save'; capture(s); assert.equal(Activity.unreadCount(s), 0);
  r.status = 'completed'; r.approvalReceipt.savePending = false; assert.equal(capture(s).added, 1); assert.equal(Activity.unreadCount(s), 1);
});
test('digest deduplicates unchanged results across approval and completion snapshots', () => {
  const s = state(), r = run(s); capture(s); r.results = [{ type: 'note', id: 'n', operation: 'created' }]; r.status = 'awaiting-approval'; capture(s); finish(s, r);
  assert.equal(Activity.digest(s).total, 2); assert.deepEqual(Activity.digest(s).changes, { note: 1 });
});
test('approval, rejection and a repeated approval remain separate recorded transitions', () => {
  const s = state(), r = run(s); capture(s); r.status = 'awaiting-approval'; capture(s); finish(s, r, 'rejected'); r.status = 'awaiting-approval'; delete r.finishedAt; capture(s);
  assert.deepEqual(s.ui.activityCenter.events.map(x => x.status), ['awaiting-approval', 'rejected', 'awaiting-approval']);
  assert.equal(new Set(s.ui.activityCenter.events.map(x => x.id)).size, 3);
});
test('failure, interruption, cancellation and local completion retain truthful outcomes', () => {
  const s = state(); capture(s); for (const [index, status] of ['failed', 'interrupted', 'cancelled', 'completed-local', 'completed-local-fallback'].entries()) run(s, `r${index}`, status, 1100 + index);
  capture(s); assert.deepEqual(s.ui.activityCenter.events.map(x => x.kind), ['failed', 'failed', 'stopped', 'completed', 'completed']);
});
test('private or unknown conversations and private runs never enter the ledger, even as observations', () => {
  const s = state(); s.conversations.push({ id: 'private', ephemeral: true }); capture(s);
  const r = run(s); r.conversationId = 'private'; const unknown = run(s, 'unknown', 'completed'); unknown.conversationId = 'missing'; const privateRun = run(s, 'private-run', 'completed'); privateRun.private = true;
  r.goal = 'PRIVATE_GOAL'; capture(s); assert.equal(s.ui.activityCenter.observed.length, 0); assert.doesNotMatch(JSON.stringify(s.ui.activityCenter), /PRIVATE_GOAL|private-run|unknown/);
});
test('a public conversation made private removes previous snapshots and observation identities', () => {
  const s = state(); capture(s); const r = run(s); finish(s, r); s.conversations[0].incognito = true; capture(s);
  assert.equal(s.ui.activityCenter.events.length, 0); assert.equal(s.ui.activityCenter.observed.length, 0);
});
test('streaming captures do not read bodies or results, nor serialize entire run records', () => {
  const s = state(), r = run(s); capture(s);
  for (const field of ['goal', 'results', 'text', 'toolCalls', 'steps']) Object.defineProperty(r, field, { get() { throw Error('Expensive streaming field read: ' + field); }, configurable: true });
  for (let index = 0; index < 100; index += 1) assert.equal(capture(s).changed, false);
});
test('summary counts only actual result operations and references contain no body text', () => {
  const s = state(); s.notes = [{ id: 'n', title: 'Note', content: 'SECRET_BODY' }]; s.tasks = [{ id: 't', title: 'Task' }]; capture(s);
  const r = run(s); r.results = [{ type: 'note', id: 'n', operation: 'drafted', text: 'SECRET_BODY' }, { type: 'note', id: 'n', operation: 'drafted' }, { type: 'task', id: 't', operation: 'matched' }, { type: 'shell', id: 's', operation: 'updated' }]; finish(s, r);
  assert.deepEqual(event(s).counts, { note: 1 }); assert.equal(event(s).references.length, 2); assert.doesNotMatch(JSON.stringify(event(s)), /SECRET_BODY|shell/);
});
test('references and title are bounded while recorded change counts remain accurate', () => {
  const s = state(); capture(s); const r = run(s); r.goal = 'x'.repeat(1000); r.results = Array.from({ length: 30 }, (_, i) => ({ type: 'task', id: `t${i}`, operation: 'created' })); finish(s, r);
  assert.equal(event(s).title.length, 240); assert.equal(event(s).references.length, 6); assert.equal(event(s).resultCount, 30); assert.equal(event(s).counts.task, 30);
});
test('deleted and archived sources are explicit; stale approvals never execute an action', async () => {
  const s = state(), r = run(s); capture(s); r.status = 'awaiting-approval'; capture(s); const e = event(s); finish(s, r);
  assert.equal(Activity.sourceState(s, e).outdated, true); s.conversations[0].archived = true;
  let calls = 0; const c = Activity.createController({ getState: () => s, save: async () => true, openTarget: () => { calls += 1; } });
  await assert.rejects(c.openSource(e.id), /归档/); assert.equal(calls, 0);
  assert.equal(Activity.sourceState(s, e, { kind: 'note', id: 'gone' }).available, false);
});
test('view watermark persists separately from unread, including arrivals during its save', async () => {
  const s = state(); capture(s); finish(s, run(s)); let release;
  const c = Activity.createController({ getState: () => s, save: () => new Promise(resolve => { release = resolve; }) });
  const pending = c.view(); finish(s, run(s, 'later')); release(true); assert.equal(await pending, 0);
  assert.equal(s.ui.activityCenter.lastViewedSeq, 1); assert.equal(Activity.digest(s).total, 1); assert.equal(Activity.unreadCount(s), 2);
});
test('mark-read, archive and restore are independent persistent fields', async () => {
  const s = state(); capture(s); finish(s, run(s)); const id = event(s).id; let durable;
  const c = Activity.createController({ getState: () => s, save: async () => { durable = JSON.parse(JSON.stringify(s)); return true; } });
  await c.archive([id]); assert.equal(Activity.unreadCount(s), 0); assert.equal(event(s).readAt, null); assert.equal(Activity.query(durable, { archived: true }).total, 1);
  await c.archive([id], false); assert.equal(Activity.unreadCount(s), 1); await c.markRead([id]); assert.equal(Activity.unreadCount(durable), 0);
  await c.markRead([id], false); assert.equal(Activity.unreadCount(s), 1);
});
test('save failure rolls back only its fields and preserves new events and unrelated edits', async () => {
  const s = state(); capture(s); finish(s, run(s)); const first = event(s); let reject;
  const c = Activity.createController({ getState: () => s, save: () => new Promise((_, no) => { reject = no; }) });
  const pending = c.markRead([first.id]); finish(s, run(s, 'later')); s.notes.push({ id: 'concurrent', title: 'Keep me' }); first.archivedAt = 42;
  reject(Error('Disk full')); await assert.rejects(pending, /Disk full/);
  assert.equal(first.readAt, null); assert.equal(first.archivedAt, 42); assert.equal(s.ui.activityCenter.events.length, 2); assert.equal(s.notes.length, 1);
});
test('failed viewing does not lose newly arrived watermark evidence', async () => {
  const s = state(); capture(s); finish(s, run(s)); let reject;
  const c = Activity.createController({ getState: () => s, save: () => new Promise((_, no) => { reject = no; }) });
  const pending = c.view(); finish(s, run(s, 'later')); reject(Error('Denied')); await assert.rejects(pending, /Denied/);
  assert.equal(s.ui.activityCenter.lastViewedSeq, 0); assert.equal(Activity.digest(s).total, 2);
});
test('an operation never restores a removed event or clobbers a later change', async () => {
  const s = state(); capture(s); finish(s, run(s)); const first = event(s); let reject;
  const c = Activity.createController({ getState: () => s, save: () => new Promise((_, no) => { reject = no; }) });
  const pending = c.markRead([first.id]); first.readAt = 123; reject(Error('Denied')); await assert.rejects(pending); assert.equal(first.readAt, 123);
  const pending2 = c.archive([first.id]); s.ui.activityCenter.events = []; reject(Error('Denied')); await assert.rejects(pending2); assert.equal(s.ui.activityCenter.events.length, 0);
});
test('project, type, unread and archive filters compose and pagination remains bounded', async () => {
  const s = state(); capture(s); for (let i = 0; i < 45; i++) finish(s, run(s, `r${i}`), i % 2 ? 'completed' : 'failed');
  assert.equal(Activity.query(s).events.length, 20); assert.equal(Activity.query(s).pages, 3); assert.equal(Activity.query(s, { page: 99 }).events.length, 5);
  assert.equal(Activity.query(s, { projectId: 'p', kind: 'failed', unread: true }).total, 23); assert.equal(Activity.query(s, { projectId: '__none__' }).total, 0);
  const c = Activity.createController({ getState: () => s, save: async () => true }); await c.markRead(Activity.query(s, { kind: 'failed' }).ids);
  assert.equal(Activity.query(s, { unread: true }).total, 22);
});
test('event retention never replays evicted events and explains truncated digest', () => {
  const s = state(); capture(s); for (let i = 0; i < 350; i++) run(s, `r${i}`, 'completed', 1100 + i); capture(s);
  assert.equal(s.ui.activityCenter.events.length, Activity.MAX_EVENTS); assert.equal(s.ui.activityCenter.droppedCount, 50); assert.equal(Activity.digest(s, 0).truncated, true);
  assert.equal(capture(JSON.parse(JSON.stringify(s))).added, 0);
});
test('bounded observation history preferentially preserves unfinished runs and prevents replay', () => {
  const s = state(); for (let i = 0; i < 5050; i++) run(s, `r${i}`, 'completed', 100 + i); const active = run(s, 'still-running', 'running', 1); capture(s);
  assert.equal(s.ui.activityCenter.observed.length, Activity.MAX_OBSERVED); assert.ok(s.ui.activityCenter.observed.find(x => x.id === active.id));
  assert.equal(capture(s).added, 0); assert.equal(finish(s, active).added, 1);
});
test('successful source routing does not conflate opening with read-state mutation', async () => {
  const s = state(); capture(s); finish(s, run(s)); let target; const c = Activity.createController({ getState: () => s, openTarget: async value => { target = value; return true; } });
  assert.equal(await c.openSource(event(s).id), true); assert.deepEqual(target, { kind: 'conversation', id: 'c', conversationId: 'c', runId: 'r' }); assert.equal(Activity.unreadCount(s), 1);
});
test('local activity ledger is excluded from the existing cloud projection', () => {
  const { execFileSync } = require('node:child_process'); const path = require('node:path');
  const s = state(); capture(s); finish(s, run(s));
  const output = execFileSync('python3', ['-c', 'import json,sys; from sync_store import project; value=project(json.load(sys.stdin)); print(json.dumps(list(value.values())))'], { cwd: path.resolve(__dirname, '../app'), input: JSON.stringify(s), encoding: 'utf8' });
  assert.doesNotMatch(output, /activityCenter|activity:|A real task|lastViewedSeq/);
});
