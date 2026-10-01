'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/cloud-sync-ui.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
const config = { target: 'research-fixture', sshPort: 0, localPort: 18787, remotePort: 8787 };
const pendingJob = patch => ({ id: '0123456789abcdef0123456789abcdef', state: 'uncertain', config: { ...config }, source: '/srv/original', destination: '/mnt/research', message: '本机服务已重启，服务器迁移结果尚未核对。', ...patch });
const ok = value => ({ ok: true, json: async () => copy(value) });

// Synthetic transport and an owned DOM/controller fixture. No real SSH, server,
// credentials, user data, timers or browser are involved in these recovery tests.
function fixture(options = {}) {
  const elements = [], calls = [], surfaces = {}, timers = new Set();
  let metadata = { config: { ...config }, remote: null, job: pendingJob(), hosts: [], ...options.metadata };
  const status = { connected: true, state: 'paused', autoSync: false, pending: 0, conflicts: 0, target: { serverUrl: 'http://127.0.0.1:18787', accountId: 'fixture' }, serverUrl: 'http://127.0.0.1:18787', account: { username: 'fixture' }, device: { id: 'fixture-device', name: 'Fixture Mac' } };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.checked = false; this.hidden = false; elements.push(this); }
    set innerHTML(_) { throw new Error('Recovery metadata must not render as HTML'); }
    append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    replaceWith(...children) { const parent = this.parentNode, index = parent.children.indexOf(this); for (const child of children) child.parentNode = parent; parent.children.splice(index, 1, ...children); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async fire(type) { for (const handler of this.listeners[type] || []) await handler({ preventDefault() {}, target: this, currentTarget: this }); }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    contains(other) { return this === other || this.children.some(child => child.contains(other)); }
    focus() { doc.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; void this.fire('close'); }
  }
  const host = new Element('section'), doc = { createElement: tag => new Element(tag), body: new Element('body'), visibilityState: 'visible', querySelector: selector => selector === '#settings .settings-grid' ? host : null, getElementById: id => elements.find(item => item.id === id) };
  doc.body.dataset.view = 'settings';
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL, AbortController, setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; }, clearTimeout: timer => timers.delete(timer) });
  const environment = { document: doc, disablePolling: true, HalaskaUI: { componentNames: ['CloudSyncOverview', 'CloudSSHStorage', 'CloudSSHConnection'], mount: (element, name, props) => { surfaces[name] = props; return { update: value => { surfaces[name] = value; }, unmount: () => { delete surfaces[name]; } }; } } };
  const api = module.exports.createController({ flush: async () => true, fetch: async (url, init) => {
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(call);
    const custom = await options.fetch?.(call); if (custom) return custom;
    if (url === '/__cloud/ssh') return ok(metadata);
    if (url === '/__cloud/ssh/reconcile') return ok(metadata);
    if (url === '/__cloud/devices') return ok({ devices: [] });
    return ok(status);
  } }, environment).init();
  return { api, doc, calls, surfaces, timers, el: id => doc.getElementById(id), get metadata() { return metadata; }, set metadata(value) { metadata = value; }, async ready() { await api.refresh(); await tick(); }, async open() { await api.refresh(); await tick(); await surfaces.CloudSyncOverview.onSSHStorage(); } };
}
const storage = h => h.surfaces.CloudSSHStorage;
const overview = h => h.surfaces.CloudSyncOverview;
const posts = h => h.calls.filter(call => call.method === 'POST');

test('fresh metadata reveals persisted uncertainty in the overview before any maintenance dialog is opened', async t => {
  const h = fixture(); t.after(() => h.api.destroy()); await h.ready();
  assert.equal(overview(h).ssh.job.id, '0123456789abcdef0123456789abcdef');
  assert.equal(overview(h).ssh.pending, true); assert.equal(overview(h).blocked, true);
  assert.equal(typeof overview(h).onSSHStorage, 'function');
  await h.api.sync(); await overview(h).onAuto(true); await overview(h).onDisconnect(); await h.api.openSSHConnection('another-host');
  assert.equal(posts(h).length, 0, 'unknown remote outcome cannot start a mutation');
  assert.equal(h.surfaces.CloudSSHConnection, undefined);
});

