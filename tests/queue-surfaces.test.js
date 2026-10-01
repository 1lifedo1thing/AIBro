'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),React=require('react'),esbuild=require('esbuild');
const source=fs.readFileSync(require.resolve('../app/ui/queue-surfaces.jsx'),'utf8'),css=fs.readFileSync(require.resolve('../app/ui/queue-surfaces.css'),'utf8');
const compiled=esbuild.transformSync(source,{loader:'jsx',format:'cjs'}).code;
const controlsCompiled=esbuild.transformSync(fs.readFileSync(require.resolve('../app/ui/kit-controls.jsx'),'utf8'),{loader:'jsx',format:'cjs'}).code;
const kit=Object.fromEntries(['AlertBanner','Badge','Button','Caption','Card','Select','StatusBadge','TextArea','TextInput'].map(name=>[name,`Kit:${name}`]));
function setup(language='zh'){
 const module={exports:{}},hooks={...React,useRef:()=>({current:null}),useLayoutEffect:()=>{}};
 const document={documentElement:{lang:language},getElementById:()=>true},controls={exports:{}};
 vm.runInNewContext(controlsCompiled,{module:controls,exports:controls.exports,document,require:id=>id==='react'?hooks:id.endsWith('.css')?css:kit});
 vm.runInNewContext(compiled,{module,exports:module.exports,document,require:id=>id==='react'?hooks:id.endsWith('.css')?css:id.endsWith('kit-controls.jsx')?controls.exports:kit});
 const calls=[],callbacks=Object.fromEntries(['onEdit','onDraft','onCancel','onCommand','onSend','onQuery','onPdfReadMode','onMutate','onBrowse','onCheck','onReload','onConfirmReload','onCancelReload'].map(name=>[name,value=>calls.push([name,value])]));
 return {calls,render:props=>expand(module.exports.QueueSurface({conversationId:'c',items:[{id:'a',goal:'原始排队文字'}],summaries:{a:{materials:[],skills:[],issues:[]}},contextView:{materials:[],skills:[],issues:[],canSend:true},catalog:{materials:[],skills:[],projects:[]},...callbacks,...props}))};
}
function expand(node){if(!React.isValidElement(node))return node;if(typeof node.type==='function')return expand(node.type(node.props));return React.cloneElement(node,{},...React.Children.toArray(node.props.children).map(expand));}
function nodes(node){if(!React.isValidElement(node))return[];return[node,...React.Children.toArray(node.props.children).flatMap(nodes)];}
function text(node){if(typeof node==='string'||typeof node==='number')return String(node);if(!React.isValidElement(node))return'';return[node.type==='Kit:AlertBanner'?`${node.props.title} ${node.props.description}`:'',...React.Children.toArray(node.props.children).map(text)].join(' ');}
const button=(tree,id)=>nodes(tree).find(node=>node.type==='Kit:Button'&&node.props.id===id);
const event=(key,extra={})=>({key,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra});
test('queue editor uses real imported Kit primitives and offers independent material and Skill sections',()=>{
 const h=setup(),tree=h.render({editingId:'a',draft:'editable'});for(const name of ['Card','TextArea','TextInput','Button'])assert.ok(nodes(tree).some(node=>node.type===`Kit:${name}`),name);
 assert.match(text(tree),/资料与本机引用|Skills 快照/);assert.match(text(tree),/不改变输入框草稿或会话默认/);assert.match(text(tree),/在本机读取文件确认版本/);assert.match(text(tree),/正文不保存在编辑草稿中/);assert.equal(nodes(tree).find(node=>node.type==='Kit:TextArea').props.maxLength,undefined);assert.doesNotMatch(source,/4000|maxLength/);
});
test('IME Enter and Escape are ignored; command Enter saves, plain Enter and Tab retain native behavior',()=>{
 const h=setup(),tree=h.render({editingId:'a',draft:'可保存'}),editor=nodes(tree).find(node=>node.props.className==='queue-edit');
 for(const key of ['Enter','Escape']){const e=event(key,{metaKey:true,nativeEvent:{isComposing:true}});editor.props.onKeyDown(e);assert.equal(e.prevented,undefined);}
 editor.props.onCompositionStart();editor.props.onKeyDown(event('Escape'));editor.props.onCompositionEnd();assert.deepEqual(h.calls,[]);
 for(const key of ['Enter','Tab']){const e=event(key);editor.props.onKeyDown(e);assert.equal(e.prevented,undefined);}
 const save=event('Enter',{metaKey:true});editor.props.onKeyDown(save);assert.equal(save.prevented,true);assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])),['onCommand',{action:'edit',id:'a'}]);
 editor.props.onKeyDown(event('Escape'));assert.equal(h.calls[1][0],'onCancel');
});
test('busy editor locks save, context actions, reorder and explicit send without fake completion',()=>{
 const h=setup(),row={key:'m1',title:'file',status:'changed',refresh:{action:'refresh-material',key:'m1'},remove:{action:'remove-material',key:'m1'}},tree=h.render({editingId:'a',draft:'text',busy:true,canSend:true,contextView:{materials:[row],skills:[],issues:[{}]}});
 assert.equal(button(tree,'queue-save-a').props.disabled,true);assert.equal(button(tree,'queueSendNext').props.disabled,true);assert.equal(nodes(tree).find(node=>node.props['data-queue-id']==='a').props.draggable,false);
 for(const control of nodes(tree).filter(node=>node.type==='Kit:Button'&&node.props['aria-label']?.match(/更新引用|移除/)))control.props.onClick();button(tree,'queueSendNext').props.onClick();assert.deepEqual(h.calls,[]);
 assert.equal(nodes(tree).some(node=>node.props.role==='progressbar'),false);assert.doesNotMatch(source,/setTimeout|setInterval|localStorage|fetch\(/);
});
test('frozen Skill can be explicitly refreshed or removed without exposing instruction bodies',()=>{
 const h=setup(),refresh={action:'refresh-skill',id:'s'},remove={action:'remove-skill',id:'s'},tree=h.render({editingId:'a',draft:'text',items:[{id:'a',goal:'text',skillSnapshot:[{id:'s',instructions:'SECRET_BODY'}]}],contextView:{materials:[],skills:[{key:'s',id:'s',title:'Skill name',status:'changed',reason:'保持旧快照',refresh,remove}],issues:[]}});
 assert.match(text(tree),/更新到当前版本/);assert.match(text(tree),/保持旧快照/);assert.doesNotMatch(text(tree),/SECRET_BODY/);
 const update=nodes(tree).find(node=>node.type==='Kit:Button'&&text(node).includes('更新到当前版本'));update.props.onClick();assert.equal(h.calls[0][1],refresh);
});
test('opaque redacted material rows keep removal usable without exposing old reference titles',()=>{
 const h=setup(),tree=h.render({editingId:'a',draft:'text',items:[{id:'a',goal:'text',fileReferences:[{title:'PRIVATE_OLD_TITLE',path:'private/path'}]}],contextView:{materials:[{key:'material-3',title:'私密来源',status:'private',reason:'不可用于发送',remove:{action:'remove-material',key:'material-3'},refresh:null}],skills:[],issues:[{}]}});
 assert.match(text(tree),/私密来源/);assert.doesNotMatch(text(tree),/PRIVATE_OLD_TITLE|private\/path/);const remove=nodes(tree).find(node=>node.type==='Kit:Button'&&node.props['aria-label']==='移除：私密来源');remove.props.onClick();assert.deepEqual(h.calls,[['onMutate',{action:'remove-material',key:'material-3'}]]);
});
test('local browsing and pagination use actual commands; unsupported formats cannot be added',()=>{
 const h=setup(),add={action:'add-material',type:'local',ref:{path:'src/a.js'}},tree=h.render({editingId:'a',draft:'text',catalog:{materials:[],skills:[],projects:[{key:'p',id:'p',title:'Project'}]},local:{projectId:'p',path:'src',entries:[{key:'f',title:'a.js',path:'src/a.js',directory:false,add},{key:'x',title:'photo.raw',path:'src/photo.raw',directory:false,disabled:true,add:{}}],nextOffset:20}});
 nodes(tree).find(node=>node.type==='Kit:Button'&&node.props['aria-label']==='添加文件：a.js').props.onClick();assert.equal(h.calls[0][1],add);
 const blocked=nodes(tree).find(node=>node.type==='Kit:Button'&&node.props['aria-label']==='添加文件：photo.raw');assert.equal(blocked.props.disabled,true);blocked.props.onClick();assert.equal(h.calls.length,1);
 nodes(tree).find(node=>node.type==='Kit:Button'&&text(node).includes('加载更多文件')).props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])),['onBrowse',{projectId:'p',path:'src',offset:20}]);
});
test('reload is a separate confirmation; errors use polite status and English controls remain available',()=>{
 const h=setup('en'),tree=h.render({editingId:'a',draft:'text',confirmReload:true,error:'Disk failed',notice:'Retained'});assert.match(text(tree),/Reload the saved version\?/);assert.ok(button(tree,'queue-confirm-reload-a'));assert.equal(nodes(tree).some(node=>node.props.role==='alert'),false);assert.equal(nodes(tree).filter(node=>node.props.role==='status').length,1);
 const editor=nodes(tree).find(node=>node.props.className==='queue-edit');editor.props.onKeyDown(event('Escape'));assert.equal(h.calls[0][0],'onCancelReload');assert.equal(text(button(tree,'queue-save-a')).trim(),'Save changes');
 assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/var\(--panel\)/);assert.match(css,/max-width:500px/);
});

