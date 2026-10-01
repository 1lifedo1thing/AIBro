'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const esbuild = require('esbuild');
const source = fs.readFileSync(require.resolve('../app/ui/cloud-surfaces.jsx'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const primitives = Object.fromEntries(['AlertBanner', 'Badge', 'Button', 'Caption', 'Card', 'StatusBadge', 'TextInput', 'KitCheckbox', 'KitSelect', 'KitSwitch'].map(name => [name, `Kit:${name}`]));
function fixture(language = 'zh', hooks = {}) {
  let ids = 0;
  const react = { ...React, useId: () => String(++ids), useLayoutEffect() {}, useRef: value => ({ current: value }), useState: value => [typeof value === 'function' ? value() : value, () => {}], ...hooks };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, document: { documentElement: { lang: language } }, require: id => id === 'react' ? react : primitives });
  return module.exports;
}
function nodes(node) { if (!React.isValidElement(node)) return []; if (typeof node.type === 'function') return [node, ...nodes(node.type(node.props))]; return [node, ...React.Children.toArray(node.props.children).flatMap(nodes)]; }
function words(node) { if (typeof node === 'string' || typeof node === 'number') return String(node); if (!React.isValidElement(node)) return ''; if (typeof node.type === 'function') return words(node.type(node.props)); return React.Children.toArray(node.props.children).map(words).join(' '); }
const find = (tree, kind, predicate = () => true) => nodes(tree).find(node => (node.type === `Kit:${kind}` || node.type?.name === kind) && predicate(node.props));
const button = (tree, id) => find(tree, 'Button', props => props.id === id);
const draft = patch => ({ config: { target: 'fixture-host', sshPort: 0, remotePort: 8787, localPort: 18787 }, deviceName: '我的 Mac', busy: '', confirmed: false, accountId: 'a', probe: { active: true, dataPath: '/home/me/cloud', accounts: [{ id: 'a', username: '研究' }, { id: 'b', username: '其他工作区' }] }, kind: 'success', message: '连接检查通过。', ...patch });
function render(patch = {}, extra = {}) { const calls = [], ui = fixture(); return { calls, tree: ui.CloudSSHConnection({ draft: draft(patch), onChange: (...args) => calls.push(args), onProbe() {}, onConnect() {}, ...extra }) }; }

test('SSH form uses actual Kit fields/select/checkbox and a single editable host entry', () => {
  const { tree } = render();
  for (const kind of ['TextInput', 'KitSelect', 'KitCheckbox', 'StatusBadge']) assert.ok(find(tree, kind), kind);
  assert.equal(nodes(tree).some(node => ['input', 'select', 'datalist'].includes(node.type)), false);
  assert.equal(nodes(tree).filter(node => node.type?.name === 'CloudSSHHostPicker').length, 1);
  assert.doesNotMatch(words(tree), /云账号密码/);
  assert.match(words(tree), /与 SSH 登录用户名不同/);
});

test('merge agreement remains explicit and cannot connect to unavailable or unselected workspaces', () => {
  assert.equal(button(render().tree, 'cloudSSHConnectNow').props.disabled, true);
  assert.equal(button(render({ confirmed: true }).tree, 'cloudSSHConnectNow').props.disabled, false);
  for (const patch of [{ confirmed: true, accountId: '' }, { confirmed: true, accountId: 'missing' }, { confirmed: true, deviceName: '  ' }, { confirmed: true, busy: 'probe' }, { confirmed: true, probe: { active: false, accounts: [{ id: 'a' }] } }]) assert.equal(button(render(patch).tree, 'cloudSSHConnectNow').props.disabled, true);
  assert.equal(find(render({ probe: null }).tree, 'KitCheckbox'), undefined);
});

test('existing binding exposes only the original workspace and locks its local port', () => {
  const { tree } = render({ confirmed: true }, { boundAccountId: 'a', boundServer: 'http://127.0.0.1:18787' });
  const select = find(tree, 'KitSelect'); assert.equal(select.props.disabled, true); assert.equal(select.props.options.length, 1); assert.equal(select.props.options[0].value, 'a');
  const port = find(tree, 'CloudConnectionField', props => props.id === 'cloudSSHConnect-localPort'); assert.equal(port.props.readOnly, true); assert.match(port.props.caption, /保持不变/);
  assert.equal(button(render({ confirmed: true }, { boundAccountId: 'not-on-this-host' }).tree, 'cloudSSHConnectNow').props.disabled, true);
  assert.equal(find(render({}, { boundAccountId: 'not-on-this-host' }).tree, 'KitSelect'), undefined);
});

