'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app/conversation-window.js'),'utf8');
// Lifecycle adapter only. These tests exercise the production owner and search
// index; layout, actual media and native IME remain native acceptance concerns.
function fixture(count=4){
 const frames=new Map(),timers=[],events=[],rendered=[],disposals=[],citationDisposals=[],mutations=[];let nextFrame=0,walks=0,geometryReads=0;
 const doc={activeElement:null,listeners:{},getSelection:()=>({isCollapsed:true}),addEventListener(type,fn){(this.listeners[type]||=[]).push(fn)},removeEventListener(){},fire(type){for(const fn of this.listeners[type]||[])fn()}};
 class Text {constructor(text){this.nodeType=3;this.nodeValue=text;this.ownerDocument=doc}get parentNode(){return this.parentElement}get textContent(){return this.nodeValue}get length(){return this.nodeValue.length}}
 class Element {
  constructor(tag='div'){this.nodeType=1;this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.childNodes=[];this.dataset={};this.style={};this.listeners={};this.attrs={};this.className='';this.clientWidth=760;this.clientHeight=640;this.scrollTop=0;this.open=false}
  get parentNode(){return this.parentElement}get children(){return this.childNodes.filter(n=>n.nodeType===1)}get firstElementChild(){return this.children[0]||null}get nextElementSibling(){const all=this.parentElement?.children||[];return all[all.indexOf(this)+1]||null}get isConnected(){return this===doc.body||!!this.parentElement?.isConnected}get textContent(){return this.childNodes.map(n=>n.textContent).join('')}get scrollHeight(){return this.children.length*400}
  append(...nodes){for(const n of nodes){if(n.fragment){this.append(...n.childNodes.slice());continue}n.remove?.();n.parentElement=this;this.childNodes.push(n)}}
  insertBefore(n,target){n.remove?.();const at=this.childNodes.indexOf(target);n.parentElement=this;at<0?this.childNodes.push(n):this.childNodes.splice(at,0,n)}
  replaceChildren(...nodes){for(const n of this.childNodes)n.parentElement=null;this.childNodes=[];this.append(...nodes)}
  remove(){if(this.parentElement){this.parentElement.childNodes=this.parentElement.childNodes.filter(n=>n!==this);this.parentElement=null}}
  replaceWith(n){const p=this.parentElement;if(!p)return;const at=p.childNodes.indexOf(this);n.remove?.();p.childNodes[at]=n;n.parentElement=p;this.parentElement=null}
  before(n){this.parentElement?.insertBefore(n,this)}contains(n){for(;n;n=n.parentElement)if(n===this)return true;return false}
  setAttribute(k,v){this.attrs[k]=String(v)}getAttribute(k){return this.attrs[k]??null}hasAttribute(k){return Object.hasOwn(this.attrs,k)||(k==='data-window-placeholder'&&Object.hasOwn(this.dataset,'windowPlaceholder'))}
  addEventListener(k,fn){(this.listeners[k]||=[]).push(fn)}removeEventListener(k,fn){this.listeners[k]=(this.listeners[k]||[]).filter(x=>x!==fn)}dispatchEvent(e){events.push(e);for(const fn of this.listeners[e.type]||[])fn(e)}
  matches(selector){return selector.split(',').some(s=>{s=s.trim();if(s==='[data-message-id]')return !!this.dataset.messageId;if(s==='[data-halaska-root]')return !!this.dataset.halaskaRoot;if(s==='[data-citation-deferred]')return this.hasAttribute('data-citation-deferred');if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));return this.tagName===s.toUpperCase()})}
  closest(selector){for(let n=this;n;n=n.parentElement)if(n.matches?.(selector))return n;return null}querySelectorAll(selector){const out=[];for(const n of this.children){if(n.matches(selector))out.push(n);out.push(...n.querySelectorAll(selector))}return out}querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  getBoundingClientRect(){geometryReads++;const index=this.dataset.messageId?list.children.indexOf(this):-1,top=index<0?0:index*400-list.scrollTop,height=index<0?640:400;return {top,bottom:top+height,height,width:760}}scrollTo({top}){this.scrollTop=top}focus(){doc.activeElement=this}
 }
 doc.body=new Element('body');doc.createElement=tag=>new Element(tag);doc.createDocumentFragment=()=>Object.assign(new Element(),{fragment:true});
 doc.createTreeWalker=(node,_,options)=>{walks++;const out=[];function visit(n){if(n.nodeType===3){if(!options||options.acceptNode(n)===1)out.push(n)}else n.childNodes.forEach(visit)}visit(node);let at=0;return {nextNode:()=>out[at++]||null}};
 const list=new Element();doc.body.append(list);const state={messages:Array.from({length:count},(_,i)=>({id:'m'+i,text:'body '+i,run:{status:'completed'}})),context:{locale:'zh',access:true},conversationId:'chat'};
 const root={document:doc,DOMException,Promise,Map,Set,console,getComputedStyle:()=>({marginTop:'8',marginBottom:'28'}),CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail}},requestAnimationFrame:fn=>{const id=++nextFrame;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id),setTimeout:fn=>timers.push(fn),AnswerFeedback:{unmount:n=>disposals.push(n)},CitationEvidence:{discard:n=>citationDisposals.push(n)},MutationObserver:class{constructor(fn){this.callback=fn;mutations.push(this)}observe(){}takeRecords(){}disconnect(){}},WorkstationI18n:{getLanguage:()=>state.context.locale}};
 root.window=root;doc.defaultView=root;vm.runInNewContext(source,root);
 const render=(message,holder,options)=>{rendered.push({id:message.id,search:!!options.search});const node=new Element();node.dataset.messageId=message.id;node.append(new Text(state.context.access?[message.text,message.run.status,state.context.locale].join(' '):'unavailable'));holder.append(node)};
 const defaults=()=>({id:state.conversationId,messages:state.messages,render,rowVersion:m=>JSON.stringify(m),contextVersion:JSON.stringify(state.context)});
 const set=(options={})=>root.ConversationWindow.render(list,{...defaults(),...options});
 const drain=()=>{let rounds=0;while(frames.size&&rounds++<5){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn())}};
 const tick=async()=>{const pending=timers.splice(0);pending.forEach(fn=>fn());await Promise.resolve()};
 const settle=async(promise)=>{let done=false;promise.finally(()=>{done=true}).catch(()=>{});for(let i=0;i<1000&&!done;i++)await tick();assert.ok(done,'synthetic async work exceeded tick budget');return promise};
 const controller=set();drain();return {root,doc,list,state,controller,set,drain,tick,settle,rendered,events,disposals,citationDisposals,mutations,Element,Text,walks:()=>walks,geometryReads:()=>geometryReads,node:id=>list.children.find(n=>n.dataset.messageId===id)};
}

