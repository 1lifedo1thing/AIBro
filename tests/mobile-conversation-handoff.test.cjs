const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const { mount } = require('../app/mobile-conversation-handoff.js');

function fixture() {
  const { document, window } = parseHTML('<html><head></head><body><article><div class="message-body">真实正文</div></article></body></html>');
  return { document, window, wrapper: document.querySelector('article') };
}
function message(extra = {}) {
  return { role: 'assistant', content: '合成答复', text: '合成答复', status: 'completed', reasoning: '合成思考\n第二行',
    toolEvents: [{ type: 'tool-start', title: 'read', input: { key: 'notes/synthetic' } },
      { type: 'tool-result', title: 'read', output: { content: '合成来源内容' } }],
    pendingPlan: { id: 'synthetic-plan', status: 'pending' }, ...extra };
}

test('received reasoning and actual tool input/output use keyboard-native details with no execution controls', () => {
  const { wrapper } = fixture();
  const original = message(), before = JSON.stringify(original), body = wrapper.querySelector('.message-body');
  const result = mount(original, wrapper);
  assert.equal(wrapper.querySelector('.message-body'), body);
  assert.equal(JSON.stringify(original), before);
  assert.match(result.textContent, /思考记录.*合成思考\n第二行/);
  assert.match(result.textContent, /工具记录（2 条）.*read · 请求记录.*notes\/synthetic.*read · 结果记录.*合成来源内容/s);
  assert.match(result.textContent, /待在手机确认/);
  assert.equal(result.querySelectorAll('button,input,a,[role="button"],[aria-live]').length, 0);
  for (const detail of result.querySelectorAll('details')) {
    assert.equal(detail.firstElementChild.localName, 'summary');
    assert.equal(detail.hasAttribute('open'), false);
    assert.equal(detail.firstElementChild.hasAttribute('tabindex'), false);
  }
  for (const pre of result.querySelectorAll('pre')) assert.equal(pre.getAttribute('tabindex'), '0');
});

test('untrusted reasoning, tool payloads, errors, titles and status are literal text', () => {
  const { wrapper, document } = fixture();
  const attack = '<img src=x onerror="throw 1"><script>throw 2</script>';
  const result = mount(message({ reasoning: attack, status: attack, error: attack,
    toolEvents: [{ type: 'tool-result', title: attack, input: { value: attack }, output: attack, error: attack }] }), wrapper);
  assert.equal(result.querySelectorAll('img,script,iframe,svg').length, 0);
  assert.match(result.textContent, /<script>throw 2<\/script>/);
  assert.equal(result.querySelector('.message-reasoning pre').textContent, attack);
  assert.equal(document.querySelectorAll('style#mobile-conversation-handoff-style').length, 1);
});

test('remote running is a historical record and does not become local live progress', () => {
  const { wrapper } = fixture();
  const result = mount(message({ status: 'running', pendingPlan: null }), wrapper);
  assert.match(result.textContent, /其他设备记录：生成中。本机未在运行此任务/);
  assert.equal(result.querySelectorAll('.agent-progress,.live-message,[aria-busy],.spinner').length, 0);
});

test('invalidated, redacted and settled plans remain read-only and never look pending', () => {
  const { wrapper } = fixture();
  for (const [plan, pattern] of [
    [{ status: 'invalidated', invalidatedReason: 'conversation-message-edited' }, /对话内容已变化，方案已失效/],
    [{ status: 'invalidated', invalidatedReason: 'metadata-redacted' }, /方案记录不完整，方案已失效/],
    [{ status: 'applied' }, /手机方案记录：已应用/], [{ status: 'rejected' }, /手机方案记录：已拒绝/]
  ]) {
    const result = mount(message({ pendingPlan: plan }), wrapper);
    assert.match(result.textContent, pattern);
    assert.doesNotMatch(result.textContent, /待在手机确认/);
    assert.equal(result.querySelectorAll('button').length, 0);
  }
});

test('long text retains every character in bounded scroll regions, with responsive theme-local CSS', () => {
  const { document, wrapper } = fixture();
  const content = '长文本😀'.repeat(10000), result = mount(message({ reasoning: content }), wrapper);
  assert.equal(result.querySelector('.message-reasoning pre').textContent, content);
  const css = document.getElementById('mobile-conversation-handoff-style').textContent;
  assert.match(css, /max-height:240px;overflow:auto/);
  assert.match(css, /max-height:440px;overflow:auto/);
  assert.match(css, /white-space:pre-wrap;overflow-wrap:anywhere/);
  assert.match(css, /var\(--panel\)/);
  assert.doesNotMatch(css, /animation|transition|@import|https?:/);
});

test('large history batches lazy native disclosures without silently dropping events', () => {
  const { window, wrapper } = fixture();
  const events = Array.from({ length: 251 }, (_, index) => ({ type: 'tool-result', title: `tool-${index}`, output: index }));
  const result = mount(message({ toolEvents: events }), wrapper);
  assert.equal(result.querySelectorAll('.mobile-handoff-event').length, 100);
  const first = result.querySelector('.mobile-handoff-more');
  assert.equal(first.firstElementChild.textContent, '更多记录（151 条）');
  first.open = true; first.dispatchEvent(new window.Event('toggle'));
  first.dispatchEvent(new window.Event('toggle'));
  assert.equal(result.querySelectorAll('.mobile-handoff-event').length, 200);
  const second = first.querySelector('.mobile-handoff-more');
  second.open = true; second.dispatchEvent(new window.Event('toggle'));
  assert.equal(result.querySelectorAll('.mobile-handoff-event').length, 251);
  assert.match(result.textContent, /tool-250 · 结果记录输出250$/);
});

test('mount is isolated and idempotent; ordinary, user and deleted messages clear only owned history', () => {
  const { document, wrapper } = fixture();
  mount(message(), wrapper); mount(message(), wrapper);
  assert.equal(wrapper.querySelectorAll('[data-mobile-conversation-handoff]').length, 1);
  assert.equal(document.querySelectorAll('style#mobile-conversation-handoff-style').length, 1);
  for (const ordinary of [{ role: 'agent', text: '旧版纯文字' }, message({ role: 'user' }), message({ deletedAt: 1 }), null]) {
    mount(message(), wrapper);
    assert.equal(mount(ordinary, wrapper), null);
    assert.equal(wrapper.querySelectorAll('[data-mobile-conversation-handoff]').length, 0);
    assert.equal(wrapper.querySelector('.message-body').textContent, '真实正文');
  }
});

test('explicit false, empty and null tool outputs remain visible records', () => {
  const { wrapper } = fixture();
  const result = mount(message({ toolEvents: [{ type: 'tool-result', title: 'propose_changes', input: null, output: { executed: false }, error: '' }] }), wrapper);
  assert.deepEqual([...result.querySelectorAll('.mobile-handoff-event pre')].map(n => n.textContent), ['null', '{\n  "executed": false\n}', '']);
});
