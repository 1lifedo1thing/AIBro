'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Evidence = require('../app/citation-evidence');
const Collection = require('../app/collection-ui');
const Core = require('../app/workstation-core');
const PrivateMode = require('../app/private-mode');
const Consolidation = require('../app/note-consolidation');
const Overview = require('../app/project-overview');
const Board = require('../app/project-board');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
function section(start, end) {
  const at = source.indexOf(start), until = source.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `Missing production section: ${start}`);
  return source.slice(at, until);
}
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const esc = value => String(value ?? '').replace(/[&<>"']/g, value => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]));
function baseState() {
  return {currentProjectId: 'p', projects: [{id: 'p', name: 'Public project', workspace: '科研'}], tasks: [], notes: [], imports: [], papers: [], conversations: [], agentRuns: [], trash: [], links: [], attachments: [], ui: {projectTab: 'knowledge'}};
}
function notesState() {
  const state = baseState();
  state.notes = ['a', 'b'].map(id => ({id, title: `Public ${id}`, content: `Public body ${id}`, projectId: 'p', workspace: '科研', provenance: {origin: {runId: 'gone-run', conversationId: 'gone-chat'}}}));
  return state;
}
class Element {
  constructor() {this.dataset = {}; this.innerHTML = ''; this.textContent = ''; this.children = new Map(); this.listeners = {}; this.classList = {add() {}, remove() {}}; this.value = 'Merged public notes';}
  querySelector(selector) {if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector);}
  querySelectorAll() {return [];}
  closest(selector) {return this.querySelector(`parent:${selector}`);}
  setAttribute() {} toggleAttribute() {} replaceChildren() {} replaceWith() {} prepend() {} append() {} before() {} focus() {} remove() {}
  addEventListener(type, fn) {this.listeners[type] = fn;}
  showModal() {this.open = true;}
  close() {this.open = false; this.listeners.close?.();}
}
function renderHarness(state) {
  const nodes = new Map(), calls = {overviews: [], boards: [], collections: [], folders: []};
  const $ = selector => {if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector);};
  const document = {body: {dataset: {view: 'project'}}, createElement: () => new Element(), getElementById: id => $(`#${id}`)};
  // Keep the production controllers and privacy/identity filters. Only the
  // terminal React mount is replaced so this host test can inspect its props.
  const mount = (name, rows) => (_host, component, props) => {
    assert.equal(component, name); rows.push(props);
    return {update: next => rows.push(next), unmount() {}};
  };
  Board.init({getState: () => state, document, mount: mount('ProjectBoard', calls.boards)});
  const Library = require('../app/project-library.js');
  const window = {ProjectLibrary: {...Library, mount(_host, options) {calls.folders.push(Library.buildModel(options.records, options.selected, options.expansion));}}, CitationEvidence: Evidence,
    ProjectBoard: Board, ProjectOverview: {...Overview, mount: (host, options) => Overview.mount(host, {...options, mount: mount('ProjectOverview', calls.overviews)})}, CollectionUI: {render(_host, options) {
    Collection.init({getState: () => state}); calls.collections.push(Collection._private.records(options));
  }}};
  const context = vm.createContext({state, window, document, $, esc,
    workspaceName: value => value, orderTasks: value => value, requestAnimationFrame() {}, updateProjectHeading() {},
    formatRelative: value => String(value), formatDate: value => String(value), uiIcon: () => '',
    importAnalysis: item => item.analysis || {status: 'pending'}, setEntityBox: (selector, html) => {$(selector).innerHTML = html;},
    entityTask: item => `<task>${esc(item.title)}</task>`, entityNote: item => `<note>${esc(item.title)}</note>`, entityImport: item => `<import>${esc(item.name)}</import>`,
    renderPlanning() {}, applySectionTabs() {}, save() {}, toast() {}});
  vm.runInContext(section('const projectIsActive =', '\nconst visibleRun ='), context);
  vm.runInContext(section('let projectOverviewController =', '\nfunction updateProjectHeading('), context);
  return {context, nodes, $, calls, render: () => context.renderProject('p')};
}

