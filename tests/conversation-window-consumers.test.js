'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sources=Object.fromEntries(['find-in-conversation','message-rail'].map(name=>[name,fs.readFileSync(path.join(__dirname,'../app',name+'.js'),'utf8')]));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(moduleName){
 const byId=new Map(),timers=new Map(),mutations=[],intersections=[];let timerId=0;const reveals=[];
 class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.nodeType=1;this.childNodes=[];this.dataset={};this.style={};this.attributes={};this.listeners={};this.className='';this.hidden=false;this.value='';this.text='';this.open=false;this.offsetHeight=20;this.classList={contains:name=>this.className.split(' ').includes(name)};}
  get children(){return this.childNodes.filter(node=>node.nodeType===1)}
  get isConnected(){return this===document.body||!!this.parentElement?.isConnected}
  get textContent(){return this.text+this.childNodes.map(node=>node.textContent??node.nodeValue).join('')}
  set textContent(value){this.text=String(value);this.replaceChildren()}
  set id(value){this._id=value;byId.set(value,this)}get id(){return this._id}
  append(...nodes){for(const node of nodes){node.remove?.();node.parentElement=this;this.childNodes.push(node)}}
  replaceChildren(...nodes){for(const node of this.childNodes)node.parentElement=null;this.childNodes=[];this.append(...nodes)}
  remove(){if(this.parentElement){this.parentElement.childNodes=this.parentElement.childNodes.filter(node=>node!==this);this.parentElement=null}}
  setAttribute(name,value){this.attributes[name]=String(value)}
  getAttribute(name){return this.attributes[name]??null}
  addEventListener(name,handler){(this.listeners[name]||=[]).push(handler)}
  removeEventListener(name,handler){this.listeners[name]=(this.listeners[name]||[]).filter(value=>value!==handler)}
  fire(name,fields={}){const event={target:this,preventDefault(){this.defaultPrevented=true},...fields};for(const handler of this.listeners[name]||[])handler(event);return event}
  focus(){document.activeElement=this;this.onfocus?.()}select(){this.selected=true}
  matches(selector){if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector==='.message-wrap[data-message-id]')return this.classList.contains('message-wrap')&&!!this.dataset.messageId;if(selector==='[data-rail-preview]')return Object.hasOwn(this.dataset,'railPreview');if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));return selector.split(',').some(name=>this.tagName===name.toUpperCase())}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches?.(selector))return node;return null}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  querySelectorAll(selector){const out=[];for(const node of this.children){if(node.matches(selector))out.push(node);out.push(...node.querySelectorAll(selector))}return out}
  getBoundingClientRect(){return {top:20,left:0,width:10,height:300,bottom:320,right:10}}
  scrollIntoView(){reveals.push(this)}
 }
 class TextNode {constructor(value){this.nodeType=3;this.nodeValue=value}get isConnected(){return !!this.parentElement?.isConnected}get textContent(){return this.nodeValue}}
 const document={createElement:tag=>new Element(tag),querySelector:selector=>selector.startsWith('#')?byId.get(selector.slice(1)):document.body.querySelector(selector),createRange:()=>({setStart(node,start){this.node=node;this.start=start},setEnd(node,end){this.end=end}}),createTreeWalker(container,filter,options){const texts=[];const visit=node=>{if(node.nodeType===3){if(!options||options.acceptNode(node)===1)texts.push(node)}else for(const child of node.childNodes||[])visit(child)};visit(container);let at=0;return{nextNode(){this.currentNode=texts[at++];return this.currentNode}}}};
 document.body=new Element('body');const pane=new Element();pane.className='conversation-pane';document.body.append(pane);const list=new Element();list.id='messageList';list.dataset.conversationId='conversation-a';pane.append(list);
 for(const id of ['findBar','findInput','findCount','findPrev','findNext','findClose']){const node=new Element(id==='findInput'?'input':'div');node.id=id;document.body.append(node)}byId.get('findBar').hidden=true;
 const state={controller:null,messages:[]};
 const context=vm.createContext({document,NodeFilter:{SHOW_TEXT:4,FILTER_ACCEPT:1,FILTER_REJECT:2},AbortController,Promise,Map,Set,console,
  setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id),
  MutationObserver:class{constructor(callback){this.callback=callback;mutations.push(this)}observe(host){this.host=host;this.active=true}disconnect(){this.active=false}},
  IntersectionObserver:class{constructor(callback){this.callback=callback;this.watched=new Set();intersections.push(this)}observe(node){this.watched.add(node)}unobserve(node){this.watched.delete(node)}disconnect(){this.watched.clear()}},
  CSS:{highlights:new Map()},Highlight:class extends Set{},
  ConversationWindow:{active:()=>state.controller},ConversationReading:{reveal:node=>{reveals.push(node);return true}},WorkstationI18n:{getLanguage:()=> 'zh'}});
 vm.runInContext(sources[moduleName],context);const api=moduleName==='message-rail'?context.MessageRail:context.FindInConversation;
 const row=(id,text)=>{const node=new Element();node.className='message-wrap';node.dataset.messageId=id;if(text!==undefined)node.append(new TextNode(text));list.append(node);return node};
 const mutate=()=>mutations.filter(observer=>observer.active).forEach(observer=>observer.callback([]));
 const runTimers=()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn())};
 const jobs=[],ensured=[];
 function controller(){const value={isWindowed:()=>true,entries:()=>state.messages,ensure(id){ensured.push(id);let node=list.children.find(row=>row.dataset.messageId===id);if(!node)node=row(id);return node},ensureHit(hit){const node=this.ensure(hit.messageId);node.replaceChildren(new TextNode(hit.text));return{node:node.childNodes[0],start:hit.start,end:hit.end}},searchRows(query,options){return new Promise((resolve,reject)=>jobs.push({query,options,resolve,reject}))}};state.controller=value;return value}
 api.init(moduleName==='message-rail'?{getMessages:()=>state.messages}:{getRoot:()=>list});
 return{api,list,pane,document,byId,row,state,jobs,ensured,controller,mutate,runTimers,reveals,intersections,context,Element,TextNode};
}
const hit=(id,text='目标 source')=>({messageId:id,path:[0],start:0,end:2,text});
test('windowed Find counts full history but materializes only an explicitly selected result',async()=>{
 const h=harness('find-in-conversation');h.controller();h.row('first');h.row('last');h.api.open('目标');await flush();
 assert.equal(h.api.stats().searching,true);assert.equal(h.byId.get('findNext').disabled,true);assert.match(h.byId.get('findCount').textContent,/搜索全部对话/);
 h.jobs[0].resolve({hits:[hit('first'),hit('last')],capped:true,total:1000});await flush();
 assert.equal(h.api.stats().hits,2);assert.deepEqual(h.ensured,['first']);assert.match(h.byId.get('findCount').textContent,/前 800/);assert.equal(h.document.activeElement.id,'findInput');
 h.api.next();assert.deepEqual(h.ensured,['first','last']);assert.equal(h.api.stats().index,1);assert.equal(h.document.activeElement.id,'findInput');
 h.mutate();h.runTimers();await flush();assert.equal(h.jobs.length,1,'mount mutation must not trigger full-history scan');assert.equal(h.ensured.length,2,'painting must not ensure every hit');
});
test('new query aborts old search and ignores late results, progress, and errors',async()=>{
 const h=harness('find-in-conversation');h.controller();h.api.open('old');await flush();h.byId.get('findInput').value='new';h.byId.get('findInput').fire('input');await flush();
 assert.equal(h.jobs[0].options.signal.aborted,true);h.jobs[1].resolve({hits:[hit('new')],capped:false});await flush();
 h.jobs[0].options.onProgress({processed:99,total:100});h.jobs[0].resolve({hits:[hit('old')],capped:true});await flush();
 assert.equal(h.api.stats().query,'new');assert.equal(h.api.stats().hits,1);assert.equal(h.api.stats().capped,false);assert.deepEqual(h.ensured,['new']);assert.doesNotMatch(h.byId.get('findCount').textContent,/99/);
});
test('closing or changing conversations cannot let a stale search navigate or repaint',async()=>{
 const h=harness('find-in-conversation');h.controller();h.api.open('same');await flush();h.api.close();h.jobs[0].resolve({hits:[hit('gone')]});await flush();assert.deepEqual(h.ensured,[]);assert.equal(h.api.stats().open,false);
 h.api.open('same');await flush();h.list.dataset.conversationId='conversation-b';h.mutate();assert.equal(h.jobs[1].options.signal.aborted,true);h.jobs[1].resolve({hits:[hit('wrong-conversation')]});await flush();assert.deepEqual(h.ensured,[]);
 h.runTimers();await flush();h.jobs[2].resolve({hits:[hit('right-conversation')]});await flush();assert.equal(h.api.stats().hits,1);assert.deepEqual(h.ensured,[],'background conversation refresh preserves reading position');h.api.next();assert.deepEqual(h.ensured,['right-conversation']);
});
test('real content invalidation refreshes full search while retaining selected identity without scroll',async()=>{
 const h=harness('find-in-conversation');h.controller();h.api.open('目标');await flush();h.jobs[0].resolve({hits:[hit('a'),hit('b')]});await flush();h.api.next();const revealed=h.reveals.length;
 h.list.fire('conversation-window-content');h.runTimers();await flush();h.jobs[1].resolve({hits:[hit('before'),hit('a'),hit('b')]});await flush();assert.equal(h.api.stats().index,2);assert.equal(h.reveals.length,revealed);assert.deepEqual(h.ensured,['a','b']);
});
test('IME cancels old scanning, does not overwrite draft, and commits a single new query',async()=>{
 const h=harness('find-in-conversation');h.controller();h.api.open('before');await flush();const field=h.byId.get('findInput');field.fire('compositionstart');field.value='正在组合';field.fire('input',{isComposing:true});field.fire('keydown',{key:'Enter',isComposing:true});h.jobs[0].resolve({hits:[hit('old')]});await flush();assert.equal(field.value,'正在组合');assert.deepEqual(h.ensured,[]);
 field.fire('compositionend');field.fire('input');await flush();assert.equal(h.jobs.length,2);assert.equal(h.jobs[1].query,'正在组合');h.jobs[1].resolve({hits:[hit('committed')]});await flush();assert.equal(h.api.stats().hits,1);
});
test('window-to-full-mode transition invalidates async search and returns to actual DOM scope',async()=>{
 const h=harness('find-in-conversation'),controller=h.controller();h.row('visible','目标 visible');h.api.open('目标');await flush();controller.isWindowed=()=>false;h.list.fire('conversation-window-content');h.runTimers();await flush();assert.equal(h.api.stats().hits,1);assert.equal(h.api.stats().searching,false);h.jobs[0].resolve({hits:[hit('stale')]});await flush();assert.deepEqual(h.ensured,[]);assert.equal(h.api.stats().hits,1);
});
test('empty queries and a synchronously closed find bar never start a full-history scan',async()=>{
 const h=harness('find-in-conversation');h.controller();h.api.open('');await flush();assert.equal(h.jobs.length,0);h.api.open('cancel before microtask');h.api.close();await flush();assert.equal(h.jobs.length,0);assert.deepEqual(h.ensured,[]);
});
test('content invalidation blocks stale navigation during debounce and canceled progress stays hidden',async()=>{
 const h=harness('find-in-conversation');h.controller();h.api.open('目标');await flush();h.jobs[0].resolve({hits:[hit('a'),hit('b')]});await flush();h.list.fire('conversation-window-content');assert.equal(h.byId.get('findNext').disabled,true);h.api.next();assert.deepEqual(h.ensured,['a']);h.runTimers();await flush();h.jobs[1].options.onProgress({done:8,total:10});assert.match(h.byId.get('findCount').textContent,/8 \/ 10/);h.api.close();h.jobs[1].options.onProgress({done:9,total:10});h.jobs[1].reject(new Error('old scan failed'));await flush();assert.equal(h.api.stats().error,'');assert.equal(h.api.stats().open,false);
});
test('search failure is actionable and entering the same query retries instead of retaining an empty success',async()=>{
 const h=harness('find-in-conversation');h.controller();h.api.open('目标');await flush();h.jobs[0].reject(new Error('renderer failed'));await flush();assert.equal(h.api.stats().searching,false);assert.match(h.api.stats().error,/查找未完成/);assert.equal(h.byId.get('findNext').disabled,true);h.byId.get('findInput').fire('input');await flush();assert.equal(h.jobs.length,2);h.jobs[1].resolve({hits:[hit('retry')]});await flush();assert.equal(h.api.stats().error,'');assert.deepEqual(h.ensured,['retry']);
});
test('rail summaries use message IDs, so a deleted model row cannot shift visible previews',()=>{
 const h=harness('message-rail');h.state.messages=[{id:'deleted',role:'user',text:'deleted wrong',deletedAt:1},{id:'a',role:'agent',text:'real A'},{id:'b',role:'user',text:'real B'}];h.row('a');h.row('b');h.api.sync();
 const ticks=h.pane.querySelectorAll('.message-rail-tick');assert.equal(ticks.length,2);ticks[1].onmouseenter();assert.match(h.pane.querySelector('.message-rail-preview').textContent,/real B/);assert.doesNotMatch(h.pane.querySelector('.message-rail-preview').textContent,/deleted|real A/);
});
test('rail ensures the exact offscreen ID and retains tick focus across slot replacement',()=>{
 const h=harness('message-rail');const controller=h.controller();h.state.messages=[{id:'a',text:'A'},{id:'b',text:'B'}];h.row('a');const old=h.row('b');h.api.sync();const tick=h.pane.querySelectorAll('.message-rail-tick')[1];tick.focus();tick.onclick();assert.deepEqual(h.ensured,['b']);assert.equal(h.document.activeElement,tick);
 old.remove();h.row('b','mounted B');h.api.sync();assert.equal(h.pane.querySelectorAll('.message-rail-tick')[1],tick);assert.equal(h.document.activeElement,tick);controller.entries=()=>[{id:'a',text:'A'},{id:'b',text:'new B'}];tick.onmouseenter();assert.match(h.pane.querySelector('.message-rail-preview').textContent,/new B/);
});
test('rail ignores retired observer nodes and maps current visibility by stable ID',()=>{
 const h=harness('message-rail');h.row('a');const retired=h.row('b');h.api.sync();const observer=h.intersections[0];observer.callback([{target:retired,isIntersecting:true}]);assert.equal(h.api.stats().active,1);retired.remove();const current=h.row('b');h.api.sync();assert.equal(h.api.stats().active,0);observer.callback([{target:retired,isIntersecting:true}]);assert.equal(h.api.stats().active,0);observer.callback([{target:current,isIntersecting:true}]);assert.equal(h.api.stats().active,1);
});
test('rail releases all retired rows and does not reveal a placeholder when its controller cannot ensure it',()=>{
 const h=harness('message-rail'),controller=h.controller();h.row('a');h.api.sync();const observer=h.intersections[0];assert.equal(observer.watched.size,1);controller.ensure=()=>null;h.pane.querySelector('.message-rail-tick').onclick();assert.equal(h.reveals.length,0);h.list.replaceChildren();h.api.sync();assert.equal(observer.watched.size,0);assert.equal(h.api.stats().messages,0);assert.equal(h.pane.querySelector('#messageRail').hidden,true);
});
