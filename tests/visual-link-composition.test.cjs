'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const vue = require('vue');

// Execute the exported production DOM guard without loading a browser/editor.
// The second half runs the installed Crepe control's real event callback, so
// this exercises capture-versus-target ordering rather than a duplicate handler.
const source = fs.readFileSync(require.resolve('../app/editor/visual-editor.js'), 'utf8');
const guardSource = source.slice(source.indexOf('export function installLinkCompositionGuard('), source.indexOf('/** An owned, offline Crepe surface.'));
const scope = {};
vm.runInNewContext(guardSource.replace('export function', 'function') + '\nthis.install = installLinkCompositionGuard;', scope);
const upstreamFile = require('node:path').resolve(__dirname, '../node_modules/@milkdown/components/src/link-tooltip/edit/component.tsx');
const compiled = transformSync(fs.readFileSync(upstreamFile, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'h', jsxFragment: 'Fragment' }).code;
const upstream = { exports: {} };
vm.runInNewContext(compiled, { module: upstream, exports: upstream.exports, require(id) {
  if (id === 'vue') return { ...vue, watch() {} };
  if (id.includes('keep-alive')) return { keepAlive() {} };
  if (id.includes('unique-id')) return { inputId: () => 'link-ime-test' };
  return { Icon: () => null };
} });

function fixture() {
  const listeners = new Map(), timers = new Map(); let timerID = 0;
  const outer = {
    contains: target => target.owner === outer,
    addEventListener(type, listener, capture) { assert.equal(capture, true); listeners.set(type, listener); },
    removeEventListener(type, listener, capture) { assert.equal(capture, true); if (listeners.get(type) === listener) listeners.delete(type); }
  };
  const clock = { setTimeout(fn) { timers.set(++timerID, fn); return timerID; }, clearTimeout(id) { timers.delete(id); } };
  const input = { owner: outer, closest: () => input };
  const confirms = []; let canceled = 0;
  const render = upstream.exports.EditLink.setup({ config: vue.ref({}), src: vue.ref('https://example.com/zhong'), onConfirm: value => confirms.push(value), onCancel: () => canceled++ });
  const targetHandler = render().children[0].props.onKeydown;
  const cleanup = scope.install(outer, clock);
  function fire(type, fields = {}) {
    const event = { target: input, key: '', isComposing: false, keyCode: 0, defaultPrevented: false, immediate: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.immediate = true; }, stopPropagation() {}, ...fields };
    listeners.get(type)?.(event);
    if (type === 'keydown' && !event.immediate) targetHandler(event);
    return event;
  }
  return { fire, input, outer, confirms, canceled: () => canceled, cleanup, listeners, timers,
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}

test('candidate Enter and Escape never reach Crepe confirm/cancel and keep native IME defaults', () => {
  const f = fixture(); f.fire('compositionstart');
  for (const key of ['Enter', 'Escape']) {
    const event = f.fire('keydown', { key, isComposing: true, keyCode: 229 });
    assert.equal(event.immediate, true); assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(f.confirms, []); assert.equal(f.canceled(), 0); f.cleanup();
});

test('end-before-keydown stays guarded for one task, then normal link confirmation resumes', () => {
  const f = fixture(); f.fire('compositionstart'); f.fire('compositionend');
  const tail = f.fire('keydown', { key: 'Enter' });
  assert.equal(tail.immediate, true); assert.equal(tail.defaultPrevented, false); assert.deepEqual(f.confirms, []);
  f.tick(); const confirmed = f.fire('keydown', { key: 'Enter' });
  assert.equal(confirmed.defaultPrevented, true); assert.deepEqual(f.confirms, ['https://example.com/zhong']);
  f.fire('keydown', { key: 'Escape' }); assert.equal(f.canceled(), 1); f.cleanup();
});

test('key event fallback guards missed starts without swallowing arrows, unrelated inputs or other roots', () => {
  const f = fixture();
  assert.equal(f.fire('keydown', { key: 'Enter', isComposing: true }).immediate, true);
  assert.equal(f.fire('keydown', { key: 'Escape', keyCode: 229 }).immediate, true);
  assert.equal(f.fire('keydown', { key: 'ArrowDown', isComposing: true }).immediate, false);
  const unrelated = { owner: f.outer, closest: () => null };
  assert.equal(f.fire('keydown', { target: unrelated, key: 'Enter', isComposing: true }).immediate, false);
  const foreign = { closest() { return this; }, owner: {} };
  assert.equal(f.fire('keydown', { target: foreign, key: 'Enter', isComposing: true }).immediate, false);
  f.cleanup();
});

test('new candidate session cancels the prior settle; teardown removes listeners and late timers', () => {
  const f = fixture(); f.fire('compositionstart'); f.fire('compositionend');
  f.fire('compositionstart'); f.tick();
  assert.equal(f.fire('keydown', { key: 'Enter' }).immediate, true);
  f.fire('compositionend'); assert.equal(f.timers.size, 1);
  f.cleanup(); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
  f.tick(); assert.deepEqual(f.confirms, []);
});
