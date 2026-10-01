const test = require('node:test');
const assert = require('node:assert/strict');
const Catalog = require('../app/document-files.js');
const ProjectFiles = require('../app/project-files.js');
const fixture = () => ({
  projects: [{ id: 'p', name: 'Project', localFolder: { id: 'root', name: 'Local' } }, { id: 'q', name: 'Other', localFolder: { id: 'other-root' } }],
  notes: [{ id: 'n', title: 'Working note.md', folderPath: 'notes', projectId: 'p', updatedAt: 10, content: 'BODY NEVER COPIED' }],
  imports: [{ id: 'a', name: 'Lecture.pdf', projectId: 'p', content: 'PDF BODY NEVER COPIED' }],
  conversations: [{ id: 'c', projectId: 'p', messages: [{ id: 'u', role: 'user', attachmentIds: ['a'], fileReferences: [{ type: 'note', id: 'n', title: 'Old name', version: 'note-v1' }] }] }],
  agentRuns: [], trash: []
});
const build = (state, options = {}) => Catalog.build({ state, conversationId: 'c', ...options });
const row = (state, id, options) => build(state, options).items.find(item => item.id === id);
const local = (overrides = {}) => ({ id: 'edit', candidateId: 'root', projectId: 'p', path: 'docs/result.md', status: 'pending', beforeVersion: null, afterVersion: 'after-sha', ...overrides });
const run = (edit, overrides = {}) => ({ id: 'r', projectId: 'p', conversationId: 'c', status: 'completed', startedAt: 20, localFileEdits: [edit], ...overrides });

test('sent attachments and explicit references work without a project', () => {
  const state = fixture(); state.conversations[0].projectId = null;
  const result = build(state);
  assert.equal(result.projectId, null); assert.equal(result.available, true);
  assert.deepEqual(result.items.map(item => item.id), ['a', 'n']);
  assert.deepEqual(row(state, 'n').open, { kind: 'note', id: 'n' });
  assert.equal(row(state, 'n').title, 'Working note.md');
});

test('never treats unsent composer attachments, draft references or plans as conversation files', () => {
  const state = fixture(); state.conversations[0].messages = [];
  Object.assign(state.conversations[0], { attachments: ['a'], draftAttachmentIds: ['a'], draftFileReferences: [{ type: 'note', id: 'n' }], pendingSubmits: [{ attachmentIds: ['a'] }] });
  state.agentRuns.push({ id: 'r', conversationId: 'c', pendingActions: [{ type: 'note', id: 'n' }], status: 'completed' });
  assert.deepEqual(build(state).items, []);
});

test('deduplicates attachment, reference, message result and durable file change by typed identity', () => {
  const state = fixture();
  state.conversations[0].messages.push({ id: 'answer', role: 'agent', runId: 'r', results: [{ type: 'note', id: 'n', operation: 'created' }] });
  state.agentRuns.push({ id: 'r', conversationId: 'c', attachmentIds: ['a'], fileReferences: [{ type: 'import', id: 'a' }], fileChanges: [{ type: 'note', id: 'n' }], results: [{ type: 'note', id: 'n' }] });
  const result = build(state);
  assert.equal(result.items.length, 2); assert.equal(row(state, 'n').group, 'outputs'); assert.equal(row(state, 'n').status, 'saved');
  assert.equal(row(state, 'a').origins.length, 3); assert.equal(row(state, 'n').origins.length, 3);
  assert.equal(row(state, 'n').key, JSON.stringify(['note', 'n']));
});

test('same string id in different collections stays separate', () => {
  const state = fixture(); state.notes[0].id = 'a'; state.conversations[0].messages[0].fileReferences[0].id = 'a';
  assert.equal(build(state).items.length, 2); assert.equal(new Set(build(state).items.map(item => item.key)).size, 2);
});

test('saved result availability is current, not inferred from completed run status', () => {
  const state = fixture(); state.agentRuns.push({ id: 'r', conversationId: 'c', status: 'completed', results: [{ type: 'note', id: 'missing', title: 'No file' }] });
  const missing = row(state, 'missing'); assert.equal(missing.status, 'missing'); assert.equal(missing.open, null); assert.equal(missing.disabled, true);
  state.agentRuns.push({ id: 'nothing', conversationId: 'c', status: 'completed', message: 'Created result.md' });
  assert.equal(build(state).items.length, 3);
});

