'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FileContext = require('../app/file-context.js');
const ConversationContinuity = require('../app/conversation-continuity.js');
global.FileContext = FileContext;
global.ConversationContinuity = ConversationContinuity;
const Selection = require('../app/context-selection.js');

const copy = value => structuredClone(value);
const noteRef = (id = 'n1', version = 'old') => ({ type: 'note', id, title: id, version, projectId: 'p' });
const importRef = (id = 'i1') => ({ type: 'import', id, title: id, version: 'attachment-v1', projectId: 'p' });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let state = { projects: [{ id: 'p', name: 'Project' }], notes: [{ id: 'n1', projectId: 'p' }, { id: 'n2', projectId: 'p' }], imports: [{ id: 'i1', name: 'one.pdf', projectId: 'p' }, { id: 'i2', name: 'two.pdf', projectId: 'p' }], agentRuns: [], conversations: [{ id: 'c', projectId: 'p', draft: 'Keep my draft', messages: [], draftFileReferences: [], draftAttachmentIds: [], queuedMessages: [{ id: 'q1', text: 'Keep queued request' }] }] };
  let currentId = 'c', privateMode = false, preparing = false, saves = 0, rollbackCalls = 0;
  const changes = [], selected = [];
  const hooks = {
    getState: () => state,
    getConversation: () => state.conversations.find(item => item.id === currentId),
    isPrivate: () => privateMode,
    isPreparing: () => preparing,
    assertReady: options.assertReady || (() => {}),
    access: options.access || ((s, ref) => ({ available: ref.type === 'local' || !!s[ref.type === 'note' ? 'notes' : 'imports']?.some(item => item.id === ref.id && !item.private && !item.deletedAt) })),
    selectRef: async ref => { selected.push(copy(ref)); return options.selectRef ? options.selectRef(ref, api) : { ...ref, version: 'new' }; },
    save: async () => { saves++; return options.save ? options.save(api) : true; },
    onRollback: () => { rollbackCalls++; },
    onChange: () => changes.push(controller.isBusy()),
  };
  const controller = Selection.create(hooks);
  const api = { controller, changes, selected, get state() { return state; }, get conversation() { return state.conversations.find(item => item.id === 'c'); }, get saves() { return saves; }, get rollbackCalls() { return rollbackCalls; }, replace: value => { state = value; }, current: value => { currentId = value; }, private: value => { privateMode = value; }, preparing: value => { preparing = value; }, command: (action, ref = noteRef()) => controller.mutate(action === 'remove-attachment' ? { action, conversationId: 'c', id: ref.id } : { action, conversationId: 'c', ref }) };
  return api;
}

test('selection stays busy until durable acknowledgement, and a second request cannot interleave', async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise });
  let settled = false;
  const pending = f.command('add-reference').then(value => { settled = true; return value; });
  assert.equal(f.controller.isBusy(), true);
  assert.equal(f.saves, 1);
  assert.equal(FileContext.references(f.conversation).length, 1);
  await assert.rejects(f.command('add-reference', noteRef('n2')), /正在保存|still being saved/);
  await Promise.resolve(); assert.equal(settled, false);
  gate.resolve(true);
  assert.equal(await pending, true);
  assert.equal(f.controller.isBusy(), false);
  assert.deepEqual(f.changes, [true, false]);
});

test('failed save removes only its owned addition while keeping concurrent draft, references and queue changes', async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise });
  const pending = f.command('add-reference');
  f.conversation.draft = 'User typed while saving';
  FileContext.stage(f.conversation, noteRef('n2', 'concurrent'));
  f.conversation.queuedMessages.push({ id: 'q2', text: 'New queue item', fileReferences: [noteRef('n2')] });
  const queue = copy(f.conversation.queuedMessages);
  gate.reject(Error('disk full'));
  await assert.rejects(pending, /disk full/);
  assert.equal(f.conversation.draft, 'User typed while saving');
  assert.deepEqual(f.conversation.draftFileReferences, [noteRef('n2', 'concurrent')]);
  assert.deepEqual(f.conversation.queuedMessages, queue);
  assert.equal(f.rollbackCalls, 1);
  assert.equal(f.controller.isBusy(), false);
});