test('real renderProject keeps all derived counts, folders and hidden knowledge DOM free of private and ambiguous rows', () => {
  let state = baseState();
  for (const [collection, type] of [['tasks', 'task'], ['notes', 'note'], ['imports', 'import'], ['papers', 'paper']]) {
    state[collection] = [
      {id: `${type}-public`, title: `Public ${type}`, name: `Public ${type}`, projectId: 'p', status: 'todo', updatedAt: 1, folderPath: 'Public folder', provenance: {origin: {runId: 'gone', conversationId: 'gone'}}},
      {id: `${type}-private`, title: `PRIVATE_${type}`, name: `PRIVATE_${type}`, projectId: 'p', updatedAt: 9999, folderPath: 'PRIVATE_FOLDER', provenance: {origin: {runId: 'retired-private'}}},
      ...[1, 2].map(() => ({id: `${type}-duplicate`, title: `AMBIGUOUS_${type}`, name: `AMBIGUOUS_${type}`, projectId: 'p', folderPath: 'AMBIGUOUS_FOLDER'}))
    ];
  }
  state.trash = [{data: {runs: [{id: 'retired-private', private: true}]}}];
  const run = {id: 'temp-run', conversationId: 'temp-chat', projectId: 'p', workspace: '科研'};
  state.agentRuns.push(run); state.conversations.push({id: 'temp-chat', ephemeral: true, messages: []});
  state = Core.applyPlan(state, [{type: 'create_knowledge_item', title: 'PRIVATE_CORE_PURGED', content: 'Synthetic private output'}], {projectId: 'p', workspace: '科研', conversationId: 'temp-chat', runId: run.id, provenanceRun: run, now: 20, uid: prefix => `${prefix}-private-core`}).state;
  PrivateMode.init({getState: () => state, save() {}});
  assert.equal(state.conversations.length, 0); assert.equal(state.agentRuns.length, 0);
  const h = renderHarness(state); h.render();
  const overview = h.calls.overviews.at(-1), board = h.calls.boards.at(-1);
  assert.equal(overview.available, true);
  assert.deepEqual([overview.taskCount, overview.doneCount, overview.sourceCount, overview.recordCount], [1, 0, 3, 0]);
  assert.deepEqual(overview.tasks.map(item => item.id), ['task-public']);
  assert.deepEqual(board.counts, {todo: 1, in_progress: 0, blocked: 0, done: 0});
  assert.deepEqual(board.tasks.map(item => item.id), ['task-public']);
  assert.doesNotMatch(JSON.stringify([h.calls.overviews, h.calls.boards]), /PRIVATE_|AMBIGUOUS_/);
  assert.equal(h.$('#projectTreeCount').textContent, '3 份资料');
  assert.match(h.$('#projectSectionCaption').innerHTML, /1 篇笔记.*1 份原始资料.*1 篇论文/);
  assert.deepEqual(h.calls.folders.at(-1).roots.map(({path,count}) => ({path,count})), [{path:'Public folder',count:3}]);
  assert.doesNotMatch(JSON.stringify(h.calls.folders), /PRIVATE_|AMBIGUOUS_/);
  assert.equal(h.$('#projectKnowledge').closest('article').hidden, true);
  const rendered = [...h.nodes.values()].map(node => node.innerHTML + node.textContent).join('\n');
  assert.doesNotMatch(rendered, /PRIVATE_|AMBIGUOUS_/);
  assert.deepEqual(h.calls.collections.at(-1).map(item => item.id).sort(), ['import-public', 'note-public', 'paper-public']);
  assert.match(h.$('#projectKnowledge').innerHTML, /Public note/);
  assert.equal(board.tasks[0].title, 'Public task');
});

test('real renderProject drops all records when live owning project identity becomes ambiguous', () => {
  const state = notesState(); state.projects.push({...state.projects[0]});
  const h = renderHarness(state); h.render();
  assert.equal(h.$('#projectTreeCount').textContent, '0 份资料');
  assert.equal(h.calls.overviews.at(-1).available, false);
  assert.equal(h.calls.overviews.at(-1).sourceCount, 0);
  assert.equal(h.calls.overviews.at(-1).taskCount, 0);
  assert.equal(h.calls.boards.at(-1).available, false);
  assert.deepEqual(h.calls.boards.at(-1).tasks, []);
  assert.match(h.$('#projectKnowledge').innerHTML, /暂无知识条目/);
  assert.deepEqual(h.calls.collections.at(-1), []);
});

function actionHarness(state = notesState()) {
  const calls = {opened: [], preview: 0, apply: 0, commits: 0, errors: []}, dialogs = [];
  let leave = () => true;
  const NoteConsolidation = {...Consolidation,
    preview(...args) {calls.preview++; return Consolidation.preview(...args);},
    apply(...args) {calls.apply++; return Consolidation.apply(...args);}
  };
  const SourceComparison = {open: (...args) => {calls.opened.push(['open', ...args]); return true;}, reopen: id => {calls.opened.push(['reopen', id]); return true;}};
  const context = vm.createContext({state, storageHydrated: true, serverConflict: false, NoteConsolidation, SourceComparison,
    window: {CitationEvidence: Evidence, NoteConsolidation, SourceComparison, PrivateMode: {isOn: () => false}},
    document: {createElement: () => {const dialog = new Element(); dialogs.push(dialog); return dialog;}, body: {append() {}}},
    beforePreviewLeave: () => leave(), toast: message => calls.errors.push(message), esc, uid: () => 'merge-snapshot',
    commitContentState: value => {calls.commits++; context.state = value;}, flushWorkspace: async () => true, openNote() {}});
  vm.runInContext(section('let noteMergePending =', '\nlet contentDeletePending ='), context);
  vm.runInContext(section('async function openSourceComparison(', '\nfunction refreshComparisonReaderEntry('), context);
  return {context, calls, dialogs, setLeave: value => {leave = value;}};
}

