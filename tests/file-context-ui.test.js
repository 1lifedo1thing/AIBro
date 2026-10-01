const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const FileContext = require('../app/file-context');
const CitationEvidence = require('../app/citation-evidence');
const source = fs.readFileSync(require.resolve('../app/file-context-ui'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await tick(); assert.ok(predicate(), 'Expected async operation to reach its persistence boundary'); };

function harness(options = {}) {
  let document;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.style = {}; this.className = ''; this.value = ''; this.hidden = false; this.open = false; this._text = ''; this.offsetWidth = 500; }
    append(...nodes) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); }
    after(node) { const parent = this.parentElement; node.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async fire(type, values = {}) { const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...values }; if (this[`on${type}`]) await this[`on${type}`](event); for (const handler of this.listeners[type] || []) await handler(event); }
    dispatchEvent(event) { void this.fire(event.type); }
    all() { return [this, ...this.children.flatMap(node => node.all())]; }
    matches(selector) { if (selector.includes(',')) return selector.split(',').some(part => this.matches(part)); return selector.startsWith('#') ? this.id === selector.slice(1) : selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : selector.startsWith('[role=') ? this.attributes.role === selector.slice(6, -1) : selector.startsWith('[data-mode=') ? this.dataset.mode === selector.slice(11, -1) : this.tagName === selector; }
    querySelector(selector) { return this.all().find(node => node.matches(selector)) || null; }
    querySelectorAll(selector) { return this.all().filter(node => node.matches(selector)); }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    contains(target) { return this.all().includes(target); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { if (!this.open) return; this.open = false; void this.fire('close'); }
    getBoundingClientRect() { return { width: 700, left: 100, top: 600 }; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    scrollIntoView() {}
  }
  const body = new Element('body'), composer = new Element('section'), input = new Element('textarea'), staged = new Element('div'), attach = new Element('button');
  composer.id = 'composer'; input.id = 'agentInput'; staged.id = 'stagedAttachments'; attach.id = 'chatAttach'; composer.append(input, staged, attach); body.append(composer);
  document = { body, activeElement: null, createElement: tag => new Element(tag), addEventListener() {}, querySelector: selector => body.querySelector(selector) };
  const state = { projects: [{ id: 'p', name: 'Visible project', localFolder: { id: 'folder', name: 'Workspace' } }], notes: [{ id: 'n', title: 'Visible note', content: 'Current text', projectId: 'p' }], imports: [{ id: 'i', name: 'Visible import', createdAt: 1, originalName: 'sample.pdf', projectId: 'p' }], conversations: [{ id: 'c', messages: [] }, { id: 'other', messages: [] }], agentRuns: [] };
  let currentId = 'c', privateMode = false, changes = 0, saves = 0;
  const calls = [], commands = [], toasts = [], opens = [];
  const F = { ...FileContext, request: async (...args) => { calls.push(args); return options.request ? options.request(...args) : { version: 'v2', text: 'Visible text', nextOffset: null, entries: [{ name: 'visible.md', path: 'visible.md', type: 'file', supported: true }] }; } };
  if (options.libraryRef) F.libraryRef = options.libraryRef;
  const sandbox = { document, FileContext: F, CitationEvidence, innerWidth: 1000, innerHeight: 800, structuredClone, AbortController, requestAnimationFrame: callback => callback(), addEventListener() {}, Event: class { constructor(type) { this.type = type; } } };
  vm.runInNewContext(source, sandbox);
  const hooks = { getState: () => state, getConversation: () => state.conversations.find(c => c.id === currentId), isPrivate: () => privateMode, onChange: () => { changes++; }, save: async () => { saves++; return options.save ? options.save() : true; }, toast: value => toasts.push(value), open: (...args) => opens.push(args) };
  if (options.mutate) hooks.mutate = async command => { commands.push(command); return options.mutate(command, state.conversations.find(c => c.id === command.conversationId)); };
  const ui = sandbox.FileContextUI; ui.init(hooks);
  const node = selector => body.querySelector(selector);
  const choose = () => node('.file-context-option').fire('click');
  return { ui, state, hooks, body, input, composer, node, choose, calls, commands, toasts, opens, get conversation() { return hooks.getConversation(); }, set current(value) { currentId = value; }, set private(value) { privateMode = value; }, get changes() { return changes; }, get saves() { return saves; } };
}
const localRef = { type: 'local', projectId: 'p', candidateId: 'folder', path: 'visible.md', title: 'visible.md', version: 'v1' };