test('explicit false save response is a failure and restores absent properties', async () => {
  const f = fixture({ save: () => false }); delete f.conversation.draftFileReferences; delete f.conversation.excludedFileReferenceKeys;
  await assert.rejects(f.command('add-reference'), /未保存|not saved/);
  assert.equal(Object.hasOwn(f.conversation, 'draftFileReferences'), false);
  assert.equal(Object.hasOwn(f.conversation, 'excludedFileReferenceKeys'), false);
});

test('refresh changes only the next selection, preserving sent, retry and queued snapshots', async () => {
  const f = fixture(), sent = noteRef(), retry = noteRef('n1', 'retry-frozen');
  f.conversation.messages = [{ id: 'm', role: 'user', fileReferences: [sent], retryFileReferences: [retry] }];
  f.conversation.queuedMessages[0].fileReferences = [noteRef('n1', 'queue-frozen')];
  const messages = copy(f.conversation.messages), queue = copy(f.conversation.queuedMessages);
  await f.command('refresh-reference', sent);
  assert.equal(FileContext.references(f.conversation)[0].version, 'new');
  assert.deepEqual(f.conversation.messages, messages);
  assert.deepEqual(FileContext.references(f.conversation, { retry: true, message: f.conversation.messages[0] }), [retry]);
  assert.deepEqual(f.conversation.queuedMessages, queue);
});

test('remove import excludes historical continuation and removes draft attachment and reference; re-add restores selection', async () => {
  const f = fixture(), ref = importRef();
  f.conversation.messages = [{ id: 'm', role: 'user', text: 'Review these files', attachmentIds: ['i1'], fileReferences: [ref] }];
  f.conversation.draftAttachmentIds = ['i1', 'i2']; f.conversation.draftFileReferences = [ref];
  const messages = copy(f.conversation.messages);
  assert.ok(ConversationContinuity.build(f.state, f.conversation, { goal: '继续' }).attachmentIds.includes('i1'));
  await f.command('remove-attachment', ref);
  assert.deepEqual(f.conversation.draftAttachmentIds, ['i2']);
  assert.deepEqual(FileContext.references(f.conversation), []);
  assert.ok(!ConversationContinuity.build(f.state, f.conversation, { goal: '继续' }).attachmentIds.includes('i1'));
  assert.equal(ConversationContinuity.collect(f.state, f.conversation).ledger[0].status, 'excluded');
  assert.deepEqual(f.conversation.messages, messages);
  await f.command('add-reference', ref);
  assert.deepEqual(FileContext.references(f.conversation), [ref]);
  assert.ok(!f.conversation.excludedFileReferenceKeys.includes(FileContext.key(ref)));
  assert.ok(ConversationContinuity.build(f.state, f.conversation, { goal: '继续' }).attachmentIds.includes('i1'));
  assert.deepEqual(f.conversation.messages, messages);
});

test('a historical attachment carried by continuity can be removed even without a draft or file-reference entry', async () => {
  const f = fixture(); f.conversation.messages = [{ id: 'm', role: 'user', attachmentIds: ['i1'] }];
  assert.deepEqual(ConversationContinuity.build(f.state, f.conversation, { goal: '继续' }).attachmentIds, ['i1']);
  await f.command('remove-attachment', importRef());
  assert.deepEqual(ConversationContinuity.build(f.state, f.conversation, { goal: '继续' }).attachmentIds, []);
  assert.deepEqual(f.conversation.messages[0].attachmentIds, ['i1']);
});

