const test = require('node:test');
const assert = require('node:assert/strict');
global.AgentProgress = require('../app/agent-progress');
const Conversation = require('../app/halaska-conversation');
global.RunCheckpoint = require('../app/run-checkpoint');

test('saved summary requires a valid committed receipt and a settled successful run', () => {
  for (const status of ['completed', 'completed-local', 'done']) {
    const props = Conversation.summaryProps({role:'agent'}, { status, executionReceipt: { version: 1, phase: 'committed' } });
    assert.equal(props.label, '结果已保存');
  }
  for (const receipt of [undefined, {version:1,phase:'applied'}, {version:1,phase:'prepared'}, {version:2,phase:'committed'}]) {
    assert.notEqual(Conversation.summaryProps({role:'agent'}, { status:'completed', executionReceipt:receipt }).label, '结果已保存');
  }
  for (const status of ['running', 'failed', 'cancelled', 'awaiting-save', 'awaiting-approval']) {
    assert.notEqual(Conversation.summaryProps({role:'agent'}, { status, executionReceipt:{version:1,phase:'committed'} }).label, '结果已保存');
  }
  assert.notEqual(Conversation.summaryProps({role:'agent',live:true}, { status:'completed', executionReceipt:{version:1,phase:'committed'} }).label, '结果已保存');
});

test('lifecycle summary uses actual phase, latest public content and measured timestamps', () => {
  const message = { role: 'agent', live: true, at: 1000, activities: [
    { id: 'summary', kind: 'summary', text: '第一段\n完整公开摘要', status: 'completed', at: 1000 },
    { id: 'tool', kind: 'tool', name: '读取项目文件', text: '/notes/plan.md', status: 'running', at: 2000 },
  ] };
  const props = Conversation.summaryProps(message, { status: 'running', startedAt: 1000 });
  assert.equal(props.status, 'running'); assert.equal(props.phase, 'tool');
  assert.equal(props.detail, '读取项目文件'); assert.equal(props.count, '2 项活动');
  assert.equal(message.activities[0].text, '第一段\n完整公开摘要');
});

test('unknown history does not become completed and explicit failed/cancelled/approval states remain truthful', () => {
  for (const [status, label] of [['failed', '执行失败'], ['cancelled', '已停止'], ['awaiting-approval', '等待审批'], ['rejected', '已拒绝']]) {
    const props = Conversation.summaryProps({ role: 'agent', at: 2000 }, { status, startedAt: 2000, finishedAt: 62000 });
    assert.equal(props.label, label); assert.equal(props.detail, ''); assert.equal(props.elapsed, '1 分 0 秒');
  }
  const old = Conversation.summaryProps({ role: 'agent' });
  assert.equal(old.status, 'unknown'); assert.equal(old.label, '执行记录'); assert.equal(old.elapsed, '');
});

test('full last-line summary is retained rather than clipped at an arbitrary character count', () => {
  const line = '一段公开过程说明'.repeat(400);
  const props = Conversation.summaryProps({ live: true, activities: [{ id: 'one', kind: 'summary', text: '前文\n' + line, status: 'running' }] });
  assert.equal(props.detail, line); assert.equal(props.phase, 'thinking');
});

test('language selection uses current app locale and no event means waiting rather than fabricated activity', () => {
  global.WorkstationI18n = { getLanguage: () => 'en' };
  const props = Conversation.summaryProps({ live: true, activities: [] });
  assert.equal(props.label, 'Waiting'); assert.equal(props.count, '0 activities'); assert.equal(props.detail, '');
  delete global.WorkstationI18n;
});
