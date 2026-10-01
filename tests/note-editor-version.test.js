const test = require('node:test');
const assert = require('node:assert/strict');
const Editor = require('../app/note-editor.js');
const reorder = value => JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().reverse().map(key => [key, item[key]])) : item));
const initial = () => ({ notes: [{ id: 'n', title: 'Title', content: '\uFEFF# 内容\r\n😀', createdAt: 1, updatedAt: 2,
  provenance: { run: { id: 'r', provider: 'fixture' }, output: { id: 'o', variant: 'body' } },
  revisionHistory: [{ title: 'Before', content: 'Before body', updatedAt: 0, savedAt: 1, sourceAttachmentIds: ['b', 'a'] }],
  aiDraft: { title: 'Proposed', content: 'Proposed body', provenance: { output: { id: 'new', variant: 'draft' }, run: { id: 'new-run', provider: 'fixture' } } },
  wikiSourceLinks: { z: { id: 'z', title: 'Z' }, a: { id: 'a', title: 'A' } }
}] });

test('version signatures ignore recursive object order without changing raw strings or ordered arrays', () => {
  const state = initial(), sorted = reorder(state);
  assert.equal(Editor.begin(state, 'n').base, Editor.begin(sorted, 'n').base);
  const session = Editor.begin(state, 'n'); session.content += '\nmanual';
  const change = Editor.prepare(sorted, session);
  assert.equal(change.after.content, '\uFEFF# 内容\r\n😀\nmanual');
  assert.deepEqual(change.after.revisionHistory[0].sourceAttachmentIds, ['b', 'a']);
  for (const mutate of [
    note => { note.content = note.content.replace('\r\n', '\n'); },
    note => { note.revisionHistory[0].sourceAttachmentIds.reverse(); },
    note => { note.aiDraft.provenance.run.id = 'another'; },
    note => { note.provenance.run.provider = 'changed'; },
    note => { note.wikiSourceLinks.a.title = 'changed'; }
  ]) {
    const changed = reorder(state); mutate(changed.notes[0]);
    assert.throws(() => Editor.prepare(changed, session), /其他操作修改/);
  }
});

test('legacy raw versions require all 14 fields, not only matching title and body', () => {
  const state = initial(), session = Editor.begin(state, 'n'); session.content += '\ndraft';
  session.base = Editor.legacyBases(state, 'n')[0];
  assert.equal(Editor.prepare(reorder(state), session).changed, true);
  const parsed = JSON.parse(session.base); parsed[13].run.id = 'wrong-origin';
  assert.throws(() => Editor.prepare(state, { ...session, base: JSON.stringify(parsed) }), /其他操作修改/);
  parsed.pop(); const incomplete = JSON.stringify(parsed);
  assert.equal(Editor.normalizeBase(incomplete), incomplete);
  assert.throws(() => Editor.prepare(state, { ...session, base: incomplete }), /其他操作修改/);
  assert.equal(Editor.normalizeBase('sha256:' + 'a'.repeat(64)), 'sha256:' + 'a'.repeat(64));
});

test('selected AI draft remains selected after nested key sorting and preserves its own provenance', () => {
  const state = initial(), session = Editor.begin(state, 'n'), proposal = state.notes[0].aiDraft;
  session.content = proposal.content; session.title = proposal.title;
  session.appliedAiDraft = JSON.stringify(proposal); // Marker made before this fix.
  const change = Editor.prepare(reorder(state), session);
  assert.equal(change.after.aiDraft, undefined);
  assert.equal(change.after.provenance.run.id, 'new-run');
  assert.equal(change.after.provenance.output.variant, 'body');
  assert.equal(change.after.revisionHistory.at(-1).provenance.run.id, 'r');
});

test('all retired lifecycle markers and ambiguous identities block begin and stale prepare without mutating a draft', () => {
  const fixture = () => ({ projects: [{ id: 'p' }], notes: [{ id: 'n', projectId: 'p', title: 'Current', content: 'Saved', updatedAt: 1 }] });
  const mutations = [
    ...['notes', 'projects'].flatMap(collection => [
      { archived: true }, { archivedAt: 123 }, { deleted: true }, { deletedAt: 123 }, { status: 'archived' }, { status: 'deleted' }
    ].map(marker => state => Object.assign(state[collection][0], marker))),
    state => state.notes.push({ ...state.notes[0] }),
    state => state.projects.push({ ...state.projects[0] })
  ];
  for (const mutate of mutations) {
    const state = fixture(), session = Editor.begin(state, 'n'); session.content = 'My unsaved draft';
    mutate(state);
    const before = JSON.stringify(state), draft = JSON.stringify(session);
    assert.throws(() => Editor.begin(state, 'n'), /删除|归档|身份不明确/);
    assert.throws(() => Editor.legacyBases(state, 'n'), /删除|归档|身份不明确/);
    assert.throws(() => Editor.prepare(state, session), /删除|归档|身份不明确/);
    assert.equal(JSON.stringify(state), before); assert.equal(JSON.stringify(session), draft);
  }
});

test('ordinary unassigned notes remain editable without inventing a project dependency', () => {
  for (const projectId of [undefined, null, '']) {
    const state = { notes: [{ id: 'n', projectId, title: 'Unassigned', content: 'Saved' }] };
    const session = Editor.begin(state, 'n'); session.content = 'Changed';
    assert.equal(Editor.prepare(state, session).after.content, 'Changed');
  }
});

test('only explicit adoption records the exact proposal receipt and preserves earlier review history', () => {
  const state = initial(), proposal = state.notes[0].aiDraft;
  state.notes[0].aiDraftHistory = [{ action: 'discard', reviewedAt: 3, draft: { content: 'Earlier' } }];
  const session = Editor.begin(state, 'n'); session.content = proposal.content + '\nMy refinement';
  const human = Editor.prepare(state, session, 10);
  assert.deepEqual(human.after.aiDraftHistory, state.notes[0].aiDraftHistory);
  assert.deepEqual(human.after.aiDraft, proposal);
  session.appliedAiDraft = JSON.stringify(proposal);
  const adopted = Editor.prepare(reorder(state), session, 11);
  assert.deepEqual(adopted.after.aiDraftHistory, [state.notes[0].aiDraftHistory[0], { action: 'adopt', reviewedAt: 11, draft: proposal }]);
  assert.equal(adopted.after.aiDraft, undefined);
  assert.equal(adopted.after.content, proposal.content + '\nMy refinement');
  adopted.after.aiDraftHistory[1].draft.content = 'Must not change original';
  assert.equal(state.notes[0].aiDraft.content, proposal.content);
  assert.equal(state.notes[0].aiDraftHistory.length, 1, 'prepare is only a plan until persistence is requested');
});
