'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const bridge = fs.readFileSync(require.resolve('../native/Resources/bridge.js'), 'utf8');
function harness(input = {}) {
  const state = {ui: {}, projects: [{id: 'p', workspace: '科研'}, {id: 'q', workspace: '科研'}], tasks: [], notes: [], imports: [], conversations: [], agentRuns: [], trash: [], ...input};
  let tick, posted;
  const tokens = new Set(), classList = {add: (...values) => values.forEach(value => tokens.add(value)), remove: (...values) => values.forEach(value => tokens.delete(value)), contains: value => tokens.has(value), toggle: (value, on) => on ? tokens.add(value) : tokens.delete(value)};
  const document = {hidden: false, body: {dataset: {view: 'agent'}, classList, offsetWidth: 1}, documentElement: {lang: 'zh'}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}};
  const window = {__aibroPresentationVisible: false, addEventListener() {}, webkit: {messageHandlers: {workspace: {postMessage(value) {posted = value;}}}}};
  vm.runInNewContext(bridge, {state, document, window, storageHydrated: true, sendMessage: {busy: false}, setInterval(fn, ms) {if (ms === 500) tick = fn;}, setTimeout() {return 1;}, clearTimeout() {}});
  return {state, tick: () => tick(), current: () => posted};
}
const task = (id, extra = {}) => ({id, title: 'Synthetic', projectId: 'p', workspace: '科研', status: 'todo', ...extra});
const waits = h => h.current().tasks.find(value => value.id === 'target').waitingOnDependencies;

test('dependency readiness preserves exact identity, raw workspace and normalized project scope semantics', () => {
  const scenarios = [
    {id: 'dep', source: {}, target: {}, dependency: 'dep', expected: false},
    {id: 1, source: {}, target: {}, dependency: '1', expected: true},
    {id: 1, source: {}, target: {}, dependency: 1, expected: false},
    {id: 'dep', source: {projectId: 'q'}, target: {}, dependency: 'dep', expected: true},
    {id: 'dep', source: {workspace: undefined}, target: {workspace: '科研'}, dependency: 'dep', expected: true},
    {id: 'dep', source: {workspace: undefined}, target: {workspace: undefined}, dependency: 'dep', expected: false},
    {id: 'dep', source: {workspace: null}, target: {workspace: undefined}, dependency: 'dep', expected: true},
    {id: 'dep', source: {workspace: 1}, target: {workspace: '1'}, dependency: 'dep', expected: true},
    {id: 'dep', source: {projectId: ''}, target: {projectId: null}, dependency: 'dep', expected: false},
    {id: 'dep', source: {projectId: 0}, target: {projectId: false}, dependency: 'dep', expected: false},
    {id: NaN, source: {}, target: {}, dependency: NaN, expected: true},
    {id: 'dep', source: {workspace: NaN}, target: {workspace: NaN}, dependency: 'dep', expected: true},
  ];
  for (const scenario of scenarios) {
    const prior = task(scenario.id, {...scenario.source, status: 'done'}), target = task('target', {...scenario.target, dependsOn: [scenario.dependency]});
    const expected = ![prior, target].some(value => value.id === scenario.dependency && value.status === 'done' && (value.projectId || null) === (target.projectId || null) && value.workspace === target.workspace);
    assert.equal(expected, scenario.expected);
    assert.equal(waits(harness({tasks: [prior, target]})), expected, JSON.stringify(scenario));
  }
});

test('duplicate completed identities retain existing any-matching-scope behavior without accepting another scope', () => {
  const state = {tasks: [task('dep'), task('dep', {projectId: 'q', status: 'done'}), task('target', {dependsOn: ['dep']})]};
  const h = harness(state); assert.equal(waits(h), true);
  state.tasks.push(task('dep', {status: 'done'})); h.tick(); assert.equal(waits(h), false);
  state.tasks.at(-1).archived = true; h.tick(); assert.equal(waits(h), true);
});

test('each snapshot rechecks completion, deletion and inherited private ancestors without retaining an old index', () => {
  const dependency = task('dep', {status: 'done', provenance: {origin: {runId: 'gone'}}});
  const h = harness({tasks: [dependency, task('target', {dependsOn: ['dep']})]});
  assert.equal(waits(h), false);
  dependency.status = 'todo'; h.tick(); assert.equal(waits(h), true);
  dependency.status = 'done'; dependency.deletedAt = 1; h.tick(); assert.equal(waits(h), true);
  delete dependency.deletedAt; h.tick(); assert.equal(waits(h), false);
  h.state.trash = [{data: {runs: [{id: 'gone', private: true}]}}]; h.tick(); assert.equal(waits(h), true);
  h.state.trash = []; h.tick(); assert.equal(waits(h), false, 'missing public origin is not private');
  dependency.provenance.origin.private = true; h.tick(); assert.equal(waits(h), true);
  delete dependency.provenance.origin.private; h.tick(); assert.equal(waits(h), false);
  h.state.tasks = [h.state.tasks[1]]; h.tick(); assert.equal(waits(h), true);
});

test('a private duplicate cannot satisfy a public dependency through a different visible duplicate', () => {
  const h = harness({tasks: [task('dep', {status: 'done'}), task('dep', {status: 'done', private: true}), task('target', {dependsOn: ['dep']})]});
  assert.equal(waits(h), true); assert.equal(h.current().tasks.length, 1);
});

test('unchanged background snapshot dependency lookup reads task identities linearly', () => {
  const count = 1000; let reads = 0;
  const tasks = Array.from({length: count}, (_, index) => {
    const value = task(`t${index}`, {projectId: `p${Math.floor(index / 25)}`, dependsOn: index % 25 ? [`t${index - 1}`] : []});
    Object.defineProperty(value, 'id', {enumerable: true, get() {reads++; return `t${index}`;}}); return value;
  });
  const h = harness({projects: Array.from({length: count / 25}, (_, index) => ({id: `p${index}`, workspace: '科研'})), tasks});
  const before = reads; h.tick(); const work = reads - before;
  assert.ok(work <= count * 20, `Expected bounded per-snapshot identity work; got ${work} for ${count} tasks`);
  assert.equal(h.current().tasks.filter(value => value.waitingOnDependencies).length, 960);
});
