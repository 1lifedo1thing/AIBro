'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Context = require('../app/queue-context.js'), Queue = require('../app/agent-queue.js'), Files = require('../app/file-context.js');
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(extra = {}) {
  const state = { settings: {}, conversations: [{ id: 'c', draft: 'untouched', draftAttachmentIds: ['composer-file'], draftFileReferences: [{ type: 'note', id: 'composer-note' }], skillIds: ['builtin-paper'] }],
    projects: [{ id: 'p', name: 'Visible project', localFolder: { id: 'root-p' } }, { id: 'hidden-project', name: 'Private project name', private: true, localFolder: { id: 'hidden-root' } }],
    notes: [{ id: 'n', title: 'Visible note', content: 'ORIGINAL_NOTE_BODY', projectId: 'p' }, { id: 'private', title: 'PRIVATE_NOTE_TITLE', content: 'PRIVATE_NOTE_BODY', private: true }, { id: 'private-parent', title: 'PRIVATE_PARENT_TITLE', content: 'PRIVATE_PARENT_BODY', projectId: 'hidden-project' }],
    imports: [{ id: 'f', name: 'visible.pdf', originalName: 'visible.pdf', size: 10, createdAt: 1 }, { id: 'hidden-file', name: 'PRIVATE_FILE_TITLE', private: true }],
    skills: [{ id: 'skill_one', command: 'one', name: 'First skill', description: 'Summary', instructions: 'ORIGINAL_SKILL_BODY', enabled: true }, { id: 'skill_disabled', command: 'disabled', name: 'Disabled skill', instructions: 'DISABLED_SKILL_BODY', enabled: false }, { id: 'skill_private', command: 'private', name: 'PRIVATE_SKILL_TITLE', instructions: 'PRIVATE_SKILL_BODY', private: true }] };
  const requests = [], service = extra.request || (async (url, body) => {
    requests.push({ url, body });
    if (url === '/__local/files') return { entries: [{ name: 'src', path: 'src', type: 'directory' }, { name: 'a.js', path: 'a.js', type: 'file', supported: true }, { name: 'image.png', path: 'image.png', type: 'file', supported: false }], nextOffset: 3 };
    return { path: body.path, version: 'local-v1', text: 'LOCAL_FILE_BODY_MUST_NOT_ENTER_DRAFT' };
  });
  const api = Context.create({ getState: () => state, getConversation: id => state.conversations.find(c => c.id === id), request: service, ...extra });
  const empty = () => Queue.snapshot({ goal: 'Do the work' });
  return { state, api, empty, requests };
}

test('catalog contains only accessible metadata and bound local roots, never source/skill bodies', () => {
  const { api } = fixture(), catalog = api.catalog('c');
  assert.deepEqual(catalog.materials.map(row => row.id).sort(), ['f', 'n']);
  assert.deepEqual(catalog.projects, [{ key: 'project:p', id: 'p', title: 'Visible project', candidateId: 'root-p' }]);
  assert.ok(catalog.skills.some(row => row.id === 'skill_one'));
  assert.ok(catalog.skills.every(row => !['skill_disabled', 'skill_private'].includes(row.id)));
  assert.doesNotMatch(JSON.stringify(catalog), /BODY|PRIVATE_.*TITLE|instructions|"content"/);
  assert.deepEqual(api.catalog('c', 'visible.pdf').materials.map(row => row.id), ['f']);
});

test('adding, replacing versions and removing library context is independent of composer and original snapshot', async () => {
  const { state, api, empty } = fixture(), conversation = structuredClone(state.conversations[0]), original = empty();
  const note = await api.mutate('c', original, { action: 'add-material', type: 'note', id: 'n' });
  assert.deepEqual(original.fileReferences, []); assert.equal(note.fileReferences[0].version, await Files.digest('ORIGINAL_NOTE_BODY'));
  assert.doesNotMatch(JSON.stringify(note), /ORIGINAL_NOTE_BODY|"content"/);
  let context = await api.mutate('c', note, { action: 'add-material', type: 'import', id: 'f' });
  assert.deepEqual(context.attachmentIds, ['f']); assert.equal(context.fileReferences.length, 2);
  const combined = api.inspect('c', context).materials.find(row => row.id === 'f');
  assert.equal(combined.attachment, true); assert.equal(combined.reference, true);
  assert.equal(api.inspect('c', context).materials.filter(row => row.id === 'f').length, 1);
  context = await api.mutate('c', context, combined.remove);
  assert.deepEqual(context.attachmentIds, []); assert.deepEqual(context.fileReferences.map(row => row.id), ['n']);
  assert.deepEqual(state.conversations[0], conversation);
});

