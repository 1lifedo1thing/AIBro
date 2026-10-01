const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm');

function load() {
  const source=fs.readFileSync(require.resolve('../app/project-automation'),'utf8');
  const sandbox={
    document:{createElement:()=>({style:{},append(){},setAttribute(){}}),querySelector:()=>null},
    fetch:async()=>({ok:false,json:async()=>({})}),
    setInterval:()=>0,clearInterval(){},setTimeout:()=>0,clearTimeout(){},
    AgentProgress:{duration:(from,to)=>`${Math.max(0,Math.round((to-from)/1000))} 秒`},
    storageHydrated:false,sendMessage:{},importMaterials:{},state:{},console
  };
  sandbox.globalThis=sandbox;
  vm.runInNewContext(source,sandbox);
  return sandbox.ProjectAutomation;
}

test('只有进行中或待审批的执行才有实时摘要',()=>{
  const PA=load();
  assert.equal(PA.progressSummary(null),null);
  assert.equal(PA.progressSummary(undefined),null);
  for(const status of ['completed','failed','cancelled','rejected','interrupted','queued'])
    assert.equal(PA.progressSummary({status,steps:[{text:'阶段',status:'running'}]}),null,status+' 不应产生实时摘要');
  assert.ok(PA.progressSummary({status:'running'}),'running 应产生摘要');
  assert.ok(PA.progressSummary({status:'awaiting-approval'}),'待审批应产生摘要');
});

test('阶段取最后一个进行中的步骤，全部完成时回退到最近一步',()=>{
  const PA=load();
  const running={status:'running',steps:[{text:'分析目标',status:'done'},{text:'读取资料',status:'running'},{text:'整理结果',status:'pending'}]};
  assert.equal(PA.progressSummary(running).phase,'读取资料');
  const settled={status:'running',steps:[{text:'分析目标',status:'done'},{text:'读取资料',status:'done'}]};
  assert.equal(PA.progressSummary(settled).phase,'读取资料','没有进行中步骤时显示最近一步，而不是空白');
  assert.equal(PA.progressSummary({status:'running',steps:[]}).phase,'','没有步骤时不得编造阶段文字');
  assert.equal(PA.progressSummary({status:'running'}).phase,'');
  assert.equal(PA.progressSummary({status:'running',steps:[{label:'以 label 记录',status:'running'}]}).phase,'以 label 记录');
});

test('进行中显示实测用时，待审批不显示计时',()=>{
  const PA=load();
  const at=1000000;
  const running={status:'running',startedAt:at,steps:[]};
  assert.equal(PA.progressSummary(running,at+45000).elapsed,'45 秒');
  const waiting={status:'awaiting-approval',startedAt:at,steps:[]};
  assert.equal(PA.progressSummary(waiting,at+45000).elapsed,'','等待审批时不应继续累计用时');
  assert.equal(PA.progressSummary(waiting).waiting,true);
  assert.equal(PA.progressSummary({status:'running',steps:[]}).elapsed,'','缺少开始时间时不显示耗时');
});

test('最近活动最多三条、倒序、单条截断到 40 字符',()=>{
  const PA=load();
  const run={status:'running',steps:[],activities:[
    {id:'a1',name:'读取文件'},{id:'a2',text:'分析目标与附件'},{id:'a3',name:'检索知识库'},
    {id:'a4',text:'x'.repeat(120)},{id:'a5',name:'整理'}
  ]};
  const summary=PA.progressSummary(run);
  assert.equal(summary.recent.length,3,'最多显示三条');
  assert.equal(summary.recent[0],'整理','应取最近的活动');
  assert.equal(summary.recent[1].length,40,'长文本应截断');
  assert.equal(summary.recent[2],'检索知识库');
  assert.deepEqual(PA.progressSummary({status:'running',steps:[],activities:[{id:'x'},{},null]}).recent,[]);
});

