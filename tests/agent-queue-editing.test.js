const test=require('node:test'),assert=require('node:assert/strict');
const Queue=require('../app/agent-queue');
const create=()=>({id:`qa-${Math.random()}`,pendingSubmits:[{id:'a',goal:'First',at:1,attachmentIds:['file-a'],skillSnapshot:[{id:'skill-a',name:'Review',instructions:'Original instructions'}]},{id:'b',goal:'Second',at:2,attachmentIds:[]},{id:'c',goal:'Third',at:3,attachmentIds:[]}],draft:'Unsent composer draft',draftAttachmentIds:['draft-file']});
const command=(conversation,save,action)=>Queue.commit({getConversation:id=>id===conversation.id?conversation:null,save},{conversationId:conversation.id,...action});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
test('queued skill instructions are frozen at enqueue, edit retains context and composer',async()=>{
 const conversation=create(),skill={id:'s',name:'Selected skill',instructions:'Before'};
 const reference={path:'src/original.js',selection:{start:3,end:9}};
 const item=Queue.enqueue(conversation,{goal:'Fourth',attachmentIds:['x','x'],skillSnapshot:[skill],fileReferences:[reference]},123);skill.instructions='After';reference.selection.start=100;
 assert.equal(item.skillSnapshot[0].instructions,'Before');assert.equal(item.fileReferences[0].selection.start,3);
 await command(conversation,async()=>true,{action:'edit',id:item.id,goal:'Fourth revised'});assert.deepEqual(conversation.pendingSubmits.at(-1).fileReferences,[{path:'src/original.js',selection:{start:3,end:9}}]);
 await command(conversation,async()=>true,{action:'edit',id:'a',expectedGoal:'First',goal:'  Revised\nrequest  '});
 assert.equal(conversation.pendingSubmits[0].goal,'Revised\nrequest');
 assert.deepEqual(conversation.pendingSubmits[0].attachmentIds,['file-a']);assert.equal(conversation.pendingSubmits[0].skillSnapshot[0].instructions,'Original instructions');
 assert.equal(conversation.draft,'Unsent composer draft');assert.deepEqual(conversation.draftAttachmentIds,['draft-file']);
});
test('editing blocks automatic consumption; only explicit release resumes',()=>{
 const conversation=create();assert.equal(Queue.beginEdit(conversation,'a'),true);assert.equal(Queue.shift(conversation),null);assert.equal(Queue.count(conversation),3);
 Queue.endEdit(conversation,'b');assert.equal(Queue.isBlocked(conversation),true);Queue.endEdit(conversation,'a');assert.equal(Queue.shift(conversation).id,'a');
 assert.equal(Queue.beginEdit(conversation,'a'),false);
});
test('async persistence locks consumption and a second edit until actual completion',async()=>{
 const conversation=create(),pending=defer(),saving=command(conversation,()=>pending.promise,{action:'edit',id:'a',goal:'Updated',expectedGoal:'First'});
 assert.equal(Queue.isBusy(conversation),true);assert.equal(Queue.anyBusy(),true);assert.equal(Queue.shift(conversation),null);
 await assert.rejects(command(conversation,async()=>true,{action:'remove',id:'b'}),{code:'QUEUE_BUSY'});
 pending.resolve(true);await saving;assert.equal(Queue.isBusy(conversation),false);assert.equal(Queue.shift(conversation).goal,'Updated');
});
test('removed or consumed entries cannot be edited, and stale text cannot overwrite newer text',async()=>{
 const conversation=create();Queue.shift(conversation);
 await assert.rejects(command(conversation,async()=>true,{action:'edit',id:'a',goal:'late'}),{code:'QUEUE_CONSUMED'});
 await assert.rejects(command(conversation,async()=>true,{action:'edit',id:'b',expectedGoal:'old',goal:'late'}),{code:'QUEUE_CONFLICT'});
 assert.equal(conversation.pendingSubmits[0].goal,'Second');
});
test('failure restores just owned goal while preserving subsequent fields and draft',async()=>{
 const conversation=create(),pending=defer(),saving=command(conversation,()=>pending.promise,{action:'edit',id:'a',goal:'Attempt',expectedGoal:'First'});
 conversation.pendingSubmits[0].attachmentIds.push('new-context');conversation.draft='Draft typed during persistence';
 Queue.enqueue(conversation,{goal:'Arrived meanwhile'});pending.reject(Error('disk full'));await assert.rejects(saving,/disk full/);
 assert.equal(conversation.pendingSubmits[0].goal,'First');assert.deepEqual(conversation.pendingSubmits[0].attachmentIds,['file-a','new-context']);assert.equal(Queue.count(conversation),4);assert.equal(conversation.draft,'Draft typed during persistence');
});
test('failed persistence never restores a later consumed item or replaces newer edit',async()=>{
 const conversation=create(),pending=defer(),saving=command(conversation,()=>pending.promise,{action:'edit',id:'a',goal:'Attempt'});
 conversation.pendingSubmits=conversation.pendingSubmits.filter(item=>item.id!=='a');pending.resolve(false);await assert.rejects(saving,{code:'QUEUE_SAVE'});assert.equal(Queue.list(conversation).some(item=>item.id==='a'),false);
 const next=defer(),again=command(conversation,()=>next.promise,{action:'edit',id:'b',goal:'Attempt'});conversation.pendingSubmits[0]={...conversation.pendingSubmits[0],goal:'new owner',editedAt:999};next.reject(Error('failed'));await assert.rejects(again);assert.equal(conversation.pendingSubmits[0].goal,'new owner');
});
test('drag order and keyboard deltas persist without mutating message objects',async()=>{
 const conversation=create(),a=conversation.pendingSubmits[0];
 await command(conversation,async()=>true,{action:'move',id:'a',beforeId:null});assert.deepEqual(Queue.list(conversation).map(item=>item.id),['b','c','a']);
 await command(conversation,async()=>true,{action:'move',id:'a',delta:-1});assert.deepEqual(Queue.list(conversation).map(item=>item.id),['b','a','c']);
 await command(conversation,async()=>true,{action:'move',id:'c',beforeId:'b'});assert.deepEqual(Queue.list(conversation).map(item=>item.id),['c','b','a']);assert.equal(conversation.pendingSubmits[2],a);
});
test('failed order save restores original positions and keeps new queue arrivals',async()=>{
 const conversation=create(),pending=defer(),saving=command(conversation,()=>pending.promise,{action:'move',id:'c',beforeId:'a'});
 const added=Queue.enqueue(conversation,{goal:'Added meanwhile'});pending.reject(Error('disk full'));await assert.rejects(saving);
 assert.deepEqual(Queue.list(conversation).map(item=>item.id),['a','b','c',added.id]);
});
test('failed move must not replace a later reorder',async()=>{
 const conversation=create(),pending=defer(),saving=command(conversation,()=>pending.promise,{action:'move',id:'c',beforeId:'a'});
 conversation.pendingSubmits.reverse();const later=conversation.pendingSubmits.map(item=>item.id);pending.resolve(false);await assert.rejects(saving);assert.deepEqual(Queue.list(conversation).map(item=>item.id),later);
});
test('failed remove restores original attachment and skills payload but preserves fresh arrivals',async()=>{
 const conversation=create(),original=conversation.pendingSubmits[0],pending=defer(),saving=command(conversation,()=>pending.promise,{action:'remove',id:'a'});
 const added=Queue.enqueue(conversation,{goal:'New'});pending.reject(Error('write failed'));await assert.rejects(saving);assert.equal(conversation.pendingSubmits[0],original);assert.equal(conversation.pendingSubmits.at(-1),added);
});
test('successful changes survive actual JSON disk reload including frozen Skills',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'aibro-queue-test-')),file=path.join(dir,'queue.json'),conversation=create();
 const save=async()=>{await fs.writeFile(file,JSON.stringify(conversation));return true;};
 try{await command(conversation,save,{action:'edit',id:'a',goal:'Edited on disk'});await command(conversation,save,{action:'move',id:'b',delta:-1});const loaded=JSON.parse(await fs.readFile(file,'utf8'));assert.deepEqual(loaded.pendingSubmits.map(item=>item.id),['b','a','c']);assert.equal(loaded.pendingSubmits[1].goal,'Edited on disk');assert.equal(loaded.pendingSubmits[1].skillSnapshot[0].instructions,'Original instructions');assert.equal(loaded.draft,'Unsent composer draft');}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('empty and missing persistence are rejected without partial mutation',async()=>{
 const conversation=create();await assert.rejects(command(conversation,async()=>true,{action:'edit',id:'a',goal:'  '}));assert.equal(conversation.pendingSubmits[0].goal,'First');
 await assert.rejects(command(conversation,null,{action:'remove',id:'a'}),{code:'QUEUE_SAVE'});assert.equal(Queue.count(conversation),3);
});

