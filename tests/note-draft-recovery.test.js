'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const esbuild = require('esbuild');
const source = fs.readFileSync(require.resolve('../app/ui/note-draft-recovery.jsx'), 'utf8');
const css = fs.readFileSync(require.resolve('../app/ui/note-draft-recovery.css'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const primitives = Object.fromEntries(['AlertBanner', 'Button', 'Card', 'StatusBadge'].map(name => [name, `Kit:${name}`]));
function fixture(language = 'zh') {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, document: { documentElement: { lang: language }, getElementById: () => true }, require: id => id === 'react' ? React : id.endsWith('.css') ? css : primitives });
  const calls = [], callbacks = Object.fromEntries(['onRetry', 'onReload', 'onConfirmReload', 'onCancelReload', 'onCopy'].map(name => [name, () => calls.push(name)]));
  return { calls, render: props => module.exports.NoteDraftRecovery({ ...callbacks, ...props }) };
}
function nodes(node) { if (!React.isValidElement(node)) return []; if (typeof node.type === 'function') return nodes(node.type(node.props)); return [node, ...React.Children.toArray(node.props.children).flatMap(nodes)]; }
function text(node) { if (typeof node === 'string' || typeof node === 'number') return String(node); if (!React.isValidElement(node)) return ''; if (typeof node.type === 'function') return text(node.type(node.props)); return [node.type === 'Kit:AlertBanner' ? `${node.props.title} ${node.props.description}` : '', ...React.Children.toArray(node.props.children).map(text)].join(' '); }
const button = (tree, id) => nodes(tree).find(node => node.type === 'Kit:Button' && node.props.id === id);

