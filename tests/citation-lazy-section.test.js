const test=require('node:test'),assert=require('node:assert/strict');
const Evidence=require('../app/citation-evidence.js');

// A small owned-root DOM contract: no browser/runtime mocks outside the
// disclosure lifecycle. Real keyboard/layout acceptance remains native QA.
class Element {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.parentElement=null;this.open=false;this.textContent='';this.events=new Map();this.connected=false;}
 get isConnected(){return this.connected||!!this.parentElement?.isConnected;}
 append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
 remove(){if(this.parentElement){const parent=this.parentElement;parent.children.splice(parent.children.indexOf(this),1);this.parentElement=null;}}
 replaceWith(node){const parent=this.parentElement,index=parent.children.indexOf(this);node.remove();parent.children[index]=node;node.parentElement=parent;this.parentElement=null;}
 matches(selector){if(selector==='details[data-citation-panel]')return this.tagName==='DETAILS'&&Object.hasOwn(this.dataset,'citationPanel');if(selector==='[data-citation-source]')return Object.hasOwn(this.dataset,'citationSource');return this.tagName===selector.toUpperCase();}
 querySelectorAll(selector){if(selector.startsWith(':scope > '))return this.children.filter(node=>node.matches(selector.slice(9)));return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 addEventListener(name,fn){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(fn);}
 removeEventListener(name,fn){this.events.get(name)?.delete(fn);}
 toggle(open){this.open=open;this.emit('toggle');}
 emit(name){for(const fn of this.events.get(name)||[])fn({target:this});}
}
function runtime(fn){
 const saved={document:globalThis.document,HalaskaUI:globalThis.HalaskaUI,WorkstationI18n:globalThis.WorkstationI18n};
 const calls={mounts:0,updates:0,unmounts:0,props:null};let language='zh';
 const container=new Element('article');container.connected=true;
 const kit={componentNames:['CitationSourceList'],mount(host,name,props){assert.equal(name,'CitationSourceList');assert.equal(host.children.length,0);calls.mounts++;calls.props=props;return {update(value){calls.updates++;calls.props=value;},unmount(){calls.unmounts++;}};}};
 globalThis.document={createElement:tag=>new Element(tag)};globalThis.HalaskaUI=kit;globalThis.WorkstationI18n={getLanguage:()=>language};
 try{return fn({calls,container,kit,language:value=>{language=value;}});}finally{Evidence.discard(container);Object.assign(globalThis,saved);}
}
function fixture({open=false}={}){
 const state={notes:[{id:'n',title:'Source title',content:'Retained evidence.',projectId:'p'}],projects:[{id:'p',name:'Project'}]};
 const message={id:'m',runId:'r',evidenceOpen:open};
 const run={id:'r',conversationId:'c'};Evidence.capture(run,{type:'note',id:'n',title:'Source title',excerpt:'Retained evidence.'},state);
 return {message,run,state};
}
const hasDeferred=panel=>Object.hasOwn(panel.dataset,'citationDeferred');

test('a closed source panel neither reads workspace bodies/excerpts nor mounts a UI root',()=>runtime(({calls,container})=>{
 const source={sourceId:'e1',provided:true,type:'note',id:'n',get excerpt(){throw Error('Closed source excerpt was read');}};
 const state=new Proxy({}, {get(){throw Error('Closed panel consulted workspace data');}}),run={id:'r',evidenceSources:[source]};
 const panel=Evidence.section({id:'m',runId:'r'},run,state);container.append(panel);
 assert.match(panel.children[0].textContent,/1 项/);assert.equal(panel.children[1].children.length,0);assert.equal(calls.mounts,0);assert.equal(hasDeferred(panel),true);
 panel.emit('toggle');assert.equal(calls.mounts,0);assert.equal(panel.events.get('toggle').size,1);
}));

