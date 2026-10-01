const test = require('node:test');
const assert = require('node:assert/strict');
global.AgentProgress = require('../app/agent-progress');
const Conversation = require('../app/halaska-conversation');

test('activity summaries derive tool title and measured cost without modifying full output', () => {
  const item = { id: 'read-1', kind: 'tool', name: 'read_page', status: 'completed', at: 1000, updatedAt: 64500, text: '完整原文\n'.repeat(800) };
  const original = JSON.stringify(item);
  assert.deepEqual(Conversation.activityProps(item, { live: false }), {
    title: 'read_page', status: 'completed', active: false, elapsed: '1 分 3 秒', kindLabel: '工具', statusLabel: '已完成',
  });
  assert.equal(JSON.stringify(item), original);
});

test('animation requires both a live message and a recorded running activity', () => {
  assert.equal(Conversation.activityProps({ kind: 'summary', status: 'running' }, { live: true }).active, true);
  for (const status of ['completed', 'done', 'failed', 'cancelled', 'pending', 'awaiting-approval', 'awaiting-save', 'rejected', 'unknown']) {
    const props = Conversation.activityProps({ kind: 'tool', status }, { live: true });
    assert.equal(props.active, false, status);
    assert.equal(props.status, status);
  }
  const stale = Conversation.activityProps({ kind: 'tool', status: 'running' }, { live: false });
  assert.equal(stale.active, false);
  assert.equal(stale.status, 'running');
  assert.equal(stale.statusLabel, '未确认结束');
});

test('missing or unsupported activity state does not become completed', () => {
  for (const status of [undefined, '', 'unexpected', '__proto__']) {
    const props = Conversation.activityProps({ status });
    assert.equal(props.status, 'unknown');
    assert.equal(props.statusLabel, '未确认');
    assert.equal(props.active, false);
  }
});

test('cost is absent without a valid recorded interval', () => {
  for (const item of [{}, { at: 10 }, { at: 0, updatedAt: 10 }, { at: 20, updatedAt: 10 }, { at: 'not-a-time', updatedAt: 10 }, { at: 10, updatedAt: Infinity }]) {
    assert.equal(Conversation.activityProps(item).elapsed, '');
  }
});

test('long stage titles are preserved and rendering remains text rather than markup', () => {
  const text = '<script>not markup</script> ' + '公开活动记录'.repeat(500);
  const props = Conversation.activityProps({ kind: 'step', text, status: 'pending' });
  assert.equal(props.title, text);
  assert.equal(props.statusLabel, '待执行');
});

test('group summary retains failed aggregate and exact owner-provided breakdown', () => {
  const props = Conversation.groupProps({ groupName: 'read_page', groupCount: '20', groupStatus: 'failed', groupDuration: '4800' }, { live: true }, '18 已完成 · 2 失败');
  assert.equal(props.title, 'read_page');
  assert.equal(props.countLabel, '20 次');
  assert.equal(props.statusLabel, '失败');
  assert.equal(props.detail, '18 已完成 · 2 失败');
  assert.equal(props.elapsed, '4 秒');
  assert.equal(props.active, false);
});

test('group summaries do not fabricate counts, measured durations or completion', () => {
  for (const value of ['', 'NaN', '-1', 'Infinity']) {
    const props = Conversation.groupProps({ groupCount: value, groupDuration: value });
    assert.equal(props.countLabel, '');
    assert.equal(props.elapsed, '');
    assert.equal(props.status, 'unknown');
    assert.equal(props.statusLabel, '未确认');
  }
  assert.equal(Conversation.groupProps({ groupCount: '2.5' }).countLabel, '');
});

test('row and group labels follow current app language without translating source names', () => {
  global.WorkstationI18n = { getLanguage: () => 'en' };
  try {
    const row = Conversation.activityProps({ kind: 'tool', name: '读取用户资料', status: 'rejected' });
    assert.equal(row.title, '读取用户资料');
    assert.equal(row.statusLabel, 'Declined');
    assert.equal(row.kindLabel, 'Tool');
    const group = Conversation.groupProps({ groupCount: '3', groupStatus: 'cancelled' });
    assert.equal(group.countLabel, '3 calls');
    assert.equal(group.statusLabel, 'Stopped');
    assert.equal(group.kindLabel, 'Tool group');
  } finally {
    delete global.WorkstationI18n;
  }
});
