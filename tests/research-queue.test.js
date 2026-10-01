const test=require('node:test'),assert=require('node:assert/strict'),Q=require('../app/research-queue');
const fixture=()=>({projects:[{id:'p',workspace:'科研'},{id:'q',workspace:'科研'}],imports:Array.from({length:101},(_,i)=>({id:'s'+i,projectId:i<97?'p':'q',workspace:'科研'})),conversations:[],agentRuns:[],notes:[]});
test('hundreds of sources form persisted bounded batches without crossing projects',()=>{const s=fixture(),q=Q.create(s,s.imports.map(n=>n.id),'batch',1);assert.equal(q.researchQueue.items.length,14);assert.equal(q.researchQueue.items.flatMap(i=>i.ids).length,101);assert(q.researchQueue.items.every(i=>i.ids.length<=8));q.researchQueue.items.forEach(i=>Q.validate(s,i));assert.equal(q.researchQueue.status,'paused');const roundtrip=JSON.parse(JSON.stringify(q));assert.deepEqual(roundtrip,q);s.imports[0].projectId='q';assert.throws(()=>Q.validate(s,q.researchQueue.items[0]));});
test('restart pauses unfinished batch and does not count a text-only reply as analysis',()=>{const s=fixture(),c=Q.create(s,['s0'],'batch');s.conversations.push(c);c.researchQueue.status='active';c.researchQueue.instance='old';c.researchQueue.items[0].status='running';s.agentRuns.push({id:'r',conversationId:'batch_0',status:'completed'});assert.equal(Q.reconcile(s,'new'),true);assert.equal(c.researchQueue.status,'paused');assert.equal(c.researchQueue.items[0].status,'attention');assert.equal(Q.reconcile(s,'new'),false);});
test('draft output is distinct from completed analysis and missing output prevents completion',()=>{const s=fixture(),i={projectId:'p',ids:['s0','s1']};s.notes.push({id:'n',projectId:'p',aiDraft:{content:'Findings',sourceAttachmentIds:['s0']}});assert.equal(Q.outcome(s,i),'attention');s.notes[0].aiDraft.sourceAttachmentIds.push('s1');assert.equal(Q.outcome(s,i),'review');s.notes[0].archived=true;assert.equal(Q.outcome(s,i),'attention');});
test('queue survives state replacement during save and send, and does not send completed batches twice',async()=>{
 let s=fixture();s.imports=s.imports.slice(0,1);const q=Q.create(s,['s0'],'durable');q.researchQueue.status='active';s.conversations.push(q);let sent=0;
 Q.init({getState:()=>s,idle:()=>true,persist:async()=>{s=JSON.parse(JSON.stringify(s));},toast:message=>{throw Error(message);},stop:()=>{},send:async options=>{sent++;s=JSON.parse(JSON.stringify(s));s.agentRuns.push({id:'actual',conversationId:options.conversationId,status:'completed',results:[{type:'note',id:'draft',operation:'drafted'}]});s.notes.push({id:'draft',projectId:'p',aiDraft:{content:'Synthetic evidence',sourceAttachmentIds:['s0']}});}});
 await Q.tick();assert.equal(sent,1);assert.equal(s.conversations[0].researchQueue.items[0].status,'review');assert.equal(s.conversations[0].researchQueue.status,'completed');await Q.tick();assert.equal(sent,1);assert.equal(s.conversations[1].projectId,'p');
});
test('empty draft does not complete source processing',()=>{const s=fixture();s.notes=[{id:'n',projectId:'p',aiDraft:{content:'   ',sourceAttachmentIds:['s0']}}];assert.equal(Q.outcome(s,{projectId:'p',ids:['s0']}),'attention');});
test('foreign-project, missing-file and withdrawn-source drafts cannot finish a batch',()=>{
 const s=fixture(),item={projectId:'p',ids:['s0']};
 const note={id:'n',projectId:'q',aiDraft:{content:'Evidence to review',sourceAttachmentIds:['s0']}};s.notes.push(note);
 assert.equal(Q.outcome(s,item),'attention');note.projectId='p';assert.equal(Q.outcome(s,item),'review');
 note.wikiFileError='missing';assert.equal(Q.outcome(s,item),'attention');delete note.wikiFileError;
 note.sourceAttachmentIds=['s0'];note.aiDraft.sourceAttachmentIds=[];assert.equal(Q.outcome(s,item),'attention');
 note.aiDraft.sourceAttachmentIds=['s0'];s.imports[0].projectId='q';assert.equal(Q.outcome(s,item),'attention');
});
test('an unrelated pre-existing draft is not a successful outcome of the current batch run',()=>{
 const s=fixture(),item={projectId:'p',ids:['s0'],runId:'r'};
 s.notes.push({id:'n',projectId:'p',aiDraft:{content:'Evidence',sourceAttachmentIds:['s0']}});
 const run={id:'r',status:'completed',results:[]};s.agentRuns.push(run);
 assert.equal(Q.outcome(s,item),'attention');run.results.push({type:'note',id:'n',operation:'drafted'});assert.equal(Q.outcome(s,item),'review');
 run.status='failed';assert.equal(Q.outcome(s,item),'attention');
});
test('approved analysis in another project does not complete a source batch',()=>{
 const s=fixture(),item={projectId:'p',ids:['s0']};
 s.notes.push({id:'n',projectId:'q',kind:'资料分析',content:'The comparison establishes that the second method needs a separate ablation to distinguish its effects.',sourceAttachmentIds:['s0']});
 assert.equal(Q.outcome(s,item),'attention');s.notes[0].projectId='p';assert.equal(Q.outcome(s,item),'completed');
});