test('host shared guard accepts both kind and type while retaining public missing-origin and orphan references', () => {
  const h = actionHarness(); h.context.state.projects = [];
  for (const field of ['kind', 'type']) {
    assert.equal(h.context.collectionReferencesAllowed([{[field]: 'note', id: 'a'}]), true);
    h.context.state.notes[0].provenance.origin.private = true;
    assert.equal(h.context.collectionReferencesAllowed([{[field]: 'note', id: 'a'}]), false);
    delete h.context.state.notes[0].provenance.origin.private;
  }
});

test('comparison rechecks explicit sources and saved comparison note after the awaited editor leave', async () => {
  for (const reopen of [false, true]) for (const revoke of ['origin', 'trash', 'duplicate']) {
    const h = actionHarness(), gate = deferred(); h.setLeave(() => gate.promise);
    const pending = h.context.openSourceComparison(reopen ? undefined : [{kind: 'note', id: 'a'}, {kind: 'note', id: 'b'}], reopen ? {noteId: 'a'} : {});
    if (revoke === 'origin') h.context.state.notes[0].provenance.origin.private = true;
    if (revoke === 'trash') h.context.state.trash = [{data: {runs: [{id: 'gone-run', private: true}]}}];
    if (revoke === 'duplicate') h.context.state.notes.push({...h.context.state.notes[0]});
    gate.resolve(true); assert.equal(await pending, false, `${reopen}/${revoke}`); assert.deepEqual(h.calls.opened, []);
  }
  const h = actionHarness(); assert.equal(await h.context.openSourceComparison([{kind: 'note', id: 'a'}, {kind: 'note', id: 'b'}]), true);
  assert.equal(await h.context.openSourceComparison(undefined, {noteId: 'a'}), true); assert.equal(h.calls.opened.length, 2);
});

test('merge rejects privacy changes while its editor leave waits before evaluating a preview', async () => {
  for (const revoke of ['origin', 'duplicate', 'trash']) {
    const h = actionHarness(), gate = deferred(); h.setLeave(() => gate.promise);
    const pending = h.context.requestNoteMerge(['a', 'b']);
    if (revoke === 'origin') h.context.state.notes[0].provenance.origin.private = true;
    if (revoke === 'duplicate') h.context.state.notes.push({...h.context.state.notes[0]});
    if (revoke === 'trash') h.context.state.trash = [{data: {conversations: [{id: 'gone-chat', private: true}]}}];
    gate.resolve(true); assert.equal(await pending, false); assert.equal(h.calls.preview, 0); assert.equal(h.dialogs.length, 0);
  }
});

test('merge refuses a source becoming private while the review dialog is open before applying or saving', async () => {
  const h = actionHarness(), pending = h.context.requestNoteMerge(['a', 'b']); await tick();
  const dialog = h.dialogs[0]; assert.ok(dialog?.open);
  h.context.state.notes[0].provenance.origin.private = true; const before = JSON.stringify(h.context.state);
  await dialog.querySelector('form').onsubmit({preventDefault() {}});
  assert.equal(h.calls.apply, 0); assert.equal(h.calls.commits, 0); assert.equal(JSON.stringify(h.context.state), before);
  assert.match(dialog.querySelector('[role=status]').textContent, /不可用/);
  dialog.close(); assert.equal(await pending, false);
});

test('merge checks automatically included paper main note before displaying its actual private body', async () => {
  const state = notesState(); state.notes.forEach(note => {note.sourceAttachmentIds = ['pdf'];});
  state.notes.push({id: 'main', title: 'PRIVATE_AUTO_MAIN', content: 'PRIVATE_AUTO_BODY', projectId: 'p', workspace: '科研', provenance: {origin: {private: true}}, sourceAttachmentIds: ['pdf']});
  state.papers.push({id: 'paper', projectId: 'p', workspace: '科研', noteId: 'main', sourceAttachmentIds: ['pdf']});
  state.imports.push({id: 'pdf', projectId: 'p', name: 'Synthetic.pdf'});
  const h = actionHarness(state), pending = h.context.requestNoteMerge(['a', 'b']); await tick();
  // Close an accidentally opened dialog before asserting, so a red regression
  // never leaves an unresolved promise or masks the exposed preview content.
  const visible = h.dialogs.map(dialog => dialog.querySelector('pre').textContent).join('\n');
  h.dialogs.forEach(dialog => dialog.close());
  assert.equal(await pending, false); assert.equal(h.dialogs.length, 0); assert.doesNotMatch(visible, /PRIVATE_AUTO_/);
});

test('merge of public retained notes still previews and saves after all origin run and chat records disappeared', async () => {
  const h = actionHarness(), pending = h.context.requestNoteMerge(['a', 'b']); await tick();
  const dialog = h.dialogs[0]; assert.ok(dialog?.open); assert.match(dialog.querySelector('pre').textContent, /Public body a.*Public body b/s);
  await dialog.querySelector('form').onsubmit({preventDefault() {}});
  assert.equal(await pending, true); assert.equal(h.calls.apply, 1); assert.equal(h.calls.commits, 1);
  assert.equal(h.context.state.notes.length, 1); assert.match(h.context.state.notes[0].content, /Public body b/);
});
