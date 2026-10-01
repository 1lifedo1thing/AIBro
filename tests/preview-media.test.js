'use strict';
/* 原件预览补充形态（§5.3）：解析正确性 + 安全边界。
   安全断言是刻意的：HTML 必须空沙箱、CSV 单元一律转义——后续改动不得放开。 */
const test = require('node:test');
const assert = require('node:assert/strict');

const PreviewMedia = require('../app/preview-media.js');

test('kindOf 按 MIME 与扩展名分流，不认识的返回 null（交回既有分支）', () => {
  assert.equal(PreviewMedia.kindOf('video/mp4', 'a.mp4'), 'video');
  assert.equal(PreviewMedia.kindOf('', 'clip.MOV'), 'video');
  assert.equal(PreviewMedia.kindOf('audio/mpeg', 'a.mp3'), 'audio');
  assert.equal(PreviewMedia.kindOf('', '录音.m4a'), 'audio');
  assert.equal(PreviewMedia.kindOf('text/csv', 'a'), 'csv');
  assert.equal(PreviewMedia.kindOf('', '表格.TSV'), 'csv');
  assert.equal(PreviewMedia.kindOf('text/html', 'page'), 'html');
  assert.equal(PreviewMedia.kindOf('', 'demo.htm'), 'html');
  // PDF 与图片由既有分支处理：这里必须返回 null，避免两处抢管。
  assert.equal(PreviewMedia.kindOf('application/pdf', 'a.pdf'), null);
  assert.equal(PreviewMedia.kindOf('image/png', 'a.png'), null);
  assert.equal(PreviewMedia.kindOf('text/plain', 'a.txt'), null);
});

