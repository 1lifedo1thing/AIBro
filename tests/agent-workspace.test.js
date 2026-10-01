const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/agent-workspace.js'), 'utf8');

function harness({ workbench = true } = {}) {
  let document;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.hidden = false; this.className = ''; this._html = ''; this._text = ''; this.classList = { contains: value => this.className.split(' ').includes(value), add: value => this.classList.toggle(value, true), remove: value => this.classList.toggle(value, false), toggle: (value, on) => { const items = new Set(this.className.split(' ').filter(Boolean)); if (on === undefined) on = !items.has(value); on ? items.add(value) : items.delete(value); this.className = [...items].join(' '); return on; } }; }
    get firstElementChild() { return this.children[0] || null; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    prepend(node) { node.remove(); node.parentElement = this; this.children.unshift(node); }
    insertBefore(node, before) { if (!before) return this.append(node); node.remove(); node.parentElement = this; this.children.splice(this.children.indexOf(before), 0, node); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this._html = ''; this.append(...nodes); }
    set innerHTML(value) { this.replaceChildren(); this._html = value; if (value.includes('data-workspace-choose')) this.append(new Element('button')); }
    get innerHTML() { return this._html; }
    set textContent(value) { this.replaceChildren(); this._text = value; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    all() { return [this, ...this.children.flatMap(node => node.all())]; }
    querySelector(selector) { return this.all().find(node => selector[0] === '#' ? node.id === selector.slice(1) : selector[0] === '.' ? node.classList.contains(selector.slice(1)) : selector.startsWith('[data-inspector=') ? node.dataset.inspector === selector.slice(17, -2) : node.tagName === selector) || null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(key, fn) { (this.listeners[key] ||= []).push(fn); }
    cloneNode() { const node = new Element(this.tagName); node.className = this.className; node._html = this._html; node._text = this._text; return node; }
    click() { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }; this.onclick?.(event); for (const fn of this.listeners.click || []) fn(event); return event; }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { width: 900 }; }
    getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
  }
  document = new Element('document'); document.body = new Element('body'); document.append(document.body); document.body.dataset.view = 'agent';
  document.createElement = tag => new Element(tag); document.getElementById = id => document.all().find(node => node.id === id) || null;
  const add = (id, parent = document.body, classes = '', tag = 'div') => { const node = new Element(tag); node.id = id; node.className = classes; parent.append(node); return node; };
  const home = add('chatGrid', document.body, 'chat-grid'), pane = add('conversationInspector', home), tabs = add('inspectorTabs', pane, 'inspector-tabs'), contextTab = add('contextTab', tabs, 'inspector-tab', 'button'); contextTab.dataset.inspector = 'context';
  const context = add('inspectorContext', pane), reader = add('readingPane'), toolbar = add('readingToolbar', reader, 'reading-toolbar'); add('readingExpand', toolbar); add('actions', document.body, 'chat-header-actions'); add('footer', document.body, 'composer-footer'); add('inspectorToggle', document.body, '', 'button');
  const state = { ui: { inspector: 'context', inspectorOpen: true }, projects: [{ id: 'p', name: 'Project' }], notes: [], imports: [], agentRuns: [] };
  let conversation = { id: 'c1', projectId: 'p', messages: [] }, refreshes = 0, opens = 0, treeRenders = 0, observerCount = 0, resizeCount = 0, saves = 0;
  const ctx = { document, console, MutationObserver: class { constructor() { observerCount++; } observe() {} }, ResizeObserver: class { constructor() { resizeCount++; } observe() {} }, ProjectFiles: { renderForProject(host) { treeRenders++; host.replaceChildren(new Element('nav')); } } };
  function installWorkbench() { if (!document.getElementById('contextWorkbench')) add('contextWorkbench', context); ctx.ContextWorkbench = { refresh() { refreshes++; }, open() { opens++; state.ui.inspector = 'context'; state.ui.inspectorOpen = true; api.updateTabs(); this.refresh(); } }; }
  if (workbench) installWorkbench();
  vm.createContext(ctx); vm.runInContext(source, ctx); const api = ctx.AgentWorkspace;
  const hooks = { state: () => state, conversation: () => conversation, apply: () => api.updateTabs(), save: () => saves++ };
  api.init(hooks);
  return { api, hooks, document, state, pane, home, reader, contextTab, add, installWorkbench, context, setConversation: value => { conversation = value; }, counts: () => ({ refreshes, opens, treeRenders, observerCount, resizeCount, saves }) };
}

