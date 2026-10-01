'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const sourcePath=process.env.AIBRO_PROJECT_FILES_SOURCE || require.resolve('../app/project-files.js');
const source=fs.readFileSync(sourcePath,'utf8');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function harness({request}={}){
 const state={projects:[{id:'connected',localFolder:{id:'folder',name:'Fixture'}}]},calls=[];let renderCount=0;
 const doc={};
 class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.className='';this.children=[];this.dataset={};this.attributes={};this.listeners={};this.value='';this._html='';this.ownerDocument=doc;this.classList={add:name=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),name])].join(' ');}};}
  get isConnected(){return this===doc.body||!!this.parentElement?.isConnected;}
  get firstElementChild(){return this.children[0]||null;}
  get innerHTML(){return this._html;}
  set innerHTML(value){this._html=String(value);this.replaceChildren();}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...nodes);}
  remove(){if(!this.parentElement)return;const parent=this.parentElement;parent.children.splice(parent.children.indexOf(this),1);this.parentElement=null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  matches(selector){if(selector==='[data-project-file-key]')return Object.hasOwn(this.dataset,'projectFileKey');return selector.startsWith('.')&&this.className.split(' ').includes(selector.slice(1));}
  querySelectorAll(selector){const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 }
 doc.body=new Element('body');doc.createElement=tag=>new Element(tag);doc.querySelectorAll=selector=>doc.body.querySelectorAll(selector);
 const root={document:doc,FileContext:{request:async(url,payload)=>{calls.push({url,payload});return request?request(url,payload):{entries:[{name:'kept.md',path:'kept.md',type:'file'}],nextOffset:null};}},addEventListener(){}};
 vm.runInNewContext(source,root);const api=root.ProjectFiles;api.init({getState:()=>state,open(){}});
 const mount=(project=state.projects[0])=>{const host=new Element();doc.body.append(host);api.render(host,project,{notes:[],imports:[]});renderCount++;return host;};
 const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
 return {api,root,doc,state,calls,mount,settle,Element,renderCount:()=>renderCount};
}
async function probe(){
 assert.equal(typeof global.gc,'function');
 const h=harness(),refs=[];
 for(let i=0;i<30;i++){let host=h.mount();await h.settle();refs.push(new WeakRef(host));host.remove();host=null;}
 // End all jobs which held a host/async directory continuation before collecting.
 for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
 const retained=refs.map(ref=>ref.deref()).filter(Boolean);
 const descendants=node=>1+node.children.reduce((sum,child)=>sum+descendants(child),0);
 const result={cycles:30,connectedHosts:h.doc.querySelectorAll('.project-files').length,retainedDetachedHosts:retained.length,retainedDetachedNodes:retained.reduce((sum,host)=>sum+descendants(host),0)};
 process.stdout.write(JSON.stringify(result)+'\n');
 assert.equal(result.retainedDetachedHosts,0,'retired project tree hosts must not remain owned by the module');
}
if(process.argv.includes('--gc-probe'))probe().catch(error=>{console.error(error);process.exitCode=1;});
else{
 const test=require('node:test');
 test('retiring and recreating local tree hosts does not retain detached DOM in the module',()=>{
  const result=spawnSync(process.execPath,['--expose-gc',__filename,'--gc-probe'],{encoding:'utf8',timeout:15000,env:process.env});
  assert.equal(result.status,0,result.stdout+result.stderr);const evidence=JSON.parse(result.stdout.trim());assert.equal(evidence.cycles,30);assert.equal(evidence.connectedHosts,0);assert.equal(evidence.retainedDetachedNodes,0);
 });
 test('refresh visits connected owned trees only and preserves cached local listings',async()=>{
  const h=harness(),old=h.mount();await h.settle();old.remove();const live=h.mount();await h.settle();const oldChild=old.firstElementChild,liveChild=live.firstElementChild;
  const unowned=new h.Element();unowned.classList.add('project-files');h.doc.body.append(unowned);
  h.api.refresh();await h.settle();assert.equal(old.firstElementChild,oldChild);assert.notEqual(live.firstElementChild,liveChild);assert.equal(unowned.children.length,0);assert.equal(h.calls.length,1,'same binding reuses the previously loaded listing');assert.equal(live.querySelectorAll('.project-file-row').length,1);
 });
 test('an old asynchronous listing cannot render into a replacement tree on the same live host',async()=>{
  const first=deferred(),second=deferred();let count=0;const h=harness({request:()=>++count===1?first.promise:second.promise});const host=h.mount();
  h.api.render(host,h.state.projects[0],{notes:[],imports:[]});second.resolve({entries:[{name:'current.md',path:'current.md',type:'file'}],nextOffset:null});await h.settle();
  first.resolve({entries:[{name:'old.md',path:'old.md',type:'file'}],nextOffset:null});await h.settle();
  const rows=host.querySelectorAll('.project-file-row');assert.equal(rows.length,1);assert.equal(rows[0].title,'current.md');
  h.api.refresh();await h.settle();assert.equal(host.querySelectorAll('.project-file-row')[0].title,'current.md','a retired response must not poison the shared listing cache');
 });
 test('an async listing for a detached host cannot append to its retired subtree',async()=>{
  const response=deferred(),h=harness({request:()=>response.promise}),host=h.mount();host.remove();
  response.resolve({entries:[{name:'late.md',path:'late.md',type:'file'}],nextOffset:null});await h.settle();assert.equal(host.querySelectorAll('.project-file-row').length,0);
 });
 test('refresh retains the current project search and explicit refresh reloads directory data',async()=>{
  const h=harness(),host=h.mount();await h.settle();const search=host.querySelector('.project-files-search');search.value='kept';search.oninput();await h.settle();h.api.refresh();await h.settle();assert.equal(host.querySelector('.project-files-search').value,'kept');assert.equal(h.calls.length,1);
  host.querySelector('.project-files-refresh').onclick();await h.settle();assert.equal(h.calls.length,2);
 });
}
