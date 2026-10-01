const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../app/context-workbench.js');
const FileContext = require('../app/file-context.js');
const CitationEvidence = require('../app/citation-evidence.js');
const state = () => ({ projects: [{ id: 'p', name: 'Project', workspace: '科研', localFolder: { id: 'folder' } }], notes: [{ id: 'n', title: 'Current note', content: 'Current body', projectId: 'p' }], imports: [{ id: 'i', name: 'Current file', originalName: 'file.pdf', createdAt: 1, size: 17, projectId: 'p' }], conversations: [{ id: 'c', projectId: 'p', workspace: '科研', messages: [], draftAttachmentIds: [], attachments: [] }], agentRuns: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture() { const s = state(), c = s.conversations[0]; c.draftFileReferences = [await FileContext.libraryRef(s, 'note', 'n')]; return { s, c }; }
const opts = { model: { provider: 'openai-compatible', model: 'example-model', effort: 'high', token: 'DO_NOT_COPY' }, permission: '修改前确认', skills: [{ id: 'skill', name: 'Paper workflow', instructions: 'DO_NOT_COPY' }] };

test('next context shows only explicit references and actual staged attachments', async () => {
  const { s, c } = await fixture(); c.attachments = ['i']; c.messages.push({ role: 'user', text: 'Earlier', attachmentIds: ['i'] });
  const view = Context.snapshot(s, c, opts);
  assert.equal(view.materials.length, 1); assert.equal(view.materials[0].id, 'n'); assert.equal(view.model.model, 'example-model'); assert.equal(view.project, 'Project'); assert.equal(view.history.messages, 1); assert.doesNotMatch(JSON.stringify(view), /DO_NOT_COPY|Current body/);
  c.draftAttachmentIds = ['i']; assert.equal(Context.snapshot(s, c, opts).materials.length, 2);
});
test('an import chosen as a reference and draft attachment is one row with both origins', async () => {
  const { s, c } = await fixture(); c.draftFileReferences.push(await FileContext.libraryRef(s, 'import', 'i')); c.draftAttachmentIds = ['i', 'i'];
  const rows = Context.snapshot(s, c, opts).materials; assert.equal(rows.length, 2); const row = rows.find(row => row.id === 'i'); assert.equal(row.fromReference, true); assert.equal(row.fromAttachment, true);
});
test('removed historical references stay excluded while refreshed explicit selection appears', async () => {
  const { s, c } = await fixture(), ref = c.draftFileReferences[0]; c.draftFileReferences = []; c.messages = [{ role: 'user', fileReferences: [ref] }];
  assert.equal(Context.snapshot(s, c).materials.length, 1); FileContext.remove(c, ref); assert.equal(Context.snapshot(s, c).materials.length, 0); FileContext.stage(c, ref); assert.equal(Context.snapshot(s, c).materials.length, 1);
});
test('version inspection hashes only selected library entries and never reads a local file', async t => {
  const { s, c } = await fixture(); c.draftFileReferences.push({ type: 'local', projectId: 'p', candidateId: 'folder', path: 'main.txt', title: 'Local title', version: 'local-v' });
  let hashes = 0; global.FileContext = { ...FileContext, libraryRef: (...args) => { hashes++; return FileContext.libraryRef(...args); }, request: () => { throw Error('Panel must not read local files'); } }; t.after(() => delete global.FileContext);
  const versions = await Context.inspectVersions(s, c); assert.equal(hashes, 1); assert.equal(versions.get(FileContext.key(c.draftFileReferences[0])).kind, 'current'); assert.equal(versions.get(FileContext.key(c.draftFileReferences[1])).kind, 'local');
  s.notes[0].content += ' changed'; const changed = await Context.inspectVersions(s, c); assert.equal(changed.get(FileContext.key(c.draftFileReferences[0])).kind, 'changed');
});
test('missing, archived and private references cannot preview and private titles never enter the view', async () => {
  for (const setup of [s => { s.notes[0].private = true; }, s => { s.notes[0].sourceConversationId = 'secret'; s.conversations.push({ id: 'secret', incognito: true }); }, s => { s.notes[0].agentRunId = 'secret'; s.agentRuns.push({ id: 'secret', private: true }); }]) {
    const { s, c } = await fixture(); setup(s); const view = Context.snapshot(s, c); assert.equal(view.materials[0].private, true); assert.equal(view.materials[0].available, false); assert.doesNotMatch(JSON.stringify(view), /Current note|Current body/);
  }
  const { s, c } = await fixture(); s.notes[0].archived = true; assert.equal(Context.snapshot(s, c).materials[0].available, false); s.notes = []; assert.equal(Context.snapshot(s, c).materials[0].state, 'missing');
});
test('private mode and private owners clear all regular request and selection content', async () => {
  const { s, c } = await fixture(); const view = Context.snapshot(s, c, { ...opts, privateMode: true }); assert.equal(view.private, true); assert.deepEqual(view.materials, []); assert.equal(view.recent, null); assert.doesNotMatch(JSON.stringify(view), /Current note|example-model|Paper workflow/);
  s.projects[0].private = true; assert.equal(Context.snapshot(s, c).private, true);
});
test('duplicate record identity and missing project deny preview without choosing an arbitrary owner', async () => {
  const { s, c } = await fixture(); s.notes.push({ ...s.notes[0], content: 'Other' }); assert.equal(Context.snapshot(s, c).materials[0].available, false); s.notes.pop(); s.projects = []; assert.equal(Context.snapshot(s, c).materials[0].available, false);
});
test('latest request selection excludes deleted runs and uses run chronology', () => {
  const s = state(), c = s.conversations[0]; s.agentRuns = [{ id: 'latest', conversationId: 'c', startedAt: 9, modelConfig: { model: 'frozen' } }, { id: 'old', conversationId: 'c', startedAt: 3 }, { id: 'deleted', conversationId: 'c', startedAt: 10, deletedAt: 11 }];
  const view = Context.snapshot(s, c, opts); assert.equal(view.recent.id, 'latest'); assert.equal(view.recent.model.model, 'frozen'); assert.equal(view.model.model, 'example-model');
});
test('a historical record without model or attachment name stays unknown, never filled from current choices', () => {
  const s = state(), c = s.conversations[0]; s.agentRuns.push({ id: 'r', conversationId: 'c', attachmentIds: ['i'] });
  const view = Context.snapshot(s, c, opts); assert.equal(view.recent.model.model, ''); assert.equal(view.recent.model.provider, ''); assert.doesNotMatch(view.recent.files[0].title, /Current file/);
});
test('request manifest uses the sent attachment name snapshot and merges matching import reference', () => {
  const s = state(), c = s.conversations[0]; c.messages = [{ id: 'u', role: 'user', attachments: [{ id: 'i', name: 'Frozen original name' }] }]; s.agentRuns.push({ id: 'r', conversationId: 'c', userMessageId: 'u', attachmentIds: ['i'] });
  let view = Context.snapshot(s, c); assert.equal(view.recent.files[0].title, 'Frozen original name'); s.agentRuns[0].fileReferences = [{ type: 'import', id: 'i', title: 'Frozen ref title' }]; view = Context.snapshot(s, c); assert.equal(view.recent.files.length, 1); assert.equal(view.recent.files[0].fromReference, true); assert.equal(view.recent.files[0].fromAttachment, true);
});
test('request evidence keeps the supplied excerpt after source changes and keeps read logs distinct', () => {
  const s = state(), c = s.conversations[0], run = { id: 'r', conversationId: 'c', contextMetrics: { estimatedTokens: 123, characters: 800, history: { includedMessages: 2, totalMessages: 5, omittedMessages: 3 } }, knowledgeReads: [{ type: 'read', recordType: 'note', id: 'n', title: 'Read title', offset: 20 }] }; s.agentRuns.push(run);
  CitationEvidence.capture(run, { type: 'note', id: 'n', title: 'At request', excerpt: 'Original supplied passage', origin: 'read' }, s); s.notes[0].content = 'Changed later';
  const recent = Context.snapshot(s, c).recent; assert.equal(recent.sources[0].excerpt, 'Original supplied passage'); assert.equal(recent.sources[0].provided, true); assert.equal(recent.sources[0].status.kind, 'changed'); assert.equal(recent.reads.length, 1); assert.equal(recent.history.omitted, 3); assert.equal(recent.metrics.estimatedTokens, 123);
});
test('legacy reads have no fabricated excerpt from current source content', () => {
  const s = state(), c = s.conversations[0]; s.agentRuns.push({ id: 'r', conversationId: 'c', knowledgeReads: [{ type: 'read', recordType: 'note', id: 'n', title: 'Legacy title' }] });
  const source = Context.snapshot(s, c).recent.sources[0]; assert.equal(source.provided, false); assert.equal(source.excerpt, null); assert.doesNotMatch(JSON.stringify(source), /Current body/);
});
test('private historical evidence redacts its title, excerpt, path, URL and read error', () => {
  const s = state(), c = s.conversations[0], run = { id: 'r', conversationId: 'c', fileReferences: [{ type: 'note', id: 'n', title: 'SECRET_TITLE', version: 'SECRET_VERSION' }], knowledgeReads: [{ type: 'read', recordType: 'note', id: 'n', title: 'SECRET_TITLE', error: 'SECRET_ERROR' }] }; s.agentRuns.push(run);
  CitationEvidence.capture(run, { type: 'note', id: 'n', title: 'SECRET_TITLE', excerpt: 'SECRET_BODY', path: 'SECRET_PATH', url: 'https://secret.example/' }, s); s.notes[0].private = true;
  const recent = Context.snapshot(s, c).recent; assert.equal(recent.sources[0].private, true); assert.doesNotMatch(JSON.stringify(recent), /SECRET_|secret\.example/);
});
test('controller publishes saving and durable errors, and rejects duplicate clicks while awaiting host', async () => {
  const { s, c } = await fixture(); let resolve, calls = 0; const controller = Context.createController({ getState: () => s, getConversation: () => c, mutate: () => { calls++; return new Promise(done => { resolve = done; }); } }); controller.refresh();
  const command = { conversationId: c.id, action: 'remove-reference', ref: c.draftFileReferences[0] }, first = controller.mutate(command); assert.equal(controller.isBusy(), true); assert.equal(await controller.mutate(command), false); assert.equal(calls, 1); resolve(false); assert.equal(await first, false); assert.equal(controller.isBusy(), false); assert.match(controller.getView().error, /未能保存/); controller.destroy();
});
test('controller removal for import references uses the single remove-attachment host action', async () => {
  const { s, c } = await fixture(); c.draftFileReferences = [await FileContext.libraryRef(s, 'import', 'i')]; let submitted;
  const controller = Context.createController({ getState: () => s, getConversation: () => c, mutate: async command => { submitted = command; FileContext.remove(c, command.ref || { type: 'import', id: command.id }); return true; } }); controller.refresh();
  assert.equal(await controller.mutate({ conversationId: 'c', action: 'remove-attachment', id: 'i' }), true); assert.equal(submitted.action, 'remove-attachment'); assert.equal(controller.getView().materials.length, 0); controller.destroy();
});
test('controller never edits source records or selection itself when host persistence fails', async () => {
  const { s, c } = await fixture(), before = structuredClone(s); const controller = Context.createController({ getState: () => s, getConversation: () => c, mutate: async () => { throw Error('Disk full'); } }); controller.refresh();
  assert.equal(await controller.mutate({ conversationId: 'c', action: 'refresh-reference', ref: c.draftFileReferences[0] }), false); assert.deepEqual(s, before); assert.match(controller.getView().error, /Disk full/); controller.destroy();
});
test('an old owner save failure cannot paint errors or change a new conversation', async () => {
  const { s, c } = await fixture(); let current = c, reject; const controller = Context.createController({ getState: () => s, getConversation: () => current, mutate: () => new Promise((_, no) => { reject = no; }) }); controller.refresh();
  const promise = controller.mutate({ conversationId: 'c', action: 'remove-reference', ref: c.draftFileReferences[0] }); current = { id: 'other', messages: [], draftAttachmentIds: [] }; controller.refresh(); reject(Error('Old owner error')); await promise; assert.equal(controller.getView().conversationId, 'other'); assert.equal(controller.getView().error, ''); assert.equal(controller.isBusy(), false); controller.destroy();
});
test('click-time guards reject stale owner actions and private previews before the next render', async () => {
  const { s, c } = await fixture(); let current = c, previews = 0, mutations = 0; const controller = Context.createController({ getState: () => s, getConversation: () => current, mutate: async () => { mutations++; }, onPreview: () => { previews++; } }); controller.refresh(); const row = controller.getView().materials[0];
  s.notes[0].private = true; assert.equal(controller.preview(row), false); assert.equal(previews, 0); current = { id: 'other' }; assert.equal(await controller.mutate({ conversationId: 'c', action: 'remove-reference', ref: row.ref }), false); assert.equal(mutations, 0); controller.destroy();
});
test('unchanged selected versions hash once across streaming refreshes', async t => {
  const { s, c } = await fixture(); let hashes = 0; global.FileContext = { ...FileContext, libraryRef: (...args) => { hashes++; return FileContext.libraryRef(...args); } }; t.after(() => delete global.FileContext);
  const controller = Context.createController({ getState: () => s, getConversation: () => c }); controller.refresh(); for (let i = 0; i < 20; i++) controller.refresh(); for (let i = 0; i < 5; i++) await tick(); assert.equal(hashes, 1); assert.equal(controller.getView().materials[0].state, 'current');
  s.notes[0].content += ' changed'; controller.refresh(); assert.equal(controller.getView().materials[0].state, 'checking'); for (let i = 0; i < 5; i++) await tick(); assert.equal(hashes, 2); assert.equal(controller.getView().materials[0].state, 'changed'); controller.destroy();
});
test('an in-flight hash cannot restore private data after access changes', async t => {
  const { s, c } = await fixture(); let resolve; global.FileContext = { ...FileContext, libraryRef: () => new Promise(done => { resolve = done; }) }; t.after(() => delete global.FileContext);
  const controller = Context.createController({ getState: () => s, getConversation: () => c }); controller.refresh(); await tick(); s.notes[0].private = true; controller.refresh(); resolve({ version: c.draftFileReferences[0].version }); await tick(); assert.equal(controller.getView().materials[0].private, true); assert.doesNotMatch(JSON.stringify(controller.getView()), /Current note|Current body/); controller.destroy();
});
test('a completed hash from the previous conversation is discarded', async t => {
  const { s, c } = await fixture(); let current = c, resolve; global.FileContext = { ...FileContext, libraryRef: () => new Promise(done => { resolve = done; }) }; t.after(() => delete global.FileContext);
  const controller = Context.createController({ getState: () => s, getConversation: () => current }); controller.refresh(); await tick(); current = { id: 'next', messages: [] }; controller.refresh(); resolve({ version: 'later' }); await tick(); assert.equal(controller.getView().conversationId, 'next'); assert.deepEqual(controller.getView().materials, []); controller.destroy();
});
test('source inspection supplies the frozen source, real run ID and same-run siblings', () => {
  const s = state(), c = s.conversations[0], run = { id: 'r', conversationId: 'c' }; s.agentRuns.push(run); CitationEvidence.capture(run, { type: 'note', id: 'n', title: 'Frozen title', excerpt: 'Frozen excerpt' }, s); let received;
  const controller = Context.createController({ getState: () => s, getConversation: () => c, onEvidence: (...args) => { received = args; } }); controller.refresh(); const source = controller.getView().recent.sources[0], target = {}; controller.evidence(source, target); assert.equal(received[0].excerpt, 'Frozen excerpt'); assert.equal(received[1], 'r'); assert.equal(received[2], target); assert.equal(received[3].length, 1); controller.destroy();
});
