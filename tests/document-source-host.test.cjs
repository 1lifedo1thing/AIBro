'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Evidence = require('../app/citation-evidence');
const Provenance = require('../app/artifact-provenance');
const ProjectFiles = require('../app/project-files');
const Editor = require('../app/note-editor');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const cut = (start, end) => {const at = source.indexOf(start), until = source.indexOf(end, at); assert.ok(at >= 0 && until > at, start); return source.slice(at, until);};
const defer = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;

function adoptDraft(h) {
  const session = Editor.begin(h.state, 'owner'); session.content = h.owner().aiDraft.content; session.appliedAiDraft = JSON.stringify(h.owner().aiDraft);
  const change = Editor.prepare(h.state, session, 10); assert.equal(change.after.aiDraft, undefined);
  h.state.notes[h.state.notes.findIndex(note => note.id === 'owner')] = change.after;
}

function fixture(type = 'import', variant = 'body') {
  const state = {ui: {}, projects: [{id: 'project', workspace: '科研', localFolder: {id: 'folder'}}],
    notes: [{id: 'owner', title: 'Saved synthetic note', content: 'Synthetic saved body', projectId: 'project'}, {id: 'source-note', title: 'Source note', content: 'Actual synthetic source', projectId: 'project'}],
    imports: [{id: 'pdf', name: 'Synthetic.pdf', content: 'Actual synthetic source', mimeType: 'application/pdf', pageCount: 5, projectId: 'project'}, {id: 'other-pdf', name: 'Other.pdf', content: 'Other source', projectId: 'project'}],
    papers: [{id: 'paper:with:colon', title: 'Synthetic paper', content: 'Actual synthetic source', projectId: 'project'}],
    tasks: [{id: 'task:with:colon', title: 'Synthetic task', content: 'Actual synthetic source', projectId: 'project'}],
    conversations: [{id: 'chat', projectId: 'project', messages: []}], agentRuns: [], trash: [], previewRecord: {type: 'note', id: 'owner'}};
  let sequence = 0;
  const owner = () => state.notes.find(note => note.id === 'owner');
  function attach(nextVariant, nextType, fields = {}) {
    if (nextVariant === 'draft') owner().aiDraft = {title: 'Synthetic proposal', content: 'Synthetic draft body'};
    const id = {import: 'pdf', note: 'source-note', paper: 'paper:with:colon', task: 'task:with:colon', local: 'local-source'}[nextType];
    const run = {id: `saved-run-${++sequence}`, conversationId: 'chat', projectId: 'project', status: 'completed'};
    state.agentRuns.push(run);
    const source = Evidence.capture(run, {type: nextType, id, title: 'Saved source', projectId: 'project', excerpt: 'Actual synthetic source', ...(nextType === 'import' ? {page: 2} : {}), ...(nextType === 'local' ? {candidateId: 'folder', path: 'docs/source.md', refKey: '["local","folder","docs/source.md"]'} : {}), ...fields}, state);
    const receipt = Provenance.capture(state, run, {type: 'note', id: 'owner', record: owner(), variant: nextVariant, operation: 'captured', at: 5});
    if (nextVariant === 'draft') owner().aiDraft.provenance = receipt; else owner().provenance = receipt;
    return {href: '#aibro-source-' + encodeURIComponent(source.sourceId), source, input: receipt.inputs[0], run};
  }
  const captured = attach(variant, type);
  return {state, owner, attach, variant, type, ...captured};
}

