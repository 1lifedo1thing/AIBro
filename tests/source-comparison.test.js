const test = require('node:test'), assert = require('node:assert/strict');
const Compare = require('../app/source-comparison.js');
const state = () => ({ projects: [{ id: 'p', name: 'Project', workspace: '科研' }], notes: [{ id: 'a', title: 'Source A', content: 'A source provides direct evidence.\nIts limits are explicit.', projectId: 'p', workspace: '科研', updatedAt: 100 }, { id: 'b', title: 'Source B', content: 'B source covers different conditions.', projectId: 'p', workspace: '科研', updatedAt: 100 }], imports: [], papers: [], conversations: [], agentRuns: [] });
const refs = [{ kind: 'note', id: 'a' }, { kind: 'note', id: 'b' }];
const session = s => ({ data: Compare.begin(s, refs, { now: 12345 }), noteId: null, base: null });
const host = (s, save = async () => true) => ({ getState: () => s, save, uid: () => 'comparison-result' });

test('begins with two actual source snapshots and empty user judgments', () => {
  const s = state(), data = session(s).data; assert.equal(data.sources.length, 2); assert.equal(data.sources[0].excerpt, s.notes[0].content); assert.equal(data.projectId, 'p'); assert.equal(data.criteria[0].cells['note:a'].judgment, ''); assert.equal(data.selectedKey, '');
});
test('requires 2–4 distinct supported sources', () => {
  const s = state(); for (const chosen of [[refs[0]], [refs[0], refs[0]], [...refs, ...refs, refs[0]], [{ kind: 'task', id: 'a' }, refs[1]]]) assert.throws(() => Compare.begin(s, chosen));
});
test('rejects duplicate source or owner identity instead of picking the first record', () => {
  const s = state(); s.notes.push({ ...s.notes[0] }); assert.throws(() => Compare.begin(s, refs), /重复/); s.notes.pop(); s.projects.push({ ...s.projects[0] }); assert.throws(() => Compare.begin(s, refs), /重复/);
});
test('private source, source conversation, run and owner project never enter comparison', () => {
  for (const setup of [s => { s.notes[0].ephemeral = true; }, s => { s.notes[0].sourceConversationId = 'c'; s.conversations.push({ id: 'c', private: true }); }, s => { s.notes[0].agentRunId = 'r'; s.agentRuns.push({ id: 'r', incognito: true }); }, s => { s.projects[0].private = true; }]) { const s = state(); setup(s); assert.throws(() => Compare.begin(s, refs), /私密|无痕/); assert.ok(!Compare.candidates(s).some(item => item.id === 'a')); }
});
test('archived, deleted and orphan-project sources are unavailable', () => {
  for (const setup of [s => { s.notes[0].archived = true; }, s => { s.notes[0].deletedAt = 1; }, s => { s.projects = []; }]) { const s = state(); setup(s); assert.throws(() => Compare.begin(s, refs), /不可用/); }
});
test('bounded snapshots expose truncation, and binary-only sources stay honestly empty', () => {
  const s = state(); s.notes[0].content = 'x'.repeat(10000); s.imports.push({ id: 'img', name: 'Image', mimeType: 'image/png', dataUrl: 'NEVER_COPY_THIS', content: '' });
  const long = Compare.snapshot(s, refs[0]); assert.equal(long.excerpt.length, 6000); assert.equal(long.totalCharacters, 10000); assert.equal(long.truncated, true);
  const image = Compare.snapshot(s, { kind: 'import', id: 'img' }); assert.equal(image.excerpt, ''); assert.doesNotMatch(JSON.stringify(image), /NEVER_COPY_THIS|dataUrl/);
});
test('paper excerpts are explicitly saved record content and filter unsafe URLs and unknown raw fields', () => {
  const s = state(); s.papers.push({ id: 'paper', title: 'Paper', structured: { methods: { content: 'Recorded method.' } }, userEdits: { methods: 'Human revised method.' }, url: 'javascript:alert(1)', localPath: '/private/file', authors: ['A'] });
  const source = Compare.snapshot(s, { kind: 'paper', id: 'paper' }); assert.equal(source.excerptLabel, 'paper-record'); assert.match(source.excerpt, /Human revised/); assert.doesNotMatch(source.excerpt, /Recorded method/); assert.equal(source.metadata.url, ''); assert.doesNotMatch(JSON.stringify(source), /private\/file|localPath/);
});
test('later source passages can be selected exactly with a genuine offset and no copied entire body', () => {
  const s = state(); s.notes[0].content = 'Preface '.repeat(1000) + 'The later conclusion is important.'; const initial = session(s).data;
  const selected = Compare.selectExcerpt(s, initial, 'note:a', 'The later conclusion is important.');
  assert.equal(selected.sources[0].excerptOffset, 8000); assert.equal(selected.sources[0].excerpt, 'The later conclusion is important.'); assert.equal(selected.sources[0].totalCharacters, s.notes[0].content.length); assert.equal(Compare.sourceStatus(s, selected.sources[0]).stale, false);
  assert.equal(initial.sources[0].excerptOffset, 0);
});
test('rewritten, repeated, oversized and stale excerpt selections are rejected', () => {
  const s = state(); s.notes[0].content = 'repeated and repeated'; const data = session(s).data;
  assert.throws(() => Compare.selectExcerpt(s, data, 'note:a', 'new imaginary text'), /原文/); assert.throws(() => Compare.selectExcerpt(s, data, 'note:a', 'repeated'), /多次/); assert.throws(() => Compare.selectExcerpt(s, data, 'note:a', 'x'.repeat(6001)), /6000/); s.notes[0].content += ' changed'; assert.throws(() => Compare.selectExcerpt(s, data, 'note:a', 'and'), /先刷新/);
});
test('every evidence quote must be an exact continuous fragment; judgment may be a personal inference', () => {
  const s = state(), data = session(s).data, cell = data.criteria[0].cells['note:a']; cell.quote = 'direct evidence'; cell.judgment = 'My inference may go beyond the source.'; assert.equal(Compare.validate(data), true); cell.quote = 'fabricated direct evidence'; assert.throws(() => Compare.validate(data), /不在冻结来源/);
});
test('source refresh preserves criteria, chosen option, judgment and old evidence for review', () => {
  const s = state(), data = session(s).data; data.criteria[0].cells['note:a'] = { quote: 'direct evidence', judgment: 'Retain my judgment' }; data.conclusion = 'Retain conclusion'; data.selectedKey = 'note:a'; s.notes[0].content = 'Entirely changed.';
  assert.equal(Compare.sourceStatus(s, data.sources[0]).stale, true); const next = Compare.refreshSource(s, data, 'note:a'); assert.deepEqual(next.criteria, data.criteria); assert.equal(next.conclusion, data.conclusion); assert.equal(next.selectedKey, data.selectedKey); assert.throws(() => Compare.validate(next), /不在冻结来源/); assert.equal(Compare.sourceStatus(s, next.sources[0]).stale, false);
});
test('refresh follows an unchanged selected passage moved by a new introduction', () => {
  const s = state(), initial = session(s).data; const chosen = Compare.selectExcerpt(s, initial, 'note:a', 'Its limits are explicit.'); s.notes[0].content = 'New introduction.\n' + s.notes[0].content;
  const refreshed = Compare.refreshSource(s, chosen, 'note:a'); assert.equal(refreshed.sources[0].excerpt, 'Its limits are explicit.'); assert.equal(refreshed.sources[0].excerptOffset, s.notes[0].content.indexOf('Its limits')); assert.equal(Compare.sourceStatus(s, refreshed.sources[0]).stale, false);
});
test('staleness detects body edits even without updatedAt changes, moves and tampered facts', () => {
  const s = state(), data = session(s).data; s.notes[0].content += ' changed'; assert.equal(Compare.sourceStatus(s, data.sources[0]).stale, true); const source = Compare.snapshot(s, refs[0]); source.excerpt = 'forged fact'; assert.equal(Compare.sourceStatus(s, source).stale, true); const source2 = Compare.snapshot(s, refs[0]); s.notes[0].projectId = null; assert.equal(Compare.sourceStatus(s, source2).stale, true);
});
test('metadata key ordering from JSON storage does not fabricate staleness', () => {
  const s = state(), source = Compare.snapshot(s, refs[0]); source.metadata = Object.fromEntries(Object.entries(source.metadata).reverse()); assert.equal(Compare.sourceStatus(s, source).stale, false);
});
test('saving creates a normal editable note, source references and meaningful frozen snapshots', async () => {
  const s = state(), edit = session(s); edit.data.criteria[0].cells['note:a'].quote = 'direct evidence'; edit.data.criteria[0].cells['note:a'].judgment = 'Useful but limited.'; edit.data.selectedKey = 'note:a'; edit.data.conclusion = 'Use A after checking limits.'; let durable;
  const saved = await Compare.createController(host(s, async () => { durable = JSON.parse(JSON.stringify(s)); return true; })).save(edit);
  const note = durable.notes.find(n => n.id === saved.noteId); assert.equal(note.kind, '来源比较'); assert.deepEqual(note.sourceNoteIds, ['a', 'b']); assert.match(note.content, /个人判断/); assert.match(note.content, /Useful but limited/); assert.match(note.content, /note:a/); assert.equal(note.sourceComparison.sources[0].excerpt, s.notes[0].content); assert.equal(Compare.reopenSession(durable, saved.noteId).externalChanged, false);
});
test('failed creation removes only the owned new note and preserves concurrent unrelated notes', async () => {
  const s = state(); const controller = Compare.createController(host(s, async () => { s.notes.push({ id: 'concurrent', title: 'Keep' }); throw Error('disk full'); })); await assert.rejects(controller.save(session(s)), /disk full/); assert.deepEqual(s.notes.map(n => n.id), ['a', 'b', 'concurrent']);
});
test('a concurrent user edit on a newly created note is not erased on failure', async () => {
  const s = state(); const controller = Compare.createController(host(s, async () => { s.notes.at(-1).title = 'Concurrent user title'; throw Error('disk full'); })); await assert.rejects(controller.save(session(s))); assert.equal(s.notes.at(-1).title, 'Concurrent user title');
});
test('failed update rolls back only owned matching fields, preserving concurrent unrelated metadata', async () => {
  const s = state(), controller = Compare.createController(host(s)); const saved = await controller.save(session(s)); const edit = Compare.reopenSession(s, saved.noteId); edit.data.conclusion = 'Changed'; const before = s.notes.at(-1).content;
  const failed = Compare.createController(host(s, async () => { s.notes.at(-1).tags = ['user-tag']; throw Error('disk full'); })); await assert.rejects(failed.save(edit)); assert.equal(s.notes.at(-1).content, before); assert.deepEqual(s.notes.at(-1).tags, ['user-tag']);
});
test('regular note edits are never overwritten; another comparison note can be saved explicitly', async () => {
  const s = state(), c = Compare.createController(host(s)); const saved = await c.save(session(s)); s.notes.at(-1).content += '\nUser added a paragraph.'; const reopened = Compare.reopenSession(s, saved.noteId); assert.equal(reopened.externalChanged, true); await assert.rejects(c.save(reopened), /别处编辑/);
  const copyController = Compare.createController({ ...host(s), uid: () => 'comparison-copy' }); const copied = await copyController.save(reopened, { asNew: true }); assert.equal(copied.noteId, 'comparison-copy'); assert.match(s.notes.find(n => n.id === saved.noteId).content, /User added/);
});
test('stale, deleted and private sources prevent all new saved claims', async () => {
  for (const mutate of [s => { s.notes[0].content += ' changed'; }, s => { s.notes.splice(0, 1); }, s => { s.notes[0].private = true; }]) { const s = state(), edit = session(s); mutate(s); await assert.rejects(Compare.createController(host(s)).save(edit), /来源|Source A/); assert.equal(s.notes.some(n => n.id === 'comparison-result'), false); }
});
test('concurrent edits during a successful save are not accepted as the next overwrite baseline', async () => {
  const s = state(), c = Compare.createController(host(s, async () => { s.notes.at(-1).content += '\nConcurrent edit'; return true; })); const saved = await c.save(session(s)); assert.equal(saved.externalChanged, true); await assert.rejects(c.save(saved), /别处编辑/);
});
test('comparison note text escapes source and judgment markup; payload drops unknown fields', async () => {
  const s = state(); s.notes[0].content = '<script>bad</script> ![image](https://example.com/x)'; const edit = session(s); edit.data.conclusion = '<img src=x> [click](javascript:bad)'; edit.data.rawToken = 'never-persist'; edit.data.sources[0].localPath = '/never/persist';
  const saved = await Compare.createController(host(s)).save(edit), note = s.notes.find(n => n.id === saved.noteId); assert.doesNotMatch(JSON.stringify(note.sourceComparison), /never-persist|\/never\/persist/); assert.ok(note.content.includes('\\<script\\>')); assert.ok(note.content.includes('\\!\\[image\\]\\(')); assert.ok(note.content.includes('\\[click\\]\\('));
});
