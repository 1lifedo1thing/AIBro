const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/electron-main.js'), 'utf8');
const factorySource = source.slice(source.indexOf('function createDraftExitGate('), source.indexOf('\nconst desktopExitGate ='));
const factory = vm.runInNewContext(`${factorySource}\ncreateDraftExitGate`, { setTimeout, clearTimeout });
const drain = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness(options = {}) {
  const calls = [], timers = new Map(); let serial = 0;
  const window = { destroyed: false, isDestroyed() { return this.destroyed; } };
  const h = { window, current: window, calls, timers, counts: { workspace: 0, drafts: 0, prompts: 0 } };
  h.schedule = (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; };
  h.unschedule = id => timers.delete(id);
  h.fire = ms => { const timer = [...timers].find(([, value]) => value.ms === ms); assert.ok(timer, `missing ${ms} ms timer`); timers.delete(timer[0]); timer[1].fn(); };
  h.gate = factory({
    getWindow: () => h.current,
    flushWorkspace: target => { h.counts.workspace++; calls.push('workspace'); return options.workspace ? options.workspace(target) : Promise.resolve(); },
    flushDrafts: target => { h.counts.drafts++; calls.push('drafts'); return options.drafts ? options.drafts(target) : Promise.resolve(true); },
    confirmFailure: (kind, target) => { h.counts.prompts++; calls.push('confirm'); return options.confirm ? options.confirm(kind, target) : false; },
    approve: (kind, target) => calls.push({ approved: kind, window: target }),
    returned: target => calls.push({ returned: target }), schedule: h.schedule, unschedule: h.unschedule
  });
  return h;
}

test('production gate waits for workspace then actual draft acknowledgement without closing early', async () => {
  const workspace = deferred(), drafts = deferred();
  const h = harness({ workspace: () => workspace.promise, drafts: () => drafts.promise });
  assert.equal(h.gate.begin('quit', h.window), true); await drain();
  assert.deepEqual(h.calls, ['workspace']); assert.equal(h.gate.allowsUnload(h.window), false);
  workspace.resolve(); await drain();
  assert.deepEqual(h.calls, ['workspace', 'drafts']); assert.equal(h.gate.allowsUnload(h.window), false);
  drafts.resolve(true); await drain();
  assert.equal(h.gate.allowsUnload(h.window), true);
  assert.equal(h.calls.at(-1).approved, 'quit'); assert.equal(h.counts.prompts, 0); assert.equal(h.timers.size, 0);
});

test('draft failure or exception returns to editing and leaves a subsequent quit available', async () => {
  for (const drafts of [async () => false, async () => { throw Error('synthetic disk failure'); }]) {
    const h = harness({ drafts }); h.gate.begin('quit', h.window); await drain();
    assert.equal(h.gate.allowsUnload(h.window), false); assert.equal(h.counts.prompts, 1);
    assert.equal(h.calls.at(-1).returned, h.window);
    assert.equal(h.gate.begin('close', h.window), true); await drain();
    assert.equal(h.counts.prompts, 2); assert.equal(h.calls.some(call => call.approved), false);
  }
});

test('only literal true acknowledges a draft save', async () => {
  for (const value of [false, undefined, null, 0, 1, 'true', {}, []]) {
    const h = harness({ drafts: async () => value }); h.gate.begin('quit', h.window); await drain();
    assert.equal(h.counts.prompts, 1); assert.equal(h.gate.allowsUnload(h.window), false);
  }
});

test('draft timeout fails closed; a late success cannot dismiss the decision or approve a later edit', async () => {
  const drafts = deferred(), decision = deferred();
  const h = harness({ drafts: () => drafts.promise, confirm: () => decision.promise });
  h.gate.begin('quit', h.window); await drain(); h.fire(8000); await drain();
  assert.equal(h.counts.prompts, 1); assert.equal(h.gate.allowsUnload(h.window), false);
  drafts.resolve(true); await drain();
  assert.equal(h.calls.some(call => call.approved), false);
  decision.resolve(false); await drain();
  assert.equal(h.calls.at(-1).returned, h.window); assert.equal(h.gate.allowsUnload(h.window), false);
});

