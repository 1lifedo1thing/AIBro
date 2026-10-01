const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Org = require('../app/conversation-organization');
const chat = (id, extra = {}) => ({ id, title: id, workspace: '科研', createdAt: 10, updatedAt: 20, messages: [{ id: `${id}-u`, role: 'user', text: `请协助处理 ${id}` }], ...extra });
const workspace = conversations => ({ conversations, projects: [{ id: 'p', name: '机器学习课程', workspace: '课程' }], folders: { conversations: [], projects: [{ id: 'pf' }] }, notes: [{ id: 'n', content: 'leave this untouched' }], settings: { model: 'model' }, currentConversationId: conversations[0]?.id });
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }
const groupFixture = () => workspace([chat('c1', { projectId: 'p', workspace: '课程', title: '优化器学习' }), chat('c2', { projectId: 'p', workspace: '课程', title: '梯度下降作业' }), chat('unrelated', { title: '晚餐菜单' })]);

test('same-project recommendation explains real ownership, never modifies state before approval', () => {
  const state = deepFreeze(groupFixture()), before = JSON.stringify(state);
  const recs = Org.recommend(state);
  assert.equal(recs.length, 1); assert.equal(recs[0].kind, 'project'); assert.equal(recs[0].proposedName, '机器学习课程');
  assert.deepEqual(recs[0].conversationIds, ['c1', 'c2']); assert.deepEqual(recs[0].evidence, { projectId: 'p' });
  assert.match(recs[0].reason, /属于/); assert.equal(JSON.stringify(state), before);
});

test('approval creates only a folder membership, preserving project, workspace, transcript, notes and current chat', () => {
  const state = deepFreeze(groupFixture()), rec = Org.recommend(state)[0];
  const changed = Org.apply(state, { action: 'approve', recommendation: rec, name: '课程复习' }, { now: 100, makeId: () => 'new-folder' });
  assert.equal(state.folders.conversations.length, 0); assert.equal(changed.folders.conversations[0].name, '课程复习');
  assert.equal(changed.folders.conversations[0].projectId, 'p');
  for (const original of state.conversations.slice(0, 2)) {
    const next = changed.conversations.find(item => item.id === original.id);
    assert.equal(next.folderId, 'new-folder'); assert.equal(next.messages, original.messages); assert.equal(next.workspace, original.workspace);
    assert.equal(next.projectId, original.projectId); assert.equal(next.updatedAt, original.updatedAt);
  }
  assert.equal(changed.conversations[2], state.conversations[2]); assert.equal(changed.notes, state.notes);
  assert.equal(changed.settings, state.settings); assert.equal(changed.currentConversationId, state.currentConversationId);
  assert.deepEqual(Org.recommend(changed), []);
});

test('Chinese and English topical matching has concrete shared terms; generic chat requests do not group', () => {
  const state = workspace([
    chat('zh1', { title: '签证面试材料准备', messages: [{ role: 'user', text: '签证面试需要准备哪些资金证明和材料？' }] }),
    chat('zh2', { title: '签证面试问题', messages: [{ role: 'user', text: '请检查签证面试所需资金证明，准备回答。' }] }),
    chat('en1', { title: 'React hydration debugging', messages: [{ role: 'user', text: 'React hydration mismatch causes layout to flicker.' }] }),
    chat('en2', { title: 'React hydration mismatch', messages: [{ role: 'user', text: 'Investigate React hydration server render mismatch.' }] }),
    chat('generic1', { title: '新对话', messages: [{ role: 'user', text: '帮我修改这个项目的代码。' }] }),
    chat('generic2', { title: '新对话', messages: [{ role: 'user', text: '帮我分析这个项目的代码。' }] }),
  ]);
  const recs = Org.recommend(state);
  assert.equal(recs.length, 2); assert.ok(recs.some(rec => rec.conversationIds.join() === 'zh1,zh2'));
  assert.ok(recs.some(rec => rec.conversationIds.join() === 'en1,en2'));
  recs.forEach(rec => { assert.ok(rec.evidence.terms.length >= 2); assert.match(rec.reason, /共同出现/); assert.ok(!rec.conversationIds.some(id => id.startsWith('generic'))); });
});

test('never groups explicit different projects or disjoint workspaces just because titles overlap', () => {
  const state = workspace([chat('a', { title: 'React hydration mismatch', projectId: 'project-a' }), chat('b', { title: 'React hydration mismatch', projectId: 'project-b' }), chat('c', { title: 'React hydration mismatch', workspace: '日常' })]);
  assert.deepEqual(Org.recommend(state), []);
});

