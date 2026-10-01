const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Evidence = require('../app/citation-evidence');

// Each harness owns its controller and clock. No renderer, network or disk
// persistence is used; save observes the same workspace object as production.
function harness(initial) {
  let state = initial, sequence = 0, privateMode = false;
  const timers = new Map(), saves = [], calls = [], unmounted = [], module = { exports: {} };
  const context = { module, require: () => Evidence,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    PrivateMode: { isOn: () => privateMode },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/collection-ui'), 'utf8'), context);
  const api = module.exports;
  api.init({ getState: () => state, save: () => { saves.push(JSON.parse(JSON.stringify(state))); return true; },
    getAnalysis: item => ({ status: item.analyzed ? 'analyzed' : 'pending', label: item.analyzed ? '已分析' : '待 AI 分析' }),
    analyzeImports: () => { calls.push('analyze'); return true; }, toast() {} });
  return { api, context, saves, calls, timers, unmounted,
    get state() { return state; }, setState(next) { state = next; }, setPrivate(value) { privateMode = value; },
    tick() { const queued = [...timers.values()]; timers.clear(); queued.forEach(timer => timer.fn()); },
    kit(container) {
      const node = () => ({ dataset: {}, isConnected: true, classList: { add() {}, remove() {} }, replaceChildren() { this.innerHTML = ''; } });
      container.ownerDocument = { createElement: node };
      container.replaceChildren = (...children) => { container.children = children; };
      const mounted = new Map();
      context.HalaskaUI = { mount(host, name, props) { host.dataset.halaskaRoot = name; mounted.set(name, props); }, unmount(host) { if (host.dataset.halaskaRoot) unmounted.push(host.dataset.halaskaRoot); delete host.dataset.halaskaRoot; } };
      return name => mounted.get(name || 'LibraryToolbar');
    },
  };
}
class Container {
  constructor() { this.dataset = {}; this.listeners = {}; this.html = ''; }
  set innerHTML(html) {
    this.html = html;
    this.search = { value: /data-cui-search\s+(?:disabled\s+)?value="([^"]*)"/.exec(html)?.[1] || '',
      matches: selector => selector === '[data-cui-search]', focus() {}, setSelectionRange() {} };
  }
  get innerHTML() { return this.html; }
  querySelector(selector) { return selector === '[data-cui-search]' ? this.search : null; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  event(type, target, extras = {}) { return this.listeners[type]?.({ target, ...extras }); }
  query(value) { this.search.value = value; this.event('input', this.search); }
  type(value) { this.event('change', { value, matches: selector => selector === '[data-cui-type]' }); }
  click(name, value) { return this.event('click', { closest: selector => selector === `[data-cui-${name}]` ? { dataset: { cuiView: value } } : null }); }
}
const fixture = () => ({ projects: [{ id: 'a' }, { id: 'b' }],
  notes: [{ id: 'a-note', projectId: 'a', title: 'Alpha note' }, { id: 'b-note', projectId: 'b', title: 'Beta note' }], ui: {} });
const plain = value => JSON.parse(JSON.stringify(value));
const preference = (state, id) => plain(state.ui.projectCollectionPreferences?.[id] ?? null);

test('project preferences survive folders, A/B switching and a new host without retaining selection', () => {
  const h = harness(fixture()), host = new Container();
  h.api.render(host, { projectId: 'a' });
  host.query('Alpha'); host.type('note'); host.click('sort'); host.click('sort'); host.click('view', 'tree');
  host.event('change', { checked: true, matches: selector => selector === '[data-cui-check]', closest: () => ({ dataset: { cuiKey: 'note:a-note' } }) });
  assert.deepEqual(preference(h.state, 'a'), { query: 'Alpha', type: 'note', sort: 'name', dir: 'asc', view: 'tree' });
  h.api.render(host, { projectId: 'a', folderPath: '' });
  assert.equal(host.search.value, 'Alpha'); assert.match(host.html, /class="collection-tree"/);
  h.api.render(host, { projectId: 'b' });
  assert.equal(h.saves.length, 1, 'Leaving A flushes its confirmed preference once');
  assert.equal(host.search.value, ''); assert.doesNotMatch(host.html, /已选择/);
  host.query('Beta'); host.click('view', 'cards');
  h.api.render(host, { projectId: 'a' });
  assert.equal(host.search.value, 'Alpha'); assert.match(host.html, /名称 ↑/); assert.doesNotMatch(host.html, /已选择/);
  const replacement = new Container(); h.api.render(replacement, { projectId: 'b' });
  assert.equal(replacement.search.value, 'Beta'); assert.match(replacement.html, /class="collection-cards"/);
  assert.deepEqual(Object.keys(preference(h.state, 'a')).sort(), ['dir', 'query', 'sort', 'type', 'view']);
});

