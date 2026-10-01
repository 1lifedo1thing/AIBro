const test = require('node:test');
const assert = require('node:assert/strict');
const Review = require('../app/file-review.js');

function fixture(created = false, type = 'note') {
  const item = type === 'note' ? { id: 'n', title: 'Agent title', content: 'Agent edit', updatedAt: 2 } : { id: 'n', name: 'Agent filename', folderPath: 'new', updatedAt: 2 };
  const change = { type, id: item.id, before: created ? null : type === 'note' ? { title: 'Original', content: 'Before', updatedAt: 1 } : { name: 'Before', folderPath: 'old', updatedAt: 1 }, after: Review.record(type, item) };
  const state = { notes: type === 'note' ? [item] : [], imports: type === 'import' ? [item] : [], links: [{ id: 'l', sourceId: 'n', targetId: 'other' }], trash: [] };
  return { state, item, change };
}
function pending() {
  let reject, resolve;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { save: () => promise, reject, resolve };
}

test('successful undo resolves only after durable save and retains actual revision', async () => {
  const { state, item, change } = fixture(); const gate = pending();
  let finished = false;
  const operation = Review.undoDurably(state, change, gate.save).then(result => { finished = true; return result; });
  assert.equal(item.content, 'Before'); assert.equal(item.revisionHistory.length, 1);
  await Promise.resolve(); assert.equal(finished, false);
  gate.resolve(true); assert.equal(await operation, true); assert.ok(change.undoneAt);
});

test('failed undo restores an unchanged record and rejects with original save error', async () => {
  const { state, item, change } = fixture(); const before = structuredClone(item), error = Error('disk failed');
  await assert.rejects(Review.undoDurably(state, change, async () => { throw error; }), value => value === error);
  assert.deepEqual(item, before); assert.equal('undoneAt' in change, false);
});

test('failure merges rollback with user edits and removes only this undo revision', async () => {
  const { state, item, change } = fixture(); const gate = pending();
  const operation = Review.undoDurably(state, change, gate.save);
  item.content = 'User edit while saving'; item.userEditedAt = 99; item.updatedAt = 99;
  item.revisionHistory.push({ content: 'Subsequent user revision', savedAt: 99 });
  gate.reject(Error('disk failed')); await assert.rejects(operation, /disk failed/);
  assert.equal(item.content, 'User edit while saving'); assert.equal(item.title, 'Agent title');
  assert.equal(item.userEditedAt, 99); assert.equal(item.updatedAt, 99);
  assert.deepEqual(item.revisionHistory, [{ content: 'Subsequent user revision', savedAt: 99 }]);
});

test('later deletion of an updated file remains deleted after failed undo', async () => {
  const { state, item, change } = fixture(); const gate = pending();
  const operation = Review.undoDurably(state, change, gate.save);
  state.notes = []; const deletion = { id: 'user-trash', data: { notes: [structuredClone(item)] } }; state.trash.push(deletion);
  gate.reject(Error('disk failed')); await assert.rejects(operation);
  assert.deepEqual(state.notes, []); assert.deepEqual(state.trash, [deletion]);
});

test('restored or replaced same-ID file is not overwritten after failed undo', async () => {
  for (const created of [false, true]) {
    const { state, change } = fixture(created); const gate = pending();
    const operation = Review.undoDurably(state, change, gate.save);
    const replacement = { id: 'n', title: 'Restored later', content: 'New owner', updatedAt: 99 }; state.notes = [replacement];
    gate.reject(Error('disk failed')); await assert.rejects(operation);
    assert.equal(state.notes[0], replacement); assert.equal(replacement.content, 'New owner'); assert.deepEqual(state.trash, []);
  }
});

test('new-note undo failure restores its position and links without removing unrelated trash', async () => {
  const { state, item, change } = fixture(true); const before = structuredClone(item); state.notes.unshift({ id: 'first' }); state.notes.push({ id: 'last' });
  const gate = pending(), operation = Review.undoDurably(state, change, gate.save);
  const unrelated = { id: 'other-trash', data: { notes: [{ id: 'other' }] } }; state.trash.push(unrelated);
  const newerLink = { id: 'unrelated-link', sourceId: 'a', targetId: 'b' }; state.links.push(newerLink);
  gate.reject(Error('disk failed')); await assert.rejects(operation);
  assert.deepEqual(state.notes.map(note => note.id), ['first', 'n', 'last']); assert.deepEqual(state.notes[1], before);
  assert.deepEqual(state.trash, [unrelated]); assert.equal(state.links.length, 2); assert.ok(state.links.includes(newerLink));
});

test('a second deletion of a newly-created file remains in trash on rollback', async () => {
  const { state, change } = fixture(true); const gate = pending(), operation = Review.undoDurably(state, change, gate.save);
  const later = { id: 'later-delete', data: { notes: [{ id: 'n', content: 'User version' }] } }; state.trash.push(later);
  gate.reject(Error('disk failed')); await assert.rejects(operation);
  assert.deepEqual(state.notes, []); assert.deepEqual(state.trash, [later]); assert.deepEqual(state.links, []);
});

test('a consumed undo tombstone is not re-created if its restored note was deleted again', async () => {
  const { state, change } = fixture(true); const gate = pending(), operation = Review.undoDurably(state, change, gate.save);
  state.trash = [];
  gate.reject(Error('disk failed')); await assert.rejects(operation);
  assert.deepEqual(state.notes, []); assert.deepEqual(state.trash, []);
});

test('import metadata edits made while saving survive failure', async () => {
  const { state, item, change } = fixture(false, 'import'); const gate = pending(), operation = Review.undoDurably(state, change, gate.save);
  item.name = 'User filename'; item.folderPath = 'user folder';
  gate.reject(Error('disk failed')); await assert.rejects(operation);
  assert.equal(item.name, 'User filename'); assert.equal(item.folderPath, 'user folder'); assert.equal(item.updatedAt, 2);
});

test('false save result is a failed undo and duplicate undo never calls save twice', async () => {
  const one = fixture(); await assert.rejects(Review.undoDurably(one.state, one.change, async () => false), /成功保存/);
  assert.equal(one.item.content, 'Agent edit');
  const two = fixture(), gate = pending(); let saves = 0;
  const operation = Review.undoDurably(two.state, two.change, () => { saves++; return gate.save(); });
  await assert.rejects(Review.undoDurably(two.state, two.change, () => { saves++; }), /已经撤销/);
  assert.equal(saves, 1); gate.resolve(true); await operation;
});