test('explicit refresh updates changed note hash while add remains idempotent and check never changes the frozen reference', async () => {
  const { state, api, empty } = fixture();
  let context = await api.mutate('c', empty(), { action: 'add-material', type: 'note', id: 'n' }), initial = structuredClone(context);
  state.notes[0].content = 'NEW_NOTE_BODY';
  const same = await api.mutate('c', context, { action: 'add-material', type: 'note', id: 'n' }); assert.deepEqual(same, context);
  const checked = await api.check('c', context); assert.equal(checked.canSend, false); assert.equal(checked.materials[0].status, 'changed'); assert.deepEqual(context, initial);
  context = await api.mutate('c', context, checked.materials[0].refresh);
  assert.equal(context.fileReferences[0].version, await Files.digest('NEW_NOTE_BODY'));
  assert.equal((await api.check('c', context)).canSend, true);
});

test('removed and private references are redacted but still removable; private inherited ownership and duplicate identities are filtered', async () => {
  const { state, api, empty } = fixture();
  let context = await api.mutate('c', empty(), { action: 'add-material', type: 'note', id: 'n' });
  state.projects[0].private = true;
  const privateRow = api.inspect('c', context).materials[0]; assert.equal(privateRow.status, 'private'); assert.equal(privateRow.title, '私密来源'); assert.equal(privateRow.refresh, null);
  assert.doesNotMatch(JSON.stringify(privateRow), /Visible note|ORIGINAL_NOTE_BODY/);
  context = await api.mutate('c', context, privateRow.remove); assert.equal(context.fileReferences.length, 0);
  await assert.rejects(api.mutate('c', empty(), { action: 'add-material', type: 'note', id: 'private' }), { code: 'QUEUE_SOURCE_UNAVAILABLE' });
  state.projects[0].private = false; state.notes.push({ ...state.notes[0] }); assert.ok(!api.catalog('c').materials.some(row => row.id === 'n'));
  const missing = Queue.snapshot({ goal: 'repair', attachmentIds: ['gone'], fileReferences: [{ type: 'import', id: 'gone', title: 'Lost file' }] });
  const row = api.inspect('c', missing).materials[0]; assert.equal(row.status, 'missing'); assert.equal(api.inspect('c', missing).canSend, false);
  const fixed = await api.mutate('c', missing, row.remove); assert.deepEqual(fixed.attachmentIds, []); assert.deepEqual(fixed.fileReferences, []);
});

test('private conversation can remove old references but cannot add or browse sources', async () => {
  const { state, api, empty } = fixture(), context = await api.mutate('c', empty(), { action: 'add-material', type: 'note', id: 'n' });
  state.conversations[0].private = true; assert.deepEqual(api.catalog('c'), { materials: [], skills: [], projects: [] });
  assert.equal(api.inspect('c', context).materials[0].status, 'private');
  await assert.rejects(api.mutate('c', context, { action: 'add-material', type: 'note', id: 'n' }), { code: 'QUEUE_PRIVATE' });
  await assert.rejects(api.browse('c', { projectId: 'p' }), { code: 'QUEUE_PRIVATE' });
  assert.equal((await api.mutate('c', context, api.inspect('c', context).materials[0].remove)).fileReferences.length, 0);
});

test('skill selection freezes instructions, explicit refresh replaces them, and never mutates conversation defaults', async () => {
  const { state, api, empty } = fixture(), original = structuredClone(state.conversations[0]);
  let context = await api.mutate('c', empty(), { action: 'add-skill', id: 'skill_one' });
  state.skills[0].instructions = 'NEW_SKILL_BODY';
  const row = api.inspect('c', context).skills[0]; assert.equal(row.status, 'changed'); assert.equal(api.inspect('c', context).canSend, true);
  assert.doesNotMatch(JSON.stringify(row), /ORIGINAL_SKILL_BODY|NEW_SKILL_BODY|instructions/);
  assert.equal((await api.mutate('c', context, { action: 'add-skill', id: 'skill_one' })).skillSnapshot[0].instructions, 'ORIGINAL_SKILL_BODY');
  context = await api.mutate('c', context, row.refresh); assert.equal(context.skillSnapshot[0].instructions, 'NEW_SKILL_BODY');
  context = await api.mutate('c', context, row.remove); assert.deepEqual(context.skillSnapshot, []); assert.deepEqual(state.conversations[0], original);
});