function executionFixture({skillsEnabled=true,saveResult=true}={}) {
 const calls=[],state={projects:[{id:'p',workspace:'科研'}],settings:{skillsEnabled},skills:[{id:'skill_disabled',name:'停用',command:'disabled',instructions:'DO_NOT_SEND',enabled:false}],conversations:[],agentRuns:[]};
 const sandbox={state,document:{documentElement:{lang:'zh'},querySelector:()=>null},WorkstationSkillsCore:require('../app/skills-core'),
  setInterval:()=>0,clearInterval(){},setTimeout:()=>0,clearTimeout(){},
  fetch:async(url,options)=>{calls.push({url,payload:options?JSON.parse(options.body):null});return{ok:true,json:async()=>({})};},
  saveDocumentDurably:async()=>saveResult,toast:message=>calls.push({toast:message}),stopCurrentRun(){},storageHydrated:false,importMaterials:{},
  sendMessage:async options=>{const conversation=state.conversations.find(c=>c.id===options.conversationId);calls.push({snapshot:sandbox.WorkstationSkillsCore.requestSnapshot(state,conversation),selection:[...conversation.skillIds]});state.agentRuns.push({...options,id:'run-fixture',status:'completed'});}};
 sandbox.globalThis=sandbox;vm.runInNewContext(fs.readFileSync(require.resolve('../app/project-automation'),'utf8'),sandbox);
 const claim={token:'synthetic-token',job:{id:'j',name:'组合工作流',projectId:'p',workspace:'科研',prompt:'核对资料',permissionMode:'request',skillIds:['builtin-materials','skill_deleted','skill_disabled','builtin-course'],skillId:'builtin-paper',attempt:{id:'a',expiresAt:Date.now()/1000+60}}};
 return{api:sandbox.ProjectAutomation,state,calls,claim,sandbox};
}
test('自动执行保留技能顺序，跳过删除与停用说明，并使用共享快照',async()=>{
 const f=executionFixture();await f.api.executeClaim(f.claim);
 const sent=f.calls.find(item=>item.snapshot);
 assert.deepEqual([...sent.selection],['builtin-materials','skill_disabled','builtin-course']);
 assert.deepEqual(sent.snapshot.map(item=>item.id),['builtin-materials','builtin-course']);
 assert.equal(f.state.conversations[0].skillId,'builtin-materials');
 assert.equal(f.calls.at(-2).payload.runId,'run-fixture');
});
test('全局停用与对话语义一致：保留任务选择且不注入工作流',async()=>{
 const f=executionFixture({skillsEnabled:false});await f.api.executeClaim(f.claim);
 assert.deepEqual(f.calls.find(item=>item.snapshot).snapshot,[]);
 assert.deepEqual([...f.state.conversations[0].skillIds],['builtin-materials','skill_disabled','builtin-course']);
});
test('旧自动任务 skillId 与显式空数组均正确执行',async()=>{
 for(const empty of [false,true]){const f=executionFixture();delete f.claim.job.skillIds;f.claim.job.skillId='builtin-course';if(empty)f.claim.job.skillIds=[];await f.api.executeClaim(f.claim);
 assert.deepEqual(f.calls.find(item=>item.snapshot).snapshot.map(item=>item.id),empty?[]:['builtin-course']);}
});
test('执行前持久化失败不得调用模型或发送已完成提示',async()=>{
 const f=executionFixture({saveResult:false});await f.api.executeClaim(f.claim);
 assert.equal(f.calls.some(item=>item.snapshot),false);
 assert.match(f.calls.find(item=>item.payload?.error).payload.error,/保存失败/);
 assert.equal(f.calls.some(item=>item.toast?.includes('已完成')),false);
 assert.equal(f.state.conversations.length,0,'failed first save must not leave a phantom automatic conversation');
});

