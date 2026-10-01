const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('esbuild');

// Transform only the real component for Node tests. The established Kit
// primitives are semantic stand-ins; no bundle, app or renderer is started.
const source = fs.readFileSync(require.resolve('../app/ui/project-overview.jsx'), 'utf8');
const compiled = transformSync(source + '\nexport {OutputRow, TaskRow};', { loader: 'jsx', format: 'cjs' }).code;
const primitives = {
  Button: ({ children, disabled, onClick, title, variant, ...props }) => React.createElement('button', {
    type: 'button', disabled, onClick, title, 'data-kit-button': variant, 'aria-label': props['aria-label'],
  }, children),
  Heading: ({ level, children }) => React.createElement('h' + level, null, children),
  EmptyState: ({ title, description, action }) => React.createElement('div', { 'data-kit-empty': '' },
    React.createElement('div', null, title), description && React.createElement('div', null, description), action && React.createElement('div', null, action)),
};
function load(language = 'zh-CN') {
  const module = { exports: {} }, document = { documentElement: { lang: language }, getElementById: () => null, createElement: () => ({}), head: { append() {} } };
  vm.runInNewContext(compiled, { module, exports: module.exports, document, require: id => id === 'react' ? React : id.endsWith('.css') ? '' : primitives });
  return module.exports;
}
function render(props, language) { return renderToStaticMarkup(React.createElement(load(language).ProjectOverview, props)); }
function nodes(element, predicate) {
  if (Array.isArray(element)) return element.flatMap(value => nodes(value, predicate));
  if (!element || typeof element !== 'object') return [];
  return [...(predicate(element) ? [element] : []), ...nodes(element.props?.children, predicate)];
}
const buttons = node => nodes(node, value => value.type === primitives.Button);
const task = (id, extra = {}) => ({ id, title: 'Task ' + id, dueLabel: 'Tomorrow', statusLabel: 'In progress', ...extra });
const output = (key, extra = {}) => ({ key, title: 'Output ' + key, typeLabel: '笔记', statusLabel: '已保存', updatedLabel: '10月1日', ...extra });

test('an unavailable project hides all stale titles, descriptions, counts and actionable entries', () => {
  const html = render({ available: false, description: 'SECRET_DESCRIPTION', taskCount: 9876, sourceCount: 9876, outputCount: 9876,
    tasks: [task('SECRET_TASK')], outputs: [output('SECRET_OUTPUT')], onStart() {}, onTask() {}, onOutput() {} });
  assert.match(html, /项目当前不可用/); assert.doesNotMatch(html, /SECRET_|9876|<button|data-overview-nav/);
});

test('a truly empty project has one compact start area with add sources primary and conversation secondary', () => {
  const html = render({ available: true, onAddSources() {}, onStart() {} });
  assert.match(html, /从第一份资料开始/); assert.match(html, /data-kit-button="primary"[^>]*>添加资料/);
  assert.match(html, /data-kit-button="ghost"[^>]*>新建对话/); assert.equal((html.match(/data-kit-empty=/g) || []).length, 1);
  assert.doesNotMatch(html, /data-overview-nav|最近成果|下一步任务|progressbar|%/);
});

test('source-only or record-only projects keep both sections and offer a small add-task empty state', () => {
  for (const counts of [{ sourceCount: 8 }, { recordCount: 3 }]) {
    const html = render({ available: true, ...counts, onAddTask() {}, onStart() {}, onNavigate() {} });
    assert.match(html, /最近成果/); assert.match(html, /下一步任务/); assert.match(html, /暂无待办/); assert.match(html, /添加任务/);
    assert.doesNotMatch(html, /从第一份资料开始|项目完成度|progressbar|%/);
    assert.equal((html.match(/data-overview-nav=/g) || []).length, 3);
  }
});

test('overview samples four outputs and three tasks without changing the actual totals or source order', () => {
  const outputs = Array.from({ length: 9 }, (_, index) => output('o-' + index));
  const tasks = Array.from({ length: 7 }, (_, index) => task('t-' + index));
  const html = render({ available: true, taskCount: 12, doneCount: 5, sourceCount: 23, recordCount: 2, outputCount: 9, tasks, outputs, onNavigate() {}, onTask() {}, onOutput() {} });
  assert.equal((html.match(/data-overview-output=/g) || []).length, 4); assert.equal((html.match(/data-overview-task=/g) || []).length, 3);
  assert.match(html, /<span>资料<\/span><strong>23<\/strong>/); assert.match(html, /项目记录 2/);
  assert.match(html, /<span>成果<\/span><strong>9<\/strong>/); assert.match(html, /<span>待办<\/span><strong>7<\/strong>/);
  assert.ok(html.indexOf('Output o-0') < html.indexOf('Output o-3')); assert.doesNotMatch(html, /Output o-4|Task t-3|%/);
  assert.match(html, /aria-label="查看全部成果"/); assert.match(html, /aria-label="查看全部任务"/);
});

