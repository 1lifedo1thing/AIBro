const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Review=require('../app/file-review.js');
function fixture(){
 const project={id:'p',name:'Public project',localFolder:{id:'folder'}},conversation={id:'c',projectId:'p',title:'Conversation'};
 const note={id:'n',projectId:'p',title:'Public file',content:'Current body'};
 const change={type:'note',id:'n',title:'Public file',operation:'updated',before:{projectId:'p',content:'Before'},after:{projectId:'p',content:'After'}};
 const local={id:'edit',runId:'r',projectId:'p',candidateId:'folder',path:'public.md',status:'pending'};
 const run={id:'r',conversationId:'c',projectId:'p',status:'completed',fileChanges:[change],localFileEdits:[local]};
 const state={projects:[project],conversations:[conversation],notes:[note],imports:[],agentRuns:[run],trash:[]};
 return{state,project,conversation,note,change,local,run,access:(kind='review',options)=>Review.availableRun(state,kind,'r',options)};
}
test('valid library and local review return original identities without mutating snapshots',()=>{
 const h=fixture(),original=JSON.stringify(h.state);for(const kind of ['review','local-review']){const result=h.access(kind);assert.equal(result.run,h.run);assert.equal(result.changes[0],kind==='review'?h.change:h.local);}
 assert.equal(JSON.stringify(h.state),original);
});
test('public deleted, archived and absent current files retain historical review snapshots',()=>{
 for(const mutate of [h=>{h.note.deletedAt=1;},h=>{h.note.archived=true;},h=>{h.note.status='deleted';},h=>{h.state.notes=[];},h=>{h.state.notes=[];h.state.trash.push({data:{notes:[h.note]}});}]){
  const h=fixture();mutate(h);assert.equal(h.access()?.changes[0],h.change);
 }
});
test('private current, deleted, archived and snapshot records never reveal their historical text',()=>{
 for(const mutate of [h=>{h.note.private=true;},h=>{h.note.ephemeral=true;},h=>{h.note.incognito=true;},h=>{h.note.private=true;h.note.deletedAt=1;},h=>{h.note.private=true;h.state.notes=[];h.state.trash.push({data:{notes:[h.note]}});},h=>{h.change.before.private=true;},h=>{h.change.after.incognito=true;},h=>{h.change.private=true;}]){
  const h=fixture();mutate(h);assert.equal(h.access(),null);
 }
});
test('privacy follows current and snapshot provenance through retained runs and conversations',()=>{
 for(const target of ['record','before','after','draft']){
  const h=fixture();h.state.trash.push({data:{runs:[{id:'old-run',sourceConversationId:'secret-chat'}],conversations:[{id:'secret-chat',private:true}]}});
  const provenance={origin:{runId:'old-run'}};
  if(target==='record')h.note.provenance=provenance;else if(target==='draft')h.change.after.aiDraft={content:'Private proposed body',provenance};else h.change[target].provenance=provenance;
  assert.equal(h.access(),null,target);
 }
});
test('run and conversation must be unique, active and present with active direct project owners',()=>{
 for(const mutate of [h=>{h.state.agentRuns=[];},h=>{h.state.agentRuns.push({...h.run});},h=>{h.state.conversations=[];},h=>{h.state.conversations.push({...h.conversation});},h=>{delete h.run.conversationId;},h=>{h.state.projects=[];},h=>{h.state.projects.push({...h.project});},h=>{h.project.archived=true;},h=>{h.state.trash.push({data:{agentRuns:[{id:'r'}]}});},h=>{h.state.trash.push({data:{conversations:[{id:'c'}]}});}]){
  const h=fixture();mutate(h);assert.equal(h.access(),null);assert.equal(h.access('local-review'),null);
 }
 for(const flag of ['deleted','deletedAt','archived','archivedAt','hidden','hiddenAt','tombstone','wikiFileError'])for(const owner of ['run','conversation','project']){const h=fixture();h[owner][flag]=true;assert.equal(h.access(),null,`${owner}.${flag}`);}
});
test('global privacy and inherited run or conversation privacy revoke both review kinds',()=>{
 const h=fixture();assert.equal(h.access('review',{privateMode:true}),null);assert.equal(h.access('local-review',{privateMode:true}),null);
 for(const owner of ['run','conversation','project']){const h=fixture();h[owner].private=true;assert.equal(h.access(),null);assert.equal(h.access('local-review'),null);}
 const nested=fixture();nested.run.provenance={origin:{conversationId:'private-source'}};nested.state.trash.push({data:{conversations:[{id:'private-source',private:true}]}});assert.equal(nested.access(),null);
});
test('ambiguous records, snapshot owners and untyped duplicate row identities fail closed',()=>{
 for(const mutate of [h=>{h.state.notes.push({...h.note});},h=>{h.state.trash.push({data:{notes:[{...h.note}]}});},h=>{h.run.fileChanges.push({...h.change});},h=>{h.run.fileChanges.push({...h.change,type:'import'});},h=>{h.change.before.projectId='other';h.state.projects.push({id:'other'},{id:'other'});}]){const h=fixture();mutate(h);assert.equal(h.access(),null);}
});
test('mixed library review keeps only public rows and never returns private paths or titles',()=>{
 const h=fixture();const hidden={...h.change,id:'secret',title:'Secret name',folderPath:'secret-folder',after:{content:'Secret body',private:true}};h.run.fileChanges.push(hidden);
 const result=h.access();assert.deepEqual(result.changes,[h.change]);assert.equal(result.run,h.run);assert.equal(h.run.fileChanges.length,2);
});
test('local review tolerates disconnected historical binding but rejects unsafe mixed rows',()=>{
 const h=fixture();h.project.localFolder.id='replacement';assert.equal(h.access('local-review')?.run,h.run);
 for(const patch of [{runId:'other'},{private:true},{candidateId:''},{path:''},{projectId:'missing'}]){const h=fixture();Object.assign(h.local,patch);assert.equal(h.access('local-review'),null);}
 const mixed=fixture();mixed.run.localFileEdits.push({...mixed.local,id:'secret',path:'secret.md',private:true});assert.equal(mixed.access('local-review'),null);
});
test('cyclic public provenance terminates and a private node in the cycle revokes access',()=>{
 const h=fixture(),a={},b={};a.provenance={origin:b};b.provenance={origin:a};h.change.after.provenance={origin:a};assert.equal(h.access()?.run,h.run);b.private=true;assert.equal(h.access(),null);
});
test('filtered card and viewer expose no private title, path or body, including explicit selected ID',()=>{
 const h=fixture();h.run.fileChanges.push({type:'note',id:'secret',title:'Secret title',folderPath:'Hidden path',before:null,after:{content:'Private body',private:true}});
 const cards=[],views=[],configs=[];class Node{constructor(){this.children=[];this.dataset={};this.isConnected=true;}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(){}querySelector(){return null;}}
 const context={document:{createElement:()=>new Node()},HalaskaUI:{componentNames:['ReviewChangeCard'],mount(host,name,props){cards.push(props);}},ReviewWorkbench:{create(container,config){configs.push(config);const viewer=new Node();if(config.files.length)config.onSelect(config.files.find(file=>file.id===config.selectedId)||config.files[0],viewer,{});return{};},document(host,config){views.push(config);return{footer:new Node()};}},CitationEvidence:require('../app/citation-evidence.js')};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../app/file-review.js'),'utf8'),context);context.FileReview.init({getState:()=>h.state,openFile(){},open(){},markdown:value=>value});
 context.FileReview.card(h.run,h.state);context.FileReview.render(new Node(),h.run,'secret');
 assert.equal(cards[0].changes.length,1);assert.equal(configs[0].files.length,1);assert.equal(views[0].after,'After');assert.doesNotMatch(JSON.stringify([cards,configs.map(config=>config.files),views]),/Secret title|Hidden path|Private body/);
});
