const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../app/sse-frame-scanner'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../app/agent-transport'), 'utf8');
const DSML = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_page">\n<｜｜DSML｜｜ parameter name="recordType" string="true">import</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="id" string="true">fixture-pdf</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="page" string="false">4</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
const options = { base: 'https://api.deepseek.com/v1', model: 'fixture', input: 'Return a reviewed JSON plan.' };
function setup(fetch) {
  const context = vm.createContext({ fetch, URL, AbortController, TextDecoder, WorkstationCore: require('../app/workstation-core') });
  vm.runInContext(source, context);
  return context.AgentTransport;
}
const chunk = content => ({ choices: [{ index: 0, delta: { content } }] });
const completed = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
function events(items, { fragmentBytes = false } = {}) {
  const bytes = new TextEncoder().encode(items.map(item => `data: ${item === '[DONE]' ? item : JSON.stringify(item)}\n\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    if (fragmentBytes) for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function protocolFailure(error) {
  assert.equal(error.code, 'MODEL_PROTOCOL_ERROR');
  assert.equal(error.recoverable, true);
  assert.doesNotMatch(error.message, /fixture-pdf|string="false"/);
  return true;
}

test('bare DSML output is a recoverable protocol error, never a successful plan or executed call', async () => {
  const deltas = [], transport = setup(async () => events([chunk(DSML), completed, '[DONE]']));
  await assert.rejects(transport.requestPlan({ ...options, onDelta: value => deltas.push(value) }), protocolFailure);
  assert.deepEqual(deltas, []);
});

test('split DSML tokens and UTF-8 bytes never leak tool arguments into onDelta', async () => {
  for (const fragments of [[DSML.slice(0, 3), DSML.slice(3, 9), DSML.slice(9)], [...DSML]]) {
    const deltas = [], transport = setup(async () => events([...fragments.map(chunk), completed, '[DONE]'], { fragmentBytes: true }));
    await assert.rejects(transport.requestPlan({ ...options, onDelta: value => deltas.push(value) }), protocolFailure);
    assert.ok(deltas.every(value => !/DSML|invoke|fixture-pdf/.test(value)));
  }
});

test('separator variants, malformed/unknown invocations and bare truncated tokens cannot complete', async () => {
  for (const output of [DSML.replaceAll('｜｜', '|'), DSML.replaceAll('｜｜', '｜'), '<||DSML|| invoke name="erase_everything">', '<｜DSML｜ calls', '<｜DSML', '<||DSM', '<||', '读取下一页。\n' + DSML, '{"message":"complete","actions":[]}\n' + DSML]) {
    const transport = setup(async () => events([chunk(output), completed, '[DONE]']));
    await assert.rejects(transport.requestPlan(options), protocolFailure);
  }
});

test('protocol examples in fenced code, block quotes, inline prose and JSON strings stay ordinary text', async () => {
  for (const output of ['DSML 使用 `<｜DSML｜ calls>` 表示调用。', '示例：\n```xml\n' + DSML + '\n```', '~~~xml\n' + DSML + '\n~~~', DSML.split('\n').map(line => '> ' + line).join('\n'), JSON.stringify({ message: '下面解释协议：\n' + DSML, actions: [] }), JSON.stringify({ message: 'quote: "\\\n' + DSML, actions: [] }, null, 2)]) {
    const deltas = [], transport = setup(async () => events([...output].map(chunk).concat(completed, '[DONE]')));
    assert.equal(await transport.requestPlan({ ...options, onDelta: value => deltas.push(value) }), output);
    assert.equal(deltas.at(-1), output);
  }
});

test('non-stream Chat, Responses and plain text bodies use the same protocol guard', async () => {
  for (const [body, type] of [[JSON.stringify({ choices: [{ message: { content: DSML }, finish_reason: 'stop' }] }), 'application/json'], [JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: DSML }] }] }), 'application/json'], [DSML, 'text/plain']]) {
    const deltas = [], transport = setup(async () => new Response(body, { headers: { 'content-type': type } }));
    await assert.rejects(transport.requestPlan({ ...options, onDelta: value => deltas.push(value) }), protocolFailure);
    assert.deepEqual(deltas, []);
  }
});

test('Responses delta, output_text.done and completed-only snapshots cannot bypass the guard', async () => {
  for (const sequence of [[{ type: 'response.output_text.delta', delta: DSML }, { type: 'response.completed' }], [{ type: 'response.output_text.done', text: DSML }, { type: 'response.completed' }], [{ type: 'response.completed', response: { status: 'completed', output_text: DSML } }]]) {
    const deltas = [], transport = setup(async () => events(sequence));
    await assert.rejects(transport.requestPlan({ ...options, protocol: 'responses', onDelta: value => deltas.push(value) }), protocolFailure);
    assert.deepEqual(deltas, []);
  }
});

test('unwired Chat tool_calls/function_call are rejected even with an apparent final answer', async () => {
  for (const choice of [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_page', arguments: '{"id":"fixture-pdf"}' } }] } }, { delta: { function_call: { name: 'unknown' } } }, { delta: { content: 'done' }, finish_reason: 'tool_calls' }, { message: { content: 'done', tool_calls: [{ type: 'function', function: { name: 'read_page' } }] } }]) {
    for (const streamed of [true, false]) {
      const deltas = [], payload = { choices: [{ index: 0, ...choice }] };
      // Non-stream responses use message, never delta.
      if (!streamed && choice.delta) payload.choices[0].message = choice.delta;
      const transport = setup(async () => streamed ? events([payload, '[DONE]']) : new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }));
      await assert.rejects(transport.requestPlan({ ...options, onDelta: value => deltas.push(value) }), protocolFailure);
      assert.deepEqual(deltas, []);
    }
  }
});

test('strict plan requests reject unexecuted Responses host calls and argument-only events', async () => {
  for (const event of [{ type: 'response.output_item.added', item: { type: 'function_call', id: 'call', name: 'read_page', arguments: '{}' } }, { type: 'response.function_call_arguments.delta', delta: '{}' }, { type: 'response.custom_tool_call_input.done', input: 'arbitrary' }]) {
    const transport = setup(async () => events([event, { type: 'response.completed', response: { output_text: 'done' } }]));
    await assert.rejects(transport.requestPlan({ ...options, protocol: 'responses', requirePlanProtocol: true }), protocolFailure);
  }
});

test('valid JSON knowledge requests pass unchanged; transport never translates or executes DSML', async () => {
  const output = JSON.stringify({ knowledgeRequests: [{ type: 'read_page', recordType: 'import', id: 'fixture-pdf', page: 4 }], actions: [] });
  const transport = setup(async () => events([chunk(output), completed, '[DONE]']));
  assert.equal(await transport.requestPlan({ ...options, requirePlanProtocol: true }), output);
  assert.equal(transport.inspectProtocolOutput(output), null);
});

test('failed or incomplete streams never turn protocol contamination into completion', async () => {
  for (const terminal of [{ type: 'response.failed', response: { error: { message: 'provider failed' } } }, { type: 'response.incomplete' }, null]) {
    const transport = setup(async () => events([{ type: 'response.output_text.delta', delta: DSML }, ...(terminal ? [terminal] : [])]));
    await assert.rejects(transport.requestPlan({ ...options, protocol: 'responses' }), protocolFailure);
  }
});

test('a protocol error releases/cancels the reader and performs no automatic network retry', async () => {
  let calls = 0, cancelled = 0, released = 0, reads = 0;
  const transport = setup(async () => {
    calls++;
    return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({
      read: async () => ({ done: false, value: new TextEncoder().encode(reads++ ? 'data: [DONE]\n\n' : 'data: ' + JSON.stringify(chunk(DSML)) + '\n\n') }),
      cancel() { cancelled++; return Promise.resolve(); }, releaseLock() { released++; }
    }) } };
  });
  await assert.rejects(transport.requestPlan(options), protocolFailure);
  assert.equal(calls, 1); assert.equal(cancelled, 1); assert.equal(released, 1);
});
