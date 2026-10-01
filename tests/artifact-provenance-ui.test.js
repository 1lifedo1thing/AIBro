'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../app/artifact-provenance-ui');
const Provenance = require('../app/artifact-provenance');
function setup(extra = {}) {
  const state = { notes: [{ id: 'output', title: '研究结论', content: '正文', sourceAttachmentIds: ['pdf'], aiDraft: { title: '草稿', content: '未采纳' } }], imports: [{ id: 'pdf', name: '原文.pdf', content: '正文证据' }], projects: [], agentRuns: [], conversations: [] };
  const calls = [], paints = [];
  const controller = createController({ getState: () => state, project: Provenance.project, onChanged: view => paints.push(view), navigate: async target => { calls.push(target); return true; }, ...extra });
  assert.equal(controller.open({ type: 'note', id: 'output' }), true);
  return { state, controller, calls, paints };
}
test('legacy related source opens exact fresh id and does not invent a run', async () => {
  const { controller, calls } = setup();
  assert.equal(controller.view().projection.origin.recorded, false);
  assert.equal(await controller.act('open-run'), false);
  const source = controller.view().projection.related[0];
  assert.equal(await controller.act('open-source', { key: source.key, id: 'spoof', type: 'task' }), true);
  assert.equal(calls[0].id, 'pdf'); assert.equal(calls[0].type, 'import');
});
test('source removal or duplicate identity after paint blocks navigation', async () => {
  const { state, controller, calls } = setup();
  const source = controller.view().projection.related[0];
  state.imports.push({ ...state.imports[0] });
  assert.equal(await controller.act('open-source', source), false);
  state.imports = [];
  assert.equal(await controller.act('open-source', source), false); assert.equal(calls.length, 0);
  assert.equal(controller.view().projection.related[0].title, '来源不可用');
});
test('double click is serialized; canceled editor leave retains selected provenance variant', async () => {
  let resolve;
  const { controller } = setup({ navigate: () => new Promise(r => resolve = r) });
  assert.equal(await controller.act('variant', { variant: 'draft' }), true);
  const source = controller.view().projection.related[0], pending = controller.act('open-source', source);
  assert.equal(await controller.act('open-source', source), false); assert.equal(controller.close(), false);
  resolve(false); assert.equal(await pending, false);
  assert.equal(controller.view().variant, 'draft'); assert.equal(controller.view().reference.id, 'output');
});
test('privacy changed while waiting invalidates guard and clears panel', async () => {
  let resolve, guard, privateMode = false;
  const { controller } = setup({ isPrivate: () => privateMode, navigate: (_, available) => { guard = available; return new Promise(r => resolve = r); } });
  const pending = controller.act('open-source', controller.view().projection.related[0]);
  privateMode = true; assert.equal(guard(), false); resolve(false);
  assert.equal(await pending, false); assert.equal(controller.view().projection, null); assert.equal(controller.view().reference, null);
});
test('deleted draft and source becoming private are not accessible through stale props', async () => {
  const { state, controller, calls } = setup();
  delete state.notes[0].aiDraft;
  assert.equal(await controller.act('variant', { variant: 'draft' }), false);
  const source = controller.view().projection.related[0]; state.imports[0].private = true;
  assert.equal(await controller.act('open-source', source), false); assert.equal(calls.length, 0);
  assert.equal(controller.view().projection.related[0].title, '私密来源');
});
test('failed navigation resumes same panel and reports actual error', async () => {
  const events = [];
  const { controller } = setup({ suspend: () => events.push('suspend'), resume: yes => events.push(yes), navigate: async () => { throw Error('读取失败'); } });
  assert.equal(await controller.act('open-source', controller.view().projection.related[0]), false);
  assert.deepEqual(events, ['suspend', true]); assert.equal(controller.view().notice, '读取失败'); assert.equal(controller.isBusy(), false);
});