function preparingQueue(){
 let state=fixture(),idle=true,saves=0,sends=0;
 const queue=Q.create(state,['s0'],'preparing');queue.researchQueue.status='active';state.conversations.push(queue);
 let resolve,reject;const gate=new Promise((yes,no)=>{resolve=yes;reject=no;}),toasts=[];
 Q.init({getState:()=>state,idle:()=>idle,persist:async()=>{++saves;state=structuredClone(state);if(saves===1)await gate;},toast:message=>toasts.push(message),stop:()=>{},send:async options=>{
  assert.equal(Q.isStarting(),false);++sends;state=structuredClone(state);
  state.agentRuns.push({id:'prepared-run',conversationId:options.conversationId,status:'completed',results:[{type:'note',id:'prepared-note',operation:'drafted'}]});
  state.notes.push({id:'prepared-note',projectId:'p',aiDraft:{content:'Evidence from the prepared batch',sourceAttachmentIds:['s0']}});
 }});
 return {get state(){return state;},replace:()=>{state=structuredClone(state);},get queue(){return state.conversations.find(c=>c.id==='preparing');},get chat(){return state.conversations.find(c=>c.id==='preparing_0');},get batch(){return this.queue?.researchQueue.items.find(i=>i.id==='preparing_0');},get sends(){return sends;},get saves(){return saves;},setIdle:value=>{idle=value;},resolve,reject,toasts};
}

test('a busy host after preparation releases the live replacement batch and retries it once',async()=>{
 const h=preparingQueue(),pending=Q.tick();assert.equal(Q.isStarting(),true);const stale=h.batch;
 h.replace();h.setIdle(false);h.resolve();await pending;
 assert.equal(stale.status,'running');assert.equal(h.batch.status,'pending');assert.equal(h.queue.researchQueue.status,'active');assert.equal(h.sends,0);assert.equal(h.saves,2);assert.equal(Q.isStarting(),false);assert.deepEqual(h.toasts,[]);
 h.setIdle(true);await Q.tick();assert.equal(h.sends,1);assert.equal(h.batch.status,'review');assert.equal(h.queue.researchQueue.status,'completed');await Q.tick();assert.equal(h.sends,1);
});

test('preparation respects pause, deletion, skipped batches and replacement ownership',async t=>{
 const cases=[
  {name:'paused queue',edit:h=>{h.queue.researchQueue.status='paused';h.queue.researchQueue.error='user pause';},check:h=>{assert.equal(h.queue.researchQueue.status,'paused');assert.equal(h.queue.researchQueue.error,'user pause');assert.equal(h.batch.status,'pending');}},
  {name:'archived queue',edit:h=>{h.queue.archived=true;},check:h=>{assert.equal(h.queue.archived,true);assert.equal(h.batch.status,'running');}},
  {name:'deleted queue',edit:h=>{h.state.conversations=h.state.conversations.filter(c=>c.id!=='preparing');},check:h=>assert.equal(h.queue,undefined)},
  {name:'removed batch',edit:h=>{h.queue.researchQueue.items=[];},check:h=>assert.deepEqual(h.queue.researchQueue.items,[])},
  {name:'skipped batch',edit:h=>{h.batch.status='skipped';h.batch.error='user decision';},check:h=>{assert.equal(h.batch.status,'skipped');assert.equal(h.batch.error,'user decision');}},
  {name:'another execution instance',edit:h=>{h.queue.researchQueue.instance='new-owner';},check:h=>{assert.equal(h.queue.researchQueue.instance,'new-owner');assert.equal(h.batch.status,'running');}}
 ];
 for(const entry of cases)await t.test(entry.name,async()=>{const h=preparingQueue(),pending=Q.tick();h.replace();entry.edit(h);h.resolve();await pending;assert.equal(h.sends,0);assert.equal(Q.isStarting(),false);entry.check(h);assert.deepEqual(h.toasts,[]);});
});

