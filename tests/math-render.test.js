'use strict';
/* 数学渲染（§3 的 LaTeX）：支持有限但明确——**不认识的命令原样显示**（不假渲染），
   内容一律转义，渲染永远终止。 */
const test = require('node:test');
const assert = require('node:assert/strict');

const MathRender = require('../app/math-render.js');

test('基础符号：希腊字母、运算符、大运算符', () => {
  assert.match(MathRender.inlineMath('\\alpha'), /α/);
  assert.match(MathRender.inlineMath('\\Omega'), /Ω/);
  assert.match(MathRender.inlineMath('a \\le b'), /≤/);
  assert.match(MathRender.inlineMath('x \\to y'), /→/);
  assert.match(MathRender.inlineMath('\\sum_{i=1}^{n}'), /∑/);
  assert.match(MathRender.inlineMath('\\int_0^1'), /∫/);
});

test('上下标：花括号与单字符两种写法', () => {
  assert.match(MathRender.inlineMath('x^{2}'), /x<sup>2<\/sup>/);
  assert.match(MathRender.inlineMath('a_i'), /a<sub>i<\/sub>/);
  assert.match(MathRender.inlineMath('x_{ij}^{2}'), /x<sub>ij<\/sub><sup>2<\/sup>/);
});

test('分式与根号（含嵌套）', () => {
  const frac = MathRender.inlineMath('\\frac{a}{b}');
  assert.match(frac, /math-frac/);
  assert.match(frac, /math-num">a</);
  assert.match(frac, /math-den">b</);
  const nested = MathRender.inlineMath('\\frac{\\frac{a}{b}}{c}');
  assert.equal((nested.match(/math-frac/g) || []).length, 2, '嵌套分式应有两个分式节点');
  const sqrt = MathRender.inlineMath('\\sqrt{x+1}');
  assert.match(sqrt, /math-sqrt/);
  assert.match(sqrt, /√/);
  const order = MathRender.inlineMath('\\sqrt[3]{x}');
  assert.match(order, /math-root-order[^>]*>3</, 'n 次根应显示次数');
});

test('\\text{} 与函数名用正体；未知命令原样显示（不假装渲染）', () => {
  assert.match(MathRender.inlineMath('\\text{当且仅当}'), /math-text[^>]*>当且仅当</);
  assert.match(MathRender.inlineMath('\\sin x'), /math-upright">sin</);
  const unknown = MathRender.inlineMath('\\foobar{x}');
  assert.match(unknown, /\\foobar/, '不认识的命令必须原样出现');
  const env = MathRender.inlineMath('\\begin{matrix}a&b\\end{matrix}');
  assert.match(env, /\\begin/, '不支持的环境原样显示');
});

test('安全：内容一律转义，不产生可执行标记', () => {
  const html = MathRender.inlineMath('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(MathRender.inlineMath('<script>alert(1)</script>'), /<script/i);
});

test('空输入返回 null（调用方据此保持原样文本）', () => {
  assert.equal(MathRender.inlineMath(''), null);
  assert.equal(MathRender.inlineMath('   '), null);
  assert.equal(MathRender.inlineMath(null), null);
  assert.equal(MathRender.blockMath('  '), null);
});

test('块级：\\ 换行会拆成多行；整体是可居中的块', () => {
  const block = MathRender.blockMath('a = b \\\\ c = d');
  assert.match(block, /math-block/);
  assert.equal((block.match(/math-line/g) || []).length, 2, '两行公式');
  assert.match(block, /a = b/);
  assert.match(block, /c = d/);
});

test('终止性：深嵌套与畸形输入都能返回', () => {
  const nasty = ['{'.repeat(40), '\\frac{'.repeat(20), '^'.repeat(30), '_'.repeat(30), '\\sqrt['.repeat(10), '~'.repeat(30)];
  for (const input of nasty) {
    const html = MathRender.inlineMath(input);
    assert.ok(html === null || typeof html === 'string', '必须返回字符串或 null');
  }
});

test('aria-label 保留原始 TeX（便于核对渲染是否忠实）', () => {
  const html = MathRender.inlineMath('\\frac{a}{b}');
  assert.match(html, /aria-label="\\frac\{a\}\{b\}"/, 'aria-label 应含原始写法');
});
