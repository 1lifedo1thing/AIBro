'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const esbuild = require('esbuild');
const source = fs.readFileSync(require.resolve('../app/ui/artifact-provenance-surfaces.jsx'), 'utf8');
const css = fs.readFileSync(require.resolve('../app/artifact-provenance.css'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
// These tests exercise the projection/action contract. Kit primitives are
// placeholders here; their actual DOM and native rendering belong to UI QA.
const primitives = Object.fromEntries(['Badge', 'Button', 'Card', 'Heading', 'StatusBadge', 'Text', 'KitTabs'].map(name => [name, `Kit:${name}`]));
function fixture(language = 'zh') {
  const module = { exports: {} }, appended = [], calls = [], focuses = [], hooks = new Map();
  let owner, cursor, effects;
  const slot = initial => { const index = cursor++, values = hooks.get(owner) || []; hooks.set(owner, values); if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values, index]; };
  const react = { ...React,
    useState: initial => { const [values,index] = slot(initial); return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }]; },
    useRef: initial => { const [values,index] = slot(() => ({ current: initial })); return values[index]; },
    useLayoutEffect: (effect,deps) => { const [values,index] = slot(null); if (!values[index] || deps.some((value,i) => value !== values[index][i])) effects.push(effect); values[index] = deps; },
  };
  const document = { documentElement: { lang: language }, getElementById: () => null, createElement: () => ({}), head: { appendChild: node => appended.push(node) } };
  vm.runInNewContext(compiled, { module, exports: module.exports, document, require: id => id === 'react' ? react : id.endsWith('.css') ? css : primitives });
  const onAction = (action, payload) => calls.push({ action, payload });
  function expand(node, path = 'root') {
    if (!React.isValidElement(node)) return node;
    if (typeof node.type === 'function') { owner = `${path}/${node.type.name}`; cursor = 0; return expand(node.type(node.props), path); }
    const tree = React.cloneElement(node, undefined, React.Children.toArray(node.props.children).map((child,index) => expand(child, `${path}/${child.key ?? index}`)));
    if (node.props.ref) node.props.ref.current = { querySelector: selector => {
      const rows = nodes(tree).filter(row => row.props['data-provenance-source']);
      const row = rows.find(row => nodes(row).some(button => button.type === 'Kit:Button' && !button.props.disabled));
      if (selector.startsWith('[data-provenance-source]') && !row) return null;
      return { focus: () => focuses.push(row?.props['data-provenance-source'] || 'group-heading'), scrollIntoView() {} };
    } };
    return tree;
  }
  return { render: props => { effects = []; const tree = expand(module.exports.ArtifactProvenanceSurface({ onAction, ...props })); effects.forEach(effect => effect()); return tree; }, calls, appended, focuses };
}
function nodes(node) {
  if (!React.isValidElement(node)) return [];
  if (typeof node.type === 'function') return nodes(node.type(node.props));
  return [node, ...React.Children.toArray(node.props.children).flatMap(nodes)];
}
function copy(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!React.isValidElement(node)) return '';
  if (typeof node.type === 'function') return copy(node.type(node.props));
  return React.Children.toArray(node.props.children).map(copy).join(' ');
}
const base = (patch = {}) => ({ available: true, title: '研究成果', variant: 'body', recordKind: 'recorded', bodyChanged: false,
  origin: { recorded: true, runId: 'r', conversationId: 'c', userMessageId: 'm', at: Date.UTC(2026, 8, 30), model: 'model-id', provider: 'provider-id', effort: 'medium', runAvailable: true, conversationAvailable: true }, inputs: [], related: [], ...patch });
const button = (tree, id) => nodes(tree).find(node => node.type === 'Kit:Button' && node.props.id === id);