test('current note draft is review, matched existing file is input, withdrawn change is not saved output', () => {
  const state = fixture(); state.notes[0].aiDraft = { content: 'UNAPPROVED BODY', provenance: { origin: { runId: 'r' } } };
  state.agentRuns.push({ id: 'r', conversationId: 'c', fileChanges: [{ type: 'note', id: 'n', operation: 'drafted' }], results: [{ type: 'import', id: 'a', operation: 'matched' }] });
  assert.equal(row(state, 'n').group, 'review'); assert.equal(row(state, 'n').status, 'draft');
  assert.deepEqual(row(state, 'n').review, { kind: 'review', runId: 'r', editId: 'n' });
  assert.equal(row(state, 'a').group, 'inputs');
  state.agentRuns[0].fileChanges[0].undoneAt = 30;
  assert.equal(row(state, 'n').group, 'inputs');
  delete state.notes[0].aiDraft; delete state.agentRuns[0].fileChanges[0].undoneAt;
  assert.equal(row(state, 'n').group, 'history');
  assert.equal(row(state, 'n').status, 'recorded-proposal');
  assert.equal(row(state, 'n').review.editId, 'n');
  assert.equal(row(state, 'n').open, null);
  assert.deepEqual(row(state, 'n').currentOpen, { kind: 'note', id: 'n' });
});

test('each proposed note carries the exact file identity, not only the shared run', () => {
  const state = fixture(); state.notes.push({ id: 'second', title: 'Second.md', projectId: 'p' });
  for (const note of state.notes) note.aiDraft = { provenance: { origin: { runId: 'r' } } };
  state.agentRuns.push({ id: 'r', conversationId: 'c', fileChanges: state.notes.map(note => ({ type: 'note', id: note.id, operation: 'drafted' })) });
  for (const id of ['n', 'second']) assert.deepEqual(row(state, id).review, { kind: 'review', runId: 'r', editId: id });
});

test('a newer draft never turns an older saved result into that old run review', () => {
  const state = fixture(); state.notes[0].aiDraft = { content: 'NEW DRAFT', provenance: { origin: { runId: 'new-run' } } };
  state.agentRuns.push({ id: 'r', conversationId: 'c', fileChanges: [{ type: 'note', id: 'n', operation: 'updated' }] });
  const item = row(state, 'n');
  assert.equal(item.group, 'outputs'); assert.equal(item.status, 'saved'); assert.equal(item.review, null);
  assert.deepEqual(item.open, { kind: 'note', id: 'n' });
});

test('legacy proposals retain exact historical review without claiming a current draft or saved output', () => {
  for (const draft of [undefined, { content: 'Legacy draft' }, { content: 'New run draft', provenance: { origin: { runId: 'new-run' } } }]) {
    const state = fixture(); state.notes[0].aiDraft = draft;
    state.agentRuns.push({ id: 'r', conversationId: 'c', fileChanges: [{ type: 'note', id: 'n', operation: 'drafted' }] });
    const item = row(state, 'n');
    assert.equal(item.group, 'history'); assert.equal(item.status, 'recorded-proposal');
    assert.equal(item.disabled, false); assert.equal(item.open, null);
    assert.deepEqual(item.review, { kind: 'review', runId: 'r', editId: 'n', label: '查看历史修改' });
    assert.match(item.reason, /尚未确认/); assert.equal(build(state).groups.find(group => group.id === 'history').label, '历史修改');
  }
});

test('the current draft remains the default review even when an earlier message contributed historical changes first', () => {
  const state = fixture(); state.notes[0].aiDraft = { provenance: { origin: { runId: 'new-run' } } };
  state.conversations[0].messages.push({ id: 'old-answer', role: 'agent', runId: 'r', results: [{ type: 'note', id: 'n', operation: 'drafted' }] });
  state.agentRuns.push({ id: 'r', conversationId: 'c', startedAt: 10, fileChanges: [{ type: 'note', id: 'n', operation: 'drafted' }] },
    { id: 'new-run', conversationId: 'c', startedAt: 20, fileChanges: [{ type: 'note', id: 'n', operation: 'drafted' }] });
  const item = row(state, 'n');
  assert.equal(item.group, 'review'); assert.deepEqual(item.review, { kind: 'review', runId: 'new-run', editId: 'n' });
  assert.equal(item.reviews.length, 2); assert.equal(item.reviews.find(review => review.runId === 'r').label, '查看历史修改');
});