test('recovered operation restores its identity, host and destination without treating saved paths as verified', async t => {
  const h = fixture(); t.after(() => h.api.destroy()); await h.open();
  const draft = storage(h).draft;
  assert.equal(draft.job.id, '0123456789abcdef0123456789abcdef'); assert.equal(draft.uncertain, true);
  assert.equal(draft.config.target, config.target); assert.equal(draft.destination, '/mnt/research');
  assert.equal(draft.verified, false); assert.equal(draft.confirmed, false);
  storage(h).onChange('target', 'not-the-recovered-host'); storage(h).onChange('destination', '/wrong/destination'); storage(h).onChange('confirmed', true);
  assert.equal(storage(h).draft.config.target, config.target); assert.equal(storage(h).draft.destination, '/mnt/research'); assert.equal(storage(h).draft.confirmed, false);
  await storage(h).onInspect(); await storage(h).onSave(); await storage(h).onMove();
  assert.equal(posts(h).length, 0);
});

test('a missing tunnel retains the recoverable job configuration without silently reconnecting', async t => {
  const h = fixture({ metadata: { config: null } }); t.after(() => h.api.destroy()); await h.open();
  assert.equal(storage(h).draft.job.id, '0123456789abcdef0123456789abcdef'); assert.equal(storage(h).draft.config.target, config.target);
  assert.equal(storage(h).draft.uncertain, true); assert.equal(storage(h).draft.verified, false);
  assert.equal(typeof storage(h).onReconcile, 'function'); await storage(h).onConnect();
  assert.equal(posts(h).length, 0); assert.equal(h.surfaces.CloudSSHConnection, undefined);
});

test('opening, metadata refresh and recovered uncertainty never launch remote reconciliation or live-move polling', async t => {
  const h = fixture(); t.after(() => h.api.destroy()); await h.open();
  await storage(h).onRefresh(); await h.el('cloudRefresh').fire('click'); await tick();
  assert.equal(posts(h).length, 0); assert.equal(h.calls.every(call => call.method === 'GET'), true);
  assert.equal(storage(h).draft.uncertain, true); assert.equal(overview(h).ssh.pending, true);
  assert.equal([...h.timers].some(timer => timer.ms === 1500), false, 'restart uncertainty is not a live running job');
});

test('explicit remote reconciliation sends only the persisted job identity and an uncertain result stays locked', async t => {
  const h = fixture(); t.after(() => h.api.destroy()); await h.open();
  await storage(h).onReconcile();
  assert.deepEqual(posts(h), [{ url: '/__cloud/ssh/reconcile', method: 'POST', body: { jobId: '0123456789abcdef0123456789abcdef' } }]);
  assert.equal(storage(h).draft.uncertain, true); assert.equal(overview(h).ssh.pending, true);
  assert.equal(storage(h).draft.job.id, '0123456789abcdef0123456789abcdef'); assert.equal(storage(h).draft.verified, false);
});

for (const terminalState of ['completed', 'error']) test(`confirmed ${terminalState} reconciliation releases the lock but still requires a fresh inspection and consent`, async t => {
  const terminal = { config, remote: { dataPath: terminalState === 'completed' ? '/mnt/research' : '/srv/original' }, job: pendingJob({ state: terminalState, message: '已根据服务器回执核对结果。' }) };
  const h = fixture({ fetch: call => call.url === '/__cloud/ssh/reconcile' ? ok(terminal) : null }); t.after(() => h.api.destroy()); await h.open();
  await storage(h).onReconcile();
  assert.equal(storage(h).draft.job.state, terminalState); assert.equal(storage(h).draft.uncertain, false);
  assert.equal(overview(h).ssh.pending, false); assert.equal(overview(h).blocked, false);
  assert.equal(storage(h).draft.verified, false); assert.equal(storage(h).draft.confirmed, false);
  await storage(h).onMove(); assert.equal(h.calls.some(call => call.url === '/__cloud/ssh/move'), false);
});

test('a failed reconciliation preserves the job and never resumes automatic sync', async t => {
  const h = fixture({ fetch: call => { if (call.url === '/__cloud/ssh/reconcile') throw new Error('synthetic network unavailable'); } }); t.after(() => h.api.destroy()); await h.open();
  await storage(h).onReconcile();
  assert.equal(storage(h).draft.job.id, '0123456789abcdef0123456789abcdef'); assert.equal(storage(h).draft.uncertain, true);
  assert.equal(overview(h).ssh.pending, true); assert.equal(storage(h).draft.busy, '');
  assert.equal(h.calls.some(call => call.url === '/__cloud/settings' || call.url === '/__cloud/sync'), false);
});

