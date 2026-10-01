const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Overview = require('../app/project-overview');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const cut = (first, next) => {
  const from = source.indexOf(first), to = source.indexOf(next, from);
  assert.ok(from >= 0 && to > from, `Real application function: ${first}`);
  return source.slice(from, to);
};
const start = source.indexOf('function openConversation(');
const end = source.indexOf('\nfunction sidebarProjectWorkspace(', start);
assert.ok(start >= 0 && end > start, 'Use the real conversation selection and navigation helpers');

function harness(privateMode) {
  let sequence = 0;
  const elements = new Map();
  const state = {
    projects: [{ id: 'a', name: '同名项目', workspace: '课程' }, { id: 'b', name: '同名项目', workspace: '科研' }],
    conversations: [{ id: 'global', workspace: 'auto', projectId: null, draft: '', messages: [], attachments: [] }],
    currentProjectId: 'a', currentConversationId: 'global'
  };
  const calls = [];
  let overviewProps;
  const document = { body: { dataset: { view: 'project' } } };
  const $ = selector => {
    if (!elements.has(selector)) {const element={
      value: '', dataset: {conversationId:'global'}, open: false, focus() { calls.push(['focus', selector]); },
      close() { this.open = false; calls.push(['close', selector]); },
      click() { return this.onclick?.(); }
    };if(selector==='#previewDialog'){element.tagName='SECTION';element.hidden=true;delete element.open;delete element.close;}elements.set(selector,element);}
    return elements.get(selector);
  };
  const context = vm.createContext({
    window: {PrivateMode:privateMode, ProjectOverview: {
      mount: (host, options) => Overview.mount(host, { ...options, mount: (_host, name, props) => {
        assert.equal(name, 'ProjectOverview'); overviewProps = props;
        return { update: next => { overviewProps = next; }, unmount() {} };
      } })
    }}, state, $, Date, Number, document, previewOpenIntent: 0, PrivateMode: privateMode, uid: prefix => `${prefix}-${++sequence}`,
    formatDate: value => String(value), formatRelative: value => String(value),
    currentConversation: () => state.conversations.find(item => item.id === state.currentConversationId),
    workspaceName: value => ['课程', '科研'].includes(value) ? value : '日常',
    save: () => calls.push(['save']), renderAll: () => calls.push(['render']),
    showView: (view, label) => {
      calls.push(['view', view, label]);
      document.body.dataset.view = view;
      $('#agentInput').value = state.conversations.find(item => item.id === state.currentConversationId)?.draft || '';
      $('#messageList').dataset.conversationId = state.currentConversationId;
    },
    toast: message => calls.push(['toast', message])
  });
  vm.runInContext(source.slice(start, end), context);
  const handler = source.split('\n').find(line => line.startsWith("$('#projectChat').onclick ="));
  assert.ok(handler, 'The current project continue button is wired');
  vm.runInContext(handler, context);
  // The deleted projectFirstInput was a second "continue" button. Its replacement
  // is the real overview's guarded "new chat" action, with distinct semantics.
  vm.runInContext(cut('function recordMatchesSpace(', '\nfunction resolveSpaceSection(')
    + cut('let workspaceRouteIntent =', '\nasync function navigateWorkspaceView(')
    + cut('async function navigateWorkspaceNewConversation(', '\nasync function openProject(')
    + cut('async function beforePreviewSwitch(', '\nfunction canPersistDocumentTab(')
    + cut('let projectOverviewController =', '\nfunction renderProject('), context);
  const add = (id, fields = {}) => {
    const conversation = { id, projectId: 'a', workspace: '课程', messages: [], attachments: [], createdAt: 1, updatedAt: 1, ...fields };
    state.conversations.push(conversation);
    return conversation;
  };
  return { state, calls, $, add, create: context.newConversation, open:context.openConversation, continue: context.continueProjectConversation,
    startFromOverview: () => { context.renderProjectOverview(() => {}); assert.equal(overviewProps.available, true); return overviewProps.onStart(); }
  };
}