test('cheap disclosure counts and presence match full evidence for historical and attachment metadata',()=>{
 const examples=[
  {},{evidenceSources:[{sourceId:'e',type:'note',id:'n',provided:true,excerpt:'sample'}]},
  {evidenceSources:[{sourceId:'e',type:'note',id:'n',provided:false}]},
  {knowledgeReads:[{type:'read_page',recordType:'import',id:'pdf',page:3},{type:'read_page',recordType:'import',id:'pdf',page:3}]},
  {knowledgeReads:[{type:'read_page',id:'pdf',error:'unavailable'}]},
  {retrievalCoverage:{strategy:'local-bm25'}},{retrievalCoverage:{strategy:'hybrid-rrf'}},
  {retrievalCoverage:{strategy:'unknown',eligibleRecords:0}},{retrievalCoverage:{strategy:'not-requested',eligibleRecords:5}},
  {attachmentIds:['pdf']},{attachmentIds:['pdf'],attachmentDelivery:{scope:'prepared_representations'}},
  {attachmentDelivery:{totalAttachments:0}},{attachmentDelivery:{originalFiles:1}},
  {attachmentCoverage:{scope:'extracted_text',totalAttachments:1,includedPages:0}},
  {webSources:[{url:'https://example.com/read',title:'Read'},{url:'javascript:bad',title:'Bad'}]}
 ];
 for(const value of examples)for(const retrievedSources of [undefined,[],[{type:'note',id:'n'},{type:'note',id:'n'}],[{}]]){
  const message={id:'m',runId:'r',retrievedSources},run={id:'r',...value};
  const outline=Evidence.evidenceOutline(message,run),full=Evidence.evidenceModel(message,run,{});
  assert.deepEqual(outline,{sourceCount:full.sources.length,hasContent:full.hasContent},JSON.stringify({message,run}));
 }
 assert.deepEqual(Evidence.evidenceOutline({id:'m',runId:'other'},{id:'r',evidenceSources:[{sourceId:'e',provided:true}]}),{sourceCount:0,hasContent:false});
});

test('opening uses a fresh replacement context and redacts newly private ancestry before mounting',()=>runtime(({calls,container})=>{
 const initial=fixture();let current=initial,resolutions=0;
 const panel=Evidence.section(initial.message,initial.run,initial.state,{getContext:()=>{resolutions++;return current;}});container.append(panel);
 assert.equal(resolutions,0);
 current=structuredClone(initial);current.state.projects[0].private=true;current.run.evidenceSources[0].title='SECRET_OLD_TITLE';current.run.evidenceSources[0].excerpt='SECRET_OLD_EXCERPT';
 panel.toggle(true);assert.equal(resolutions,1);assert.equal(calls.mounts,1);assert.equal(hasDeferred(panel),false);
 assert.equal(calls.props.sources[0].status.kind,'private');assert.equal(calls.props.sources[0].status.canOpen,false);
 assert.doesNotMatch(JSON.stringify(calls.props),/SECRET_OLD_TITLE|SECRET_OLD_EXCERPT|Source title/);
 panel.emit('toggle');assert.equal(resolutions,1,'Queued initial-open toggle does not rebuild an already populated root');
}));

test('body hashing is deferred to opening and closing releases bindings and the root',()=>runtime(({calls,container})=>{
 const value=fixture();let content='Retained evidence.',reads=0;
 Object.defineProperty(value.state.notes[0],'content',{get(){reads++;return content;}});
 const panel=Evidence.section(value.message,value.run,value.state);container.append(panel);assert.equal(reads,0);
 panel.toggle(true);assert.equal(reads,1);assert.equal(calls.props.sources[0].status.kind,'snapshot');
 const button=new Element('button');panel.children[1].append(button);calls.props.onBind(calls.props.sources[0],button);
 assert.ok(Evidence.resolveTarget(value.state,button));
 panel.toggle(false);assert.equal(calls.unmounts,1);assert.equal(panel.children[1].children.length,0);assert.equal(Evidence.resolveTarget(value.state,button),null);assert.equal(hasDeferred(panel),true);
 content='Changed after collapse.';panel.toggle(true);assert.equal(reads,2);assert.equal(calls.mounts,2);assert.equal(calls.props.sources[0].status.kind,'changed');
 Evidence.discard(panel);assert.equal(calls.unmounts,2);assert.equal(panel.events.get('toggle').size,0);
 Evidence.discard(panel);assert.equal(calls.unmounts,2);
}));

test('closed live patches replace the resolver without resolving state or constructing a second root',()=>runtime(({calls,container})=>{
 const value=fixture();let oldReads=0,newReads=0;
 const panel=Evidence.section(value.message,value.run,value.state,{getContext:()=>{oldReads++;return value;}});container.append(panel);
 const replacement=structuredClone(value);replacement.message.evidenceOpen=true;replacement.state.notes[0].deletedAt=7;
 const staged=Evidence.section(replacement.message,replacement.run,replacement.state,{previous:container,getContext:()=>{newReads++;return replacement;}});
 assert.equal(oldReads+newReads,0);assert.equal(calls.mounts,0);assert.equal(Evidence.patchSection(panel,staged),true);assert.equal(calls.mounts,0);assert.equal(panel.open,false);
 panel.toggle(true);assert.equal(oldReads,0);assert.equal(newReads,1);assert.equal(calls.props.sources[0].status.kind,'missing');
 staged.connected=true;staged.emit('toggle');assert.equal(calls.mounts,1,'Staged toggle listener was retired');
}));

