const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Origin = require('../app/document-origin.js');
const fixture = () => ({
  projects: [{ id: 'p', name: '研究项目', workspace: '科研', localFolder: { id: 'folder' } }, { id: 'q', name: '课程项目', workspace: '课程' }],
  conversations: [{ id: 'c', projectId: 'p', title: '资料讨论', messages: [{ id: 'm', role: 'user', text: 'PRIVATE BODY' }] }],
  notes: [{ id: 'n', projectId: 'p', title: '研究笔记', content: 'PRIVATE BODY' }], imports: [{ id: 'i', projectId: 'p', name: '材料.pdf' }],
  tasks: [{ id: 't', projectId: 'p', title: '核对资料' }], agentRuns: [{ id: 'r', projectId: 'p', conversationId: 'c', fileChanges: [{ id: 'n' }], localFileEdits: [{ id: 'e' }] }],
  currentProjectId: 'p', currentConversationId: 'c', ui: { projectTab: 'outputs', spaceTabs: { research: 'papers', daily: 'knowledge' } }, trash: []
});
const project = { view: 'project', projectId: 'p', section: 'outputs' };
const agent = { view: 'agent', conversationId: 'c', messageId: 'm' };
const document = { view: 'document', kind: 'note', id: 'n' };

test('UMD exposes the same pure interface without browser state', () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(require.resolve('../app/document-origin.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.DocumentOrigin), ['clean', 'capture', 'resolve']);
});
test('clean whitelists route identities and never retains malicious metadata', () => {
  for (const value of [project, agent, document, { view: 'task', id: 't' }, { view: 'daily', section: 'knowledge' }, { view: 'captures' }]) {
    const dirty = { ...value, title: 'LEAK', content: 'LEAK', url: 'https://evil.test', source: { content: 'LEAK' }, __proto__: { body: 'LEAK' } };
    assert.deepEqual(Origin.clean(dirty), value); assert.doesNotMatch(JSON.stringify(Origin.clean(dirty)), /LEAK|evil/);
  }
  assert.deepEqual(Origin.clean({ view: 'agent', conversationId: 'c', projectId: 'background', section: 'outputs' }), { view: 'agent', conversationId: 'c' });
});
test('clean rejects unsupported routes, invalid identities and unsafe control characters', () => {
  for (const value of [null, [], '', {}, { view: 'settings' }, { view: 'project', projectId: '' }, { view: 'agent', conversationId: 42 }, { view: 'task', id: ' \t ' }, { view: 'document', kind: 'paper', id: 'n' }, { view: 'document', kind: 'note', id: 'n\n' }]) assert.equal(Origin.clean(value), null);
  assert.deepEqual(Origin.clean({ view: 'task', id: 'p:arbitrary punctuation 雪' }), { view: 'task', id: 'p:arbitrary punctuation 雪' });
});
test('task entry retains only one workspace route and rejects recursive trails and display payloads', () => {
  const value = { view: 'task', id: 't', entry: { ...project, title: 'LEAK', body: 'LEAK', url: 'https://evil.test', entry: agent } };
  assert.deepEqual(Origin.clean(value), { view: 'task', id: 't', entry: project });
  for (const entry of [{ view: 'task', id: 'other', entry: project }, document, { view: 'settings' }, {}, null]) {
    assert.deepEqual(Origin.clean({ view: 'task', id: 't', entry }), { view: 'task', id: 't' });
  }
  const cyclic = { view: 'task', id: 't' }; cyclic.entry = cyclic;
  assert.deepEqual(Origin.clean(cyclic), { view: 'task', id: 't' });
});
test('a task preserves its entry independently of task moves and refuses revoked parent routes', () => {
  const state = fixture(), origin = { view: 'task', id: 't', entry: project };
  state.tasks[0].projectId = 'q';
  assert.equal(Origin.resolve(state, origin).available, true);
  assert.deepEqual(Origin.resolve(state, origin).origin.entry, project);
  assert.match(Origin.resolve(state, origin).caption, /课程项目/);
  state.projects[0].private = true;
  assert.equal(Origin.resolve(state, origin).available, false);
  assert.equal(Origin.resolve(state, origin).caption, '');
  delete state.projects[0].private; state.projects.push({ ...state.projects[0] });
  assert.equal(Origin.resolve(state, origin).available, false);
  assert.equal(Origin.resolve(state, { view: 'task', id: 't', entry: { view: 'agenda' } }).available, true);
});
test('project and space section defaults match supported root routes', () => {
  for (const section of ['conversations', 'knowledge', 'outputs', 'tasks', 'schedule', 'overview']) assert.equal(Origin.clean({ ...project, section }).section, section);
  assert.equal(Origin.clean({ ...project, section: 'evil' }).section, 'conversations');
  for (const view of ['daily', 'courses', 'research']) {
    for (const section of ['projects', 'knowledge', 'tasks', 'overview']) assert.deepEqual(Origin.clean({ view, section }), { view, section });
    assert.equal(Origin.clean({ view, section: 'content' }).section, 'knowledge');
    assert.equal(Origin.clean({ view, section: 'papers' }).section, view === 'research' ? 'papers' : 'projects');
  }
  assert.deepEqual(Origin.clean({ view: 'dashboard', section: 'knowledge' }), { view: 'dashboard' });
});
test('capture follows the active route and never borrows a background project', () => {
  const state = fixture(); assert.deepEqual(Origin.capture(state, { view: 'project' }), project);
  assert.deepEqual(Origin.capture(state, { view: 'project', projectSection: 'knowledge' }), { ...project, section: 'knowledge' });
  assert.deepEqual(Origin.capture(state, { view: 'agent', messageId: 'm' }), agent);
  assert.deepEqual(Origin.capture(state, { view: 'research' }), { view: 'research', section: 'papers' });
  assert.deepEqual(Origin.capture(state, { view: 'daily', spaceSection: 'tasks' }), { view: 'daily', section: 'tasks' });
  state.currentConversationId = 'missing'; assert.equal(Origin.capture(state, { view: 'agent' }), null);
  for (const view of ['settings', 'document', 'task', undefined]) assert.equal(Origin.capture(state, { view }), null);
});
test('capture and resolution do not expose ordinary routes during private mode', () => {
  const state = fixture(); for (const view of ['project', 'agent', 'daily', 'dashboard']) assert.equal(Origin.capture(state, { view, privateMode: true }), null);
  assert.deepEqual(Origin.resolve(state, project, { privateMode: true }), { origin: project, label: '原入口不可用', caption: '', available: false });
});
test('live names and current ownership drive captions without truncation or state mutation', () => {
  const state = fixture(), before = JSON.stringify(state);
  assert.deepEqual(Origin.resolve(state, project), { origin: project, label: '返回成果', caption: '科研空间 / 研究项目 / 成果', available: true });
  assert.equal(Origin.resolve(state, agent).caption, '科研空间 / 研究项目 / 资料讨论');
  assert.equal(JSON.stringify(state), before);
  state.projects[0].name = '新名称'.repeat(300); assert.ok(Origin.resolve(state, project).caption.includes(state.projects[0].name));
  state.conversations[0].projectId = 'q'; assert.equal(Origin.resolve(state, agent).caption, '课程空间 / 课程项目 / 资料讨论');
  state.notes[0].projectId = 'q'; assert.equal(Origin.resolve(state, document).caption, '课程空间 / 课程项目 / 研究笔记');
  assert.equal(Origin.resolve(state, project).origin.projectId, 'p', 'an entry project does not move with the opened document');
});
test('project deletion, duplicates, trash and privacy revoke availability with no title leaks', () => {
  const mutations = [s => { s.projects = []; }, s => { s.projects.push({ ...s.projects[0] }); }, s => { s.trash.push({ data: { projects: [{ id: 'p' }] } }); }, ...['archived', 'archivedAt', 'deleted', 'deletedAt', 'hidden', 'hiddenAt', 'tombstone', 'wikiFileError', 'private', 'ephemeral', 'incognito'].map(flag => s => { s.projects[0][flag] = true; }), ...['deleted', 'archived', 'hidden'].map(status => s => { s.projects[0].status = status; })];
  for (const mutate of mutations) {
    const state = fixture(); mutate(state);
    for (const value of [project, agent, document, { view: 'task', id: 't' }]) {
      const result = Origin.resolve(state, value); assert.equal(result.available, false); assert.equal(result.label, '原入口不可用'); assert.equal(result.caption, '');
    }
    assert.equal(Origin.capture(state, { view: 'project' }), null);
  }
});
test('conversation missing, duplicate, retired and private states are unavailable', () => {
  for (const mutate of [s => { s.conversations = []; }, s => { s.conversations.push({ ...s.conversations[0] }); }, s => { s.trash.push({ data: { conversations: [{ id: 'c' }] } }); }, ...['private', 'ephemeral', 'incognito', 'deletedAt', 'archivedAt'].map(flag => s => { s.conversations[0][flag] = true; })]) {
    const state = fixture(); mutate(state); assert.equal(Origin.resolve(state, agent).available, false); assert.equal(Origin.capture(state, { view: 'agent' }), null);
  }
});
test('a missing, deleted, private, duplicate or foreign message downgrades only the anchor', () => {
  for (const mutate of [s => { s.conversations[0].messages = []; }, s => { s.conversations[0].messages[0].deletedAt = 1; }, s => { s.conversations[0].messages[0].private = true; }, s => { s.conversations[0].messages.push({ id: 'm' }); }, s => { s.conversations.push({ id: 'other', messages: s.conversations[0].messages }); s.conversations[0].messages = []; }]) {
    const state = fixture(); mutate(state); const result = Origin.resolve(state, agent);
    assert.equal(result.available, true); assert.deepEqual(result.origin, { view: 'agent', conversationId: 'c' }); assert.equal(result.label, '返回对话');
  }
});
test('independent conversations keep their own workspace and never inherit background project', () => {
  const state = fixture(); delete state.conversations[0].projectId; state.conversations[0].workspace = 'daily';
  assert.equal(Origin.resolve(state, agent).caption, '日常空间 / 资料讨论');
});
test('global routes have live fixed labels and only real space sections', () => {
  const cases = [
    [{ view: 'daily', section: 'knowledge' }, '返回资料', '日常空间 / 资料'],
    [{ view: 'courses', section: 'tasks' }, '返回任务', '课程空间 / 任务'],
    [{ view: 'research', section: 'papers' }, '返回文献', '科研空间 / 文献'],
    [{ view: 'wiki' }, '返回科研 Wiki', '科研 Wiki'], [{ view: 'captures' }, '返回随记', '随记'], [{ view: 'dashboard' }, '返回总览', '总览'], [{ view: 'history' }, '返回执行历史', '执行历史'],
    [{ view: 'overview' }, '返回总览', '总览'], [{ view: 'conversations' }, '返回全部对话', '全部对话'], [{ view: 'agenda' }, '返回日程', '日程']
  ];
  for (const [origin, label, caption] of cases) assert.deepEqual(Origin.resolve({}, origin), { origin, label, caption, available: true });
});
test('document and task access use exact typed identity and live record names', () => {
  const state = fixture(); state.imports[0].id = 'n';
  assert.equal(Origin.resolve(state, document).caption, '科研空间 / 研究项目 / 研究笔记');
  assert.equal(Origin.resolve(state, { view: 'document', kind: 'import', id: 'n' }).caption, '科研空间 / 研究项目 / 材料.pdf');
  assert.deepEqual(Origin.resolve(state, { view: 'task', id: 't' }), { origin: { view: 'task', id: 't' }, label: '返回任务', caption: '科研空间 / 研究项目 / 核对资料', available: true });
  for (const [collection, origin] of [['notes', document], ['imports', { view: 'document', kind: 'import', id: 'n' }], ['tasks', { view: 'task', id: 't' }]]) {
    const copy = structuredClone(state); copy[collection].push({ ...copy[collection][0] }); assert.equal(Origin.resolve(copy, origin).available, false);
    copy[collection] = []; assert.equal(Origin.resolve(copy, origin).available, false);
  }
});
test('host getDocument is an additional access gate and cannot grant another identity', () => {
  const state = fixture(); let args;
  assert.equal(Origin.resolve(state, document, { getDocument: (...value) => { args = value; return state.notes[0]; } }).available, true); assert.deepEqual(args, ['note', 'n']);
  for (const getDocument of [() => null, () => false, () => ({ id: 'other' }), () => ({ id: 'n', private: true }), () => Promise.resolve(state.notes[0]), () => { throw Error('revoked'); }]) assert.equal(Origin.resolve(state, document, { getDocument }).available, false);
  state.notes[0].deletedAt = 1; assert.equal(Origin.resolve(state, document, { getDocument: () => ({ id: 'n' }) }).available, false);
});
test('private ancestry follows current and retired owners even after a document moves', () => {
  const state = fixture(); state.notes[0].projectId = 'q'; state.notes[0].provenance = { origin: { runId: 'secret' } };
  state.trash.push({ data: { agentRuns: [{ id: 'secret', sourceConversationId: 'secret-chat' }], conversations: [{ id: 'secret-chat', private: true }] } });
  assert.equal(Origin.resolve(state, document).available, false);
});
test('review entry requires exact run, live origin conversation, actual changes and host permission', () => {
  for (const kind of ['review', 'local-review']) {
    const state = fixture(), origin = { view: 'document', kind, id: 'r' };
    assert.equal(Origin.resolve(state, origin).available, true);
    assert.equal(Origin.resolve(state, origin, { getDocument: () => ({ id: 'r', run: state.agentRuns[0] }) }).available, true);
    state.conversations[0].private = true; assert.equal(Origin.resolve(state, origin).available, false); delete state.conversations[0].private;
    state.agentRuns[0][kind === 'review' ? 'fileChanges' : 'localFileEdits'] = []; assert.equal(Origin.resolve(state, origin).available, false);
  }
});
test('local document identity requires host authorization and exact project/root/path', () => {
  const state = fixture(), id = JSON.stringify(['p', 'folder', 'docs/readme.md']), origin = { view: 'document', kind: 'local-file', id };
  const ref = { id, projectId: 'p', candidateId: 'folder', path: 'docs/readme.md' };
  assert.equal(Origin.resolve(state, origin).available, false);
  assert.equal(Origin.resolve(state, origin, { getDocument: () => ref }).caption, '科研空间 / 研究项目 / docs/readme.md');
  for (const override of [{ id: 'other' }, { projectId: 'q' }, { candidateId: 'other' }, { path: 'other.md' }, { private: true }]) assert.equal(Origin.resolve(state, origin, { getDocument: () => ({ ...ref, ...override }) }).available, false);
  for (const path of ['../outside.md', '/outside.md', 'docs/../outside.md', 'docs\\bad.md', 'docs//bad.md', 'docs/./bad.md']) {
    const bad = { ...ref, id: JSON.stringify(['p', 'folder', path]), path }; assert.equal(Origin.resolve(state, { ...origin, id: bad.id }, { getDocument: () => bad }).available, false);
  }
  state.projects[0].localFolder.id = 'new'; assert.equal(Origin.resolve(state, origin, { getDocument: () => ({ ...ref, disconnected: true }) }).available, true, 'root authorizes readonly recovery without granting disk access');
  state.projects[0].private = true; assert.equal(Origin.resolve(state, origin, { getDocument: () => ref }).available, false);
});
test('body, message text, stored titles, URLs and DOM are never consulted or copied', () => {
  const state = fixture();
  for (const record of [...state.notes, ...state.imports, ...state.tasks, ...state.agentRuns, ...state.conversations[0].messages]) for (const name of ['content', 'text', 'body', 'url']) Object.defineProperty(record, name, { get() { throw Error('Sensitive field read'); } });
  const extra = { ...agent }; for (const name of ['title', 'body', 'url']) Object.defineProperty(extra, name, { get() { throw Error('Untrusted field read'); } });
  assert.deepEqual(Origin.clean(extra), agent); assert.equal(Origin.resolve(state, extra).available, true); assert.equal(Origin.resolve(state, document).available, true);
  assert.doesNotMatch(JSON.stringify(Origin.capture(state, { view: 'agent', messageId: 'm' })), /title|content|text|url/);
});
