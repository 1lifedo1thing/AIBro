'use strict';
// Exercise production ESM state/history code without mounting a DOM or starting
// Electron. Keep CodeMirror external so transactions share the same CM instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { EditorSelection, Transaction } = require('@codemirror/state');
const { undo, redo, undoDepth, redoDepth, isolateHistory, historyField } = require('@codemirror/commands');
const { markdown, markdownLanguage } = require('@codemirror/lang-markdown');
const { syntaxTree } = require('@codemirror/language');
const Raw = require('../app/editor/raw-text');
const filename = path.resolve(__dirname, '../app/editor/source-editor.js');
const compiled = buildSync({ entryPoints: [filename], write: false, bundle: true, format: 'cjs', platform: 'node', external: ['@codemirror/*'], loader: { '.css': 'text' }, logLevel: 'silent' }).outputFiles[0].text;
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths; loaded._compile(compiled, filename);
const { createSourceState, rawDocument, replaceSourceValue, sourceLanguage } = loaded.exports;

function editor(source) {
  let state = createSourceState(source);
  const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
  return {
    get state() { return state; }, get value() { return state.field(rawDocument).raw; },
    change(changes, annotations = []) { state = state.update({ changes, annotations }).state; return this; },
    replace(value) { state = replaceSourceValue(state, value).state; return this; },
    undo() { return undo(target); }, redo() { return redo(target); },
    select(selection) { state = state.update({ selection }).state; }
  };
}
const type = () => [Transaction.userEvent.of('input.type')];
const isolated = () => [isolateHistory.of('full')];

test('production state uses normalized CM text and retains complete canonical bytes', () => {
  const source = '\ufeff# 标题\r\n😀\r第三行\n';
  const e = editor(source);
  assert.equal(e.state.doc.toString(), Raw.display(source));
  assert.equal(e.value, source);
  assert.equal(undoDepth(e.state), 0);
  e.select(EditorSelection.single(1, 3));
  assert.equal(e.value, source);
});

test('a file BOM stays raw metadata so the real Markdown parser recognizes its first heading', () => {
  const source = '\ufeff# 标题\r\n\r\n正文';
  const state = createSourceState(source, [markdown({ base: markdownLanguage })]);
  assert.match(syntaxTree(state).toString(), /ATXHeading1/);
  assert.equal(state.field(rawDocument).raw, source);
  assert.equal(Raw.toRaw(state.field(rawDocument), 0), 1);
});

test('BOM-only explicit replacements are undoable without changing normalized text', () => {
  const e = editor('# Head\r\n');
  e.replace('\ufeff# Head\r\n');
  assert.equal(e.value, '\ufeff# Head\r\n');
  assert.equal(e.state.doc.toString(), '# Head\n');
  e.undo(); assert.equal(e.value, '# Head\r\n');
  e.redo(); assert.equal(e.value, '\ufeff# Head\r\n');
  e.replace('# Head\r\n');
  e.undo(); assert.equal(e.value, '\ufeff# Head\r\n');
});

test('a pasted literal BOM is document content and is not silently removed', () => {
  for (const source of ['abc\r\n', '\ufeffabc\r\n']) {
    const e = editor(source);
    e.change({ from: 0, insert: '\ufeff' });
    assert.equal(e.value, '\ufeff' + source);
    assert.equal(e.state.doc.toString(), '\ufeffabc\n');
    e.undo(); assert.equal(e.value, source);
    e.redo(); assert.equal(e.value, '\ufeff' + source);
    assert.equal(e.state.doc.toString(), '\ufeffabc\n');
  }
});

test('CM multi-range transactions preserve untouched BOM and mixed newline formats', () => {
  const e = editor('\ufeffa\r\nb\rc\nd');
  e.change([{ from: 0, to: 1, insert: '甲😀' }, { from: 4, to: 5, insert: '丙' }]);
  assert.equal(e.value, '\ufeff甲😀\r\nb\r丙\nd');
  assert.equal(e.state.doc.toString(), Raw.display(e.state.field(rawDocument)));
  assert.equal(e.undo(), true);
  assert.equal(e.value, '\ufeffa\r\nb\rc\nd');
  assert.equal(e.redo(), true);
  assert.equal(e.value, '\ufeff甲😀\r\nb\r丙\nd');
});

