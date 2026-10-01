'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 消息目录刻度的纯逻辑：聚合计划、摘要、标签、区间。
const Rail = require(path.join(__dirname, '../app/message-rail.js'));

test('消息少时不聚合：一条消息一个刻度', () => {
  assert.deepEqual(Rail._pure.plan(0), { ticks: 0, span: 1, aggregated: false });
  assert.deepEqual(Rail._pure.plan(1), { ticks: 1, span: 1, aggregated: false });
  assert.deepEqual(Rail._pure.plan(30), { ticks: 30, span: 1, aggregated: false });
});

test('消息多时聚合，且刻度数不超过上限', () => {
  const plan = Rail._pure.plan(100);
  assert.equal(plan.aggregated, true);
  assert.ok(plan.ticks <= Rail._pure.MAX_TICKS, `刻度数应不超过 ${Rail._pure.MAX_TICKS}，实际 ${plan.ticks}`);
  assert.ok(plan.span >= 2, '聚合格至少覆盖两条');
  const again = Rail._pure.plan(31);
  assert.equal(again.aggregated, true);
  assert.equal(again.span, 2, '31 条 → 每格 2 条');
});

test('聚合计刻能覆盖全部消息（不丢尾巴）', () => {
  for (const count of [31, 45, 100, 999]) {
    const plan = Rail._pure.plan(count);
    assert.ok(plan.ticks * plan.span >= count, `${count} 条：刻度 ${plan.ticks} × 跨度 ${plan.span} 应覆盖全部`);
  }
});

test('summarize 压平空白并截断，不产生换行', () => {
  assert.equal(Rail._pure.summarize('  多行\n文本\t内容  '), '多行 文本 内容');
  const long = Rail._pure.summarize('x'.repeat(100));
  assert.ok(long.length <= 43, `摘要应有界，实际 ${long.length}`);
  assert.ok(long.endsWith('…'));
});

test('labelFor 给出角色与时间，缺时间时只给角色', () => {
  assert.equal(Rail._pure.labelFor({ role: 'user' }), '你');
  assert.equal(Rail._pure.labelFor({ role: 'agent' }), 'AI');
  const withTime = Rail._pure.labelFor({ role: 'user', at: Date.parse('2026-09-23T10:30:00') });
  assert.match(withTime, /^你 · \d{2}:\d{2}$/);
});

test('rangeOf 给出刻度覆盖的消息区间', () => {
  assert.deepEqual(Rail._pure.rangeOf(0, 1), { start: 0, end: 1 });
  assert.deepEqual(Rail._pure.rangeOf(2, 5), { start: 10, end: 15 });
  assert.deepEqual(Rail._pure.rangeOf(0, 0), { start: 0, end: 1 }, '跨度非法时按 1 处理，不产生空区间');
});

test('模块暴露的接入口齐全', () => {
  for (const name of ['init', 'sync', 'build', 'stats']) assert.equal(typeof Rail[name], 'function', `缺少 ${name}`);
});
