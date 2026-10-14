const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../app/tool-scheduler'),C=require('../app/agent-context');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const call=(id,type,status,extra={})=>({id,type,status,request:{type},...extra});

test('restart: an acting tool that was running is outcome unknown; reads simply failed; queued tools never started',()=>{
 const state={agentRuns:[{id:'r',conversationId:'c',status:'running',executionInstanceId:'old',toolCalls:[
  call('cmd','terminal','running'),call('click','browser_click','running',{dispatchedAt:1}),call('later','terminal','queued'),
  call('read','read','running'),call('snap','browser_snapshot','running')]}],conversations:[]};
 assert.equal(S.recover(state,'new'),true);
 const [cmd,click,later,read,snap]=state.agentRuns[0].toolCalls;
 assert.deepEqual([cmd.outcome,click.outcome,later.outcome,read.outcome,snap.outcome],['unknown','unknown','not-started',undefined,undefined]);
 assert.ok(cmd.status==='interrupted'&&cmd.finishedAt);assert.match(cmd.error,/无法确认是否已执行/);assert.match(cmd.error,/不会自动重跑/);
 assert.equal(S.outcome(read),'failed','a read without a receipt has no effect to verify');
 assert.deepEqual(S.unconfirmed(state.agentRuns[0]).map(c=>c.id),['cmd','click']);
 assert.equal(S.isIssue(cmd),true);
});

test('stopping before a queued command is dispatched records it as not started',async()=>{
 const c=new AbortController(),run={};let commands=0;
 const s=S.create({run,signal:c.signal,execute:async(r,{signal})=>{if(r.type==='terminal')commands++;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{code:'CANCELLED'})),{once:true}));}});
 const pending=s.batch([{type:'read'},{type:'terminal'}]);await delay(5);c.abort();
 await assert.rejects(pending,{code:'CANCELLED'});assert.equal(commands,0);
 const command=run.toolCalls[1];
 assert.equal(command.status,'cancelled');assert.equal(command.outcome,'not-started');assert.equal(S.outcome(command),'not-started');
 assert.deepEqual(S.unconfirmed(run),[],'nothing was dispatched without a receipt');
});

test('a failed pre-execution checkpoint leaves every entry not started with the real reason',async()=>{
 const run={};let called=false;
 const s=S.create({run,checkpoint:async()=>{throw Error('disk full')},execute:async()=>{called=true}});
 await assert.rejects(s.batch([{type:'terminal',argv:['pwd']}]),/disk full/);assert.equal(called,false);
 assert.deepEqual([run.toolCalls[0].status,run.toolCalls[0].outcome,run.toolCalls[0].error],['failed','not-started','disk full']);
});

test('run end marks an in-flight acting tool unknown but keeps provider and read activity as before',()=>{
 const run={toolCalls:[call('cmd','terminal','running',{dispatchedAt:5}),call('read','search','running')]};
 S.provider(run,{kind:'tool',id:'x',name:'web_search',status:'running',text:'search'});
 S.finish(run,'cancelled');
 assert.deepEqual(run.toolCalls.map(c=>[c.status,c.outcome]),[['cancelled','unknown'],['cancelled',undefined],['cancelled',undefined]]);
 assert.deepEqual(S.unconfirmed(run).map(c=>c.id),['cmd']);
});

test('records saved before outcomes existed are read conservatively',()=>{
 assert.equal(S.outcome(call('a','terminal','interrupted')),'unknown');
 assert.equal(S.outcome(call('b','terminal','cancelled',{error:'未收到工具完成结果，请核对执行记录。'})),'unknown','old host-written stop text');
 assert.equal(S.outcome(call('c','terminal','cancelled',{error:'stopped by user'})),'cancelled','a cancellation the tool itself reported');
 assert.equal(S.outcome(call('d','read','interrupted')),'failed');
 assert.equal(S.outcome(call('e','terminal','completed')),'completed');
 assert.equal(S.outcome(call('f','terminal','timed_out')),'failed');
 assert.equal(S.outcome(call('g','terminal','queued')),'pending');
 assert.equal(S.outcome({id:'provider:main:1',type:'code_interpreter',status:'interrupted'}),'failed','provider-run tools cannot change local data');
});

test('model history lists unconfirmed tools for its run and explains how to treat them',()=>{
 const conversation={id:'c',messages:[{id:'m1',role:'user',text:'run the cleanup',at:1}]};
 const state={agentRuns:[
  {id:'clean',conversationId:'c',status:'completed',goal:'read notes',toolCalls:[call('r','read','completed')]},
  {id:'risky',conversationId:'c',status:'interrupted',goal:'run the cleanup',toolCalls:[call('cmd','terminal','interrupted',{outcome:'unknown',request:{type:'terminal',argv:['rm','-r','build']}})]}]};
 const envelope=JSON.parse(C.history(state,conversation,{maxTokens:3500}).text);
 const risky=envelope.operations.find(o=>o.runId==='risky'),clean=envelope.operations.find(o=>o.runId==='clean');
 assert.equal(risky.unconfirmedTools.length,1);assert.equal(risky.unconfirmedTools[0].type,'terminal');assert.match(risky.unconfirmedTools[0].request,/build/);
 assert.equal('unconfirmedTools' in clean,false);
 assert.match(envelope.unconfirmedNotice,/先核对实际状态/);
 const quiet=JSON.parse(C.history({agentRuns:[state.agentRuns[0]]},conversation,{maxTokens:3500}).text);
 assert.equal('unconfirmedNotice' in quiet,false);
});