test('open live patches retain their host and focused source binding while refreshing the context',()=>runtime(({calls,container})=>{
 const value=fixture({open:true});let current=value;
 const panel=Evidence.section(value.message,value.run,value.state,{getContext:()=>current});container.append(panel);
 const host=panel.children[1],button=new Element('button');host.append(button);calls.props.onBind(structuredClone(calls.props.sources[0]),button);
 current=structuredClone(value);current.state.projects[0].private=true;
 const staged=Evidence.section({...current.message,evidenceOpen:false},current.run,current.state,{previous:container,getContext:()=>current});
 assert.equal(calls.mounts,1);assert.equal(Evidence.patchSection(panel,staged),true);assert.equal(calls.mounts,1);assert.equal(calls.updates,1);assert.equal(panel.children[1],host);assert.equal(host.children[0],button);assert.equal(panel.open,true);
 const rebound=Evidence.resolveTarget(current.state,button);assert.equal(rebound.source.private,true);assert.equal(rebound.source.excerpt,null);assert.equal(rebound.source.status.kind,'private');
 panel.toggle(false);assert.equal(calls.unmounts,1);panel.toggle(true);assert.equal(calls.mounts,2);assert.equal(calls.props.sources[0].status.kind,'private');
}));

test('an open patch uses the authoritative context count when staged inputs are older',()=>runtime(({calls,container})=>{
 const initial=fixture({open:true}),panel=Evidence.section(initial.message,initial.run,initial.state);container.append(panel);
 const current=structuredClone(initial);Evidence.capture(current.run,{type:'note',id:'n',title:'Second passage',excerpt:'Another supplied excerpt.'},current.state);
 const staged=Evidence.section(initial.message,initial.run,initial.state,{previous:container,getContext:()=>current});
 assert.match(staged.children[0].textContent,/1 项/);Evidence.patchSection(panel,staged);
 assert.equal(calls.props.sources.length,2);assert.match(panel.children[0].textContent,/2 项/);
}));

test('missing, ambiguous-owner and failed context resolution never fall back to old source titles',()=>runtime(({calls,container})=>{
 for(const resolve of [()=>null,()=>{throw Error('Ownership lookup failed');},()=>({...fixture(),message:{id:'other'}})]){
  const value=fixture(),panel=Evidence.section(value.message,value.run,value.state,{getContext:resolve});container.append(panel);panel.toggle(true);
  assert.equal(calls.mounts,0);assert.match(panel.children[1].children[0].textContent,/来源记录已不可用/);Evidence.discard(panel);panel.remove();
 }
}));

test('detached and discarded disclosure events cannot mount or resurrect a root',()=>runtime(({calls,container})=>{
 const value=fixture();let reads=0;
 const panel=Evidence.section(value.message,value.run,value.state,{getContext:()=>{reads++;return value;}}),queued=[...panel.events.get('toggle')][0];
 panel.toggle(true);assert.equal(calls.mounts,0);assert.equal(reads,0);
 container.append(panel);Evidence.discard(panel);queued({target:panel});assert.equal(calls.mounts,0);assert.equal(reads,0);assert.equal(panel.events.get('toggle').size,0);
}));

test('explicit search materializes source titles in scratch while ordinary collapsed rendering does not',()=>runtime(({calls,container})=>{
 const value=fixture(),panel=Evidence.section(value.message,value.run,value.state,{search:true});container.append(panel);
 assert.equal(panel.open,false);assert.equal(calls.mounts,1);assert.equal(hasDeferred(panel),false);assert.equal(calls.props.sources[0].title,'Source title');
 Evidence.discard(panel);assert.equal(calls.unmounts,1);
}));

test('selecting a source search result materializes only current connected evidence and never saves disclosure intent',()=>runtime(({calls,container})=>{
 const value=fixture();let current=value;
 const panel=Evidence.section(value.message,value.run,value.state,{getContext:()=>current});
 assert.equal(Evidence.materializeForSearch(panel),false);assert.equal(calls.mounts,0);
 container.append(panel);assert.equal(Evidence.materializeForSearch(container),true);assert.equal(panel.open,true);assert.equal(calls.mounts,1);assert.equal(value.message.evidenceOpen,false);
 assert.equal(Evidence.materializeForSearch(container),false);assert.equal(calls.mounts,1);
 panel.toggle(false);current=null;
 assert.equal(Evidence.materializeForSearch(container),false);assert.equal(panel.open,false);assert.equal(calls.mounts,1);assert.match(panel.children[1].children[0].textContent,/来源记录已不可用/);
}));

test('a closed panel resolves source labels and metadata in the current locale when first opened',()=>runtime(({calls,container,language})=>{
 const value=fixture(),panel=Evidence.section(value.message,value.run,value.state);container.append(panel);assert.match(panel.children[0].textContent,/来源与证据/);
 language('en');panel.toggle(true);assert.match(panel.children[0].textContent,/Sources and evidence/);assert.match(calls.props.sources[0].status.notice,/excerpt/);
}));