test('continue opens the latest active conversation in the exact project without copying its content', () => {
  const h = harness();
  h.add('old', { updatedAt: 10 });
  const recent = h.add('recent', { updatedAt: 30, draft: '未发送的问题', messages: [{ id: 'message', text: '已有讨论' }], attachments: ['pdf'] });
  h.add('created-later', { createdAt: 20, updatedAt: 20 });
  const order = h.state.conversations.slice();
  h.$('#agentInput').value = '原对话草稿'; h.$('#previewDialog').hidden = false;
  h.$('#projectChat').click();
  assert.equal(h.state.currentConversationId, 'recent');
  assert.deepEqual(h.state.conversations, order, 'Selection must not reorder or append canonical records');
  assert.strictEqual(h.state.conversations.find(item => item.id === 'recent'), recent);
  assert.equal(h.state.conversations[0].draft, '原对话草稿');
  assert.equal(h.$('#agentInput').value, '未发送的问题');
  assert.deepEqual(recent.attachments, ['pdf']);
  assert.equal(recent.messages[0].text, '已有讨论');
  assert.equal(h.$('#previewDialog').hidden, false, 'A persistent reader remains open while the main conversation changes');
  assert.equal('close' in h.$('#previewDialog'), false);
  assert.ok(h.calls.some(call => call[0] === 'view' && call[1] === 'agent'));
});

test('archived and deleted conversations cannot outrank a valid older one', () => {
  const h = harness(); h.add('valid', { updatedAt: 2 });
  for (const flag of [{ archived: true }, { archivedAt: 1 }, { deleted: true }, { deletedAt: 1 }, { status: 'archived' }, { status: 'deleted' }]) {
    h.add(`inactive-${h.state.conversations.length}`, { updatedAt: 1000, ...flag });
  }
  h.continue('a');
  assert.equal(h.state.currentConversationId, 'valid');
});

test('same-name projects and result-only associations never become the continued project context', () => {
  const h = harness();
  h.add('other-project', { projectId: 'b', workspace: '科研', updatedAt: 999, messages: [{ results: [{ projectId: 'a' }] }] });
  h.add('result-only', { projectId: null, updatedAt: 1000, messages: [{ results: [{ projectId: 'a' }] }] });
  h.continue('a');
  const created = h.state.conversations.find(item => item.id === h.state.currentConversationId);
  assert.equal(created.projectId, 'a');
  assert.equal(created.workspace, '课程');
  assert.equal(created.messages.length, 0);
  assert.equal(created.attachments.length, 0);
  assert.equal(h.state.conversations.length, 4);
});

test('overview new-chat and continue entries reuse an empty scoped chat; continue preserves its later draft', async () => {
  const h = harness();
  await h.startFromOverview();
  const id = h.state.currentConversationId;
  for (let i = 0; i < 3; i++) { h.$('#projectChat').click(); await h.startFromOverview(); }
  assert.equal(h.state.conversations.length, 2);
  assert.equal(h.state.currentConversationId, id);
  h.$('#agentInput').value = '项目里的草稿';
  h.$('#projectChat').click(); h.$('#projectChat').click();
  assert.equal(h.state.conversations.length, 2);
  assert.equal(h.state.currentConversationId, id);
  assert.equal(h.state.conversations[1].projectId, 'a');
  assert.equal(h.state.conversations[1].workspace, '课程');
  assert.equal(h.state.conversations[1].draft, '项目里的草稿');
});

test('opening the continue button after switching projects resolves the current project at click time', () => {
  const h = harness(); h.add('a-chat'); h.add('b-chat', { projectId: 'b', workspace: '科研' });
  h.$('#projectChat').click(); assert.equal(h.state.currentConversationId, 'a-chat');
  h.state.currentProjectId = 'b'; h.$('#projectChat').click();
  assert.equal(h.state.currentConversationId, 'b-chat');
  assert.equal(h.state.conversations.length, 3);
});

test('overview new-chat preserves the previous project draft and never reuses another project conversation', async () => {
  const h = harness();
  await h.startFromOverview();
  const previous = h.state.conversations.find(item => item.id === h.state.currentConversationId);
  h.$('#agentInput').value = '保留项目草稿';
  await h.startFromOverview();
  assert.equal(previous.draft, '保留项目草稿');
  assert.notEqual(h.state.currentConversationId, previous.id);
  assert.equal(h.state.conversations.length, 3);
  h.state.currentProjectId = 'b';
  await h.startFromOverview();
  const current = h.state.conversations.find(item => item.id === h.state.currentConversationId);
  assert.equal(current.projectId, 'b'); assert.equal(current.workspace, '科研');
  assert.equal(current.messages.length, 0); assert.equal(current.attachments.length, 0);
  assert.equal(h.state.conversations.length, 4); assert.equal(previous.draft, '保留项目草稿');
});

