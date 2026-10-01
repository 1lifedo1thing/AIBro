'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const esbuild = require('esbuild');

const source = fs.readFileSync(require.resolve('../app/ui/project-outputs.jsx'), 'utf8');
const code = esbuild.transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const origin = { conversationId: 'chat', conversationTitle: 'Literal <b>conversation</b>', runId: 'run', at: 100 };
const item = (patch = {}) => ({ key: 'saved-note', type: 'note', group: 'saved', title: 'Literal <script>title</script>.md', at: 100, open: { kind: 'note', id: 'note' }, source: origin, origins: [origin], ...patch });
function fixture({ lang = 'zh', expanded = false } = {}) {
  let id = 0;
  const toggles = [], module = { exports: {} };
  const react = { ...React, useId: () => `output-${++id}`, useState: () => [expanded, value => toggles.push(value)] };
  vm.runInNewContext(code, { module, exports: module.exports, document: { documentElement: { lang } }, require(name) {
    if (name === 'react') return react;
    if (name.endsWith('.css')) return '';
    if (name.includes('halaska-kit')) return { Button: 'Kit:Button', Badge: 'Kit:Badge', EmptyState: 'Kit:EmptyState' };
    if (name.includes('kit-controls')) return { KitSearchInput: 'Kit:SearchInput', KitSegmentedControl: 'Kit:SegmentedControl' };
    return new Proxy({}, { get: (_, key) => `Icon:${String(key)}` });
  } });
  function render(props = {}) {
    const all = [];
    function visit(value) {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!React.isValidElement(value)) return;
      if (typeof value.type === 'function') { visit(value.type(value.props)); return; }
      all.push(value); visit(value.props.children);
      if (value.props.action) visit(value.props.action);
    }
    visit(module.exports.ProjectOutputsPanel({ available: true, projectName: 'Project', items: [item()], counts: { all: 1, saved: 1, review: 0 }, total: 1, ...props }));
    return all;
  }
  return { render, toggles };
}
const byClass = (nodes, name) => nodes.filter(node => String(node.props.className || '').split(' ').includes(name));
const text = node => React.Children.toArray(node?.props?.children).map(value => typeof value === 'string' || typeof value === 'number' ? String(value) : React.isValidElement(value) ? text(value) : '').join('');

test('output list uses imported Kit primary actions without repeated card introductions or saved badges', () => {
  const calls = [], nodes = fixture().render({ onOpen: (...args) => calls.push(args) });
  const actions = byClass(nodes, 'project-output-actions'); assert.equal(actions.length, 1);
  const button = actions[0].props.children;
  assert.equal(button.type, 'Kit:Button'); assert.equal(text(button), '打开');
  const anchor = {}; button.props.onClick({ currentTarget: anchor }); assert.deepEqual(calls, [['saved-note', anchor]]);
  assert.equal(byClass(nodes, 'project-outputs-intro').length, 0);
  assert.equal(byClass(nodes, 'project-outputs-total').length, 0);
  assert.equal(byClass(nodes, 'project-outputs-footnote').length, 0);
  assert.equal(byClass(nodes, 'project-output-saved').length, 0);
  assert.match(byClass(nodes, 'project-outputs-result-count')[0].props.className, /is-visually-hidden/);
  const segments = nodes.find(node => node.type === 'Kit:SegmentedControl');
  assert.deepEqual(Array.from(segments.props.options, option => option.label), ['全部 1', '已保存 1', '待审阅 0']);
  assert.equal(text(byClass(nodes, 'project-output-title')[0]), 'Literal <script>title</script>.md');
  assert.ok(nodes.every(node => node.props.dangerouslySetInnerHTML === undefined));
});

test('pending review and saved directory actions retain honest labels and exact anchors', () => {
  const calls = [], nodes = fixture().render({ items: [item({ group: 'review', open: null })], onReview: (...args) => calls.push(args) });
  const review = byClass(nodes, 'project-output-actions')[0].props.children;
  assert.equal(review.type, 'Kit:Button'); assert.equal(review.props.variant, 'secondary'); assert.equal(text(review), '审阅');
  assert.equal(nodes.find(node => node.type === 'Kit:Badge').props.children, '待审阅');
  const anchor = {}; review.props.onClick({ currentTarget: anchor }); assert.deepEqual(calls, [['saved-note', anchor]]);
  const directory = byClass(fixture().render({ items: [item({ type: 'local', directory: true, open: null })] }), 'project-output-actions')[0].props.children;
  assert.equal(text(directory), '查看记录'); assert.match(directory.props['aria-label'], /^查看记录 /);
});

