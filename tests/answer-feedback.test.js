const test = require('node:test');
const assert = require('node:assert/strict');
const Feedback = require('../app/answer-feedback.js');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
function fixture(overrides = {}) {
  const state = {conversations:[{id:'conversation',messages:[{id:'answer',role:'agent',text:'A completed answer',runId:'run'}],draft:''}],runs:[{id:'run',status:'completed'}]};
  const calls = {save:0,changed:0,staged:[]};
  const host = {getConversation:id=>state.conversations.find(c=>c.id===id),getRun:id=>state.runs.find(r=>r.id===id),save:async()=>{calls.save++;return true;},onChanged:()=>calls.changed++,stageDraft:async value=>{calls.staged.push(value);return true;},...overrides};
  return {state,calls,host,api:Feedback.createController(host),get message(){return state.conversations[0]?.messages[0]},get conversation(){return state.conversations[0]}};
}
test('feedback persists only its message field, can change rating, and can be removed',async()=>{
 const f=fixture();await f.api.commit('conversation','answer',{rating:'helpful'});assert.equal(f.message.answerFeedback.rating,'helpful');assert.equal(f.calls.save,1);
 await f.api.commit('conversation','answer',{rating:'unhelpful',reason:'accuracy',comment:' Incorrect date ',correction:'Use 2026'});assert.deepEqual({...f.message.answerFeedback,updatedAt:0},{version:1,rating:'unhelpful',reason:'accuracy',comment:'Incorrect date',correction:'Use 2026',updatedAt:0});
 assert.equal(f.message.text,'A completed answer');await f.api.commit('conversation','answer',null);assert.equal(Object.hasOwn(f.message,'answerFeedback'),false);assert.equal(f.calls.save,3);
});
test('saved feedback restores after serializing and reloading the actual message',async()=>{
 const f=fixture();await f.api.commit('conversation','answer',{rating:'helpful',comment:'Clear explanation'});const reload=JSON.parse(JSON.stringify(f.state));const api=Feedback.createController({getConversation:id=>reload.conversations.find(c=>c.id===id)});assert.equal(api.read('conversation','answer').comment,'Clear explanation');
});
test('a pending durable save disables another mutation and does not report completion early',async()=>{
 const d=deferred(), f=fixture({save:()=>d.promise});let done=false;const pending=f.api.commit('conversation','answer',{rating:'helpful'}).then(()=>done=true);assert.equal(f.api.anyBusy(),true);assert.equal(done,false);
 await assert.rejects(f.api.commit('conversation','answer',null),{code:'FEEDBACK_BUSY'});d.resolve(true);await pending;assert.equal(done,true);assert.equal(f.api.anyBusy(),false);
});
test('a false or rejected save restores the prior field without changing concurrent composer/transcript data',async()=>{
 for(const reject of [true,false]){const d=deferred(),f=fixture({save:()=>d.promise});const old={version:1,rating:'helpful',reason:'',comment:'Original',correction:'',updatedAt:1};f.message.answerFeedback=old;const pending=f.api.commit('conversation','answer',{rating:'unhelpful',comment:'New'});f.conversation.draft='Typed while saving';f.conversation.messages.push({id:'later',role:'user',text:'Newer'});reject?d.reject(Error('Disk offline')):d.resolve(false);await assert.rejects(pending);assert.deepEqual(f.message.answerFeedback,old);assert.equal(f.conversation.draft,'Typed while saving');assert.equal(f.conversation.messages.length,2);}
});
test('rollback finds an adopted snapshot but does not overwrite newer feedback',async()=>{
 const d=deferred(),f=fixture({save:()=>d.promise});const pending=f.api.commit('conversation','answer',{rating:'unhelpful'});f.state.conversations=JSON.parse(JSON.stringify(f.state.conversations));d.reject(Error('Failed'));await assert.rejects(pending);assert.equal(Object.hasOwn(f.message,'answerFeedback'),false);
 const d2=deferred();f.host.save=()=>d2.promise;const newer=f.api.commit('conversation','answer',{rating:'unhelpful'});f.message.answerFeedback={version:1,rating:'helpful',comment:'Other window'};d2.reject(Error('Failed'));await assert.rejects(newer);assert.equal(f.message.answerFeedback.comment,'Other window');
});
test('rollback never resurrects deleted messages or conversations',async()=>{
 const d=deferred(),f=fixture({save:()=>d.promise});const pending=f.api.commit('conversation','answer',{rating:'helpful'});f.state.conversations=[];d.reject(Error('Failed'));await assert.rejects(pending);assert.deepEqual(f.state.conversations,[]);
});
test('stale feedback or changed answer cannot be overwritten by an old editor',async()=>{
 const f=fixture();await f.api.commit('conversation','answer',{rating:'helpful'});await assert.rejects(f.api.commit('conversation','answer',{rating:'unhelpful'},{expected:null}),{code:'FEEDBACK_CONFLICT'});
 await assert.rejects(f.api.commit('conversation','answer',{rating:'unhelpful'},{expectedText:'Earlier answer'}),{code:'FEEDBACK_ANSWER_CHANGED'});assert.equal(f.message.answerFeedback.rating,'helpful');assert.equal(f.calls.save,1);
});
test('streaming, failed, cancelled, user and empty messages are not feedback targets',async()=>{
 for(const patch of [{live:true},{retryRunId:'run'},{role:'user'},{text:''},{deletedAt:1},{deleted:true},{status:'cancelled'},{status:'running'}]){const f=fixture();Object.assign(f.message,patch);await assert.rejects(f.api.commit('conversation','answer',{rating:'helpful'}),{code:'FEEDBACK_GONE'});assert.equal(f.calls.save,0);}
 for(const status of ['planning','running','failed','cancelled','awaiting-approval','rejected']){const f=fixture();f.state.runs[0].status=status;await assert.rejects(f.api.commit('conversation','answer',{rating:'helpful'}),{code:'FEEDBACK_GONE'});}
});
test('archived and deleted conversations cannot receive feedback',async()=>{
 for(const patch of [{archived:true},{archivedAt:1},{deleted:true},{deletedAt:1},{status:'archived'},{status:'deleted'}]){const f=fixture();Object.assign(f.conversation,patch);await assert.rejects(f.api.commit('conversation','answer',{rating:'helpful'}),{code:'FEEDBACK_GONE'});assert.equal(f.calls.save,0);}
});
test('private feedback is memory-only: no save call or enumerable message field, and no reload survival',async()=>{
 for(const flag of ['ephemeral','incognito','private']){const f=fixture({save:()=>{throw Error('Private feedback must not save')}});f.conversation[flag]=true;await f.api.commit('conversation','answer',{rating:'unhelpful',comment:'PRIVATE_FEEDBACK_SECRET'});assert.equal(f.api.read('conversation','answer').comment,'PRIVATE_FEEDBACK_SECRET');assert.equal(JSON.stringify(f.state).includes('PRIVATE_FEEDBACK_SECRET'),false);const fresh=Feedback.createController(f.host);assert.equal(fresh.read('conversation','answer'),null);await f.api.commit('conversation','answer',null);assert.equal(f.api.read('conversation','answer'),null);}
});
test('private feedback does not fall back to a persisted field',()=>{
 const f=fixture();f.conversation.ephemeral=true;f.message.answerFeedback={rating:'helpful',comment:'Older persisted data'};assert.equal(f.api.read('conversation','answer'),null);
});
test('invalid or overlong input cannot mutate state',async()=>{
 for(const value of [{rating:'neutral'},{rating:'helpful',reason:'invented'},{rating:'unhelpful',comment:'x'.repeat(4001)},{rating:'unhelpful',correction:'x'.repeat(4001)}]){const f=fixture();await assert.rejects(f.api.commit('conversation','answer',value));assert.equal(Object.hasOwn(f.message,'answerFeedback'),false);assert.equal(f.calls.save,0);}
});
test('missing durability interface refuses public feedback without optimistic mutation',async()=>{
 const f=fixture({save:null});await assert.rejects(f.api.commit('conversation','answer',{rating:'helpful'}),{code:'FEEDBACK_SAVE'});assert.equal(Object.hasOwn(f.message,'answerFeedback'),false);
});
test('continuation is explicit and uses only saved negative feedback',async()=>{
 const f=fixture();await f.api.commit('conversation','answer',{rating:'unhelpful',reason:'accuracy',comment:'Check the date',correction:'2026'});assert.equal(f.calls.staged.length,0);await f.api.stage('conversation','answer');assert.equal(f.calls.staged.length,1);assert.match(f.calls.staged[0].text,/A completed answer/);assert.match(f.calls.staged[0].text,/Check the date/);assert.match(f.calls.staged[0].text,/2026/);assert.equal(f.calls.staged[0].conversationId,'conversation');assert.equal(f.calls.save,1);
});
test('continuation is unavailable while saving, with empty detail, or after the target is archived',async()=>{
 const d=deferred(),f=fixture({save:()=>d.promise});const pending=f.api.commit('conversation','answer',{rating:'unhelpful'});await assert.rejects(f.api.stage('conversation','answer'),{code:'FEEDBACK_BUSY'});d.resolve(true);await pending;await assert.rejects(f.api.stage('conversation','answer'),{code:'FEEDBACK_EMPTY'});f.conversation.archived=true;await assert.rejects(f.api.stage('conversation','answer'),{code:'FEEDBACK_GONE'});assert.equal(f.calls.staged.length,0);
});
test('continuation propagates occupied-draft and save errors without losing saved feedback',async()=>{
 const f=fixture({stageDraft:async()=>false});await f.api.commit('conversation','answer',{rating:'unhelpful',comment:'Keep this'});await assert.rejects(f.api.stage('conversation','answer'),{code:'FEEDBACK_DRAFT'});f.host.stageDraft=async()=>{throw Error('Draft save unavailable')};await assert.rejects(f.api.stage('conversation','answer'),/Draft save unavailable/);assert.equal(f.api.read('conversation','answer').comment,'Keep this');
});
test('generated followup bounds the quote and preserves user text as text',()=>{
 const text=Feedback.suggestion({text:'a'.repeat(5000)},{rating:'unhelpful',comment:'<img onerror="bad">'});assert.ok(text.length<1000);assert.ok(text.includes('<img onerror="bad">'));assert.equal(Feedback.suggestion({text:'answer'},{rating:'helpful',comment:'Fine'}),'');
});