test('private, archived, deleted and manually grouped conversations are excluded; no cross-source assistant boilerplate grouping', () => {
  const state = workspace([chat('normal'), chat('private', { ephemeral: true, projectId: 'p' }), chat('archived', { status: 'archived', projectId: 'p' }), chat('gone', { deleted: true, projectId: 'p' }), chat('manual', { folderId: 'manual', projectId: 'p' }), chat('other', { messages: [{ role: 'assistant', text: 'React hydration mismatch React hydration mismatch' }] })]);
  state.folders.conversations.push({ id: 'manual', name: '我的文件夹' });
  assert.deepEqual(Org.recommend(state), []);
  assert.throws(() => Org.apply(state, { action: 'move', conversationIds: ['private'], folderId: 'manual' }), /不可用/);
});

test('new same-project chat is recommended into existing homogeneous project folder without moving existing members', () => {
  const state = groupFixture(); state.folders.conversations.push({ id: 'f', name: '手动整理的课程' }); state.conversations[0].folderId = 'f';
  const rec = Org.recommend(state)[0]; assert.deepEqual(rec.conversationIds, ['c2']); assert.equal(rec.folderId, 'f'); assert.equal(rec.proposedName, '手动整理的课程');
  const next = Org.apply(state, { action: 'approve', recommendation: rec });
  assert.equal(next.folders.conversations.length, 1); assert.equal(next.conversations[0], state.conversations[0]); assert.equal(next.conversations[1].folderId, 'f');
});

test('ignored unchanged membership stays ignored after restart, new member produces a new reviewable group', () => {
  const state = groupFixture(), rec = Org.recommend(state)[0];
  const ignored = Org.apply(state, { action: 'dismiss', recommendation: rec }, { now: 90 });
  assert.equal(state.conversationOrganization, undefined); assert.deepEqual(Org.recommend(JSON.parse(JSON.stringify(ignored))), []);
  ignored.conversations = [...ignored.conversations, chat('c3', { projectId: 'p', workspace: '课程' })];
  const again = Org.recommend(ignored); assert.equal(again.length, 1); assert.notEqual(again[0].fingerprint, rec.fingerprint);
});

test('approve rejects stale folder, project, deleted member and transcript changes atomically', () => {
  for (const change of [s => { s.conversations[0].folderId = 'm'; s.folders.conversations.push({ id: 'm', name: 'Manual' }); }, s => { s.conversations[0].projectId = 'q'; }, s => { s.conversations[0].deletedAt = 1; }, s => { s.conversations[0].messages.push({ id: 'new', role: 'user', text: 'Actually a different task now' }); }]) {
    const state = groupFixture(), rec = Org.recommend(state)[0]; change(state); const before = JSON.stringify(state);
    assert.throws(() => Org.apply(state, { action: 'approve', recommendation: rec }), /变化/);
    assert.equal(JSON.stringify(state), before);
  }
});

test('approval allows edited member subset and folder name, but not unreviewed or a singleton new group', () => {
  const state = groupFixture(); state.conversations.push(chat('c3', { projectId: 'p', workspace: '课程' }));
  const rec = Org.recommend(state)[0];
  const next = Org.apply(state, { action: 'approve', recommendation: rec, conversationIds: ['c1', 'c3'], name: 'Custom' }, { makeId: () => 'f' });
  assert.equal(next.conversations[0].folderId, 'f'); assert.equal(next.conversations[1].folderId, undefined); assert.equal(next.conversations[3].folderId, 'f');
  assert.throws(() => Org.apply(state, { action: 'approve', recommendation: rec, conversationIds: ['c1'] }), /至少选择两条/);
  assert.throws(() => Org.apply(state, { action: 'approve', recommendation: rec, conversationIds: ['c1', 'unrelated'] }), /不属于/);
});

test('manual folder creation, rename and dragging move preserve transcript and accept explicit ungrouping', () => {
  const state = deepFreeze(groupFixture());
  let next = Org.apply(state, { action: 'createFolder', name: '  My folder  ' }, { now: 100, makeId: () => 'f' });
  next = Org.apply(next, { action: 'move', conversationId: 'c1', folderId: 'f' });
  assert.equal(next.conversations[0].folderId, 'f'); assert.equal(next.conversations[0].messages, state.conversations[0].messages);
  next = Org.apply(next, { action: 'renameFolder', id: 'f', name: 'Renamed' }); assert.equal(next.folders.conversations[0].name, 'Renamed');
  next = Org.apply(next, { action: 'move', conversationIds: ['c1'], folderId: null }); assert.equal(next.conversations[0].folderId, null);
  assert.throws(() => Org.apply(next, { action: 'move', conversationIds: ['c1', 'missing'], folderId: 'f' }), /不可用/);
  assert.throws(() => Org.apply(next, { action: 'createFolder', name: ' renamed ' }), /同名/);
  assert.throws(() => Org.apply(next, { action: 'createFolder', name: ' ' }), /填写/);
  assert.throws(() => Org.apply(next, { action: 'createFolder', name: 'new' }, { makeId: () => 'f' }), /冲突/);
});

