// Repeated identical tool calls get an advisory reminder on the model-facing
// result before the hard stop. No model, network or workspace.
const test = require('node:test'), assert = require('node:assert/strict');
const Guard = require('../app/tool-loop-guard.js'), S = require('../app/tool-scheduler.js');

test('reminder starts two calls before the stop and counts down to it', () => {
  const request = { type: 'browser_snapshot', tabId: 't' };
  assert.equal(Guard.reminder(request, 0), '');
  assert.equal(Guard.reminder(request, 1), '');
  // With LIMIT 4: the 3rd call may still run and warns that one more is allowed.
  assert.match(Guard.reminder(request, 2), /已用相同参数执行 3 次/); assert.match(Guard.reminder(request, 2), /最多还能相同调用 1 次/);
  assert.match(Guard.reminder(request, 3), /再次相同调用将停止本轮/);
  assert.equal(Guard.reminder(null, 5), '');
});

function withGuard(fn) {
  const before = global.ToolLoopGuard; global.ToolLoopGuard = Guard;
  return Promise.resolve().then(fn).finally(() => { if (before === undefined) delete global.ToolLoopGuard; else global.ToolLoopGuard = before; });
}

test('the scheduler attaches the reminder to the returned result, not to the durable record', () => withGuard(async () => {
  const request = { type: 'browser_snapshot', tabId: 'tab-1' };
  const run = { toolCalls: Array.from({ length: 2 }, (_, i) => ({ id: 'prior' + i, request, status: 'completed' })) };
  const scheduler = S.create({ run, execute: async () => ({ status: 'ok', snapshot: 'page' }) });
  const [result] = await scheduler.batch([request]);
  assert.match(result.loopNotice, /已用相同参数执行 3 次/);
  const entry = run.toolCalls.at(-1);
  assert.equal(entry.status, 'completed');
  assert.equal(JSON.stringify(entry).includes('loopNotice'), false);
}));

test('different parameters, siblings and the first calls get no reminder; the stop still applies', () => withGuard(async () => {
  const request = { type: 'browser_snapshot', tabId: 'tab-1' };
  const run = { toolCalls: Array.from({ length: 3 }, (_, i) => ({ id: 'prior' + i, request, status: 'completed' })) };
  const scheduler = S.create({ run, execute: async () => ({ status: 'ok' }) });
  const [other] = await scheduler.batch([{ type: 'browser_snapshot', tabId: 'tab-2' }]);
  assert.equal(other.loopNotice, undefined);
  const child = S.create({ run, parentId: 'child', execute: async () => ({ status: 'ok' }) });
  const [sibling] = await child.batch([request]);
  assert.equal(sibling.loopNotice, undefined);
  const [fourth] = await scheduler.batch([request]);
  assert.match(fourth.loopNotice, /再次相同调用将停止本轮/);
  await assert.rejects(scheduler.batch([request]), { code: 'REPEATED_TOOL' });
}));

test('through the real tool loop, a repeated live observation carries the reminder to the model', () => withGuard(async () => {
  const K = require('../app/knowledge-access.js');
  const run = { toolCalls: [] }, asks = [];
  const scheduler = S.create({ run, execute: async () => ({ status: 'ok', snapshot: 'unchanged page' }) });
  const snapshot = JSON.stringify({ knowledgeRequests: [{ type: 'browser_snapshot', tabId: 'tab-1' }], actions: [] });
  const final = JSON.stringify({ message: 'done', actions: [] });
  const output = await K.continuePlan(snapshot, { batch: scheduler.batch, finalize: () => null,
    ask: async text => { asks.push(text); return asks.length < 3 ? snapshot : final; } });
  assert.equal(output, final);
  assert.equal(run.toolCalls.length, 3);
  // Browser observations are live, so each round really runs; the third warns.
  assert.doesNotMatch(asks[1], /已用相同参数执行/);
  assert.match(asks[2], /已用相同参数执行 3 次/);
}));
