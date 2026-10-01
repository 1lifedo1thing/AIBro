const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Compare = require('../app/source-comparison');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return {projects: [{id: 'p', name: 'Research', workspace: '科研'}, {id: 'daily', name: 'Daily', workspace: '日常'}],
    notes: [{id: 'a', title: 'Source A', content: '😀 Introduction. Evidence A is bounded. Remaining caveat.', projectId: 'p', workspace: '科研', createdAt: 1, updatedAt: 1},
      {id: 'b', title: 'Source B', content: 'Evidence B has another condition.', projectId: 'p', workspace: '科研', createdAt: 1, updatedAt: 1}], papers: [], imports: [], conversations: [], agentRuns: []};
}
const refs = [{kind: 'note', id: 'a'}, {kind: 'note', id: 'b'}];
const begin = state => Compare.begin(state, refs, {mode: 'research', now: 10});
function reviewed(state, base = begin(state)) {
  const data = clone(base); data.question = 'When is A applicable?'; data.scope = 'These two saved materials only.';
  const row = data.criteria[0]; row.cells['note:a'] = {quote: 'Evidence A is bounded.', judgment: 'The scope is limited.', relation: 'supports', reviewedStamp: ''};
  return Compare.reviewEvidence(state, data, row.id, 'note:a');
}
function ready(state) {
  const data = reviewed(state); data.claims = [{id: 'claim:one', text: 'A may apply under the stated condition.', evidenceIds: [Compare.evidenceId(data.criteria[0].id, 'note:a')]}]; data.researchStatus = 'ready'; return data;
}
const edit = data => ({data, noteId: null, base: null});
const controller = (state, save = async () => true, uid = () => 'research-output') => Compare.createController({getState: () => state, save, uid});

test('v2 keeps the source matrix shape, begins with one criterion and declares a bounded user research draft', () => {
  const state = fixture(), data = begin(state); assert.equal(data.version, 2); assert.equal(data.mode, 'research'); assert.equal(data.workspace, '科研'); assert.equal(data.criteria.length, 1);
  assert.deepEqual(data.criteria[0].cells['note:a'], {quote: '', judgment: '', relation: 'unclassified', reviewedStamp: ''});
  assert.deepEqual(data.claims, []); assert.equal(data.researchStatus, 'draft'); assert.equal(Compare.researchView(state, data).ready, false);
  assert.throws(() => Compare.begin(state, [refs[0]], {mode: 'research'}), /2–4/);
  state.notes.forEach(note => { note.projectId = 'daily'; note.workspace = '日常'; });
  assert.equal(begin(state).projectId, null); assert.equal(begin(state).workspace, '科研');
  assert.throws(() => Compare.begin(state, refs, {mode: 'research', projectId: 'daily'}), {code: 'RESEARCH_PROJECT'});
});

test('ready requires actual claims referencing current confirmed evidence; unused empty cells do not block', () => {
  const state = fixture(), data = ready(state), view = Compare.researchView(state, data);
  assert.equal(view.ready, true); assert.equal(view.counts.confirmed, 1); assert.equal(view.evidence[1].status, 'empty');
  for (const change of [d => { d.question = ''; }, d => { d.claims = []; }, d => { d.claims[0].text = ' '; }, d => { d.claims[0].evidenceIds = []; }, d => { d.claims[0].evidenceIds.push('removed-id'); }, d => { d.claims[0].evidenceIds.push(Compare.evidenceId(d.criteria[0].id, 'note:b')); }]) {
    const changed = clone(data); change(changed); const result = Compare.researchView(state, changed);
    assert.equal(result.ready, false); assert.ok(result.readinessReasons.length); assert.equal(result.effectiveStatus, 'draft');
  }
});