test('parseDelimited 支持引号包裹、引号内逗号与换行、双写引号转义', () => {
  assert.deepEqual(PreviewMedia.parseDelimited('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(PreviewMedia.parseDelimited('a,"b,c"\nd,e'), [['a', 'b,c'], ['d', 'e']]);
  assert.deepEqual(PreviewMedia.parseDelimited('"x""y",z'), [['x"y', 'z']]);
  assert.deepEqual(PreviewMedia.parseDelimited('a,"line1\nline2",c'), [['a', 'line1\nline2', 'c']]);
  // CRLF 归一与末尾空行清理
  assert.deepEqual(PreviewMedia.parseDelimited('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(PreviewMedia.parseDelimited(''), []);
  // TSV：制表符分隔
  assert.deepEqual(PreviewMedia.parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
  assert.equal(PreviewMedia._pure.delimiterFor('x.tsv'), '\t');
  assert.equal(PreviewMedia._pure.delimiterFor('x.csv'), ',');
});

test('bounded 保留前若干行列并如实报告省略量（不静默截断）', () => {
  const rows = Array.from({ length: 250 }, (_, index) => ['r' + index, 'x']);
  const result = PreviewMedia.bounded(rows);
  assert.equal(result.head.length, 200);
  assert.equal(result.droppedRows, 50);
  assert.equal(result.totalRows, 250);
  const wide = PreviewMedia.bounded([Array.from({ length: 35 }, (_, index) => 'c' + index)]);
  assert.equal(wide.head[0].length, 30);
  assert.equal(wide.droppedCols, 5);
});

test('tableMarkup 一律转义：单元格里的标记只能以字面呈现', () => {
  const html = PreviewMedia.tableMarkup([['<script>alert(1)</script>', '<img src=x onerror=1>'], ['a', 'b']]);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  // 表头取自第一行；超出上限时给出说明
  assert.match(html, /<thead>/);
  const overflow = PreviewMedia.tableMarkup(Array.from({ length: 210 }, () => ['v']));
  assert.match(overflow, /还有 10 行未显示/);
});

test('mount 不认识的类型不接管（返回 null，不覆盖既有渲染）', () => {
  const doc = makeDocumentStub();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const host = doc.createElement('div');
    assert.equal(PreviewMedia.mount(host, { mime: 'application/pdf', name: 'a.pdf' }), null);
    assert.equal(PreviewMedia.mount(host, { mime: 'text/plain', name: 'a.txt' }), null);
    // CSV 需要文本内容；没有文本时也不接管（交回既有分支）
    assert.equal(PreviewMedia.mount(host, { mime: 'text/csv', name: 'a.csv' }), null);
  } finally { globalThis.document = previous; }
});

test('HTML 预览必须空沙箱：不执行脚本、不发外链请求（安全边界，不得放开）', () => {
  const doc = makeDocumentStub();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const host = doc.createElement('div');
    assert.equal(PreviewMedia.mount(host, { mime: 'text/html', name: 'page.html', url: 'blob:x' }), 'html');
    const frame = host.children[0];
    assert.equal(frame.tagName, 'iframe');
    // 空字符串 = 拒绝一切能力（脚本/表单/同源都关掉）
    assert.equal(frame.attributes.sandbox, '');
    assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
    // 说明文字必须如实：告知未执行脚本
    assert.match(host.children[1].textContent, /不执行.*脚本/);
  } finally { globalThis.document = previous; }
});

test('视频/音频用原生控件挂载，CSV 渲染成表格', () => {
  const doc = makeDocumentStub();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const videoHost = doc.createElement('div');
    assert.equal(PreviewMedia.mount(videoHost, { mime: 'video/mp4', name: 'a.mp4', url: 'blob:v' }), 'video');
    assert.equal(videoHost.children[0].tagName, 'video');
    assert.equal(videoHost.children[0].controls, true);
    const audioHost = doc.createElement('div');
    assert.equal(PreviewMedia.mount(audioHost, { mime: 'audio/mpeg', name: 'a.mp3', url: 'blob:a' }), 'audio');
    assert.equal(audioHost.children[0].tagName, 'audio');
    const csvHost = doc.createElement('div');
    assert.equal(PreviewMedia.mount(csvHost, { mime: 'text/csv', name: 'a.csv', text: 'h1,h2\n1,2' }), 'csv');
    assert.match(csvHost.innerHTML, /<th>h1<\/th>/);
    assert.match(csvHost.innerHTML, /<td>1<\/td>/);
  } finally { globalThis.document = previous; }
});

test('缺少必要输入时不接管：没有原件地址的媒体、空文本的表格（本次修的真实缺陷）', () => {
  const doc = makeDocumentStub();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const host = doc.createElement('div');
    // 没有 url 的媒体：不接管（渲染 src 为空的播放器等于给用户一个坏控件）
    assert.equal(PreviewMedia.mount(host, { mime: 'video/mp4', name: 'a.mp4' }), null);
    assert.equal(PreviewMedia.mount(host, { mime: 'audio/mpeg', name: 'a.mp3' }), null);
    assert.equal(PreviewMedia.mount(host, { mime: 'text/html', name: 'a.html' }), null);
    // 空文本的表格：不接管（不给一个空壳表格）
    assert.equal(PreviewMedia.mount(host, { mime: 'text/csv', name: 'a.csv', text: '   ' }), null);
    // 但只要有非空解析文本，表格就应该渲染（不依赖原件文件）
    assert.equal(PreviewMedia.mount(host, { mime: 'text/csv', name: 'a.csv', text: 'a,b\n1,2' }), 'csv');
  } finally { globalThis.document = previous; }
});

// 最小 DOM 桩：只覆盖本模块用到的 API（createElement / setAttribute / replaceChildren / append）。
function makeDocumentStub() {
  class Stub {
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.children = []; this._text = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    replaceChildren(...nodes) { this.children = nodes; this.innerHTML = ''; }
    append(...nodes) { this.children.push(...nodes); }
    set textContent(value) { this._text = String(value); }
    get textContent() { return this._text; }
  }
  return { createElement: tag => new Stub(tag) };
}