test('a proposed result becomes saved only with durable body provenance for that exact note and run', () => {
  for (const change of [() => {}, note => { note.provenance.origin.runId = 'other'; }, note => { note.provenance.output.id = 'other'; }, note => { note.provenance.output.variant = 'draft'; }, note => { note.provenance.origin.recorded = false; }]) {
    const state = fixture(), note = state.notes[0];
    // A later run may have its own draft while this prior adoption remains real.
    note.aiDraft = { provenance: { origin: { runId: 'new-run' } } };
    note.provenance = { origin: { recorded: true, runId: 'r' }, output: { type: 'note', id: 'n', variant: 'body' } }; change(note);
    state.agentRuns.push({ id: 'r', conversationId: 'c', fileChanges: [{ type: 'note', id: 'n', operation: 'drafted' }] });
    const valid = note.provenance.origin.recorded && note.provenance.origin.runId === 'r' && note.provenance.output.id === 'n' && note.provenance.output.variant === 'body';
    assert.equal(row(state, 'n').group, valid ? 'outputs' : 'history');
    if (valid) { assert.equal(row(state, 'n').review, null); assert.deepEqual(row(state, 'n').open, { kind: 'note', id: 'n' }); }
  }
});

test('draft projection reads provenance identities without touching current or historical draft bodies', () => {
  const state = fixture(), draft = { provenance: { origin: { runId: 'r' } } };
  const historical = {};
  for (const value of [state.notes[0], draft, historical]) Object.defineProperty(value, 'content', { get() { throw Error('Body read'); } });
  state.notes[0].aiDraft = draft;
  state.agentRuns.push({ id: 'r', conversationId: 'c', fileChanges: [{ type: 'note', id: 'n', operation: 'drafted', after: { aiDraft: historical } }] });
  assert.equal(row(state, 'n').group, 'review');
  draft.provenance.origin.runId = 'new-run'; assert.equal(row(state, 'n').group, 'history');
});

test('pending local creation opens only its real review, with the existing stable local identity', () => {
  const state = fixture(), edit = local(); state.agentRuns.push(run(edit));
  const id = ProjectFiles.localId(edit), item = row(state, id);
  assert.equal(Catalog.localId(edit), id); assert.equal(item.kind, 'local-file'); assert.equal(item.group, 'review');
  assert.equal(item.open, null); assert.equal(item.currentOpen, null); assert.equal(item.disabled, false);
  assert.deepEqual(item.review, { kind: 'local-review', runId: 'r', editId: 'edit', status: 'pending' });
  assert.equal(item.versionStatus, 'not-checked'); assert.equal(item.version, null);
});

test('saved local output is navigable and keeps recorded version without claiming current disk verification', () => {
  const state = fixture(), edit = local({ status: 'applied' }); state.agentRuns.push(run(edit));
  const item = row(state, Catalog.localId(edit));
  assert.equal(item.group, 'outputs'); assert.equal(item.status, 'applied'); assert.equal(item.version, 'after-sha');
  assert.deepEqual(item.open, { kind: 'local-file', id: Catalog.localId(edit) }); assert.equal(item.versionStatus, 'not-checked');
});

test('multiple pending proposals keep all review targets; input versions and open-current target survive dedupe', () => {
  const state = fixture(), edit = local({ beforeVersion: 'before-v2' });
  state.conversations[0].messages[0].fileReferences.push({ type: 'local', ...edit, version: 'sent-v1' });
  state.agentRuns.push(run(edit), run(local({ id: 'new-edit', beforeVersion: 'before-v3', status: 'partial' }), { id: 'new-run', startedAt: 30 }));
  const item = row(state, Catalog.localId(edit));
  assert.equal(item.group, 'review'); assert.equal(item.open, null); assert.deepEqual(item.currentOpen, { kind: 'local-file', id: Catalog.localId(edit) });
  assert.deepEqual(item.reviews.map(value => value.runId), ['new-run', 'r']); assert.deepEqual(new Set(item.recordedVersions), new Set(['sent-v1', 'before-v3', 'before-v2']));
});

