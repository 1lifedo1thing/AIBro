const test = require('node:test');
const assert = require('node:assert/strict');
const Outputs = require('../app/project-outputs.js');

function fixture() {
  const state = { projects: [], conversations: [], notes: [], agentRuns: [] };
  for (const id of ['a', 'b']) {
    state.projects.push({ id, name: id });
    state.conversations.push({ id: `c-${id}`, projectId: id, messages: [] });
    const results = [];
    for (let index = 0; index < 45; index++) {
      const noteId = `${id}-${index}`;
      state.notes.push({ id: noteId, projectId: id, title: `Output ${index}` });
      results.push({ type: 'note', id: noteId, operation: 'created' });
    }
    state.agentRuns.push({ id: `r-${id}`, projectId: id, conversationId: `c-${id}`, status: 'completed', results });
    for (let index = 0; index < 25; index++) state.agentRuns.push({ id: `empty-${id}-${index}`, projectId: id, conversationId: `c-${id}`, status: 'completed' });
  }
  return state;
}

function harness(overrides = {}) {
  let latest = fixture(), project = 'a', props;
  const lifecycle = [], calls = [], toasts = [];
  const control = Outputs.mount({}, {
    state: () => latest, projectId: () => project,
    mount: (host, name, next) => {
      props = next; const token = {}; lifecycle.push(['mount', token]);
      return { update(value) { props = value; lifecycle.push(['update', token]); }, unmount() { lifecycle.push(['unmount', token]); } };
    },
    onOpen: (...args) => { calls.push(args); return true; },
    onReview: (...args) => { calls.push(args); return true; },
    toast: value => toasts.push(value), ...overrides
  });
  return { control, lifecycle, calls, toasts, get props() { return props; }, get state() { return latest; },
    switch(id) { project = id; control.sync(); }, replace(value) { latest = value; control.sync(); } };
}

test('project changes retire the island boundary while same-owner sync preserves its root and preferences', () => {
  const h = harness();
  h.props.onQuery('Output'); h.props.onFilter('saved'); h.props.onPage(1);
  h.control.sync();
  assert.equal(h.lifecycle.filter(([kind]) => kind === 'mount').length, 1);
  h.switch('b');
  assert.deepEqual(h.lifecycle.filter(([kind]) => kind !== 'update').map(([kind]) => kind), ['mount', 'unmount', 'mount']);
  assert.equal(h.props.query, ''); assert.equal(h.props.filter, 'all'); assert.equal(h.props.page, 0);
  h.props.onQuery('Output 2');
  h.switch('a');
  assert.equal(h.props.query, 'Output'); assert.equal(h.props.filter, 'saved'); assert.equal(h.props.page, 1);
  h.switch('b'); assert.equal(h.props.query, 'Output 2');
  h.control.dispose();
});

test('callbacks captured before A to B to A cannot mutate either project or an active IME replacement root', () => {
  const h = harness(), old = h.props;
  h.switch('b');
  const invokeOld = () => {
    old.onQuery('stale composition'); old.onFilter('review'); old.onPage(1); old.onReset();
    old.onToggleEmptyRuns(); old.onMoreEmptyRuns();
  };
  const initialB = h.control.snapshot(); invokeOld(); assert.deepEqual(h.control.snapshot(), initialB);
  h.switch('a'); h.props.onQuery('Output'); h.props.onFilter('saved'); h.props.onPage(1);
  const freshA = h.control.snapshot(), operations = h.lifecycle.length;
  invokeOld(); assert.deepEqual(h.control.snapshot(), freshA); assert.equal(h.lifecycle.length, operations);
  h.control.dispose();
  invokeOld(); assert.equal(h.lifecycle.length, operations + 1);
});

