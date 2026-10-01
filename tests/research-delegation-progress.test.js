const test = require('node:test');
const assert = require('node:assert/strict');
require('../app/tool-scheduler');
const D = require('../app/research-delegation');
const K = require('../app/knowledge-access');

const fixture = () => ({ projects: [{ id: 'p' }], notes: [{ id: 'a', projectId: 'p', content: 'Synthetic fact' }] });

test('child delegation enters the activity feed under a name and settles into a verifiable summary', async () => {
  const events = []; let turns = 0;
  const result = await D.execute({ task: 'Analyze a', title: 'Evidence' }, {
    state: fixture(), scope: { projectId: 'p' }, run: {}, entry: { id: 'child' },
    read: request => K.execute(fixture(), { projectId: 'p' }, request),
    progress: event => events.push(event),
    ask: async () => (++turns === 1
      ? JSON.stringify({ knowledgeRequests: [{ type: 'read', id: 'a' }], actions: [] })
      : JSON.stringify({ message: 'Evidence from a: Synthetic fact', actions: [] }))
  });
  assert.equal(result.verified, false);
  assert.equal(events[0].id, 'delegate:child');
  assert.equal(events[0].status, 'running');
  assert.match(events[0].name, /研究子代理 · Evidence/);
  assert.match(events[0].text, /子问题：Analyze a/);
  assert.ok(events.some(event => event.status === 'running' && /已读取 1 处来源/.test(event.text)), '进度应反映已读取的来源数');
  const settled = events.at(-1);
  assert.equal(settled.status, 'completed');
  assert.match(settled.text, /Evidence from a/);
  assert.match(settled.text, /待核验/, '结论摘要必须保留待核验标注');
  assert.ok(settled.text.length <= 240, '段文本遵守既有长度上限');
});

test('a refused child write reports failure instead of a success segment', async () => {
  const events = [];
  await assert.rejects(D.execute({ task: 'bad' }, {
    state: fixture(), scope: { projectId: 'p' }, run: {}, entry: { id: 'c' },
    progress: event => events.push(event),
    ask: async () => JSON.stringify({ message: 'written', actions: [], fileEdits: [{ path: 'x' }] })
  }), /写入/);
  const settled = events.at(-1);
  assert.equal(settled.status, 'failed');
  assert.match(settled.text, /子代理失败/);
  assert.equal(events.some(event => event.status === 'completed'), false, '被拒绝的子代理不得留下成功段');
});

test('a stopped child reports a cancelled segment and the delegation record stays truthful', async () => {
  const events = []; const run = {};
  await assert.rejects(D.execute({ task: 'stop me' }, {
    state: fixture(), scope: { projectId: 'p' }, run, entry: { id: 'c' },
    progress: event => events.push(event),
    ask: async () => { throw Object.assign(new Error('子代理已停止'), { code: 'CANCELLED' }); }
  }), { code: 'CANCELLED' });
  assert.equal(events.at(-1).status, 'cancelled');
  assert.equal(run.delegations[0].status, 'cancelled');
});

test('delegations without a progress sink stay silent and keep the existing contract', async () => {
  const result = await D.execute({ task: 'Analyze a', title: 'Evidence' }, {
    state: fixture(), scope: { projectId: 'p' }, run: {}, entry: { id: 'child' },
    ask: async () => JSON.stringify({ message: 'Evidence from a', actions: [] })
  });
  assert.equal(result.type, 'delegate');
  assert.equal(result.message, 'Evidence from a');
});