test('enqueue, injection and editing preserve long Unicode source without arbitrary content limits',async()=>{
 const conversation=create(),goal='```text\n'+('0123456789　中文😀\n'.repeat(1000))+'END\n```';
 const entry=Queue.enqueue(conversation,{goal,attachmentIds:Array.from({length:250},(_,i)=>'file-'+i)});
 assert.equal(entry.goal,goal);assert.equal(entry.attachmentIds.length,250);assert.equal(Queue.inject(conversation,{goal}).goal,goal);
 await command(conversation,async()=>true,{action:'edit',id:entry.id,goal:goal+'\nrevised'});assert.equal(Queue.list(conversation).at(-1).goal,goal+'\nrevised');
});

test('whole context edit is isolated and retains entry identity, position, metadata and composer',async()=>{
 const conversation=create(),original=conversation.pendingSubmits[0],expectedContext=Queue.snapshot(original),context=Queue.snapshot(original);
 context.goal='Revised';context.attachmentIds=['b'];context.fileReferences=[{type:'note',id:'note',version:'v'}];context.skillSnapshot=[];
 await command(conversation,async()=>true,{action:'edit',id:'a',context,expectedContext});context.fileReferences[0].version='changed outside';
 const saved=conversation.pendingSubmits[0];assert.equal(saved.id,'a');assert.equal(saved.at,1);assert.deepEqual(saved.attachmentIds,['b']);assert.equal(saved.fileReferences[0].version,'v');assert.deepEqual(saved.skillSnapshot,[]);
 assert.deepEqual(conversation.pendingSubmits.map(item=>item.id),['a','b','c']);assert.equal(conversation.draft,'Unsent composer draft');assert.deepEqual(expectedContext.attachmentIds,['file-a']);
});

