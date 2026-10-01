'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),React=require('react'),esbuild=require('esbuild');
const source=fs.readFileSync(require.resolve('../app/ui/composer-surfaces.jsx'),'utf8');
const compiled=esbuild.transformSync(source,{loader:'jsx',format:'cjs'}).code;
const controlSource=fs.readFileSync(require.resolve('../app/ui/kit-controls.jsx'),'utf8');
const controlsCompiled=esbuild.transformSync(controlSource,{loader:'jsx',format:'cjs'}).code;
const kit=Object.fromEntries(['Button','Select','TextArea'].map(name=>[name,`Kit:${name}`]));
function fixture(language='zh'){
 const module={exports:{}},controls={exports:{}},react={...React,useLayoutEffect(){},useRef:value=>({current:value})};
 const document={documentElement:{lang:language},getElementById:()=>true};
 vm.runInNewContext(controlsCompiled,{module:controls,exports:controls.exports,document,require:id=>id==='react'?react:id.endsWith('.css')?'':kit});
 vm.runInNewContext(compiled,{module,exports:module.exports,document,require:id=>id==='react'?react:id.endsWith('kit-controls.jsx')?controls.exports:kit});
 const calls=[];
 return {calls,render:props=>expand(module.exports.PdfReadModeControl({onChange:value=>calls.push(value),...props}))};
}
function expand(node){if(!React.isValidElement(node))return node;if(typeof node.type==='function')return expand(node.type(node.props));return React.cloneElement(node,{},...React.Children.toArray(node.props.children).map(expand));}
function nodes(node){return React.isValidElement(node)?[node,...React.Children.toArray(node.props.children).flatMap(nodes)]:[];}
function text(node){if(typeof node==='string'||typeof node==='number')return String(node);return React.isValidElement(node)?React.Children.toArray(node.props.children).map(text).join(' '):'';}
const find=(tree,type)=>nodes(tree).find(node=>node.type===type);
const event=key=>({key,stopPropagation(){this.stopped=true;},preventDefault(){this.prevented=true;}});

test('compact PDF row keeps a real Kit selector and initially closed native explanation',()=>{
 const tree=fixture().render({compact:true}),select=find(tree,'select'),details=find(tree,'details');
 assert.match(tree.props.className,/pdf-read-mode-control--compact/);
 assert.equal(text(find(tree,'label')),'PDF');
 assert.equal(select.props.value,'original');
 assert.ok(find(tree,'Kit:Select'));
 assert.deepEqual(nodes(tree).filter(node=>node.type==='option').map(text),['发送原件','读取文字']);
 assert.equal(details.props.open,undefined);
 assert.equal(find(details,'summary').props['aria-label'],'PDF 读取方式说明');
 assert.equal(nodes(tree).filter(node=>node.type==='p').length,1);
 assert.ok(find(details,'p'),'the persistent row contains no separate explanation paragraph');
 assert.equal(select.props['aria-describedby'],find(details,'p').props.id);
});

test('text mode keeps actual coverage, no images and no OCR guidance in the disclosure',()=>{
 const tree=fixture().render({compact:true,value:'text'}),description=text(find(tree,'details'));
 assert.match(description,/按需继续读页/);assert.match(description,/不包含图像或 OCR/);assert.match(description,/实际读取范围见本轮来源记录/);
 assert.equal(find(tree,'select').props.value,'text');
});

test('explanation activation preserves native keyboard default without propagating a send action',()=>{
 const h=fixture(),summary=find(h.render({compact:true}),'summary');
 for(const key of ['Enter',' ']){const e=event(key);summary.props.onKeyDown(e);assert.equal(e.stopped,true);assert.equal(e.prevented,undefined);}
 for(const key of ['Tab','Escape','ArrowDown']){const e=event(key);summary.props.onKeyDown(e);assert.equal(e.stopped,undefined);assert.equal(e.prevented,undefined);}
 const click=event();summary.props.onClick(click);assert.equal(click.stopped,true);assert.equal(click.prevented,undefined);
 assert.deepEqual(h.calls,[]);assert.equal(summary.props.tabIndex,undefined);assert.equal(summary.props.role,undefined);
});

test('mode changes stay controlled and disabled PDF controls cannot invoke changes',()=>{
 const h=fixture(),select=find(h.render({compact:true,value:'text'}),'select');
 select.props.onChange({target:{value:'original'}});assert.deepEqual(h.calls,['original']);
 const locked=h.render({compact:true,disabled:true,value:'text'}),disabled=find(locked,'select');
 assert.equal(disabled.props.disabled,true);disabled.props.onChange({target:{value:'original'}});assert.deepEqual(h.calls,['original']);
 assert.ok(find(locked,'summary'),'the explanation remains readable while mode changes are disabled');
});

test('default and explicit full modes retain the retry explanation without a disclosure',()=>{
 const h=fixture();
 for(const props of [{},{compact:false,id:'retry-pdf-run',value:'text'}]){
  const tree=h.render(props);assert.equal(find(tree,'details'),undefined);assert.equal(tree.props.className,'pdf-read-mode-control');
  assert.equal(text(find(tree,'label')),'PDF 读取方式');assert.equal(find(tree,'select').props['aria-describedby'],find(tree,'p').props.id);
 }
 assert.match(text(h.render({})),/API 连接发送 PDF 原件；账号连接发送页面图像/);
});

test('English modes and description ids stay independent between composer and retry surfaces',()=>{
 const h=fixture('en'),main=h.render({compact:true,id:'main',value:'text'}),retry=h.render({id:'retry'});
 assert.equal(find(main,'select').props['aria-label'],'PDF reading mode');
 assert.equal(find(main,'summary').props['aria-label'],'About PDF reading modes');assert.equal(text(find(main,'summary')),'Details');
 assert.match(text(find(main,'details')),/No images or OCR/);assert.match(text(find(main,'details')),/actual coverage/);
 assert.deepEqual(nodes(main).filter(node=>node.type==='option').map(text),['Send original','Read text']);
 assert.equal(find(main,'p').props.id,'main-description');assert.equal(find(retry,'p').props.id,'retry-description');
});

test('ordinary value refresh preserves the native disclosure type, key and focusable summary position',()=>{
 const h=fixture(),before=h.render({compact:true,value:'original'}),after=h.render({compact:true,value:'text'});
 const a=find(before,'details'),b=find(after,'details');assert.equal(a.type,b.type);assert.equal(a.key,b.key);
 assert.equal(find(a,'summary').key,find(b,'summary').key);
 assert.equal(b.props.open,undefined,'React must not force the disclosure closed during a host refresh');
 assert.equal(b.props.onToggle,undefined,'native disclosure owns expansion without a rerender or focus move');
 assert.doesNotMatch(source.slice(source.indexOf('export function PdfReadModeControl'),source.indexOf('function Glyph')),/\.focus\(|setTimeout|setInterval/);
});