test('queued PDF selector uses actual Kit Select with native keyboard control and locks changes while busy',()=>{
 const h=setup(),tree=h.render({editingId:'a',draft:'Read PDF',pdfReadMode:'text'}),select=nodes(tree).find(node=>node.type==='select'),presentation=nodes(tree).find(node=>node.type==='Kit:Select');
 assert.equal(select.props['aria-label'],'本条消息的 PDF 读取方式');assert.equal(select.props.id,'queue-pdf-mode-a');assert.equal(select.props.value,'text');assert.deepEqual(JSON.parse(JSON.stringify(presentation.props.options)),[{value:'original',label:'原件'},{value:'text',label:'读取文字'}]);assert.match(text(tree),/不包含页面图片与排版/);
 select.props.onChange({target:{value:'original'}});assert.deepEqual(h.calls,[['onPdfReadMode','original']]);
 const busy=h.render({editingId:'a',draft:'Read PDF',busy:true});const disabled=nodes(busy).find(node=>node.type==='select');assert.equal(disabled.props.disabled,true);disabled.props.onChange({target:{value:'text'}});assert.equal(h.calls.length,1);
});

test('collapsed queued material rows display their frozen PDF mode with legacy original fallback',()=>{
 const h=setup(),base={summaries:{a:{materials:[{id:'pdf'}],skills:[],issues:[]}}};
 assert.match(text(h.render(base)),/PDF：原件/);assert.match(text(h.render({...base,items:[{id:'a',goal:'PDF',pdfReadMode:'text'}]})),/PDF：读取文字/);
 assert.doesNotMatch(text(h.render({items:[{id:'a',goal:'No materials',pdfReadMode:'text'}]})),/PDF：/);
 assert.match(text(setup('en').render({...base,items:[{id:'a',goal:'PDF',pdfReadMode:'text'}]})),/PDF: extracted text/);
});
