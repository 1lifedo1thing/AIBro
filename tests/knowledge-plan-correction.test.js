// A malformed tool batch is returned to the model once as a correctable error,
// with nothing in it executed. Pure module test: no model, network or workspace.
const test = require('node:test'), assert = require('node:assert/strict'), K = require('../app/knowledge-access');
const pdfRequests = count => Array.from({ length: count }, (_, i) => ({ type: 'read_page', recordType: 'import', id: 'synthetic-pdf', page: i + 1 }));
const toolPlan = knowledgeRequests => JSON.stringify({ knowledgeRequests, actions: [] });
const finalPlan = JSON.stringify({ message: 'done', actions: [] });

test('without a correction budget an invalid batch still fails before any tool runs', async () => {
  let calls = 0;
  await assert.rejects(K.continuePlan(toolPlan([{ type: 'read_page', id: 'x', offset: -1 }]), { execute: async () => { calls++; }, ask: async () => { calls++; } }), { code: 'INVALID_KNOWLEDGE_REQUESTS' });
  assert.equal(calls, 0);
});

test('one invalid batch is returned to the model; the corrected batch then runs normally', async () => {
  const sensitive = 'synthetic private request body', asks = [], executed = [], corrections = [];
  const output = await K.continuePlan(toolPlan([{ type: 'read', id: 'a' }, { type: 7, body: sensitive }]), {
    planCorrections: 1, onCorrection: info => corrections.push(info),
    execute: async request => { executed.push(request.id); return { type: 'note', id: request.id, text: 'Evidence', nextOffset: null }; },
    ask: async (text, blocks) => { asks.push({ text, blocks }); return asks.length === 1 ? toolPlan([{ type: 'read', id: 'a' }]) : finalPlan; },
    finalize: () => null,
  });
  assert.equal(output, finalPlan);
  // The first valid item did not run before the correction: the batch is atomic.
  assert.deepEqual(executed, ['a']);
  assert.equal(corrections.length, 1); assert.equal(corrections[0].code, 'INVALID_KNOWLEDGE_REQUESTS');
  assert.match(asks[0].text, /本批全部未执行/); assert.match(asks[0].text, /第 2 项无效/);
  // The correction describes positions and counts only, never the model's text.
  assert.doesNotMatch(asks[0].text, /private|synthetic|body/);
});

test('a second invalid batch after the correction fails with the original error', async () => {
  let asks = 0, calls = 0;
  await assert.rejects(K.continuePlan(toolPlan([{ type: '' }]), {
    planCorrections: 1, execute: async () => { calls++; },
    ask: async () => { asks++; return toolPlan([null]); },
  }), error => error.code === 'INVALID_KNOWLEDGE_REQUESTS' && error.knowledgeDiagnostic.invalidIndices[0] === 0);
  assert.equal(asks, 1); assert.equal(calls, 0);
});

test('an oversized batch with a non-splittable operation asks for a split', async () => {
  const asks = [], seen = [];
  const output = await K.continuePlan(toolPlan([...pdfRequests(32), { type: 'terminal', argv: ['private argument'] }]), {
    planCorrections: 1,
    batch: async chunk => { seen.push(...chunk.map(r => r.type)); return chunk.map(r => ({ type: 'import', id: r.id, page: r.page, text: 'p' + r.page, nextOffset: null })); },
    ask: async text => { asks.push(text); return asks.length === 1 ? toolPlan(pdfRequests(2)) : finalPlan; },
    finalize: () => null,
  });
  assert.equal(output, finalPlan);
  assert.match(asks[0], /KNOWLEDGE_BATCH_REQUIRES_SPLIT/); assert.match(asks[0], /第 33 项/); assert.doesNotMatch(asks[0], /private|argv/);
  assert.ok(!seen.includes('terminal'));
});

test('a correction in a later round keeps the evidence view the model last saw', async () => {
  const asks = [];
  await K.continuePlan(toolPlan([{ type: 'read', id: 'a' }]), {
    planCorrections: 1,
    execute: async request => ({ type: 'note', id: request.id, text: 'Retained evidence text', nextOffset: null }),
    ask: async (text, blocks) => { asks.push({ text, blocks }); return asks.length === 1 ? toolPlan('not an array') : finalPlan; },
    finalize: () => null,
  });
  assert.equal(asks.length, 2);
  assert.match(asks[0].text, /Retained evidence text/);
  // The correction request repeats that view and appends the notice.
  assert.ok(asks[1].text.startsWith(asks[0].text)); assert.match(asks[1].text, /knowledgeRequests 必须是数组/);
  assert.deepEqual(asks[1].blocks, asks[0].blocks);
});