test('replacing the state owner clears every project preference and retires callbacks with an unchanged project id', () => {
  const h = harness(); h.props.onQuery('Output 1'); h.switch('b'); h.props.onFilter('review'); h.switch('a');
  const old = h.props;
  h.replace(fixture());
  assert.equal(h.props.query, ''); assert.equal(h.props.filter, 'all');
  const before = h.control.snapshot(); old.onQuery('stale owner'); old.onToggleEmptyRuns();
  assert.deepEqual(h.control.snapshot(), before);
  h.switch('b'); assert.equal(h.props.filter, 'all');
  h.control.dispose();
});

test('query, filter and page callbacks ignore malformed inputs and accept valid zero-based whole pages', () => {
  const h = harness();
  h.props.onQuery('Output'); h.props.onFilter('saved'); h.props.onPage(1);
  const before = h.control.snapshot();
  for (const value of [null, undefined, {}, [], 7]) h.props.onQuery(value);
  for (const value of [null, {}, 'unknown', 'SAVED']) h.props.onFilter(value);
  for (const value of [-1, 0.5, NaN, Infinity, '1', null]) h.props.onPage(value);
  assert.deepEqual(h.control.snapshot(), before);
  h.props.onPage(0); assert.equal(h.props.page, 0);
  h.props.onFilter('review'); assert.equal(h.props.filter, 'review');
  h.props.onFilter('all'); assert.equal(h.props.filter, 'all');
  h.control.dispose();
});

test('public open API forwards the exact overview anchor and defaults invalid section to outputs', async () => {
  const h = harness(), key = h.props.items[0].key, anchor = { node: 'overview-output' };
  assert.equal(await h.control.open(key, { projectId: 'a', anchor, section: 'overview', mode: 'open' }), true);
  assert.equal(h.calls[0][5].anchor, anchor);
  assert.deepEqual(h.calls[0][5].origin, { view: 'project', projectId: 'a', section: 'overview' });
  assert.equal(h.calls[0][4](), true);
  await h.control.open(key, { projectId: 'a', anchor, section: 'unexpected' });
  assert.equal(h.calls[1][5].origin.section, 'outputs');
  h.switch('b');
  assert.equal(h.calls[0][4](), false);
  assert.equal(await h.control.open(key, { projectId: 'a', anchor, section: 'overview' }), false);
  h.control.dispose();
});

test('public open revalidates private and deleted outputs before invoking any navigation hook', async () => {
  for (const mutate of [record => { record.private = true; }, record => { record.deletedAt = 1; }]) {
    const h = harness(), row = h.props.items[0];
    mutate(h.state.notes.find(note => note.id === row.id));
    assert.equal(await h.control.open(row.key, { projectId: 'a', section: 'overview' }), false);
    assert.equal(h.calls.length, 0); h.control.dispose();
  }
});

test('settling an old asynchronous open neither refreshes nor reports errors in a new scope', async () => {
  for (const reject of [false, true]) {
    let settle;
    const pending = new Promise((resolve, fail) => { settle = reject ? fail : resolve; });
    const h = harness({ onOpen: () => pending });
    const opening = h.props.onOpen(h.props.items[0].key);
    h.switch('b'); h.switch('a');
    const count = h.lifecycle.length;
    settle(reject ? new Error('old request failure') : true);
    await opening;
    assert.equal(h.lifecycle.length, count); assert.deepEqual(h.toasts, []);
    h.control.dispose();
  }
});

test('start-conversation CTA exists only with a hook and protects current scope plus project availability', async () => {
  const absent = harness(); assert.equal(absent.props.onStartConversation, undefined); absent.control.dispose();
  const calls = [], h = harness({ onStartConversation: (...args) => calls.push(args) });
  const old = h.props.onStartConversation;
  await old(); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'a'); assert.equal(calls[0][1](), true);
  h.switch('b'); assert.equal(calls[0][1](), false); await old(); assert.equal(calls.length, 1);
  h.switch('a'); await old(); assert.equal(calls.length, 1);
  const current = h.props.onStartConversation;
  h.state.projects[0].private = true; await current(); assert.equal(calls.length, 1);
  h.control.dispose(); await current(); assert.equal(calls.length, 1);
});
