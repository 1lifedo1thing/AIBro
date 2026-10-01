'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createRequire}=require('node:module');
const req=createRequire(path.resolve(__dirname,'../app/queue-context.js'));
const F=require('../app/file-context.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function fixture(){
 const conversation={id:'conversation-a',draft:'UNSENT_COMPOSER_DRAFT',draftAttachmentIds:['draft-file'],skillIds:['default-skill'],pendingSubmits:[{id:'a',goal:'queued original',attachmentIds:['file'],fileReferences:[],skillSnapshot:[]}]};
 const other={id:'conversation-b',pendingSubmits:[{id:'b',goal:'other queue',attachmentIds:[],fileReferences:[],skillSnapshot:[]}]};
 const state={conversations:[conversation,other],projects:[],settings:{skillsEnabled:true},imports:[{id:'file',name:'queue file',content:'NEVER_PASS_BODY_TO_UI',originalName:'queue.txt',size:123}],notes:[{id:'note',title:'note title',content:'PRIVATE_NOTE_BODY'}],skills:[{id:'skill_test',name:'My Skill',command:'skill',description:'Skill description',instructions:'SKILL_INSTRUCTIONS_MUST_STAY_OUT_OF_UI',enabled:true}]};
 const storage=new Map(),body={},events=new Map();let props,save=async()=>true,sent=0;
 const env={require:req,structuredClone,TextEncoder,URL,console,document:{documentElement:{lang:'zh'},body,activeElement:body,getElementById:()=>null,removeEventListener:name=>events.delete(name),addEventListener:(name,fn)=>events.set(name,fn)},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},HalaskaUI:{componentNames:['QueueSurface'],mount:(_,name,value)=>{props=value;},unmount(){}},FileContext:F};
 vm.createContext(env);for(const file of ['agent-queue.js','queue-context.js','agent-queue-ui.js'])vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../app',file),'utf8'),env);
 const UI=env.AgentQueueUI,box={isConnected:true};UI.init({getState:()=>state,getConversation:id=>state.conversations.find(c=>c.id===id),save:()=>save(),onSend:()=>{sent++;}});
 const render=(current=conversation)=>UI.render(box,{conversation:current,canSend:true,hasDraft:false});render();
 const settle=async()=>{for(let i=0;UI.isBusy()&&i<30;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(UI.isBusy(),false);};
 const edit=async()=>{props.onEdit('a');await settle();};
 return{env,UI,state,conversation,other,storage,get props(){return props;},get sent(){return sent;},setSave:value=>{save=value;},render,settle,edit};
}
test('queue context editing persists only through durable whole-context save and leaves composer defaults untouched',async()=>{
 const h=await fixture();await h.edit();h.props.onDraft('revised '+ 'x'.repeat(4500));await h.props.onMutate({action:'add-material',type:'note',id:'note'});await h.props.onMutate({action:'add-skill',id:'skill_test'});
 assert.equal(h.conversation.pendingSubmits[0].goal,'queued original');assert.equal(h.conversation.pendingSubmits[0].skillSnapshot.length,0);
 assert.equal(await h.props.onCommand({action:'edit',id:'a'}),true);const item=h.conversation.pendingSubmits[0];assert.ok(item.goal.length>4000);assert.equal(item.fileReferences[0].id,'note');assert.equal(item.skillSnapshot[0].instructions,'SKILL_INSTRUCTIONS_MUST_STAY_OUT_OF_UI');
 assert.equal(h.conversation.draft,'UNSENT_COMPOSER_DRAFT');assert.deepEqual(h.conversation.draftAttachmentIds,['draft-file']);assert.deepEqual(h.conversation.skillIds,['default-skill']);assert.equal(h.UI.isPaused(h.conversation),true);assert.equal(h.sent,0);
 await h.props.onSend();assert.equal(h.sent,1);assert.equal(h.UI.isPaused(h.conversation),false);
});
test('save rejection keeps every edited field in memory and rolls back the pending item',async()=>{
 const h=await fixture();await h.edit();await h.props.onMutate({action:'add-material',type:'note',id:'note'});h.props.onDraft('draft after failure');h.setSave(async()=>{throw Error('disk full');});
 assert.equal(await h.props.onCommand({action:'edit',id:'a'}),false);assert.equal(h.props.draft,'draft after failure');assert.equal(h.props.contextView.materials.length,2);assert.equal(h.conversation.pendingSubmits[0].goal,'queued original');assert.equal(h.conversation.pendingSubmits[0].fileReferences.length,0);assert.match(h.props.error,/未能保存/);assert.equal(h.UI.isEditing(),true);
 h.setSave(async()=>true);assert.equal(await h.props.onCommand({action:'edit',id:'a'}),true);assert.equal(h.conversation.pendingSubmits[0].fileReferences[0].id,'note');
});
test('switching conversations retains independent draft context and ignores a late save UI result in the new conversation',async()=>{
 const h=await fixture();await h.edit();h.props.onDraft('return to this draft');await h.props.onMutate({action:'add-skill',id:'skill_test'});h.render(h.other);assert.equal(h.props.editingId,null);h.render();assert.equal(h.props.editingId,'a');assert.equal(h.props.draft,'return to this draft');assert.equal(h.props.contextView.skills.length,1);
 const pending=deferred();h.setSave(()=>pending.promise);const saving=h.props.onCommand({action:'edit',id:'a'});await new Promise(resolve=>setImmediate(resolve));h.render(h.other);pending.resolve(true);await saving;assert.equal(h.props.conversationId,h.other.id);assert.equal(h.props.editingId,null);assert.equal(h.props.notice,'');h.render();assert.equal(h.props.editingId,null);assert.equal(h.conversation.pendingSubmits[0].goal,'return to this draft');
});
test('ordinary localStorage contains only goal text and private editing never persists even its goal',async()=>{
 const h=await fixture();await h.edit();await h.props.onMutate({action:'add-material',type:'note',id:'note'});await h.props.onMutate({action:'add-skill',id:'skill_test'});h.props.onDraft('ordinary text');
 const stored=[...h.storage.values()].join('');assert.match(stored,/ordinary text/);assert.doesNotMatch(stored,/PRIVATE_NOTE_BODY|fileReferences|skillSnapshot|instructions|SKILL_INSTRUCTIONS/);
 const rendered=JSON.stringify(h.props);assert.doesNotMatch(rendered,/PRIVATE_NOTE_BODY|NEVER_PASS_BODY_TO_UI|SKILL_INSTRUCTIONS/);
 h.conversation.private=true;h.render();h.props.onDraft('PRIVATE_QUEUE_TEXT');assert.doesNotMatch([...h.storage.values()].join(''),/PRIVATE_QUEUE_TEXT|ordinary text/);h.state.notes[0].private=true;h.render();assert.doesNotMatch(JSON.stringify(h.props),/note title|PRIVATE_NOTE_BODY/);assert.ok(h.props.contextView.materials.every(row=>row.status==='private'));
});
test('CAS conflict keeps edits until explicitly confirmed saved-version reload',async()=>{
 const h=await fixture();await h.edit();h.props.onDraft('my retained draft');h.conversation.pendingSubmits[0].goal='external update';assert.equal(await h.props.onCommand({action:'edit',id:'a'}),false);assert.equal(h.props.draft,'my retained draft');assert.match(h.props.error,/别处修改/);
 h.props.onReload();assert.equal(h.props.confirmReload,true);assert.equal(h.props.draft,'my retained draft');h.props.onCancelReload();assert.equal(h.props.confirmReload,false);h.props.onReload();h.props.onConfirmReload();await h.settle();assert.equal(h.props.draft,'external update');assert.equal(h.props.confirmReload,false);
});
test('a broken queue head is retained, repair saves independently, then explicit continue sends once',async()=>{
 const h=await fixture();h.state.imports[0].archived=true;h.render();await h.props.onSend();assert.equal(h.sent,0);assert.equal(h.conversation.pendingSubmits.length,1);assert.equal(h.UI.isPaused(h.conversation),true);assert.match(h.props.error,/修复/);
 await h.edit();await h.props.onMutate(h.props.contextView.materials[0].remove);await h.props.onCommand({action:'edit',id:'a'});assert.equal(h.sent,0);assert.deepEqual(Array.from(h.conversation.pendingSubmits[0].attachmentIds),[]);await h.props.onSend();assert.equal(h.sent,1);
});
test('active edits and pending saves reject reordering, cancellation and duplicate sends',async()=>{
 const h=await fixture();await h.edit();assert.equal(await h.props.onCommand({action:'remove',id:'a'}),false);assert.equal(h.env.AgentQueue.shift(h.conversation),null);
 h.props.onDraft('save in flight');const pending=deferred();h.setSave(()=>pending.promise);const saving=h.props.onCommand({action:'edit',id:'a'});await new Promise(resolve=>setImmediate(resolve));h.props.onCancel();await h.props.onSend();assert.equal(h.sent,0);assert.equal(h.UI.isEditing(),true);assert.equal(h.env.AgentQueue.shift(h.conversation),null);pending.resolve(false);await saving;assert.equal(h.props.draft,'save in flight');
});
test('source and skill display changes are live while frozen skill text only upgrades explicitly',async()=>{
 const h=await fixture();await h.edit();await h.props.onMutate({action:'add-skill',id:'skill_test'});await h.props.onCommand({action:'edit',id:'a'});await h.edit();h.state.skills[0].instructions='NEW_INSTRUCTIONS';h.render();assert.equal(h.props.contextView.skills[0].status,'changed');await h.props.onCommand({action:'edit',id:'a'});assert.equal(h.conversation.pendingSubmits[0].skillSnapshot[0].instructions,'SKILL_INSTRUCTIONS_MUST_STAY_OUT_OF_UI');
 await h.edit();await h.props.onMutate(h.props.contextView.skills[0].refresh);await h.props.onCommand({action:'edit',id:'a'});assert.equal(h.conversation.pendingSubmits[0].skillSnapshot[0].instructions,'NEW_INSTRUCTIONS');h.state.skills[0].enabled=false;await h.props.onSend();assert.equal(h.sent,0);assert.equal(h.UI.isPaused(h.conversation),true);
});