test('recorded body and draft use separate headings and controlled Kit tab actions', () => {
  const h = fixture();
  const body = h.render({ projection: base({ hasDraft: true }) });
  assert.match(copy(body), /本正文生成记录/); assert.doesNotMatch(copy(body), /本草稿生成记录/);
  const tabs = nodes(body).find(node => node.type === 'Kit:KitTabs');
  assert.equal(tabs.props.value, 'body'); assert.equal(tabs.props.options[1].controls, 'artifactProvenancePanel');
  tabs.props.onChange('draft'); tabs.props.onChange('unexpected');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].action, 'variant'); assert.equal(h.calls[0].payload.variant, 'draft');
  assert.equal(tabs.props.value, 'body', 'presentation cannot change the projected variant');
  const draft = h.render({ projection: base({ variant: 'draft', hasDraft: true }) });
  assert.match(copy(draft), /本草稿生成记录/); assert.doesNotMatch(copy(draft), /本正文生成记录/);
  assert.equal(nodes(draft).find(node => node.props.role === 'tabpanel').props['aria-labelledby'], 'artifactProvenanceDraftTab');
});
test('legacy and unrecorded provenance never claim the current body was generated by a linked run', () => {
  const h = fixture();
  const legacy = h.render({ projection: base({ recordKind: 'legacy-linked', origin: { recorded: false, model: 'old-model', runId: 'old-run', runAvailable: true } }) });
  assert.match(copy(legacy), /关联历史运行/); assert.match(copy(legacy), /无法确认它生成了当前正文或草稿/); assert.doesNotMatch(copy(legacy), /本正文生成记录/);
  const missing = h.render({ projection: base({ recordKind: 'unrecorded', origin: {} }) });
  assert.match(copy(missing), /尚未留存生成记录/); assert.match(copy(missing), /无法补推/);
  assert.equal(button(missing, 'artifactProvenanceRun').props.disabled, true);
  assert.equal(button(missing, 'artifactProvenanceConversation').props.disabled, true);
});
test('unavailable artifact and rows hide old titles, metadata and source locations', () => {
  const h = fixture(), leak = 'OLD PRIVATE TITLE';
  const unavailable = h.render({ projection: base({ available: false, title: leak, inputs: [{ title: leak }], origin: { model: leak } }), hasDraft: true, canOpenRelations: true });
  assert.doesNotMatch(copy(unavailable), /OLD PRIVATE TITLE/);
  assert.equal(nodes(unavailable).some(node => node.type === 'Kit:KitTabs'), false);
  assert.equal(button(unavailable, 'artifactProvenanceRelations'), undefined);
  const hiddenRow = h.render({ projection: base({ inputs: [{ key: 'ref', type: 'import', id: 'i', title: leak, status: 'unavailable', available: false, detail: leak, page: 987, offset: 654 }] }) });
  assert.doesNotMatch(copy(hiddenRow), /OLD PRIVATE TITLE|987|654/);
  const open = nodes(hiddenRow).find(node => node.type === 'Kit:Button' && copy(node).includes('打开来源'));
  assert.equal(open.props.disabled, true); open.props.onClick(); assert.equal(h.calls.length, 0);
});
test('source navigation retains stable identity and distinguishes related records from recorded inputs', () => {
  const h = fixture();
  const item = { key: 'stable-input-key', type: 'import', id: 'pdf', title: '原件', available: true, status: 'current', page: 2, pages: [2, 4, -1], offset: 0, end: 240, detail: '记录摘录' };
  const tree = h.render({ projection: base({ inputs: [item], related: [{ ...item, key: 'related-note', type: 'note', id: 'n', status: 'unrecorded' }] }) });
  assert.match(copy(tree), /版本一致只表示/); assert.match(copy(tree), /不代表它们参与过本正文的生成/); assert.match(copy(tree), /记录页码：2、4/); assert.match(copy(tree), /记录字符位置：0–240/);
  const buttons = nodes(tree).filter(node => node.type === 'Kit:Button' && copy(node).includes('打开来源'));
  buttons[0].props.onClick(); buttons[1].props.onClick();
  assert.equal(h.calls[0].action, 'open-source'); assert.equal(h.calls[0].payload.key, item.key); assert.equal(h.calls[0].payload.related, false);
  assert.equal(h.calls[1].payload.related, true); assert.equal(h.calls[1].payload.id, 'n');
});
test('busy state and missing callbacks disable every action, including controlled variant changes', () => {
  const h = fixture();
  const tree = h.render({ projection: base({ hasDraft: true, inputs: [{ key: 'i', type: 'import', id: 'i', title: 'Source', available: true, status: 'current' }] }), busy: 'open-source', canOpenRelations: true });
  const controls = nodes(tree).filter(node => ['Kit:Button', 'Kit:KitTabs'].includes(node.type));
  assert.ok(controls.length >= 6); assert.ok(controls.every(node => node.props.disabled === true));
  for (const control of controls) { control.props.onClick?.(); control.props.onChange?.('draft'); }
  assert.equal(h.calls.length, 0); assert.equal(tree.props['aria-busy'], true); assert.match(copy(tree), /正在打开/);
  const missing = h.render({ projection: base(), onAction: undefined });
  assert.ok(nodes(missing).filter(node => node.type === 'Kit:Button').every(node => node.props.disabled));
});
test('origin, relationships and close delegate exact destinations; notices stay literal status text', () => {
  const h = fixture(), notice = '<script>not markup</script>';
  const tree = h.render({ projection: base(), notice, canOpenRelations: true });
  for (const id of ['artifactProvenanceRun', 'artifactProvenanceConversation', 'artifactProvenanceRelations', 'artifactProvenanceClose']) button(tree, id).props.onClick();
  assert.deepEqual(h.calls.map(call => call.action), ['open-run', 'open-conversation', 'open-relations', 'close']);
  assert.equal(h.calls[0].payload.runId, 'r'); assert.equal(h.calls[1].payload.userMessageId, 'm');
  const status = nodes(tree).find(node => node.props.role === 'status'); assert.equal(copy(status), notice); assert.equal(status.props['aria-live'], 'polite');
});
test('modified bodies and incomplete input retention remain explicit in English without fabricated metadata', () => {
  const h = fixture('en');
  const tree = h.render({ projection: base({ bodyChanged: true, omittedInputs: 3, evidenceLimitReached: true, origin: { recorded: true, at: Infinity, model: null, provider: {}, effort: '' } }) });
  assert.match(copy(tree), /body changed after generation/); assert.match(copy(tree), /3 additional inputs were not retained/); assert.match(copy(tree), /does not represent its full input coverage/);
  assert.doesNotMatch(copy(tree), /Invalid Date|\[object Object\]/); assert.equal(nodes(tree).some(node => node.type === 'time'), false);
  assert.equal(h.appended[0].id, 'halaska-artifact-provenance-styles');
  assert.doesNotThrow(() => esbuild.transformSync(css, { loader: 'css' })); assert.match(css, /@container\(max-width:420px\)/); assert.match(css, /prefers-reduced-motion/);
});
test('unretained excerpts differ from unknown versions and remain openable without claiming a verified conclusion',()=>{
 const h=fixture(),item={key:'late-source',type:'import',id:'pdf',title:'Later page',page:390,available:true,status:'unretained',excerptState:'omitted',excerptCharacters:5400,detail:'摘录超过正文预算；当前来源可以打开，但不能还原旧片段。'};
 const tree=h.render({projection:base({inputs:[item],evidenceExcerptLimitReached:true})}),words=copy(tree);
 assert.match(words,/未留存摘录/);assert.match(words,/已记录的来源身份均保留/);assert.doesNotMatch(words,/未完整留存来源身份|不能代表当时的完整输入范围/);
 assert.match(words,/不代表来源支持每一项结论/);
 const open=nodes(tree).find(n=>n.type==='Kit:Button'&&copy(n).includes('打开来源'));assert.equal(open.props.disabled,false);open.props.onClick();assert.equal(h.calls[0].payload.key,'late-source');
 const changed=h.render({projection:base({inputs:[{...item,status:'changed',detail:'原件已变化；未留存旧摘录。'}]})});assert.match(copy(changed),/来源已变化/);assert.match(copy(changed),/未留存摘录/);
 const privateRow=h.render({projection:base({inputs:[{...item,private:true,title:'SECRET_PRIVATE',detail:'SECRET_TEXT'}]})});assert.doesNotMatch(copy(privateRow),/SECRET_|390|5400/);
});
test('source pagination renders 20 rows, reaches late input identities and preserves each group page on refresh',()=>{
 const h=fixture(),inputs=Array.from({length:145},(_,i)=>({key:'source-'+i,type:'import',id:'pdf',title:'Page '+(i+1),page:i+1,available:true,status:i>100?'unretained':'current',excerptState:i>100?'omitted':'retained'}));
 let tree=h.render({projection:base({hasDraft:true,inputs,related:inputs.slice(0,25)})});
 const groups=tree=>nodes(tree).filter(n=>n.props.className==='artifact-provenance-group');
 const rows=group=>nodes(group).filter(n=>n.props['data-provenance-source']);
 const pager=(group,text)=>nodes(group).find(n=>n.type==='Kit:Button'&&copy(n)===text);
 assert.equal(rows(groups(tree)[0]).length,20);assert.equal(rows(groups(tree)[1]).length,20);
 for(let i=0;i<6;i++){pager(groups(tree)[0],'下一页').props.onClick();tree=h.render({projection:base({hasDraft:true,inputs,related:inputs.slice(0,25)})});}
 assert.equal(rows(groups(tree)[0])[0].props['data-provenance-source'],'source-120');assert.equal(rows(groups(tree)[1])[0].props['data-provenance-source'],'source-0');
 assert.equal(h.focuses.at(-1),'source-120');assert.equal(nodes(tree).find(n=>n.type==='Kit:KitTabs').props.value,'body');
 const late=rows(groups(tree)[0])[9],open=nodes(late).find(n=>n.type==='Kit:Button');open.props.onClick();assert.equal(h.calls[0].payload.key,'source-129');
 const beforeFocus=h.focuses.length;tree=h.render({projection:base({hasDraft:true,inputs:inputs.map(x=>({...x})),related:inputs.slice(0,25)})});
 assert.equal(rows(groups(tree)[0])[0].props['data-provenance-source'],'source-120');assert.equal(h.focuses.length,beforeFocus,'ordinary access refresh does not steal focus');
 pager(groups(tree)[0],'下一页').props.onClick();tree=h.render({projection:base({inputs,related:inputs.slice(0,25)})});
 assert.equal(rows(groups(tree)[0]).length,5);assert.equal(pager(groups(tree)[0],'下一页').props.disabled,true);
 tree=h.render({projection:base({inputs:inputs.slice(0,22),related:[]})});assert.equal(rows(groups(tree)[0])[0].props['data-provenance-source'],'source-20');assert.equal(rows(groups(tree)[0]).length,2);assert.equal(h.focuses.at(-1),'source-20');
 tree=h.render({projection:base({inputs,related:[]})});assert.equal(rows(groups(tree)[0])[0].props['data-provenance-source'],'source-20','growth does not resurrect a previously clamped page');
});
test('busy pagination cannot move the selected source page or invoke navigation',()=>{
 const h=fixture(),inputs=Array.from({length:21},(_,i)=>({key:'source-'+i,type:'import',id:'pdf',title:'Page '+i,available:true,status:'current'}));
 let tree=h.render({projection:base({inputs}),busy:true});const next=nodes(tree).find(n=>n.type==='Kit:Button'&&copy(n)==='下一页');assert.equal(next.props.disabled,true);next.props.onClick();
 tree=h.render({projection:base({inputs}),busy:false});assert.equal(nodes(tree).find(n=>n.props['data-provenance-source']).props['data-provenance-source'],'source-0');assert.equal(h.calls.length,0);
});
test('mixed historical identity gaps and new excerpt limits retain separate truthful coverage notices',()=>{
 for(const gap of [{omittedInputs:3},{evidenceLimitReached:true}]){
  const h=fixture(),tree=h.render({projection:base({...gap,evidenceExcerptLimitReached:true})});
  assert.match(copy(tree),/新增记录的来源编号已保留/);assert.match(copy(tree),/旧版缺失映射仍不可恢复/);assert.doesNotMatch(copy(tree),/已记录的来源身份均保留/);
 }
});