test('legacy completed local answers remain eligible, while an interrupted receipt does not',async()=>{
 for(const status of ['completed-local','completed-local-fallback','done']){const f=fixture();f.state.runs[0].status=status;await f.api.commit('conversation','answer',{rating:'helpful'});assert.equal(f.calls.save,1);}
 const f=fixture();f.message.runStatus='interrupted';await assert.rejects(f.api.commit('conversation','answer',{rating:'helpful'}),{code:'FEEDBACK_GONE'});
});
test('ordinary model history and history tools omit feedback until the user sends the staged draft',async()=>{
 const Context=require('../app/agent-context.js'),f=fixture();await f.api.commit('conversation','answer',{rating:'unhelpful',comment:'DO_NOT_SEND_FEEDBACK_AUTOMATICALLY'});
 const history=Context.history({agentRuns:[]},f.conversation,{goal:'Follow up'});
 assert.equal(history.text.includes('DO_NOT_SEND_FEEDBACK_AUTOMATICALLY'),false);
 assert.equal(JSON.stringify(Context.readHistory(f.conversation,{type:'history_read',messageId:'answer'})).includes('DO_NOT_SEND_FEEDBACK_AUTOMATICALLY'),false);
 assert.equal(JSON.stringify(Context.readHistory(f.conversation,{type:'history_search',query:''})).includes('DO_NOT_SEND_FEEDBACK_AUTOMATICALLY'),false);
});