test('queued PDF reading mode changes only the edit draft until save and stays separate from composer and active run',async()=>{
 const h=await fixture();h.conversation.draftPdfReadMode='original';h.conversation.activeRun={pdfReadMode:'original'};
 await h.edit();assert.equal(h.props.pdfReadMode,'original');assert.equal(h.props.onPdfReadMode('text'),true);
 assert.equal(h.props.pdfReadMode,'text');assert.equal(Object.hasOwn(h.conversation.pendingSubmits[0],'pdfReadMode'),false);
 await h.props.onMutate({action:'add-skill',id:'skill_test'});assert.equal(h.props.pdfReadMode,'text');
 assert.equal(await h.props.onCommand({action:'edit',id:'a'}),true);assert.equal(h.conversation.pendingSubmits[0].pdfReadMode,'text');assert.equal(h.props.items[0].pdfReadMode,'text');
 assert.equal(h.conversation.draftPdfReadMode,'original');assert.equal(h.conversation.activeRun.pdfReadMode,'original');assert.equal(h.conversation.draft,'UNSENT_COMPOSER_DRAFT');
});

test('queued PDF mode survives failed saves and conversation switches, but cancel discards unsaved selection',async()=>{
 const h=await fixture();await h.edit();h.props.onPdfReadMode('text');h.setSave(async()=>false);
 assert.equal(await h.props.onCommand({action:'edit',id:'a'}),false);assert.equal(h.props.pdfReadMode,'text');assert.equal(Object.hasOwn(h.conversation.pendingSubmits[0],'pdfReadMode'),false);
 h.render(h.other);h.render();assert.equal(h.props.pdfReadMode,'text');assert.equal(h.props.onPdfReadMode('auto'),false);assert.equal(h.props.pdfReadMode,'text');assert.match(h.props.error,/读取方式无效/);
 h.props.onCancel();await h.edit();assert.equal(h.props.pdfReadMode,'original');
});

