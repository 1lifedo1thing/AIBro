const test = require('node:test');
const assert = require('node:assert/strict');
let createImageUploads, durableImage, imageMarkdown, supportedImage;
test.before(async () => ({ createImageUploads, durableImage, imageMarkdown, supportedImage } = await import('../app/editor/image-uploads.mjs')));
const file = (name = 'one.png', type = 'image/png') => ({ name, type, size: 100 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(upload) {
  const state = { active: true, anchors: new Set(), inserted: [], errors: [], busy: [] };
  const queue = createImageUploads({ upload, available: () => state.active,
    capture: () => { const id = Symbol('position'); state.anchors.add(id); return id; },
    remove: id => state.anchors.delete(id),
    insert: (id, images) => { if (!state.anchors.has(id)) return false; state.inserted.push(images); return true; },
    report: error => state.errors.push(error.message), onBusy: count => state.busy.push(count) });
  return { ...state, state, queue };
}
test('accepts only nonempty supported raster formats and durable URLs', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(supportedImage(file('file', type)), true);
  for (const type of ['image/svg+xml', 'text/plain', '', 'application/pdf']) assert.equal(supportedImage(file('file', type)), false);
  assert.equal(supportedImage({ ...file(), size: 0 }), false);
  for (const url of ['', 'blob:local', 'data:image/png,AA', 'javascript:run()', '//remote/image.png']) assert.throws(() => durableImage({ url }, file()), /可保存/);
  assert.equal(durableImage({ url: '/__files/id' }, file()).url, '/__files/id');
  assert.equal(durableImage({ url: 'note.assets/123.png', alt: 'A\nB' }, file()).alt, 'A B');
});
test('invalid mixed batch is rejected before transport or pending placeholders', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  assert.equal(await f.queue.insertFiles([file(), file('bad.svg', 'image/svg+xml')]), false);
  assert.equal(calls, 0); assert.equal(f.anchors.size, 0); assert.equal(f.queue.isBusy(), false); assert.equal(f.errors.length, 1);
});
test('flush waits for actual ACK and insertion, canonical results preserve batch order', async () => {
  const gates = [deferred(), deferred()], calls = [];
  const f = fixture(file => { calls.push(file.name); return gates[calls.length - 1].promise; });
  const job = f.queue.insertFiles([file('a.png'), file('b.png')]);
  let settled = false; const flushed = f.queue.flush().then(result => { settled = true; return result; });
  await Promise.resolve(); assert.equal(f.queue.isBusy(), true); assert.equal(settled, false);
  gates[0].resolve({ url: '/__files/a' }); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, ['a.png', 'b.png']); assert.equal(f.inserted.length, 0);
  gates[1].resolve({ url: '/__files/b' }); assert.equal(await job, true); assert.equal(await flushed, true);
  assert.deepEqual(f.inserted[0].map(image => image.url), ['/__files/a', '/__files/b']); assert.equal(f.anchors.size, 0); assert.equal(f.queue.isBusy(), false);
});
test('consecutive gestures preserve order instead of racing transport completions', async () => {
  const gate = deferred(), calls = [];
  const f = fixture(file => { calls.push(file.name); return file.name === 'first.png' ? gate.promise : Promise.resolve({ url: '/__files/second' }); });
  const first = f.queue.insertFiles([file('first.png')]), second = f.queue.insertFiles([file('second.png')]);
  await Promise.resolve(); assert.deepEqual(calls, ['first.png']);
  gate.resolve({ url: '/__files/first' }); assert.equal(await first, true); assert.equal(await second, true);
  assert.deepEqual(f.inserted.map(images => images[0].url), ['/__files/first', '/__files/second']);
});
test('one rejected image preserves successful siblings, removes loading and lets user retry', async () => {
  let fail = true;
  const f = fixture(async image => { if (image.name === 'b.png' && fail) throw Error('磁盘保存失败'); return { url: '/__files/' + image.name }; });
  const batch = f.queue.insertFiles([file('a.png'), file('b.png'), file('c.png')]); const flushed = f.queue.flush();
  assert.equal(await batch, false); assert.equal(await flushed, false); assert.equal(f.queue.isBusy(), false); assert.equal(f.anchors.size, 0);
  assert.deepEqual(f.inserted[0].map(image => image.url), ['/__files/a.png', '/__files/c.png']); assert.match(f.errors[0], /b.png.*磁盘保存失败/);
  fail = false; assert.equal(await f.queue.insertFiles([file('b.png')]), true); assert.equal(f.inserted.length, 2); assert.equal(await f.queue.flush(), true);
});
test('replacing the document cancels immediately and ignores a late durable ACK', async () => {
  const gate = deferred(), f = fixture(() => gate.promise);
  const job = f.queue.insertFiles([file()]); const flush = f.queue.flush(); await Promise.resolve();
  f.queue.cancel(); assert.equal(await job, false); assert.equal(await flush, false); assert.equal(f.anchors.size, 0);
  gate.resolve({ url: '/__files/late' }); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(f.inserted, []);
});
test('destroy settles held jobs without publishing late UI or writes', async () => {
  const gate = deferred(), f = fixture(() => gate.promise);
  const job = f.queue.insertFiles([file()]); await Promise.resolve(); f.queue.destroy(); const count = f.busy.length;
  assert.equal(await job, false); gate.reject(Error('late failure')); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.busy.length, count); assert.deepEqual(f.errors, []); assert.deepEqual(f.inserted, []); assert.equal(await f.queue.flush(), false);
});
test('deleted target refuses insertion even if durable upload succeeds', async () => {
  const gate = deferred(), f = fixture(() => gate.promise); const job = f.queue.insertFiles([file()]); await Promise.resolve(); f.anchors.clear();
  gate.resolve({ url: '/__files/saved' }); assert.equal(await job, false); assert.deepEqual(f.inserted, []); assert.match(f.errors[0], /原插入位置已变化/);
});
test('detached or disabled editor does not receive an upload result', async () => {
  const gate = deferred(), f = fixture(() => gate.promise); const job = f.queue.insertFiles([file()]); await Promise.resolve(); f.state.active = false;
  gate.resolve({ url: '/__files/saved' }); assert.equal(await job, false); assert.equal(f.queue.isBusy(), false); assert.deepEqual(f.inserted, []);
});
test('source image Markdown escapes labels and delimiters without serializing temporary data', () => {
  assert.equal(imageMarkdown([{ url: 'note.assets/a.png', alt: 'A [v1] \\ x' }]), '![A \\[v1\\] \\\\ x](<note.assets/a.png>)');
  assert.match(imageMarkdown([{ url: '/__files/a<1>', alt: 'image' }]), /a%3C1%3E/);
});
test('real CodeMirror image anchors map edits and disappear when their insertion range is deleted', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { imageAnchors, imageAnchorChange } = await import('../app/editor/source-image-anchors.mjs');
  const id = Symbol('test'); let state = EditorState.create({ doc: 'First\n\nLast', extensions: [imageAnchors] });
  state = state.update({ effects: imageAnchorChange.of({ add: { id, pos: 7, count: 1 } }) }).state;
  state = state.update({ changes: { from: 0, insert: 'Typed ' } }).state;
  assert.equal(state.field(imageAnchors).get(id).pos, 13);
  state = state.update({ changes: { from: 12, to: 15, insert: 'X' } }).state;
  assert.equal(state.field(imageAnchors).has(id), false);
});
test('separate source anchors maintain gesture order at the same caret as earlier image is inserted', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { imageAnchors, imageAnchorChange } = await import('../app/editor/source-image-anchors.mjs');
  const first = Symbol(), second = Symbol(); let state = EditorState.create({ doc: 'Text', extensions: [imageAnchors] });
  state = state.update({ effects: [imageAnchorChange.of({ add: { id: first, pos: 4, count: 1 } }), imageAnchorChange.of({ add: { id: second, pos: 4, count: 1 } })] }).state;
  state = state.update({ changes: { from: 4, insert: '\n\n![first](</__files/first>)' }, effects: imageAnchorChange.of({ remove: first }) }).state;
  assert.equal(state.field(imageAnchors).get(second).pos, state.doc.length); assert.equal(state.field(imageAnchors).has(first), false);
});

test('a canceled hung transport does not block a fresh insertion into the new document', async () => {
  const gate = deferred(); let first = true; const f = fixture(async () => { if (first) { first = false; return gate.promise; } return { url: '/__files/fresh' }; });
  const old = f.queue.insertFiles([file()]); await Promise.resolve(); f.queue.cancel(); assert.equal(await old, false);
  assert.equal(await f.queue.insertFiles([file('fresh.png')]), true); assert.equal(f.inserted[0][0].url, '/__files/fresh');
  gate.resolve({ url: '/__files/stale' }); await Promise.resolve(); await Promise.resolve(); assert.equal(f.inserted.length, 1);
});