test('context CAS rejects attachment, reference or instruction changes even when goal is unchanged',async()=>{
 for(const change of [item=>item.attachmentIds.push('later'),item=>item.fileReferences=[{type:'note',id:'n'}],item=>item.skillSnapshot[0].instructions='new owner']){
  const conversation=create(),expectedContext=Queue.snapshot(conversation.pendingSubmits[0]),context=Queue.snapshot(expectedContext);context.goal='Attempt';change(conversation.pendingSubmits[0]);
  await assert.rejects(command(conversation,async()=>true,{action:'edit',id:'a',context,expectedContext}),{code:'QUEUE_CONFLICT'});assert.equal(conversation.pendingSubmits[0].goal,'First');
 }
 const conversation=create(),context=Queue.snapshot(conversation.pendingSubmits[0]);await assert.rejects(command(conversation,async()=>true,{action:'edit',id:'a',context}),{code:'QUEUE_CONTEXT'});
});

test('context CAS ignores object property order while preserving array order',()=>{
 const a={goal:'x',attachmentIds:[],fileReferences:[{type:'note',id:'n',selection:{start:1,end:3}}],skillSnapshot:[]};
 assert.equal(Queue.sameContext(a,{...a,fileReferences:[{selection:{end:3,start:1},id:'n',type:'note'}]}),true);
 assert.equal(Queue.sameContext({...a,attachmentIds:['x','y']},{...a,attachmentIds:['y','x']}),false);
});

test('failed context save restores only its transaction and preserves new entries and metadata',async()=>{
 const conversation=create(),before=Queue.snapshot(conversation.pendingSubmits[0]),context={...Queue.snapshot(before),goal:'Attempt',attachmentIds:['new'],fileReferences:[],skillSnapshot:[]},pending=defer();
 const saving=command(conversation,()=>pending.promise,{action:'edit',id:'a',context,expectedContext:before});assert.equal(Queue.shift(conversation),null);
 conversation.pendingSubmits[0].diagnostic='foreign metadata';const arrived=Queue.enqueue(conversation,{goal:'new arrival'});pending.reject(Error('disk full'));await assert.rejects(saving,/disk full/);
 assert.deepEqual(Queue.snapshot(conversation.pendingSubmits[0]),before);assert.equal(conversation.pendingSubmits[0].diagnostic,'foreign metadata');assert.equal(conversation.pendingSubmits.at(-1),arrived);
 assert.equal(Object.hasOwn(conversation.pendingSubmits[0],'fileReferences'),false);assert.equal(Object.hasOwn(conversation.pendingSubmits[0],'editedAt'),false);
});