test('interrupted transitions need review; dismissed and undone proposals never appear as saved files', () => {
  const state = fixture();
  for (const status of ['interrupted', 'applying', 'undoing', 'partial', 'dismissed', 'undone']) state.agentRuns.push(run(local({ id: status, path: `${status}.md`, status }), { id: status }));
  const edits = build(state).items.filter(item => item.kind === 'local-file');
  assert.equal(edits.length, 4); assert.ok(edits.every(item => item.group === 'review' && !item.open));
});

test('directory proposal is reviewable but is never opened as an editable file', () => {
  const state = fixture(), edit = local({ path: 'results', directory: true, status: 'applied' }); state.agentRuns.push(run(edit));
  const item = row(state, Catalog.localId(edit)); assert.equal(item.open, null); assert.equal(item.directory, true); assert.equal(item.disabled, false);
});

test('disconnected roots and invalid paths are disabled without any local reads', () => {
  const state = fixture(), edit = local(); state.agentRuns.push(run(edit)); state.projects[0].localFolder.id = 'new-root';
  const item = row(state, Catalog.localId(edit)); assert.equal(item.status, 'disconnected'); assert.equal(item.open, null); assert.equal(item.review, null); assert.equal(item.disabled, true);
  state.projects[0].localFolder.id = 'root'; edit.path = '../escape.md';
  assert.equal(row(state, Catalog.localId(edit)).status, 'invalid');
  for (const path of ['/absolute', 'C:/file', 'a//b', 'a/../b', 'a/./b', 'a\\b', 'a\0b']) assert.equal(Catalog.pathValid(path), false);
});

test('mismatched run owner never manufactures local output or consumes another conversation results', () => {
  const state = fixture(); state.agentRuns.push(run(local({ projectId: 'q', candidateId: 'other-root' })));
  state.conversations[0].messages.push({ id: 'bad', role: 'agent', runId: 'foreign', results: [{ type: 'note', id: 'n' }] });
  state.agentRuns.push({ id: 'foreign', conversationId: 'other', results: [{ type: 'note', id: 'n' }] });
  assert.equal(build(state).items.length, 2); assert.equal(row(state, 'n').group, 'inputs');
});

test('explicit cross-project source is retained and moved library record uses its current owner', () => {
  const state = fixture(); state.notes[0].projectId = 'q';
  state.conversations[0].messages[0].fileReferences[0].projectId = 'p';
  const item = row(state, 'n'); assert.equal(item.available, true); assert.equal(item.projectId, 'q'); assert.equal(item.projectName, 'Other');
});

test('deleted, archived and duplicate sources retain disabled metadata rather than opening old snapshots', () => {
  for (const change of [s => { s.notes[0].deletedAt = 42; }, s => { s.projects[0].archived = true; }, s => { s.notes.push({ ...s.notes[0] }); }, s => { s.notes = []; }]) {
    const state = fixture(); change(state); const item = row(state, 'n');
    assert.equal(item.available, false); assert.equal(item.disabled, true); assert.equal(item.open, null);
  }
});

test('private source or private provenance is redacted on the next build, including deduplicated public references', () => {
  for (const change of [s => { s.notes[0].private = true; }, s => { s.projects[0].incognito = true; }, s => { s.notes[0].agentRunId = 'private-run'; s.agentRuns.push({ id: 'private-run', private: true }); }]) {
    const state = fixture(); state.conversations[0].projectId = null; change(state); const result = build(state);
    const item = result.items.find(value => value.kind === 'note');
    assert.equal(item.status, 'private'); assert.equal(item.title, '私密文件'); assert.equal(item.path, ''); assert.equal(item.version, null); assert.equal(item.open, null);
    assert.doesNotMatch(JSON.stringify(item), /Working note|Old name|note-v1/);
  }
  const state = fixture(); state.agentRuns.push({ id: 'private-run', conversationId: 'c', private: true, fileReferences: [{ type: 'note', id: 'n', title: 'secret' }] });
  assert.equal(row(state, 'n').status, 'private');
});

