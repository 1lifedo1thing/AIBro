'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopConnectionSync, createLocalRequest } = require('../app/connection-sync-desktop');
const { createController } = require('../app/connection-sync-settings');
const { normalizeProfile } = require('../app/connection-vault');
const copy = value => structuredClone(value);
const fp = 'A'.repeat(43), secret = 'B'.repeat(43);
const snapshot = () => ({ session: { serverOrigin:'https://sync.example.test',accountId:'fixture_account',sessionId:'fixture_session',generation:1,nativeFence:fp },
  transport:{serverUrl:'http://127.0.0.1:12345/sync',sessionGeneration:secret} });
function adapterFixture() {
  let state=snapshot(), dependencies;const requests=[], reads=[], writes=[];
  const bridge={sessionSnapshot:async()=>copy(state),read:async args=>{reads.push(copy(args));return {revision:0,value:null};},
    compareAndSwap:async args=>{writes.push(copy(args));return {swapped:true};}};
  return {bridge,requests,reads,writes,set:fn=>fn(state),get:()=>dependencies,
    async create(request) { return createDesktopConnectionSync({bridge,request:request||(async(path,payload)=>{requests.push({path,payload});return {status:200,body:{ok:true}};}),
      createClient:args=>{dependencies=args;return {};}}); }};
}
const requestShape = session => ({operation:'status',session:Object.fromEntries(Object.entries(session).filter(([key])=>key!=='nativeFence')),deviceId:fp,deviceSecret:secret,payload:{}});
test('Mac adapter separates public binding from SSH transport; native fence never enters HTTP',async()=>{
  const f=adapterFixture(),adapter=await f.create(),d=f.get();
  await d.transport(requestShape(d.currentSession()));
  assert.equal(f.requests[0].payload.session.serverUrl,'http://127.0.0.1:12345/sync');
  assert.equal(f.requests[0].payload.session.serverOrigin,'https://sync.example.test');
  assert.equal(JSON.stringify(f.requests).includes('nativeFence'),false);
  assert.deepEqual(adapter.binding,{serverOrigin:'https://sync.example.test',accountId:'fixture_account'});
  await d.atomicVault.read(adapter.binding,{sessionFence:d.currentSession()});
  assert.equal(f.reads[0].sessionFence.nativeFence,fp);
  await d.atomicVault.compareAndSwap({binding:adapter.binding,sessionFence:d.currentSession(),expectedRevision:0,value:{}});
  assert.equal(f.writes[0].sessionFence.nativeFence,fp);
});
test('Mac adapter cannot acquire a new native fence for an old queued cloud request',async()=>{
  const f=adapterFixture();await f.create();const d=f.get(),request=requestShape(d.currentSession());
  f.set(state=>state.session.nativeFence='C'.repeat(43));
  await assert.rejects(d.transport(request),error=>error.code==='STALE_SESSION');assert.equal(f.requests.length,0);
});
test('late cloud response after native logout is rejected and native error codes are preserved safely',async()=>{
  const f=adapterFixture();await f.create(async()=>{f.bridge.sessionSnapshot=async()=>{throw Object.assign(Error('private detail'),{code:'CONNECTION_SESSION_CHANGED'});};return {status:200,body:{ok:true}};});
  await assert.rejects(f.get().transport(requestShape(f.get().currentSession())),error=>error.code==='STALE_SESSION'&&!error.message.includes('private detail'));
});
test('dispose prevents any subsequent local profile read',async()=>{
  const f=adapterFixture(),adapter=await f.create();adapter.dispose();await assert.rejects(adapter.activeProfiles(),error=>error.code==='STALE_SESSION');assert.equal(f.reads.length,0);
});
test('local transport request surface rejects arbitrary URL without fetch',async()=>{
  let calls=0;const request=createLocalRequest(async()=>{calls++;});await assert.rejects(request('https://other.example.test',{}));assert.equal(calls,0);
});

test('an unconnected local cloud session exposes the disconnected recovery path without opening the vault',async()=>{
  const states=[];let requests=0,connects=0;
  const request=createLocalRequest(async(path,options)=>{
    requests++;assert.equal(path,'/__cloud/connections/capabilities');assert.equal(options.method,'POST');
    return new Response(JSON.stringify({error:'private backend detail',code:'NOT_CONNECTED'}),{status:401,headers:{'Content-Type':'application/json'}});
  });
  const controller=createController({bridge:{},storage:{getItem:()=>null},request,
    connect:async()=>{connects++;throw Error('must not access a vault without a cloud session');},onChange:value=>states.push(copy(value))});
  assert.equal(await controller.refresh(),false);
  assert.equal(states.at(-1).phase,'disconnected');assert.equal(states.at(-1).busy,false);
  assert.equal(states.at(-1).message,'请先连接同步服务器。');assert.equal(states.at(-1).failure,true);
  assert.equal(requests,1);assert.equal(connects,0);assert.equal(JSON.stringify(states).includes('private backend detail'),false);
});

