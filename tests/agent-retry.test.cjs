// AgentRetry policy, and the real transport resending transient failures through a
// local HTTP fixture. No network beyond 127.0.0.1, no model, no workspace.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), vm = require('node:vm'), fs = require('node:fs');
const Retry = require('../app/agent-retry.js');

const failure = (code, extra = {}) => Object.assign(new Error(code), { code, receivedContent: false, ...extra });
const noWait = async () => {};

test('only transient failures with nothing received are retryable', () => {
  for (const code of ['RATE_LIMITED', 'UPSTREAM_SERVICE_ERROR', 'UPSTREAM_CONNECTION_ERROR', 'UPSTREAM_STREAM_INTERRUPTED', 'STREAM_INCOMPLETE', 'EMPTY_RESPONSE'])
    assert.equal(Retry.retryable(failure(code)), true, code);
  for (const code of ['QUOTA_EXHAUSTED', 'HTTP_UNAUTHORIZED', 'HTTP_FORBIDDEN', 'INVALID_REQUEST', 'CONTEXT_LENGTH_EXCEEDED', 'MODEL_PROTOCOL_ERROR', 'CONTENT_FILTER', 'OUTPUT_LIMIT', 'CANCELLED', 'MODEL_NOT_AVAILABLE'])
    assert.equal(Retry.retryable(failure(code)), false, code);
  // A diagnostic code wins over the transport's generic HTTP code.
  assert.equal(Retry.retryable(failure('HTTP', { diagnostic: { code: 'RATE_LIMITED' } })), true);
  assert.equal(Retry.retryable(failure('HTTP', { diagnostic: { code: 'QUOTA_EXHAUSTED' } })), false);
  // Anything already shown, or an unknown delivery state, is never resent.
  assert.equal(Retry.retryable(failure('RATE_LIMITED', { receivedContent: true })), false);
  assert.equal(Retry.retryable(failure('RATE_LIMITED', { receivedContent: undefined })), false);
  // A protocol mismatch belongs to the fallback path, not to retry.
  assert.equal(Retry.retryable(failure('UPSTREAM_SERVICE_ERROR', { protocolMismatch: true })), false);
});

test('run retries at most twice, reports each wait and records the attempt count', async () => {
  let calls = 0; const seen = [];
  await assert.rejects(Retry.run(async () => { calls++; throw failure('UPSTREAM_SERVICE_ERROR', { status: 503 }); }, { wait: noWait, random: () => 0.5, onRetry: info => seen.push(info) }),
    error => error.retryAttempts === 2 && /已自动重试 2 次/.test(error.message));
  assert.equal(calls, 3);
  assert.deepEqual(seen.map(info => [info.retry, info.maxRetries, info.delayMs, info.code, info.httpStatus]), [[1, 2, 1500, 'UPSTREAM_SERVICE_ERROR', 503], [2, 2, 3000, 'UPSTREAM_SERVICE_ERROR', 503]]);
});

test('a later success returns its value; non-transient failures are thrown at once', async () => {
  let calls = 0;
  assert.equal(await Retry.run(async () => { if (++calls < 3) throw failure('RATE_LIMITED'); return 'ok'; }, { wait: noWait }), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(Retry.run(async () => { calls++; throw failure('QUOTA_EXHAUSTED'); }, { wait: noWait }), error => error.code === 'QUOTA_EXHAUSTED' && error.retryAttempts === undefined);
  assert.equal(calls, 1);
});

test('Retry-After is honoured, and a wait longer than the cap is surfaced instead', async () => {
  const waits = [];
  let calls = 0;
  await Retry.run(async () => { if (++calls === 1) throw failure('RATE_LIMITED', { retryAfterMs: 4000 }); return 'ok'; }, { wait: async ms => waits.push(ms) });
  assert.deepEqual(waits, [4000]);
  calls = 0;
  await assert.rejects(Retry.run(async () => { calls++; throw failure('RATE_LIMITED', { retryAfterMs: Retry.MAX_WAIT_MS + 1 }); }, { wait: noWait }), { code: 'RATE_LIMITED' });
  assert.equal(calls, 1);
});

test('cancelling during a wait stops at once and sends nothing more', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = Retry.run(async () => { calls++; throw failure('UPSTREAM_SERVICE_ERROR'); }, { signal: controller.signal, random: () => 0.5 });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(calls, 1);
});