test('preparation never sends an edited batch or processing conversation from stale references',async t=>{
 const cases=[
  {name:'source selection changed',edit:h=>{h.batch.ids=['s1'];},check:h=>assert.deepEqual(h.batch.ids,['s1'])},
  {name:'project changed',edit:h=>{h.batch.projectId='q';h.batch.ids=['s97'];},check:h=>{assert.equal(h.batch.projectId,'q');assert.deepEqual(h.batch.ids,['s97']);}},
  {name:'processing draft changed',edit:h=>{h.chat.draft='Keep my new draft';},check:h=>assert.equal(h.chat.draft,'Keep my new draft')},
  {name:'processing message added',edit:h=>{h.chat.messages.push({id:'new-user',role:'user',text:'A different request'});},check:h=>assert.equal(h.chat.messages[0].text,'A different request')},
  {name:'processing model changed',edit:h=>{h.chat.modelConfig={provider:'api',model:'new-choice',effort:'low'};},check:h=>assert.equal(h.chat.modelConfig.model,'new-choice')},
  {name:'processing conversation archived',edit:h=>{h.chat.archived=true;},check:h=>assert.equal(h.chat.archived,true)},
  {name:'processing conversation deleted',edit:h=>{h.state.conversations=h.state.conversations.filter(c=>c.id!=='preparing_0');},check:h=>assert.equal(h.chat,undefined)}
 ];
 for(const entry of cases)await t.test(entry.name,async()=>{const h=preparingQueue(),pending=Q.tick();h.replace();entry.edit(h);h.resolve();await pending;assert.equal(h.sends,0);assert.equal(h.batch.status,'pending');assert.equal(h.queue.researchQueue.status,'paused');assert.match(h.queue.researchQueue.error,/修改|删除|归档/);assert.equal(Q.isStarting(),false);entry.check(h);assert.deepEqual(h.toasts,[]);});
});

test('source availability is validated again after the durable preparation completes',async()=>{
 const h=preparingQueue(),pending=Q.tick();h.replace();h.state.imports.find(n=>n.id==='s0').projectId='q';h.resolve();await pending;
 assert.equal(h.sends,0);assert.equal(h.batch.status,'attention');assert.equal(h.queue.researchQueue.status,'paused');assert.match(h.queue.researchQueue.error,/已删除或移动/);assert.equal(h.toasts.length,1);assert.equal(Q.isStarting(),false);
});

test('resuming an edited batch cannot silently send the prepared chat with its old attachments',async()=>{
 const h=preparingQueue(),pending=Q.tick();h.replace();h.batch.ids=['s1'];h.resolve();await pending;
 assert.deepEqual(h.chat.draftAttachmentIds,['s0']);h.queue.researchQueue.status='active';await Q.tick();
 assert.equal(h.sends,0);assert.equal(h.batch.status,'attention');assert.equal(h.queue.researchQueue.status,'paused');assert.match(h.queue.researchQueue.error,/附件不一致/);assert.deepEqual(h.batch.ids,['s1']);assert.deepEqual(h.chat.draftAttachmentIds,['s0']);
});

test('a rejected preparation cannot pause an unrelated queue or overwrite a newer batch decision',async t=>{
 for(const changed of['deleted','skipped','new owner'])await t.test(changed,async()=>{
  const h=preparingQueue(),pending=Q.tick();h.replace();
  const unrelated=Q.create(h.state,['s1'],'other');unrelated.researchQueue.status='active';h.state.conversations.push(unrelated);
  if(changed==='deleted')h.state.conversations=h.state.conversations.filter(c=>c.id!=='preparing');
  else if(changed==='skipped')h.batch.status='skipped';else h.queue.researchQueue.instance='new-owner';
  const before=structuredClone(h.queue);h.reject(Error('storage rejected'));await pending;
  assert.equal(h.sends,0);assert.deepEqual(h.queue,before);assert.equal(h.state.conversations.find(c=>c.id==='other').researchQueue.status,'active');assert.equal(h.toasts[0],'storage rejected');assert.equal(Q.isStarting(),false);
 });
});