test('ordinary idle renders nothing; saved state describes the local draft, not a committed note', () => {
  const h = fixture(); assert.equal(h.render({ state: 'idle' }), null);
  const saved = h.render({ state: 'saved', updatedAt: '2026-09-30T09:00:00Z' });
  assert.match(text(saved), /草稿已保存在本机/); assert.doesNotMatch(text(saved), /笔记已保存/);
  assert.equal(nodes(saved).some(n => n.type === 'Kit:Card'), false);
  assert.equal(nodes(saved).find(n => n.type === 'time').props.dateTime, '2026-09-30T09:00:00.000Z');
  assert.equal(nodes(saved).find(n => n.type === 'time').props['aria-live'], 'off');
  assert.equal(nodes(h.render({ state: 'saved', updatedAt: 'not-a-date' })).some(n => n.type === 'time'), false);
});
test('restored content explicitly remains a draft until the note is saved', () => {
  for (const state of ['idle', 'saving', 'saved', 'error']) {
    const tree = fixture().render({ state, restored: true });
    assert.match(text(tree), /已恢复本机草稿，保存后才写入笔记/);
    assert.ok(nodes(tree).some(n => n.type === 'Kit:Card'));
  }
});
test('loading and saving are controlled statuses with no fake completion or motion', () => {
  for (const state of ['loading', 'saving']) {
    const tree = fixture().render({ state });
    const status = nodes(tree).find(n => n.type === 'Kit:StatusBadge');
    assert.equal(status.props.pulse, false);
    assert.equal(nodes(tree).some(n => n.props.role === 'progressbar'), false);
    assert.equal(nodes(tree).filter(n => n.type === 'Kit:Button').length, 0);
    assert.doesNotMatch(text(tree), /草稿已保存|笔记已保存/);
  }
  assert.doesNotMatch(source, /setTimeout|setInterval|localStorage|fetch\(/);
});
test('conflict actions use exact controller callbacks and preserve a distinct two-step replacement', () => {
  const h = fixture(), tree = h.render({ state: 'conflict', message: '另一个窗口的版本较新。' });
  assert.match(text(tree), /自动保存已暂停/);
  button(tree, 'noteDraftCopy').props.onClick(); button(tree, 'noteDraftReload').props.onClick();
  assert.deepEqual(h.calls, ['onCopy', 'onReload']);
  assert.equal(button(tree, 'noteDraftConfirmReload'), undefined);
  const confirmation = h.render({ state: 'conflict', confirmReplace: true });
  assert.equal(button(confirmation, 'noteDraftReload'), undefined);
  assert.equal(button(confirmation, 'noteDraftRetry'), undefined);
  assert.match(text(confirmation), /载入会替换当前编辑区的内容/);
  button(confirmation, 'noteDraftCancelReload').props.onClick(); button(confirmation, 'noteDraftConfirmReload').props.onClick();
  assert.deepEqual(h.calls, ['onCopy', 'onReload', 'onCancelReload', 'onConfirmReload']);
});
test('busy guards mutations even on direct callback invocation while preserving copy access', () => {
  const h = fixture();
  for (const confirmReplace of [false, true]) {
    const tree = h.render({ state: 'conflict', busy: true, confirmReplace });
    for (const action of nodes(tree).filter(n => n.type === 'Kit:Button' && n.props.id !== 'noteDraftCopy')) {
      assert.equal(action.props.disabled, true); action.props.onClick();
    }
    button(tree, 'noteDraftCopy').props.onClick();
  }
  assert.deepEqual(h.calls, ['onCopy', 'onCopy']);
});
test('privacy and unavailable states do not suggest overwriting or persisting private contents', () => {
  for (const props of [{ state: 'unavailable', blocked: 'private' }, { state: 'conflict', blocked: true, confirmReplace: true }, { state: 'saved', blocked: 'unavailable' }]) {
    const tree = fixture().render(props);
    assert.match(text(tree), /当前草稿不会写入本机恢复存储/);
    assert.match(text(tree), /关闭窗口后无法从这里恢复/);
    assert.equal(button(tree, 'noteDraftRetry'), undefined); assert.equal(button(tree, 'noteDraftReload'), undefined);
    assert.equal(button(tree, 'noteDraftConfirmReload'), undefined); assert.ok(button(tree, 'noteDraftCopy'));
    assert.doesNotMatch(text(tree), /草稿已保存在本机/);
  }
});
test('cleanup retry says the note is saved and never offers to replace or save its body again', () => {
  const h = fixture(), tree = h.render({ state: 'error', cleanupPending: true, restored: true, confirmReplace: true });
  assert.match(text(tree), /笔记已保存，恢复草稿尚未清理/);
  assert.match(text(tree), /不会再次保存或替换正文/);
  assert.match(text(button(tree, 'noteDraftRetry')), /重试清理恢复草稿/);
  assert.doesNotMatch(text(tree), /保存后才写入笔记/);
  assert.equal(button(tree, 'noteDraftReload'), undefined); assert.equal(button(tree, 'noteDraftConfirmReload'), undefined);
  button(tree, 'noteDraftRetry').props.onClick(); assert.deepEqual(h.calls, ['onRetry']);
});
test('missing callbacks produce no inert affordances and error details remain unmodified text', () => {
  const h = fixture(), message = '<script>not markup</script>\n' + '完整错误/路径'.repeat(300);
  const tree = h.render({ state: 'error', message, onRetry: null, onCopy: null, onReload: null });
  assert.equal(nodes(tree).filter(n => n.type === 'Kit:Button').length, 0);
  assert.equal(nodes(tree).find(n => n.props['data-user-content']).props.children, message);
  assert.equal(nodes(tree).some(n => n.props.dangerouslySetInnerHTML), false);
  assert.equal(nodes(tree).filter(n => n.props.role === 'status').length, 1);
  assert.equal(nodes(tree).some(n => n.props.role === 'alert'), false);
});
test('English copy keeps draft persistence and note saving distinct', () => {
  const h = fixture('en-US');
  assert.match(text(h.render({ state: 'saved', restored: true })), /Draft saved locally/);
  assert.match(text(h.render({ state: 'saved', restored: true })), /Save it to write these changes to the note/);
  assert.match(text(h.render({ state: 'error', cleanupPending: true })), /Note saved; recovery draft still needs cleanup/);
  assert.match(text(h.render({ state: 'conflict', confirmReplace: true })), /Loading replaces the contents of this editor/);
});
test('stylesheet retains host theme and readable narrow-window, keyboard and reduced-motion behavior', () => {
  assert.doesNotThrow(() => esbuild.transformSync(css, { loader: 'css' }));
  assert.match(css, /var\(--text\)/); assert.match(css, /var\(--muted\)/);
  assert.match(css, /max-width:340px/); assert.match(css, /overflow-wrap:anywhere/); assert.match(css, /flex-wrap:wrap/);
  assert.match(css, /focus-visible/); assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /body\.reduce-motion/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});
