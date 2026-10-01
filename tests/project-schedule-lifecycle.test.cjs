const test = require('node:test');
const assert = require('node:assert/strict');
function fresh() { delete require.cache[require.resolve('../app/project-schedule.js')]; return require('../app/project-schedule.js'); }
const fixture = () => ({ projects: [{ id: 'a', plan: 'A saved', updatedAt: 10 }, { id: 'b', plan: 'B saved' }], tasks: [{ id: 'task-a', projectId: 'a', title: 'Task A', dueAt: '2026-10-01' }], notes: [], imports: [], papers: [], agentRuns: [], conversations: [], trash: [] });
function harness(overrides = {}) {
  const api = fresh(), host = { isConnected: true }, lifecycle = [], calls = [];
  let state = fixture(), props, projectId = 'a';
  api.init({ getState: () => state, persist: async () => true, openTask: (...args) => calls.push(args),
    mount: (target, name, value) => { assert.equal(target, host); assert.equal(name, 'ProjectScheduleSurface'); props = value; lifecycle.push('mount'); return { update(value) { props = value; lifecycle.push('update'); }, unmount() { lifecycle.push('unmount'); } }; }, ...overrides });
  const control = api.mount(host, projectId);
  return { api, host, control, lifecycle, calls, get state() { return state; }, get props() { return props; },
    sync() { api.mount(host, projectId); }, switch(id) { projectId = id; api.mount(host, id); }, replace(value) { state = value; api.mount(host, projectId); } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('same-owner refresh keeps the island and draft; project changes remount without cross-writing', () => {
  const h = harness(), old = h.props;
  old.onPlanToggle(true); h.props.onPlanChange('A unsaved'); h.sync();
  assert.equal(h.props.plan.value, 'A unsaved'); assert.equal(h.props.plan.open, true);
  assert.equal(h.lifecycle.filter(value => value === 'mount').length, 1); assert.equal(h.api.isDirty(), true);
  h.switch('b'); assert.equal(h.props.plan.value, 'B saved'); old.onPlanChange('stale A callback');
  h.props.onPlanChange('B unsaved'); h.switch('a'); assert.equal(h.props.plan.value, 'A unsaved');
  h.switch('b'); assert.equal(h.props.plan.value, 'B unsaved'); assert.equal(h.api.getDraftSummary().count, 2);
  assert.equal(h.state.projects[0].plan, 'A saved'); assert.equal(h.state.projects[1].plan, 'B saved');
});

test('unmount/new host retains project-local draft but retires callbacks and IME state', () => {
  const h = harness(); h.props.onPlanComposition(true); h.props.onPlanChange('组合草稿'); const stale = h.props;
  h.api.unmount(h.host); stale.onPlanChange('must not apply');
  const control = h.api.mount(h.host, 'a'); assert.notEqual(control, h.control);
  assert.equal(h.props.plan.value, '组合草稿'); assert.equal(h.props.plan.composing, false);
  assert.equal(h.lifecycle.filter(value => value === 'unmount').length, 1);
});

test('IME cannot submit and an old composition callback cannot write the next project', async () => {
  let saves = 0; const h = harness({ persist: async () => { saves++; return true; } });
  h.props.onPlanComposition(true); h.props.onPlanChange('拼音候选'); const stale = h.props;
  assert.equal(await stale.onPlanSave(), false); h.switch('b'); stale.onPlanChange('late composition end'); stale.onPlanComposition(false);
  assert.equal(h.props.plan.value, 'B saved'); assert.equal(h.props.plan.composing, false); assert.equal(saves, 0);
});

test('saving waits for durable ACK, suppresses duplicates, and does not persist week navigation', async () => {
  const gate = deferred(); let saves = 0;
  const h = harness({ persist: () => { saves++; return gate.promise; } });
  h.props.onWeek(1); h.props.onWeek(-1); assert.equal(saves, 0);
  h.props.onPlanChange('A new'); const operation = h.props.onPlanSave();
  assert.equal(h.props.plan.busy, true); assert.equal(h.props.plan.saved, false); assert.equal(h.api.isBusy(), true); assert.equal(h.api.isDirty(), true);
  assert.equal(await h.props.onPlanSave(), false); h.props.onPlanChange('ignored while saving');
  gate.resolve(true); assert.equal(await operation, true); assert.equal(saves, 1);
  assert.equal(h.state.projects[0].plan, 'A new'); assert.equal(h.props.plan.saved, true); assert.equal(h.api.isDirty(), false); assert.equal(h.api.isBusy(), false);
});

test('false and rejected ACK roll back only the submitted fields, retain draft, and never show saved', async () => {
  for (const persist of [async () => false, async () => { throw Error('disk full'); }]) {
    const h = harness({ persist }); h.props.onPlanChange('A draft');
    assert.equal(await h.props.onPlanSave(), false); assert.equal(h.state.projects[0].plan, 'A saved'); assert.equal(h.state.projects[0].updatedAt, 10);
    assert.equal(h.props.plan.value, 'A draft'); assert.equal(h.props.plan.saved, false); assert.ok(h.props.plan.error); assert.equal(h.api.isDirty(), true); assert.equal(h.api.isBusy(), false);
  }
});

test('missing durable hook cannot acknowledge a save through the legacy save callback', async () => {
  let saves = 0; const h = harness({ persist: null, save: () => saves++ }); h.props.onPlanChange('A draft');
  assert.equal(await h.props.onPlanSave(), false); assert.equal(h.state.projects[0].plan, 'A saved'); assert.equal(saves, 0); assert.match(h.props.plan.error, /草稿/);
});

test('a live saved-plan conflict requires explicit comparison choice before further save', async () => {
  let saves = 0; const h = harness({ persist: async () => { saves++; return true; } }); h.props.onPlanChange('local draft');
  h.state.projects[0].plan = 'new remote plan'; h.sync(); const oldConflict = h.props;
  assert.equal(h.props.plan.conflict, true); assert.equal(h.props.plan.savedVersion, 'new remote plan');
  assert.equal(await h.props.onPlanSave(), false); assert.equal(saves, 0);
  h.state.projects[0].plan = 'even newer'; assert.equal(oldConflict.onPlanResolve('draft'), false, 'stale conflict review must not acknowledge newer content');
  h.sync(); assert.equal(h.props.onPlanResolve('draft'), true); assert.equal(h.props.plan.value, 'local draft'); assert.equal(h.props.plan.conflict, false);
  assert.equal(saves, 0, 'choosing the local draft does not auto-save'); assert.equal(await h.props.onPlanSave(), true); assert.equal(saves, 1);
});

test('choosing the saved conflict version explicitly clears only that project draft', () => {
  const h = harness(); h.props.onPlanChange('A draft'); h.state.projects[0].plan = 'A external'; h.sync();
  assert.equal(h.props.onPlanResolve('saved'), true); assert.equal(h.props.plan.value, 'A external'); assert.equal(h.api.isDirty(), false); assert.equal(h.props.plan.saved, false);
});

test('a save crossing project navigation only acknowledges its original project', async () => {
  const gate = deferred(); const h = harness({ persist: () => gate.promise }); h.props.onPlanChange('A committed');
  const operation = h.props.onPlanSave(); h.switch('b'); h.props.onPlanChange('B draft'); gate.resolve(true);
  assert.equal(await operation, true); assert.equal(h.props.plan.value, 'B draft'); assert.equal(h.props.plan.saved, false);
  assert.equal(h.state.projects[1].plan, 'B saved'); h.switch('a'); assert.equal(h.props.plan.value, 'A committed'); assert.equal(h.props.plan.saved, true);
});

test('owner replacement or a concurrent plan edit is never overwritten by a late ACK or rollback', async () => {
  for (const action of ['replace', 'edit']) {
    const gate = deferred(), h = harness({ persist: () => gate.promise }); h.props.onPlanChange('submitted'); const operation = h.props.onPlanSave();
    if (action === 'replace') { const replacement = fixture(); replacement.projects[0].plan = 'replacement owner'; h.replace(replacement); }
    else { h.state.projects[0].plan = 'concurrent plan'; h.state.projects[0].updatedAt = 999; h.sync(); }
    gate.resolve(false); assert.equal(await operation, false);
    assert.equal(h.state.projects[0].plan, action === 'replace' ? 'replacement owner' : 'concurrent plan'); assert.equal(h.api.isDirty(), true); assert.equal(h.api.isBusy(), false);
  }
});

test('fresh privacy and duplicate ancestry filters hide project and tasks without exposing plan content', () => {
  const h = harness(); const baseline = h.api._pure.inspect(h.state, 'a'); assert.equal(baseline.tasks.length, 1);
  h.state.conversations.push({ id: 'private-chat', private: true }); h.state.trash.push({ data: { runs: [{ id: 'retired-run', private: true }] } });
  const extras = [{ private: true }, { ephemeral: true }, { conversationId: 'private-chat' }, { provenance: { origin: { runId: 'retired-run' } } }, { deletedAt: 1 }, { archivedAt: 1 }, { hidden: true }];
  extras.forEach((fields, index) => h.state.tasks.push({ id: 'bad-' + index, projectId: 'a', title: 'SECRET', ...fields }));
  h.state.tasks.push({ id: 'duplicate', projectId: 'a', title: 'SECRET' }, { id: 'duplicate', projectId: 'a', title: 'SECRET' });
  assert.deepEqual(h.api._pure.inspect(h.state, 'a').tasks.map(task => task.id), ['task-a']);
  h.props.onPlanChange('SECRET draft'); const stale = h.props; h.state.projects[0].private = true; h.sync();
  assert.deepEqual(h.props, { available: false }); stale.onPlanChange('write after private'); assert.equal(h.state.projects[0].plan, 'A saved');
  h.state.projects[0].private = false; h.state.projects.push({ ...h.state.projects[0] }); h.sync(); assert.deepEqual(h.props, { available: false });
});

test('task opening forwards exact anchor and a live guard across async privacy or owner changes', () => {
  const h = harness(), anchor = {}; h.props.onTask('task-a', anchor);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'task-a'); assert.equal(h.calls[0][1].anchor, anchor); assert.equal(h.calls[0][1].canOpen(), true);
  h.state.tasks[0].private = true; assert.equal(h.calls[0][1].canOpen(), false); assert.equal(h.props.onTask('task-a', anchor), false);
  h.state.tasks[0].private = false; h.switch('b'); assert.equal(h.calls[0][1].canOpen(), false);
});

test('model counts only actual scheduled tasks and keeps invalid date rows visible separately', () => {
  const h = harness(); h.props.onWeek(0);
  h.state.tasks = [{ id: 'dated', projectId: 'a', dueAt: Date.now(), title: 'Today' }, { id: 'none', projectId: 'a', title: 'No date' }, { id: 'invalid', projectId: 'a', title: 'Bad date', dueAt: '2026-02-31' }]; h.sync();
  assert.equal(h.props.weekCount, 1); assert.equal(h.props.openCount, 1); assert.deepEqual(h.props.unscheduled.map(task => task.id), ['none']); assert.deepEqual(h.props.invalid.map(task => task.id), ['invalid']);
});

test('preview ignores arbitrary HTML hooks and falls back to escaped text without a safe renderer', () => {
  const previous = global.DocumentMarkdown; delete global.DocumentMarkdown;
  try { const h = harness({ markdown: () => '<img src=x onerror=alert(1)>' }); h.props.onPlanChange('<script>alert(1)</script>'); h.props.onPlanPreview();
    assert.equal(h.props.plan.previewHTML, '<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>');
    let options; global.DocumentMarkdown = { render: (value, passed) => { options = passed; return '<p>trusted escaped document rendering</p>'; } }; h.sync();
    assert.equal(h.props.plan.previewHTML, '<p>trusted escaped document rendering</p>'); assert.equal(options.idPrefix, 'schedule-a'); assert.equal(Object.keys(options).length, 1);
  } finally { global.DocumentMarkdown = previous; }
});

test('ordinary unsaved changes can be explicitly discarded without saving, while stale discard is refused', () => {
  let saves = 0; const h = harness({ persist: () => { saves++; return true; } }); h.props.onPlanChange('A unsaved');
  assert.equal(h.props.onPlanResolve('saved'), true); assert.equal(h.props.plan.value, 'A saved'); assert.equal(h.api.isDirty(), false); assert.equal(saves, 0);
  h.props.onPlanChange('A new draft'); const old = h.props; h.state.projects[0].plan = 'new saved owner content';
  assert.equal(old.onPlanResolve('saved'), false); assert.equal(h.api.isDirty(), true);
});

test('snapshot adoption restores the same available project draft with its original conflict base and invalidates old callbacks', async () => {
  const h = harness(); h.props.onPlanChange('Local unsaved'); const old = h.props;
  const replacement = fixture(); replacement.projects[0].plan = 'Cloud version'; h.replace(replacement);
  assert.equal(h.props.plan.value, 'Local unsaved'); assert.equal(h.props.plan.conflict, true); assert.equal(h.props.plan.savedVersion, 'Cloud version');
  old.onPlanChange('stale write'); assert.equal(await old.onPlanSave(), false); assert.equal(h.props.plan.value, 'Local unsaved');
  assert.equal(h.props.onPlanResolve('saved'), true); assert.equal(h.api.isDirty(), false); assert.equal(h.props.plan.value, 'Cloud version');
});

test('private, deleted and ambiguous snapshot owners cannot reveal recovery text or leave a ghost quit blocker', () => {
  for (const change of [state => { state.projects[0].private = true; }, state => { state.projects = state.projects.slice(1); }, state => { state.projects.push({ ...state.projects[0] }); }]) {
    const h = harness(); h.props.onPlanChange('SECRET recovery draft'); const replacement = fixture(); change(replacement); h.replace(replacement);
    assert.deepEqual(h.props, { available: false }); assert.equal(h.api.isDirty(), false); assert.equal(h.api.getDraftSummary().count, 0);
  }
});

test('owner adoption during an in-flight save preserves the draft without pretending its old ACK saved the replacement', async () => {
  const gate = deferred(), h = harness({ persist: () => gate.promise }); h.props.onPlanChange('Local pending'); const operation = h.props.onPlanSave();
  const replacement = fixture(); replacement.projects[0].plan = 'Cloud owner'; h.replace(replacement); gate.resolve(true);
  assert.equal(await operation, false); assert.equal(h.props.plan.value, 'Local pending'); assert.equal(h.props.plan.saved, false); assert.equal(h.props.plan.conflict, true);
  assert.equal(h.props.onPlanResolve('saved'), true); assert.equal(h.api.isDirty(), false); assert.equal(h.api.isBusy(), false);
});