test('pins preserve favorite compatibility and order by real recent activity; unpin does not bump activity', () => {
  const state = workspace([chat('old', { updatedAt: 50 }), chat('recent', { updatedAt: 100 }), chat('legacy', { favorite: true, updatedAt: 75 })]);
  assert.deepEqual(Org.sort(state.conversations).map(x => x.id), ['legacy', 'recent', 'old']);
  const pinned = Org.apply(state, { action: 'pin', conversationId: 'old', pinned: true }, { now: 999 });
  assert.equal(pinned.conversations[0].favorite, true); assert.equal(pinned.conversations[0].pinnedAt, 999); assert.equal(pinned.conversations[0].updatedAt, 50);
  assert.deepEqual(Org.sort(pinned.conversations).map(x => x.id), ['legacy', 'old', 'recent']);
  const unpinned = Org.apply(pinned, { action: 'pin', conversationId: 'old', pinned: false });
  assert.equal(Org.isPinned(unpinned.conversations[0]), false); assert.equal(unpinned.conversations[0].messages, state.conversations[0].messages);
  assert.deepEqual(Org.sort(unpinned.conversations).map(x => x.id), ['legacy', 'recent', 'old']);
  assert.deepEqual(Org.sort([chat('iso', { updatedAt: '2026-09-24T01:00:00Z' }), chat('numeric', { updatedAt: 2 })]).map(x => x.id), ['iso', 'numeric']);
});

test('summary extracts latest actual request and public answer, excludes reasoning/tools/code, identifies original message IDs', () => {
  const conversation = chat('summary', { messages: [
    { id: 'u1', role: 'user', text: '初始目标是修复搜索体验。' },
    { id: 'a1', role: 'assistant', text: '旧答复不能替代新的需求。' },
    { id: 'u2', role: 'user', text: '请修复中文输入法在搜索中的组合输入问题。' },
    { id: 'reason', role: 'assistant', channel: 'analysis', text: 'Hidden chain of thought' },
    { id: 'tool', role: 'tool', text: 'Sensitive file tool output' },
    { id: 'a2', role: 'assistant', text: '<think>Private reasoning</think>\n## 修改\n已修复中文输入法组合输入，输入候选词时不会重复筛选。\n```js\nprivate_code\n```' },
    { id: 'deleted', role: 'assistant', text: 'Deleted answer', deletedAt: 1 },
  ] });
  const summary = Org.summarize(conversation);
  assert.match(summary.goal, /中文输入法/); assert.match(summary.outcome, /已修复/); assert.doesNotMatch(summary.text, /Hidden|Sensitive|Private|private_code|Deleted/);
  assert.deepEqual(summary.sourceMessageIds, ['u2', 'a2']); assert.equal(summary.messageCount, 4); assert.match(summary.text, /最近答复/);
});

test('summary never implies an earlier answer completed a later pending request; retains explicit failure wording', () => {
  const conversation = chat('pending', { messages: [{ id: 'u', role: 'user', text: '检查部署过程的完整性。' }, { id: 'a', role: 'assistant', text: '部署成功，服务已经正常启动。' }, { id: 'u2', role: 'user', text: '现在请回退这次部署并验证旧版本。' }, { id: 'live', role: 'assistant', text: '正在回退这个版本。', live: true }] });
  let summary = Org.summarize(conversation); assert.equal(summary.outcome, ''); assert.match(summary.text, /等待答复/); assert.doesNotMatch(summary.text, /部署成功/);
  conversation.messages.push({ id: 'failed', role: 'assistant', text: '回退失败，目标备份文件已经不存在。' });
  summary = Org.summarize(conversation, { language: 'en' }); assert.match(summary.text, /Latest reply/); assert.match(summary.outcome, /回退失败/);
});

