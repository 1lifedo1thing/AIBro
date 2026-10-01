const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../app/tool-scheduler'),D=require('../app/research-delegation'),K=require('../app/knowledge-access');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
test('neighbor requests keep their exact chunk version through scheduling',async()=>{
 const r={type:'neighbors',chunkId:'chunk:one',version:'v2',radius:2};let received;
 await S.create({run:{},execute:async request=>{received=request;return {entries:[]}}}).batch([r]);
 assert.deepEqual(received,r);
});
test('independent reads overlap, commands remain barriers and result order is stable',async()=>{
 const run={},events=[];let active=0,peak=0;const s=S.create({run,checkpoint:async()=>{},execute:async r=>{events.push('start'+r.id);peak=Math.max(peak,++active);if(r.type==='terminal')assert.equal(active,1);await delay(r.id==='a'?15:2);active--;events.push('end'+r.id);return {id:r.id};}});
 const result=await s.batch([{type:'read',id:'a'},{type:'read',id:'b'},{type:'terminal',id:'c'},{type:'search',id:'d'}]);
 assert.equal(peak,2);assert.deepEqual(result.map(x=>x.id),['a','b','c','d']);assert.ok(events.indexOf('startc')>events.indexOf('enda'));assert.ok(events.indexOf('startd')>events.indexOf('endc'));assert.ok(run.toolCalls.every(x=>x.status==='completed'));
});
test('queued entries are saved before execution; failed checkpoint never executes command',async()=>{
 const run={};let called=false;const s=S.create({run,checkpoint:async()=>{throw Error('disk full')},execute:async()=>{called=true}});
 await assert.rejects(s.batch([{type:'terminal',argv:['pwd']}]),/disk full/);assert.equal(called,false);
});
test('stop cancels in-flight reads and never launches queued command',async()=>{
 const c=new AbortController(),run={};let commands=0;
 const s=S.create({run,signal:c.signal,execute:async(r,{signal})=>{if(r.type==='terminal')commands++;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{code:'CANCELLED'})),{once:true}));}});
 const pending=s.batch([{type:'read'},{type:'read'},{type:'terminal'}]);await delay(5);c.abort();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(commands,0);assert.ok(run.toolCalls.every(x=>x.status==='cancelled'));
});
test('tool failure is recorded while independent results are retained',async()=>{const run={},s=S.create({run,execute:async r=>{if(r.id==='bad')throw Error('missing');return {text:'ok'}}});const result=await s.batch([{type:'read',id:'bad'},{type:'read',id:'good'}]);assert.equal(result[0].error,'missing');assert.equal(result[1].text,'ok');assert.equal(run.toolCalls[0].status,'failed');});
test('stop at result return preserves the received completed, failed or cancelled outcome before rejecting',async t=>{
 for(const [status,value] of [
  ['completed',{status:'completed',output:'command actually finished',receiptId:'receipt-ok'}],
  ['failed',{status:'failed',error:'command returned exit 1',exitCode:1,receiptId:'receipt-failed'}],
  ['cancelled',{status:'cancelled',error:'tool stopped after writing partial output',output:'partial',receiptId:'receipt-stopped'}]
 ])await t.test(status,async()=>{
  const c=new AbortController(),run={},snapshots=[];let calls=0;
  const s=S.create({run,signal:c.signal,checkpoint:async()=>{snapshots.push(JSON.parse(JSON.stringify(run.toolCalls)))},execute:async()=>{calls++;c.abort();return value;}});
  await assert.rejects(s.batch([{type:'terminal',id:'received'},{type:'terminal',id:'never-started'}]),{code:'CANCELLED'});
  assert.equal(calls,1);assert.equal(run.toolCalls[0].status,status);assert.deepEqual(run.toolCalls[0].result,value);
  assert.equal(run.toolCalls[0].error,undefined);assert.ok(run.toolCalls[0].finishedAt);assert.equal(run.toolCalls[1].status,'cancelled');
  assert.ok(snapshots.some(entries=>entries[0].status===status&&entries[0].result?.receiptId===value.receiptId));
  assert.deepEqual(snapshots.at(-1)[0].result,value);
 });
});
test('scope validation at result return rejects the batch without replacing an authoritative result',async()=>{
 const run={},scopeError=Object.assign(Error('project scope changed'),{code:'SCOPE_CHANGED'}),snapshots=[];let valid=true,calls=0;
 const value={status:'completed',output:'written before scope changed',receiptId:'scope-receipt'};
 const s=S.create({run,validate:()=>{if(!valid)throw scopeError;},checkpoint:async()=>{snapshots.push(JSON.parse(JSON.stringify(run.toolCalls)))},execute:async()=>{calls++;valid=false;return value;}});
 await assert.rejects(s.batch([{type:'terminal',id:'received'},{type:'terminal',id:'never-started'}]),error=>error===scopeError);
 assert.equal(calls,1);assert.equal(run.toolCalls[0].status,'completed');assert.deepEqual(run.toolCalls[0].result,value);assert.equal(run.toolCalls[0].error,undefined);
 assert.equal(run.toolCalls[1].status,'cancelled');assert.deepEqual(snapshots.at(-1)[0].result,value);
});
test('concurrent reads retain every returned receipt on stop and do not start queued reads or commands',async()=>{
 const c=new AbortController(),run={},bothStarted=deferred(),release=deferred(),started=[],snapshots=[];
 const s=S.create({run,signal:c.signal,concurrency:2,checkpoint:async()=>{snapshots.push(JSON.parse(JSON.stringify(run.toolCalls)))},execute:async request=>{
  started.push(request.id);if(started.length===2)bothStarted.resolve();await release.promise;return {text:'received '+request.id,receiptId:request.id};
 }});
 const batch=s.batch([{type:'read',id:'a'},{type:'read',id:'b'},{type:'read',id:'queued-read'},{type:'terminal',id:'queued-command'}]);
 await bothStarted.promise;c.abort();release.resolve();await assert.rejects(batch,{code:'CANCELLED'});
 assert.deepEqual(started,['a','b']);assert.deepEqual(run.toolCalls.map(entry=>entry.status),['completed','completed','cancelled','cancelled']);
 assert.deepEqual(run.toolCalls.slice(0,2).map(entry=>entry.result.receiptId),['a','b']);
 assert.deepEqual(snapshots.at(-1).slice(0,2).map(entry=>entry.result.receiptId),['a','b']);
});
test('post-result checkpoint failure stops the next command without erasing its received receipt',async()=>{
 const run={},saveError=Error('receipt save failed'),value={status:'completed',output:'effect already happened',receiptId:'saved-on-final-checkpoint'},snapshots=[];let calls=0,failed=false;
 const s=S.create({run,checkpoint:async()=>{
  if(run.toolCalls[0]?.result&&!failed){failed=true;throw saveError;}
  snapshots.push(JSON.parse(JSON.stringify(run.toolCalls)));
 },execute:async()=>{calls++;return value;}});
 await assert.rejects(s.batch([{type:'terminal',id:'received'},{type:'terminal',id:'never-started'}]),error=>error===saveError);
 assert.equal(calls,1);assert.equal(run.toolCalls[0].status,'completed');assert.deepEqual(run.toolCalls[0].result,value);assert.equal(run.toolCalls[0].error,undefined);
 assert.equal(run.toolCalls[1].status,'cancelled');assert.deepEqual(snapshots.at(-1)[0].result,value);
});
test('a failing checkpoint stops a parallel worker still awaiting permission to execute',async()=>{
 const run={},firstStarted=deferred(),releaseFirst=deferred(),receiptObserved=deferred(),waitingSave=deferred(),releaseSave=deferred(),started=[],saveError=Error('checkpoint failed');let saves=0;
 const s=S.create({run,concurrency:2,changed:()=>{if(run.toolCalls[0]?.result)receiptObserved.resolve();},checkpoint:async()=>{
  if(++saves===3){waitingSave.resolve();await releaseSave.promise;throw saveError;}
 },execute:async request=>{started.push(request.id);firstStarted.resolve();await releaseFirst.promise;return {receiptId:request.id,output:'already returned'};}});
 const batch=s.batch([{type:'read',id:'a'},{type:'read',id:'b'},{type:'read',id:'queued-read'},{type:'terminal',id:'queued-command'}]);
 await Promise.all([firstStarted.promise,waitingSave.promise]);releaseFirst.resolve();
 // Observe the receipt while worker b is still awaiting its serialized
 // pre-execution save. Neither wall-clock timing nor microtask counts are used.
 await receiptObserved.promise;assert.equal(run.toolCalls[0].result.receiptId,'a');
 releaseSave.resolve();await assert.rejects(batch,error=>error===saveError);
 assert.deepEqual(started,['a']);assert.equal(run.toolCalls[0].status,'completed');assert.equal(run.toolCalls[0].result.receiptId,'a');
 assert.equal(run.toolCalls[1].status,'failed');assert.equal(run.toolCalls[2].status,'cancelled');assert.equal(run.toolCalls[3].status,'cancelled');
});
test('restart recovery preserves received receipts from a stopped batch without replaying effects',async()=>{
 const c=new AbortController(),run={id:'r',status:'running',executionInstanceId:'old'},value={receiptId:'once',output:'created once'};let executions=0;
 const s=S.create({run,signal:c.signal,execute:async()=>{executions++;c.abort();return value;}});
 await assert.rejects(s.batch([{type:'terminal',id:'effect'},{type:'terminal',id:'not-executed'}]),{code:'CANCELLED'});
 const state=JSON.parse(JSON.stringify({agentRuns:[run]}));
 assert.equal(S.recover(state,'new'),true);assert.equal(S.recover(state,'new'),false);assert.equal(executions,1);
 assert.equal(state.agentRuns[0].status,'interrupted');assert.deepEqual(state.agentRuns[0].toolCalls[0].result,value);
 assert.deepEqual(state.agentRuns[0].toolCalls.map(entry=>entry.status),['completed','cancelled']);
});
test('history strips binary blocks, retains received output, and closes provider activities',()=>{assert.deepEqual(S.resultSnapshot({blocks:[{image_url:'private'}],text:'ok'}),{result:{text:'ok'},truncated:false});assert.deepEqual(S.resultSnapshot({text:'x'.repeat(40000)}),{result:{text:'x'.repeat(40000)},truncated:false});const run={};S.provider(run,{kind:'tool',id:'x',name:'web_search',status:'running',text:'search'});S.finish(run,'cancelled');assert.equal(run.toolCalls[0].status,'cancelled');});
const fixture=()=>({projects:[{id:'p'},{id:'q'}],notes:[{id:'a',projectId:'p',content:'Synthetic fact'},{id:'private',projectId:'q',content:'OTHER_PROJECT'}]});
test('child uses scoped real reads and returns traceable analysis without mutating library',async()=>{
 const state=fixture(),before=JSON.stringify(state),run={};let turns=0;
 const result=await D.execute({task:'Analyze a',title:'Evidence'},{state,scope:{projectId:'p'},run,entry:{id:'child'},read:r=>K.execute(state,{projectId:'p'},r),ask:async text=>{turns++;assert.doesNotMatch(text,/OTHER_PROJECT/);return turns===1?JSON.stringify({knowledgeRequests:[{type:'read',id:'a'}],actions:[]}):JSON.stringify({message:'Evidence from a: Synthetic fact',actions:[]});}});
 assert.equal(turns,2);assert.equal(result.readEvidence[0].id,'a');assert.equal(result.verified,false);assert.equal(JSON.stringify(state),before);assert.equal(run.toolCalls[0].parentId,'child');
});
test('child cannot execute terminal or mutate files; repeated invalid requests terminate',async()=>{
 let reads=0;const run={};await assert.rejects(D.execute({task:'bad'},{state:fixture(),scope:{projectId:'p'},run,entry:{id:'child'},read:async()=>{reads++},ask:async()=>JSON.stringify({knowledgeRequests:[{type:'terminal',argv:['touch','file']}],actions:[]})}),/重复/);assert.equal(reads,0);assert.equal(run.delegations[0].status,'failed');
 await assert.rejects(D.execute({task:'bad'},{state:fixture(),scope:{},run:{},entry:{id:'c'},ask:async()=>JSON.stringify({message:'written',actions:[],fileEdits:[{path:'x'}]})}),/写入/);
});
test('child returns missing source error to its next turn and remains project-scoped',async()=>{const state=fixture();let calls=0;const result=await D.execute({task:'read private'},{state,scope:{projectId:'p'},run:{},entry:{id:'child'},read:r=>K.execute(state,{projectId:'p'},r),ask:async text=>{if(++calls===1)return JSON.stringify({knowledgeRequests:[{type:'read',id:'private'}]});assert.match(text,/范围/);assert.doesNotMatch(text,/OTHER_PROJECT/);return JSON.stringify({message:'Unavailable',actions:[]})}});assert.equal(result.readEvidence.length,0)});
test('restart marks only previous service running work interrupted and never replays tools',()=>{const state={agentRuns:[{id:'a',conversationId:'c',status:'running',executionInstanceId:'old',toolCalls:[{status:'running'}],delegations:[{status:'running'}]},{id:'b',status:'running',executionInstanceId:'current'},{id:'c',status:'awaiting-approval',executionInstanceId:'old'}],conversations:[{id:'c',messages:[{runId:'a',live:true,text:'Progress'}]}]};assert.equal(S.recover(state,'current'),true);assert.equal(state.agentRuns[0].status,'interrupted');assert.equal(state.agentRuns[0].toolCalls[0].status,'interrupted');assert.equal(state.conversations[0].messages[0].retryRunId,'a');assert.equal(state.agentRuns[1].status,'running');assert.equal(state.agentRuns[2].status,'awaiting-approval');assert.equal(S.recover(state,'current'),false);});

test('repeat protection blocks only the repeated upcoming request, without poisoning corrective work or siblings',async()=>{
 const before=global.ToolLoopGuard;global.ToolLoopGuard=require('../app/tool-loop-guard');
 try{
  const run={toolCalls:Array.from({length:4},(_,i)=>({id:'old'+i,parentId:'child-old',request:{type:'read',id:'old'},status:'completed'}))};
  let calls=0;
  const old=S.create({run,parentId:'child-old',execute:async r=>{calls++;return {id:r.id}}});
  await old.batch([{type:'read',id:'new'}]);
  await assert.rejects(old.batch([{type:'read',id:'old',offset:0,recordType:'note',variant:'current'}]),{code:'REPEATED_TOOL'});
  const sibling=S.create({run,parentId:'child-new',execute:async()=>{calls++;return {text:'independent'}}});
  await sibling.batch([{type:'read',id:'old'}]);
  assert.equal(calls,2);
 }finally{if(before===undefined)delete global.ToolLoopGuard;else global.ToolLoopGuard=before;}
});