test('reconciliation is single-flight and its completion cannot replace a subsequently opened dialog or steal focus', async t => {
  let release;
  const terminal = { config, remote: { dataPath: '/mnt/research' }, job: pendingJob({ state: 'completed', message: '本次迁移已确认完成。' }) };
  const h = fixture({ fetch: call => call.url === '/__cloud/ssh/reconcile' ? new Promise(resolve => { release = () => resolve(ok(terminal)); }) : null }); t.after(() => h.api.destroy()); await h.open();
  const old = storage(h), reconciling = old.onReconcile(); await tick();
  await old.onReconcile(); await old.onSave(); await old.onMove();
  assert.equal(posts(h).length, 1);
  h.el('cloudSyncDialog').close(); await h.api.devices();
  const activeDialog = h.el('cloudSyncDialog'), body = h.el('cloudSyncDialogTitle').textContent;
  h.el('cloudRefresh').focus(); release(); await reconciling;
  assert.equal(activeDialog.open, true); assert.equal(h.el('cloudSyncDialogTitle').textContent, body); assert.equal(body, '已连接的设备');
  assert.equal(h.doc.activeElement, h.el('cloudRefresh')); assert.equal(storage(h), undefined);
  assert.equal(overview(h).ssh.job.state, 'completed'); assert.equal(overview(h).ssh.pending, false);
});

test('a metadata request started during reconciliation cannot revert a confirmed result when its older reply arrives late', async t => {
  let releaseReconcile, releaseMetadata, holdMetadata = false;
  const terminal = { config, remote: { dataPath: '/mnt/research' }, job: pendingJob({ state: 'completed', message: '本次迁移已确认完成。' }) };
  const h = fixture({ fetch: call => {
    if (call.url === '/__cloud/ssh/reconcile') return new Promise(resolve => { releaseReconcile = () => resolve(ok(terminal)); });
    if (call.url === '/__cloud/ssh' && holdMetadata) return new Promise(resolve => { releaseMetadata = () => resolve(ok({ config, remote: null, job: pendingJob() })); });
  } }); t.after(() => h.api.destroy()); await h.open();
  const reconciling = storage(h).onReconcile(); await tick();
  holdMetadata = true; await h.el('cloudRefresh').fire('click'); await tick(); assert.equal(typeof releaseMetadata, 'function');
  releaseReconcile(); await reconciling; assert.equal(overview(h).ssh.job.state, 'completed');
  releaseMetadata(); await tick();
  assert.equal(overview(h).ssh.job.state, 'completed'); assert.equal(overview(h).ssh.pending, false); assert.equal(overview(h).blocked, false);
});

test('missing metadata never discards the known unresolved operation identity needed for explicit reconciliation', async t => {
  const h = fixture(); t.after(() => h.api.destroy()); await h.open();
  h.metadata = { config, remote: null, job: null, hosts: [] };
  await storage(h).onRefresh();
  assert.equal(storage(h).draft.uncertain, true); assert.equal(overview(h).ssh.pending, true);
  assert.equal(storage(h).draft.job?.id, '0123456789abcdef0123456789abcdef');
  assert.equal(storage(h).draft.destination, '/mnt/research');
});

test('an unreadable recovery identity remains visible and blocked without inventing a new request identity', async t => {
  const h = fixture({ metadata: { job: pendingJob({ id: '', message: '迁移记录无法读取，结果仍待确认。' }) } }); t.after(() => h.api.destroy()); await h.open();
  assert.equal(overview(h).ssh.pending, true); assert.equal(storage(h).draft.uncertain, true);
  await storage(h).onReconcile(); await storage(h).onMove(); await storage(h).onSave(); await h.api.openSSHConnection('another-host');
  assert.equal(posts(h).length, 0); assert.equal(storage(h).draft.job.id, '');
  assert.match(storage(h).draft.message, /记录无法读取/);
});

test('a remote receipt for a different attempt cannot resolve the recovered operation even when paths match', async t => {
  const h = fixture({ fetch: call => call.url === '/__cloud/ssh/reconcile' ? ok({ config, job: pendingJob({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', state: 'completed' }) }) : null }); t.after(() => h.api.destroy()); await h.open();
  await storage(h).onReconcile();
  assert.equal(storage(h).draft.uncertain, true); assert.equal(overview(h).ssh.pending, true);
  assert.equal(storage(h).draft.job.id, '0123456789abcdef0123456789abcdef'); assert.equal(overview(h).ssh.job.id, '0123456789abcdef0123456789abcdef');
});