test('summary supports content parts, long Unicode, empty and terse follow-up without inventing outcomes', () => {
  const c = chat('empty', { title: '未开始的对话', messages: [] }); assert.match(Org.summarize(c).text, /尚无消息/);
  c.messages = [{ id: 'm', role: 'user', content: [{ type: 'text', text: '帮我对比量子计算与经典计算架构的不同。'.repeat(80) }] }, { id: 'thanks', role: 'user', text: '谢谢' }];
  const summary = Org.summarize(c, { maxLength: 100 }); assert.ok(Array.from(summary.text).length <= 100); assert.match(summary.goal, /量子计算/); assert.deepEqual(summary.sourceMessageIds, ['m']);
});

test('complete-link clustering does not merge disjoint topics via a bridge conversation', () => {
  const state = workspace([
    chat('a', { title: 'React hydration browser rendering' }),
    chat('b', { title: 'React hydration browser rendering and visa interview funding' }),
    chat('c', { title: 'visa interview funding' }),
  ]);
  const recs = Org.recommend(state); assert.ok(recs.every(rec => !(rec.conversationIds.includes('a') && rec.conversationIds.includes('c'))));
});

test('browser export and Chinese fallback work without Intl.Segmenter', () => {
  const context = { Intl: {}, console }; vm.runInNewContext(fs.readFileSync(require.resolve('../app/conversation-organization'), 'utf8'), context);
  assert.equal(typeof context.ConversationOrganization.apply, 'function');
  const recs = context.ConversationOrganization.recommend(workspace([chat('a', { title: '量子计算研究' }), chat('b', { title: '量子计算实验' })]));
  assert.equal(recs.length, 1);
});

test('durable commit remains pending until save finishes, rejects false, and never mutates the original', async () => {
  const original = deepFreeze(groupFixture()); let state = original, release;
  const save = new Promise(resolve => { release = resolve; });
  const promise = Org.commit({ getState: () => state, setState: value => { state = value; }, save: () => save, now: 500 }, { action: 'pin', conversationId: 'c1', pinned: true });
  assert.equal(state.conversations[0].favorite, true); assert.equal(original.conversations[0].favorite, undefined);
  let done = false; promise.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
  release(true); await promise; assert.equal(done, true); assert.equal(state.conversations[0].favorite, true);
  const pinned = state;
  await assert.rejects(Org.commit({ getState: () => state, setState: value => { state = value; }, save: async () => false }, { action: 'pin', conversationId: 'c1', pinned: false }), /保存未完成/);
  assert.equal(state.conversations[0].favorite, pinned.conversations[0].favorite); assert.equal(state.conversations[0].pinnedAt, pinned.conversations[0].pinnedAt);
});

test('failed save removes owned new folder but preserves concurrent transcript, rename, new notes and removed chat', async () => {
  let state = groupFixture(), reject;
  const rec = Org.recommend(state)[0], error = new Error('disk full');
  const promise = Org.commit({ getState: () => state, setState: value => { state = value; }, save: () => new Promise((_, fail) => { reject = fail; }), makeId: () => 'new-folder', now: 500 }, { action: 'approve', recommendation: rec });
  const laterMessages = [...state.conversations[0].messages, { id: 'later', role: 'user', text: 'A concurrent request' }];
  state = { ...state, notes: [...state.notes, { id: 'later-note' }], conversations: state.conversations.filter(chat => chat.id !== 'c2').map(chat => chat.id === 'c1' ? { ...chat, title: 'Later rename', messages: laterMessages } : chat) };
  reject(error); await assert.rejects(promise, actual => actual === error);
  assert.equal(state.conversations.find(chat => chat.id === 'c2'), undefined); assert.equal(state.conversations[0].title, 'Later rename');
  assert.equal(state.conversations[0].messages, laterMessages); assert.equal(state.conversations[0].folderId, undefined);
  assert.equal(state.folders.conversations.length, 0); assert.equal(state.notes[1].id, 'later-note');
});

test('failed save preserves later explicit move and keeps created folder used by another conversation', async () => {
  let state = groupFixture(), reject;
  state.folders.conversations.push({ id: 'manual', name: 'Manual' });
  const rec = Org.recommend(state)[0];
  const promise = Org.commit({ getState: () => state, setState: value => { state = value; }, save: () => new Promise((_, fail) => { reject = fail; }), makeId: () => 'new-folder', now: 500 }, { action: 'approve', recommendation: rec });
  state = Org.apply(state, { action: 'move', conversationId: 'c1', folderId: 'manual' }, { now: 501 });
  state = Org.apply(state, { action: 'move', conversationId: 'unrelated', folderId: 'new-folder' }, { now: 502 });
  reject(new Error('save failed')); await assert.rejects(promise, /save failed/);
  assert.equal(state.conversations[0].folderId, 'manual'); assert.equal(state.conversations[0].organizationUpdatedAt, 501);
  assert.equal(state.conversations[1].folderId, undefined); assert.equal(state.conversations[2].folderId, 'new-folder');
  assert.ok(state.folders.conversations.some(folder => folder.id === 'new-folder'));
});