test('failed context save does not undo a newer in-place context edit or resurrect a removed entry',async()=>{
 for(const remove of [false,true]){
  const conversation=create(),before=Queue.snapshot(conversation.pendingSubmits[0]),context={...Queue.snapshot(before),goal:'Attempt',attachmentIds:['new']},pending=defer();
  const saving=command(conversation,()=>pending.promise,{action:'edit',id:'a',context,expectedContext:before});
  if(remove)conversation.pendingSubmits.shift();else conversation.pendingSubmits[0].attachmentIds.push('newer');
  pending.resolve(false);await assert.rejects(saving,{code:'QUEUE_SAVE'});
  if(remove)assert.equal(conversation.pendingSubmits.some(item=>item.id==='a'),false);else{assert.equal(conversation.pendingSubmits[0].goal,'Attempt');assert.deepEqual(conversation.pendingSubmits[0].attachmentIds,['new','newer']);}
 }
});

test('PDF read mode freezes at enqueue and survives text edit, reorder, consume and JSON reload',async()=>{
 const conversation=create(),input={goal:'PDF analysis',attachmentIds:['pdf'],pdfReadMode:'text'};
 const item=Queue.enqueue(conversation,input,12);input.pdfReadMode='original';assert.equal(item.pdfReadMode,'text');assert.equal(Queue.snapshot(item).pdfReadMode,'text');
 await command(conversation,async()=>true,{action:'edit',id:item.id,goal:'Revised PDF analysis'});
 await command(conversation,async()=>true,{action:'move',id:item.id,beforeId:'a'});
 const reloaded=JSON.parse(JSON.stringify(conversation)),consumed=Queue.shift(reloaded);assert.equal(consumed.pdfReadMode,'text');assert.equal(consumed.goal,'Revised PDF analysis');assert.deepEqual(consumed.attachmentIds,['pdf']);
});

test('PDF read mode participates in context CAS while omitted legacy mode equals original',async()=>{
 const conversation=create(),expectedContext=Queue.snapshot(conversation.pendingSubmits[0]);
 assert.equal(Queue.sameContext(expectedContext,{...expectedContext,pdfReadMode:'original'}),true);
 assert.equal(Queue.sameContext(expectedContext,{...expectedContext,pdfReadMode:'text'}),false);
 conversation.pendingSubmits[0].pdfReadMode='text';
 await assert.rejects(command(conversation,async()=>true,{action:'edit',id:'a',context:{...expectedContext,goal:'Stale update'},expectedContext}),{code:'QUEUE_CONFLICT'});
 assert.equal(conversation.pendingSubmits[0].goal,'First');assert.equal(conversation.pendingSubmits[0].pdfReadMode,'text');
 const current=Queue.snapshot(conversation.pendingSubmits[0]);
 await command(conversation,async()=>true,{action:'edit',id:'a',context:{...current,pdfReadMode:'original'},expectedContext:current});
 assert.equal(conversation.pendingSubmits[0].pdfReadMode,'original');
});

test('invalid explicit PDF modes are rejected without enqueuing or partially mutating context',async()=>{
 for(const mode of [undefined,null,'auto','TEXT','',false,{},[]]){
  const conversation=create(),before=JSON.stringify(conversation),expectedContext=Queue.snapshot(conversation.pendingSubmits[0]);
  assert.throws(()=>Queue.enqueue(conversation,{goal:'Invalid mode',pdfReadMode:mode}),{code:'QUEUE_CONTEXT'});
  assert.throws(()=>Queue.snapshot({...expectedContext,pdfReadMode:mode}),{code:'QUEUE_CONTEXT'});
  await assert.rejects(command(conversation,async()=>true,{action:'edit',id:'a',context:{...expectedContext,pdfReadMode:mode},expectedContext}),{code:'QUEUE_CONTEXT'});
  assert.equal(JSON.stringify(conversation),before);
 }
});

test('failed PDF context save restores legacy absence and never overwrites a newer read-mode choice',async()=>{
 for(const newer of [false,true]){
  const conversation=create(),expectedContext=Queue.snapshot(conversation.pendingSubmits[0]),pending=defer();
  const saving=command(conversation,()=>pending.promise,{action:'edit',id:'a',expectedContext,context:{...expectedContext,goal:'PDF update',pdfReadMode:'text'}});
  if(newer)conversation.pendingSubmits[0].pdfReadMode='original';
  pending.resolve(false);await assert.rejects(saving,{code:'QUEUE_SAVE'});
  if(newer){assert.equal(conversation.pendingSubmits[0].pdfReadMode,'original');assert.equal(conversation.pendingSubmits[0].goal,'PDF update');}
  else {assert.equal(Object.hasOwn(conversation.pendingSubmits[0],'pdfReadMode'),false);assert.equal(conversation.pendingSubmits[0].goal,'First');}
 }
});
