/* Chat Completions 协议测试：多数 OpenAI 兼容服务（DeepSeek、Moonshot、本地推理）
   只提供 /chat/completions，此前的实现一律请求 /responses 导致这些服务不可用。
   本测试覆盖协议判定、输入转换、请求构造、流式解析与不支持能力的显式拒绝。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, TextDecoder, URL, WorkstationCore: require('../app/workstation-core') });
  vm.runInContext(fs.readFileSync(require.resolve('../app/sse-frame-scanner'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../app/agent-transport'), 'utf8'), context);
  return context.AgentTransport;
}
const stream = events => new Response(new ReadableStream({ start(c) { for (const event of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
// chat 协议以下游自带的 [DONE] 标记收尾，缺少它整轮会被如实判定为不完整。
const chatStream = events => new Response(new ReadableStream({ start(c) { for (const event of events) c.enqueue(new TextEncoder().encode(event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const chunk = (content, extra = {}) => ({ choices: [{ index: 0, delta: content ? { content } : {}, ...extra }] });

test('协议判定：OpenAI 官方走 Responses，其余兼容服务走 Chat，显式选择与账号登录优先', () => {
  const { protocolOf } = harness(async () => { throw Error('unused'); });
  assert.equal(protocolOf('api', 'https://api.openai.com/v1', undefined), 'responses', 'OpenAI 官方域名保留 Responses');
  assert.equal(protocolOf('api', 'https://api.deepseek.com', undefined), 'chat', 'DeepSeek 使用 Chat Completions');
  assert.equal(protocolOf('api', 'https://api.deepseek.com/v1', undefined), 'chat', '带 /v1 的地址同样判定');
  assert.equal(protocolOf('api', 'http://127.0.0.1:11434/v1', undefined), 'chat', '本地推理服务使用 Chat Completions');
  assert.equal(protocolOf('api', 'http://192.168.1.50:8000/v1', undefined), 'chat', '私有网段的自建推理服务使用 Chat Completions');
  assert.equal(protocolOf('api', 'https://gateway.example.com/v1', undefined), 'responses', '未知网关保持 Responses，不因地址陌生改写既有行为');
  assert.equal(protocolOf('api', 'https://evil-deepseek.com/v1', undefined), 'responses', '相似域名不得误判为已知服务');
  assert.equal(protocolOf('api', 'https://api.openai.com/v1', 'chat'), 'chat', '用户的显式选择覆盖自动判定');
  assert.equal(protocolOf('api', 'https://api.deepseek.com', 'responses'), 'responses', '显式选择 Responses 时不被域名改写');
  assert.equal(protocolOf('openai-auth', 'https://api.deepseek.com', 'chat'), 'responses', 'OpenAI 账号登录始终走本地桥接的 Responses 通道');
  assert.equal(protocolOf('api', 'not a url', undefined), 'responses', '地址无效时保持原有 Responses 行为');
});

test('输入转换：字符串与附件块转为 chat messages，无法转换的附件必须显式失败', () => {
  const { chatMessages } = harness(async () => { throw Error('unused'); });
  const j = value => JSON.parse(JSON.stringify(value)); // vm 沙箱对象跨 realm，按序列化结果比较
  assert.deepEqual(j(chatMessages('hello')), [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(j(chatMessages([{ role: 'user', content: [{ type: 'input_text', text: '第一段' }, { type: 'input_text', text: '第二段' }] }])), [{ role: 'user', content: '第一段\n第二段' }], '纯文本拼成字符串，兼容性最好');
  assert.deepEqual(j(chatMessages([{ role: 'user', content: [{ type: 'input_text', text: '看图' }, { type: 'input_image', image_url: 'https://x/y.png', detail: 'auto' }] }])), [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'auto' } }] }], '图片块转换为 image_url');
  assert.equal(chatMessages([{ role: 'developer', content: [{ type: 'input_text', text: 'x' }] }])[0].role, 'system', 'developer 角色映射为 system');
  assert.equal(chatMessages([{ role: 'assistant', content: [{ type: 'input_text', text: 'x' }] }])[0].role, 'assistant', 'assistant 角色保留');
  assert.throws(() => chatMessages([{ role: 'user', content: [{ type: 'input_file', filename: 'a.pdf', file_data: 'https://x/a' }] }]), /不支持以文件形式发送附件/, '无法无损转换的附件必须显式失败，不能静默丢弃');
});

test('Chat 协议：请求发往 /chat/completions 且以 messages 组织，chat SSE 可解析出正文', async () => {
  let request;
  const transport = harness(async (url, options) => { request = { url, body: JSON.parse(options.body) }; return chatStream([chunk('{"message":'), chunk('"完成","actions":[]}'), chunk('', { finish_reason: 'stop' }), '[DONE]']); });
  const output = await transport.requestPlan({ provider: 'api', base: 'https://api.deepseek.com', model: 'deepseek-chat', token: 'sk-x', input: '计划' });
  assert.match(decodeURIComponent(request.url), /\/chat\/completions/, 'DeepSeek 必须请求 chat/completions');
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '计划' }], '请求体使用 messages');
  assert.equal(request.body.stream, true);
  assert.equal(request.body.model, 'deepseek-chat');
  assert.equal(Object.hasOwn(request.body, 'input'), false, '不得混入 Responses 的 input 字段');
  assert.match(output, /完成/, 'chat 流式增量应可解析');
});

test('Chat 协议：推理档位使用 reasoning_effort，且不误发 responses 的 reasoning 字段', async () => {
  let request;
  const transport = harness(async (_url, options) => { request = JSON.parse(options.body); return chatStream([chunk('ok'), '[DONE]']); });
  await transport.requestPlan({ provider: 'api', base: 'https://api.deepseek.com', model: 'm', input: 'x', effort: 'high' });
  assert.equal(request.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(request, 'reasoning'), false, '不得把 Responses 的 reasoning 对象发给 chat 服务');
});

test('Chat 协议显式拒绝内置网页搜索，并给出可执行的切换指引', async () => {
  const transport = harness(async () => { throw Error('不应发起请求'); });
  await assert.rejects(transport.requestPlan({ provider: 'api', base: 'https://api.deepseek.com', model: 'm', input: 'x', webSearch: true }), /不支持内置网页搜索/);
});

test('显式选择 Responses 时仍按原协议构造请求（不因域名自动改写）', async () => {
  let request;
  const transport = harness(async (url, options) => { request = { url, body: JSON.parse(options.body) }; return stream([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed' }]); });
  await transport.requestPlan({ provider: 'api', base: 'https://example.test/v1', model: 'm', input: 'x', protocol: 'responses' });
  assert.equal(Object.hasOwn(request.body, 'input'), true, '显式 Responses 使用 input 字段');
  assert.equal(Object.hasOwn(request.body, 'messages'), false);
});

test('Chat 协议的 HTTP 错误提示指向接口协议设置，而不是只提 Responses', async () => {
  const transport = harness(async () => new Response(JSON.stringify({ error: { message: '' } }), { status: 404, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(transport.requestPlan({ provider: 'api', base: 'https://api.deepseek.com', model: 'm', input: 'x' }), /接口协议|404|接口不存在/);
});

test('Chat 协议：reasoning_content 明文思考独立成段，正文开始时收束（段级呼吸信号）', async () => {
  const seen = [];
  const transport = harness(async () => chatStream([
    { choices: [{ index: 0, delta: { reasoning_content: '先分析目标' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: '，再检索资料' } }] },
    chunk('（正文）'),
    chunk('', { finish_reason: 'stop' }),
    '[DONE]',
  ]));
  const output = await transport.requestPlan({ provider: 'api', base: 'https://api.deepseek.com', model: 'deepseek-reasoner', input: 'x', onActivity: activity => seen.push(activity) });
  const thinking = seen.filter(item => item.kind === 'summary');
  assert.ok(thinking.length >= 1, '思考必须作为独立段进入进度流（不能像现在这样被丢弃）');
  const text = thinking.map(item => item.text).join('');
  assert.match(text, /先分析目标/);
  assert.match(text, /再检索资料/);
  assert.ok(thinking.some(item => item.status === 'completed'), '正文开始后思考段必须收束，否则整轮都会展开着');
  assert.equal(output, '（正文）', '思考不得混入正文');
});

test('Chat 协议：思考与正文交替时各自成段，两段思考不合并', async () => {
  const seen = [];
  const transport = harness(async () => chatStream([
    { choices: [{ index: 0, delta: { reasoning_content: '第一段思考' } }] },
    chunk('答案'),
    { choices: [{ index: 0, delta: { reasoning_content: '第二段思考' } }] },
    chunk('续答'),
    '[DONE]',
  ]));
  await transport.requestPlan({ provider: 'api', base: 'https://api.deepseek.com', model: 'm', input: 'x', onActivity: activity => seen.push(activity) });
  const ids = new Set(seen.filter(item => item.kind === 'summary').map(item => item.id));
  assert.equal(ids.size, 2, '两段思考应各自成段（id 不同），不能把第二段并进第一段');
});