test('pending review stays explicit even when a caller supplies an old saved label', () => {
  const props = { available: true, outputCount: 2, reviewCount: 1, outputs: [output('draft', { review: true, statusLabel: '已保存' }), output('saved', { title: 'A saved output' })] };
  const html = render(props); assert.match(html, /1 待审阅/); assert.match(html, /class="project-overview-review">待审阅/);
  const row = html.slice(html.indexOf('data-overview-output="draft"'), html.indexOf('data-overview-output="saved"'));
  assert.doesNotMatch(row, /已保存|已采纳/); assert.match(html, /A saved output/);
  assert.match(render({ available: true, reviewCount: 1 }), /最近成果/, 'Review-only state is not a new empty project');
});

test('descriptions and long/custom titles remain literal user text, with no generated status claims', () => {
  const title = '<script>unsafe</script>' + '长标题'.repeat(90);
  const html = render({ available: true, description: '<b>**Keep this literal**</b>\nSecond line', outputs: [output('long', { title, typeLabel: '', statusLabel: '', updatedLabel: '' })] });
  assert.match(html, /&lt;b&gt;\*\*Keep this literal\*\*&lt;\/b&gt;/); assert.match(html, /Second line/); assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|<b>\*\*|已保存|已采纳/); assert.ok(html.includes('长标题'.repeat(90)));
});

test('output/task callbacks receive the exact Kit button anchor, not an icon or deferred event', () => {
  const { OutputRow, TaskRow } = load(), calls = [], button = {}, icon = {};
  const a = OutputRow({ item: output('note:x'), onOutput: (...args) => calls.push(['output', ...args]) });
  const b = TaskRow({ item: task('task-x'), onTask: (...args) => calls.push(['task', ...args]) });
  buttons(a)[0].props.onClick({ currentTarget: button, target: icon }); buttons(b)[0].props.onClick({ currentTarget: button, target: icon });
  assert.deepEqual(calls, [['output', 'note:x', button], ['task', 'task-x', button]]);
  assert.equal(buttons(OutputRow({ item: output('missing-handler') }))[0].props.disabled, true);
  assert.equal(buttons(TaskRow({ item: task('missing-handler') }))[0].props.onClick, undefined);
});

test('count links and view-all actions use existing project tab routes', () => {
  const { ProjectOverview } = load(), calls = [];
  const tree = ProjectOverview({ available: true, sourceCount: 1, recordCount: 2, taskCount: 1, outputCount: 1, onNavigate: section => calls.push(section) });
  const nav = nodes(tree, node => node.type === 'nav')[0]; buttons(nav).forEach(button => button.props.onClick());
  const viewAll = buttons(tree).filter(button => button.props['aria-label']); viewAll.forEach(button => button.props.onClick());
  assert.deepEqual(calls, ['knowledge', 'outputs', 'tasks', 'outputs', 'tasks']);
});

test('empty-area actions call only the requested host callback and never invent a task or conversation', () => {
  const { ProjectOverview } = load(), calls = [];
  let tree = ProjectOverview({ available: true, onAddSources: () => calls.push('sources'), onStart: () => calls.push('conversation') });
  const start = nodes(tree, node => node.type === primitives.EmptyState)[0]; buttons(start.props.action).forEach(button => button.props.onClick());
  tree = ProjectOverview({ available: true, sourceCount: 1, onAddTask: () => calls.push('task'), onStart: () => calls.push('conversation') });
  for (const empty of nodes(tree, node => node.type === primitives.EmptyState)) buttons(empty.props.action).forEach(button => button.props.onClick());
  assert.deepEqual(calls, ['sources', 'conversation', 'conversation', 'task']);
});

test('English chrome and review labels switch language while supplied titles and metadata are preserved', () => {
  const html = render({ available: true, sourceCount: 3, taskCount: 1, outputs: [output('one', { title: '用户标题', typeLabel: 'Custom kind', review: true })], tasks: [task('x', { title: 'Original task', dueLabel: 'Custom due label' })] }, 'en-US');
  for (const value of ['Recent outputs', 'Next tasks', 'View all outputs', 'Sources', 'To do', 'Needs review', '用户标题', 'Custom kind', 'Custom due label']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /最近成果|下一步任务|待审阅/);
  assert.match(render({ available: true }, 'en'), /Start with your first source/);
});

test('invalid numeric counts do not generate NaN, negative counts or fake completion progress', () => {
  const html = render({ available: true, sourceCount: 1, taskCount: -5, doneCount: Infinity, outputCount: NaN, recordCount: '7', reviewCount: -1 });
  assert.doesNotMatch(html, /NaN|Infinity|<strong>-|progressbar|%|项目记录 7/); assert.match(html, /<span>待办<\/span><strong>0<\/strong>/);
});