function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function until(check){for(let index=0;index<20;index++){if(check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('Expected asynchronous scheduler boundary');}
function schedulerFixture(){
 const f=executionFixture(),flags={open:false,saving:false},s=f.sandbox;
 s.storageHydrated=true;s.serverConflict=false;s.$=()=>({value:''});s.currentConversation=()=>({draftAttachmentIds:[]});
 s.ConversationModels={isSaving:()=>flags.saving};s.document.querySelector=selector=>selector==='#modelPicker:not([hidden])'&&flags.open?{open:true}:null;
 Object.assign(f.claim.job,{status:'active',dueAt:0});
 s.fetch=async(url,options)=>{const payload=options?.body?JSON.parse(options.body):null;f.calls.push({url,payload});let value;
  if(url==='/__project/jobs')value=await(f.jobsGate?.promise||{jobs:[f.claim.job]});
  else if(url.endsWith('/claim'))value=await(f.claimGate?.promise||{...f.claim,claimed:true});
  else value={};return{ok:true,json:async()=>value};};
 const save=s.saveDocumentDurably;s.saveDocumentDurably=async()=>{f.calls.push({save:true});return f.saveGate?await f.saveGate.promise:save();};
 return Object.assign(f,{flags});
}
const actionCalls=(fixture,action)=>fixture.calls.filter(call=>call.url==='/__project/jobs'+(action?'/'+action:''));
function assertUnstarted(f,reason){
 assert.equal(f.calls.some(call=>call.snapshot),false);
 const finish=actionCalls(f,'finish');assert.equal(finish.length,1);assert.ok(!finish[0].payload.runId);assert.match(finish[0].payload.error,reason);
 assert.equal(f.calls.some(call=>call.toast?.includes('已完成')),false);assert.equal(f.api.isStarting(),false);
}
for(const blocker of ['open','saving']){
 test(`模型面板 ${blocker} 阻止空闲轮询，不领取自动任务`,async()=>{
  const f=schedulerFixture();f.flags[blocker]=true;await f.api.tick();assert.deepEqual(f.calls,[]);assert.equal(f.api.isStarting(),false);
 });
 test(`jobs 列表请求后模型 ${blocker}，返回时不领取且不写失败记录`,async()=>{
  const f=schedulerFixture();f.jobsGate=deferred();const pending=f.api.tick();assert.equal(f.api.isStarting(),true);
  f.flags[blocker]=true;f.jobsGate.resolve({jobs:[f.claim.job]});await pending;
  assert.equal(actionCalls(f,'').length,1);assert.equal(actionCalls(f,'claim').length,0);assert.equal(actionCalls(f,'finish').length,0);assert.equal(f.state.conversations.length,0);assert.equal(f.api.isStarting(),false);
 });
 test(`claim 返回前模型 ${blocker}，已领取的任务明确收尾为未启动`,async()=>{
  const f=schedulerFixture();f.claimGate=deferred();const pending=f.api.tick();await until(()=>actionCalls(f,'claim').length===1);assert.equal(f.api.isStarting(),true);
  f.flags[blocker]=true;f.claimGate.resolve({...f.claim,claimed:true});await pending;assertUnstarted(f,/模型设置尚未完成.*未启动/);
  assert.equal(f.state.conversations.length,0);assert.equal(f.calls.some(call=>call.save),false);
  assert.equal(actionCalls(f,'resume').length,0,'never undo a concurrent pause or archive');
 });
 test(`准备对话保存 ACK 前模型 ${blocker}，不会发送模型请求`,async()=>{
  const f=schedulerFixture();f.saveGate=deferred();const pending=f.api.tick();await until(()=>f.calls.some(call=>call.save));assert.equal(f.api.isStarting(),true);
  f.flags[blocker]=true;f.saveGate.resolve(true);await pending;assertUnstarted(f,/模型设置尚未完成.*未启动/);assert.equal(f.state.agentRuns.length,0);
 });
}
test('send preflight busy 阻止领取，claim 后变忙也不运行',async()=>{
 const f=schedulerFixture();f.sandbox.sendMessage.preflight={};await f.api.tick();assert.deepEqual(f.calls,[]);
 f.sandbox.sendMessage.preflight=null;f.claimGate=deferred();const pending=f.api.tick();await until(()=>actionCalls(f,'claim').length===1);
 f.sandbox.sendMessage.preflight={};f.claimGate.resolve({...f.claim,claimed:true});await pending;assertUnstarted(f,/当前交互尚未结束.*未启动/);
});
test('send 无新执行记录不得沿用同一 attempt 的旧完成记录',async()=>{
 const f=schedulerFixture();f.state.agentRuns.push({id:'old-run',automaticJobId:'j',automaticAttemptId:'a',status:'completed'});
 f.sandbox.sendMessage=async()=>{};await f.api.tick();assertUnstarted(f,/发送前检查未通过.*未启动/);
 assert.equal(f.state.agentRuns.length,1);assert.equal(actionCalls(f,'finish')[0].payload.runId,undefined);
});
test('isStarting 在领取、发送及 finish ACK 期间保持，真实完成后释放',async()=>{
 const f=schedulerFixture(),sendGate=deferred(),finishGate=deferred(),send=f.sandbox.sendMessage,fetch=f.sandbox.fetch;
 f.sandbox.sendMessage=async options=>{f.calls.push({sendEntered:true});await sendGate.promise;await send(options);};
 f.sandbox.fetch=async(url,options)=>{const result=await fetch(url,options);if(url.endsWith('/finish'))await finishGate.promise;return result;};
 const pending=f.api.tick();await until(()=>f.calls.some(call=>call.sendEntered));assert.equal(f.api.isStarting(),true);
 sendGate.resolve();await until(()=>actionCalls(f,'finish').length===1);assert.equal(f.api.isStarting(),true);assert.equal(actionCalls(f,'finish')[0].payload.runId,'run-fixture');
 assert.equal(actionCalls(f,'finish')[0].payload.error,undefined);finishGate.resolve();await pending;assert.equal(f.api.isStarting(),false);
 assert.ok(f.calls.some(call=>call.toast?.includes('已完成')));
});
