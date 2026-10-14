const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const F = require('../app/file-context');

const context = keys => ({ version: 1, keys, source: { kind: 'notes', id: 'a', conversationId: 'origin' } });
const note = id => ({ id, title: `Synthetic ${id}`, content: `Body ${id}`, workspace: '科研', kind: 'note' });
const fixture = conversation => ({ projects: [], imports: [], notes: [note('a'), note('b')],
  conversations: [{ id: 'origin', messages: [] }, conversation] });
const root = path.resolve(__dirname, '..');
const python = `import json,sys,tempfile
sys.path.insert(0,'app')
from sync_store import SyncStore,project
payload=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='aibro-context-roundtrip-') as directory:
 store=SyncStore(directory)
 source=payload['snapshot']
 changes=[{'entityType':kind,'entityId':id,'version':1,'deleted':False,'data':data} for (kind,id),data in project(source).items()]
 store.apply_changes(changes,len(changes))
 snapshot=store.snapshot()
 # Restore only this synthetic Mac's device-local reference snapshots. They do
 # not arrive over the wire, and must not become portable membership authority.
 originals={c['id']:c for c in source.get('conversations',[])}
 for c in snapshot.get('conversations',[]):
  old=originals[c['id']]
  for key in ('draftFileReferences','excludedFileReferenceKeys'):
   if key in old:c[key]=old[key]
  messages={m['id']:m for m in old.get('messages',[])}
  for m in c.get('messages',[]):
   for key in ('fileReferences','retryFileReferences'):
    if key in messages.get(m['id'],{}):m[key]=messages[m['id']][key]
 store.capture(snapshot)
 if 'incomingContext' in payload:
  snapshot=store.snapshot();c=next(c for c in snapshot['conversations'] if c['id']=='chat')
  incoming=project({'conversations':[{**c,'mobileContext':payload['incomingContext']}]})[('conversations','chat')]
  store.apply_changes([{'entityType':'conversations','entityId':'chat','version':2,'deleted':False,'data':incoming}],len(changes)+1)
 snapshot=SyncStore(directory).snapshot()
 print(json.dumps({'snapshot':snapshot,'wire':[{'kind':kind,'id':id,'data':data} for (kind,id),data in project(snapshot).items()]}))
`;
function roundtrip(snapshot, incomingContext) {
  return JSON.parse(execFileSync('python3', ['-B', '-c', python], { cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    input: JSON.stringify({ snapshot, ...(incomingContext === undefined ? {} : { incomingContext }) }), encoding: 'utf8' }));
}
async function phoneView(result) {
  const { restoreConversationContext } = await import(pathToFileURL(path.join(root, 'mobile/src/conversation-context.js')));
  const records = Object.fromEntries(result.wire.map(({ kind, id, data }) => [`${kind}:${id}`, { data, deleted: false }]));
  return restoreConversationContext({ records }, records['conversations:chat'].data);
}

// These fixtures cross the actual Mac projection/SQLite assembly and mobile
// reader. They do not run an App, server, model, existing QA suite or real data.
test('Mac staging on a legacy conversation creates portable membership readable on mobile', async () => {
  const c = { id: 'chat', messages: [] };
  F.stage(c, { type: 'note', id: 'a', title: 'A', version: 'v1' });
  assert.deepEqual(c.mobileContext.keys, ['notes:a']);
  assert.equal(c.mobileContext.source, null);
  const result = roundtrip(fixture(c));
  assert.deepEqual((await phoneView(result)).keys, ['notes:a']);
  assert.equal((await phoneView(result)).unavailableCount, 0);
});

test('Mac remove A and stage B survive consume, SQLite projection and mobile restore while source A stays independent', async () => {
  const a = { type: 'note', id: 'a', version: 'old-a' }, b = { type: 'note', id: 'b', version: 'new-b' };
  const c = { id: 'chat', mobileContext: context(['notes:a']), messages: [{ id: 'old', role: 'user', text: 'Old turn', fileReferences: [a] }] };
  F.remove(c, a); F.stage(c, b);
  const refs = F.references(c);
  c.messages.push({ id: 'new', role: 'user', text: 'New turn', fileReferences: refs }); F.consume(c, refs);
  assert.deepEqual(F.references(c).map(ref => ref.id), ['b']);
  const result = roundtrip(fixture(c)), mobile = await phoneView(result);
  assert.deepEqual(mobile.keys, ['notes:b']);
  assert.deepEqual(mobile.source, context([]).source);
  assert.deepEqual(F.references(result.snapshot.conversations.find(item => item.id === 'chat')).map(ref => ref.id), ['b']);
});

test('explicit mobile empty selection wins over retained Mac history and drafts, while retry keeps its own snapshot', async () => {
  const a = { type: 'note', id: 'a', version: 'old-a' };
  const c = { id: 'chat', mobileContext: context(['notes:a']), draftFileReferences: [a],
    messages: [{ id: 'old', role: 'user', text: 'Old Mac turn', fileReferences: [a] }] };
  const result = roundtrip(fixture(c), context([])), restored = result.snapshot.conversations.find(item => item.id === 'chat');
  assert.deepEqual(restored.mobileContext.keys, []);
  assert.deepEqual(F.references(restored), []);
  assert.deepEqual(F.references(restored, { retry: true, message: restored.messages[0] }), [a]);
  assert.deepEqual((await phoneView(result)).keys, []);
  assert.deepEqual((await phoneView(result)).source, context([]).source);
});

test('a mobile re-selection overrides stale Mac exclusion while local paths never cross the projection', async () => {
  const a = { type: 'note', id: 'a', version: 'old-a' };
  const local = { type: 'local', candidateId: 'synthetic-folder', projectId: 'synthetic-project', path: 'private-local.txt', version: 'local-v1' };
  const c = { id: 'chat', mobileContext: context(['notes:a']), messages: [] };
  F.remove(c, a); F.stage(c, local);
  const result = roundtrip(fixture(c), context(['notes:a']));
  const restored = result.snapshot.conversations.find(item => item.id === 'chat');
  assert.deepEqual(F.references(restored).filter(ref => ref.type !== 'local').map(ref => ref.id), ['a']);
  assert.deepEqual(F.references(restored).find(ref => ref.type === 'local'), local);
  assert.deepEqual((await phoneView(result)).keys, ['notes:a']);
  assert.doesNotMatch(JSON.stringify(result.wire), /private-local|synthetic-folder|local-v1/);
});

test('refresh updates selected Mac version without reviving a phone-removed portable identity', () => {
  const a = { type: 'note', id: 'a', version: 'old-a' }, b = { type: 'note', id: 'b', version: 'old-b' };
  const c = { id: 'chat', mobileContext: context(['notes:b']), messages: [{ id: 'old', role: 'user', fileReferences: [a, b] }] };
  F.refresh(c, { ...b, version: 'new-b' });
  assert.deepEqual(F.references(c).map(ref => [ref.id, ref.version]), [['b', 'new-b']]);
  assert.deepEqual(c.mobileContext.keys, ['notes:b']);
  assert.deepEqual(c.mobileContext.source, context([]).source);
  assert.deepEqual(c.messages[0].fileReferences, [a, b]);
});