test('disabled, deleted, private and globally disabled skills cannot be newly restored', async () => {
  const { state, api, empty } = fixture();
  for (const id of ['skill_disabled', 'skill_private', 'gone']) await assert.rejects(api.mutate('c', empty(), { action: 'add-skill', id }), { code: 'QUEUE_SKILL_UNAVAILABLE' });
  const context = await api.mutate('c', empty(), { action: 'add-skill', id: 'skill_one' }); state.skills[0].enabled = false;
  assert.equal(api.inspect('c', context).skills[0].status, 'disabled'); assert.equal(api.inspect('c', context).canSend, false);
  await assert.rejects(api.mutate('c', context, { action: 'refresh-skill', id: 'skill_one' }), { code: 'QUEUE_SKILL_UNAVAILABLE' });
  assert.equal((await api.mutate('c', context, { action: 'remove-skill', id: 'skill_one' })).skillSnapshot.length, 0);
  state.skills[0].enabled = true; state.settings.skillsEnabled = false; assert.deepEqual(api.catalog('c').skills, []);
  await assert.rejects(api.mutate('c', empty(), { action: 'add-skill', id: 'builtin-paper' }), { code: 'QUEUE_SKILL_UNAVAILABLE' });
});

test('local browsing paginates only authorized roots and returns metadata commands', async () => {
  const { api, requests } = fixture(), view = await api.browse('c', { projectId: 'p', path: '', offset: 2 });
  assert.deepEqual(requests[0], { url: '/__local/files', body: { candidateId: 'root-p', path: '', offset: 2 } });
  assert.equal(view.nextOffset, 3); assert.equal(view.entries[0].directory, true); assert.equal(view.entries[2].disabled, true);
  let context = await api.mutate('c', Queue.snapshot({ goal: 'Use local code' }), view.entries[1].add);
  assert.equal(context.fileReferences[0].version, 'local-v1'); assert.equal(api.inspect('c', context).materials[0].title, 'a.js');
  assert.doesNotMatch(JSON.stringify(context), /LOCAL_FILE_BODY|"text"/);
  context = await api.mutate('c', context, api.inspect('c', context).materials[0].remove); assert.equal(context.fileReferences.length, 0);
  for (const path of ['../outside', '/absolute', 'a/../outside', 'a\\outside', 'C:/outside']) await assert.rejects(api.browse('c', { projectId: 'p', path }), { code: 'QUEUE_PATH' });
  await assert.rejects(api.browse('c', { projectId: 'hidden-project' }), { code: 'QUEUE_SOURCE_UNAVAILABLE' });
});

test('local context rejects disconnected candidates and traversal before any service request', async () => {
  const { api, empty, requests } = fixture();
  for (const ref of [{ type: 'local', projectId: 'p', candidateId: 'wrong', path: 'a.js' }, { type: 'local', projectId: 'p', candidateId: 'root-p', path: '../secret' }])
    await assert.rejects(api.mutate('c', empty(), { action: 'add-material', type: 'local', ref }), { code: 'QUEUE_SOURCE_UNAVAILABLE' });
  assert.equal(requests.length, 0);
});

test('late local browse/read results cannot expose content after project becomes private or root changes', async () => {
  for (const operation of ['browse', 'read']) {
    const pending = defer(), { api, state, empty } = fixture({ request: () => pending.promise });
    const work = operation === 'browse' ? api.browse('c', { projectId: 'p' }) : api.mutate('c', empty(), { action: 'add-material', ref: { type: 'local', projectId: 'p', candidateId: 'root-p', path: 'a.js' } });
    if (operation === 'browse') state.projects[0].private = true; else state.projects[0].localFolder.id = 'replacement-root';
    pending.resolve({ entries: [{ path: 'PRIVATE_LATE_FILENAME', name: 'PRIVATE_LATE_FILENAME', type: 'file', supported: true }], version: 'v', text: 'PRIVATE_LATE_BODY' });
    await assert.rejects(work, { code: 'QUEUE_SOURCE_UNAVAILABLE' });
  }
});

test('version check failure remains explicit and retryable; no successful state is invented', async () => {
  let fail = false, version = 'v1';
  const { api, empty } = fixture({ request: async () => { if (fail) throw Error('offline'); return { version, text: 'body' }; } });
  const context = await api.mutate('c', empty(), { action: 'add-material', ref: { type: 'local', projectId: 'p', candidateId: 'root-p', path: 'a.js' } });
  fail = true; const failed = await api.check('c', context); assert.equal(failed.canSend, false); assert.equal(failed.materials[0].status, 'unavailable');
  fail = false; assert.equal((await api.check('c', context)).canSend, true);
  version = 'v2'; const changed = await api.check('c', context); assert.equal(changed.materials[0].status, 'changed');
  const refreshed = await api.mutate('c', context, changed.materials[0].refresh); assert.equal(refreshed.fileReferences[0].version, 'v2');
});

