const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const F = require('../app/file-context');
const K = require('../app/knowledge-access');

const context = (keys = ['notes:source', 'imports:file']) => ({ version: 1, keys,
  source: { kind: 'notes', id: 'source', conversationId: 'origin' } });
function fixture() {
  return { projects: [{ id: 'p', workspace: '科研' }, { id: 'other', workspace: '课程' }],
    notes: [{ id: 'source', title: '合成手机资料', content: '这是需要在 Mac 继续讨论的正文', projectId: 'other' },
      { id: 'not-selected', content: '其他资料不可因跨项目引用而自动加入', projectId: 'other' }],
    imports: [{ id: 'file', name: '合成附件.txt', content: '附件索引', projectId: 'other' }],
    conversations: [{ id: 'origin' }], agentRuns: [], trash: [] };
}

test('mobile references are strict, bounded, identifier-only and fail closed as one selection', () => {
  assert.deepEqual(F.sourceRefs(context()), [{ type: 'note', id: 'source' }, { type: 'import', id: 'file' }]);
  assert.deepEqual(F.sourceRefs(context(['notes:source', 'notes:source'])), [{ type: 'note', id: 'source' }]);
  assert.deepEqual(F.references({ messages: [] }), []);
  for (const raw of [null, {}, { ...context(), version: 2 }, { ...context(), source: undefined },
    context(['tasks:x']), context(['notes:../../path']), context(['notes:x', false]), context(['imports:' + 'a'.repeat(201)]),
    context(Array(51).fill('notes:x')), { ...context(), content: 'not portable' },
    { ...context(), source: { kind: 'notes', id: 'source', localPath: '/synthetic/path' } }])
    assert.throws(() => F.references({ mobileContext: raw }), { code: 'CONVERSATION_CONTEXT_INVALID' });
});

test('exclusion, explicit refresh, consume and retry keep their existing precedence after JSON reload', async () => {
  const s = fixture(), c = { mobileContext: context(), messages: [] };
  const first = await F.libraryRef(s, 'note', 'source');
  c.messages.push({ role: 'user', fileReferences: [first] });
  assert.equal(F.references(c)[0].version, first.version);
  F.remove(c, first);
  assert.deepEqual(F.references(JSON.parse(JSON.stringify(c))), [{ type: 'import', id: 'file' }]);
  assert.deepEqual(F.references(c, { retry: true, message: c.messages[0] }), [first]);
  s.notes[0].content = '用户显式更新后的正文';
  const latest = await F.libraryRef(s, 'note', 'source');
  F.refresh(c, latest);
  assert.equal(F.references(c).find(ref=>ref.id==='source').version, latest.version);
  const refs = F.references(c);
  c.messages.push({ role: 'user', fileReferences: refs }); F.consume(c, refs);
  const restored = JSON.parse(JSON.stringify(c));
  assert.equal(F.references(restored).find(ref=>ref.id==='source').version, latest.version);
  assert.equal(restored.draftFileReferences.length, 0);
  // Retrying a pre-reference message never inherits newer mobile selections.
  assert.deepEqual(F.references(c, { retry: true, message: { role: 'user' } }), []);
  assert.deepEqual(c.mobileContext, context(['imports:file','notes:source']));
});

test('actual Mac prepare reads selected phone note and import without local filesystem access or sibling scope', async () => {
  const state = fixture(), refs = F.references({ mobileContext: context(), messages: [] });
  const prepared = await F.prepare(state, refs, { readLocal() { throw Error('Must not access local paths'); } });
  assert.equal(prepared.initial[0].text, state.notes[0].content);
  assert.equal(prepared.initial[1].delivery, 'original_attachment');
  assert.deepEqual(prepared.snapshots.map(({ type, id }) => ({ type, id })), refs);
  const scope = { projectId: 'p', workspace: '科研', explicitReferences: prepared.snapshots };
  assert.equal((await K.execute(state, scope, { type: 'read', recordType: 'note', id: 'source' })).text, state.notes[0].content);
  await assert.rejects(K.execute(state, scope, { type: 'read', recordType: 'note', id: 'not-selected' }), /范围/);
  assert.deepEqual(K.records(state, scope), []);
});

test('missing, private, archived and ambiguous current sources reject reads instead of dropping references', async () => {
  for (const alter of [s => { s.notes = []; }, s => { s.notes[0].archived = true; }, s => { s.notes[0].private = true; },
    s => { s.notes[0].provenance = { origin: { private: true } }; },
    s => { s.notes[0].sourceConversationId = 'origin'; s.conversations[0].ephemeral = true; },
    s => { s.notes[0].agentRunId = 'private-run'; s.trash = [{ data: { agentRuns: [{ id: 'private-run', private: true }] } }]; },
    s => { s.projects[1].private = true; }, s => { s.notes.push({ ...s.notes[0] }); }]) {
    const state = fixture(); alter(state);
    const refs = F.references({ mobileContext: context(['notes:source']) });
    assert.equal(refs.length, 1);
    await assert.rejects(F.prepare(state, refs), /可读|删除|归档/);
  }
  const state = fixture(), prepared = await F.prepare(state, F.sourceRefs(context(['notes:source'])));
  state.notes[0].private = true;
  await assert.rejects(prepared.read({ refKey: F.key({ type: 'note', id: 'source' }), offset: 0 }), /可读/);
});

test('mobile-shaped cloud operation survives real Mac SQLite and is consumed by production FileContext', async () => {
  // Invoke the production Python projection/storage in a disposable directory,
  // then feed its actual saved snapshot to the production Mac reference reader.
  const code = `import json,sys,tempfile
sys.path.insert(0,'app')
from cloud_server import CloudStore
from sync_store import SyncStore
data=json.loads(sys.stdin.read())
with tempfile.TemporaryDirectory(prefix='aibro-reference-handoff-') as directory:
 store=SyncStore(directory)
 changes=[]
 for kind in ('projects','notes','imports','conversations'):
  for item in data.get(kind,[]):
   operation=CloudStore.validate_operation({'opId':kind+'-'+item['id'],'entityType':kind,'entityId':item['id'],'baseVersion':0,'deleted':False,'data':item})
   changes.append({'entityType':kind,'entityId':item['id'],'data':operation['data'],'version':1,'deleted':False})
 store.apply_changes(changes,len(changes))
 snapshot=store.snapshot()
 next(c for c in snapshot['conversations'] if c['id']=='discussion')['messages'].append({'id':'mac-followup','role':'user','text':'继续讨论'})
 store.capture(snapshot)
 print(json.dumps(SyncStore(directory).snapshot(),ensure_ascii=False))
`;
  const input = fixture(); input.conversations.push({ id: 'discussion', title: '合成跨端资料讨论', projectId: 'p', mobileContext: context() });
  const snapshot = JSON.parse(execFileSync('python3', ['-c', code], { cwd: path.resolve(__dirname, '..'), input: JSON.stringify(input), encoding: 'utf8' }));
  const conversation = snapshot.conversations.find(c => c.id === 'discussion');
  assert.deepEqual(conversation.mobileContext, context());
  assert.equal(conversation.messages[0].text, '继续讨论');
  const prepared = await F.prepare(snapshot, F.references(conversation));
  assert.equal(prepared.initial[0].text, input.notes[0].content);
  assert.equal(prepared.initial[1].type, 'import');
});
