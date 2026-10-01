const test = require('node:test');
const assert = require('node:assert/strict');
const Plan = require('../app/plan-review.js');
const Core = require('../app/workstation-core.js');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(actions = [{ type: 'update_task', taskId: 'task', patch: { title: 'Reviewed task' } }], overrides = {}) {
  const state = { projects: [{ id: 'project', name: 'Research project', workspace: '科研' }], tasks: [{ id: 'task', title: 'Original task', workspace: '科研', projectId: 'project', status: 'todo', priority: 'medium', updatedAt: 1 }], notes: [{ id: 'note', title: 'Other note', content: 'Keep this', projectId: 'project', workspace: '科研', updatedAt: 1 }], imports: [{ id: 'source', name: 'Source.pdf', content: 'Source text', projectId: 'project', workspace: '科研', updatedAt: 1 }], attachments: [], links: [], papers: [], trash: [], conversations: [{ id: 'chat', projectId: 'project', workspace: '科研' }], agentRuns: [{ id: 'run', status: 'awaiting-approval', workspace: '科研', projectId: 'project', conversationId: 'chat', pendingActions: clone(actions) }] };
  const calls = { save: 0, preview: 0, changed: [] };
  const host = { getState: () => state, getRun: id => state.agentRuns.find(run => run.id === id), contextForRun: run => ({ workspace: run.workspace, projectId: run.projectId, conversationId: run.conversationId, runId: run.id, protectNoteUpdates: true }), applyPlan: (...args) => { calls.preview++; return Core.applyPlan(...args); }, save: async () => { calls.save++; return true; }, onChanged: (id, reason) => calls.changed.push(reason), ...overrides };
  const api = Plan.createController(host); return { state, host, calls, api, get run() { return state.agentRuns[0]; }, get row() { return api.draft('run').rows[0]; } };
}
test('preview uses the real transactional core and never mutates workspace or consumes real ids', () => {
  const f = fixture(), before = clone(f.state); const d = f.api.draft('run'); assert.equal(d.validation.ok, true); assert.equal(d.validation.results[0].text, '更新任务：Reviewed task'); assert.deepEqual(f.state, before); assert.equal(f.calls.save, 0);
});
test('legal field editing changes only in-memory draft, and every edit revalidates the whole plan', () => {
  const f = fixture(); f.api.edit('run', f.row.key, 'patch.title', 'Edited title'); assert.equal(f.api.dirty('run'), true); assert.equal(f.run.pendingActions[0].patch.title, 'Reviewed task'); assert.equal(f.state.tasks[0].title, 'Original task'); assert.equal(f.calls.preview, 2);
  f.api.edit('run', f.row.key, 'patch.dueAt', '2026-02-31'); assert.equal(f.api.draft('run').validation.ok, false); assert.throws(() => f.api.capture('run'), { code: 'PLAN_UNSAVED' });
});
test('unsupported fields cannot change an action, including type, arbitrary id and unsafe patch keys', () => {
  const f = fixture(); for (const key of ['type', '__proto__.polluted', 'patch.agentRunId', 'taskId']) assert.throws(() => f.api.edit('run', f.row.key, key, 'x'), { code: 'PLAN_FIELD' }); assert.equal(f.api.dirty('run'), false); assert.equal({}.polluted, undefined);
});
test('saved selected steps become the exact immutable approval token', async () => {
  const f = fixture([{ type: 'create_task', title: 'Keep me' }, { type: 'create_note', title: 'Skip me', content: 'draft' }]); const d = f.api.draft('run'); f.api.toggle('run', d.rows[1].key, false); await f.api.save('run'); const token = f.api.capture('run'); assert.deepEqual(token.actions, [{ type: 'create_task', title: 'Keep me' }]); assert.equal(f.api.dirty('run'), false); assert.equal(f.calls.save, 1); assert.equal(Object.isFrozen(token.actions[0]), true); assert.deepEqual(f.api.assertCurrent(token), token.actions); assert.equal(f.state.tasks.length, 1);
});
test('removing or reordering a prerequisite never silently repairs dependent project references', () => {
  const f = fixture([{ type: 'create_project', name: 'New project', id: 'future-project', workspace: '科研' }, { type: 'create_task', title: 'Dependent', projectId: 'future-project' }]); const d = f.api.draft('run'); f.api.toggle('run', d.rows[0].key, false); assert.equal(d.validation.ok, false); assert.equal(d.rows[1].action.projectId, 'future-project'); f.api.toggle('run', d.rows[0].key, true); assert.equal(d.validation.ok, true); f.api.move('run', d.rows[1].key, -1); assert.equal(d.validation.ok, false); f.api.move('run', d.rows[0].key, 1); assert.equal(d.validation.ok, true);
});
test('task dependencies are verified by Core and remain explicit after removing a create step', () => {
  const f = fixture([{ type: 'create_task', id: 'prerequisite', title: 'First' }, { type: 'create_task', title: 'Second', dependsOn: ['prerequisite'] }]); const d = f.api.draft('run'); assert.equal(d.validation.ok, true); f.api.toggle('run', d.rows[0].key, false); assert.equal(d.validation.ok, false); assert.deepEqual(d.rows[1].action.dependsOn, ['prerequisite']); f.api.edit('run', d.rows[1].key, 'dependsOn', []); assert.equal(d.validation.ok, true);
});
test('empty retained plan cannot be saved or approved; reject is a separate host action', async () => {
  const f = fixture(); f.api.toggle('run', f.row.key, false); assert.equal(f.api.draft('run').validation.ok, false); await assert.rejects(f.api.save('run'), { code: 'PLAN_INVALID' }); assert.equal(f.calls.save, 0);
});
test('an object changed after display is rejected before capture instead of silently adopting the new version', () => {
  const f = fixture(); f.api.draft('run'); f.state.tasks[0].description = 'Changed while viewed'; assert.throws(() => f.api.capture('run'), { code: 'PLAN_TARGET_CHANGED' }); assert.throws(() => f.api.edit('run', f.row.key, 'patch.title', 'new'), { code: 'PLAN_TARGET_CHANGED' }); assert.equal(f.run.pendingActions[0].patch.title, 'Reviewed task');
});
test('token blocks object changes during an awaited approval while allowing unrelated note edits', () => {
  const f = fixture(); const token = f.api.capture('run'); f.state.notes[0].content = 'Unrelated typing'; assert.deepEqual(f.api.assertCurrent(token), token.actions); f.state.tasks[0].updatedAt = 2; assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_TARGET_CHANGED' });
});
test('newly inserted deduplication candidate invalidates creation approval', () => {
  const f = fixture([{ type: 'create_task', title: 'New task' }]); const token = f.api.capture('run'); f.state.tasks.push({ id: 'new', title: 'New task', workspace: '科研', projectId: 'project' }); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_TARGET_CHANGED' });
});
test('source changes, links and routing changes are included in the reviewed snapshot', () => {
  for (const change of [f => { f.state.imports[0].content = 'New excerpt'; }, f => { f.state.conversations[0].projectId = null; }, f => { f.state.projects[0].name = 'Renamed'; }, f => { f.state.links.push({ id: 'new-link', sourceId: 'source', targetId: 'note' }); }]) { const f = fixture([{ type: 'create_note', title: 'Summary', content: 'Facts', sourceAttachmentIds: ['source'] }]); const token = f.api.capture('run'); change(f); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_TARGET_CHANGED' }); }
});
test('context permission changes invalidate approval even if action objects are unchanged', () => {
  const f = fixture(); const token = f.api.capture('run'); f.host.contextForRun = run => ({ workspace: run.workspace, projectId: run.projectId, allowedTaskIds: [] }); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_SCOPE_CHANGED' });
});
test('plan edits, external replacement, terminal run and forged tokens cannot reuse approval', async () => {
  const f = fixture(); const token = f.api.capture('run'); f.api.edit('run', f.row.key, 'patch.title', 'A different plan'); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_CHANGED' }); await f.api.save('run'); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_CHANGED' }); const next = f.api.capture('run'); f.run.pendingActions[0].patch.title = 'External'; assert.throws(() => f.api.assertCurrent(next), { code: 'PLAN_CHANGED' }); assert.throws(() => f.api.assertCurrent(clone(next)), { code: 'PLAN_TOKEN' }); f.run.status = 'completed'; assert.throws(() => f.api.capture('run'), { code: 'PLAN_GONE' });
});
test('explicit recheck updates displayed objects but invalidates old tokens and retains user edits', () => {
  const f = fixture(); const token = f.api.capture('run'); f.api.edit('run', f.row.key, 'patch.title', 'Retained draft'); f.state.tasks[0].description = 'New actual content'; f.api.refresh('run'); assert.equal(f.api.draft('run').stale, true); f.api.recheck('run'); assert.equal(f.api.draft('run').stale, false); assert.equal(f.api.actions('run')[0].patch.title, 'Retained draft'); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_CHANGED' });
});
test('reloading external plan preserves old unsaved actions for explicit copying', () => {
  const f = fixture(); f.api.edit('run', f.row.key, 'patch.title', 'Keep old draft'); f.run.pendingActions = [{ type: 'create_task', title: 'External new plan' }]; assert.throws(() => f.api.recheck('run'), { code: 'PLAN_CHANGED' }); const d = f.api.reload('run'); assert.equal(d.previousDraft[0].patch.title, 'Keep old draft'); assert.equal(d.rows[0].action.title, 'External new plan'); assert.equal(f.api.capture('run').actions[0].title, 'External new plan');
});
test('saving awaits durability, rejects edits and approval, and retains draft after false save', async () => {
  const deferredSave = deferred(), f = fixture(undefined, { save: () => deferredSave.promise }); f.api.edit('run', f.row.key, 'patch.title', 'Retry draft'); const promise = f.api.save('run'); assert.equal(f.api.anyBusy(), true); assert.throws(() => f.api.edit('run', f.row.key, 'patch.title', 'Too soon'), { code: 'PLAN_BUSY' }); assert.throws(() => f.api.capture('run'), { code: 'PLAN_BUSY' }); deferredSave.resolve(false); await assert.rejects(promise, { code: 'PLAN_SAVE' }); assert.equal(f.run.pendingActions[0].patch.title, 'Reviewed task'); assert.equal(f.api.actions('run')[0].patch.title, 'Retry draft'); assert.equal(f.api.dirty('run'), true); assert.equal(f.api.anyBusy(), false);
});
test('failed save rollback does not overwrite external pendingActions, resurrect a run or change messages', async () => {
  for (const remove of [false, true]) { const wait = deferred(), f = fixture(undefined, { save: () => wait.promise }); f.api.edit('run', f.row.key, 'patch.title', 'My draft'); const promise = f.api.save('run'); f.state.conversations[0].draft = 'Typed concurrently'; if (remove) f.state.agentRuns = []; else f.run.pendingActions = [{ type: 'create_note', title: 'Other writer' }]; wait.reject(Error('Disk failed')); await assert.rejects(promise, /Disk failed/); assert.equal(f.state.conversations[0].draft, 'Typed concurrently'); if (remove) assert.equal(f.state.agentRuns.length, 0); else assert.equal(f.run.pendingActions[0].title, 'Other writer'); }
});
test('a successful save followed by target changes keeps durable plan and blocks approval until recheck', async () => {
  const wait = deferred(), f = fixture(undefined, { save: () => wait.promise }); f.api.edit('run', f.row.key, 'patch.title', 'Saved new plan'); const promise = f.api.save('run'); f.state.tasks[0].description = 'Target changed during save'; wait.resolve(true); await assert.rejects(promise, { code: 'PLAN_TARGET_CHANGED' }); assert.equal(f.run.pendingActions[0].patch.title, 'Saved new plan'); assert.equal(f.api.dirty('run'), false); assert.throws(() => f.api.capture('run'), { code: 'PLAN_TARGET_CHANGED' }); f.api.recheck('run'); assert.equal(f.api.capture('run').actions[0].patch.title, 'Saved new plan');
});
test('host approval lock rejects edit, reorder, toggle, save, recheck and reload', async () => {
  let lock = false; const f = fixture(undefined, { isBusy: () => lock }); const token = f.api.capture('run'); lock = true;
  for (const fn of [() => f.api.edit('run', f.row.key, 'patch.title', 'No'), () => f.api.move('run', f.row.key, 1), () => f.api.toggle('run', f.row.key, false), () => f.api.recheck('run'), () => f.api.reload('run')]) assert.throws(fn, { code: 'PLAN_BUSY' }); await assert.rejects(f.api.save('run'), { code: 'PLAN_BUSY' }); assert.deepEqual(f.api.assertCurrent(token), token.actions);
});
test('project selector removes conflicting legacy route aliases and preserves explicit standalone', () => {
  const f = fixture([{ type: 'create_note', title: 'Note', project: 'Research project', projectName: 'Research project', content: 'body' }]); f.api.edit('run', f.row.key, 'projectId', null); assert.equal(f.api.draft('run').validation.ok, true); const action = f.api.actions('run')[0]; assert.equal(action.projectId, null); assert.equal(Object.hasOwn(action, 'project'), false); assert.equal(Object.hasOwn(action, 'projectName'), false); const fields = Plan.fieldsFor(action, f.state, {}, [action]); assert.equal(fields.find(field => field.key === 'projectId').value, '__standalone');
});
test('legacy status aliases and body/title aliases are removed only after explicit editing', () => {
  const f = fixture([{ type: 'update_task', taskId: 'task', status: 'todo', patch: { title: 'T' } }]); f.api.edit('run', f.row.key, 'patch.status', 'in_progress'); assert.equal(Object.hasOwn(f.api.actions('run')[0], 'status'), false); assert.equal(f.api.draft('run').validation.ok, true);
});
test('malformed, unavailable and unsafe scoped deletion plans remain blocked by Core', () => {
  for (const action of [{ type: 'launch_shell', command: 'echo forbidden' }, { type: 'delete_attachment', attachmentId: 'source' }, { type: 'update_note', noteId: 'missing', patch: { content: 'x' } }]) { const f = fixture([action]); assert.equal(f.api.draft('run').validation.ok, false); assert.throws(() => f.api.capture('run'), { code: 'PLAN_INVALID' }); }
});
test('duplicate title normalization matches Core punctuation and whitespace semantics', () => {
  const f = fixture([{ type: 'create_note', title: 'New · note', content: 'New proposal' }]); const token = f.api.capture('run'); f.state.notes.push({ id: 'dedupe-note', title: 'new_note', content: 'Human text', userEdited: true, projectId: 'project', workspace: '科研' }); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_TARGET_CHANGED' });
});
test('transitive dependency change and completion evidence are protected during approval', () => {
  const f = fixture([{ type: 'update_task', taskId: 'task', patch: { dependsOn: ['dep1'] } }]); f.state.tasks.push({ id: 'dep1', title: 'One', status: 'todo', projectId: 'project', workspace: '科研', dependsOn: ['dep2'] }, { id: 'dep2', title: 'Two', status: 'todo', projectId: 'project', workspace: '科研' }); const token = f.api.capture('run'); f.state.tasks[2].dependsOn = ['task']; assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_TARGET_CHANGED' });
  const g = fixture([{ type: 'update_task', taskId: 'task', patch: { status: 'done' } }]); const done = g.api.capture('run'); g.state.notes[0].content = 'Completion evidence changed'; assert.throws(() => g.api.assertCurrent(done), { code: 'PLAN_TARGET_CHANGED' });
});
test('repeated renderer refreshes reuse a validated plan until related content changes', () => {
  const f = fixture(); f.api.draft('run'); const count = f.calls.preview; for (let i = 0; i < 30; i++) f.api.refresh('run'); assert.equal(f.calls.preview, count); f.api.edit('run', f.row.key, 'patch.title', 'Changed once'); assert.equal(f.calls.preview, count + 1); f.state.tasks[0].description = 'Changed elsewhere'; f.api.refresh('run'); assert.equal(f.calls.preview, count + 2);
});
test('terminal runs do not leave stale editing flags that block workspace reconciliation', () => {
  const f = fixture(); f.api.edit('run', f.row.key, 'patch.title', 'Unsaved'); assert.equal(f.api.isEditing(), true); f.run.status = 'rejected'; assert.equal(f.api.isEditing(), false);
});
test('visible destinations follow retained set_workspace order and the actual project creation step', () => {
  const f = fixture(), sequence = [{ type: 'set_workspace', workspace: '课程' }, { type: 'create_project', id: 'future', name: 'Future course' }, { type: 'set_workspace', workspace: '日常' }, { type: 'create_note', projectId: 'future', title: 'Course notes' }];
  const project = Plan.describe(sequence[1], f.state, { workspace: '科研' }, sequence); assert.equal(project.project, 'Future course'); assert.equal(project.workspace, '课程');
  const note = Plan.describe(sequence[3], f.state, { workspace: '科研' }, sequence); assert.equal(note.project, 'Future course'); assert.equal(note.workspace, '课程');
  const independent = { type: 'create_task', title: 'Standalone' }; assert.equal(Plan.describe(independent, f.state, { workspace: '科研' }, [sequence[0], independent]).workspace, '课程');
});
test('collapsed action cards describe actual edited fields and linked endpoints', () => {
  const f = fixture(); const detail = Plan.describe(f.run.pendingActions[0], f.state, {}, f.run.pendingActions); assert.deepEqual(detail.changes[0], { label: '标题', before: 'Original task', after: 'Reviewed task' });
  const link = { type: 'create_link', sourceId: 'source', targetId: 'note', relation: 'source' }; assert.equal(Plan.describe(link, f.state, {}, [link]).title, 'Source.pdf → Other note');
});
test('terminal cleanup removes old window drafts and invalidates tokens even if a run id is reused', () => {
  const f = fixture(); const token = f.api.capture('run'); const original = clone(f.run); f.run.status = 'rejected'; f.api.cleanup(); f.state.agentRuns[0] = original; f.api.draft('run'); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_CHANGED' });
});
test('explicit host recheck validates refreshed task snapshots and leaves old baseline on rollback failure', () => {
  const f = fixture(); let taskSnapshot = clone(f.state.tasks[0]); const originalApply = f.host.applyPlan;
  f.host.applyPlan = (...args) => { if (Plan.stable(taskSnapshot) !== Plan.stable(f.state.tasks[0])) throw Error('Task snapshot changed'); return originalApply(...args); };
  f.host.recheckPlan = (run, actions, validate) => { const old = taskSnapshot; taskSnapshot = clone(f.state.tasks[0]); try { return validate(); } catch (error) { taskSnapshot = old; throw error; } };
  const token = f.api.capture('run'); const baseline = f.api.draft('run').baseline, revision = f.api.draft('run').revision;
  f.api.edit('run', f.row.key, 'patch.dueAt', 'invalid-date'); f.state.tasks[0].description = 'New state';
  assert.throws(() => f.api.recheck('run'), { code: 'PLAN_INVALID' }); assert.equal(f.api.draft('run').revision, revision + 1); assert.equal(f.api.draft('run').baseline, baseline); assert.equal(taskSnapshot.description, undefined); assert.throws(() => f.api.assertCurrent(token), { code: 'PLAN_CHANGED' });
  // Reload deliberately discards the invalid edit, retaining it for copying.
  f.api.reload('run'); f.api.recheck('run'); assert.equal(taskSnapshot.description, 'New state'); assert.equal(f.api.capture('run').actions[0].patch.title, 'Reviewed task');
});
test('host recheck must synchronously invoke full validation before a new baseline is adopted', () => {
  const f = fixture(undefined, { recheckPlan: () => true }); f.api.draft('run'); const old = f.api.draft('run').baseline, rev = f.api.draft('run').revision; f.state.tasks[0].title = 'Changed'; assert.throws(() => f.api.recheck('run'), { code: 'PLAN_RECHECK' }); assert.equal(f.api.draft('run').baseline, old); assert.equal(f.api.draft('run').revision, rev);
});
test('field decisions actually remove rejected task values and top-level status aliases from execution', async()=>{
 const f=fixture([{type:'update_task',taskId:'task',status:'done',patch:{status:'blocked',priority:'high',description:'Accepted description',unrecognised:'preserved parameter'}}]);
 f.api.decideField('run',f.row.key,'patch.status',false);await f.api.save('run');const actions=f.api.capture('run').actions;
 assert.equal(Object.hasOwn(actions[0],'status'),false);assert.equal(Object.hasOwn(actions[0].patch,'status'),false);assert.equal(actions[0].patch.unrecognised,'preserved parameter');
 const outcome=Core.applyPlan(f.state,actions);assert.equal(outcome.state.tasks[0].status,'todo');assert.equal(outcome.state.tasks[0].priority,'high');assert.equal(outcome.state.tasks[0].description,'Accepted description');assert.equal(outcome.state.tasks[0].completedAt,undefined);
});
test('rejecting every real field suppresses the step, saves choices, and never offers an executable empty action',async()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'Proposed',priority:'high',unknown:'keep proposal'}}]); const before=clone(f.state);
 for(const path of ['patch.title','patch.priority'])f.api.decideField('run',f.row.key,path,false);
 assert.deepEqual(f.api.actions('run'),[]);assert.equal(f.api.fieldReview('run').reviews.get(f.row.key).suppressed,true);await f.api.save('run');assert.deepEqual(f.run.pendingActions,[]);assert.throws(()=>f.api.capture('run'),{code:'PLAN_INVALID'});
 assert.deepEqual(f.state.tasks,before.tasks);assert.deepEqual(f.state.projects,before.projects);
 const reloaded=Plan.createController(f.host);const row=reloaded.draft('run').rows[0];assert.equal(row.action.patch.title,'Proposed');assert.equal(row.action.patch.unknown,'keep proposal');assert.equal(row.decisions['patch.title'],'reject');reloaded.decideField('run',row.key,'patch.title',true);await reloaded.save('run');assert.deepEqual(reloaded.capture('run').actions[0].patch,{title:'Proposed',unknown:'keep proposal'});
});
test('no-op fields are suppressed using Core normalization without touching task, project or originalName',async()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'  Original task  ',priority:'medium',dependsOn:['dep','dep'],checklist:['Keep text']}},{type:'rename_attachment',attachmentId:'source',newName:'Source.pdf'}]);f.state.tasks[0].dependsOn=['dep'];f.state.tasks[0].checklist=[{text:'Keep text',done:false}];f.state.tasks.push({id:'dep',title:'Dep',workspace:'科研',projectId:'project',status:'todo'});
 assert.deepEqual(f.api.actions('run'),[]);assert.equal(f.state.imports[0].originalName,undefined);await f.api.save('run');assert.equal(f.state.tasks[0].updatedAt,1);assert.equal(f.state.projects[0].updatedAt,undefined);
 const rename=fixture([{type:'rename_attachment',attachmentId:'source',newName:'Source/PDF'}]);rename.state.imports[0].name='Source-PDF';assert.deepEqual(rename.api.actions('run'),[]);
});
test('field rejection can make an invalid date pair legal but cannot bypass retained dependency/date validation',()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{startAt:'2026-10-04',dueAt:'2026-10-01',priority:'high'}}]);f.state.tasks[0].startAt='2026-09-01';assert.equal(f.api.draft('run').validation.ok,false);f.api.decideField('run',f.row.key,'patch.startAt',false);assert.equal(f.api.draft('run').validation.ok,true);assert.equal(f.api.actions('run')[0].patch.startAt,undefined);
 f.api.edit('run',f.row.key,'patch.dependsOn',['missing']);assert.equal(f.api.draft('run').validation.ok,false);f.api.decideField('run',f.row.key,'patch.dependsOn',false);assert.equal(f.api.draft('run').validation.ok,true);
});
test('all supported task patch fields can be retained or rejected without dropping other parameters',async()=>{
 const patch={title:'New title',description:' new description ',status:'in_progress',priority:'high',startAt:'2026-10-01',dueAt:'2026-10-02',reminderMinutes:30,checklist:[{text:'step',done:true}],dependsOn:['dep']};
 const f=fixture([{type:'update_task',taskId:'task',patch}]);f.state.tasks.push({id:'dep',title:'Dep',status:'todo',projectId:'project',workspace:'科研'});const review=f.api.fieldReview('run').reviews.get(f.row.key);assert.equal(review.fields.length,9);
 for(const field of review.fields)f.api.decideField('run',f.row.key,field.path,false);assert.deepEqual(f.api.actions('run'),[]);for(const field of review.fields)f.api.decideField('run',f.row.key,field.path,true);await f.api.save('run');assert.deepEqual(f.run.pendingActions[0].patch,patch);
});
test('successive task and rename before-values follow accepted prefix, rejected prefix, and reordering',()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'Middle'}},{type:'update_task',taskId:'task',patch:{title:'Last'}},{type:'rename_attachment',attachmentId:'source',newName:'Middle.pdf'},{type:'rename_attachment',attachmentId:'source',newName:'Last.pdf'}]);const rows=f.api.draft('run').rows;
 const before=index=>f.api.fieldReview('run').reviews.get(rows[index].key).fields[0].before;
 assert.equal(before(1),'Middle');assert.equal(before(3),'Middle.pdf');f.api.decideField('run',rows[0].key,'patch.title',false);assert.equal(before(1),'Original task');f.api.decideField('run',rows[2].key,'newName',false);assert.equal(before(3),'Source.pdf');
 f.api.decideField('run',rows[0].key,'patch.title',true);f.api.move('run',rows[1].key,-1);const ordered=f.api.draft('run').rows;assert.equal(f.api.fieldReview('run').reviews.get(ordered[1].key).fields[0].before,'Last');
});
test('edited proposal remains distinct from first review proposal and rejected fields can be restored before or after saving',async()=>{
 const f=fixture();const key=f.row.key;f.api.edit('run',key,'patch.title','User rewrite');f.api.decideField('run',key,'patch.title',false);let field=f.api.fieldReview('run').reviews.get(key).fields[0];assert.equal(field.original,'Reviewed task');assert.equal(field.proposed,'User rewrite');assert.equal(field.edited,true);await f.api.save('run');
 const reloaded=Plan.createController(f.host);field=reloaded.fieldReview('run').reviews.get(key).fields[0];assert.equal(field.original,'Reviewed task');assert.equal(field.proposed,'User rewrite');assert.equal(field.accepted,false);reloaded.decideField('run',key,'patch.title',true);await reloaded.save('run');assert.equal(reloaded.capture('run').actions[0].patch.title,'User rewrite');
});
test('persisted field choices restore only when checksum, exact compiled pending plan and context all match',async()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'Review',priority:'high'}}]);f.api.decideField('run',f.row.key,'patch.title',false);await f.api.save('run');const original=clone(f.run.planFieldReview);
 for(const mutate of [m=>m.rows[0].decisions['patch.title']='accept',m=>m.rows[0].action.patch.title='Changed rejected proposal',m=>m.rows[0].originalFields['patch.title']='Changed start',m=>m.rows.push(clone(m.rows[0])),m=>m.contextFingerprint='different']){const tampered=clone(original);mutate(tampered);f.run.planFieldReview=tampered;const api=Plan.createController(f.host);assert.equal(api.draft('run').rows[0].action.patch.title,undefined);assert.match(api.draft('run').notice,/不一致/);}
 f.run.planFieldReview=original;f.run.pendingActions[0].patch.priority='low';const api=Plan.createController(f.host);assert.equal(api.draft('run').rows[0].action.patch.priority,'low');assert.equal(api.draft('run').rows[0].decisions['patch.title'],undefined);
});
test('saved choices reloaded against changed target retain proposal but require explicit recheck before use',async()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'Review',priority:'high'}}]);f.api.decideField('run',f.row.key,'patch.title',false);await f.api.save('run');f.state.tasks[0].title='New actual title';const api=Plan.createController(f.host),row=api.draft('run').rows[0];assert.equal(row.action.patch.title,'Review');assert.equal(api.fieldReview('run').reviews.get(row.key).fields[0].before,'Original task');assert.throws(()=>api.capture('run'),{code:'PLAN_TARGET_CHANGED'});api.recheck('run');assert.equal(api.fieldReview('run').reviews.get(row.key).fields[0].before,'New actual title');assert.equal(api.capture('run').actions[0].patch.title,undefined);
});
test('rejected fields and temporarily excluded rows keep complete target CAS until explicit recheck',async()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'Review',priority:'high'}},{type:'rename_attachment',attachmentId:'source',newName:'New.pdf'}]);const rows=f.api.draft('run').rows;f.api.decideField('run',rows[0].key,'patch.title',false);f.api.toggle('run',rows[1].key,false);f.state.imports[0].name='Changed externally';assert.throws(()=>f.api.toggle('run',rows[1].key,true),{code:'PLAN_TARGET_CHANGED'});f.api.recheck('run');assert.equal(f.api.fieldReview('run').reviews.get(rows[1].key).fields[0].before,'Changed externally');f.state.tasks[0].title='Rejected field changed externally';await assert.rejects(f.api.save('run'),{code:'PLAN_TARGET_CHANGED'});
});
test('failed dual-field save rolls back owned metadata and actions, preserving selection drafts and concurrent writers',async()=>{
 const gate=deferred(),f=fixture(undefined,{save:()=>gate.promise});f.api.decideField('run',f.row.key,'patch.title',false);const pending=f.api.save('run');assert.ok(f.run.planFieldReview);gate.reject(Error('disk unavailable'));await assert.rejects(pending,/disk unavailable/);assert.equal(f.run.planFieldReview,undefined);assert.equal(f.run.pendingActions[0].patch.title,'Reviewed task');assert.equal(f.api.fieldReview('run').reviews.get(f.row.key).fields[0].accepted,false);
 const gate2=deferred();f.host.save=()=>gate2.promise;const pending2=f.api.save('run');f.run.planFieldReview={version:99,other:'writer'};f.run.pendingActions=[{type:'create_note',title:'Other writer'}];gate2.reject(Error('disk unavailable'));await assert.rejects(pending2);assert.deepEqual(f.run.planFieldReview,{version:99,other:'writer'});assert.equal(f.run.pendingActions[0].title,'Other writer');
});
test('failed latest-version recheck restores field before-values and does not advance target snapshot',()=>{
 const f=fixture();f.host.recheckPlan=(_run,_actions,validate)=>validate();const d=f.api.draft('run'),base=clone(d.reviewBase),baseline=d.baseline;f.api.edit('run',f.row.key,'patch.dueAt','invalid');f.state.tasks[0].title='Latest title';assert.throws(()=>f.api.recheck('run'),{code:'PLAN_INVALID'});assert.deepEqual(d.reviewBase,base);assert.equal(d.baseline,baseline);assert.equal(f.api.fieldReview('run').reviews.get(f.row.key).fields[0].before,'Original task');
});
test('invalid checklist entries remain invalid until explicitly rejected instead of becoming a false no-op',()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{checklist:[null],priority:'high'}}]);f.state.tasks[0].checklist=[];
 assert.equal(f.api.draft('run').validation.ok,false);assert.deepEqual(f.api.actions('run')[0].patch.checklist,[null]);f.api.decideField('run',f.row.key,'patch.checklist',false);assert.equal(f.api.draft('run').validation.ok,true);assert.deepEqual(f.api.actions('run')[0].patch,{priority:'high'});
});
test('update project editor promises only the routing behavior that Core implements',()=>{
 const f=fixture();const spec=Plan.fieldsFor({type:'update_task',taskId:'task',projectId:null,patch:{title:'X'}},f.state,{projectId:'project'},[]).find(field=>field.key==='projectId');assert.equal(spec.value,'');assert.equal(spec.options.some(option=>option.value==='__standalone'),false);assert.match(spec.options[0].label,/保留现有归属/);
 const create=Plan.fieldsFor({type:'create_task',title:'X'},f.state,{projectId:'project'},[]).find(field=>field.key==='projectId');assert.equal(create.options.some(option=>option.value==='__standalone'),true);
});
test('duplicate equal proposals retain stable row decisions across reorder, save and reload',async()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'Same'}},{type:'update_task',taskId:'task',patch:{title:'Same'}}]);const [a,b]=f.api.draft('run').rows;f.api.decideField('run',a.key,'patch.title',false);f.api.move('run',b.key,-1);await f.api.save('run');const next=Plan.createController(f.host),rows=next.draft('run').rows;assert.deepEqual(rows.map(row=>row.key),[b.key,a.key]);assert.equal(rows[1].decisions['patch.title'],'reject');assert.equal(next.capture('run').actions.length,1);
});
test('metadata restoration checks exact compiled actions even when the metadata checksum is coherent',async()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'Review',priority:'high'}},{type:'create_note',title:'Keep exact action',content:'Body'}]);f.api.decideField('run',f.row.key,'patch.title',false);await f.api.save('run');
 const stamp=text=>{let a=0x811c9dc5,b=0x9e3779b9;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,0x01000193)>>>0;b=Math.imul(b^c,0x85ebca6b)>>>0;}return `${text.length}:${a}:${b}`;};
 const metadata=clone(f.run.planFieldReview);metadata.rows[1].action.content='Different content';delete metadata.checksum;metadata.checksum=stamp(Plan.stable(metadata));f.run.planFieldReview=metadata;
 const api=Plan.createController(f.host);assert.match(api.draft('run').notice,/不一致/);assert.equal(api.actions('run')[1].content,'Body');assert.equal(api.actions('run')[0].patch.title,undefined);
});
test('explicit recheck refreshes authorized task versions even when every field was rejected, without executing them',async()=>{
 const TaskContext=require('../app/task-context.js');const f=fixture();f.run.taskContext=TaskContext.build(f.state,f.state.conversations[0],{goal:'Review original task'});
 f.host.contextForRun=run=>({workspace:run.workspace,projectId:run.projectId,conversationId:run.conversationId,runId:run.id,allowedTaskIds:run.taskContext.taskIds});
 f.host.applyPlan=(state,actions,context)=>{TaskContext.assertUnchanged(state,actions,f.run.taskContext.snapshots);return Core.applyPlan(state,actions,context);};
 let targets,executing;f.host.recheckPlan=(run,actions,validate,reviewTargets)=>{targets=clone(reviewTargets);executing=clone(actions);const before=run.taskContext.snapshots;try{run.taskContext.snapshots=TaskContext.refreshForReview(f.state,reviewTargets,before);return validate();}catch(error){run.taskContext.snapshots=before;throw error;}};
 f.api.decideField('run',f.row.key,'patch.title',false);await f.api.save('run');f.state.tasks[0].description='Changed after rejecting all fields';f.api.recheck('run');assert.deepEqual(executing,[]);assert.equal(targets[0].taskId,'task');assert.equal(f.state.tasks[0].title,'Original task');
 f.api.decideField('run',f.row.key,'patch.title',true);assert.equal(f.api.draft('run').validation.ok,true);await f.api.save('run');const outcome=Core.applyPlan(f.state,f.api.capture('run').actions);assert.equal(outcome.state.tasks[0].title,'Reviewed task');assert.equal(outcome.state.tasks[0].description,'Changed after rejecting all fields');
});
test('recheck target versions cannot enlarge allowed task scope or acknowledge another writer field decisions',()=>{
 const f=fixture([{type:'update_task',taskId:'task',patch:{title:'Review'}},{type:'update_task',taskId:'foreign',patch:{title:'Never authorized'}}]);f.host.contextForRun=()=>({workspace:'科研',projectId:'project',allowedTaskIds:['task']});const rows=f.api.draft('run').rows;f.api.toggle('run',rows[1].key,false);let targets;f.host.recheckPlan=(_run,_actions,validate,reviewTargets)=>{targets=reviewTargets;return validate();};f.api.recheck('run');assert.deepEqual(targets.map(action=>action.taskId),['task']);const baseline=f.api.draft('run').baseline;f.run.planFieldReview={otherWriter:true};assert.throws(()=>f.api.recheck('run'),{code:'PLAN_CHANGED'});assert.equal(f.api.draft('run').baseline,baseline);
});