test('repeated close and Cmd-Q share one pending flush and one explicit-exit decision', async () => {
  const drafts = deferred(), decision = deferred();
  const h = harness({ drafts: () => drafts.promise, confirm: () => decision.promise });
  h.gate.begin('close', h.window); await drain();
  assert.equal(h.gate.begin('quit', h.window), false); assert.equal(h.gate.begin('close', h.window), false);
  drafts.resolve(false); await drain();
  assert.equal(h.gate.begin('quit', h.window), false);
  assert.equal(h.counts.workspace, 1); assert.equal(h.counts.drafts, 1); assert.equal(h.counts.prompts, 1);
  decision.resolve(true); await drain();
  assert.equal(h.calls.at(-1).approved, 'quit'); assert.equal(h.gate.allowsUnload(h.window), true);
});

test('explicit close permission is scoped to exactly that window', async () => {
  const h = harness({ drafts: async () => false, confirm: async () => true });
  h.gate.begin('close', h.window); await drain();
  assert.equal(h.calls.at(-1).approved, 'close'); assert.equal(h.gate.allowsUnload({}), false);
  h.gate.cancel(h.window); assert.equal(h.gate.allowsUnload(h.window), false);
});

test('cancelling an old attempt prevents its success from approving a new attempt', async () => {
  const old = deferred(), next = deferred(); let attempts = 0;
  const h = harness({ drafts: () => (++attempts === 1 ? old : next).promise });
  h.gate.begin('quit', h.window); await drain();
  h.gate.cancel(h.window); h.gate.begin('quit', h.window); await drain();
  old.resolve(true); await drain(); assert.equal(h.calls.some(call => call.approved), false);
  next.resolve(false); await drain();
  assert.equal(h.counts.prompts, 1); assert.equal(h.gate.allowsUnload(h.window), false);
});

test('late dialog results and callbacks for destroyed or replaced windows cannot close the successor', async () => {
  const decision = deferred();
  const h = harness({ drafts: async () => false, confirm: () => decision.promise });
  h.gate.begin('quit', h.window); await drain();
  h.gate.cancel(h.window); decision.resolve(true); await drain();
  assert.equal(h.calls.some(call => call.approved), false);
  for (const replace of [false, true]) {
    const pending = deferred(); const other = harness({ drafts: () => pending.promise });
    other.gate.begin('quit', other.window); await drain();
    if (replace) other.current = { isDestroyed: () => false }; else other.window.destroyed = true;
    pending.resolve(true); await drain();
    assert.equal(other.calls.some(call => call.approved), false);
  }
});

test('workspace timeout retains its bounded behavior but cannot bypass the required draft save', async () => {
  const workspace = deferred(), drafts = deferred();
  const h = harness({ workspace: () => workspace.promise, drafts: () => drafts.promise });
  h.gate.begin('quit', h.window); await drain(); h.fire(2800); await drain();
  assert.equal(h.counts.drafts, 1); assert.equal(h.gate.allowsUnload(h.window), false);
  workspace.resolve(); await drain(); assert.equal(h.gate.allowsUnload(h.window), false);
  drafts.resolve(false); await drain(); assert.equal(h.counts.prompts, 1);
});

test('a failed confirmation UI cannot authorize leaving', async () => {
  const h = harness({ drafts: async () => false, confirm: async () => { throw Error('dialog unavailable'); } });
  h.gate.begin('quit', h.window); await drain();
  assert.equal(h.gate.allowsUnload(h.window), false); assert.equal(h.calls.at(-1).returned, h.window);
});

test('production renderer bridge awaits the real hook, uses strict acknowledgement and supports older startup documents', async () => {
  const script = source.match(/flushDrafts: window => window\.webContents\.executeJavaScript\('([^']+)'\)/)[1];
  const run = window => vm.runInNewContext(script, { window });
  const pending = deferred(); let finished = false, calls = 0;
  const result = run({ flushLocalDrafts: () => { calls++; return pending.promise; } }).then(value => { finished = true; return value; });
  await drain(); assert.equal(calls, 1); assert.equal(finished, false);
  pending.resolve(true); assert.equal(await result, true);
  assert.equal(await run({}), true);
  for (const value of [false, undefined, null, 1, 'true']) assert.equal(await run({ flushLocalDrafts: async () => value }), false);
  await assert.rejects(run({ flushLocalDrafts: async () => { throw Error('synthetic failure'); } }), /synthetic failure/);
  assert.doesNotMatch(script, /saveDocument|beforeLeave|fetch|NoteEditor\.save/);
});