test('deleting mixed line endings and undoing restores their exact bytes', () => {
  const source = '\ufeffa\r\nb\rc\nd\r\n';
  const e = editor(source);
  e.change({ from: 1, to: 7, insert: ' merged ' });
  assert.equal(e.value, '\ufeffa merged \r\n');
  assert.equal(e.undo(), true);
  assert.equal(e.value, source);
  assert.equal(e.redo(), true);
  assert.equal(e.value, '\ufeffa merged \r\n');
});

test('grouped typing keeps the oldest newline metadata for undo and newest for redo', () => {
  const source = 'start\r\ntail\rEND\n';
  const e = editor(source);
  e.change({ from: 5, insert: '\n' }, type());
  e.change({ from: 6, insert: '新' }, type());
  e.change({ from: 7, insert: '\n' }, type());
  e.change({ from: 8, insert: '😀' }, type());
  const after = 'start\r\n新\r\n😀\r\ntail\rEND\n';
  assert.equal(e.value, after);
  assert.equal(undoDepth(e.state), 1);
  assert.equal(e.undo(), true);
  assert.equal(e.value, source);
  assert.equal(e.redo(), true);
  assert.equal(e.value, after);
});

test('successive newline edits with isolated undo events keep each source format', () => {
  const e = editor('a\r\nb\rc\nd');
  const values = [e.value];
  e.change({ from: 1, insert: '\nX' }, isolated()); values.push(e.value);
  e.change({ from: 4, to: 6, insert: 'B\nY' }, isolated()); values.push(e.value);
  e.change({ from: e.state.doc.length, insert: '\nEND' }, isolated()); values.push(e.value);
  for (let index = values.length - 2; index >= 0; index--) { assert.equal(e.undo(), true); assert.equal(e.value, values[index]); }
  for (let index = 1; index < values.length; index++) { assert.equal(e.redo(), true); assert.equal(e.value, values[index]); }
});

test('explicit proposal replacement records exact proposed BOM and mixed endings in history', () => {
  const source = '\ufeffold\r\ntext\rEND\n', proposed = '# New\n😀\r\n终\r';
  const e = editor(source);
  e.replace(proposed); assert.equal(e.value, proposed);
  assert.equal(e.undo(), true); assert.equal(e.value, source);
  assert.equal(e.redo(), true); assert.equal(e.value, proposed);
});

test('line-ending-only proposal changes remain undoable despite identical normalized text', () => {
  const source = 'a\r\nb\rc\n', proposed = 'a\nb\r\nc\r';
  const e = editor(source);
  e.replace(proposed); assert.equal(e.value, proposed); assert.equal(undoDepth(e.state), 1);
  assert.equal(e.undo(), true); assert.equal(e.value, source);
  assert.equal(e.redo(), true); assert.equal(e.value, proposed);
});

test('proposal replacement followed by typing and deletion retains independent undo boundaries', () => {
  const source = '\ufeffa\r\nb\rc\n';
  const e = editor(source), proposed = '甲\r乙\n😀\r\n';
  e.replace(proposed);
  e.change({ from: 1, insert: '\n新' }, isolated());
  const typed = e.value;
  e.change({ from: 2, to: 5, insert: '' }, isolated());
  const deleted = e.value;
  for (const expected of [typed, proposed, source]) { assert.equal(e.undo(), true); assert.equal(e.value, expected); }
  for (const expected of [proposed, typed, deleted]) { assert.equal(e.redo(), true); assert.equal(e.value, expected); }
});