test('confirmed search updates one authority immediately but debounces expensive workspace saves', () => {
  const h = harness(fixture()), host = new Container(); h.api.render(host, { projectId: 'a' });
  for (const query of ['A', 'Al', 'Alp', 'Alph', 'Alpha']) host.query(query);
  assert.equal(preference(h.state, 'a').query, 'Alpha'); assert.equal(h.saves.length, 0);
  assert.equal(h.timers.size, 1); assert.ok([...h.timers.values()][0].delay >= 250);
  h.tick(); assert.equal(h.saves.length, 1); assert.equal(preference(h.saves[0], 'a').query, 'Alpha');
  h.api.render(host, { projectId: 'a' }); h.tick(); assert.equal(h.saves.length, 1, 'Routine renders do not save');
});

test('IME candidate never enters durable preferences or another project, including late detached events', () => {
  const h = harness(fixture()), host = new Container(); h.api.render(host, { projectId: 'a' }); host.query('Alpha');
  const oldInput = host.search; host.event('compositionstart', oldInput); oldInput.value = 'weiwan';
  host.event('input', oldInput, { isComposing: true }); h.api.render(host, { projectId: 'a' });
  assert.equal(host.search, oldInput); assert.equal(preference(h.state, 'a').query, 'Alpha');
  h.api.render(host, { projectId: 'b' }); oldInput.value = '未完成'; host.event('compositionend', oldInput);
  assert.equal(host.search.value, ''); assert.equal(preference(h.state, 'b'), null);
  assert.equal(preference(h.saves[0], 'a').query, 'Alpha');
  h.api.render(host, { projectId: 'a' }); assert.equal(host.search.value, 'Alpha');
  host.event('compositionstart', host.search); host.search.value = '智能'; host.event('compositionend', host.search);
  assert.equal(preference(h.state, 'a').query, '智能'); h.tick(); assert.equal(preference(h.saves.at(-1), 'a').query, '智能');
});

test('Kit callbacks cannot commit a previous project composition or preference after a scope switch', () => {
  const h = harness(fixture()), host = new Container(), props = h.kit(host);
  h.api.render(host, { projectId: 'a' }); const old = props(); old.onQuery('Alpha');
  props().onCompositionStart(); props().onQuery('candidate');
  h.api.render(host, { projectId: 'a' });
  assert.equal(h.unmounted.filter(name => name === 'LibraryToolbar').length, 0, 'Routine render keeps the input/IME root');
  h.api.render(host, { projectId: 'b' });
  assert.equal(h.unmounted.filter(name => name === 'LibraryToolbar').length, 1, 'Scope switch disposes KitSearchInput draft and native listeners');
  old.onCompositionEnd({ target: { value: '迟到' } }); old.onView('cards'); old.onType('note'); old.onQuery('stale');
  assert.equal(props().query, ''); assert.equal(props().view, 'list'); assert.equal(preference(h.state, 'b'), null);
  assert.equal(preference(h.state, 'a').query, 'Alpha');
});

test('privacy interrupts a Kit IME session by disposing its input while keeping only the last confirmed query', () => {
  const h = harness(fixture()), host = new Container(), props = h.kit(host);
  h.api.render(host, { projectId: 'a' }); props().onQuery('Alpha'); props().onCompositionStart(); props().onQuery('unfinished');
  h.state.notes[0].private = true; h.api.render(host, { projectId: 'a' });
  assert.equal(h.unmounted.filter(name => name === 'LibraryToolbar').length, 1);
  assert.equal(props().query, 'Alpha'); assert.equal(preference(h.state, 'a').query, 'Alpha');
  assert.equal(props().count, 0);
});

test('untrusted saved values are normalized and project keys cannot mutate object prototypes', () => {
  const state = fixture(); state.ui.projectCollectionPreferences = {
    a: { query: ['private'], type: 'constructor', sort: 'random', dir: 'sideways', view: 'secret', selected: ['note:a-note'] },
    b: { query: 'Beta', type: 'pending-analysis', sort: 'type', dir: 'desc', view: 'cards' },
  };
  const h = harness(state), host = new Container(); h.api.render(host, { projectId: 'a', defaultView: 'tree' });
  assert.equal(host.search.value, ''); assert.match(host.html, /更新时间 ↓/); assert.match(host.html, /class="collection-tree"/);
  h.api.render(host, { projectId: 'b', types: ['note'] }); assert.match(host.html, /value="all" selected/);
  assert.equal(host.search.value, 'Beta'); assert.match(host.html, /类型 ↓/); assert.match(host.html, /class="collection-cards"/);
  state.projects.push({ id: '__proto__' }); h.api.render(host, { projectId: '__proto__' }); host.query('literal');
  assert.equal(Object.getPrototypeOf(state.ui.projectCollectionPreferences), Object.prototype);
  assert.equal(Object.hasOwn(state.ui.projectCollectionPreferences, '__proto__'), true);
  assert.equal(state.ui.projectCollectionPreferences.__proto__.query, 'literal');
});