test('aborted local results do not populate selection or version cache', async () => {
  const pending = defer(), controller = new AbortController(), { api, empty } = fixture({ request: () => pending.promise });
  const context = empty(), work = api.mutate('c', context, { action: 'add-material', ref: { type: 'local', projectId: 'p', candidateId: 'root-p', path: 'a.js' } }, { signal: controller.signal });
  controller.abort(); pending.resolve({ version: 'v1' }); await assert.rejects(work, { code: 'CANCELLED' }); assert.deepEqual(context.fileReferences, []);
});

test('validate preserves unchanged invalid references for repair but rejects newly added hidden references and forged skill instructions', async () => {
  const { api, empty } = fixture(), invalid = { ...empty(), attachmentIds: ['gone'] };
  assert.deepEqual(await api.validate('c', { ...invalid, goal: 'Revised' }, { changedFrom: invalid }), { ...invalid, goal: 'Revised' });
  await assert.rejects(api.validate('c', { ...empty(), attachmentIds: ['hidden-file'] }, { changedFrom: empty() }), { code: 'QUEUE_SOURCE_UNAVAILABLE' });
  const skills = await api.mutate('c', empty(), { action: 'add-skill', id: 'skill_one' }); skills.skillSnapshot[0].instructions = 'FORGED';
  await assert.rejects(api.validate('c', skills, { changedFrom: empty() }), { code: 'QUEUE_SKILL_UNAVAILABLE' });
});

test('validation catches note changes and rejects an earlier source becoming private during a later async read', async () => {
  const pending = defer(); let hold = false;
  const { api, state, empty } = fixture({ request: () => hold ? pending.promise : Promise.resolve({ version: 'v1' }) });
  let context = await api.mutate('c', empty(), { action: 'add-material', type: 'note', id: 'n' });
  state.notes[0].content = 'CHANGED'; await assert.rejects(api.validate('c', context, { changedFrom: empty() }), { code: 'QUEUE_SOURCE_CHANGED' });
  context = await api.mutate('c', context, { action: 'refresh-material', type: 'note', id: 'n' });
  context = await api.mutate('c', context, { action: 'add-material', ref: { type: 'local', projectId: 'p', candidateId: 'root-p', path: 'a.js' } });
  hold = true; const work = api.validate('c', context, { changedFrom: empty() });
  await new Promise(resolve => setImmediate(resolve)); state.notes[0].private = true; pending.resolve({ version: 'v1' });
  await assert.rejects(work, { code: 'QUEUE_SOURCE_UNAVAILABLE' });
});

test('check cannot report ready when an earlier note changes while a later local version is being checked', async () => {
  const pending = defer(), entered = defer(); let hold = false;
  const { api, state, empty } = fixture({ request: () => { if (hold) { entered.resolve(); return pending.promise; } return Promise.resolve({ version: 'v1' }); } });
  let context = await api.mutate('c', empty(), { action: 'add-material', type: 'note', id: 'n' });
  context = await api.mutate('c', context, { action: 'add-material', ref: { type: 'local', projectId: 'p', candidateId: 'root-p', path: 'a.js' } });
  hold = true; const work = api.check('c', context); await entered.promise;
  state.notes[0].content = 'CHANGED_DURING_LATER_READ'; pending.resolve({ version: 'v1' });
  const view = await work; assert.equal(view.canSend, false); assert.equal(view.materials.find(row => row.id === 'n').status, 'changed');
});

test('no browser storage is used while complete context is edited, checked or validated', async () => {
  const previous = global.localStorage; global.localStorage = { getItem() { throw Error('must not read'); }, setItem() { throw Error('must not persist'); } };
  try {
    const { api, empty } = fixture(); let context = await api.mutate('c', empty(), { action: 'add-material', type: 'note', id: 'n' });
    context = await api.mutate('c', context, { action: 'add-skill', id: 'skill_one' });
    assert.equal((await api.check('c', context)).canSend, true); assert.deepEqual(await api.validate('c', context, { changedFrom: empty() }), context);
  } finally { if (previous === undefined) delete global.localStorage; else global.localStorage = previous; }
});