test('undo followed by a fresh edit drops redo without reusing stale line metadata', () => {
  const e = editor('a\r\nb\rc\n');
  e.change({ from: 1, to: 4, insert: 'x\ny' }, isolated());
  e.undo(); assert.equal(redoDepth(e.state), 1);
  e.change({ from: 3, insert: '\nZ' }, isolated());
  assert.equal(redoDepth(e.state), 0);
  assert.equal(e.value, 'a\r\nb\rZ\rc\n');
  e.undo(); assert.equal(e.value, 'a\r\nb\rc\n');
});

test('large source transaction never truncates canonical data and retains tail undo', () => {
  const source = '\ufeff' + 'abcdefghij\r\nxyz\r'.repeat(150000) + 'END';
  assert.ok(source.length > 2 * 1024 * 1024);
  const e = editor(source);
  e.change({ from: e.state.doc.length - 3, to: e.state.doc.length, insert: '末尾😀' });
  assert.equal(e.value, source.slice(0, -3) + '末尾😀');
  e.undo(); assert.equal(e.value, source);
});

test('deterministic mixed-ending edit sequences round trip every undo and redo snapshot', () => {
  let seed = 0x601a;
  const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  const inserts = ['', '甲', '😀', '\n', '\nX\n', '\ufeff', 'abc\n\nend'];
  for (let run = 0; run < 60; run++) {
    const e = editor((run % 2 ? '\ufeff' : '') + 'A\r\nB\rC\nD\r\n'), values = [e.value];
    for (let step = 0; step < 12; step++) {
      const from = random(e.state.doc.length + 1), to = from + random(e.state.doc.length - from + 1);
      let insert = inserts[random(inserts.length)];
      if (from === to && !insert) insert = 'x';
      e.change({ from, to, insert }, isolated()); values.push(e.value);
      assert.equal(e.state.doc.toString(), Raw.display(e.state.field(rawDocument)), `normalized state run ${run} step ${step}`);
    }
    for (let index = values.length - 2; index >= 0; index--) { assert.equal(e.undo(), true); assert.equal(e.value, values[index]); }
    for (let index = 1; index < values.length; index++) { assert.equal(e.redo(), true); assert.equal(e.value, values[index]); }
  }
});

// File language changes must not change raw text or accidentally enable the
// Markdown parser on ordinary source files.
test('actual local filenames select matching parsers and unknown types remain plain text', () => {
  for (const [filename, text, expected] of [
    ['a.md', '# heading', /ATXHeading1/], ['a.ts', 'const x: number = 1', /VariableDeclaration/],
    ['a.py', 'def f():\n  return 1', /FunctionDefinition/], ['a.json', '{"a":1}', /JsonText/],
    ['a.css', 'a { color: red }', /StyleSheet/], ['a.html', '<p>hi</p>', /Document/]
  ]) {
    const state = createSourceState(text, [sourceLanguage(filename)]);
    assert.match(syntaxTree(state).toString(), expected, filename);
    assert.equal(state.field(rawDocument).raw, text);
  }
  assert.deepEqual(sourceLanguage('a.txt'), []);
  assert.deepEqual(sourceLanguage('a.swift'), []);
});

test('whole-document replacement with unchanged mixed endings undoes to exact original bytes', () => {
  const raw='\ufeff---\r\ntitle: Keep exact\r\n---\n\nFirst\r\n\nSecond\r\n';
  const e=editor(raw); e.replace(raw+'changed');
  assert.equal(e.value,raw+'changed'); assert.equal(e.undo(),true); assert.equal(e.value,raw);
  assert.equal(e.redo(),true); assert.equal(e.value,raw+'changed');
});


test('grouped single-line typing does not retain line-ending metadata per keystroke',()=>{
 const raw='\ufeffFirst\r\nSecond\nThird\r',e=editor(raw);
 for(let n=0;n<200;n++) e.change({from:5+n,insert:'x'},type());
 const native=e.state.field(historyField);assert.equal(native.done.length,1);assert.equal(native.done[0].effects.length,0);
 assert.equal(e.undo(),true);assert.equal(e.value,raw);assert.equal(e.redo(),true);assert.equal(e.value,'\ufeffFirst'+'x'.repeat(200)+'\r\nSecond\nThird\r');
});