test('review binds the question, scope, row, snapshot location, quote, judgment and relation', () => {
  const state = fixture(), data = ready(state);
  for (const change of [d => { d.question += '?'; }, d => { d.scope += ' changed'; }, d => { d.criteria[0].label += ' changed'; }, d => { d.criteria[0].cells['note:a'].quote = 'Evidence A'; }, d => { d.criteria[0].cells['note:a'].judgment += ' changed'; }, d => { d.criteria[0].cells['note:a'].relation = 'contradicts'; }, d => { d.sources[0].sourceVersion += 'x'; }, d => { d.sources[0].excerptOffset++; }, d => { d.sources[0].capturedAt++; }]) {
    const changed = clone(data); change(changed); assert.equal(Compare.researchView(state, changed).evidence[0].confirmed, false);
  }
  const stable = clone(data); stable.title = 'A different title'; stable.claims[0].text += ' Alternative wording.';
  assert.equal(Compare.researchView(state, stable).evidence[0].confirmed, true, 'Editorial output wording does not pretend to re-review evidence');
});

test('only a unique exact quote in a current source with an explicit relationship can be reviewed', () => {
  const state = fixture(), base = reviewed(state);
  for (const change of [d => { d.question = ''; }, d => { d.criteria[0].cells['note:a'].quote = 'invented text'; }, d => { d.criteria[0].cells['note:a'].quote = ''; }, d => { d.criteria[0].cells['note:a'].relation = 'unclassified'; }]) {
    const data = clone(base); change(data); assert.throws(() => Compare.reviewEvidence(state, data, data.criteria[0].id, 'note:a'), {code: 'EVIDENCE_REVIEW'});
  }
  state.notes[0].content = 'repeat and repeat'; const repeated = begin(state); repeated.question = 'Question'; repeated.criteria[0].cells['note:a'] = {quote: 'repeat', judgment: '', relation: 'related', reviewedStamp: ''};
  const item = Compare.researchView(state, repeated).evidence[0]; assert.equal(item.ambiguous, true); assert.equal(item.offset, null); assert.equal(item.canReview, false); assert.equal(item.canOpen, false);
  assert.throws(() => Compare.reviewEvidence(state, repeated, repeated.criteria[0].id, 'note:a'), {code: 'EVIDENCE_REVIEW'});
});

test('explicit source refresh and passage replacement retain judgments but invalidate review and downgrade ready', () => {
  const state = fixture(), data = ready(state), rowId = data.criteria[0].id, original = clone(data);
  for (const changed of [Compare.refreshSource(state, data, 'note:a'), Compare.selectExcerpt(state, data, 'note:a', 'Evidence A is bounded.')]) {
    assert.equal(changed.researchStatus, 'draft'); assert.equal(changed.criteria[0].cells['note:a'].reviewedStamp, ''); assert.equal(changed.criteria[0].cells['note:a'].judgment, original.criteria[0].cells['note:a'].judgment);
    assert.equal(Compare.researchView(state, changed).evidence[0].confirmed, false);
    assert.equal(Compare.researchView(state, Compare.reviewEvidence(state, changed, rowId, 'note:a')).ready, true);
  }
  assert.deepEqual(data, original);
});

test('stable evidence identities are collision-safe and removed rows remain explicit dangling claim references', async () => {
  assert.notEqual(Compare.evidenceId('a--note:b', 'note:c'), Compare.evidenceId('a', 'note:b--note:c'));
  const state = fixture(), data = ready(state), id = data.claims[0].evidenceIds[0]; data.criteria[0].id = 'replacement'; data.researchStatus = 'draft';
  assert.equal(Compare.researchView(state, data).claims[0].valid, false);
  const saved = await controller(state).save(edit(data)), restored = Compare.reopenSession(state, saved.noteId);
  assert.deepEqual(restored.data.claims[0].evidenceIds, [id]); assert.equal(restored.externalChanged, false); assert.match(state.notes.at(-1).content, /已移除的证据（需重新关联）/);
});

