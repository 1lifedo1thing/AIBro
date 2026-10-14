// Real AgentProgress markup and patchLive in an isolated Node DOM. A spy
// HalaskaUI records mount/update/unmount; no React, GUI, network or user data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const ROOT = path.resolve(__dirname, '..');

function fixture() {
  const { window } = parseHTML('<html><body><main id="root"></main></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); } });
  const mounted = new Map(), calls = { mount: 0, update: 0, unmount: 0 };
  const HalaskaUI = {
    mount(host, name, props) { assert.equal(mounted.has(host), false, 'double mount'); mounted.set(host, { name, props }); host.textContent = props.title || props.label || name; calls.mount++; },
    update(host, props) { assert.ok(mounted.has(host), 'update needs a mounted host'); mounted.get(host).props = props; host.textContent = props.title || props.label || ''; calls.update++; },
    unmount(host) { assert.ok(mounted.has(host), 'unmount needs a mounted host'); mounted.delete(host); calls.unmount++; },
  };
  const context = { document: window.document, HalaskaUI, Date, queueMicrotask, getSelection: () => null, WorkstationI18n: { getLanguage: () => 'zh' } };
  for (const key of ['MutationObserver', 'Element', 'HTMLElement', 'Node', 'Event']) context[key] = window[key];
  context.window = context; context.globalThis = context; vm.createContext(context);
  for (const file of ['agent-progress.js', 'halaska-conversation.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', file), 'utf8'), context);
  const { AgentProgress, HalaskaConversation } = context;
  const tool = (n, status = 'completed') => ({ id: `read-${n}`, kind: 'tool', name: 'read_file', text: `docs/${n}.md`, status, at: 1000 + n * 10, updatedAt: 1005 + n * 10 });
  const message = { id: 'm', role: 'agent', live: false, runStatus: 'completed', at: 1000, finishedAt: 9000, progressPins: {}, activities: Array.from({ length: 6 }, (_, n) => tool(n)) };
  const run = { id: 'r', status: 'completed', startedAt: 1000, finishedAt: 9000 };
  const render = previous => {
    const wrapper = window.document.createElement('article'); wrapper.className = 'message-wrap'; wrapper.dataset.messageId = message.id;
    wrapper.innerHTML = AgentProgress.markup(message) + '<div class="message-body"></div>';
    HalaskaConversation.enhance(wrapper, message, run, { previous }); return wrapper;
  };
  const current = render(); window.document.querySelector('#root').append(current);
  const rowRoots = node => [...node.querySelectorAll('[data-activity-id] summary')].filter(s => s.querySelector(':scope > [data-halaska-conversation]')).length;
  const patch = () => { AgentProgress.patchLive(current, render(current)); };
  // Browsers deliver the non-bubbling toggle to document capture listeners;
  // linkedom only propagates bubbling events, so the fixture sets bubbles.
  const toggle = details => { details.open = true; details.dispatchEvent(new window.Event('toggle', { bubbles: true })); };
  return { window, current, message, run, calls, mounted, tool, rowRoots, patch, toggle, C: HalaskaConversation, render };
}

test('a settled message mounts only its visible feed summary; rows wait for their disclosure', () => {
  const f = fixture();
  const feed = f.current.querySelector('.agent-progress');
  assert.equal(feed.open, false);
  assert.equal(f.calls.mount, 1, 'only the visible lifecycle summary mounts');
  assert.equal(f.rowRoots(f.current), 0);
  // Plain markup stays readable for find/select and the closed group's label.
  assert.match(f.current.querySelector('.progress-group-details > summary').textContent, /read_file ×6/);
});

test('opening the feed mounts the group, opening the group mounts its rows, each exactly once', () => {
  const f = fixture();
  const feed = f.current.querySelector('.agent-progress'), group = f.current.querySelector('.progress-group-details');
  f.toggle(feed);
  assert.ok(group.querySelector(':scope > summary > [data-halaska-conversation]'), 'group summary mounted');
  assert.equal(f.rowRoots(f.current), 0, 'rows inside the still-closed group stay plain');
  // The capture listener mounts before the native toggle and animation measure.
  group.querySelector(':scope > summary').dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(f.rowRoots(f.current), 6);
  const before = f.calls.mount;
  f.toggle(group);
  assert.equal(f.calls.mount, before, 'a later toggle is a no-op');
});

test('stream patches keep plain rows plain with current props, and revealed rows show the latest state', () => {
  const f = fixture();
  f.message.live = true; f.message.runStatus = 'running'; f.run.status = 'running';
  f.message.progressPins = { 'group:read-0': false };
  f.message.activities.push(f.tool(6, 'running'));
  const summary = f.current.querySelector('[data-activity-id="read-0"] summary');
  for (let i = 0; i < 5; i++) { f.message.activities[6].text += ` ${i}`; f.patch(); }
  assert.equal(f.current.querySelector('[data-activity-id="read-0"] summary'), summary, 'patch keeps the connected summary');
  assert.equal(f.rowRoots(f.current), 0);
  assert.equal(f.calls.unmount, 0);
  f.message.activities[6].status = 'failed'; f.patch();
  const group = f.current.querySelector('.progress-group-details');
  f.toggle(group);
  const last = [...f.mounted.entries()].find(([host]) => host.closest('[data-activity-id="read-6"]'));
  assert.equal(last?.[1].props.status, 'failed', 'reveal uses the latest staged props');
});

test('a mounted row keeps its root across patches even when its group later closes', () => {
  const f = fixture();
  const feed = f.current.querySelector('.agent-progress'), group = f.current.querySelector('.progress-group-details');
  f.toggle(feed);
  f.toggle(group);
  const host = f.current.querySelector('[data-activity-id="read-2"] summary > [data-halaska-conversation]');
  f.message.progressPins = { feed: true, 'group:read-0': false };
  const mounts = f.calls.mount;
  f.patch(); f.patch();
  assert.equal(f.current.querySelector('[data-activity-id="read-2"] summary > [data-halaska-conversation]'), host);
  assert.equal(f.calls.mount, mounts, 'no transient remounts');
  assert.equal(f.mounted.size, f.current.querySelectorAll('[data-halaska-conversation]').length);
});

test('a detached render holder never mounts on a queued toggle, and discard leaves no roots', () => {
  const f = fixture();
  const holder = f.render(f.current), detached = holder.querySelector('.agent-progress');
  const before = f.calls.mount;
  detached.open = true; f.C.reveal(detached);
  assert.equal(f.calls.mount, before);
  f.C.discard(holder); f.C.discard(f.current); f.current.remove();
  assert.equal(f.mounted.size, 0);
});