test('missing, archived, or deleted projects neither create nor open a conversation', () => {
  for (const flag of [null, { archived: true }, { archivedAt: 1 }, { deleted: true }, { deletedAt: 1 }, { status: 'archived' }, { status: 'deleted' }]) {
    const h = harness(); h.add('must-not-open');
    if (flag) Object.assign(h.state.projects[0], flag); else h.state.currentProjectId = 'missing';
    h.$('#projectChat').click();
    assert.equal(h.state.conversations.length, 2);
    assert.equal(h.state.currentConversationId, 'global');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], 'toast');
    assert.match(h.calls[0][1], /删除或归档/);
  }
});

test('recency uses createdAt when updatedAt is missing or invalid, with deterministic ties', () => {
  const h = harness();
  h.add('old', { updatedAt: 5 });
  h.add('missing-update', { updatedAt: null, createdAt: 20 });
  h.add('bad-update', { updatedAt: 'invalid', createdAt: 30 });
  h.add('same-time', { updatedAt: 30 });
  h.continue('a'); assert.equal(h.state.currentConversationId, 'bad-update');
  h.add('zero-update', { updatedAt: 0, createdAt: 40 });
  h.continue('a'); assert.equal(h.state.currentConversationId, 'zero-update');
  h.add('iso-date', { updatedAt: '2026-09-12T12:00:00Z' });
  h.continue('a'); assert.equal(h.state.currentConversationId, 'iso-date');
});


test('ten new-conversation clicks reuse a blank conversation; messages and drafts are preserved', () => {
  const h = harness();
  for(let i=0;i<10;i++) h.create();
  assert.equal(h.state.conversations.length,1);
  h.$('#agentInput').value='unsent draft';h.create();
  assert.equal(h.state.conversations.length,2);
  assert.equal(h.state.conversations[0].draft,'unsent draft');
  const blank=h.state.conversations[1];blank.messages.push({role:'user',text:'sent'});h.create();
  assert.equal(h.state.conversations.length,3);
  for(let i=0;i<10;i++)h.create();
  assert.equal(h.state.conversations.length,3);
});
test('new conversations never reuse attachments, references, archived records or a different scope', () => {
  for(const fields of [{attachments:['pdf']},{draftAttachmentIds:['pending']},{draftFileReferences:[{type:'note',id:'n'}]},{archived:true},{skillId:'paper'},{title:'named draft'}]) {
    const h=harness();Object.assign(h.state.conversations[0],fields);h.create();
    assert.equal(h.state.conversations.length,2,JSON.stringify(fields));
  }
  const h=harness();h.create('课程','a');h.create('科研','b');h.create('课程','a');
  assert.equal(h.state.conversations.length,3);assert.equal(h.state.conversations.find(c=>c.id===h.state.currentConversationId).projectId,'a');
});

test('new private conversations never reuse a public blank, but reuse blanks in the same privacy mode', () => {
  let privateMode=true;
  const h=harness({isOn:()=>privateMode,mark:conversation=>{if(privateMode)conversation.ephemeral=true;}});
  const ordinary=h.state.conversations[0];
  h.create();
  const privateId=h.state.currentConversationId;
  assert.notEqual(privateId,ordinary.id);
  assert.equal(h.state.conversations.find(c=>c.id===privateId).ephemeral,true);
  h.create();assert.equal(h.state.currentConversationId,privateId);
  assert.equal(h.state.conversations.length,2);
  privateMode=false;h.create();
  assert.equal(h.state.currentConversationId,ordinary.id,'ordinary mode must not reuse a leftover private blank');
  assert.equal(ordinary.ephemeral,undefined,'existing ordinary data retains its lifetime');
});

test('opening a saved ordinary conversation cannot silently leave a private draft while the private notice remains active', () => {
  const h=harness({isOn:()=>true,mark:conversation=>{conversation.ephemeral=true;}});
  h.create();const privateId=h.state.currentConversationId;
  h.$('#agentInput').value='私密草稿';h.open('global');
  assert.equal(h.state.currentConversationId,privateId);
  assert.equal(h.$('#agentInput').value,'私密草稿');
  assert.match(h.calls.at(-1)[1],/退出无痕模式/);
});

for (const action of ['open', 'create']) test(`${action} never overwrites restored conversation draft with another hidden composer`, () => {
  const h = harness(); const restored = h.add('restored', {draft:'Restored unsent question'});
  h.state.currentConversationId = restored.id;
  h.$('#messageList').dataset.conversationId = 'global'; h.$('#agentInput').value = '';
  if(action==='open') h.open('restored'); else h.create('科研','b');
  assert.equal(restored.draft,'Restored unsent question');
});
