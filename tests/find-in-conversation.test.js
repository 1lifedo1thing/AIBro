'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 页内查找的纯逻辑：匹配区间、计数、计数标签。
// 这些函数不触碰 DOM——DOM 部分由真实渲染器的冒烟验收覆盖。
const Find = require(path.join(__dirname, '../app/find-in-conversation.js'));

test('matchRanges 逐字面匹配并给出精确区间', () => {
  const hits = Find._pure.matchRanges('计划从本月开始，计划到下月结束', '计划');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { start: 0, end: 2 });
  assert.deepEqual(hits[1], { start: 8, end: 10 });
});

test('matchRanges 不区分大小写，但仍给出原文区间', () => {
  const hits = Find._pure.matchRanges('Agent 与 agent 都要能找到', 'AGENT');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].end - hits[0].start, 5);
});

test('matchRanges 空查询返回空结果——不把“没输入”当成“匹配全部”', () => {
  assert.deepEqual(Find._pure.matchRanges('任何文本', ''), []);
  assert.deepEqual(Find._pure.matchRanges('任何文本', null), []);
  assert.deepEqual(Find._pure.matchRanges('任何文本', '   '.trim()), []);
});

test('matchRanges 不重复计数重叠片段（逐段向前推进）', () => {
  const hits = Find._pure.matchRanges('aaaa', 'aa');
  assert.equal(hits.length, 2, '应命中两段且不重叠：0-2、2-4');
  assert.deepEqual(hits, [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test('countIn 跨多个文本节点累计', () => {
  assert.equal(Find._pure.countIn(['计划 A', '无关', '计划 B 与计划 C'], '计划'), 3);
  assert.equal(Find._pure.countIn([], '计划'), 0);
});

test('labelText 无命中时如实说明，而不是显示 0/0', () => {
  const empty = Find._pure.labelText(0, 0);
  assert.doesNotMatch(empty, /0/, '无命中时不应出现 0/0 这类空计数');
  assert.match(empty, /无匹配|No matches/);
});

test('labelText 命中时给出「第 X / 共 Y 个匹配」', () => {
  const label = Find._pure.labelText(2, 7);
  assert.match(label, /第 2 \/ 共 7 个匹配|2 of 7 matches/);
});

test('模块暴露的接入口齐全（供 app.js 与冒烟验收使用）', () => {
  for (const name of ['init', 'open', 'close', 'next', 'prev', 'stats', 'isOpen']) {
    assert.equal(typeof Find[name], 'function', `缺少 ${name}`);
  }
});
