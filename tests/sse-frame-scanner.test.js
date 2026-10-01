const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../app/sse-frame-scanner');
function scan(chunks, finish = true) {
  const frames = [], scanner = create({ onFrame: frame => frames.push(frame) });
  for (const chunk of chunks) scanner.push(chunk);
  if (finish) scanner.finish();
  return { frames, scanner };
}
const data = frames => frames.map(frame => frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n'));
test('LF, CRLF, CR and mixed endings delimit complete frames across every chunk boundary', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const body = `event: response.output_text.delta${ending}data: {"delta":"中文"}${ending}${ending}data: [DONE]${ending}${ending}`;
    for (let cut = 0; cut <= body.length; cut++) assert.deepEqual(data(scan([body.slice(0, cut), '', body.slice(cut)]).frames), ['{"delta":"中文"}', '[DONE]']);
    assert.deepEqual(data(scan([...body]).frames), ['{"delta":"中文"}', '[DONE]']);
  }
  assert.deepEqual(data(scan(['data: one\r', '\n\ndata: two\n\r', '\ndata: three\r\r']).frames), ['one', 'two', 'three']);
});
test('multiple data lines, comments and event names remain in their original order', () => {
  const { frames } = scan([': heartbeat\nevent: result\ndata: {"a":\n', 'data: 1}\n\n']);
  assert.equal(frames.length, 1); assert.equal(data(frames)[0], '{"a":\n1}');
  assert.match(frames[0], /^: heartbeat\nevent: result\ndata:/);
});
test('EOF flushes one trailing frame and empty EOF or repeated finish never dispatch duplicates', () => {
  const f = scan(['\n\n', 'data: last'], false); assert.equal(f.frames.length, 0);
  f.scanner.finish(); f.scanner.finish(); assert.deepEqual(data(f.frames), ['last']);
  assert.equal(f.scanner.inspect().bufferedCharacters, 0); assert.equal(f.scanner.inspect().fragments, 0);
  assert.throws(() => f.scanner.push('late'), /ended/);
  assert.deepEqual(scan(['']).frames, []);
});
test('a giant one-byte-at-a-time data line uses bounded fragment metadata and scans each new character once', () => {
  const text = 'data: ' + 'x'.repeat(131073), f = scan([...text], false), stats = f.scanner.inspect();
  assert.equal(stats.bufferedCharacters, text.length);
  assert.equal(stats.scannedCharacters, text.length);
  assert.ok(stats.fragments <= Math.ceil(text.length / 16384));
  f.scanner.push('\n\n'); assert.equal(f.frames[0], text + '\n');
  assert.equal(f.scanner.inspect().bufferedCharacters, 0);
});
test('large chunks and many completed frames never rescan or retain consumed frames', () => {
  const first = 'data: ' + 'x'.repeat(2 * 1024 * 1024), tail = 'data: pending';
  const chunk = first + '\n\n' + 'data: next\n\n' + tail;
  const f = scan([chunk], false); assert.deepEqual(data(f.frames), [first.slice(6), 'next']);
  const stats = f.scanner.inspect(); assert.equal(stats.bufferedCharacters, tail.length); assert.equal(stats.fragments, 1); assert.equal(stats.scannedCharacters, chunk.length);
});
test('frame callback failures propagate without retaining the completed frame', () => {
  const scanner = create({ onFrame: () => { throw Error('bad event'); } });
  assert.throws(() => scanner.push('data: failed\n\n'), /bad event/);
  assert.equal(scanner.inspect().bufferedCharacters, 0); assert.equal(scanner.inspect().fragments, 0);
});
