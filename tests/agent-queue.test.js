const test = require('node:test');
const assert = require('node:assert/strict');
const Queue = require('../app/agent-queue');

test('queued submits keep order, carry attachments, and survive normalization', () => {
  const conversation = {};
  const first = Queue.enqueue(conversation, { goal: '  第一条  ', attachmentIds: ['a', 'a', 'b', 3, null] }, 10);
  const second = Queue.enqueue(conversation, { goal: '第二条' }, 20);
  assert.equal(first.goal, '第一条');
  assert.deepEqual(first.attachmentIds, ['a', 'b']);
  assert.deepEqual(Queue.list(conversation).map(item => item.goal), ['第一条', '第二条']);
  assert.equal(Queue.count(conversation), 2);
  assert.equal(second.at, 20);
  assert.equal(Queue.shift(conversation).goal, '第一条');
  assert.equal(Queue.shift(conversation).goal, '第二条');
  assert.equal(Queue.shift(conversation), null);
  assert.equal(Queue.count(conversation), 0);
});

test('empty goals are refused and the queue is bounded', () => {
  const conversation = {};
  assert.equal(Queue.enqueue(conversation, { goal: '   ' }), null);
  assert.equal(Queue.enqueue(conversation, {}), null);
  assert.equal(Queue.enqueue(null, { goal: 'x' }), null);
  assert.equal(Queue.count(conversation), 0);
  for (let n = 0; n < Queue.LIMIT; n++) assert.ok(Queue.enqueue(conversation, { goal: `第 ${n} 条` }, n + 1));
  assert.equal(Queue.count(conversation), Queue.LIMIT);
  assert.equal(Queue.enqueue(conversation, { goal: '超出上限' }, 99), null);
  assert.equal(Queue.count(conversation), Queue.LIMIT);
});

test('a specific queued item can be dropped without disturbing the rest', () => {
  const conversation = {};
  Queue.enqueue(conversation, { goal: '保留一' }, 1);
  const middle = Queue.enqueue(conversation, { goal: '移除我' }, 2);
  Queue.enqueue(conversation, { goal: '保留二' }, 3);
  assert.equal(Queue.shift(conversation, middle.id).goal, '移除我');
  assert.deepEqual(Queue.list(conversation).map(item => item.goal), ['保留一', '保留二']);
  assert.equal(Queue.shift(conversation, '不存在'), null);
  Queue.clear(conversation);
  assert.equal(Queue.count(conversation), 0);
});

test('normalization repairs a queued list from persisted state and description stays bilingual', () => {
  const conversation = { pendingSubmits: 'not-an-array' };
  assert.deepEqual(Queue.list(conversation), []);
  assert.ok(Array.isArray(conversation.pendingSubmits));
  assert.equal(Queue.describe(conversation), '');
  Queue.enqueue(conversation, { goal: '继续' }, 5);
  assert.match(Queue.describe(conversation), /已排队 1 条/);
  assert.match(Queue.describe(conversation, true), /1 queued/);
});

test('中途补充进入独立队列，与排队互不干扰', () => {
  const conversation = {};
  Queue.inject(conversation, { goal: '补充：注意时区' }, 10);
  Queue.enqueue(conversation, { goal: '排队的下一条' }, 11);
  assert.equal(Queue.injections(conversation).length, 1);
  assert.equal(Queue.count(conversation), 1, '排队与注入是两条队列');
  assert.match(Queue.describeInjections(conversation), /待注入 1 条/);
  assert.match(Queue.describeInjections(conversation, true), /next tool boundary/);
  assert.equal(Queue.inject(conversation, { goal: '   ' }), null, '空内容不得入队');
  assert.equal(Queue.injections({ pendingInjections: 'broken' }).length, 0, '损坏的持久化数据应被修复为空队列');
});

test('注入内容被明确标注为资料，而不是新任务或批准', () => {
  const conversation = {};
  assert.equal(Queue.injectionText(conversation), '', '没有补充时不产生任何文本');
  Queue.inject(conversation, { goal: '这条要一起看' }, 7);
  const text = Queue.injectionText(conversation);
  assert.match(text, /- 这条要一起看/);
  assert.match(text, /不是新任务/);
  assert.match(text, /不代表对任何计划的批准/, '必须说明它不是批准——否则会削弱审批语义');
  assert.match(Queue.injectionText(conversation, true), /not a new task/);
});

test('只有真正发起请求的那一次才算生效，仅构造文本不算', () => {
  const conversation = {};
  Queue.inject(conversation, { goal: '一' }, 1);
  assert.equal(Queue.injections(conversation)[0].usedAt, 0);
  Queue.injectionText(conversation, false, 100);
  assert.equal(Queue.injections(conversation)[0].usedAt, 0, '仅构造文本（例如估算长度）不算生效');
  Queue.injectionText(conversation, false, 200, true);
  assert.equal(Queue.injections(conversation)[0].usedAt, 200, '真正发请求时才标记');
  Queue.injectionText(conversation, false, 300, true);
  assert.equal(Queue.injections(conversation)[0].usedAt, 200, '标记不得被后续请求覆盖');
});

test('取出注入项后队列清空，调用方据此决定写入对话或降级排队', () => {
  const conversation = {};
  Queue.inject(conversation, { goal: '甲' }, 1);
  Queue.inject(conversation, { goal: '乙' }, 2);
  const taken = Queue.takeInjections(conversation);
  assert.deepEqual(taken.map(item => item.goal), ['甲', '乙']);
  assert.deepEqual(Queue.takeInjections(conversation), [], '取出后必须清空');
  assert.equal(Queue.describeInjections(conversation), '');
  assert.deepEqual(Queue.takeInjections(null), [], '没有对话时安全返回空');
});

test('注入队列有上限，避免无限堆积', () => {
  const conversation = {};
  for (let index = 0; index < Queue.LIMIT; index += 1) assert.ok(Queue.inject(conversation, { goal: '第' + index }, index), '上限内应可入队');
  assert.equal(Queue.inject(conversation, { goal: '超出' }, 99), null, '达到上限后拒绝');
  assert.equal(Queue.injections(conversation).length, Queue.LIMIT);
});