test('opening and refreshing the picker only read library metadata and hide private/archived owners', () => {
  const h = harness();
  h.state.projects.push({ id: 'secret', name: 'SECRET_PROJECT', private: true, localFolder: { id: 'secret-folder' } }, { id: 'old', name: 'ARCHIVED_PROJECT', archived: true, localFolder: { id: 'old-folder' } });
  h.state.notes.push({ id: 'secret-note', title: 'SECRET_TITLE', projectId: 'secret' }, { id: 'old-note', title: 'ARCHIVED_TITLE', projectId: 'old' });
  h.ui.open(); assert.doesNotMatch(h.node('#fileContextPicker').textContent, /SECRET|ARCHIVED/); h.ui.refresh(); assert.equal(h.calls.length, 0);
  h.state.projects[0].private = true; h.ui.refresh(); assert.doesNotMatch(h.node('#fileContextPicker').textContent, /Visible note|Visible import/);
});

test('picker add uses and awaits the durable coordinator before closing or announcing changes', async () => {
  const gate = deferred(), h = harness({ mutate: async (command, conversation) => { await gate.promise; FileContext.stage(conversation, command.ref); return true; } });
  h.ui.open(); const pending = h.choose(); await until(() => h.commands.length === 1); assert.equal(h.commands.length, 1); assert.equal(h.commands[0].action, 'add-reference'); assert.equal(h.node('#fileContextPicker').hidden, false); assert.equal(h.changes, 0); assert.equal(h.saves, 0);
  gate.resolve(); await pending; assert.equal(h.node('#fileContextPicker').hidden, true); assert.equal(h.changes, 1); assert.equal(h.conversation.draftFileReferences.length, 1);
});

test('a rejected coordinator does not fabricate success or mutate references', async () => {
  const h = harness({ mutate: async () => false }); h.ui.open(); await h.choose();
  assert.equal(h.conversation.draftFileReferences, undefined); assert.equal(h.node('#fileContextPicker').hidden, false); assert.match(h.node('.file-context-status').textContent, /未能保存/); assert.equal(h.changes, 0);
});

test('refreshing the next reference never changes historical retry snapshots', async () => {
  const h = harness(), original = { type: 'note', id: 'n', title: 'Old title', version: 'old' };
  h.conversation.messages = [{ role: 'user', fileReferences: [original], retryFileReferences: [{ ...original, version: 'retry' }] }]; const history = JSON.stringify(h.conversation.messages);
  h.ui.render(); await h.node('.file-context-chip').children[1].fire('click');
  assert.equal(JSON.stringify(h.conversation.messages), history); assert.notEqual(h.conversation.draftFileReferences[0].version, 'old'); assert.equal(h.saves, 1); assert.equal(h.changes, 1);
});

test('refresh and import removal route exact commands to the host without premature mutation', async () => {
  const h = harness({ mutate: async () => true }); h.conversation.draftFileReferences = [{ type: 'import', id: 'i', title: 'sample.pdf', version: 'v1' }]; h.conversation.draftAttachmentIds = ['i'];
  h.ui.render(); await h.node('.file-context-chip').children[1].fire('click'); assert.equal(h.commands[0].action, 'refresh-reference'); assert.equal(h.calls.length, 0);
  await h.node('.file-context-chip').children[2].fire('click'); assert.equal(h.commands[1].action, 'remove-attachment'); assert.equal(h.commands[1].id, 'i'); assert.deepEqual(h.conversation.draftAttachmentIds, ['i']); assert.equal(h.saves, 0);
});

test('fallback save is awaited and a failed save restores the draft without undoing newer unrelated changes', async () => {
  const gate = deferred(), h = harness({ save: () => gate.promise }); h.ui.open(); const pending = h.choose(); await until(() => h.saves === 1);
  h.conversation.draftAttachmentIds = ['new-concurrent-attachment']; assert.equal(h.changes, 0); gate.reject(Error('disk full')); await pending;
  assert.equal(h.conversation.draftFileReferences, undefined); assert.deepEqual(h.conversation.draftAttachmentIds, ['new-concurrent-attachment']); assert.match(h.node('.file-context-status').textContent, /disk full/); assert.equal(h.changes, 0);
});

