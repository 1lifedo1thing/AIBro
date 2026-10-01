const test = require('node:test');
const assert = require('node:assert/strict');
const Clarify = require('../app/clarify-questions');

test('validate keeps question-shaped entries and drops incomplete ones', () => {
  const out = Clarify.validate([
    { id: 'q1', question: '计划哪天发布？', options: ['9月上旬', '9月中旬', '9月上旬'] },
    { question: '没有选项的问题' },
    { question: '只有一个选项', options: ['唯一'] },
    { question: '', options: ['a', 'b'] },
    null, 'x',
    { question: '可多选问题', options: ['A', 'B'], multiple: true },
  ]);
  assert.equal(out.length, 2, '只有“至少两个选项”的问题才成立');
  assert.deepEqual(out[0].options, ['9月上旬', '9月中旬'], '重复选项应去重');
  assert.equal(out[0].multiple, false);
  assert.equal(out[1].multiple, true);
  assert.ok(out[1].id, '缺失 id 时自动生成');
});

test('validate bounds question and option counts, and resolves id collisions', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 'same', question: `问题${i}`, options: ['a', 'b'] }));
  const out = Clarify.validate(many);
  assert.equal(out.length, 6, '最多 6 个问题');
  assert.equal(new Set(out.map(q => q.id)).size, 6, 'id 冲突要被消解');
  const wide = Clarify.validate([{ question: '很多选项', options: Array.from({ length: 12 }, (_, i) => `选项${i}`) }]);
  assert.equal(wide[0].options.length, 8, '每题最多 8 个选项');
  assert.deepEqual(Clarify.validate('not-array'), []);
  assert.deepEqual(Clarify.validate(undefined), []);
});

test('answerText quotes the original question and only accepts offered options', () => {
  const questions = Clarify.validate([
    { id: 'q1', question: '渠道？', options: ['官网', '社媒'], multiple: true },
    { id: 'q2', question: '日期？', options: ['上旬', '中旬'] },
  ]);
  assert.equal(Clarify.answerText(questions, {}), null, '没有选择时不产生消息');
  const text = Clarify.answerText(questions, { q1: ['官网', '伪造选项'], q2: ['中旬'] });
  assert.match(text, /渠道？ 官网/);
  assert.doesNotMatch(text, /伪造选项/, '未提供的选项不得进入回答');
  assert.match(text, /日期？ 中旬/);
});

test('markup renders live picks as buttons and escapes untrusted text', () => {
  const questions = Clarify.validate([{ id: 'q1', question: '<img src=x onerror=alert(1)>？', options: ['<b>A</b>', 'B'] }]);
  const html = Clarify.markup({ questions, draft: { q1: ['<b>A</b>'] } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<b>A<\/b>/);
  assert.match(html, /data-clarify-pick="q1"/);
  assert.match(html, /aria-pressed="true"/, '已选中的选项应带 aria-pressed=true');
  assert.match(html, /clarify-submit/);
  assert.match(html, /也可以直接在输入框里回答/, '必须保留“也可以直接回答”的出口');
});

test('submitted markup is read-only and shows exactly what was sent', () => {
  const questions = Clarify.validate([{ id: 'q1', question: '渠道？', options: ['官网', '社媒'] }]);
  const html = Clarify.markup({ questions, draft: { q1: ['社媒'] }, answers: { q1: ['官网'] }, submittedAt: 123 });
  assert.doesNotMatch(html, /data-clarify-pick/, '提交后不再有可点选项');
  assert.doesNotMatch(html, /clarify-submit/);
  assert.match(html, /已回答/);
  assert.match(html, /is-picked">官网/);
  assert.doesNotMatch(html, /is-picked">社媒/, '展示的是提交时发送的选择，而不是后来的草稿');
});