test('stale or unmatched evidence may be saved as draft or insufficient, but never as ready', async () => {
  for (const status of ['draft', 'insufficient']) {
    const state = fixture(), data = ready(state); state.notes[0].content += ' Source changed.'; data.researchStatus = status;
    const saved = await controller(state).save(edit(data)); assert.equal(state.notes.at(-1).sourceComparison.researchStatus, status);
    const resumed = Compare.reopenSession(state, saved.noteId); assert.equal(Compare.researchView(state, resumed.data).ready, false); assert.equal(resumed.externalChanged, false);
    resumed.data.researchStatus = 'ready'; await assert.rejects(controller(state).save(resumed), {code: 'RESEARCH_NOT_READY'});
  }
  const state = fixture(), data = ready(state); data.criteria[0].cells['note:a'].quote = 'A paraphrase that was not quoted'; data.researchStatus = 'draft';
  await controller(state).save(edit(data)); assert.equal(Compare.researchView(state, data).evidence[0].status, 'unmatched'); assert.match(state.notes.at(-1).content, /无法唯一定位/);
});

test('source access loss blocks draft persistence and redacts the live evidence projection', async () => {
  for (const mutate of [s => { s.notes[0].private = true; }, s => { s.notes[0].hidden = true; }, s => { s.notes[0].archived = true; }, s => { s.notes[0].deletedAt = 2; }, s => { s.notes.splice(0, 1); }, s => { s.notes.push(clone(s.notes[0])); }, s => { s.projects[0].hidden = true; }]) {
    const state = fixture(), data = ready(state); data.researchStatus = 'draft'; mutate(state);
    const view = Compare.researchView(state, data), item = view.evidence[0]; assert.equal(view.blocked, true); assert.equal(item.available, false); assert.equal(item.sourceTitle, '来源不可用'); assert.equal(item.quote, ''); assert.equal(item.judgment, ''); assert.equal(item.offset, null);
    assert.equal(Compare.evidenceTarget(state, data, 'note:a', item.id), null);
    await assert.rejects(controller(state).save(edit(data)), {code: 'SOURCE_CHANGED'}); assert.ok(!state.notes.some(note => note.id === 'research-output'));
  }
});

test('research saves as a user-edited Wiki output with exact quotes and explicit claim refs, without invented AI origin', async () => {
  const state = fixture(), data = ready(state); data.openQuestions = 'Independent replication remains open.';
  const saved = await controller(state).save(edit(data)), note = state.notes.at(-1), restored = Compare.reopenSession(clone(state), saved.noteId);
  assert.equal(note.kind, '科研 Wiki/output'); assert.equal(note.workspace, '科研'); assert.equal(note.userEdited, true); assert.equal(note.provenance, undefined); assert.equal(note.agentRunId, undefined);
  assert.equal(restored.externalChanged, false); assert.deepEqual(restored.data, data); assert.equal(Compare.researchView(state, restored.data).ready, true);
  assert.ok(!note.content.includes(data.claims[0].evidenceIds[0]), 'internal reference identity stays in structured data');
  for (const value of ['研究问题与范围', '### E1 ·', '### 结论 1', '关联依据: E1 ·', 'Evidence A is bounded.', '用户曾核对该冻结版本', '不代表 AI 验证', data.openQuestions]) assert.ok(note.content.includes(value), value);
});

test('nonresearch destination is rejected even if changed after begin', async () => {
  const state = fixture(), data = ready(state); data.projectId = 'daily'; await assert.rejects(controller(state).save(edit(data)), {code: 'RESEARCH_PROJECT'});
  data.projectId = null; data.workspace = '日常'; await controller(state).save(edit(data)); assert.equal(state.notes.at(-1).workspace, '科研');
});

