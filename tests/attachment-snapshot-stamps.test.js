const assert = require('node:assert/strict');
const C = require('../app/workstation-core.js');

// Runs used to store the full JSON body of every in-scope attachment in
// `attachmentSnapshots` (~700 KB per run; tens of MB per workspace). The delete guard
// only asks "did this attachment change since the plan was read?", so it reads a content
// stamp now. These assertions lock both halves: the size drop AND the guard semantics.

function fixture() {
  return {
    projects: [{ id: 'p', name: '科研', workspace: '科研', archived: false }],
    imports: [
      { id: 'a1', name: '论文A.pdf', projectId: 'p', workspace: '科研', archived: false, dataUrl: 'data:application/pdf;base64,' + 'A'.repeat(4000) },
      { id: 'a2', name: '论文B.pdf', projectId: 'p', workspace: '科研', archived: false }
    ],
    tasks: [], notes: [], links: [], conversations: [], trash: [], agentRuns: []
  };
}
const context = (s, snapshots) => ({ projectId: 'p', workspace: '科研', attachmentSnapshots: snapshots ?? C.attachmentSnapshots(s, { projectId: 'p', workspace: '科研' }) });

// ① Stamps are deterministic, content-sensitive and length-sensitive.
assert.equal(C.contentStamp('abc'), C.contentStamp('abc'), '同一输入必须得到同一指纹');
assert.notEqual(C.contentStamp('abc'), C.contentStamp('abd'), '内容变化必须改变指纹');
assert.notEqual(C.contentStamp('abc'), C.contentStamp('abc '), '长度变化必须改变指纹');
assert.match(C.contentStamp('abc'), /^v1-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);

// ② Snapshots carry stamps, never bodies.
const snaps = C.attachmentSnapshots(fixture(), { projectId: 'p', workspace: '科研' });
assert.deepEqual(Object.keys(snaps).sort(), ['a1', 'a2']);
Object.values(snaps).forEach(value => {
  assert.ok(!value.includes('论文A') && !value.includes('论文B'), '快照不得包含资料正文');
  assert.ok(!value.includes('data:'), '快照不得包含二进制正文');
  assert.ok(value.startsWith('v1-'), '快照必须是内容指纹');
});
const stampBytes = Buffer.byteLength(JSON.stringify(snaps));
assert.ok(stampBytes < 300, `两个资料的快照必须极小（实际 ${stampBytes} 字节）`);

// ③ Guard: unchanged attachment is deletable.
{
  const s = fixture();
  const result = C.applyPlan(s, [{ type: 'delete_attachment', attachmentId: 'a1' }], context(s));
  assert.equal(result.state.trash.length, 1, '未变化的资料应当允许删除');
}

// ④ Guard: changed attachment is refused.
{
  const s = fixture();
  const ctx = context(s);
  s.imports[0].name = '用户改过的名字.pdf';
  assert.throws(() => C.applyPlan(s, [{ type: 'delete_attachment', attachmentId: 'a1' }], ctx), /发生变化/, '被改过的资料必须拒绝删除');
}

// ⑤ Legacy rows (full JSON bodies) keep working — the migration is not a prerequisite.
{
  const legacy = fixture();
  const legacySnaps = {};
  legacy.imports.forEach(item => { legacySnaps[item.id] = JSON.stringify(item); });
  const ok = fixture();
  assert.equal(C.applyPlan(ok, [{ type: 'delete_attachment', attachmentId: 'a2' }], context(ok, legacySnaps)).state.trash.length, 1, '旧格式快照在内容未变时必须放行');
  const changed = fixture();
  changed.imports[1].name = '被改过.pdf';
  assert.throws(() => C.applyPlan(changed, [{ type: 'delete_attachment', attachmentId: 'a2' }], context(changed, legacySnaps)), /发生变化/, '旧格式快照在内容变化时必须拦截');
}

// ⑥ Migration rewrites legacy rows, is idempotent, and preserves guard semantics.
{
  const s = fixture();
  s.agentRuns = [{ id: 'run1', attachmentSnapshots: { a1: JSON.stringify(s.imports[0]), a2: JSON.stringify(s.imports[1]) } }];
  const before = JSON.stringify(s).length;
  assert.equal(C.migrateAttachmentSnapshots(s), 2, '应改写两条旧格式快照');
  assert.equal(C.migrateAttachmentSnapshots(s), 0, '再次迁移必须无操作（幂等）');
  assert.ok(JSON.stringify(s).length < before, '迁移后体积必须下降');
  const migrated = s.agentRuns[0].attachmentSnapshots;
  const ok = fixture();
  assert.equal(C.applyPlan(ok, [{ type: 'delete_attachment', attachmentId: 'a1' }], context(ok, migrated)).state.trash.length, 1, '迁移后的指纹必须放行未变化的资料');
  const changed = fixture();
  changed.imports[0].name = '变了.pdf';
  assert.throws(() => C.applyPlan(changed, [{ type: 'delete_attachment', attachmentId: 'a1' }], context(changed, migrated)), /发生变化/, '迁移后的指纹必须拦截已变化的资料');
}

// ⑦ Migration tolerates malformed shapes.
const weird = { agentRuns: [null, {}, { attachmentSnapshots: null }, { attachmentSnapshots: [1, 2] }] };
assert.equal(C.migrateAttachmentSnapshots(weird), 0);
assert.equal(C.migrateAttachmentSnapshots(null), 0);

console.log('✓ attachment snapshot stamps: 全部通过');