test('failed pin and dismiss preserve newer choices and unrelated metadata', async () => {
  let state = groupFixture(), reject;
  const promise = Org.commit({ getState: () => state, setState: value => { state = value; }, save: () => new Promise((_, fail) => { reject = fail; }), now: 500 }, { action: 'pin', conversationId: 'c1', pinned: true });
  state = Org.apply(state, { action: 'pin', conversationId: 'c1', pinned: false }, { now: 501 });
  reject(new Error('offline')); await assert.rejects(promise, /offline/);
  assert.equal(state.conversations[0].favorite, false); assert.equal(state.conversations[0].organizationUpdatedAt, 501);
  const before = groupFixture(), after = Org.apply(before, { action: 'dismiss', recommendation: Org.recommend(before)[0] }, { now: 600 });
  const concurrent = { ...after, conversationOrganization: { ...after.conversationOrganization, custom: true, dismissed: [...after.conversationOrganization.dismissed, { fingerprint: 'other', at: 601 }] } };
  const restored = Org.rollbackOwned(before, after, concurrent);
  assert.deepEqual(restored.conversationOrganization, { custom: true, dismissed: [{ fingerprint: 'other', at: 601 }] });
});

test('a repeated specific title topic remains meaningful even when most conversations share it', () => {
  const state = workspace(Array.from({ length: 15 }, (_, index) => chat(`related-${index}`, { title: `React hydration debugging ${index}`, messages: [{ role: 'user', text: `Investigate hydration condition ${index}` }] })));
  const recs = Org.recommend(state); assert.equal(recs.length, 1); assert.equal(recs[0].conversationIds.length, 15); assert.ok(recs[0].evidence.terms.includes('hydration'));
});

test('real AIBro agent messages supply public answer and count, including retained planPreview after completion', () => {
  const conversation = chat('native-real-shape', { messages: [
    { id: 'user', role: 'user', text: '请修复资料搜索中的中文输入问题。', at: 100 },
    { id: 'agent', role: 'agent', text: '已修复中文输入，候选词确认后才应用搜索。', live: false, planPreview: true, runId: 'r1', runStatus: 'completed', steps: [{ text: 'Do not expose step details', status: 'done' }], activities: [{ kind: 'summary', text: 'Do not expose reasoning detail' }], at: 101 },
  ] });
  const summary = Org.summarize(conversation);
  assert.equal(summary.messageCount, 2); assert.match(summary.outcome, /已修复中文输入/); assert.deepEqual(summary.sourceMessageIds, ['user', 'agent']);
  assert.doesNotMatch(summary.text, /等待答复|Do not expose|step|reasoning/);
});

test('agent live plan, internal tool and reasoning content do not become a final answer', () => {
  const conversation = chat('native-live', { messages: [
    { id: 'user', role: 'user', text: '请重新检查资料搜索的组合输入行为。' },
    { id: 'live', role: 'agent', text: '{"actions":[{"type":"secret_pending_plan"}]}', live: true, planPreview: true, steps: [{ text: 'Tool detail' }] },
    { id: 'reasoning', role: 'agent', channel: 'reasoning', text: 'Private reasoning output' },
    { id: 'tool', role: 'agent', channel: 'tool', text: 'Private tool output' },
    { id: 'internal', role: 'agent', internal: true, text: 'Internal output' },
    { id: 'hidden', role: 'agent', hidden: true, text: 'Hidden output' },
  ] });
  const summary = Org.summarize(conversation);
  assert.equal(summary.messageCount, 2); assert.equal(summary.outcome, ''); assert.match(summary.text, /等待答复/);
  assert.doesNotMatch(summary.text, /secret_pending_plan|Private|Internal|Hidden|Tool detail/);
  conversation.messages[1] = { ...conversation.messages[1], live: false, runStatus: 'failed', text: '调用失败：同步服务暂时无法连接。', retryRunId: 'r1' };
  const failed = Org.summarize(conversation); assert.match(failed.outcome, /调用失败/); assert.doesNotMatch(failed.text, /secret_pending_plan/);
});
