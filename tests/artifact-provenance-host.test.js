'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture() {
  let release, opened = 0, leaves = 0;
  const context = vm.createContext({
    state: { conversations: [{ id: 'chat', messages: [] }], imports: [{ id: 'file' }], currentConversationId: null },
    storageHydrated: true, serverConflict: false, window: { PrivateMode: { isOn: () => false } },
    document: { body: { dataset: { view: 'agent' } }, dispatchEvent() {} }, CustomEvent: function () {},
    beforePreviewLeave: () => { leaves++; return new Promise(r => release = r); },
    openConversation: id => { opened++; context.state.currentConversationId = id; },
  });
  vm.runInContext([
    section('async function openSearchResult(', '\nfunction openCreateProjectDialog('),
    section('async function openActivityTarget(', '\nasync function openSourceComparison('),
    section('async function openArtifactProvenanceTarget(', '\nwindow.ArtifactProvenanceUI?.init('),
  ].join('\n'), context);
  return { context, release: value => release(value), opened: () => opened, leaves: () => leaves };
}
test('original conversation navigation checks provenance after exactly one leave decision', async () => {
  const f = fixture(); let available = true;
  const pending = f.context.openArtifactProvenanceTarget({ action: 'open-conversation', id: 'chat' }, () => available);
  assert.equal(f.leaves(), 1);
  available = false; f.release(true);
  assert.equal(await pending, false); assert.equal(f.opened(), 0); assert.equal(f.leaves(), 1);
});
test('conversation made private during editor leave cannot open before the final guard', async () => {
  const f = fixture();
  const pending = f.context.openArtifactProvenanceTarget({ action: 'open-conversation', id: 'chat' }, () => true);
  f.context.state.conversations[0].private = true; f.release(true);
  assert.equal(await pending, false); assert.equal(f.opened(), 0);
});
test('unchanged original conversation opens successfully after the same single decision', async () => {
  const f = fixture();
  const pending = f.context.openArtifactProvenanceTarget({ action: 'open-conversation', id: 'chat' }, () => true);
  f.release(true); assert.equal(await pending, true); assert.equal(f.opened(), 1); assert.equal(f.leaves(), 1);
});
test('real preview rechecks provenance before mounting a source after an awaited leave', async () => {
  const f = fixture(); let available = true;
  Object.assign(f.context, { previewOpenIntent: 0, previewRequestVersion: 0, showView() {}, sourcePreviewGuards: new Map() });
  // Only the pre-mount navigation segment is needed. A mount would fail in this
  // context, so a successful test proves the revoked target never reaches it.
  const preview = section('function captureDocumentOrigin(', '\nfunction openImport(');
  assert.ok(preview.length > 500);
  vm.runInContext(preview, f.context);
  const pending = f.context.openPreview('import', 'file', 2, undefined, () => available);
  available = false; f.release(true);
  assert.equal(await pending, false); assert.equal(f.context.previewRequestVersion, 0);
});