test('private local identities never expose their path through serialized ids, keys or versions', () => {
  const state = fixture(), edit = local({ path: 'sensitive-title/secret.md' }); state.agentRuns.push(run(edit, { private: true }));
  const item = build(state).items.find(value => value.kind === 'local-file');
  assert.equal(item.id, null); assert.match(item.key, /^private:/); assert.equal(item.candidateId, null); assert.equal(item.projectId, null);
  assert.doesNotMatch(JSON.stringify(item), /sensitive-title|secret\.md|after-sha/);
});

test('privacy survives a source or owner moving to trash and does not revive archived content', () => {
  const state = fixture(); const note = state.notes.pop(); note.private = true; state.trash.push({ data: { notes: [note] } });
  assert.equal(row(state, 'n').status, 'private');
  const other = fixture(); other.conversations[0].projectId = null; const project = other.projects.shift(); project.private = true; other.trash.push({ data: { projects: [project] } });
  assert.equal(row(other, 'n').status, 'private'); assert.equal(build(other, { scope: 'all', projectId: 'p' }).items.length, 0);
});

test('private, deleted and duplicate current conversations cannot expose a conversation catalog', () => {
  for (const change of [s => { s.conversations[0].private = true; }, s => { s.conversations[0].deletedAt = 2; }, s => { s.conversations.push({ ...s.conversations[0] }); }]) {
    const state = fixture(); change(state); assert.deepEqual(build(state).items, []); assert.equal(build(state).available, false);
  }
});

test('all files is scoped to the selected project and local roots contain only connected metadata', () => {
  const state = fixture(); state.notes.push({ id: 'other', title: 'Other note', projectId: 'q' }, { id: 'loose', title: 'Loose note' });
  const result = build(state, { scope: 'all' });
  assert.deepEqual(result.items.map(item => item.id), ['n', 'a']); assert.equal(result.localRoots.length, 1); assert.equal(result.localRoots[0].candidateId, 'root');
  const standalone = build(state, { scope: 'all', projectId: null }); assert.equal(standalone.items.length, 4); assert.equal(standalone.localRoots.length, 2);
  state.projects[1].private = true; assert.equal(build(state, { scope: 'all', projectId: null }).items.length, 3); assert.equal(build(state, { scope: 'all', projectId: null }).localRoots.length, 1);
});

test('query uses current visible metadata only and cannot discover redacted titles', () => {
  const state = fixture(); assert.deepEqual(build(state, { query: 'notes Working' }).items.map(item => item.id), ['n']);
  state.notes[0].private = true; assert.deepEqual(build(state, { query: 'Working' }).items, []);
});

test('catalog does not read or clone document bodies, make requests or mutate state', () => {
  const state = fixture();
  for (const record of [...state.notes, ...state.imports]) for (const field of ['content', 'text', 'extractedText', 'pages']) Object.defineProperty(record, field, { configurable: true, get() { throw Error(`Body read: ${field}`); } });
  Object.freeze(state.notes[0]); Object.freeze(state.conversations[0].messages[0]);
  const savedFetch = global.fetch; global.fetch = () => { throw Error('Unexpected request'); };
  try { assert.equal(build(state).items.length, 2); assert.equal(build(state, { scope: 'all' }).items.length, 2); } finally { global.fetch = savedFetch; }
});

function capturedFixture() {
  const state = fixture();
  state.conversations[0].messages = [{ id: 'answer', role: 'agent', runId: 'capture-run', text: '实际保存的回复' }];
  state.agentRuns = [{ id: 'capture-run', conversationId: 'c', projectId: 'p', status: 'completed', results: [] }];
  const captured = require('../app/note-capture').plan(state, 'answer', { id: 'captured', now: 100, citationEvidence: require('../app/citation-evidence') }).note;
  state.notes = [captured];
  return { state, captured };
}

