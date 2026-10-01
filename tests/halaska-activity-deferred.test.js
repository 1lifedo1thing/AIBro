const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/halaska-conversation.js'), 'utf8');

// Boundary-only fixture: no simulated React rendering. The spy verifies when
// the integration calls the real mount/update/unmount API; renderer coverage
// separately checks DOM preservation, keyboard and actual React roots.
class Host {
  constructor() { this.dataset = {}; }
  querySelectorAll() { return []; }
}
class Summary {
  constructor(detail = '') { this.host = null; this.detail = detail; this.listeners = []; }
  querySelector(selector) {
    if (selector.includes('[data-halaska-conversation]')) return this.host;
    if (selector === '.progress-group-status') return this.host ? null : { textContent: this.detail };
    return null;
  }
  replaceChildren(host) { this.host = host; }
  addEventListener(...args) { this.listeners.push(args); }
}
class Row {
  constructor(id, group = null) { this.dataset = { activityId: id }; this.summary = new Summary(); this.group = group; }
  querySelector() { return this.summary; }
  closest() { return this.group; }
}
class Group {
  constructor(id, count) {
    this.dataset = { progressGroupId: id, groupName: 'read_page', groupCount: String(count), groupStatus: 'completed', groupDuration: '1200' };
    this.summary = new Summary(`${count} 已完成`);
  }
  querySelector() { return this.summary; }
}
function wrapper(ids, groupId) {
  const group = groupId ? new Group(groupId, ids.length) : null;
  const rows = ids.map(id => new Row(id, group)), groups = group ? [group] : [], feed = new Summary();
  const progress = {
    querySelector: () => feed,
    querySelectorAll: selector => selector.startsWith('.progress-item') ? rows : groups,
  };
  return {
    dataset: {}, rows, groups, feed,
    querySelector: selector => selector === ':scope > .agent-progress' ? progress : null,
    querySelectorAll: () => [feed, ...rows.map(row => row.summary), ...groups.map(item => item.summary)].map(summary => summary.host).filter(Boolean),
  };
}
function setup(count = 150) {
  const calls = { mount: 0, update: 0, unmount: 0 }, mounted = new Map();
  const context = {
    document: { createElement: () => new Host() },
    AgentProgress: { entries: message => message.activities || [], phase: () => 'settled', duration: (start, end) => `${Math.floor((end - start) / 1000)} 秒` },
    HalaskaUI: {
      mount(host, name, props) { assert.equal(mounted.has(host), false); mounted.set(host, { name, props }); calls.mount++; },
      update(host, props) { assert.equal(mounted.has(host), true, 'cannot update a deferred host'); mounted.get(host).props = props; calls.update++; },
      unmount(host) { assert.equal(mounted.has(host), true, 'cannot unmount a deferred host'); mounted.delete(host); calls.unmount++; },
    },
  };
  vm.runInNewContext(source, context);
  const activities = Array.from({ length: count }, (_, i) => ({ id: `tool-${i}`, kind: 'tool', name: 'read_page', status: 'completed', at: 1000, updatedAt: 2000, text: '原始结果' }));
  return { C: context.HalaskaConversation, calls, mounted, message: { role: 'agent', live: false, activities, at: 1000 }, run: { status: 'completed', startedAt: 1000, finishedAt: 4000 } };
}
function patch(C, before, next) {
  assert.equal(C.patchIsland(before.feed.host, next.feed.host), true);
  for (let i = 0; i < before.rows.length; i++) assert.equal(C.patchIsland(before.rows[i].summary.host, next.rows[i].summary.host), true);
  for (let i = 0; i < before.groups.length; i++) assert.equal(C.patchIsland(before.groups[i].summary.host, next.groups[i].summary.host), true);
  C.discard(next);
}

test('150 existing activity roots survive 20 deltas without any new mount, update or unmount', () => {
  const { C, calls, mounted, message, run } = setup();
  const ids = message.activities.map(item => item.id), before = wrapper(ids, 'group:tool-0');
  C.enhance(before, message, run);
  assert.equal(calls.mount, 152);
  for (let delta = 0; delta < 20; delta++) {
    message.activities[149].text += '\n公开正文增量';
    const next = wrapper(ids, 'group:tool-0');
    C.enhance(next, message, run, { previous: before });
    patch(C, before, next);
  }
  assert.deepEqual(calls, { mount: 152, update: 0, unmount: 0 });
  assert.equal(mounted.size, 152);
});

test('changing a mutable message field updates exactly the affected flat props', () => {
  const { C, calls, mounted, message, run } = setup(2);
  const ids = message.activities.map(item => item.id), before = wrapper(ids);
  C.enhance(before, message, run);
  message.activities[1].status = 'failed';
  const next = wrapper(ids); C.enhance(next, message, run, { previous: before }); patch(C, before, next);
  assert.deepEqual(calls, { mount: 3, update: 1, unmount: 0 });
  assert.equal(mounted.get(before.rows[1].summary.host).props.status, 'failed');
});

test('new activities mount immediately while existing summaries remain deferred', () => {
  const { C, calls, message, run } = setup(2), before = wrapper(['tool-0']);
  C.enhance(before, { ...message, activities: message.activities.slice(0, 1) }, run);
  const next = wrapper(['tool-0', 'tool-1']); C.enhance(next, message, run, { previous: before });
  assert.equal(calls.mount, 3);
  assert.equal(calls.update, 0);
  C.discard(next);
  assert.equal(calls.unmount, 1);
});

test('a row entering or leaving a group is mounted instead of inserted as an empty deferred host', () => {
  for (const [oldGroup, newGroup] of [[null, 'group:tool-0'], ['group:tool-0', null], ['group:old', 'group:new']]) {
    const { C, calls, mounted, message, run } = setup(2);
    const ids = message.activities.map(item => item.id), before = wrapper(ids, oldGroup);
    C.enhance(before, message, run);
    const initial = calls.mount, next = wrapper(ids, newGroup);
    C.enhance(next, message, run, { previous: before });
    assert.equal(calls.mount - initial, 2 + (newGroup ? 1 : 0));
    for (const row of next.rows) assert.equal(mounted.has(row.summary.host), true);
  }
});

test('an abandoned staged wrapper is discarded without touching connected roots', () => {
  const { C, calls, mounted, message, run } = setup(2), before = wrapper(['tool-0', 'tool-1']);
  C.enhance(before, message, run);
  const next = wrapper(['tool-0', 'tool-1']); C.enhance(next, message, run, { previous: before }); C.discard(next);
  assert.deepEqual(calls, { mount: 3, update: 0, unmount: 0 });
  assert.equal(mounted.size, 3);
});

test('legacy callers without previous still mount normally and patch without leaking roots', () => {
  const { C, calls, mounted, message, run } = setup(2), before = wrapper(['tool-0', 'tool-1']), next = wrapper(['tool-0', 'tool-1']);
  C.enhance(before, message, run); C.enhance(next, message, run); patch(C, before, next);
  assert.deepEqual(calls, { mount: 6, update: 0, unmount: 3 });
  assert.equal(mounted.size, 3);
});

test('an unregistered prior summary never qualifies for deferred mounting', () => {
  const { C, calls, message, run } = setup(1), before = wrapper(['tool-0']), next = wrapper(['tool-0']);
  before.feed.host = new Host(); before.feed.host.dataset.halaskaConversation = 'AgentLifecycleSummary';
  before.rows[0].summary.host = new Host(); before.rows[0].summary.host.dataset.halaskaConversation = 'AgentActivitySummary';
  C.enhance(next, message, run, { previous: before });
  assert.equal(calls.mount, 2);
});