test('workbench replaces only request evidence ownership, preserving one island host and file tree', () => {
  const h = harness();
  assert.equal(h.document.getElementById('requestContextEvidence'), null);
  const root = h.document.getElementById('contextWorkbench'), focus = h.add('contextSourceSearch', root, '', 'input'); focus.focus();
  h.state.ui.inspector = 'files'; h.api.updateTabs(); const tree = h.document.getElementById('conversationProjectFiles').firstElementChild;
  h.state.ui.inspector = 'context';
  for (let n = 0; n < 40; n++) h.api.sync();
  h.api.init(h.hooks);
  assert.equal(h.document.activeElement, focus); assert.equal(h.document.getElementById('contextWorkbench'), root);
  assert.equal(h.document.getElementById('conversationProjectFiles').firstElementChild, tree);
  for (const id of ['contextWorkbench', 'conversationProjectFiles', 'inspectorFiles', 'workspaceFilesToggle', 'readerFilesToggle']) assert.equal(h.document.all().filter(node => node.id === id).length, 1, id);
  assert.equal(h.counts().treeRenders, 1); assert.equal(h.counts().observerCount, 1); assert.equal(h.counts().resizeCount, 1);
  assert.equal(h.counts().refreshes, 42);
});

test('context click opens through host callback once; closing and reopening preserve the island', () => {
  const h = harness(), root = h.document.getElementById('contextWorkbench');
  h.state.ui.inspectorOpen = false;
  const event = h.contextTab.click(); assert.equal(event.stopped, true); assert.equal(h.counts().opens, 1); assert.equal(h.state.ui.inspectorOpen, true);
  h.pane.querySelector('.workspace-inspector-close').click(); assert.equal(h.state.ui.inspectorOpen, false); assert.equal(h.document.activeElement.id, 'inspectorToggle');
  h.contextTab.click(); assert.equal(h.counts().opens, 2); assert.equal(h.document.getElementById('contextWorkbench'), root);
});

test('reader docking and restoration never reparent the island or replace file navigation', () => {
  const h = harness(), root = h.document.getElementById('contextWorkbench');
  h.state.ui.inspector = 'files'; h.api.updateTabs(); const tree = h.document.getElementById('conversationProjectFiles').firstElementChild;
  h.document.body.classList.add('reading-open'); h.api.updateTabs(); assert.equal(h.pane.parentElement, h.reader);
  h.state.ui.inspector = 'context'; h.api.sync(); assert.equal(h.reader.classList.contains('with-context-workbench'), true); assert.equal(h.pane.parentElement, h.reader); assert.equal(root.parentElement, h.context);
  h.state.ui.inspectorOpen = false; h.api.updateTabs(); assert.equal(h.reader.classList.contains('with-context-workbench'), false); assert.equal(h.pane.parentElement, h.home);
  h.state.ui.inspectorOpen = true; h.api.updateTabs(); assert.equal(h.pane.parentElement, h.reader);
  h.document.body.classList.remove('reading-open'); h.api.updateTabs(); assert.equal(h.pane.parentElement, h.home);
  assert.equal(h.document.getElementById('conversationProjectFiles').firstElementChild, tree); assert.equal(h.counts().treeRenders, 1);
});

test('conversation switching and an empty selection always refresh the owner without reinitialization', () => {
  const h = harness(), root = h.document.getElementById('contextWorkbench');
  h.setConversation({ id: 'c2', messages: [] }); h.api.sync();
  assert.equal(h.document.getElementById('workspaceFilesToggle').hidden, true);
  h.setConversation(null); h.api.sync();
  assert.equal(h.counts().refreshes, 3); assert.equal(h.document.getElementById('contextWorkbench'), root); assert.equal(h.counts().observerCount, 1);
});

test('Wiki and archived projects do not expose a reader file button owned by the previous conversation',()=>{
  const h=harness(),toggle=h.document.getElementById('readerFilesToggle');
  assert.equal(toggle.hidden,false);h.document.body.dataset.view='wiki';h.api.updateTabs();assert.equal(toggle.hidden,true);
  h.document.body.dataset.view='agent';h.api.updateTabs();assert.equal(toggle.hidden,false);
  h.state.projects[0].archived=true;h.api.updateTabs();assert.equal(toggle.hidden,true);
});

test('without a workbench module legacy evidence remains usable, and late availability retires it once', () => {
  const h = harness({ workbench: false });
  const legacy = h.document.getElementById('requestContextEvidence'); assert.match(legacy.innerHTML, /最近一次请求/);
  const event = h.contextTab.click(); assert.equal(event.stopped, undefined);
  h.installWorkbench(); h.api.sync(); assert.equal(h.document.getElementById('requestContextEvidence'), null); assert.equal(h.counts().refreshes, 1);
  h.api.sync(); assert.equal(h.document.getElementById('requestContextEvidence'), null);
});
