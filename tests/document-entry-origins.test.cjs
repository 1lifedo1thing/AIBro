const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the actual entry controllers without a browser, native data or disk IO.
function harness(module) {
  class Node {
    constructor(tag) { this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.dataset={};this.style={};this.attributes={};this.listeners={};this.hidden=false;this.className='';this.classList={add(){}}; }
    get isConnected() { for(let n=this;n;n=n.parentElement)if(n===doc.body)return true;return false; }
    append(...nodes) { for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);} }
    remove() { if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null; }
    replaceChildren(...nodes) { for(const node of [...this.children])node.remove();this.append(...nodes); }
    setAttribute(name,value) { this.attributes[name]=String(value); }
    getAttribute(name) { return this.attributes[name]??null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type,fn) { (this.listeners[type]||=[]).push(fn); }
    removeEventListener(type,fn) { this.listeners[type]=(this.listeners[type]||[]).filter(f=>f!==fn); }
    contains(target) { for(let n=target;n;n=n.parentElement)if(n===this)return true;return false; }
    closest(selector) { for(let n=this;n;n=n.parentElement)if(selector.startsWith('#')&&n.id===selector.slice(1))return n;return null; }
    getBoundingClientRect() { return {top:10,left:10,right:300,bottom:100,width:290,height:90}; }
    getClientRects() { return [this.getBoundingClientRect()]; }
    querySelectorAll(selector) { const out=[];const walk=n=>{for(const child of n.children){if(selector==='[data-project-file-key]'&&child.dataset.projectFileKey)out.push(child);walk(child);}};walk(this);return out; }
    querySelector() { return null; }
    focus() { doc.activeElement=this; }
  }
  const doc={createElement:tag=>new Node(tag),addEventListener(){},removeEventListener(){},getElementById:()=>null,querySelector:()=>null};
  doc.body=new Node('body');doc.querySelectorAll=selector=>doc.body.querySelectorAll(selector);
  const opens=[],cards=[],state={projects:[{id:'p',localFolder:{id:'folder',name:'Local'}}],notes:[],imports:[]};
  const sources=new Map();
  const context={document:doc,innerWidth:1000,innerHeight:800,setTimeout,clearTimeout,addEventListener(){},removeEventListener(){},MutationObserver:class{observe(){}disconnect(){}},
    CitationEvidence:{access:()=>({kind:'available',available:true}),status:()=>({canOpen:true}),resolveTarget:(_state,target)=>sources.get(target),location:()=>''},
    HalaskaUI:{componentNames:['CitationPeek'],mount(_host,_component,props){const card={props,update(value){this.props=value;},unmount(){}};cards.push(card);return card;}},
    FileContext:{request:async()=>({entries:[{type:'file',path:'docs/local.md',name:'local.md',supported:true}],nextOffset:null})}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../app/'+module+'.js'),'utf8'),context);
  const api=context[module==='source-peek'?'SourcePeek':'ProjectFiles'];
  const hook={state:()=>state,getState:()=>state,open:(...args)=>{opens.push(args);return false;}};
  const handle=api.init(hook);
  return {api,handle,hook,doc,Node,opens,cards,state,sources};
}

test('source popup opens with its original citation anchor even when focus is in the body portal', async()=>{
  const h=harness('source-peek'),messageList=new h.Node('section'),citation=new h.Node('button');messageList.id='messageList';messageList.append(citation);h.doc.body.append(messageList);
  const source={type:'import',id:'pdf',page:4,title:'PDF'},before=JSON.stringify(source);h.sources.set(citation,{source,siblings:[source]});h.api.show(citation);
  const portal=h.doc.body.children.find(n=>n.id==='sourcePeek'),openButton=new h.Node('button');portal.append(openButton);openButton.focus();
  await h.cards.at(-1).props.onOpen();
  const call=h.opens[0];assert.equal(call[0],'import');assert.equal(call[1],'pdf');assert.equal(call[2],4);assert.equal(call[3],source);assert.equal(call[4].anchor,citation);assert.notEqual(call[4].anchor,h.doc.activeElement);
  assert.equal(JSON.stringify(source),before,'Transient DOM origin must never be attached to persisted source evidence');h.handle.destroy();
});

test('source popup captures the document anchor before a delayed open is replaced by another source', async()=>{
  const h=harness('source-peek'),reader=new h.Node('section'),first=new h.Node('button'),second=new h.Node('button');reader.id='readingPane';reader.append(first,second);h.doc.body.append(reader);
  for(const [node,id] of [[first,'a'],[second,'b']]){const source={type:'note',id};h.sources.set(node,{source,siblings:[source]});}
  let settle;h.hook.open=(...args)=>{h.opens.push(args);return new Promise(resolve=>{settle=resolve;});};
  h.api.show(first);const pending=h.cards.at(-1).props.onOpen();h.api.show(second);settle(false);await pending;
  assert.equal(h.opens.length,1);assert.equal(h.opens[0][1],'a');assert.equal(h.opens[0][4].anchor,first);assert.equal(h.cards.at(-1).props.source.id,'b');h.handle.destroy();
});

test('project file entries pass their own row as transient navigation anchor for notes and local files', async()=>{
  const h=harness('project-files'),host=new h.Node('section');host.id='projectTreePanel';h.doc.body.append(host);
  h.api.render(host,h.state.projects[0],{notes:[{id:'n',title:'Note'}],imports:[]});await new Promise(resolve=>setImmediate(resolve));
  const rows=host.querySelectorAll('[data-project-file-key]');assert.equal(rows.length,2);
  const unrelated=new h.Node('button');h.doc.body.append(unrelated);unrelated.focus();
  for(const row of rows){row.onclick();const call=h.opens.at(-1),[kind,id]=JSON.parse(row.dataset.projectFileKey);assert.equal(call.length,6);assert.equal(call[0],kind);assert.equal(call[1],id);assert.equal(call[2],undefined);assert.equal(call[3],undefined);assert.equal(call[4],undefined);assert.equal(call[5].anchor,row);assert.notEqual(call[5].anchor,unrelated);assert.equal(Object.hasOwn(JSON.parse(row.dataset.fileRef),'anchor'),false);}
  assert.equal(h.opens.some(call=>call[0]==='local-file'),true);assert.equal(h.opens.some(call=>call[0]==='note'),true);
});