function checkpointQueue(phase='prepared',status='completed'){
 const state=fixture(),conversation=Q.create(state,['s0'],'checkpoint'),queue=conversation.researchQueue,item=queue.items[0];
 state.conversations.push(conversation,{id:item.id,workspace:'科研',projectId:'p',messages:[],attachments:['s0']});
 const run={id:'checkpoint-run',conversationId:item.id,status,mode:'ai',results:[{type:'note',id:'analysis',operation:'created'}],executionReceipt:{version:1,id:'receipt',phase,actions:[{type:'create_note'}]}};
 state.agentRuns.push(run);item.runId=run.id;item.status='attention';
 state.notes.push({id:'analysis',projectId:'p',kind:'资料分析',content:'The evidence establishes a concrete comparison, with limitations and a separate ablation required to distinguish the observed effects.',sourceAttachmentIds:['s0']});
 return {state,conversation,queue,item,run};
}
const checkpointHint=phase=>phase==='applied'?/打开结果.*继续保存结果/:/打开结果.*继续完成整理/;

test('pending receipt overrides completed analysis and blocks retry and skip without changing execution state',async t=>{
 for(const phase of ['prepared','applied'])for(const status of ['completed','failed','awaiting-save'])await t.test(`${phase} / ${status}`,()=>{
  const h=checkpointQueue(phase,status),before=structuredClone(h.state);
  assert.equal(Q.outcome(h.state,h.item),'attention');
  assert.throws(()=>Q.retryBatch(h.state,h.conversation.id,h.item.id),checkpointHint(phase));
  assert.throws(()=>Q.skipBatch(h.state,h.conversation.id,h.item.id),checkpointHint(phase));
  assert.deepEqual(h.state,before,'A blocked queue action must not touch the run, receipt, results or batch');
 });
});

test('all batch-linked runs are checked even when the batch reference is missing or a newer run completed',async t=>{
 for(const link of ['conversation','batch','run'])await t.test(link,()=>{
  const h=checkpointQueue('applied');
  if(link==='conversation')delete h.item.runId;
  if(link==='batch'){h.run.conversationId='other-chat';h.run.researchBatchId=h.item.id;h.run.researchQueueId=h.conversation.id;h.item.runId='newer';}
  if(link==='run')h.run.conversationId='other-chat';
  h.state.agentRuns.push({id:'newer',conversationId:h.item.id,status:'completed',executionReceipt:{phase:'committed'}});
  assert.equal(Q.outcome(h.state,h.item),'attention');assert.throws(()=>Q.retryBatch(h.state,h.conversation.id,h.item.id),checkpointHint('applied'));assert.throws(()=>Q.skipBatch(h.state,h.conversation.id,h.item.id),checkpointHint('applied'));
 });
});

test('reconciliation pauses stale completed batches for pending receipts and remains idempotent across phases',()=>{
 const h=checkpointQueue('prepared');h.item.status='completed';h.queue.status='completed';h.queue.instance='same';
 const second={id:'checkpoint_1',projectId:'p',ids:['s1'],status:'skipped'};h.queue.items.push(second);
 h.state.agentRuns.push({id:'second',conversationId:second.id,status:'completed',executionReceipt:{phase:'applied'}});
 const executions=structuredClone(h.state.agentRuns),notes=structuredClone(h.state.notes);
 assert.equal(Q.reconcile(h.state,'same'),true);assert.equal(h.queue.status,'paused');assert.equal(h.item.status,'attention');assert.equal(second.status,'attention');assert.match(h.item.error,checkpointHint('prepared'));assert.match(second.error,checkpointHint('applied'));
 assert.equal(Q.reconcile(h.state,'same'),false);assert.deepEqual(h.state.agentRuns,executions);assert.deepEqual(h.state.notes,notes);
});

test('pending checkpoints prevent tick from starting a provider run even with an idle host and a pending batch',async t=>{
 for(const phase of ['prepared','applied'])await t.test(phase,async()=>{
  const h=checkpointQueue(phase);h.queue.status='active';h.item.status='pending';let sends=0,saves=0;
  Q.init({getState:()=>h.state,idle:()=>true,persist:async()=>{saves++;},send:async()=>{sends++;},toast:message=>assert.fail(message)});
  await Q.tick();assert.equal(sends,0);assert.equal(saves,1);assert.equal(h.queue.status,'paused');assert.equal(h.item.status,'attention');assert.equal(h.item.runId,h.run.id);assert.match(h.item.error,checkpointHint(phase));assert.equal(h.state.agentRuns.length,1);
 });
});