test('paused recovery explicitly promises authorization only in both languages and uses Restore connection', () => {
  for (const language of ['zh','en']) {
    const ui=fixture(language),tree=ui.CloudSSHConnection({draft:draft({autoSync:false,confirmed:true}),boundAccountId:'a'});
    const consent=find(tree,'KitCheckbox'),submit=button(tree,'cloudSSHConnectNow');
    assert.equal(submit.props.disabled,false);
    assert.match(consent.props.label,language==='zh'?/保持自动同步暂停/:/keep automatic sync paused/);
    assert.match(consent.props.description,language==='zh'?/不自动上传或下载/:/No automatic uploads or downloads/);
    assert.equal(words(submit),language==='zh'?'恢复连接':'Restore connection');
    assert.doesNotMatch(consent.props.label,language==='zh'?/开启自动同步/:/enable automatic sync/);
  }
});

test('first connection and active automatic-sync recovery retain accurate distinct consent', () => {
  const first=render({autoSync:true,confirmed:true}).tree,recovery=render({autoSync:true,confirmed:true},{boundAccountId:'a'}).tree;
  assert.match(find(first,'KitCheckbox').props.label,/合并.*开启自动同步/);assert.equal(words(button(first,'cloudSSHConnectNow')),'连接并同步');
  assert.match(find(recovery,'KitCheckbox').props.label,/恢复原工作区.*继续自动同步/);assert.equal(words(button(recovery,'cloudSSHConnectNow')),'恢复连接并同步');
  assert.equal(button(render({autoSync:false,confirmed:false},{boundAccountId:'a'}).tree,'cloudSSHConnectNow').props.disabled,true);
});

test('new Kit controls preserve controller IDs and callback values', () => {
  const { tree, calls } = render();
  find(tree, 'CloudConnectionField', props => props.id === 'cloudSSHDeviceName').props.onChange('研究电脑');
  find(tree, 'CloudConnectionField', props => props.id === 'cloudSSHConnect-remotePort').props.onChange('9898');
  find(tree, 'KitSelect').props.onChange('b');
  find(tree, 'KitCheckbox').props.onChange(true);
  assert.deepEqual(calls.map(value => Array.from(value)), [['deviceName', '研究电脑'], ['remotePort', '9898'], ['accountId', 'b'], ['confirmed', true]]);
});

test('errors show real details and never show success; busy fields and empty host cannot probe', () => {
  const failed = render({ kind: 'error', message: '主机指纹未确认', probe: null }).tree;
  assert.equal(find(failed, 'AlertBanner').props.description, '主机指纹未确认'); assert.doesNotMatch(words(failed), /检查通过/);
  const pending = render({ busy: 'probe', kind: 'progress', message: '正在检查', probe: null }).tree;
  assert.equal(button(pending, 'cloudSSHProbe').props.loading, true);
  assert.ok(nodes(pending).filter(node => node.type?.name === 'CloudConnectionField').every(node => node.props.disabled));
  assert.equal(button(render({ config: { target: ' ', sshPort: 0, remotePort: 8787, localPort: 18787 } }).tree, 'cloudSSHProbe').props.disabled, true);
});

function statefulFixture() {
  let index = 0, effects = []; const cells = [];
  const ui = fixture('zh', {
    useId: () => 'test',
    useState: value => { const slot = index++; if (!cells[slot]) cells[slot] = { value }; return [cells[slot].value, next => { cells[slot].value = typeof next === 'function' ? next(cells[slot].value) : next; }]; },
    useRef: value => { const slot = index++; return cells[slot] ||= { current: value }; },
    useLayoutEffect: effect => effects.push(effect),
  });
  return { render: (name, props) => { index = 0; effects = []; return ui[name](props); }, effects: () => effects.forEach(effect => effect()) };
}

