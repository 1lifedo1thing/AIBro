'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const esbuild = require('esbuild');
const source = fs.readFileSync(require.resolve('../app/ui/cloud-maintenance-surfaces.jsx'), 'utf8');
const css = fs.readFileSync(require.resolve('../app/ui/cloud-maintenance-surfaces.css'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const primitives = Object.fromEntries(['AlertBanner', 'Badge', 'Button', 'Caption', 'Card', 'Checkbox', 'EmptyState', 'Heading', 'Label', 'StatusBadge', 'TextInput', 'KitCheckbox', 'CloudConnectionField', 'Database', 'FolderInput', 'KeyRound', 'Server'].map(name => [name, `Kit:${name}`]));
function fixture(language = 'zh') {
  const module = { exports: {} }, react = { ...React, useLayoutEffect() {}, useRef: value => ({ current: value }) };
  vm.runInNewContext(compiled, { module, exports: module.exports, document: { documentElement: { lang: language }, getElementById: () => true }, require: id => id === 'react' ? react : id.endsWith('.css') ? css : primitives });
  const calls = [], callbacks = Object.fromEntries(['onChange', 'onInspect', 'onSave', 'onMove', 'onRefresh', 'onReconcile', 'onConnect', 'onSSH'].map(name => [name, (...args) => calls.push({ name, args })]));
  return { calls, storage: draft => module.exports.CloudSSHStorage({ draft, ...callbacks }), account: props => module.exports.CloudAccountConnection({ ...callbacks, ...props }) };
}
function nodes(node) { if (!React.isValidElement(node)) return []; if (typeof node.type === 'function') return nodes(node.type(node.props)); return [node, ...React.Children.toArray(node.props.children).flatMap(nodes)]; }
function text(node) { if (typeof node === 'string' || typeof node === 'number') return String(node); if (!React.isValidElement(node)) return ''; if (typeof node.type === 'function') return text(node.type(node.props)); return React.Children.toArray(node.props.children).map(text).join(' '); }
const find = (tree, kind, predicate = () => true) => nodes(tree).find(node => node.type === `Kit:${kind}` && predicate(node.props));
const button = (tree, id) => find(tree, 'Button', props => props.id === id);
const base = patch => ({ config: { target: 'research-server', sshPort: 0, localPort: 18787, remotePort: 8787 }, savedConfig: { target: 'research-server' }, remote: { dataPath: '/srv/aibro', databasePath: '/srv/aibro/db.sqlite3' }, verified: true, destination: '/mnt/aibro', confirmed: true, busy: '', job: null, uncertain: false, ...patch });

test('directory movement requires a current verification, destination and explicit consent', () => {
  const h = fixture();
  assert.equal(button(h.storage(base()), 'cloudSSHMove').props.disabled, false);
  for (const patch of [{ verified: false }, { confirmed: false }, { destination: '   ' }, { destination: 'relative/path' }, { destination: '/srv/aibro' }, { busy: 'save' }, { busy: 'inspect' }, { busy: 'move' }, { busy: 'poll' }, { job: { state: 'running', message: '正在复制校验' } }, { uncertain: true }]) {
    const tree = h.storage(base(patch));
    assert.equal(button(tree, 'cloudSSHMove').props.disabled, true, JSON.stringify(patch));
  }
});
test('uncertain migration keeps modifications locked and offers a status read instead of resubmission', () => {
  const h = fixture(), tree = h.storage(base({ uncertain: true, message: '网络读取中断', kind: 'error' }));
  assert.equal(button(tree, 'cloudSSHInspect').props.disabled, true);
  assert.equal(button(tree, 'cloudSSHSave').props.disabled, true);
  assert.equal(find(tree, 'CloudConnectionField', p => p.id === 'cloudSSHDataPath').props.disabled, true);
  assert.equal(find(tree, 'KitCheckbox').props.disabled, true);
  assert.equal(button(tree, 'cloudSSHRefresh').props.disabled, false);
  button(tree, 'cloudSSHRefresh').props.onClick();
  assert.equal(h.calls[0].name, 'onRefresh');
  assert.match(find(tree, 'AlertBanner').props.description, /网络读取中断/);
  assert.match(text(tree), /迁移可能仍在服务器进行/);
  assert.equal(nodes(tree).findIndex(node => node.props.id === 'cloudSSHMessage') < nodes(tree).findIndex(node => node.type === 'Kit:CloudConnectionField'), true);
  assert.equal(nodes(tree).some(node => node.props.role === 'progressbar'), false);
});
test('maintenance fields expose stable identities, retain the bound port, and send raw edits to the controller', () => {
  const h = fixture(), tree = h.storage(base()), all = nodes(tree);
  assert.equal(all.some(node => ['input', 'textarea', 'select'].includes(node.type)), false);
  const local = find(tree, 'CloudConnectionField', p => p.id === 'cloudSSH-localPort');
  assert.equal(local.props.readOnly, true); assert.equal(local.props.value, '18787');
  const target = find(tree, 'CloudConnectionField', p => p.id === 'cloudSSH-target');
  target.props.onChange('user@new-server');
  const port = find(tree, 'CloudConnectionField', p => p.id === 'cloudSSH-sshPort');
  assert.equal(port.props.min, 0); assert.equal(port.props.max, 65535); port.props.onChange('');
  find(tree, 'KitCheckbox').props.onChange(false);
  assert.deepEqual(h.calls.map(call => [call.name, ...call.args]), [['onChange', 'target', 'user@new-server'], ['onChange', 'sshPort', ''], ['onChange', 'confirmed', false]]);
  assert.match(text(tree), /\/srv\/aibro\/db.sqlite3/);
});
test('recovered uncertainty has a static receipt and a separate explicit server reconciliation action', () => {
  const h=fixture(), job={id:'a'.repeat(32),state:'uncertain',config:{target:'saved-host'},source:'/srv/old',destination:'/srv/new',message:'上次迁移的结果待核对'};
  const tree=h.storage(base({job,uncertain:false}));
  assert.equal(button(tree,'cloudSSHMove').props.disabled,true);assert.equal(button(tree,'cloudSSHSave').props.disabled,true);
  assert.equal(button(tree,'cloudSSHReconcile').props.disabled,false);button(tree,'cloudSSHReconcile').props.onClick();
  button(tree,'cloudSSHRefresh').props.onClick();assert.deepEqual(h.calls.map(c=>c.name),['onReconcile','onRefresh']);
  assert.match(text(tree),/saved-host/);assert.match(text(tree),/\/srv\/old/);assert.match(text(tree),/\/srv\/new/);assert.match(text(tree),/本机记录会跨退出保留/);
  assert.equal(nodes(tree).some(n=>n.type==='Kit:StatusBadge'&&n.props.pulse),false);
  const missing=h.storage({config:null,job});assert.ok(button(missing,'cloudSSHReconcile'));
  assert.equal(find(missing,'EmptyState').props.action.props.disabled,true);
  const invalid=h.storage({config:null,job:{state:'uncertain',message:'本机记录损坏'}});
  assert.equal(button(invalid,'cloudSSHReconcile'),undefined);assert.equal(find(invalid,'EmptyState').props.action.props.disabled,true);
});
test('no connection has one actionable empty state and job completion is sourced from actual state', () => {
  const h = fixture(), empty = h.storage({ config: null });
  const state = find(empty, 'EmptyState'); assert.ok(state); state.props.action.props.onClick(); assert.equal(h.calls[0].name, 'onConnect');
  assert.equal(nodes(empty).some(node => node.type === 'Kit:CloudConnectionField'), false);
  const tree = h.storage(base({ job: { state: 'completed', message: '复制校验已通过；旧目录保留。' }, verified: false }));
  assert.match(text(tree), /复制校验已通过/); assert.match(text(tree), /迁移已完成/);
  assert.equal(button(tree, 'cloudSSHMove').props.disabled, true);
});
test('account presentation never reads passwords or replaces the owned native fields and submit button', () => {
  const h = fixture(), controls = { cloudPassword: { disabled: false }, cloudConnect: { label: '登录并恢复同步', disabled: false }, cloudMergeConfirmed: { checked: true, label: '继续同步原账号内容' }, cloudConnectionSSH: { hidden: true } };
  Object.defineProperty(controls.cloudPassword, 'value', { get() { throw new Error('Password must remain in the native DOM'); } });
  const tree = h.account({ view: { needsSignIn: true }, controls, attach() {} }), all = nodes(tree);
  for (const id of ['cloudServerUrl', 'cloudUsername', 'cloudPassword', 'cloudDeviceName', 'cloudMergeConfirmed', 'cloudConnect', 'cloudConnectionIntro', 'cloudServerHint', 'cloudConnectionSSH']) assert.equal(all.filter(node => node.props['data-cloud-account-slot'] === id).length, 1, id);
  assert.equal(all.some(node => ['form', 'input'].includes(node.type)), false);
  const secret = find(tree, 'TextInput', props => props.type === 'password'); assert.equal(secret.props.value, '');
  assert.equal(find(tree, 'Checkbox').props.checked, true);
  assert.match(text(tree), /SSH 登录用户、Mac 登录密码和模型 API Key 各自独立/);
  assert.match(text(tree), /登录并恢复同步/);
  for (const input of all.filter(node => ['Kit:TextInput', 'Kit:Checkbox'].includes(node.type))) assert.equal(input.props.onChange, undefined);
  assert.ok(all.some(node => node.props.inert === true && node.props['aria-hidden'] === 'true'));
});
test('account SSH option routes once and retained SSH action avoids a second interactive entry', () => {
  const h = fixture('en'), controls = { cloudConnectionSSH: { hidden: true }, cloudConnect: { label: 'Connect' } };
  const tree = h.account({ controls }); button(tree, 'cloudAccountUseSSH').props.onClick(); assert.equal(h.calls[0].name, 'onSSH');
  const retained = h.account({ controls: { ...controls, cloudConnectionSSH: { hidden: false, label: 'SSH settings' } } });
  assert.equal(button(retained, 'cloudAccountUseSSH'), undefined);
  assert.match(text(retained), /separate from your SSH user/);
});
test('maintenance stylesheet supports narrow windows and reduced motion without weakening password ownership', () => {
  assert.doesNotThrow(() => esbuild.transformSync(css, { loader: 'css' }));
  assert.match(css, /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /focus-visible/);
  assert.doesNotMatch(source, /control\.value|input\.value|state\.value|cloudPassword\.value/);
});