test('manually captured reply appears in conversation saved outputs without a synthetic run result', () => {
  const { state, captured } = capturedFixture(), before = JSON.stringify(state);
  const item = row(state, captured.id);
  assert.ok(item, 'the durable saved note must be discoverable from its source conversation');
  assert.equal(item.group, 'outputs'); assert.equal(item.status, 'saved');
  assert.deepEqual(item.open, { kind: 'note', id: captured.id });
  assert.equal(item.title, captured.title); assert.equal(JSON.stringify(state), before);
  assert.equal(state.agentRuns[0].results.length, 0, 'catalog must not modify execution history');
});

test('captured output survives cleaned source message/run and sync metadata, but does not guess unrelated notes or AI proposals', () => {
  const { state, captured } = capturedFixture(); state.agentRuns = []; state.conversations[0].messages = [];
  delete captured.sourceMessageId; // Current cloud projection retains compact provenance, not this legacy field.
  assert.equal(row(state, captured.id)?.status, 'saved');
  state.notes.push({ id: 'ordinary', sourceConversationId: 'c', content: 'not a capture' },
    { id: 'draft-only', sourceConversationId: 'c', aiDraft: { provenance: captured.provenance } });
  assert.deepEqual(build(state).items.map(item => item.id), [captured.id]);
  for (const change of [p => { p.output.id = 'other'; }, p => { p.output.variant = 'draft'; }, p => { p.origin.conversationId = 'other'; }, p => { p.operation = 'drafted'; }]) {
    const altered = JSON.parse(JSON.stringify(state)); change(altered.notes[0].provenance); assert.equal(build(altered).items.length, 0);
  }
});

test('captured output merges other explicit references and uses its current project after moving', () => {
  const { state, captured } = capturedFixture();
  state.conversations[0].messages.push({ id: 'other-input', role: 'user', fileReferences: [{ type: 'note', id: captured.id }] });
  state.agentRuns[0].results = [{ type: 'note', id: captured.id, operation: 'created' }];
  captured.projectId = 'q';
  const result = build(state); assert.equal(result.items.length, 1); const item = result.items[0];
  assert.equal(item.group, 'outputs'); assert.equal(item.projectId, 'q'); assert.equal(item.projectName, 'Other');
  assert.deepEqual(item.open, { kind: 'note', id: captured.id }); assert.ok(item.origins.some(origin => origin.kind === 'capture'));
  assert.ok(!build(state, { scope: 'all', projectId: 'p' }).items.some(item => item.id === captured.id));
  assert.ok(build(state, { scope: 'all', projectId: 'q' }).items.some(item => item.id === captured.id));
});

test('captured privacy, lifecycle and duplicate identities keep existing catalog guards', () => {
  for (const change of [
    h => { h.captured.private = true; }, h => { h.state.conversations[0].messages[0].private = true; },
    h => { h.captured.provenance.origin.private = true; },
    h => { h.state.agentRuns = []; h.state.trash = [{ data: { runs: [{ id: 'capture-run', private: true }] } }]; },
    h => { h.captured.projectId = 'q'; h.state.projects[1].private = true; }
  ]) {
    const h = capturedFixture(); change(h); const item = row(h.state, h.captured.id);
    assert.equal(item?.status, 'private'); assert.equal(item.open, null); assert.doesNotMatch(JSON.stringify(item), /实际保存的回复/);
  }
  for (const change of [h => { h.captured.deletedAt = 2; }, h => { h.captured.archived = true; }, h => { h.state.notes.push({ ...h.captured }); }, h => { h.captured.projectId = 'missing'; }]) {
    const h = capturedFixture(); change(h); const item = row(h.state, h.captured.id); assert.equal(item?.available, false); assert.equal(item.open, null);
  }
  const h = capturedFixture(); h.state.notes = []; assert.equal(build(h.state).items.length, 0);
});

test('captured projection reads only metadata even after human edits and legacy receipt absence', () => {
  const { state, captured } = capturedFixture(); delete captured.provenance;
  Object.defineProperty(captured, 'content', { get() { throw Error('catalog must not hash or read the saved body'); } });
  assert.equal(row(state, captured.id)?.status, 'saved');
  captured.sourceConversationId = 'other'; assert.equal(build(state).items.length, 0);
});
