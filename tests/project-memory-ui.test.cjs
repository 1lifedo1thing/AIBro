'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),Memory=require('../app/project-memory.js'),Evidence=require('../app/citation-evidence.js');
class Node {
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.dataset={};}
 get isConnected(){return this===this.ownerDocument?.body||!!this.parentElement?.isConnected;}
 prepend(node){node.remove();node.parentElement=this;node.ownerDocument=this.ownerDocument;this.children.unshift(node);}
 append(node){node.remove();node.parentElement=this;node.ownerDocument=this.ownerDocument;this.children.push(node);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}
 replaceChildren(...nodes){for(const child of this.children)child.parentElement=null;this.children=[];nodes.forEach(node=>this.append(node));}
 contains(node){return this===node||this.children.some(child=>child.contains(node));}
}
function fixture(){
 const doc={createElement:tag=>{const node=new Node(tag);node.ownerDocument=doc;return node;}};doc.body=doc.createElement('body');doc.body.dataset.view='project';const overview=doc.createElement('section');doc.body.append(overview);
 const find=(node,id)=>node.id===id?node:node.children.map(child=>find(child,id)).find(Boolean);
 doc.querySelector=selector=>selector==='#project [data-project-panel="overview"]'?(overview.isConnected?overview:null):selector==='#projectMemoryControls'?find(doc.body,'projectMemoryControls'):null;
 const project={id:'p',name:'Project',workspace:'日常'},other={id:'q',name:'Other',workspace:'日常'},state={projects:[project,other],notes:[],tasks:[],conversations:[],agentRuns:[],trash:[],currentProjectId:'p',ui:{projectTab:'overview'}};
 const calls={save:0,open:[],toast:[],automate:[]},mounts=new Map();let saving=async()=>true;
 const env={document:doc,state,ProjectMemory:Memory,CitationEvidence:Evidence,toast:message=>calls.toast.push(message),saveDocumentDurably:async()=>{calls.save++;return saving();},openPreview:async(...args)=>{if(args[4]?.()===false)return false;calls.open.push(args);return true;},HalaskaUI:{mount(host,name,props){mounts.set(host,{name,props});}},WorkstationI18n:{getLanguage:()=> 'zh'},ProjectAutomation:{open:p=>calls.automate.push(p.id)}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../app/project-memory-ui.js'),'utf8'),env);
 return {env,doc,overview,project,other,state,calls,mounts,render:p=>env.ProjectMemoryUI.render(p||project),host:()=>doc.querySelector('#projectMemoryControls'),props:()=>mounts.get(doc.querySelector('#projectMemoryControls'))?.props,setSave:fn=>saving=fn};
}
function record(f,kind='long',extra={}){const note={id:Memory.id('p',kind),projectId:'p',title:'Record',projectMemoryType:kind,content:'Approved content',updatedAt:10,...extra};f.state.notes.push(note);return note;}
test('cold-start record controls attach to the stable overview with no removed banner present',()=>{
 const f=fixture();assert.equal(f.doc.querySelector('#projectLocalSummary'),null);assert.equal(f.render(),true);assert.equal(f.host().parentElement,f.overview);assert.equal(f.host().isConnected,true);assert.equal(f.mounts.get(f.host()).name,'ProjectMemoryActions');const host=f.host();f.render();assert.equal(f.host(),host);assert.equal(f.overview.children.length,1);
});
test('existing approved records open read-only with their exact clicked origin, no workspace save',async()=>{
 const f=fixture(),note=record(f);f.render();const anchor=f.doc.createElement('button');f.host().append(anchor);assert.equal(await f.props().onOpen('long',anchor),true);assert.equal(f.calls.save,0);assert.equal(f.calls.open[0][1],note.id);assert.equal(f.calls.open[0][5].anchor,anchor);assert.equal(note.content,'Approved content');
});
test('new record is saved once before opening and another existing-record click does not save again',async()=>{
 const f=fixture();f.render();await f.props().onOpen('long');assert.equal(f.calls.save,1);assert.equal(f.calls.open.length,1);assert.equal(f.state.notes.length,1);await f.props().onOpen('long');assert.equal(f.calls.save,1);assert.equal(f.state.notes.length,1);assert.equal(f.calls.open.length,2);
});
test('failed first save does not open, and retry saves the same record rather than treating it as durable',async()=>{
 const f=fixture();f.setSave(async()=>false);f.render();assert.equal(await f.props().onOpen('long'),false);assert.equal(f.calls.open.length,0);assert.equal(f.calls.save,1);const note=f.state.notes[0];assert.equal(f.props().busy,false);f.setSave(async()=>true);assert.equal(await f.props().onOpen('long'),true);assert.equal(f.calls.save,2);assert.equal(f.state.notes.length,1);assert.equal(f.state.notes[0],note);
});
test('project-switch and detached-host callbacks cannot create or open records',async()=>{
 const f=fixture();f.render();const stale=f.props();f.state.currentProjectId='q';f.render(f.other);assert.equal(await stale.onOpen('long'),false);assert.equal(f.state.notes.length,0);assert.equal(f.calls.open.length,0);const current=f.props();f.host().remove();assert.equal(await current.onOpen('long'),false);assert.equal(f.state.notes.length,0);
});
test('save that finishes after navigation cannot steal the reader, while same-project rerender remains valid',async()=>{
 const f=fixture();let resolve;f.setSave(()=>new Promise(done=>resolve=done));f.render();const pending=f.props().onOpen('long');assert.equal(f.props().busy,true);f.state.currentProjectId='q';f.render(f.other);resolve(true);assert.equal(await pending,false);assert.equal(f.calls.open.length,0);
 const g=fixture();let resolveSame;g.setSave(()=>new Promise(done=>resolveSame=done));g.render();const same=g.props().onOpen('plan');g.render();resolveSame(true);assert.equal(await same,true);assert.equal(g.calls.open.length,1);
});
test('private, ambiguous, deleted or unavailable records cannot leak through the overview shortcut',async()=>{
 for(const extra of [{private:true},{deletedAt:1},{wikiFileError:'missing'}]){const f=fixture();record(f,'long',extra);f.render();await f.props().onOpen('long');assert.equal(f.calls.open.length,0);assert.equal(f.calls.save,0);assert.equal(f.state.notes.length,1);}
 const f=fixture();record(f);record(f);f.render();await f.props().onOpen('long');assert.equal(f.calls.open.length,0);assert.equal(f.calls.save,0);
 const g=fixture();record(g,'long',{sourceConversationId:'secret'});g.state.conversations.push({id:'secret',private:true});g.render();await g.props().onOpen('long');assert.equal(g.calls.open.length,0);assert.equal(g.calls.save,0);
});
test('missing daily record has a readable empty explanation and does not manufacture a journal',async()=>{
 const f=fixture();f.render();assert.equal(await f.props().onOpen('daily'),false);assert.equal(f.state.notes.length,0);assert.equal(f.calls.save,0);assert.match(f.calls.toast[0],/完成项目对话后/);f.props().onAutomation();assert.deepEqual(f.calls.automate,['p']);
});
test('unavailable overview has no detached replacement; replaced host retires previous callbacks',async()=>{
 const f=fixture();f.overview.remove();assert.equal(f.render(),false);assert.equal(f.host(),undefined);f.doc.body.append(f.overview);f.render();const stale=f.props();f.host().remove();f.render();assert.equal(await stale.onOpen('long'),false);assert.equal(f.state.notes.length,0);
});