test('paper fingerprints and note baselines survive recursively sorted storage JSON', async () => {
  const state = fixture(); state.papers.push({id: 'paper', title: 'Paper', projectId: 'p', workspace: '科研', structured: {methods: 'Recorded method.', abstract: 'Recorded abstract.'}});
  let data = Compare.begin(state, [refs[0], {kind: 'paper', id: 'paper'}], {mode: 'research', now: 10}); data.question = 'Question'; const row = data.criteria[0]; row.cells['paper:paper'] = {quote: 'Recorded method.', judgment: '', relation: 'related', reviewedStamp: ''};
  data = Compare.reviewEvidence(state, data, row.id, 'paper:paper'); data.claims = [{id: 'claim', text: 'A bounded observation.', evidenceIds: [Compare.evidenceId(row.id, 'paper:paper')]}]; data.researchStatus = 'ready';
  const saved = await controller(state).save(edit(data)), restored = JSON.parse(JSON.stringify(state, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
  const resumed = Compare.reopenSession(restored, saved.noteId); assert.equal(resumed.base, saved.base); assert.equal(resumed.externalChanged, false); assert.equal(Compare.researchView(restored, resumed.data).ready, true);
});

test('update history retains previous research structure and source metadata, while external text remains protected', async () => {
  const state = fixture(), c = controller(state), saved = await c.save(edit(ready(state))), previous = clone(state.notes.at(-1));
  const resumed = Compare.reopenSession(state, saved.noteId); resumed.data.openQuestions = 'Another open question'; await c.save(resumed);
  const revision = state.notes.at(-1).revisionHistory.at(-1); assert.deepEqual(revision.sourceComparison, previous.sourceComparison); assert.deepEqual(revision.sourceNoteIds, previous.sourceNoteIds);
  state.notes.at(-1).content += '\nExternal edit'; const changed = Compare.reopenSession(state, saved.noteId); assert.equal(changed.externalChanged, true); await assert.rejects(c.save(changed), {code: 'COMPARISON_CONFLICT'});
  await controller(state, async () => true, () => 'research-copy').save(changed, {asNew: true}); assert.match(state.notes.find(note => note.id === saved.noteId).content, /External edit/);
});

test('failed save rolls back only owned research fields and leaves the editable session intact', async () => {
  const state = fixture(), saved = await controller(state).save(edit(ready(state))), resumed = Compare.reopenSession(state, saved.noteId), before = clone(state.notes.at(-1)); resumed.data.openQuestions = 'Retry this unsaved change';
  await assert.rejects(controller(state, async () => { state.notes.at(-1).tags = ['concurrent']; throw Error('disk full'); }).save(resumed), /disk full/);
  assert.equal(state.notes.at(-1).content, before.content); assert.deepEqual(state.notes.at(-1).sourceComparison, before.sourceComparison); assert.deepEqual(state.notes.at(-1).tags, ['concurrent']); assert.equal(resumed.data.openQuestions, 'Retry this unsaved change');
  await controller(state).save(resumed); assert.match(state.notes.at(-1).content, /Retry this unsaved change/);
});

test('a state replacement during save cannot become an overwrite baseline or receive rollback mutations', async () => {
  let state = fixture(); const saved = await controller(state).save(edit(ready(state))), resumed = Compare.reopenSession(state, saved.noteId); resumed.data.openQuestions = 'Pending';
  const host = Compare.createController({getState: () => state, save: async () => { state = clone(state); return true; }}); const result = await host.save(resumed); assert.equal(result.externalChanged, true);
  const another = Compare.reopenSession(state, saved.noteId); another.data.openQuestions = 'Other pending'; let replacement;
  const failed = Compare.createController({getState: () => state, save: async () => { state = clone(state); replacement = clone(state); throw Error('merge while saving'); }});
  await assert.rejects(failed.save(another), /merge while saving/); assert.deepEqual(state, replacement);
});

test('evidence navigation uses UTF-16 offsets and only maps pages from actual extracted-page layout', () => {
  const state = fixture(), data = ready(state), id = data.claims[0].evidenceIds[0], target = Compare.evidenceTarget(state, data, 'note:a', id);
  assert.deepEqual(target, {kind: 'note', id: 'a', comparisonEvidence: {quote: 'Evidence A is bounded.', offset: state.notes[0].content.indexOf('Evidence A'), sourceVersion: data.sources[0].sourceVersion}});
  state.imports.push({id: 'pdf', name: 'PDF', pages: [{page: 2, text: 'First extracted page.'}, {page: 7, text: 'Actual page seven evidence.'}], projectId: 'p', workspace: '科研'});
  const pageData = Compare.begin(state, [refs[0], {kind: 'import', id: 'pdf'}], {mode: 'research', now: 10}); pageData.question = 'Question'; pageData.criteria[0].cells['import:pdf'].quote = 'Actual page seven evidence.';
  const pageTarget = Compare.evidenceTarget(state, pageData, 'import:pdf', Compare.evidenceId(pageData.criteria[0].id, 'import:pdf'));
  assert.equal(pageTarget.comparisonEvidence.page, 7); assert.equal(pageTarget.comparisonEvidence.offset, pageData.sources[1].excerpt.indexOf('Actual page'));
  state.imports[0].content = 'Actual page seven evidence.'; const plain = Compare.begin(state, [refs[0], {kind: 'import', id: 'pdf'}], {mode: 'research'}); plain.criteria[0].cells['import:pdf'].quote = 'Actual page seven evidence.';
  assert.equal(Compare.evidenceTarget(state, plain, 'import:pdf', Compare.evidenceId(plain.criteria[0].id, 'import:pdf')).comparisonEvidence.page, undefined);
  state.notes[0].content += ' revised'; assert.equal(Compare.evidenceTarget(state, data, 'note:a', id), null);
});

test('canonical research persistence strips arbitrary nested fields and escapes user markup', async () => {
  const state = fixture(), data = ready(state); data.apiKey = 'SECRET_ROOT'; data.claims[0].secret = 'SECRET_CLAIM'; data.criteria[0].cells['note:a'].token = 'SECRET_CELL'; data.sources[0].path = 'SECRET_PATH'; data.openQuestions = '<img src=x> [link](javascript:bad)';
  await controller(state).save(edit(data)); const note = state.notes.at(-1); assert.doesNotMatch(JSON.stringify(note.sourceComparison), /SECRET_/); assert.ok(note.content.includes('\\<img src=x\\>')); assert.ok(note.content.includes('\\[link\\]\\('));
  const invalid = clone(data); invalid.claims[0].evidenceIds = ['`\n# forged']; assert.throws(() => Compare.validate(invalid), {code: 'CLAIM_FORMAT'});
});

function uiFixture(state = fixture(), options = {}) {
  let latest, dialog, privateMode = false;
  const listeners = new Map(), node = () => ({open: false, append() {}, setAttribute() {}, querySelector: () => ({focus() {}}), addEventListener(name, handler) { listeners.set(name, handler); }, showModal() { this.open = true; }, close() { this.open = false; listeners.get('close')?.(); }});
  const document = {documentElement: {lang: 'zh'}, activeElement: null, addEventListener() {}, body: {append() {}}, createElement: type => { const item = node(); if (type === 'dialog') dialog = item; return item; }};
  const context = vm.createContext({document, HalaskaUI: {mount: (_host, name, props) => { latest = {name, props}; }, unmount() {}}, URL, console});
  vm.runInContext(fs.readFileSync(require.resolve('../app/source-comparison'), 'utf8'), context);
  context.SourceComparison.init({getState: () => state, save: async () => true, uid: () => 'ui-output', isPrivate: () => privateMode, ...options});
  return {api: context.SourceComparison, state, get latest() { return latest; }, get dialog() { return dialog; }, setPrivate: value => { privateMode = value; }};
}

test('picker preserves requested research mode and project without silently converting a retained v1 draft', () => {
  const f = uiFixture(); assert.equal(f.api.open(undefined, {mode: 'research', projectId: 'p'}), true); assert.equal(f.latest.props.mode, 'research');
  f.latest.props.onSelect({kind: 'note', id: 'a', key: 'note:a'}); f.latest.props.onSelect({kind: 'note', id: 'b', key: 'note:b'}); f.latest.props.onStart();
  assert.equal(f.latest.props.data.version, 2); assert.equal(f.latest.props.data.projectId, 'p'); f.api.close(); assert.equal(f.api.open(undefined, {mode: 'comparison'}), false);
  const old = uiFixture(); old.api.open(refs); old.api.close(); assert.equal(old.api.open(undefined, {mode: 'research'}), false); old.api.open(); assert.equal(old.latest.props.data.version, 1);
});

test('research entry starts its requested mode after a saved ordinary comparison without changing the saved note', async () => {
  const f = uiFixture(); f.api.open(refs); await f.latest.props.onSave();
  assert.equal(f.state.notes.at(-1).sourceComparison.version, 1);
  const stored = JSON.stringify(f.state.notes.at(-1)); f.api.close();
  assert.equal(f.api.open(undefined, {mode: 'research', projectId: 'p'}), true);
  assert.equal(f.latest.name, 'ComparisonPicker'); assert.equal(f.latest.props.mode, 'research');
  assert.equal(JSON.stringify(f.state.notes.at(-1)), stored);
});

test('controller edits downgrade ready and obsolete render callbacks cannot mutate a replaced data draft', () => {
  const f = uiFixture(); f.api.open(refs, {mode: 'research'}); f.latest.props.onChange('question', 'Question'); f.latest.props.onCell('criterion-1', 'note:a', 'quote', 'Evidence A is bounded.'); f.latest.props.onCell('criterion-1', 'note:a', 'relation', 'supports');
  const prior = f.latest.props; assert.equal(prior.onReview('criterion-1', 'note:a'), true); prior.onChange('question', 'OLD CALLBACK'); assert.equal(f.latest.props.data.question, 'Question');
  f.latest.props.onChange('researchStatus', 'ready'); f.latest.props.onCell('criterion-1', 'note:a', 'judgment', 'Edited judgment'); assert.equal(f.latest.props.data.researchStatus, 'draft'); assert.match(f.latest.props.notice, /回到草稿/);
});

test('cancelled asynchronous source navigation preserves the draft and validates access at the last await', async () => {
  let release, guard, target;
  const f = uiFixture(fixture(), {openTarget: (value, canOpen) => { target = value; guard = canOpen; return new Promise(resolve => { release = resolve; }); }});
  f.api.open(refs, {mode: 'research'}); f.latest.props.onChange('question', 'Keep this draft'); f.latest.props.onCell('criterion-1', 'note:a', 'quote', 'Evidence A is bounded.');
  const pending = f.latest.props.onSource('note:a', Compare.evidenceId('criterion-1', 'note:a'));
  assert.equal(f.api.isBusy(), true); assert.equal(guard(), true); assert.equal(target.comparisonEvidence.offset, f.state.notes[0].content.indexOf('Evidence A'));
  assert.equal(f.api.reopen('some-other-note'), false); f.state.notes[0].private = true; assert.equal(guard(), false); release(true);
  assert.equal(await pending, false); assert.equal(f.dialog.open, true); assert.equal(f.latest.props.data.question, 'Keep this draft'); assert.equal(f.api.hasDraft(), true); assert.equal(f.api.isBusy(), false);
});

test('saving blocks callback edits until acknowledgement so a new draft cannot be overwritten', async () => {
  let release; const f = uiFixture(fixture(), {save: () => new Promise(resolve => { release = resolve; })}); f.api.open(refs, {mode: 'research'}); f.latest.props.onChange('question', 'Persist me');
  const prior = f.latest.props, pending = prior.onSave(); assert.equal(f.api.isBusy(), true); prior.onChange('question', 'Overwrite while saving'); prior.onDiscard();
  release(true); assert.equal(await pending, true); assert.equal(f.latest.props.data.question, 'Persist me'); assert.equal(f.api.hasDraft(), false); assert.equal(f.latest.props.noteId, 'ui-output');
});
