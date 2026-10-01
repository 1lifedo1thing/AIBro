'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 会话内任务清单的纯逻辑：校验、合并、进度、显示条件。
const Tasks = require(path.join(__dirname, '../app/session-tasks.js'));

test('validate 接受字符串与对象两种条目形态', () => {
  const list = Tasks.validate([{ text: '读 package.json', done: false }, '写 run.md']);
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0], { text: '读 package.json', done: false });
  assert.deepEqual(list.items[1], { text: '写 run.md', done: false }, '字符串条目默认未完成');
});

test('validate 丢弃空文本与超长条目——不截断成半句', () => {
  const long = 'x'.repeat(201);
  const list = Tasks.validate(['', '   ', long, { text: '有效条目' }]);
  assert.deepEqual(list.items.map(item => item.text), ['有效条目']);
});

test('validate 最多 12 条；超出部分丢弃而不是无限增长', () => {
  const list = Tasks.validate(Array.from({ length: 20 }, (_, i) => `步骤 ${i}`));
  assert.equal(list.items.length, 12);
});

test('validate 对非数组输入返回 null——不猜、也不清空既有清单', () => {
  assert.equal(Tasks.validate(null), null);
  assert.equal(Tasks.validate(undefined), null);
  assert.equal(Tasks.validate('步骤一'), null);
  assert.equal(Tasks.validate({ nope: 1 }), null);
  assert.deepEqual(Tasks.validate({ items: ['步骤一'] }).items.map(i => i.text), ['步骤一']);
});

test('merge 按文本沿用勾选状态——只有同一条目才继承', () => {
  const previous = { items: [{ text: '读资料', done: true }, { text: '写结论', done: false }] };
  const next = Tasks.validate(['读资料', '写结论', '发出去']);
  const merged = Tasks.merge(previous, next);
  assert.equal(merged.items.find(item => item.text === '读资料').done, true, '同一条目沿用已完成');
  assert.equal(merged.items.find(item => item.text === '写结论').done, false);
  assert.equal(merged.items.find(item => item.text === '发出去').done, false, '新条目用自身状态');
});

test('merge 不改写条目文本——换了说法就是新条目', () => {
  const previous = { items: [{ text: '读取 package.json', done: true }] };
  const merged = Tasks.merge(previous, Tasks.validate(['读取 package.json 并总结 scripts']));
  assert.equal(merged.items[0].done, false, '文本不同不继承勾选——不猜“这条其实就是那条”');
});

test('Agent 后续轮次的完成信号推进同名任务，全部完成后收起清单', () => {
  const previous = Tasks.validate([{ text: '读取资料', done: false }, { text: '整理结论', done: false }]);
  const next = Tasks.validate([{ text: '读取资料', done: true }, { text: '整理结论', done: false }]);
  const advanced = Tasks.merge(previous, next);
  assert.deepEqual(Tasks.progress(advanced), { done: 1, total: 2 });
  assert.equal(Tasks.shouldShow(advanced), true);
  const completed = Tasks.merge(advanced, Tasks.validate([{ text: '读取资料', done: true }, { text: '整理结论', done: true }]));
  assert.deepEqual(Tasks.progress(completed), { done: 2, total: 2 });
  assert.equal(Tasks.shouldShow(completed), false);
  assert.equal(previous.items[0].done, false, '不改写旧轮次的状态对象');
  assert.equal(next.items[1].done, false, '不修改 Agent 的输入');
});

test('后续重述清单不能把已有完成状态退回待办', () => {
  const previous = { items: [{ text: '读取资料', done: true }, { text: '整理结论', done: true }] };
  const merged = Tasks.merge(previous, Tasks.validate([{ text: '读取资料', done: false }, '整理结论']));
  assert.deepEqual(Tasks.progress(merged), { done: 2, total: 2 });
});

test('merge 遇到 null 时保持既有清单不变', () => {
  const previous = { items: [{ text: 'a', done: true }] };
  assert.equal(Tasks.merge(previous, null), previous);
  assert.equal(Tasks.merge(null, null), null);
});

test('progress / describe / shouldShow 的语义', () => {
  const list = { items: [{ text: 'a', done: true }, { text: 'b', done: false }] };
  assert.deepEqual(Tasks.progress(list), { done: 1, total: 2 });
  assert.match(Tasks.describe(list), /1\/2/);
  assert.equal(Tasks.shouldShow(list), true, '未完成时显示');
  assert.equal(Tasks.shouldShow({ items: [{ text: 'a', done: true }] }), false, '全部完成时不再占据输入区上方');
  assert.equal(Tasks.shouldShow(null), false);
  assert.equal(Tasks.describe(null), '', '没有清单时不显示任何文案');
});

test('模块暴露的接入口齐全', () => {
  for (const name of ['init', 'render', 'validate', 'merge', 'progress', 'describe', 'shouldShow']) {
    assert.equal(typeof Tasks[name], 'function', `缺少 ${name}`);
  }
});