test('non-authentication capability failures do not masquerade as a disconnected cloud account',async()=>{
  for(const code of ['NETWORK','FORBIDDEN','CONNECTION_STORAGE_ERROR']){
    const states=[];let connects=0;
    const controller=createController({bridge:{},storage:{getItem:()=>null},
      request:async()=>{throw Object.assign(Error('private backend detail'),{code});},
      connect:async()=>{connects++;throw Error('must not attach after a failed capability check');},onChange:value=>states.push(copy(value))});
    assert.equal(await controller.refresh(),false);
    assert.notEqual(states.at(-1).phase,'disconnected');assert.equal(states.at(-1).busy,false);
    assert.equal(states.at(-1).failure,true);assert.equal(connects,0);
    assert.equal(JSON.stringify(states).includes('private backend detail'),false);
  }
});

function controllerFixture({ normalizeStored = false } = {}) {
  const data=new Map(), snapshots=[],sent=[];let saved={format:'aibro.connection-profile.v1',purpose:'chat',provider:'openai-compatible',authKind:'api-key',apiFormat:'chat-completions',baseUrl:'https://api.example.test/v1',model:'synthetic-v1',apiKey:'synthetic-key-never-in-UI'};
  let speech={format:'aibro.connection-profile.v1',purpose:'speech',provider:'aliyun',authKind:'api-key',apiFormat:'aliyun-multimodal',baseUrl:'https://speech.example.test/api/v1',model:'speech-v1',apiKey:'synthetic-speech-secret',language:'zh'};
  const exports=[];
  let profiles={},initialized=false,pending=null,sendHook=null;
  const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
  const info=()=>({deviceId:fp,publicJwk:{kty:'EC',crv:'P-256',x:'fixture',y:'fixture'},pendingOperation:pending?'pending-op':null});
  const client={pairingInfo:async()=>{if(!initialized)throw Object.assign(Error(),{code:'UNPAIRED'});return info();},
    initializeOwner:async()=>{initialized=true;},ownerState:async()=>({...info(),devices:[]}),
    saveProfiles:async changes=>{sent.push(copy(changes));pending=changes;await sendHook?.(changes);apply();},
    retryPending:async()=>apply()};
  function apply(){for(const item of pending||[])if(item.profile===null)delete profiles[item.profileId];else profiles[item.profileId]=normalizeStored?normalizeProfile(item.profile):copy(item.profile);pending=null;}
  const binding={serverOrigin:'https://sync.example.test',accountId:'fixture_account'};
  const connect=async()=>({binding,client,dispose(){},activeProfiles:async()=>copy(profiles),pairingCode:async()=>JSON.stringify({format:'aibro.connection-pairing.v1',...binding,publicJwk:info().publicJwk,fingerprint:fp}),
    exportSavedAPI:async()=>{exports.push('chat');return {profile:copy(saved),sourceDigest:saved.model};},verifySavedAPI:async digest=>{if(digest!==saved.model)throw Object.assign(Error(),{code:'SOURCE_CHANGED'});},
    exportSavedSpeech:async()=>{exports.push('speech');if(!speech)throw Object.assign(Error(),{code:'SOURCE_UNAVAILABLE'});return {profile:copy(speech),sourceDigest:speech.model};},verifySavedSpeech:async digest=>{if(digest!==speech?.model)throw Object.assign(Error(),{code:'SOURCE_CHANGED'});}});
  const controller=createController({storage,connect,bridge:{},request:async()=>({supported:true,requiresConfirmation:false}),getProtocol:()=> 'chat',onChange:state=>snapshots.push(copy(state))});
  return {controller,storage,sent,snapshots,exports,setSpeech:value=>{speech=value===null?null:{...speech,...value};},state:()=>snapshots.at(-1),setSaved:model=>{saved={...saved,model};},hook:fn=>{sendHook=fn;},
    transformSource(purpose,change){if(purpose==='chat')saved=change(copy(saved));else speech=change(copy(speech));},
    async start(){await controller.refresh();await controller.initialize();await controller.preview();await controller.publish();}};
}
test('settings publishes only previewed saved snapshot and never sends API key through React props',async()=>{
  const f=controllerFixture();await f.start();assert.equal(f.sent[0][0].profile.apiKey,'synthetic-key-never-in-UI');
  assert.equal(JSON.stringify(f.snapshots).includes('synthetic-key-never-in-UI'),false);assert.equal(f.state().following,true);
  await f.controller.preview();f.setSaved('changed-during-review');await f.controller.publish();assert.equal(f.sent.length,1);assert.equal(f.state().failure,true);
});
test('unknown delete ACK then retry never restores automatic sharing',async()=>{
  const f=controllerFixture();await f.start();f.hook(changes=>{if(changes[0].profile===null)throw Object.assign(Error(),{code:'NETWORK'});});
  await f.controller.remove();assert.equal(f.storage.getItem('aibro-connection-export-v1'),null);
  await f.controller.refresh();assert.equal(f.state().phase,'pending');await f.controller.retry();assert.equal(f.state().profiles.length,0);
  const count=f.sent.length;await f.controller.sourceChanged();assert.equal(f.sent.length,count);assert.equal(f.state().following,false);
});
test('saved API changes during pending sync coalesce and then send the newest saved version',async()=>{
  const f=controllerFixture();await f.start();let release,started;const held=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  f.hook(async changes=>{if(changes[0].profile?.model==='synthetic-v2'){started();await held;}});
  f.setSaved('synthetic-v2');const first=f.controller.sourceChanged();await entered;
  f.setSaved('synthetic-v3');await f.controller.sourceChanged();await f.controller.sourceChanged();release();await first;
  for(let i=0;i<20&&f.state().profiles[0]?.model!=='synthetic-v3';i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state().profiles[0].model,'synthetic-v3');assert.deepEqual(f.sent.map(batch=>batch[0].profile.model),['synthetic-v1','synthetic-v2','synthetic-v3']);
});
test('saved source is not read automatically before user has opted in',async()=>{
  const f=controllerFixture();await f.controller.sourceChanged();assert.equal(f.state().phase,'idle');assert.equal(f.sent.length,0);
});
test('failed durable opt-out prevents cloud mutation rather than claiming sharing stopped',async()=>{
  const f=controllerFixture();await f.start();const count=f.sent.length;
  f.storage.removeItem=async()=>{throw Error('synthetic disk failure');};await f.controller.remove();
  assert.equal(f.sent.length,count);assert.equal(f.state().following,true);assert.equal(f.state().failure,true);
});

