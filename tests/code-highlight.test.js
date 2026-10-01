'use strict';
/* 代码高亮（§3/§5.3）：核心不变量是**内容逐字不变**（只加标记），
   以及"未知语言不猜测、未闭合不吞内容、扫描永远终止"。 */
const test = require('node:test');
const assert = require('node:assert/strict');

const CodeHighlight = require('../app/code-highlight.js');

// 去掉标记并还原实体：应等于原代码（内容守恒）。
const decoders = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const strip = html => String(html).replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, match => decoders[match]);

test('内容守恒：任何语言、任何输入，去标记后与原代码逐字相同', () => {
  const samples = [
    ['const x = 1 + 2; // 注释 "字符串"', 'js'],
    ['def f(x):\n    # 注释\n    return x ** 2', 'python'],
    ['SELECT * FROM t WHERE a = \'x\' -- 注释', 'sql'],
    ['<div class="a">text</div><!-- 注释 -->', 'html'],
    ['{"a": 1, "b": [true, null]}', 'json'],
    ['#!/bin/bash\necho "$HOME" # 注释', 'sh'],
    ['a = "未闭合', 'js'],
    ['/* 未闭合注释', 'js'],
    ['', 'js'],
    ['`模板 ${x} 字符串`', 'js'],
    ['π ≤ ∞ 中文注释 # mixed', 'python']
  ];
  for (const [code, lang] of samples) {
    const html = CodeHighlight.highlight(code, lang);
    assert.equal(typeof html, 'string', `${lang} 应返回字符串`);
    assert.equal(strip(html), code, `${lang} 内容必须逐字守恒：${JSON.stringify(code)}`);
  }
});

test('未知语言返回 null（宁可不高亮，也不假高亮）', () => {
  assert.equal(CodeHighlight.highlight('x', 'brainfuck'), null);
  assert.equal(CodeHighlight.highlight('x', ''), null);
  assert.equal(CodeHighlight.highlight('x', '   '), null);
  assert.equal(CodeHighlight.highlight('x', undefined), null);
  assert.equal(CodeHighlight.highlight('x', 42), null);
});

test('别名归一化：常见写法都能认出来', () => {
  const cases = { js: 'javascript', JSX: 'javascript', node: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', bash: 'shell', zsh: 'shell', sh: 'shell', html: 'markup', xml: 'markup', yml: 'yaml', cpp: 'c', 'c++': 'c', golang: 'go', rs: 'rust', postgres: 'sql' };
  for (const [alias, expected] of Object.entries(cases)) {
    assert.equal(CodeHighlight.normalizeLanguage(alias), expected, `${alias} → ${expected}`);
  }
  assert.equal(CodeHighlight.normalizeLanguage('python3'), 'python');
  assert.equal(CodeHighlight.normalizeLanguage('nope'), null);
});

test('数字不吞运算符（1+2 不得被当成一个数字 token）', () => {
  const html = CodeHighlight.highlight('const n = 1+2;', 'js');
  assert.match(html, /<span class="tok-number">1<\/span>/, '1 应单独成 token');
  assert.match(html, /<span class="tok-number">2<\/span>/, '2 应单独成 token');
  assert.doesNotMatch(html, /tok-number">1\+/, '加号不得被吞进数字');
  // 十六进制 / 小数 / 科学计数法仍应作为整体
  assert.match(CodeHighlight.highlight('0xFF', 'c'), /tok-number">0xFF/);
  assert.match(CodeHighlight.highlight('3.14', 'python'), /tok-number">3\.14/);
  assert.match(CodeHighlight.highlight('1e-9', 'python'), /tok-number">1e-9/);
});

test('字符串与注释里的关键字不得被单独染色（错误高亮）', () => {
  const inString = CodeHighlight.highlight('const s = "return if else";', 'js');
  // 注意：字符串内容里的引号会被转义为 &quot;（这正是"内容一律转义"的正确行为）
  assert.match(inString, /tok-string">&quot;return if else&quot;<\/span>/, '整段字符串应作为一个 token');
  assert.doesNotMatch(inString, /tok-keyword">return/, '字符串内的关键字不得再被染色');
  const inComment = CodeHighlight.highlight('// return const\nx', 'js');
  assert.match(inComment, /tok-comment">\/\/ return const/, '注释整体成 token');
  assert.doesNotMatch(inComment, /tok-keyword">return/, '注释内的关键字不得再被染色');
});

test('markup：标签名与注释被识别，属性值保持字符串语义', () => {
  const html = CodeHighlight.highlight('<div class="box">hi</div><!-- note -->', 'html');
  assert.match(html, /tok-keyword">div/, '标签名应被识别');
  assert.match(html, /tok-comment">/, '注释应被识别');
  assert.equal(strip(html), '<div class="box">hi</div><!-- note -->', '内容守恒');
});

test('安全：标记字符一律转义，输出里不出现可执行的标签', () => {
  const html = CodeHighlight.highlight('<script>alert(1)</script>', 'js');
  assert.doesNotMatch(html, /<script/i, '不得出现真实 script 标签');
  assert.match(html, /&lt;script&gt;|&lt;/, '应转义为实体');
  const markup = CodeHighlight.highlight('<img src=x onerror=alert(1)>', 'html');
  assert.doesNotMatch(markup, /<img\s/i, 'markup 分支同样不得注入');
});

test('终止性：任意输入都返回（扫描必须前进）', () => {
  const nasty = ['\\'.repeat(50), '`'.repeat(30), '/*'.repeat(20), '"'.repeat(20), '{{{[[[', '\n\n\n', '§±∞'.repeat(30)];
  for (const input of nasty) {
    for (const lang of ['js', 'python', 'html', 'json']) {
      const html = CodeHighlight.highlight(input, lang);
      assert.equal(typeof html, 'string', `${lang} 对特殊输入应返回字符串`);
      assert.equal(strip(html), input, `${lang} 特殊输入也要内容守恒`);
    }
  }
});
