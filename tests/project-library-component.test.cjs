'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),React=require('react'),esbuild=require('esbuild'),Library=require('../app/project-library.js');
const source=fs.readFileSync(require.resolve('../app/ui/project-library.jsx'),'utf8');
const compiled=esbuild.transformSync(source,{loader:'jsx',format:'cjs'}).code;
const controlsCompiled=esbuild.transformSync(fs.readFileSync(require.resolve('../app/ui/kit-controls.jsx'),'utf8'),{loader:'jsx',format:'cjs'}).code;
function setup(lang='zh',realControls=false){
 const module={exports:{}},effects=[],refs=[];let next=0;
 const react={...React,useId:()=>`node-${next++}`,useLayoutEffect:f=>effects.push(f),useRef:()=>{const ref={current:null};refs.push(ref);return ref;}};
 const document={documentElement:{lang},getElementById:()=>true},kit={Button:'Kit:Button',SegmentedControl:'Kit:SegmentedControl'};
 let controls={KitSegmentedControl:'Kit:ScopeControl'};
 if(realControls){const module={exports:{}};vm.runInNewContext(controlsCompiled,{module,exports:module.exports,document,require:id=>id==='react'?react:id.endsWith('.css')?'':kit});controls=module.exports;}
 vm.runInNewContext(compiled,{module,exports:module.exports,document,require:id=>id==='react'?react:id.endsWith('.css')?'':id.endsWith('kit-controls.jsx')?controls:kit});
 return {components:module.exports,effects,refs};
}
function expand(node){if(!React.isValidElement(node))return node;if(typeof node.type==='function')return expand(node.type(node.props));return React.cloneElement(node,{},...React.Children.toArray(node.props.children).map(expand));}
function nodes(node){return React.isValidElement(node)?[node,...React.Children.toArray(node.props.children).flatMap(nodes)]:[];}
function text(node){return typeof node==='string'||typeof node==='number'?String(node):React.isValidElement(node)?React.Children.toArray(node.props.children).map(text).join(''):'';}
const records=[{folderPath:'A/B/C'},{folderPath:'A/D'},{folderPath:'<img>'},{}];
test('navigation uses actual Kit button imports and semantic nav/list, no partial ARIA tree',()=>{
 const f=setup(),tree=expand(f.components.ProjectLibraryNavigation({projectId:'p',model:Library.buildModel(records),onSelect(){},onToggle(){}}));assert.equal(tree.type,'nav');assert.equal(tree.props['aria-label'],'按目录浏览资料');assert.ok(nodes(tree).filter(n=>n.type==='Kit:Button').length>=7);assert.equal(nodes(tree).some(n=>n.props.role==='tree'),false);assert.match(text(tree),/<img>/);assert.equal(nodes(tree).some(n=>n.type==='img'),false);
});
test('disclosure and selection have separate callbacks, controls point at hidden descendant lists',()=>{
 const f=setup(),calls=[],tree=expand(f.components.ProjectLibraryNavigation({projectId:'p',model:Library.buildModel(records),onSelect:path=>calls.push(['select',path]),onToggle:(...args)=>calls.push(['toggle',...args])}));
 const buttons=nodes(tree).filter(n=>n.type==='Kit:Button'),disclosure=buttons.find(n=>n.props['aria-label']==='展开 A');assert.equal(disclosure.props['aria-expanded'],false);const ul=nodes(tree).find(n=>n.props.id===disclosure.props['aria-controls']);assert.equal(ul.type,'ul');assert.equal(ul.props.hidden,true);disclosure.props.onClick();assert.deepEqual(calls,[['toggle','A',true]]);buttons.find(n=>n.props.title==='A').props.onClick();assert.deepEqual(calls[1],['select','A']);assert.equal(buttons.some(n=>n.props['aria-label']==='展开 A/D'),false);
});
test('breadcrumb keeps hidden current position visible and provides explicit reveal plus ancestor selection',()=>{
 const f=setup(),calls=[],model=Library.buildModel(records,'A/B/C',{'A':false}),tree=expand(f.components.ProjectLibraryBreadcrumb({model,onSelect:p=>calls.push(p),onReveal:()=>calls.push('reveal')}));assert.equal(nodes(tree).find(n=>n.props['aria-current']==='location').props.children,'C');const buttons=nodes(tree).filter(n=>n.type==='Kit:Button');buttons.find(n=>n.props['aria-label']==='在目录中显示当前位置').props.onClick();buttons.find(n=>n.props.title==='A').props.onClick();assert.deepEqual(calls,['reveal','A']);
});
test('actual native Kit button receives current-page and stable automation attributes',()=>{
 const f=setup();expand(f.components.ProjectLibraryNavigation({projectId:'p',model:Library.buildModel(records,''),onSelect(){},onToggle(){}}));let selected=0;for(const ref of f.refs){const attributes={};ref.current={querySelector:()=>({setAttribute(k,v){attributes[k]=v;},removeAttribute(k){delete attributes[k];}})};ref.attributes=attributes;}f.effects.forEach(effect=>effect());for(const ref of f.refs){if(ref.attributes['aria-current']==='page'){selected++;assert.equal(ref.attributes['data-project-library-folder'],'');}}assert.equal(selected,1);
});
test('English navigation and breadcrumb translate UI labels without modifying user folders',()=>{
 const f=setup('en'),model=Library.buildModel([{folderPath:'中文目录/资料'},{}],'中文目录/资料',{'中文目录':false}),tree=expand(f.components.ProjectLibraryNavigation({projectId:'p',model,onSelect(){},onToggle(){}})),crumb=expand(f.components.ProjectLibraryBreadcrumb({model,onSelect(){},onReveal(){}}));assert.match(text(tree),/All sources/);assert.match(text(tree),/Uncategorized/);assert.match(text(tree),/中文目录/);assert.match(text(crumb),/Show in folders/);assert.ok(nodes(tree).some(n=>n.props['aria-label']==='Expand 中文目录'));
});
test('scope switch labels expose exact counts and full selected context in both languages',()=>{
 for(const lang of ['zh','en'])for(const scope of ['content','records','all']){
  const f=setup(lang),counts={content:7,records:3,all:10},model=Library.buildModel([{folderPath:'项目记录 <img> /用户长目录'.repeat(8)}]);
  const tree=expand(f.components.ProjectLibraryNavigation({projectId:'p',scope,counts,model,onScope(){},onSelect(){},onToggle(){}}));
  const control=nodes(tree).find(n=>n.type==='Kit:ScopeControl');assert.equal(control.props.value,scope);assert.equal(control.props.disabled,false);assert.equal(control.props.label,lang==='zh'?'项目内容范围':'Project content scope');
  assert.deepEqual(Array.from(control.props.options,x=>x.label),lang==='zh'?['资料 7','记录 3','全部 10']:['Sources 7','Records 3','All 10']);
  assert.equal(control.props.options[1].attributes['aria-label'],lang==='zh'?'项目记录，3 项':'Project records, 3 items');assert.equal(control.props.options[1].attributes['data-project-library-scope'],'records');
  const expected=scope==='records'?(lang==='zh'?'全部记录':'All records'):scope==='all'?(lang==='zh'?'全部内容':'All content'):(lang==='zh'?'全部资料':'All sources');
  assert.match(text(tree),new RegExp(expected));assert.match(text(tree),lang==='zh'?/当前范围：/:/Current scope:/);assert.match(text(tree),/项目记录 <img>/);assert.equal(nodes(tree).some(n=>n.type==='img'),false);
  const crumb=expand(f.components.ProjectLibraryBreadcrumb({scope,model:Library.buildModel([]),onSelect(){},onReveal(){}}));assert.equal(text(crumb),expected);
 }
});
test('scope switch uses the actual Kit radio adapter for Arrow Home End, one tab stop and labelled activation',()=>{
 const f=setup('zh',true),calls=[],tree=expand(f.components.ProjectLibraryNavigation({projectId:'p',scope:'content',counts:{content:2,records:3,all:5},model:Library.buildModel([]),onScope:value=>calls.push(value),onSelect(){},onToggle(){}}));
 const group=nodes(tree).find(n=>n.props.role==='radiogroup'),segment=nodes(tree).find(n=>n.type==='Kit:SegmentedControl');
 assert.equal(group.props['aria-label'],'项目内容范围');
 const button=()=>({dataset:{},attributes:{},disabled:false,focus(){this.focused=true;},closest(){return this;},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];}}),buttons=[button(),button(),button()];
 for(const ref of f.refs)ref.current={querySelector:()=>button(),querySelectorAll:()=>[]};
 group.props.ref.current={querySelectorAll:()=>buttons};f.effects.forEach(effect=>effect());
 assert.equal(buttons.filter(b=>b.tabIndex===0).length,1);assert.equal(buttons[0].attributes['aria-checked'],'true');assert.equal(buttons[1].attributes['aria-label'],'项目记录，3 项');assert.ok(buttons.every(b=>b.attributes.role==='radio'));
 for(const [key,index,expected]of [['ArrowRight',0,'records'],['End',0,'all'],['Home',2,'content'],['ArrowLeft',0,'all']]){
  let prevented=false;group.props.onKeyDown({key,target:buttons[index],preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(calls.at(-1),expected);
 }
 segment.props.onChange('记录 3');assert.equal(calls.at(-1),'records');const length=calls.length;segment.props.onChange('未知范围');assert.equal(calls.length,length);
});
test('a scope switch without a controller is disabled and cannot dispatch through the Kit adapter',()=>{
 const f=setup('en',true),tree=expand(f.components.ProjectLibraryNavigation({projectId:'p',model:Library.buildModel([]),onSelect(){},onToggle(){}})),group=nodes(tree).find(n=>n.props.role==='radiogroup');
 const buttons=[0,1,2].map(()=>({dataset:{},setAttribute(){},removeAttribute(){},focus(){throw Error('Disabled scope must not receive focus');}}));
 for(const ref of f.refs)ref.current={querySelector:()=>null,querySelectorAll:()=>[]};group.props.ref.current={querySelectorAll:()=>buttons};f.effects.forEach(effect=>effect());assert.ok(buttons.every(b=>b.disabled));
 assert.doesNotThrow(()=>group.props.onKeyDown({key:'ArrowRight',target:{closest:()=>buttons[0]},preventDefault(){}}));
});
