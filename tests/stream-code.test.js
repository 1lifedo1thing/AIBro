'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const Code = require('../app/stream-code.js');
const Highlight = require('../app/code-highlight.js');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const parser = source.slice(source.indexOf('function renderRichText('), source.indexOf('\nfunction renderMessage('));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const env = { esc, URL, CodeHighlight: Highlight, window: {}, state: {} };
const render = vm.runInNewContext(`(${parser})`, env);
const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, item => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[item]));
const codeText = html => decode([...html.matchAll(/<code(?: data-language="[^"]*")?>([\s\S]*?)<\/code>/g)].at(-1)?.[1].replace(/<[^>]*>/g, '') || '');
function apply(text, edits) { for (const edit of edits) text = edit.remove ? text.slice(0, text.length - edit.remove) : text + edit.append; return text; }
function frames(values) {
  let continuation, current = '', fast = 0, parsed = 0;
  for (const text of values) {
    const metadata = { liveCode: true }, reference = render(text, null, metadata);
    const change = continuation && Code.advance(continuation, text);
    if (change) { current = apply(current, change.edits); continuation = change.state; fast++; }
    else { continuation = metadata.fence ? Code.seed(metadata.fence, text) : null; current = codeText(reference); parsed++; }
    if (continuation) assert.equal(current, codeText(reference), JSON.stringify(text));
    // The opt-in temporary presentation is allowed to remove token spans,
    // never characters. Final/default parsing always remains canonical.
    assert.equal(codeText(reference), codeText(render(text)), JSON.stringify(text));
  }
  return { current, fast, parsed, continuation };
}
const progressive = text => Array.from({ length: text.length + 1 }, (_, n) => text.slice(0, n));

test('every partial fence boundary matches actual parser text including tentative closing revocation', () => {
  const fixtures = [
    '```js\nconst a = 1;\n``` \tx\n// still code\n```\nAfter',
    '~~~python\n# 😀中文 & <script>\n ~~~\t\n',
    ' ````c++\nfirst\n```\nsecond\n`````x\nlast\n````\n',
    '```text\n\n\n```', '```js\n```', '```js\n\n```x',
    '```js\na\n    ```\n b\n```', '```js\na\n\t```\n b\n```',
    '```js\na\r\n```\r\nlast', '~~~\r\nα\rβ\n~~~ x\r~~~\r\n',
    '~~~language with spaces\na\n~~~', '~~~' + 'x'.repeat(31) + '\ny\n~~~',
    '```unknown\na\n---not a close\n~~~\n```x\n```\nnext',
    '# heading\n\nStable **text**\n\n```js\nconst x = "body";\n```\n',
  ];
  for (const text of fixtures) frames(progressive(text).flatMap(value => [value, value, value]));
});

test('UTF-8 byte splits and UTF-16 surrogate splits neither lose nor duplicate text', () => {
  const raw = '```text\r\n中文😀𝄞 <tag> & e\u0301\r\n```x';
  const bytes = new TextEncoder().encode(raw), decoder = new TextDecoder(), values = []; let value = '';
  for (const byte of bytes) { value += decoder.decode(Uint8Array.of(byte), { stream: true }); values.push(value); }
  value += decoder.decode(); values.push(value);
  assert.equal(frames(values).current, '中文😀𝄞 <tag> & e\u0301\n```x');
  assert.equal(frames(progressive(raw)).current, '中文😀𝄞 <tag> & e\u0301\n```x');
});

test('nonappend edits and shortened or same-length replies invalidate continuation', () => {
  const input = '```js\nconst value = 1;';
  const metadata = { liveCode: true }; render(input, null, metadata);
  const before = Code.seed(metadata.fence, input);
  for (const value of ['', input.slice(0, -1), input.replace('1', '2'), input.replace('js', 'ts')]) assert.equal(Code.advance(before, value), null);
  assert.equal(Code.advance(before, input).edits.length, 0);
});

test('planning does not mutate the accepted continuation or permit a discarded plan to advance it', () => {
  const input = '```js\nconst n = ', metadata = { liveCode: true }; render(input, null, metadata);
  const before = Code.seed(metadata.fence, input), frozen = JSON.stringify(before);
  const ignored = Code.advance(before, input + '12345');
  const committed = Code.advance(before, input + '7');
  assert.equal(JSON.stringify(before), frozen); assert.notEqual(ignored.state, before);
  assert.equal(apply('const n = ', committed.edits), 'const n = 7');
  assert.equal(committed.state.codeLength, 'const n = 7'.length);
});

test('large activity scans new suffixes and does not require a whole-source highlighter call', () => {
  const initial = '```js\n', metadata = { liveCode: true }; render(initial, null, metadata);
  let continuation = Code.seed(metadata.fence, initial), raw = initial, current = '', scanned = 0;
  const delta = 'const value = "😀中文"; // <safe>\n'.repeat(2048);
  for (let n = 0; n < 36; n++) {
    raw += delta;
    const change = Code.advance(continuation, raw); assert.ok(change);
    scanned += change.scannedCharacters; current = apply(current, change.edits); continuation = change.state;
  }
  assert.ok(raw.length > 2 * 1024 * 1024); assert.equal(scanned, raw.length - initial.length);
  assert.equal(current, raw.slice(initial.length)); assert.equal(continuation.codeLength, current.length);
  assert.equal(Code.advance(continuation, raw + '```\nFinal'), null);
});

test('an arbitrarily long tentative closing line stays suppressed then restores once when invalidated', () => {
  const input = '```text\nvalue\n```', metadata = { liveCode: true }; render(input, null, metadata);
  let continuation = Code.seed(metadata.fence, input), raw = input, current = 'value';
  for (let n = 0; n < 20; n++) {
    raw += ' '.repeat(16384); const change = Code.advance(continuation, raw);
    assert.equal(change.edits.length, 0); continuation = change.state;
  }
  raw += 'x'; const change = Code.advance(continuation, raw); current = apply(current, change.edits);
  assert.equal(current, 'value\n```' + ' '.repeat(327680) + 'x');
});

test('dependency probes do not normalize, parse, or highlight content', () => {
  let calls = 0; const old = env.CodeHighlight;
  env.CodeHighlight = { highlight() { calls++; return null; } };
  const probe = { probeOnly: true };
  assert.equal(render({ toString() { throw Error('must not stringify'); } }, null, probe), '');
  assert.equal(calls, 0); assert.equal(probe.dependencies[2], env.CodeHighlight.highlight);
  env.CodeHighlight = old;
});