test('speech-only publication preserves language, never exports chat and stores only the chosen follow intent',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();
  f.controller.purpose('chat',false);f.controller.purpose('speech',true);await f.controller.preview();
  assert.deepEqual(f.exports,['speech']);assert.equal(f.state().previews[0].purpose,'speech');assert.equal(f.state().previews[0].language,'zh');
  assert.equal(JSON.stringify(f.snapshots).includes('synthetic-speech-secret'),false);
  await f.controller.publish();assert.deepEqual(f.sent[0].map(p=>p.profileId),['mac-speech']);
  const following=JSON.parse(f.storage.getItem('aibro-connection-export-v1'));assert.equal(following.speech,true);assert.equal('apiFormat' in following,false);
  assert.deepEqual(f.state().followingPurposes,{chat:false,speech:true});
});
test('two selected purposes are one atomic batch and either changed digest blocks the entire next publication',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();f.controller.purpose('speech',true);
  await f.controller.preview();await f.controller.publish();assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].map(p=>p.profileId),['mac-chat','mac-speech']);
  await f.controller.preview();f.setSpeech({model:'speech-v2'});await f.controller.publish();
  assert.equal(f.sent.length,1);assert.equal(f.state().failure,true);assert.equal(JSON.stringify(f.snapshots).includes('synthetic-speech-secret'),false);
});
test('unavailable speech prevents partial chat sharing and never falls back to chat credentials',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();f.controller.purpose('speech',true);f.setSpeech(null);
  await f.controller.preview();assert.match(f.state().message,/语音/);assert.equal(f.state().preview,null);assert.deepEqual(f.state().previews,[]);
  await f.controller.publish();assert.equal(f.sent.length,0);assert.equal(f.storage.getItem('aibro-connection-export-v1'),null);
});
test('opting into speech preserves an earlier chat follow and removing speech with a lost ACK cannot republish it',async()=>{
  const f=controllerFixture();await f.start();f.controller.purpose('chat',false);f.controller.purpose('speech',true);await f.controller.preview();await f.controller.publish();
  assert.equal(f.state().followingPurposes.chat,true);assert.equal(f.state().followingPurposes.speech,true);
  f.hook(batch=>{if(batch[0].profileId==='mac-speech'&&batch[0].profile===null)throw Object.assign(Error(),{code:'NETWORK'});});
  await f.controller.remove('speech');const config=JSON.parse(f.storage.getItem('aibro-connection-export-v1'));assert.equal(config.apiFormat,'chat-completions');assert.equal('speech' in config,false);
  await f.controller.refresh();await f.controller.retry();f.setSaved('chat-new');await f.controller.sourceChanged();
  assert.deepEqual(f.sent.at(-1).map(p=>p.profileId),['mac-chat']);assert.equal(f.state().profiles.some(p=>p.id==='mac-speech'),false);
});
test('automatic refresh ignores draft selections and events for purposes never approved for sharing',async()=>{
  const f=controllerFixture();await f.start();f.controller.purpose('speech',true);f.controller.purpose('chat',false);
  const n=f.exports.length;await f.controller.sourceChanged('speech');assert.equal(f.exports.length,n);
  f.setSaved('chat-new');await f.controller.sourceChanged();assert.deepEqual(f.exports.slice(n),['chat']);assert.deepEqual(f.sent.at(-1).map(p=>p.profileId),['mac-chat']);
});
test('automatic dual-purpose source failure keeps both previously shared snapshots unchanged',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();f.controller.purpose('speech',true);await f.controller.preview();await f.controller.publish();
  f.setSaved('chat-new');f.setSpeech(null);await f.controller.sourceChanged();assert.equal(f.sent.length,1);assert.equal(f.state().failure,true);
  assert.equal(f.state().profiles.find(p=>p.id==='mac-chat').model,'synthetic-v1');
});
test('stopping chat sharing retains speech following and never reads chat on later source changes',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();f.controller.purpose('speech',true);await f.controller.preview();await f.controller.publish();
  await f.controller.remove('chat');const config=JSON.parse(f.storage.getItem('aibro-connection-export-v1'));assert.equal(config.speech,true);assert.equal('apiFormat' in config,false);
  const n=f.exports.length;f.setSpeech({model:'speech-v2'});await f.controller.sourceChanged();assert.deepEqual(f.exports.slice(n),['speech']);assert.deepEqual(f.sent.at(-1).map(p=>p.profileId),['mac-speech']);
});