test('queued PDF mode detects external change and reload explicitly replaces the retained choice',async()=>{
 const h=await fixture();await h.edit();h.props.onPdfReadMode('original');h.conversation.pendingSubmits[0].pdfReadMode='text';
 assert.equal(await h.props.onCommand({action:'edit',id:'a'}),false);assert.equal(h.props.pdfReadMode,'original');assert.match(h.props.error,/别处修改/);
 h.props.onReload();h.props.onConfirmReload();await h.settle();assert.equal(h.props.pdfReadMode,'text');
});

test('queued PDF selection is locked during persistence and invalid persisted modes retain a removable queue',async()=>{
 const h=await fixture();await h.edit();h.props.onPdfReadMode('text');const pending=deferred();h.setSave(()=>pending.promise);const saving=h.props.onCommand({action:'edit',id:'a'});await new Promise(resolve=>setImmediate(resolve));
 h.props.onPdfReadMode('original');assert.equal(h.props.pdfReadMode,'text');pending.resolve(true);await saving;assert.equal(h.conversation.pendingSubmits[0].pdfReadMode,'text');
 h.conversation.pendingSubmits[0].pdfReadMode='invalid';h.render();assert.equal(h.props.summaries.a.canSend,false);h.props.onEdit('a');assert.equal(h.UI.isEditing(),false);assert.equal(h.env.AgentQueue.isBlocked(h.conversation),false);assert.match(h.props.error,/读取方式无效/);
 await h.props.onSend();assert.equal(h.sent,0);assert.equal(h.conversation.pendingSubmits.length,1);h.setSave(async()=>true);assert.equal(await h.props.onCommand({action:'remove',id:'a'}),true);assert.equal(h.conversation.pendingSubmits.length,0);
});