test('local selectRef rechecks privacy after an asynchronous read and never returns secret metadata', async () => {
  const gate = deferred(), h = harness({ request: () => gate.promise }); const pending = h.ui.selectRef(localRef); h.state.projects[0].private = true; gate.resolve({ version: 'v2', text: 'SECRET' }); await assert.rejects(pending, /不可用|私密/); assert.equal(h.calls.length, 1);
  await assert.rejects(h.ui.selectRef(localRef), /不可用|私密/); assert.equal(h.calls.length, 1);
});

test('library selection cannot follow the user into a different conversation', async () => {
  const gate = deferred(), h = harness({ libraryRef: () => gate.promise, mutate: async () => true }); h.ui.open(); const pending = h.choose(); h.current = 'other'; gate.resolve({ type: 'note', id: 'n', title: 'Visible note', version: 'v2' }); await pending;
  assert.equal(h.commands.length, 0); assert.equal(h.node('#fileContextPicker').hidden, true); assert.equal(h.changes, 0);
});

test('composer drop uses the durable add path and blocks private sources', async () => {
  const h = harness({ mutate: async () => true }), event = { dataTransfer: { getData: () => JSON.stringify({ type: 'note', id: 'n' }) } };
  await h.composer.fire('drop', event); assert.equal(h.commands.length, 1); assert.equal(h.commands[0].action, 'add-reference'); assert.equal(h.changes, 1);
  h.state.projects[0].private = true; await h.composer.fire('drop', event); assert.equal(h.commands.length, 1); assert.equal(h.changes, 1);
});

test('local preview discards a late success or error after access revocation', async () => {
  for (const failure of [false, true]) {
    const gate = deferred(), h = harness({ request: () => gate.promise }); const pending = h.ui.preview(localRef), dialog = h.node('.file-reference-preview'); assert.ok(dialog.open);
    h.state.projects[0].private = true;
    if (failure) gate.reject(Error('SECRET_ERROR_PATH')); else gate.resolve({ text: 'SECRET_TEXT', nextOffset: null });
    await pending; assert.equal(dialog.open, false); assert.equal(dialog.textContent, '×继续读取'); assert.equal(h.node('.file-reference-preview'), null); assert.doesNotMatch(h.body.textContent, /SECRET/);
  }
});

test('refresh immediately redacts an open local preview and prevents another chunk from being read', async () => {
  const h = harness(); await h.ui.preview(localRef); const dialog = h.node('.file-reference-preview'), more = dialog.querySelector('footer').children[0]; assert.match(dialog.textContent, /Visible text/);
  h.state.projects[0].archived = true; h.ui.refresh(); assert.equal(h.node('.file-reference-preview'), null); assert.equal(dialog.textContent, '×继续读取'); await more.fire('click'); assert.equal(h.calls.length, 1); assert.equal(h.changes, 0);
});

test('a private source leaves no title, path or serialized reference in the rendered chip', () => {
  const h = harness(); h.conversation.draftFileReferences = [{ ...localRef, title: 'SECRET_TITLE', path: 'SECRET_PATH' }]; h.ui.render(); h.state.projects[0].private = true; h.ui.refresh(); const label = h.node('.file-context-chip-name');
  assert.equal(label.textContent, '私密来源'); assert.equal(label.disabled, true); assert.equal(label.title, undefined); assert.equal(label.dataset.fileRef, undefined); assert.doesNotMatch(h.body.textContent, /SECRET/);
  h.private = true; h.ui.refresh(); assert.equal(h.node('#fileContextChips').textContent, ''); h.ui.open(); assert.equal(h.node('#fileContextPicker').hidden, true);
});

test('local picker invalidation clears stale names and never triggers an automatic filesystem read', async () => {
  const h = harness(); h.ui.open(); await h.node('[data-mode=local]').fire('click'); assert.equal(h.calls.length, 0); await h.choose(); assert.equal(h.calls.length, 1); assert.match(h.node('#fileContextPicker').textContent, /visible.md/);
  h.state.projects[0].private = true; h.ui.refresh(); assert.equal(h.node('#fileContextPicker').hidden, true); assert.doesNotMatch(h.node('#fileContextPicker').textContent, /visible.md|Visible project/); assert.equal(h.calls.length, 1);
});