test('a speech save arriving during chat opt-out is coalesced without restoring chat sharing',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();f.controller.purpose('speech',true);await f.controller.preview();await f.controller.publish();
  let release;const held=new Promise(r=>release=r);const persist=f.storage.setItem;
  f.storage.setItem=async(key,value)=>{await held;return persist(key,value);};
  const removing=f.controller.remove('chat');await new Promise(setImmediate);
  f.setSpeech({model:'speech-during-opt-out'});await f.controller.sourceChanged('speech');release();await removing;
  for(let i=0;i<20&&f.state().profiles.find(p=>p.id==='mac-speech')?.model!=='speech-during-opt-out';i++)await new Promise(r=>setImmediate(r));
  assert.equal(f.state().profiles.find(p=>p.id==='mac-speech').model,'speech-during-opt-out');
  assert.equal(f.state().profiles.some(p=>p.id==='mac-chat'),false);assert.deepEqual(f.sent.at(-1).map(p=>p.profileId),['mac-speech']);
});

test('automatic sharing ignores native dictionary field order for both opted-in purposes',async()=>{
  const f=controllerFixture({normalizeStored:true});await f.controller.refresh();await f.controller.initialize();f.controller.purpose('speech',true);await f.controller.preview();await f.controller.publish();
  for(const purpose of ['chat','speech'])f.transformSource(purpose,profile=>Object.fromEntries(Object.entries(profile).reverse()));
  await f.controller.sourceChanged();await f.controller.sourceChanged('speech');await f.controller.sourceChanged('chat');
  assert.equal(f.sent.length,1,'focus and save notifications must not create unchanged cloud versions');
  assert.equal(f.state().failure,false);
});

test('automatic speech sharing treats omitted and empty language as the same default',async()=>{
  const f=controllerFixture();f.transformSource('speech',profile=>{delete profile.language;return profile;});
  await f.controller.refresh();await f.controller.initialize();f.controller.purpose('chat',false);f.controller.purpose('speech',true);await f.controller.preview();await f.controller.publish();
  f.setSpeech({language:''});await f.controller.sourceChanged();assert.equal(f.sent.length,1);
  f.setSpeech({language:'zh'});await f.controller.sourceChanged();assert.equal(f.sent.length,2);assert.equal(f.sent[1][0].profile.language,'zh');
  f.setSpeech({language:''});await f.controller.sourceChanged();assert.equal(f.sent.length,3);
  f.transformSource('speech',profile=>{delete profile.language;return profile;});await f.controller.sourceChanged();assert.equal(f.sent.length,3);
});