test('private, deleted, ambiguous and inherited-private projects cannot restore or persist searches', () => {
  for (const alter of [
    state => { state.projects[0].private = true; },
    state => { state.projects[0].deletedAt = 1; },
    state => { state.projects.push({ id: 'a' }); },
    state => { state.projects[0].provenance = { origin: { private: true } }; },
    state => { state.projects[0].agentRunId = 'r'; state.agentRuns = [{ id: 'r', private: true }]; },
  ]) {
    const state = fixture(); state.ui.projectCollectionPreferences = { a: { query: 'DO_NOT_DISPLAY', type: 'all', sort: 'updated', dir: 'desc', view: 'list' } };
    alter(state); const h = harness(state), host = new Container(); h.api.render(host, { projectId: 'a' });
    assert.doesNotMatch(host.html, /DO_NOT_DISPLAY/); host.query('DO_NOT_SAVE'); h.tick();
    assert.equal(h.saves.length, 0); assert.notEqual(preference(state, 'a').query, 'DO_NOT_SAVE');
  }
});

test('pending save revalidates privacy and workspace ownership without writing a replacement scope', () => {
  const h = harness(fixture()), host = new Container(); h.api.render(host, { projectId: 'a' }); host.query('sensitive');
  h.state.projects[0].provenance = { origin: { private: true } }; h.tick();
  assert.equal(h.saves.length, 0); assert.equal(preference(h.state, 'a'), null, 'An unsaved revoked query is not left for a later unrelated save');
  const next = fixture(); h.setState(next); h.api.render(host, { projectId: 'a' }); host.query('before replacement');
  const third = fixture(); h.setState(third); h.tick();
  assert.equal(h.saves.length, 0); assert.equal(third.ui.projectCollectionPreferences, undefined);
  h.api.render(host, { projectId: 'a' }); assert.equal(host.search.value, '');
  h.setPrivate(true); host.query('private mode'); h.tick(); assert.equal(preference(third, 'a'), null);
});

test('workspace collections retain transient behavior without creating project preferences or saves', () => {
  const h = harness(fixture()), host = new Container(); h.api.render(host, { workspace: '日常' });
  host.query('Alpha'); host.type('note'); host.click('view', 'cards'); h.api.render(host, { workspace: '日常' });
  assert.equal(host.search.value, 'Alpha'); assert.match(host.html, /class="collection-cards"/);
  h.api.render(host, { workspace: '科研' }); assert.equal(host.search.value, '');
  h.tick(); assert.equal(h.saves.length, 0); assert.equal(h.state.ui.projectCollectionPreferences, undefined);
});

test('Kit pending shortcut counts this directory before search and only changes filters; empty add uses current scope', () => {
  const state = fixture(); state.imports = [
    { id: 'pending', projectId: 'a', folderPath: 'one', name: 'First' },
    { id: 'nested', projectId: 'a', folderPath: 'one/sub', name: 'Second' },
    { id: 'analyzed', projectId: 'a', folderPath: 'one', analyzed: true },
    { id: 'outside', projectId: 'a', folderPath: 'two' },
    { id: 'private', projectId: 'a', folderPath: 'one', private: true },
    { id: 'other-project', projectId: 'b', folderPath: 'one' },
  ];
  const h = harness(state), host = new Container(), props = h.kit(host), added = [];
  h.api.render(host, { projectId: 'a', folderPath: 'one', onAdd: () => added.push('a') });
  props().onQuery('no-match'); props().onType('note');
  assert.equal(props().pendingCount, 2); const previousEmpty = props('LibraryEmpty');
  props().onPending(); assert.equal(props().query, ''); assert.equal(props().type, 'pending-analysis'); assert.equal(props().count, 2);
  assert.deepEqual(h.calls, []); assert.equal(preference(state, 'a').type, 'pending-analysis');
  h.api.render(host, { projectId: 'b', folderPath: 'empty', onAdd: () => added.push('b') });
  previousEmpty.onAdd(); props('LibraryEmpty').onAdd(); assert.deepEqual(added, ['b']);
  state.projects[1].private = true; props('LibraryEmpty').onAdd(); assert.deepEqual(added, ['b']);
});