test('source history is a Kit disclosure with a connected hidden region and source identity callbacks', () => {
  const origins = [origin, { ...origin, conversationId: 'other', conversationTitle: 'Other conversation', runId: 'other-run' }];
  const render = fixture(), nodes = render.render({ items: [item({ origins })] });
  const disclosure = byClass(nodes, 'project-output-more-sources')[0].props.children;
  assert.equal(disclosure.type, 'Kit:Button'); assert.equal(disclosure.props['aria-expanded'], false);
  const region = byClass(nodes, 'project-output-sources')[0];
  assert.equal(region.props.id, disclosure.props['aria-controls']); assert.equal(region.props.hidden, true);
  assert.equal(React.Children.count(region.props.children), 1); assert.equal(region.props.children, false);
  disclosure.props.onClick(); assert.deepEqual(render.toggles, [true]);
  const calls = [], expanded = fixture({ expanded: true }).render({ items: [item({ origins })], onRun: (...args) => calls.push(args) });
  const runButtons = expanded.filter(node => node.type === 'Kit:Button' && text(node) === '执行记录');
  assert.equal(runButtons.length, 2); runButtons[1].props.onClick(); assert.deepEqual(calls, [['saved-note', 1]]);
  assert.equal(byClass(expanded, 'project-output-sources')[0].props.hidden, false);
});

test('empty results offer only the real supplied start action or a filter reset', () => {
  const calls = [], props = { items: [], counts: { all: 0, saved: 0, review: 0 }, total: 0, onStartConversation: () => calls.push('start') };
  const empty = fixture().render(props), card = empty.find(node => node.type === 'Kit:EmptyState');
  assert.equal(card.props.action.type, 'Kit:Button'); assert.equal(text(card.props.action), '开始项目对话');
  card.props.action.props.onClick(); assert.deepEqual(calls, ['start']);
  assert.equal(byClass(empty, 'project-outputs-toolbar').length, 0);
  assert.equal(fixture().render({ ...props, onStartConversation: undefined }).find(node => node.type === 'Kit:EmptyState').props.action, undefined);
  const filtered = fixture().render({ ...props, query: 'unmatched', onReset: () => calls.push('reset'), completedWithoutOutput: 3 });
  const reset = filtered.find(node => node.type === 'Kit:EmptyState').props.action;
  assert.equal(text(reset), '清除筛选'); reset.props.onClick(); assert.deepEqual(calls, ['start', 'reset']);
  assert.equal(byClass(filtered, 'project-outputs-no-result').length, 0);
  assert.doesNotMatch(byClass(filtered, 'project-outputs-result-count')[0].props.className, /is-visually-hidden/);
});

test('no-output history has one optional Kit disclosure and no hidden navigable run content', () => {
  const props = { completedWithoutOutput: 1, noOutputRuns: [{ runId: 'none', conversationTitle: 'History title', at: 100 }] };
  const closed = fixture().render(props), aside = byClass(closed, 'project-outputs-no-result')[0];
  const children = React.Children.toArray(aside.props.children), toggle = children[0], region = children[1];
  assert.equal(toggle.type, 'Kit:Button'); assert.equal(toggle.props['aria-expanded'], false); assert.equal(region.props.id, toggle.props['aria-controls']);
  assert.equal(region.props.hidden, true); assert.equal(closed.some(node => text(node) === 'History title'), false);
  const calls = [], opened = fixture({ lang: 'en' }).render({ ...props, showEmptyRuns: true, onEmptyRun: runId => calls.push(runId) });
  const action = opened.find(node => node.type === 'Kit:Button' && text(node) === 'View run');
  action.props.onClick(); assert.deepEqual(calls, ['none']);
  assert.ok(opened.some(node => node.type === 'Kit:Button' && text(node) === 'Runs without outputs · 1'));
});

test('pagination uses semantic Kit buttons with disabled edges and exact page callbacks', () => {
  const calls = [], nodes = fixture().render({ page: 0, pages: 3, onPage: page => calls.push(page) });
  const buttons = React.Children.toArray(byClass(nodes, 'project-outputs-pagination')[0].props.children).filter(node => node.type === 'Kit:Button');
  assert.equal(buttons[0].props.disabled, true); assert.equal(buttons[1].props.disabled, false);
  buttons[1].props.onClick(); assert.deepEqual(calls, [1]);
  const local = byClass(fixture({ lang: 'en' }).render({ items: [item({ type: 'local', path: 'docs/output.md' })] }), 'project-output-actions')[0].props.children;
  assert.equal(local.props.title, 'Open the current disk version');
});
