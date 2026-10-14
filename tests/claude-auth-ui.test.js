'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/claude-auth-ui.js'),'utf8');
const signedOut={available:true,loggedIn:false,authMethod:'none',localCLIOnly:true,dynamicTools:false};
const signedIn={...signedOut,loggedIn:true,authMethod:'claude.ai'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const flush=()=>new Promise(r=>setImmediate(r));
const uuid='ee85800a-f345-4f00-8b0e-190b7b36e6aa';
function harness({save=async()=>true,state={settings:{}}}={}){
  const nodes={provider:{value:'api'},claudeAuthPanel:{hidden:true}},calls=[],queues=new Map(),timers=new Map();let props,timerID=0,saves=0,changes=0;
  const context=vm.createContext({document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=>uuid},AbortController,
    setTimeout:(fn,ms)=>{const id=++timerID;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),addEventListener(){},
    HalaskaUI:{mount(host,name,value){assert.equal(host,nodes.claudeAuthPanel);assert.equal(name,'ClaudeAuthSurface');props=value;return{update:value=>props=value};}},
    fetch:async(path,init)=>{calls.push({path,method:init.method,body:init.body&&JSON.parse(init.body)});const next=queues.get(path)?.shift();assert.ok(next,'Unexpected request '+path);const value=await next();return{ok:value.status<400,json:async()=>value.body};}});
  vm.runInContext(source,context);const api=context.ClaudeAuth;
  const queue=(path,body,status=200)=>{if(!queues.has(path))queues.set(path,[]);queues.get(path).push(typeof body==='function'?body:async()=>({body,status}));};
  api.init({getState:()=>state,save:async()=>{saves++;return save();},onChange:()=>changes++});
  return{api,nodes,calls,timers,state,queue,get props(){return props;},get saves(){return saves;},get changes(){return changes;},
    async tick(){const pending=[...timers].filter(([,t])=>t.ms===1800);for(const[id,t]of pending){timers.delete(id);await t.fn();}await flush();},
    async select(){nodes.provider.value='claude-auth';api.providerChanged();await flush();}};
}
test('Claude provider only detects on selection, uses official aliases, and reads actual account status before every run',async()=>{
  const h=harness();assert.equal(h.calls.length,0);assert.equal(h.nodes.claudeAuthPanel.hidden,true);
  h.queue('/__claude/status',signedIn);await h.select();assert.equal(h.props.authenticated,true);assert.equal(h.nodes.claudeAuthPanel.hidden,false);
  assert.deepEqual(Array.from(h.api.models),['','sonnet','opus','haiku']);
  h.queue('/__claude/status',signedIn);await h.api.ensureReady();h.queue('/__claude/status',signedOut);await assert.rejects(h.api.ensureReady(),/尚未登录/);
  assert.equal(h.calls.length,3);assert.ok(h.calls.every(c=>c.path==='/__claude/status'));assert.equal(h.props.authenticated,false);
});
test('API key, environment token, third-party and unknown status cannot satisfy Claude account readiness',async()=>{
  const h=harness();
  for(const authMethod of ['api_key','oauth_token','api_key_helper','third_party','future-auth']){
    h.queue('/__claude/status',{...signedIn,authMethod});await assert.rejects(h.api.ensureReady(),/认证方式|无法确认/);
  }
  for(const change of [{available:false},{localCLIOnly:false},{dynamicTools:true},{loggedIn:'true'}]){
    h.queue('/__claude/status',{...signedIn,...change});await assert.rejects(h.api.ensureReady());
  }
});
test('user login uses one UUID, polls its operation, and then confirms actual official account without fetching a catalogue',async()=>{
  const h=harness();h.queue('/__claude/status',signedOut);await h.select();
  const start=deferred();h.queue('/__claude/login',()=>start.promise);const login=h.props.onLogin();await h.props.onLogin();assert.equal(h.calls.filter(c=>c.path==='/__claude/login').length,1);
  start.resolve({status:200,body:{requestId:uuid,status:'started',localCLIOnly:true}});await login;assert.equal(h.props.pending,true);
  h.queue('/__claude/operation?requestId='+uuid,{requestId:uuid,status:'running'});await h.tick();assert.equal(h.props.pending,true);
  h.queue('/__claude/operation?requestId='+uuid,{requestId:uuid,status:'completed'});h.queue('/__claude/status',signedIn);await h.tick();
  assert.equal(h.props.authenticated,true);assert.equal(h.props.pending,false);assert.deepEqual(h.calls.find(c=>c.path==='/__claude/login').body,{requestId:uuid});
  assert.equal([...h.timers.values()].filter(t=>t.ms===1800).length,0);assert.ok(!h.calls.some(c=>c.path.includes('models')));
});
test('cancel while login starts ignores late login and stale status responses, then allows a clean new login',async()=>{
  const h=harness();const oldStatus=deferred();h.queue('/__claude/status',()=>oldStatus.promise);const refresh=h.api.refresh();
  const start=deferred();h.queue('/__claude/login',()=>start.promise);const login=h.api.signIn();
  h.queue('/__claude/cancel',{requestId:uuid,cancelled:true});h.queue('/__claude/status',signedOut);await h.api.cancel();
  oldStatus.resolve({status:200,body:signedIn});start.resolve({status:200,body:{requestId:uuid,status:'started',localCLIOnly:true}});await Promise.all([refresh,login]);
  assert.equal(h.props.authenticated,false);assert.equal(h.props.pending,false);assert.equal(h.props.busy,false);
  assert.deepEqual(h.calls.find(c=>c.path==='/__claude/cancel').body,{requestId:uuid});assert.equal([...h.timers.values()].filter(t=>t.ms===1800).length,0);
  h.queue('/__claude/login',{requestId:uuid,status:'started',localCLIOnly:true});await h.api.signIn();assert.equal(h.props.pending,true);
});
test('explicit shared CLI logout confirmation is required and stale authenticated status cannot undo logout',async()=>{
  const h=harness();await h.api.signOut();assert.equal(h.calls.length,0);
  h.queue('/__claude/status',signedIn);await h.api.refresh();const old=deferred();h.queue('/__claude/status',()=>old.promise);const reading=h.api.refresh();
  h.props.onRequestLogout();assert.equal(h.props.logoutConfirmation,true);assert.equal(h.calls.filter(c=>c.path==='/__claude/logout').length,0);
  h.queue('/__claude/logout',{loggedIn:false});h.queue('/__claude/status',signedOut);await h.props.onConfirmLogout();old.resolve({status:200,body:signedIn});await reading;
  assert.equal(h.props.authenticated,false);assert.equal(h.props.logoutConfirmation,false);assert.deepEqual(h.calls.find(c=>c.path==='/__claude/logout').body,{confirmation:true});
});
test('model alias persists in existing state, save failure rolls back and unsupported aliases never write',async()=>{
  const h=harness({state:{settings:{claudeModel:'sonnet',unrelated:true}},save:async()=>false});await h.api.setModel('opus');assert.equal(h.state.settings.claudeModel,'sonnet');assert.equal(h.changes,0);assert.match(h.props.status,/未保存/);
  await h.api.setModel('invented-model');assert.equal(h.saves,1);assert.equal(h.state.settings.unrelated,true);
  const ok=harness({state:{settings:{claudeModel:'haiku'}}});await ok.api.setModel('');assert.equal(ok.state.settings.claudeModel,'');assert.equal(ok.changes,1);assert.equal(ok.calls.length,0);
  const reopened=harness({state:ok.state});assert.equal(reopened.api.model(),'');
});
test('failed status refresh never authorizes using cached login and cancellation during readiness rejects the run',async()=>{
  const h=harness();h.queue('/__claude/status',signedIn);await h.api.ensureReady();h.queue('/__claude/status',{error:{code:'CLI_ERROR',message:'状态检测失败'}},503);await assert.rejects(h.api.ensureReady(),/状态检测失败/);
  const old=deferred();h.queue('/__claude/status',()=>old.promise);const ready=h.api.ensureReady();h.queue('/__claude/login',{requestId:uuid,status:'started',localCLIOnly:true});await h.api.signIn();old.resolve({status:200,body:signedIn});await assert.rejects(ready,/状态已变化/);
});