function harness(f = fixture()) {
  const calls = {preview: [], typed: [], leaves: 0, errors: []}; let leave = () => true, privateMode = false;
  const dialogs = {taskDialog: {open: false}, paperDialog: {open: false}};
  const showView = () => {}; showView.navigationVersion = 1;
  const ReadingPane = {isActive: (kind, id) => f.state.previewRecord?.type === kind && f.state.previewRecord?.id === id, reconcile() {}};
  const context = vm.createContext({state: f.state, storageHydrated: true, serverConflict: false, showView,
    window: {CitationEvidence: Evidence, ProjectFiles, ReadingPane, PrivateMode: {isOn: () => privateMode}}, ProjectFiles, ReadingPane,
    previewOpenIntent: 0, sourcePreviewGuards: new Map(), captureDocumentOrigin: () => ({view: 'document', kind: 'note', id: 'owner'}),
    beforePreviewLeave: () => {calls.leaves++; return leave();}, toast: message => calls.errors.push(message),
    previewItem: (kind, id) => kind === 'local-file' ? ProjectFiles.parseLocal(id, f.state) : Evidence.recordFor(f.state, kind, id),
    document: {body: {dataset: {view: 'agent'}}}, $: selector => dialogs[selector.slice(1)],
    visibleTask: () => true, visiblePaper: () => true,
    openTask: id => {calls.typed.push(['task', id]); f.state.openTaskId = id; dialogs.taskDialog.open = true;},
    openPaper: id => {calls.typed.push(['paper', id]); f.state.ui.openPaperId = id; dialogs.paperDialog.open = true;},
    commitPreview: (kind, id, page, sourceGuard, navigation) => {calls.preview.push({kind, id, page, sourceGuard, navigation}); f.state.previewRecord = {type: kind, id}; return true;}
  });
  vm.runInContext(cut('function previewSourceAvailable(', '\nfunction documentTabSource('), context);
  // Execute the production preview navigation/leave/availability segment.
  // Replace only the heavy DOM mounting tail after the actual target lookup.
  const preview = cut('async function openPreview(', '  if (!sameLocalFile && window.ProjectFiles?.unmount()');
  vm.runInContext(preview + '\n return commitPreview(kind, id, requestedPage, sourceGuard, navigation);\n}', context);
  vm.runInContext(cut('async function openSearchResult(', '\nfunction openCreateProjectDialog('), context);
  vm.runInContext(cut('async function openSavedDocumentSource(', "\ndocument.addEventListener('click'"), context);
  return {...f, context, calls, dialogs, setLeave: next => {leave = next;}, setPrivate: value => {privateMode = value;}, open: (href = f.href, options = {}) => context.openSavedDocumentSource('owner', href, {variant: f.variant, ...options})};
}

test('saved document source follows exact note/import/local target and retained PDF page through the real preview guard', async () => {
  for (const type of ['import', 'note', 'local']) {
    const h = harness(fixture(type)), anchor = {synthetic: true};
    assert.equal(await h.open(undefined, {anchor}), true);
    assert.equal(h.calls.leaves, 1); assert.equal(h.calls.preview.length, 1);
    const opened = h.calls.preview[0]; assert.equal(opened.kind, type === 'local' ? 'local-file' : type);
    assert.equal(opened.id, type === 'local' ? ProjectFiles.localId(h.source) : h.source.id);
    assert.equal(opened.page, type === 'import' ? 2 : 1); assert.equal(opened.sourceGuard.sourceId, h.source.sourceId); assert.equal(opened.navigation.anchor, anchor);
  }
});

test('paper/task citations keep typed routing and colon-bearing IDs through the real search dispatcher', async () => {
  for (const type of ['paper', 'task']) {
    const h = harness(fixture(type)); assert.equal(await h.open(), true);
    assert.equal(h.calls.leaves, 1); assert.deepEqual(h.calls.typed, [[type, `${type}:with:colon`]]); assert.deepEqual(h.calls.preview, []);
  }
});

test('source access, mapping, page and route changes during the actual awaited leave block navigation', async () => {
  for (const type of ['import', 'paper', 'task']) for (const change of ['source-private', 'owner-private', 'origin-private', 'mapping', 'run', 'conversation', 'route', 'stale-anchor', 'conflict', 'private-mode']) {
    const h = harness(fixture(type)), gate = defer(); let current = true; h.setLeave(() => gate.promise);
    const before = JSON.stringify(h.state.previewRecord), pending = h.open(undefined, {isCurrent: () => current});
    if (change === 'source-private') h.state[{import: 'imports', paper: 'papers', task: 'tasks'}[type]][0].private = true;
    if (change === 'owner-private') h.owner().provenance.origin.private = true;
    if (change === 'origin-private') h.state.trash = [{data: {runs: [{id: h.run.id, private: true}]}}];
    if (change === 'mapping') h.input.page = 4;
    if (change === 'run') h.owner().provenance.origin.runId = 'another-public-run';
    if (change === 'conversation') h.owner().provenance.origin.conversationId = 'another-public-chat';
    if (change === 'route') h.context.showView.navigationVersion++;
    if (change === 'stale-anchor') current = false;
    if (change === 'conflict') h.context.serverConflict = true;
    if (change === 'private-mode') h.setPrivate(true);
    gate.resolve(true); assert.equal(await pending, false, `${type}/${change}`);
    assert.deepEqual(h.calls.preview, []); assert.deepEqual(h.calls.typed, []); assert.equal(JSON.stringify(h.state.previewRecord), before);
  }
});