test('a receipt appearing in replacement state during durable preparation blocks the imminent send',async t=>{
 for(const phase of ['prepared','applied'])await t.test(phase,async()=>{
  const h=preparingQueue(),pending=Q.tick(),stale=h.batch;h.replace();
  const run={id:'during-preparation',conversationId:h.chat.id,status:'completed',executionReceipt:{phase}};h.state.agentRuns.push(run);const before=structuredClone(run);
  h.resolve();await pending;
  assert.equal(h.sends,0);assert.equal(stale.status,'running');assert.equal(h.batch.status,'attention');assert.equal(h.batch.runId,run.id);assert.equal(h.queue.researchQueue.status,'paused');assert.match(h.batch.error,checkpointHint(phase));assert.deepEqual(h.state.agentRuns[0],before);assert.deepEqual(h.toasts,[]);
 });
});

test('a pending receipt returned by send pauses the queue instead of counting an existing analysis as completed',async t=>{
 for(const phase of ['prepared','applied'])await t.test(phase,async()=>{
  const h=checkpointQueue(phase);h.state.agentRuns=[];delete h.item.runId;h.item.status='pending';h.queue.status='active';let sends=0;
  Q.init({getState:()=>h.state,idle:()=>true,persist:async()=>{},toast:message=>assert.fail(message),stop(){},send:async()=>{sends++;h.state.agentRuns.push(h.run);}});
  await Q.tick();assert.equal(sends,1);assert.equal(h.item.status,'attention');assert.equal(h.queue.status,'paused');assert.match(h.item.error,checkpointHint(phase));await Q.tick();assert.equal(sends,1);
 });
});

test('committed receipts and unrelated pending receipts keep ordinary retry and skip behavior',()=>{
 const h=checkpointQueue('committed');h.state.agentRuns.push({id:'unrelated',conversationId:'another-batch',executionReceipt:{phase:'applied'}});
 assert.equal(Q.outcome(h.state,h.item),'completed');Q.retryBatch(h.state,h.conversation.id,h.item.id);assert.equal(h.item.status,'completed');
 h.item.status='attention';Q.skipBatch(h.state,h.conversation.id,h.item.id);assert.equal(h.item.status,'skipped');
 h.item.status='attention';h.state.notes=[];Q.retryBatch(h.state,h.conversation.id,h.item.id);assert.equal(h.item.status,'pending');
});

function queueDocument(){
 class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.events={};this.parent=null;this.textContent='';}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
  addEventListener(type,listener){this.events[type]=listener;}
  showModal(){this.open=true;}
  close(){this.open=false;this.events.close?.();}
  get isConnected(){return this.tagName==='body'||!!this.parent?.isConnected;}
 }
 const body=new Element('body'),all=(node=body)=>[node,...node.children.flatMap(child=>all(child))];
 return {body,createElement:tag=>new Element(tag),getElementById:id=>all().find(node=>node.id===id),button:text=>all().find(node=>node.tagName==='button'&&node.textContent===text)};
}

test('queue dialog disables pending actions and stale callbacks re-read the live receipt before retry or skip',async t=>{
 const previous=global.document;global.document=queueDocument();t.after(()=>{global.document.getElementById('researchQueueDialog')?.close();if(previous===undefined)delete global.document;else global.document=previous;});
 for(const phase of ['prepared','applied'])for(const label of ['重试本批','跳过本批']){
  const h=checkpointQueue('committed');let state=h.state,saves=0;const toasts=[];
  Q.init({getState:()=>state,idle:()=>false,persist:async()=>{saves++;},toast:message=>toasts.push(message)});
  Q.open();const original=global.document.button(label);assert.equal(original.disabled,false);const stale=structuredClone(h.state);
  state=structuredClone(state);state.agentRuns[0].executionReceipt.phase=phase;const liveBefore=structuredClone(state);
  await original.onclick();assert.deepEqual(state,liveBefore);assert.deepEqual(h.state,stale);assert.equal(saves,0);assert.match(toasts[0],checkpointHint(phase));
  global.document.getElementById('researchQueueDialog').close();Q.open();
  assert.equal(global.document.button('重试本批').disabled,true);assert.equal(global.document.button('跳过本批').disabled,true);assert.ok(global.document.button('查看结果 · '+(phase==='applied'?'继续保存':'继续整理')));
  global.document.getElementById('researchQueueDialog').close();
 }
});
