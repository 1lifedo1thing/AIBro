'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Raw = require('../app/editor/raw-text');

test('raw source index preserves BOM, UTF16, CRLF, lone CR and LF', () => {
  const source = '\ufeff甲😀\r\n乙\r丙\n尾';
  const doc = Raw.create(source);
  assert.equal(doc.raw, source);
  assert.equal(Raw.normalize(source), '\ufeff甲😀\n乙\n丙\n尾');
  assert.deepEqual(doc.endings, ['\r\n', '\r', '\n']);
  assert.equal(doc.length, Raw.display(source).length);
  assert.equal(Raw.display(doc), '甲😀\n乙\n丙\n尾');
  assert.equal(Raw.toRaw(doc, 0), 1);
  assert.equal(Raw.toDisplay(doc, 0), 0);
  for (let offset = 0; offset <= doc.length; offset++) {
    assert.equal(Raw.toDisplay(doc, Raw.toRaw(doc, offset)), offset);
  }
});

test('CRLF interior offsets have an explicit directional projection', () => {
  const doc = Raw.create('A\r\nB\r\nC');
  assert.deepEqual(Array.from({ length: doc.length + 1 }, (_, i) => Raw.toRaw(doc, i)), [0, 1, 3, 4, 6, 7]);
  assert.equal(Raw.toDisplay(doc, 2, -1), 1);
  assert.equal(Raw.toDisplay(doc, 2, 1), 2);
  assert.equal(Raw.toDisplay(doc, 5, -1), 3);
  assert.equal(Raw.toDisplay(doc, 5, 1), 4);
});

test('invalid offsets are rejected instead of silently editing another range', () => {
  const doc = Raw.create('a\r\nb');
  for (const value of [-1, 0.5, NaN, Infinity, '1']) {
    assert.throws(() => Raw.toRaw(doc, value), RangeError);
    assert.throws(() => Raw.toDisplay(doc, value), RangeError);
  }
  assert.throws(() => Raw.toRaw(doc, 4), RangeError);
  assert.throws(() => Raw.toDisplay(doc, 5), RangeError);
});

test('local text changes preserve every untouched raw separator', () => {
  const source = '\ufeffone\r\ntwo\rthree\nfour';
  const doc = Raw.applyChanges(source, [{ from: 0, to: 3, insert: 'ONE' }, { from: 4, to: 7, insert: 'TWO' }]);
  assert.equal(doc.raw, '\ufeffONE\r\nTWO\rthree\nfour');
});

test('newlines follow the edited line convention without rewriting adjacent lines', () => {
  const source = 'a\r\nb\rc\nd';
  assert.equal(Raw.applyChanges(source, [{ from: 1, insert: '\nX' }]).raw, 'a\r\nX\r\nb\rc\nd');
  assert.equal(Raw.applyChanges(source, [{ from: 3, insert: '\nY' }]).raw, 'a\r\nb\rY\rc\nd');
  assert.equal(Raw.applyChanges(source, [{ from: 7, insert: '\nZ' }]).raw, 'a\r\nb\rc\nd\nZ');
  assert.equal(Raw.applyChanges('a\r\nlast', [{ from: 6, insert: '\nZ' }]).raw, 'a\r\nlast\r\nZ');
  assert.equal(Raw.applyChanges('empty', [{ from: 5, insert: '\nZ' }]).raw, 'empty\nZ');
});

test('semantically unchanged replacement retains original mixed bytes', () => {
  const source = '\ufeffa\r\nb\rc\nd';
  assert.equal(Raw.applyChanges(source, [{ from: 0, to: Raw.display(source).length, insert: Raw.display(source) }]).raw, source);
  assert.equal(Raw.applyChanges(source, []).raw, source);
});

test('simultaneous changes map against the original document including UTF16 surrogate pairs', () => {
  const source = '😀\r\nB\rC\nD';
  assert.equal(Raw.applyChanges(source, [{ from: 0, to: 2, insert: '🧭' }, { from: 3, to: 4, insert: 'beta' }, { from: 7, to: 8, insert: 'delta' }]).raw, '🧭\r\nbeta\rC\ndelta');
  assert.throws(() => Raw.applyChanges(source, [{ from: 3, to: 5, insert: 'x' }, { from: 4, insert: 'y' }]), RangeError);
});

test('line ending restoration rejects stale metadata rather than corrupting raw text', () => {
  assert.equal(Raw.restoreEndings('A\nB\nC\nD', ['\r\n', '\r', '\n']), 'A\r\nB\rC\nD');
  assert.throws(() => Raw.restoreEndings('A\nB', []), /history/);
  assert.throws(() => Raw.restoreEndings('A', ['\r\n']), /history/);
  assert.throws(() => Raw.restoreEndings('A\nB', ['x']), /history/);
});

test('deleting between lone CR and LF keeps two logical newlines', () => {
  const after = Raw.applyChanges('a\rREMOVE\nb\r\n', [{ from: 2, to: 8, insert: '' }]);
  assert.equal(Raw.normalize(after.raw), 'a\n\nb\n');
  assert.equal(after.raw, 'a\r\n\nb\r\n');
});

test('documents beyond textarea preview sizes keep complete content and exact tail mappings', () => {
  const source = '\ufeff' + '甲😀\r\n乙\r丙\n'.repeat(240000) + 'END';
  assert.ok(source.length > 2 * 1024 * 1024);
  const doc = Raw.create(source);
  const after = Raw.applyChanges(doc, [{ from: doc.length - 3, to: doc.length, insert: '尾😀' }]);
  assert.equal(after.raw, source.slice(0, -3) + '尾😀');
  assert.equal(Raw.toRaw(after, after.length), after.raw.length);
  assert.equal(Raw.toDisplay(after, after.raw.length), after.length);
});