test('field adapter retains IME text, commits exactly once and forwards semantic constraints', () => {
  const h = statefulFixture(), calls = [], listeners = {}, attributes = {}, input = { id: '', setAttribute: (key, value) => { attributes[key] = value; }, removeAttribute: key => { delete attributes[key]; }, addEventListener: (name, callback) => { listeners[name] = callback; }, removeEventListener() {} }, label = {};
  const props = { id: 'device', label: '本机设备名称', caption: '用于识别', value: '', maxLength: 100, onChange: value => calls.push(value) };
  let tree = h.render('CloudConnectionField', props); tree.props.ref.current = { querySelector: selector => selector === 'input' ? input : label }; h.effects();
  assert.equal(input.id, 'device'); assert.equal(label.htmlFor, 'device'); assert.equal(attributes.maxlength, '100'); assert.equal(attributes['aria-describedby'], 'device-caption');
  listeners.compositionstart(); find(tree, 'TextInput').props.onChange('yan');
  assert.equal(calls.length, 0);
  tree = h.render('CloudConnectionField', { ...props, value: 'old controller projection' }); h.effects();
  assert.equal(find(tree, 'TextInput').props.value, 'yan');
  listeners.compositionend({ target: { value: '研究' } }); find(tree, 'TextInput').props.onChange('研究'); assert.deepEqual(calls, ['研究']);
  tree = h.render('CloudConnectionField', { ...props, value: '18787', type: 'number', readOnly: true, min: 1, max: 65535 }); h.effects(); find(tree, 'TextInput').props.onChange('123');
  assert.deepEqual(calls, ['研究']); assert.equal(input.readOnly, true); assert.equal(attributes.min, '1'); assert.equal(attributes.max, '65535');
});

test('host suggestions search label and target, accept freeform text, and require explicit selection', () => {
  const h = statefulFixture(), calls = [], hosts = [{ target: 'lab', label: '研究服务器' }, { target: 'gpu.example', label: 'GPU' }, { target: 'lab', label: '重复' }];
  const props = { value: '', hosts, onChange: value => calls.push(value) };
  let tree = h.render('CloudSSHHostPicker', props); find(tree, 'CloudConnectionField').props.onFocus();
  tree = h.render('CloudSSHHostPicker', props); assert.equal(nodes(tree).filter(node => node.props.role === 'option').length, 2);
  let field = find(tree, 'CloudConnectionField'); field.props.onChange('me@new-host'); assert.deepEqual(calls, ['me@new-host']);
  tree = h.render('CloudSSHHostPicker', { ...props, value: '研究' }); assert.equal(nodes(tree).filter(node => node.props.role === 'option').length, 1);
  field = find(tree, 'CloudConnectionField'); let prevented = 0; field.props.onKeyDown({ key: 'ArrowDown', preventDefault() { prevented++; } });
  tree = h.render('CloudSSHHostPicker', { ...props, value: '研究' }); field = find(tree, 'CloudConnectionField'); assert.equal(field.props.attributes['aria-activedescendant'], 'cloudSSHHostOption-0');
  field.props.onKeyDown({ key: 'Enter', preventDefault() { prevented++; }, stopPropagation() {} }); assert.deepEqual(calls, ['me@new-host', 'lab']); assert.equal(prevented, 2);
});

test('Escape closes suggestions before the containing dialog and composing keys never select', () => {
  const h = statefulFixture(); let stopped = 0;
  const props = { value: '', hosts: [{ target: 'lab' }] };
  let tree = h.render('CloudSSHHostPicker', props); find(tree, 'CloudConnectionField').props.onFocus();
  tree = h.render('CloudSSHHostPicker', props); find(tree, 'CloudConnectionField').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped++; } });
  tree = h.render('CloudSSHHostPicker', props); assert.equal(find(tree, 'CloudConnectionField').props.attributes['aria-expanded'], false); assert.equal(stopped, 1);
  let keys = 0; const field = statefulFixture().render('CloudConnectionField', { onKeyDown() { keys++; } });
  field.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true } }); field.props.onKeyDown({ key: 'Enter', keyCode: 229 }); assert.equal(keys, 0);
});