test('automatic sharing still publishes actual source value changes once in one batch',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();f.controller.purpose('speech',true);await f.controller.preview();await f.controller.publish();
  f.transformSource('chat',profile=>({...profile,apiKey:'synthetic-replaced-key',baseUrl:'https://api2.example.test/v1',apiFormat:'responses'}));
  f.setSpeech({language:'en'});await f.controller.sourceChanged();
  assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].map(item=>item.profileId),['mac-chat','mac-speech']);
  assert.equal(f.sent[1][0].profile.apiKey,'synthetic-replaced-key');assert.equal(f.sent[1][1].profile.language,'en');
  await f.controller.sourceChanged();assert.equal(f.sent.length,2);assert.equal(JSON.stringify(f.snapshots).includes('synthetic-replaced-key'),false);
});

for(const purpose of ['chat','speech'])test(`first ${purpose} publication coalesces a saved change only after durable follow`,async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();
  f.controller.purpose('chat',purpose==='chat');f.controller.purpose('speech',purpose==='speech');await f.controller.preview();
  let entered,release;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  f.hook(async()=>{if(f.sent.length===1){entered();await held;}});
  const publishing=f.controller.publish();await started;const reads=f.exports.length;
  if(purpose==='chat')f.setSaved('updated-during-first-publish');else f.setSpeech({model:'updated-during-first-publish'});
  await f.controller.sourceChanged(purpose);await f.controller.sourceChanged(purpose);
  assert.equal(f.exports.length,reads);assert.equal(f.storage.getItem('aibro-connection-export-v1'),null);
  release();await publishing;for(let i=0;i<20&&(f.sent.length<2||f.state().busy);i++)await new Promise(setImmediate);
  assert.equal(f.sent.length,2);assert.equal(f.sent[1][0].profile.model,'updated-during-first-publish');
  assert.deepEqual(f.sent[1].map(item=>item.profileId),[`mac-${purpose}`]);assert.equal(f.state().following,true);
});

test('first publish waits for successful follow persistence before reading a newer secret',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();await f.controller.preview();
  let entered,release;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r),persist=f.storage.setItem;
  f.storage.setItem=async(key,value)=>{entered();await held;return persist(key,value);};
  const publishing=f.controller.publish();await started;const reads=f.exports.length;
  f.setSaved('saved-before-follow-commit');await f.controller.sourceChanged('chat');
  assert.equal(f.sent.length,1);assert.equal(f.exports.length,reads);assert.equal(f.storage.getItem('aibro-connection-export-v1'),null);
  release();await publishing;for(let i=0;i<20&&(f.sent.length<2||f.state().busy);i++)await new Promise(setImmediate);
  assert.equal(f.sent.length,2);assert.equal(f.sent[1][0].profile.model,'saved-before-follow-commit');
});

test('failed first follow persistence discards deferred changes without automatic secret reads',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();await f.controller.preview();
  let entered,release;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  f.hook(async()=>{entered();await held;});f.storage.setItem=async()=>{throw Error('synthetic disk failure');};
  const publishing=f.controller.publish();await started;const reads=f.exports.length;f.setSaved('not-authorized-for-follow');await f.controller.sourceChanged('chat');
  release();await publishing;await new Promise(setImmediate);
  assert.equal(f.state().failure,true);assert.equal(f.sent.length,1);assert.equal(f.exports.length,reads);assert.equal(f.storage.getItem('aibro-connection-export-v1'),null);
});

test('preview cancellation and unrelated first-publish events never authorize another source read',async()=>{
  const f=controllerFixture();await f.controller.refresh();await f.controller.initialize();await f.controller.preview();
  const reads=f.exports.length;await f.controller.sourceChanged('chat');f.controller.cancelPreview();await f.controller.sourceChanged();assert.equal(f.exports.length,reads);assert.equal(f.sent.length,0);
  await f.controller.preview();let entered,release;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  f.hook(async()=>{entered();await held;});const publishing=f.controller.publish();await started;const stagedReads=f.exports.length;
  f.setSpeech({model:'unapproved-speech'});await f.controller.sourceChanged('speech');release();await publishing;await new Promise(setImmediate);
  assert.equal(f.exports.length,stagedReads);assert.equal(f.sent.length,1);assert.equal(JSON.parse(f.storage.getItem('aibro-connection-export-v1')).speech,undefined);
});
