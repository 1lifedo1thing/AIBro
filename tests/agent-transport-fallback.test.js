/* 协议自动回退测试：企业 MaaS、中转网关等只实现一种协议，请求打到另一种时
   以 404/405/501，或以 503/400 附带“没有可服务该请求的端点/路由”说明的方式拒绝。
   本项目此前对未知地址一律先试 Responses，遇到只提供 Chat Completions 的网关
   （如校内 MaaS）就会失败。修复：自动判定模式下改用另一协议重试一次，成功即
   记住该来源，并把这次切换如实展示；用户显式选择或网页搜索开启时不回退。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, TextDecoder, URL, WorkstationCore: require('../app/workstation-core') });
  vm.runInContext(fs.readFileSync(require.resolve('../app/sse-frame-scanner'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../app/agent-transport'), 'utf8'), context);
  return context.AgentTransport;
}
const chatStream = events => new Response(new ReadableStream({ start(c) { for (const event of events) c.enqueue(new TextEncoder().encode(event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const chunk = (content, extra = {}) => ({ choices: [{ index: 0, delta: content ? { content } : {}, ...extra }] });
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MAAS_REJECTION = { data: null, message: 'No enabled endpoints are available after routing filters', success: false };

test('协议回退：Responses 失败且服务只提供 Chat 时自动重试一次并成功', async () => {
  const calls = [];
  const transport = harness(async (url, options) => {
    calls.push({ url: decodeURIComponent(url), body: JSON.parse(options.body) });
    if (calls.length === 1) return json(MAAS_REJECTION, 503);
    return chatStream([chunk('已改用 Chat 返回'), chunk('', { finish_reason: 'stop' }), '[DONE]']);
  });
  const activities = [];
  const output = await transport.requestPlan({ provider: 'api', base: 'https://maas.example.cn/v1', model: 'deepseek-v4.1-flash', token: 'sk-x', input: '你好', onActivity: activity => activities.push(activity) });
  assert.equal(calls.length, 2, '首次 Responses 失败后应重试一次');
  assert.match(calls[0].url, /\/responses$/, '首次按自动判定使用 Responses');
  assert.match(calls[1].url, /\/chat\/completions$/, '回退使用 Chat Completions');
  assert.equal(Object.hasOwn(calls[1].body, 'messages'), true, '回退请求体按 Chat 协议重建');
  assert.equal(Object.hasOwn(calls[1].body, 'input'), false);
  assert.match(output, /已改用 Chat 返回/, '回退成功后正常解析流式输出');
  assert.ok(activities.some(item => String(item.id).includes('protocol-fallback') && /已自动改用 Chat Completions/.test(item.text)), '必须把这次切换如实展示给用户，不得静默改写协议');
});

test('协议回退成功后记住该来源：后续请求直接使用 Chat，不再先失败一轮', async () => {
  const urls = [];
  const transport = harness(async (url) => {
    urls.push(decodeURIComponent(url));
    if (urls.length === 1) return json(MAAS_REJECTION, 503);
    return chatStream([chunk('ok'), '[DONE]']);
  });
  await transport.requestPlan({ provider: 'api', base: 'https://learn.example.cn/v1', model: 'm', input: 'x' });
  assert.equal(urls.length, 2, '第一次：Responses 失败 + Chat 成功');
  const output = await transport.requestPlan({ provider: 'api', base: 'https://learn.example.cn/v1', model: 'm', input: 'x' });
  assert.equal(urls.length, 3, '第二次只发一次请求');
  assert.match(urls[2], /\/chat\/completions$/, '已验证的协议直接生效');
  assert.equal(transport.protocolOf('api', 'https://learn.example.cn/v1', undefined), 'chat', '学到的协议参与后续判定');
  assert.equal(output, 'ok');
});

test('404 同样按协议不匹配处理并回退一次', async () => {
  const calls = [];
  const transport = harness(async (url) => {
    calls.push(decodeURIComponent(url));
    if (calls.length === 1) return json({ error: { message: 'Not Found' } }, 404);
    return chatStream([chunk('ok'), '[DONE]']);
  });
  await transport.requestPlan({ provider: 'api', base: 'https://nf.example.cn/v1', model: 'm', input: 'x' });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/chat\/completions$/);
});

test('与协议无关的 400（如模型不存在）不触发回退，避免无意义重试', async () => {
  const calls = [];
  const transport = harness(async (url) => {
    calls.push(decodeURIComponent(url));
    return json({ error: { message: "The model 'foo' does not exist" } }, 400);
  });
  await assert.rejects(transport.requestPlan({ provider: 'api', base: 'https://bad-model.example.cn/v1', model: 'foo', input: 'x' }), /does not exist/);
  assert.equal(calls.length, 1, '与协议无关的失败不得重试');
});

test('用户显式选择协议时不自动回退，但错误里给出可执行的切换指引', async () => {
  const calls = [];
  const transport = harness(async (url) => {
    calls.push(decodeURIComponent(url));
    return json(MAAS_REJECTION, 503);
  });
  await assert.rejects(
    transport.requestPlan({ provider: 'api', base: 'https://explicit.example.cn/v1', model: 'm', input: 'x', protocol: 'responses' }),
    error => /routing filters/.test(error.message) && /Chat Completions/.test(error.message) && /连接设置/.test(error.message)
  );
  assert.equal(calls.length, 1, '显式选择必须先被尊重，不得自动改写协议');
});

test('开启内置网页搜索时不自动回退（Chat 协议无法承载该能力）', async () => {
  const calls = [];
  const transport = harness(async (url) => {
    calls.push(decodeURIComponent(url));
    return json(MAAS_REJECTION, 503);
  });
  await assert.rejects(
    transport.requestPlan({ provider: 'api', base: 'https://api.openai.com/v1', model: 'm', input: 'x', webSearch: true }),
    /Chat Completions/
  );
  assert.equal(calls.length, 1, '网页搜索依赖 Responses，回退会改变能力语义');
});

test('两个协议都失败时如实报告两次失败，不隐瞒重试过程', async () => {
  const transport = harness(async (url) => {
    const isChat = decodeURIComponent(url).includes('chat/completions');
    return json({ message: isChat ? 'chat 通道同样不可用' : 'No enabled endpoints are available after routing filters' }, 503);
  });
  await assert.rejects(
    transport.requestPlan({ provider: 'api', base: 'https://both.example.cn/v1', model: 'm', input: 'x' }),
    error => /routing filters/.test(error.message) && /已按 Chat Completions 重试/.test(error.message) && /chat 通道同样不可用/.test(error.message)
  );
});

test('重启后沿用已学到的协议：configure 注入的持久化记录直接生效', async () => {
  const urls = [];
  const transport = harness(async (url) => { urls.push(decodeURIComponent(url)); return chatStream([chunk('ok'), '[DONE]']); });
  transport.configure({ learnedProtocols: { 'persist.example.cn': 'chat' } });
  assert.equal(transport.protocolOf('api', 'https://persist.example.cn/v1', undefined), 'chat', '注入记录参与判定');
  await transport.requestPlan({ provider: 'api', base: 'https://persist.example.cn/v1', model: 'm', input: 'x' });
  assert.match(urls[0], /\/chat\/completions$/, '首次请求即使用已验证协议，不再先失败一轮');
  assert.equal(transport.protocolOf('api', 'https://other.example.cn/v1', undefined), 'responses', '其他来源不受影响');
});

test('学到协议时通过回调通知宿主，供写入本地存储', async () => {
  const learned = [];
  const transport = harness(async (url) => {
    if (decodeURIComponent(url).includes('/responses')) return json(MAAS_REJECTION, 503);
    return chatStream([chunk('ok'), '[DONE]']);
  });
  transport.configure({ onProtocolLearned: (origin, protocol) => learned.push([origin, protocol]) });
  await transport.requestPlan({ provider: 'api', base: 'https://notify.example.cn/v1', model: 'm', input: 'x' });
  assert.deepEqual(learned, [['notify.example.cn', 'chat']], '宿主据此持久化，下次启动直接使用正确协议');
});
