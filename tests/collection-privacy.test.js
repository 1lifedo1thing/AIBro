const test = require('node:test');
const assert = require('node:assert/strict');
const Collection = require('../app/collection-ui');
const Evidence = require('../app/citation-evidence');
const Core = require('../app/workstation-core');
const PrivateMode = require('../app/private-mode');

class Container {
  constructor() { this.dataset = {}; this.listeners = {}; this.html = ''; }
  set innerHTML(value) { this.html = value; this.search = {value: '', matches: value => value === '[data-cui-search]', focus() {}}; }
  get innerHTML() { return this.html; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelector(selector) { return selector === '[data-cui-search]' ? this.search : null; }
  event(type, target) { return this.listeners[type]?.({target}); }
}
const button = selector => ({closest: value => value === selector ? {} : null});
const select = key => ({checked: true, matches: value => value === '[data-cui-check]', closest: () => ({dataset: {cuiKey: key}})});
function useState(state, hooks = {}) {
  Collection.init({getState: () => state, save: () => true, toast() {}, renderAll() {}, openProject() {}, openNote() {}, openImport() {}, openPaper() {}, openTask() {}, deleteItems: undefined, analyzeImports: undefined, mergeNotes: undefined, compareSources: undefined, ...hooks});
  return state;
}
function generated(privateOrigin = true) {
  const run = {id: 'run', conversationId: 'chat', projectId: 'project', workspace: '科研', status: 'completed'};
  const state = {projects: [{id: 'project', workspace: '科研'}], conversations: [{id: 'chat', projectId: 'project', ephemeral: privateOrigin, messages: []}], agentRuns: [run], tasks: [], notes: [{id: 'public', title: 'Public input', projectId: 'project'}], imports: [], papers: [], links: [], attachments: [], trash: []};
  const result = Core.applyPlan(state, [{type: 'create_knowledge_item', title: 'PRIVATE_OUTPUT_TITLE', content: 'Synthetic private output body'}], {workspace: '科研', projectId: 'project', conversationId: 'chat', runId: run.id, provenanceRun: run, uid: prefix => `${prefix}-derived`, now: 10}).state;
  const note = result.notes.find(value => value.title === 'PRIVATE_OUTPUT_TITLE');
  assert.equal(!!note.provenance.origin.private, privateOrigin);
  if (privateOrigin) PrivateMode.init({getState: () => result, save() {}});
  return {state: result, note};
}

test('real Core output remains absent from every collection view and count after PrivateMode restart purge', () => {
  const {state, note} = generated();
  assert.equal(state.agentRuns.length, 0); assert.equal(state.conversations.length, 0); assert.ok(state.notes.includes(note));
  useState(state);
  for (const defaultView of ['list', 'cards', 'tree']) {
    const container = new Container(); Collection.render(container, {projectId: 'project', types: ['note'], defaultView});
    container.event('click', {closest: selector => selector === '[data-cui-view]' ? {dataset: {cuiView: defaultView}} : null});
    assert.doesNotMatch(container.innerHTML, /PRIVATE_OUTPUT_TITLE|note-derived/);
    assert.match(container.innerHTML, /role="status">1 项/);
    container.search.value = 'PRIVATE_OUTPUT_TITLE'; container.event('input', container.search);
    assert.match(container.innerHTML, /role="status">0 项/); assert.doesNotMatch(container.innerHTML, /data-cui-id="note-derived"/);
    // Project search now survives a new host. Clear the user's deliberate
    // query before checking the next view for leaked record-derived text.
    container.search.value = ''; container.event('input', container.search);
  }
});

test('indexed access follows private live/trash ancestors, duplicate branches and both run aliases', () => {
  const cases = [
    s => {s.notes[0].provenance = {origin: {private: true}};},
    s => {s.notes[0].agentRunId = 'r'; s.agentRuns = [{id: 'r', conversationId: 'c'}]; s.conversations = [{id: 'c'}, {id: 'c', private: true}];},
    s => {s.notes[0].provenance = {origin: {runId: 'r'}}; s.agentRuns = [{id: 'r'}]; s.trash = [{data: {agentRuns: [{id: 'r', incognito: true}]}}];},
    s => {s.notes[0].runId = 'r'; s.trash = [{data: {runs: [{id: 'r', ephemeral: true}]}}];},
    s => {s.notes[0].runId = 'r'; s.runs = [{id: 'r', private: true}];},
    s => {s.notes[0].sourceConversationId = 'c'; s.trash = [{data: {conversations: [{id: 'c', projectId: 'p'}], projects: [{id: 'p', private: true}]}}];},
    s => {s.notes.push({...s.notes[0], private: true});},
    s => {s.projects.push({id: 'p', private: true});},
    s => {s.trash = [{data: {notes: [{id: 'n', private: true}]}}];}
  ];
  for (const mutate of cases) {
    const state = {projects: [{id: 'p'}], notes: [{id: 'n', title: 'PRIVATE_TITLE', projectId: 'p'}]}; mutate(state);
    const ref = {type: 'note', id: 'n'}; const guard = Evidence.createAccessContext(state);
    assert.equal(guard.access(ref).kind, 'private'); assert.equal(Evidence.access(state, ref).kind, 'private');
    useState(state); assert.deepEqual(Collection._private.records(), []);
  }
});

test('public origin removal and orphan project preserve collection visibility while ambiguous live IDs fail closed', () => {
  const {state, note} = generated(false); state.agentRuns = []; state.conversations = []; state.projects = [];
  useState(state); assert.ok(Collection._private.records().some(value => value.id === note.id));
  const orphan = {type: 'note', id: note.id}; const guard = Evidence.createAccessContext(state);
  assert.equal(guard.access(orphan).kind, 'missing'); assert.equal(guard.isAmbiguous(orphan), false);
  state.notes.push({...note}); assert.equal(Evidence.createAccessContext(state).isAmbiguous(orphan), true);
  assert.ok(!Collection._private.records().some(value => value.id === note.id));
  state.notes.pop(); state.projects = [{id: 'project'}, {id: 'project'}];
  assert.equal(Evidence.createAccessContext(state).isAmbiguous(orphan), true); assert.deepEqual(Collection._private.records(), []);
});

test('selection and each entry action recheck current inherited privacy without requiring a render', async () => {
  const calls = [];
  const state = useState({projects: [{id: 'p'}], tasks: [{id: 't', projectId: 'p', status: 'todo'}], notes: [{id: 'a', projectId: 'p'}, {id: 'b', projectId: 'p'}], imports: [{id: 'i', projectId: 'p'}]}, {
    openNote: id => calls.push(['open', id]), openProject: id => calls.push(['project', id]),
    deleteItems: ids => calls.push(['delete', ids]), mergeNotes: ids => calls.push(['merge', ids]), compareSources: ids => calls.push(['compare', ids]), analyzeImports: ids => calls.push(['analyze', ids])
  });
  const container = new Container(); Collection.render(container, {projectId: 'p'});
  container.event('change', {checked: true, matches: value => value === '[data-cui-all]'});
  state.projects[0].provenance = {origin: {private: true}};
  const row = {dataset: {cuiKey: 'note:a'}};
  await container.event('click', {closest: value => value === '[data-cui-open]' ? {closest: () => row} : null});
  await container.event('click', {closest: value => value === '[data-cui-project]' ? {dataset: {cuiProject: 'p'}, closest: () => row} : null});
  for (const action of ['delete-selected', 'merge', 'compare', 'analyze-selected', 'complete']) await container.event('click', button(`[data-cui-${action}]`));
  assert.deepEqual(calls, []); assert.equal(state.tasks[0].status, 'todo');
  Collection.render(container, {projectId: 'p'}); assert.doesNotMatch(container.innerHTML, /已选择|data-cui-id=/);
});

test('duplicate task identities cannot authorize mutations to any matching object', () => {
  const state = useState({tasks: [{id: 't', status: 'todo'}, {id: 't', status: 'todo', private: true}]});
  assert.equal(Collection._private.completeSelected(new Set(['task:t']), {}, 5), 0);
  assert.deepEqual(state.tasks.map(value => value.status), ['todo', 'todo']);
});

test('each selected action independently rejects an inherited-private selection at invocation', async () => {
  for (const action of ['delete-selected', 'merge', 'compare', 'analyze-selected', 'complete', 'reopen']) {
    const calls = [];
    const state = useState({tasks: [{id: 't', status: action === 'reopen' ? 'done' : 'todo', agentRunId: 'r'}], notes: [{id: 'a', agentRunId: 'r'}, {id: 'b', agentRunId: 'r'}], imports: [{id: 'i', agentRunId: 'r'}], agentRuns: [{id: 'r'}]}, {
      save: () => calls.push('save'), deleteItems: () => calls.push('delete'), mergeNotes: () => calls.push('merge'), compareSources: () => calls.push('compare'), analyzeImports: () => calls.push('analyze')
    });
    const container = new Container(); Collection.render(container);
    const keys = ['merge', 'compare'].includes(action) ? ['note:a', 'note:b'] : action === 'analyze-selected' ? ['import:i'] : ['complete', 'reopen'].includes(action) ? ['task:t'] : ['note:a'];
    for (const key of keys) container.event('change', select(key));
    state.agentRuns[0].provenance = {origin: {private: true}};
    const before = JSON.stringify(state); await container.event('click', button(`[data-cui-${action}]`));
    assert.deepEqual(calls, [], action); assert.equal(JSON.stringify(state), before, action);
  }
});

test('rejected completion never rolls back replacement or duplicated records with matching optimistic fields', async () => {
  for (const replace of [
    state => {state.tasks[0] = {...state.tasks[0], private: true};},
    state => {state.tasks.push({...state.tasks[0], private: true});},
    state => {state.tasks[0].updatedAt = 900;}
  ]) {
    let settle; const state = useState({tasks: [{id: 't', status: 'todo'}]}, {save: () => new Promise(resolve => {settle = resolve;})});
    const container = new Container(); Collection.render(container); container.event('change', select('task:t'));
    const saving = container.event('click', button('[data-cui-complete]'));
    assert.equal(state.tasks[0].status, 'done'); replace(state); const afterReplacement = JSON.stringify(state);
    settle(false); await saving; assert.equal(JSON.stringify(state), afterReplacement);
  }
});

test('Kit toolbar and selection receive only current public collection counts', () => {
  const calls = [], previous = globalThis.HalaskaUI;
  const state = useState({notes: [{id: 'public', title: 'Public'}, {id: 'private', title: 'PRIVATE_TITLE', provenance: {origin: {private: true}}}]});
  const node = () => ({dataset: {}, isConnected: true, classList: {add() {}, remove() {}}, replaceChildren() {this.innerHTML = '';}});
  const container = new Container(); container.ownerDocument = {createElement: node}; container.replaceChildren = (...children) => {container.children = children;};
  globalThis.HalaskaUI = {mount(host, kind, props) {calls.push({kind, props}); host.dataset.halaskaRoot = kind;}, unmount() {}};
  try {
    Collection.render(container); assert.equal(calls.find(call => call.kind === 'LibraryToolbar').props.count, 1);
    assert.doesNotMatch(container.children[2].innerHTML, /PRIVATE_TITLE|data-cui-id="private"/);
    container.event('change', select('note:public')); assert.equal(calls.filter(call => call.kind === 'LibrarySelection').at(-1).props.count, 1);
    state.notes[0].private = true; Collection.render(container);
    assert.equal(calls.filter(call => call.kind === 'LibraryToolbar').at(-1).props.count, 0);
    assert.equal(calls.filter(call => call.kind === 'LibrarySelection').at(-1).props.count, 0);
  } finally {globalThis.HalaskaUI = previous;}
});

test('privacy revocation removes existing rows during search composition', () => {
  const state = useState({notes: [{id: 'n', title: 'PRIVATE_TITLE'}]}); const container = new Container(); Collection.render(container);
  const input = container.search; container.event('compositionstart', input);
  state.notes[0].provenance = {origin: {private: true}}; Collection.render(container);
  assert.doesNotMatch(container.innerHTML, /PRIVATE_TITLE/); assert.match(container.innerHTML, /role="status">0 项/);
});

test('one indexed context traverses state collections once and handles cyclic ancestry without rescanning', () => {
  let reads = 0; const notes = Array.from({length: 300}, (_, id) => ({id: String(id), agentRunId: 'r'}));
  const state = {agentRuns: [{id: 'r', conversationId: 'c'}], conversations: [{id: 'c', runId: 'r'}]};
  Object.defineProperty(state, 'notes', {get() {reads++; return notes;}});
  const guard = Evidence.createAccessContext(state), afterIndex = reads;
  for (const note of notes) assert.equal(guard.access({type: 'note', id: note.id}).available, true);
  assert.equal(reads, afterIndex); assert.ok(afterIndex <= 2);
  state.conversations[0].private = true;
  assert.equal(Evidence.createAccessContext(state).access({type: 'note', id: '299'}).kind, 'private');
});