test('the failure description and details record the automatic retries', () => {
  const D = require('../app/run-failure-diagnostics.js');
  const shown = D.present({ version: 1, code: 'RATE_LIMITED', httpStatus: 429, retryAttempts: 2 });
  assert.match(shown.description, /已自动重试 2 次/);
  assert.ok(shown.details.some(item => item.label === '自动重试' && item.value === '已重试 2 次'));
  assert.equal(D.normalize({ version: 1, code: 'RATE_LIMITED', retryAttempts: 99 }).retryAttempts, undefined);
});

// The real transport, served by a local fixture standing in for a provider.
const transportSource = ['sse-frame-scanner', 'run-failure-diagnostics', 'agent-retry', 'agent-transport'].map(name => fs.readFileSync(require.resolve('../app/' + name), 'utf8')).join('\n');
const done = text => ({ type: 'response.completed', response: { status: 'completed', output_text: text } });
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')); };
const json = (res, value, status, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
async function fixture(t, respond) {
  const calls = [];
  const server = http.createServer(async (req, res) => { for await (const _ of req); calls.push(req.url); await respond(res, calls.length); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const address = 'http://127.0.0.1:' + server.address().port;
  // Fast virtual waits: the policy is covered above; here only the wiring matters.
  const timers = { setTimeout: fn => setImmediate(fn), clearTimeout: () => {} };
  const context = vm.createContext({ fetch: (url, options) => fetch(address + url, options), AbortController, TextDecoder, URL, Date, ...timers, WorkstationCore: require('../app/workstation-core') });
  vm.runInContext(transportSource, context);
  return { calls, transport: context.AgentTransport };
}
const options = { base: 'https://provider.invalid/v1', protocol: 'responses', model: 'fixture', input: 'read' };

test('the transport resends a 503 that returned nothing, and shows the retry in the process', async t => {
  const f = await fixture(t, (res, n) => n === 1 ? json(res, { error: { message: 'temporarily unavailable' } }, 503) : sse(res, [done('ok')]));
  const activity = [];
  assert.equal(await f.transport.requestPlan({ ...options, onActivity: item => activity.push(item) }), 'ok');
  assert.equal(f.calls.length, 2);
  const shown = activity.filter(item => item.name === '自动重试');
  assert.equal(shown.length, 1); assert.match(shown[0].text, /HTTP 503/); assert.match(shown[0].text, /第 1\/2 次/);
});

test('the transport reads Retry-After from a 429 and stops after two retries', async t => {
  const f = await fixture(t, res => json(res, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '2' }));
  const activity = [];
  await assert.rejects(f.transport.requestPlan({ ...options, onActivity: item => activity.push(item) }), error => error.diagnostic?.code === 'RATE_LIMITED' && error.retryAttempts === 2 && /已自动重试 2 次/.test(error.message));
  assert.equal(f.calls.length, 3);
  assert.ok(activity.filter(item => item.name === '自动重试').every(item => /2 秒后/.test(item.text)));
});

test('quota, authentication and a stream that already showed text are never resent', async t => {
  for (const [status, body] of [[429, { error: { code: 'insufficient_quota', message: 'quota' } }], [401, { error: { message: 'bad key' } }]]) {
    const f = await fixture(t, res => json(res, body, status));
    await assert.rejects(f.transport.requestPlan(options)); assert.equal(f.calls.length, 1, String(status));
  }
  const f = await fixture(t, res => sse(res, [{ type: 'response.output_text.delta', delta: 'partial' }]));
  await assert.rejects(f.transport.requestPlan(options), { code: 'STREAM_INCOMPLETE' });
  assert.equal(f.calls.length, 1);
});

test('a stream that finished with no output counts as a transient empty response', async t => {
  const f = await fixture(t, (res, n) => n === 1 ? sse(res, [done('')]) : sse(res, [done('second')]));
  assert.equal(await f.transport.requestPlan(options), 'second');
  assert.equal(f.calls.length, 2);
});
