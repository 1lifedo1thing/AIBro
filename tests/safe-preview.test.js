'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 大回复安全预览的纯逻辑：阈值判定、如实描述、纯文本截断。
const Safe = require(path.join(__dirname, '../app/safe-preview.js'));

test('needsPreview 只在超过阈值时为真', () => {
  assert.equal(Safe.needsPreview(''), false);
  assert.equal(Safe.needsPreview('普通回复'), false);
  assert.equal(Safe.needsPreview('x'.repeat(12000)), false, '恰好等于阈值不算超限');
  assert.equal(Safe.needsPreview('x'.repeat(12001)), true);
  assert.equal(Safe.needsPreview(null), false);
});

test('describe 如实给出总量、展示量与未渲染量', () => {
  const info = Safe.describe('x'.repeat(20000));
  assert.equal(info.total, 20000);
  assert.equal(info.shown, 4000);
  assert.equal(info.hidden, 16000);
  assert.equal(info.shown + info.hidden, info.total, '展示 + 未渲染必须等于总量');
});

test('describe 对短文本不虚报未渲染量', () => {
  const info = Safe.describe('短回复');
  assert.equal(info.total, 3);
  assert.equal(info.hidden, 0);
});

test('plainPreview 返回有界的纯文本（不解析任何 Markdown）', () => {
  const text = '# 标题\n**粗体**\n' + 'x'.repeat(9000);
  const shown = Safe.plainPreview(text);
  assert.equal(shown.length, 4000);
  assert.ok(shown.startsWith('# 标题'), '原文照录，不做任何转换');
  assert.ok(shown.includes('**粗体**'), 'Markdown 记号原样保留——预览是纯文本，不是渲染结果');
});

test('noticeText 明确说明还有多少字符未渲染——不假装等于完整内容', () => {
  const notice = Safe.noticeText(Safe.describe('x'.repeat(20000)));
  assert.match(notice, /20000|20,000/, '应说明总量');
  assert.match(notice, /4000|4,000/, '应说明已展示量');
  assert.match(notice, /16000|16,000/, '应说明未渲染量');
});

test('模块暴露的接入口齐全', () => {
  for (const name of ['init', 'mount', 'needsPreview', 'describe', 'plainPreview', 'noticeText']) {
    assert.equal(typeof Safe[name], 'function', `缺少 ${name}`);
  }
});