function lifecycleHarness({ result = true, confirm = 0 } = {}) {
  const appHandlers = {}, handlers = {}, webHandlers = {}, prompts = [], actions = [], timers = new Map(); let id = 0;
  const window = {
    isDestroyed: () => false, close: () => actions.push('close'), show: () => actions.push('show'), focus: () => actions.push('focus'),
    on: (name, callback) => { handlers[name] = callback; },
    webContents: { on: (name, callback) => { webHandlers[name] = callback; }, executeJavaScript: script => script.includes('flushLocalDrafts') ? Promise.resolve(result) : Promise.resolve() }
  };
  const context = vm.createContext({ mainWindow: window, window, quitting: false,
    setTimeout: (fn, ms) => { const token = ++id; timers.set(token, { fn, ms }); return token; }, clearTimeout: token => timers.delete(token),
    nativeUI: { text: zh => zh },
    dialog: { showMessageBox: async (_window, options) => { prompts.push(options); return { response: confirm }; }, showMessageBoxSync: (_window, options) => { prompts.push(options); return confirm; } },
    app: { on: (name, callback) => { appHandlers[name] = callback; }, quit: () => actions.push('quit') },
    localServer: { killed: false, kill() { this.killed = true; actions.push('kill'); } }
  });
  vm.runInContext(source.slice(source.indexOf('function createDraftExitGate('), source.indexOf('\nasync function createWindow()')), context);
  const closeStart = source.indexOf("  window.on('close'");
  vm.runInContext(source.slice(closeStart, source.indexOf('  // Preserve the existing desktop origin', closeStart)), context);
  vm.runInContext(source.slice(source.indexOf("app.on('before-quit'")), context);
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  return { context, window, handlers, webHandlers, appHandlers, prompts, actions, event };
}

test('actual before-quit keeps backend alive through draft failure and return; no automatic quit is scheduled', async () => {
  const h = lifecycleHarness({ result: false }); const event = h.event();
  h.appHandlers['before-quit'](event); await drain();
  assert.equal(event.prevented, true); assert.equal(h.context.localServer.killed, false); assert.equal(h.context.quitting, false);
  assert.deepEqual(h.actions, ['show', 'focus']); assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].defaultId, 0); assert.equal(h.prompts[0].cancelId, 0);
});

test('actual approved quit skips the obsolete unload prompt and stops backend only at will-quit', async () => {
  const h = lifecycleHarness(); h.appHandlers['before-quit'](h.event()); await drain();
  assert.deepEqual(h.actions, ['quit']); assert.equal(h.context.quitting, true); assert.equal(h.context.localServer.killed, false);
  const second = h.event(); h.appHandlers['before-quit'](second); assert.equal(second.prevented, false);
  const close = h.event(); h.handlers.close(close); assert.equal(close.prevented, false);
  const unload = h.event(); h.webHandlers['will-prevent-unload'](unload);
  assert.equal(unload.prevented, true); assert.equal(h.prompts.length, 0);
  h.appHandlers['will-quit'](); assert.equal(h.context.localServer.killed, true);
});

test('actual window-close gate permits explicit exit once without double confirmation', async () => {
  const h = lifecycleHarness({ result: false, confirm: 1 }); const first = h.event();
  h.handlers.close(first); await drain(); assert.equal(first.prevented, true); assert.deepEqual(h.actions, ['close']);
  const second = h.event(); h.handlers.close(second); assert.equal(second.prevented, false);
  const unload = h.event(); h.webHandlers['will-prevent-unload'](unload);
  assert.equal(unload.prevented, true); assert.equal(h.prompts.length, 1); assert.equal(h.context.localServer.killed, false);
});

test('refresh/navigation warning preserves saved-draft distinction and navigation invalidates previous approval', async () => {
  const h = lifecycleHarness(); h.handlers.close(h.event()); await drain();
  h.webHandlers['did-start-navigation']({}, 'http://127.0.0.1/new', false, true);
  const unload = h.event(); h.webHandlers['will-prevent-unload'](unload);
  assert.equal(unload.prevented, false); assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].message, /刷新或离开/);
  assert.match(h.prompts[0].detail, /已经保存的本机草稿/);
  assert.doesNotMatch(h.prompts[0].detail, /草稿将无法恢复/);
  assert.equal(h.context.localServer.killed, false);
});