test('failed removal restores only the selected import, preserving concurrently edited unrelated attachments and exclusions', async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise }), ref = importRef();
  f.conversation.draftFileReferences = [ref]; f.conversation.draftAttachmentIds = ['i1'];
  const pending = f.command('remove-attachment', ref);
  f.conversation.draftAttachmentIds.push('i2');
  f.conversation.excludedFileReferenceKeys.push(FileContext.key(noteRef('n2')));
  gate.reject(Error('offline')); await assert.rejects(pending, /offline/);
  assert.deepEqual(new Set(f.conversation.draftAttachmentIds), new Set(['i1', 'i2']));
  assert.deepEqual(f.conversation.draftFileReferences, [ref]);
  assert.deepEqual(f.conversation.excludedFileReferenceKeys, [FileContext.key(noteRef('n2'))]);
});

test('rollback preserves a newer concurrent version of the same reference', async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise });
  f.conversation.draftFileReferences = [noteRef()];
  const pending = f.command('refresh-reference');
  await Promise.resolve(); await Promise.resolve();
  FileContext.stage(f.conversation, noteRef('n1', 'concurrent-newer'));
  gate.reject(Error('offline')); await assert.rejects(pending, /offline/);
  assert.equal(FileContext.references(f.conversation)[0].version, 'concurrent-newer');
});

test('state replacement during failed persistence rolls back the current conversation object', async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise });
  const oldConversation = f.conversation, pending = f.command('add-reference');
  f.replace(copy(f.state)); f.conversation.draft = 'Draft on replacement state';
  FileContext.stage(f.conversation, noteRef('n2'));
  gate.reject(Error('disk full')); await assert.rejects(pending, /disk full/);
  assert.notEqual(f.conversation, oldConversation);
  assert.equal(f.conversation.draft, 'Draft on replacement state');
  assert.deepEqual(FileContext.references(f.conversation), [noteRef('n2')]);
});

test('owner, privacy, project and preparing changes while selecting a fresh version reject before any save', async t => {
  for (const [name, change] of [
    ['different current conversation', f => { f.state.conversations.push({ id: 'other' }); f.current('other'); }],
    ['global private mode', f => f.private(true)],
    ['conversation becomes ephemeral', f => { f.conversation.ephemeral = true; }],
    ['project becomes private', f => { f.state.projects[0].private = true; }],
    ['preparing message', f => f.preparing(true)],
    ['conversation archived', f => { f.conversation.archived = true; }],
    ['conversation deleted flag', f => { f.conversation.deleted = true; }],
    ['conversation deleted status', f => { f.conversation.status = 'deleted'; }],
  ]) await t.test(name, async () => {
    const gate = deferred(), f = fixture({ selectRef: () => gate.promise });
    f.conversation.draftFileReferences = [noteRef()];
    const pending = f.command('refresh-reference'); change(f); gate.resolve(noteRef('n1', 'new'));
    await assert.rejects(pending); assert.equal(f.saves, 0); assert.equal(f.controller.isBusy(), false);
    assert.deepEqual(f.conversation.draftFileReferences, [noteRef()]);
  });
});

test('source becomes unavailable while refreshing, leaving existing next-turn selection intact', async () => {
  const gate = deferred(), f = fixture({ selectRef: () => gate.promise }); f.conversation.draftFileReferences = [noteRef()];
  const pending = f.command('refresh-reference'); f.state.notes[0].private = true; gate.resolve(noteRef('n1', 'new'));
  await assert.rejects(pending, /不可用|unavailable/); assert.equal(f.saves, 0); assert.deepEqual(f.conversation.draftFileReferences, [noteRef()]);
});

test('failed version lookup leaves selection and retry history untouched without a rollback write', async () => {
  const f = fixture({ selectRef: () => { throw Error('local folder disconnected'); } });
  f.conversation.draftFileReferences = [noteRef()];
  f.conversation.messages = [{ role: 'user', fileReferences: [noteRef()], retryFileReferences: [noteRef('n1', 'retry')] }];
  const before = copy(f.conversation);
  await assert.rejects(f.command('refresh-reference'), /folder disconnected/);
  assert.deepEqual(f.conversation, before); assert.equal(f.saves, 0); assert.equal(f.rollbackCalls, 0);
  assert.equal(f.controller.isBusy(), false);
});