test('cancel arriving before login registration retains the exact ID and cancels the late started process once',async()=>{
  const h=harness();const start=deferred();h.queue('/__claude/login',()=>start.promise);const login=h.api.signIn();
  h.queue('/__claude/cancel',{requestId:uuid,cancelled:false});const cancel=h.api.cancel();await flush();
  assert.equal(h.props.pending,true);assert.equal(h.props.busy,true);assert.match(h.props.status,/等待原登录启动回应/);
  await h.api.signIn();assert.equal(h.calls.filter(c=>c.path==='/__claude/login').length,1,'A different login cannot replace the cancelled-in-flight request');
  h.queue('/__claude/cancel',{requestId:uuid,cancelled:true});h.queue('/__claude/status',signedOut);
  start.resolve({status:200,body:{requestId:uuid,status:'started',localCLIOnly:true}});await Promise.all([login,cancel]);
  assert.deepEqual(h.calls.filter(c=>c.path==='/__claude/cancel').map(c=>c.body),[{requestId:uuid},{requestId:uuid}]);
  assert.equal(h.props.pending,false);assert.equal(h.props.busy,false);assert.equal(h.props.authenticated,false);
});
test('unconfirmed cancellation retains a retryable pending login and never loops or announces stopped',async()=>{
  const h=harness();h.queue('/__claude/login',{requestId:uuid,status:'started',localCLIOnly:true});await h.api.signIn();
  h.queue('/__claude/cancel',{requestId:uuid,cancelled:false});h.queue('/__claude/operation?requestId='+uuid,{requestId:uuid,status:'running'});await h.api.cancel();
  assert.equal(h.props.pending,true);assert.equal(h.props.busy,false);assert.match(h.props.status,/尚未确认.*停止/);assert.equal(h.calls.filter(c=>c.path==='/__claude/cancel').length,1);
});
test('a pending alias save cannot become the effective model before durable acknowledgement',async()=>{
  const save=deferred();const h=harness({state:{settings:{claudeModel:'sonnet'}},save:()=>save.promise});const saving=h.api.setModel('opus');assert.equal(h.api.model(),'sonnet');assert.equal(h.changes,0);
  save.resolve(true);await saving;assert.equal(h.api.model(),'opus');assert.equal(h.changes,1);
});