test('unchanged immutable snapshots retain every short-history node and search index without content events',async()=>{
 const h=fixture(),nodes=h.list.children.slice();await h.controller.searchRows('body');const before={renders:h.rendered.length,walks:h.walks(),events:h.events.length,index:h.controller.inspect().indexCharacters,revision:h.controller.inspect().revision};
 for(let i=0;i<10;i++){h.state.messages=h.state.messages.map(m=>structuredClone(m));h.set();h.drain()}
 assert.deepEqual(h.list.children,nodes);assert.equal(h.rendered.length,before.renders);assert.equal(h.events.length,before.events);assert.equal(h.controller.inspect().revision,before.revision);assert.equal(h.controller.inspect().indexCharacters,before.index);
 await h.controller.searchRows('completed');assert.equal(h.walks(),before.walks);
});
test('in-place message and nested run changes invalidate only their row and its search text',async()=>{
 const h=fixture(),nodes=h.list.children.slice();await h.controller.searchRows('body');const before=h.walks();h.state.messages[1].text='new answer';h.state.messages[2].run.status='failed';h.set();
 assert.equal(h.node('m0'),nodes[0]);assert.notEqual(h.node('m1'),nodes[1]);assert.notEqual(h.node('m2'),nodes[2]);assert.equal(h.node('m3'),nodes[3]);assert.equal(h.rendered.length,6);
 assert.equal((await h.controller.searchRows('new answer')).hits.length,1);assert.equal(h.walks()-before,2);assert.equal((await h.controller.searchRows('failed')).hits.length,1);assert.equal((await h.controller.searchRows('body 1')).hits.length,0);
});
test('shared permission and locale snapshots invalidate all mounted content and indexes',async()=>{
 const h=fixture(),nodes=h.list.children.slice();await h.controller.searchRows('body');h.state.context.access=false;h.set();assert.ok(h.list.children.every((n,i)=>n!==nodes[i]));assert.equal((await h.controller.searchRows('body')).hits.length,0);assert.equal((await h.controller.searchRows('unavailable')).hits.length,4);
 h.state.context.access=true;h.state.context.locale='en';h.set();assert.equal((await h.controller.searchRows(' en')).hits.length,4);
});
test('legacy callers and mutable or failed version providers conservatively refresh',()=>{
 for(const options of [{rowVersion:undefined},{contextVersion:undefined},{contextVersion:{}},{rowVersion:m=>m},{rowVersion:()=>{throw Error('snapshot unavailable')}},{rowVersion:()=>NaN}]){const h=fixture();h.set(options);const previous=h.node('m0');h.state.messages[0].text='changed in place';h.set(options);assert.notEqual(h.node('m0'),previous);assert.match(h.node('m0').textContent,/changed in place/)}
});
test('reorder moves existing nodes, removal drops its index, and append renders only new content',async()=>{
 const h=fixture(),nodes=h.list.children.slice();await h.controller.searchRows('body');const walks=h.walks();h.state.messages=[h.state.messages[2],h.state.messages[0],{id:'new',text:'new body',run:{status:'completed'}}];h.set();
 assert.equal(h.list.children[0],nodes[2]);assert.equal(h.list.children[1],nodes[0]);assert.equal(h.rendered.length,5);assert.equal(nodes[1].isConnected,false);assert.equal(nodes[3].isConnected,false);
 const result=await h.controller.searchRows('body');assert.deepEqual(Array.from(result.hits,h=>h.messageId),['m2','m0','new']);assert.equal(h.walks()-walks,1);
});
test('conversation replacement releases all old DOM and indexes even when message IDs and versions repeat',async()=>{
 const h=fixture(),old=h.list.children.slice();await h.controller.searchRows('body');h.state.conversationId='replacement';h.set();assert.equal(h.controller.inspect().indexCharacters,0);assert.ok(old.every(n=>!n.isConnected));assert.ok(old.every(n=>h.disposals.includes(n)));assert.equal(h.rendered.length,8);
});
test('unchanged refresh does not cancel a long async search; real change does',async()=>{
 const h=fixture(90);const stable=h.controller.searchRows('body');h.set();assert.equal((await h.settle(stable)).hits.length,90);
 const pending=h.controller.searchRows('body');const rejection=assert.rejects(pending,{name:'AbortError'});h.state.messages[89].text='different';h.set();await h.settle(rejection);assert.equal(h.doc.body.querySelector('.conversation-search-scratch'),null);
});
test('unchanged refresh keeps full-reading progress alive instead of restarting its batches',async()=>{
 const h=fixture(90);const pending=h.controller.setFull(true);await h.tick();const rendered=h.rendered.length;h.set();await h.settle(pending);assert.equal(h.controller.inspect().loading,false);assert.equal(h.controller.inspect().mounted,90);assert.equal(h.rendered.length-rendered,90-rendered);
});
test('stream notification adopts live DOM without rerendering history, then settles only that row',async()=>{
 const h=fixture(),old=h.list.children.slice();await h.controller.searchRows('body');h.state.messages[3].text='streamed answer';const live=new h.Element();live.dataset.messageId='m3';live.append(new h.Text('streamed answer'));old[3].replaceWith(live);h.controller.changed('m3',h.state.messages[3]);h.drain();assert.equal(h.rendered.length,4);assert.equal(h.node('m3'),live);
 h.set();assert.equal(h.rendered.length,5);assert.equal(h.node('m0'),old[0]);assert.equal((await h.controller.searchRows('streamed answer')).hits.length,1);
});
test('deferred dirty rows survive a no-op refresh while active input remains pinned',()=>{
 const h=fixture(),row=h.node('m0'),input=new h.Element('textarea');row.append(input);input.focus();h.state.messages[0].text='pending render';h.set();assert.equal(h.node('m0'),row);h.set();assert.equal(h.node('m0'),row);h.doc.activeElement=null;h.drain();assert.notEqual(h.node('m0'),row);assert.match(h.node('m0').textContent,/pending render/);
});
test('search resolves fresh permissions while a dirty editor row is temporarily pinned',async()=>{
 const h=fixture(1),row=h.node('m0'),input=new h.Element('textarea');await h.controller.searchRows('body');row.append(input);input.focus();h.state.context.access=false;h.set();assert.equal(h.node('m0'),row);assert.equal((await h.controller.searchRows('body')).hits.length,0);assert.equal((await h.controller.searchRows('unavailable')).hits.length,1);h.doc.activeElement=null;h.drain();assert.match(h.node('m0').textContent,/unavailable/);
});
test('DOM mutations and explicit language events still invalidate search without a model refresh',async()=>{
 const h=fixture();await h.controller.searchRows('body');h.node('m1').childNodes[0].nodeValue='local DOM change';h.mutations[0].callback([{target:h.node('m1').childNodes[0]}]);assert.equal((await h.controller.searchRows('local DOM change')).hits.length,1);
 const before=h.controller.inspect().indexCharacters;assert.ok(before>0);h.doc.fire('workstation-language-change');assert.equal(h.controller.inspect().indexCharacters,0);
});
test('removed, refreshed and destroyed rows retire citation section lifecycle before detached toggles',()=>{
 const h=fixture(),first=h.node('m0'),removed=h.node('m1');h.state.messages[0].text='updated';h.state.messages.splice(1,1);h.set();assert.ok(h.citationDisposals.includes(first));assert.ok(h.citationDisposals.includes(removed));const remaining=h.list.children.slice();h.controller.destroy();assert.ok(remaining.every(n=>h.citationDisposals.includes(n)));assert.equal(h.root.ConversationWindow.active(h.list),null);
});
test('collapsed deferred citations remain searchable through explicit scratch rendering and release scratch roots',async()=>{
 const h=fixture(1),calls=[];const render=(message,holder,options)=>{calls.push(options.search);const row=new h.Element();row.dataset.messageId=message.id;row.append(new h.Text(message.text));const details=new h.Element('details');if(options.search)details.append(new h.Text('Deferred source title'));else details.setAttribute('data-citation-deferred','');row.append(details);holder.append(row)};
 h.set({render,contextVersion:'lazy-citations'});const visible=h.node('m0');assert.doesNotMatch(visible.textContent,/Deferred source/);const result=await h.controller.searchRows('Deferred source title');assert.equal(result.hits.length,1);assert.equal(calls.filter(Boolean).length,1);assert.equal(h.node('m0'),visible);assert.doesNotMatch(visible.textContent,/Deferred source/);assert.equal(h.doc.body.querySelector('.conversation-search-scratch'),null);
});
test('revealing a source hit materializes the selected real panel while body hits leave it collapsed',async()=>{
 const h=fixture(1),opened=[];const render=(message,holder,options)=>{const row=new h.Element();row.dataset.messageId=message.id;row.append(new h.Text(message.text));const details=new h.Element('details');if(options.search)details.append(new h.Text('Deferred source title'));else details.setAttribute('data-citation-deferred','');row.append(details);holder.append(row)};
 h.root.CitationEvidence.materializeForSearch=wrapper=>{opened.push(wrapper);const details=wrapper.querySelector('[data-citation-deferred]');details.append(new h.Text('Deferred source title'));details.open=true;delete details.attrs['data-citation-deferred'];return true};h.set({render,contextVersion:'lazy-citations'});
 const body=(await h.controller.searchRows('body')).hits[0];assert.ok(h.controller.ensureHit(body));assert.equal(opened.length,0);const source=(await h.controller.searchRows('Deferred source title')).hits[0];const resolved=h.controller.ensureHit(source);assert.ok(resolved);assert.equal(resolved.node.nodeValue,'Deferred source title');assert.equal(resolved.node.parentElement.open,true);assert.equal(opened.length,1);assert.equal(opened[0],h.node('m0'));
});
test('settled long-history no-op avoids geometry work without losing an already scheduled viewport refresh',()=>{
 const h=fixture(90),before=h.geometryReads(),renders=h.rendered.length;for(let i=0;i<10;i++){h.set();h.drain()}assert.equal(h.geometryReads(),before);assert.equal(h.rendered.length,renders);assert.ok(h.node('m40').hasAttribute('data-window-placeholder'));
 h.list.scrollTop=40*400;h.list.dispatchEvent({type:'scroll'});h.set();h.drain();assert.ok(h.geometryReads()>before);assert.equal(h.node('m40').hasAttribute('data-window-placeholder'),false);
});