test('a failed refresh restores its previous draft version while keeping a concurrently added different source', async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise }); f.conversation.draftFileReferences = [noteRef()];
  const pending = f.command('refresh-reference');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.conversation.draftFileReferences[0].version, 'new');
  FileContext.stage(f.conversation, noteRef('n2', 'independent'));
  gate.reject(Error('offline')); await assert.rejects(pending, /offline/);
  assert.deepEqual(new Map(FileContext.references(f.conversation).map(ref => [ref.id, ref.version])), new Map([['n1', 'old'], ['n2', 'independent']]));
});

test('local reference refresh keeps the exact candidate and relative path while advancing only its next-use version', async () => {
  const f = fixture(), local = { type: 'local', candidateId: 'folder-1', path: 'notes/paper.md', projectId: 'p', version: 'old', title: 'paper.md' };
  f.conversation.messages = [{ role: 'user', fileReferences: [local] }];
  await f.command('refresh-reference', local);
  assert.deepEqual(FileContext.references(f.conversation), [{ ...local, version: 'new' }]);
  assert.deepEqual(f.conversation.messages[0].fileReferences, [local]);
  await f.command('remove-reference', local);
  assert.deepEqual(FileContext.references(f.conversation), []);
});

test('a concurrent selection change while selectRef is pending is not overwritten by a late version', async () => {
  const gate = deferred(), f = fixture({ selectRef: () => gate.promise }); f.conversation.draftFileReferences = [noteRef()];
  const pending = f.command('refresh-reference'); FileContext.stage(f.conversation, noteRef('n1', 'user-picked')); gate.resolve(noteRef('n1', 'late'));
  await assert.rejects(pending, /已经变化|changed/); assert.equal(f.saves, 0);
  assert.equal(FileContext.references(f.conversation)[0].version, 'user-picked');
});

test('selectRef may update content version but cannot substitute another reference identity', async () => {
  const f = fixture({ selectRef: () => noteRef('n2', 'new') }); f.conversation.draftFileReferences = [noteRef()];
  await assert.rejects(f.command('refresh-reference'));
  assert.equal(f.saves, 0); assert.deepEqual(f.conversation.draftFileReferences, [noteRef()]);
});

test('invalid action, missing identity and removing an unselected source do not persist', async () => {
  const f = fixture();
  for (const command of [null, { action: 'delete-source', conversationId: 'c', ref: noteRef() }, { action: 'add-reference', conversationId: 'c', ref: { type: 'note' } }, { action: 'add-reference', conversationId: 'c', ref: { type: 'local', candidateId: 'candidate' } }, { action: 'remove-reference', conversationId: 'c', ref: noteRef() }]) await assert.rejects(f.controller.mutate(command));
  assert.equal(f.saves, 0); assert.equal(f.controller.isBusy(), false); assert.deepEqual(f.changes, []);
});

test('non-string reference identities are rejected instead of creating impossible selections', async () => {
  const f = fixture({ access: () => ({ available: true }) });
  for (const ref of [{ type: 'note', id: {} }, { type: 'import', id: 7 }, { type: 'local', candidateId: {}, path: 'file.md' }, { type: 'local', candidateId: 'folder', path: ['file.md'] }]) await assert.rejects(f.command('add-reference', ref));
  assert.equal(f.saves, 0); assert.deepEqual(f.conversation.draftFileReferences, []);
});

test('duplicate conversation identities are rejected instead of selecting an arbitrary owner', async () => {
  const f = fixture(); f.state.conversations.push(copy(f.conversation));
  await assert.rejects(f.command('add-reference'));
  assert.equal(f.saves, 0); assert.ok(f.state.conversations.every(c => !c.draftFileReferences.length));
});

test('repeated add requests keep one next-turn reference and no duplicate exclusion entries', async () => {
  const f = fixture(); await f.command('add-reference'); await f.command('add-reference');
  assert.deepEqual(f.conversation.draftFileReferences, [noteRef()]);
  await f.command('remove-reference'); await f.command('add-reference');
  assert.deepEqual(f.conversation.draftFileReferences, [noteRef()]);
  assert.deepEqual(f.conversation.excludedFileReferenceKeys, []);
});
