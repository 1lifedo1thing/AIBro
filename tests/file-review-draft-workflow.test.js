const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const DraftReview=require('../app/draft-review');
const source=fs.readFileSync(require.resolve('../app/file-review'),'utf8');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness(options={}){
 class Node{constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.isConnected=true;this.textContent='';}append(...nodes){this.children.push(...nodes);}setAttribute(){}querySelector(){return this.children.find(n=>n.tagName==='button')||null;}focus(){this.focused=true;}scrollIntoView(){}}
 const notes=['a','b'].map(id=>({id,projectId:'p',title:id,content:'Original '+id,aiDraft:{content:'Proposed '+id,createdAt:2}}));
 const state={notes,projects:[{id:'p'}],conversations:[{id:'c',projectId:'p'}]};const run={id:'r',conversationId:'c',projectId:'p',fileChanges:notes.map(n=>({type:'note',id:n.id,title:n.title,operation:'drafted',before:{content:n.content},after:{content:n.content,aiDraft:structuredClone(n.aiDraft)}}))};state.agentRuns=[run];
 const docs=[],calls=[],cards=[],container=new Node('main');let workbench;
 const context={DraftReview,document:{createElement:tag=>new Node(tag)},ReviewWorkbench:{create(_host,config){const viewer=new Node('section'),state={selectedId:config.selectedId};workbench={config,viewer,state,refresh(file){calls.push(['refresh',file.id,file.status]);},select(file){state.selectedId=file.id;config.onSelect(file,viewer,state);}};workbench.select(config.files.find(f=>f.id===config.selectedId)||config.files[0]);return workbench;},document(viewer,config){const footer=new Node('footer');footer.append(...config.actions);viewer.children=[footer];docs.push(config);return {footer};}},confirm:()=>true};
 if(options.kit)context.HalaskaUI={componentNames:['ReviewChangeCard'],mount(_host,name,props){cards.push({name,props});}};
 vm.createContext(context);vm.runInContext(source,context);const api=context.FileReview;
 api.init({getState:()=>state,openFile:(type,id)=>calls.push(['open',type,id]),editDraft:(_run,change)=>calls.push(['edit',change.id]),open:(id,file)=>calls.push(['review',id,file]),markdown:x=>x,toast:x=>calls.push(['toast',x]),reviewDraft:async(_run,change,action)=>{calls.push(['decision',change.id,action]);if(options.cancel)return false;const status=DraftReview.proposalStatus(state,change,{runId:run.id});return DraftReview.commit(state,status.review,action,()=>options.persist?options.persist.promise:true);}});
 return {api,state,run,container,docs,calls,cards,get workbench(){return workbench;},render:(selected='b')=>api.render(container,run,selected),action:key=>docs.at(-1).actions.find(n=>n.dataset.draftReviewAction===key)};
}
test('second file review uses its exact note and refreshes only after durable adoption',async()=>{
 const persist=defer(),h=harness({persist});h.render();const original=JSON.stringify(h.run.fileChanges);assert.match(h.docs.at(-1).notice,/待采纳/);
 const saving=h.action('adopt').onclick();assert.equal(h.action('adopt').disabled,true);assert.equal(h.calls.filter(c=>c[0]==='refresh').length,0);persist.resolve(true);await saving;
 assert.equal(h.state.notes[0].content,'Original a');assert.equal(h.state.notes[1].content,'Proposed b');assert.equal(h.workbench.state.selectedId,'b');assert.match(h.docs.at(-1).notice,/已采纳/);assert.equal(h.action('adopt'),undefined);assert.equal(h.action('discard'),undefined);assert.equal(JSON.stringify(h.run.fileChanges),original);assert.deepEqual(h.calls.find(c=>c[0]==='decision'),['decision','b','adopt']);
});
test('discard preserves body and transitions proposal to historical discarded state',async()=>{
 const h=harness();h.render();await h.action('discard').onclick();assert.equal(h.state.notes[1].content,'Original b');assert.equal(h.state.notes[1].aiDraft,undefined);assert.match(h.docs.at(-1).notice,/已放弃/);
});
test('save failure and cancelled leave retain pending review with enabled controls',async()=>{
 const gate=defer(),h=harness({persist:gate});h.render();const action=h.action('adopt'),saving=action.onclick();gate.reject(Error('disk full'));assert.equal(await saving,false);assert.equal(action.disabled,false);assert.equal(h.state.notes[1].content,'Original b');assert.equal(h.state.notes[1].aiDraft.content,'Proposed b');assert.match(h.docs.at(-1).notice,/待采纳/);assert.equal(h.calls.filter(c=>c[0]==='refresh').length,0);
 const cancelled=harness({cancel:true});cancelled.render();assert.equal(await cancelled.action('adopt').onclick(),false);assert.equal(cancelled.state.notes[1].content,'Original b');assert.equal(cancelled.calls.filter(c=>c[0]==='refresh').length,0);
});
test('late decision for the previous file never jumps selection back or overwrites its successor viewer',async()=>{
 const gate=defer(),h=harness({persist:gate});h.render();const saving=h.action('adopt').onclick();h.workbench.select(h.workbench.config.files[0]);const next=h.docs.at(-1);gate.resolve(true);await saving;assert.equal(h.workbench.state.selectedId,'a');assert.equal(h.docs.at(-1),next);assert.match(next.path,/a/);
});
test('newer proposal invalidates captured action and processed proposals never offer destructive stale actions',async()=>{
 const h=harness();h.render();const stale=h.action('adopt');h.state.notes[1].aiDraft={content:'Newer',createdAt:3};assert.equal(await stale.onclick(),false);assert.equal(h.calls.some(c=>c[0]==='decision'),false);h.render();assert.match(h.docs.at(-1).notice,/被新草稿替代/);assert.equal(h.action('adopt'),undefined);assert.equal(h.docs.at(-1).actions.some(n=>n.textContent==='撤销此项'),false);
});
test('editor callback retains exact reviewed file identity',async()=>{const h=harness();h.render();await h.action('edit').onclick();assert.deepEqual(h.calls.at(-1),['edit','b']);});
test('real Kit change card receives resolved proposal states rather than stale drafted flags',async()=>{
 const h=harness({kit:true});h.render();await h.action('adopt').onclick();h.api.card(h.run);const [first,second]=h.cards.at(-1).props.changes;assert.equal(first.draft,true);assert.equal(second.draft,false);assert.equal(second.status,'已采纳');
});
