const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const DraftReview = require('../app/draft-review.js');
const AgentQueue = require('../app/agent-queue.js');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const host = source.slice(source.indexOf('async function applySavedDraft('), source.indexOf('async function requestAgentPlan('));
function setup(save = async () => true, queued = false) {
  const note = {id:'n',title:'Original',content:'Human body',projectId:'p',updatedAt:1,aiDraft:{title:'Reviewed',content:'AI proposal',createdAt:2}};
  const conversation = {id:'c',projectId:'p',draft:queued?'':'采纳',messages:[{id:'prior',at:2,results:[{type:'note',id:'n'}]}]};
  const state = {notes:[note],projects:[{id:'p'}],conversations:[conversation],agentRuns:[],currentConversationId:'c'};
  const notices = [], input = {value:queued?'':'采纳'}; let serial=0, renders=0, flushes=0;
  const context = {state,DraftReview,structuredClone,Date,JSON,Error,sendMessage:{busy:false},saveDocumentDurably:save,
    beforePreviewLeave:async()=>true,uid:prefix=>`${prefix}-${++serial}`,toast:text=>notices.push(text),renderAll:()=>renders++,renderComposerQueue:()=>{},flushQueuedSubmit:()=>flushes++,$:()=>input,
    window:{DraftReview,AgentQueue,AgentQueueUI:{check:async()=>({canSend:true}),inspect:()=>({canSend:true}),isPaused:()=>false,isBusy:()=>false}}};
  vm.createContext(context);vm.runInContext(host,context);
  const entry = queued ? AgentQueue.enqueue(conversation,{goal:'采纳',attachmentIds:[]}) : null;
  const options = entry ? {queuedSubmitId:entry.id,queuedEntry:structuredClone(entry)} : {};
  return {context,state,note,conversation,input,notices,entry,run:()=>context.handleDraftCommand(conversation,'采纳',input,options),renders:()=>renders,flushes:()=>flushes};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
test('draft command awaits durable acknowledgement before clearing input or rendering success',async()=>{
  const gate=deferred(),f=setup(()=>gate.promise);const operation=f.run();
  while(!f.state.agentRuns.length)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.input.value,'采纳');assert.equal(f.renders(),0);assert.equal(f.context.sendMessage.busy,true);
  gate.resolve(true);await operation;assert.equal(f.input.value,'');assert.equal(f.note.content,'AI proposal');assert.equal(f.note.aiDraft,undefined);
  assert.equal(f.state.agentRuns.length,1);assert.equal(f.renders(),1);assert.equal(f.context.sendMessage.busy,false);
});
for(const queued of [false,true])test(`failed durable command retains draft, intent and no success receipt (queued=${queued})`,async()=>{
  const f=setup(async()=>false,queued),before=JSON.stringify(f.note);await f.run();
  assert.equal(JSON.stringify(f.note),before);assert.equal(f.state.agentRuns.length,0);assert.equal(f.conversation.messages.length,1);
  assert.equal(f.input.value,queued?'':'采纳');assert.equal(f.conversation.draft,queued?'':'采纳');assert.equal(f.renders(),0);assert.equal(f.flushes(),0);
  assert.match(f.notices[0],/保存/);if(queued)assert.equal(AgentQueue.list(f.conversation)[0],f.entry);
});
test('failed command rollback preserves later typing, messages and a newer AI draft',async()=>{
  const gate=deferred(),f=setup(()=>gate.promise);const operation=f.run();
  while(!f.state.agentRuns.length)await new Promise(resolve=>setImmediate(resolve));
  f.input.value='new typing';f.conversation.draft='new typing';const next={id:'later',text:'new message'};f.conversation.messages.push(next);
  f.note.aiDraft={content:'Newer proposal',createdAt:9};gate.reject(Error('disk full'));await operation;
  assert.equal(f.input.value,'new typing');assert.equal(f.conversation.draft,'new typing');assert.equal(f.conversation.messages.at(-1),next);
  assert.equal(f.note.aiDraft.content,'Newer proposal');assert.equal(f.state.agentRuns.length,0);
});
test('successful command does not clear input typed during acknowledgement',async()=>{
  const gate=deferred(),f=setup(()=>gate.promise);const operation=f.run();
  while(!f.state.agentRuns.length)await new Promise(resolve=>setImmediate(resolve));
  f.input.value='Follow up';f.conversation.draft='Follow up';gate.resolve(true);await operation;
  assert.equal(f.input.value,'Follow up');assert.equal(f.conversation.draft,'Follow up');
});
test('cancelled leave keeps proposal and queued item untouched',async()=>{
  let saves=0;const f=setup(async()=>{saves++;},true);f.context.beforePreviewLeave=async()=>false;
  const before=JSON.stringify(f.state);await f.run();assert.equal(JSON.stringify(f.state),before);assert.equal(saves,0);
});