test('local receipt path and folder remapping during leave cannot retarget the requested source', async () => {
  for (const change of ['path', 'folder', 'project', 'ref-key']) {
    const h = harness(fixture('local')), gate = defer(); h.setLeave(() => gate.promise); const pending = h.open();
    if (change === 'path') h.input.path = 'docs/different.md';
    if (change === 'folder') {h.state.projects[0].localFolder.id = 'replacement'; h.input.candidateId = 'replacement';}
    if (change === 'project') h.state.projects[0].archived = true;
    if (change === 'ref-key') h.input.refKey = 'different-read';
    gate.resolve(true); assert.equal(await pending, false, change); assert.deepEqual(h.calls.preview, []);
  }
});

test('cancelled leave retains the current document and does not report success merely because the target was already active', async () => {
  for (const alreadyActive of [false, true]) {
    const h = harness(); if (alreadyActive) h.state.previewRecord = {type: 'import', id: 'pdf'};
    const before = JSON.stringify(h.state.previewRecord); h.setLeave(() => false);
    assert.equal(await h.open(), false); assert.equal(JSON.stringify(h.state.previewRecord), before); assert.deepEqual(h.calls.preview, []); assert.deepEqual(h.calls.typed, []);
  }
  const h = harness(fixture('task')); h.setLeave(() => false); assert.equal(await h.open(), false); assert.deepEqual(h.calls.typed, []);
});

test('body and AI draft receipts cannot resolve each other or unrelated runs', async () => {
  const f = fixture('import'), draft = f.attach('draft', 'note'), h = harness(f);
  assert.equal(await h.open(draft.href, {variant: 'body'}), false);
  assert.equal(await h.open(f.href, {variant: 'draft'}), false);
  assert.equal(h.calls.leaves, 0); assert.deepEqual(h.calls.preview, []);
  assert.equal(await h.open(f.href, {variant: 'body'}), true); assert.equal(h.calls.preview.at(-1).id, 'pdf');
  assert.equal(await h.open(draft.href, {variant: 'draft'}), true); assert.equal(h.calls.preview.at(-1).id, 'source-note');
});

test('removed or ambiguous targets and malformed local locators never mount a reader', async () => {
  for (const mutate of [h => {h.state.imports = [];}, h => {h.state.imports[0].archived = true;}, h => {h.state.imports.push({...h.state.imports[0]});}, h => {h.owner().provenance.inputs.push({...h.input});}, h => {h.owner().provenance.output.id = 'another-note';}]) {
    const h = harness(); mutate(h); assert.equal(await h.open(), false); assert.deepEqual(h.calls.preview, []); assert.deepEqual(h.calls.typed, []);
  }
  const h = harness(fixture('local')); h.input.path = '../outside.md'; assert.equal(await h.open(), false); assert.deepEqual(h.calls.preview, []);
});

test('successful actual AI draft promotion during leave preserves only that exact citation authority', async () => {
  for (const reordered of [false, true]) {
    const h = harness(fixture('import', 'draft'));
    h.setLeave(() => {adoptDraft(h); if (reordered) h.owner().provenance = reverseKeys(h.owner().provenance); return true;});
    assert.equal(await h.open(), true); assert.equal(h.calls.preview.length, 1); assert.equal(h.calls.preview[0].id, 'pdf'); assert.equal(h.calls.preview[0].page, 2);
  }
});

test('a promoted receipt must match entirely even when its source marker and target identity are unchanged', async () => {
  for (const mutate of [receipt => {receipt.operation = 'different-operation';}, receipt => {receipt.inputs[0].title = 'Changed receipt label';}, receipt => {receipt.origin.runId = 'replacement-run';}, receipt => {receipt.origin.conversationId = 'replacement-chat';}, receipt => {receipt.inputs[0].page = 4;}]) {
    const h = harness(fixture('import', 'draft'));
    h.setLeave(() => {adoptDraft(h); mutate(h.owner().provenance); return true;});
    assert.equal(await h.open(), false); assert.deepEqual(h.calls.preview, []); assert.deepEqual(h.calls.typed, []);
  }
});

test('discarding an AI draft never falls back to a body receipt even when a source marker was copied', async () => {
  const f = fixture('note'), draft = f.attach('draft', 'import');
  f.owner().provenance.inputs[0].sourceId = draft.source.sourceId;
  const h = harness({...f, variant: 'draft', href: draft.href});
  h.setLeave(() => {delete h.owner().aiDraft; return true;});
  assert.equal(await h.open(), false); assert.deepEqual(h.calls.preview, []);
});
