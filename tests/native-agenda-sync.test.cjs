const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync('native/Resources/agenda-sync.js','utf8');
const note=(id,title='原日程')=>({id,kind:'日程',title,content:JSON.stringify({format:'aibro.agenda.v1',title,start:1,end:2})});
function setup(){
 let saves=0,flushes=0,queued=0;
 const c={window:{flushWorkspace:async()=>{flushes++}},storageHydrated:true,serverConflict:false,serverSaveInFlight:false,serverSaveQueued:false,sendMessage:{busy:false},purgeTrash:{syncPaused:false},state:{notes:[note('a')]},saveDocumentDurably:async()=>{saves++;return true},save(){queued++},renderAll(){}};
 vm.createContext(c);vm.runInContext(code,c);return {c,api:c.window.NativeAgendaSync,saves:()=>saves,flushes:()=>flushes,queued:()=>queued};
}
const read=async api=>JSON.parse(await api.read());
const write=async(api,changes)=>JSON.parse(await api.write(changes));
const replacement=(snapshot,title='修改日程')=>[{id:'a',expected:snapshot.notes.a,note:JSON.stringify(note('a',title))}];
test('agenda bridge read is read-only; exact CAS changes save durably',async()=>{
 const {c,api,saves,flushes}=setup();const snapshot=await read(api);
 assert.equal(snapshot.status,'ready');assert.equal(snapshot.version,1);assert.equal(snapshot.stage,'read');
 assert.equal(flushes(),0);assert.equal(saves(),0);
 const result=await write(api,replacement(snapshot));
 assert.deepEqual(result,{version:1,stage:'write',status:'ready',accepted:['a']});
 assert.equal(saves(),1);assert.equal(c.state.notes[0].title,'修改日程');
});
test('stale baseline and invalid batch cannot partially modify native workspace notes',async()=>{
 const {c,api,saves}=setup();const snapshot=await read(api);c.state.notes[0].title='人编辑中';
 assert.equal((await write(api,replacement(snapshot))).reason,'stale_snapshot');assert.equal(saves(),0);
 assert.equal((await write(api,[{id:'new',expected:null,note:JSON.stringify(note('new'))},{id:'bad id',expected:null,note:JSON.stringify(note('bad id'))}])).reason,'invalid_identifier');
 assert.equal(c.state.notes.length,1);assert.equal(c.state.notes[0].title,'人编辑中');
});
test('failed durable save rolls back only its own note objects, preserving concurrent human edits',async()=>{
 const {c,api,queued}=setup();const snapshot=await read(api);
 c.saveDocumentDurably=async()=>{throw Error('本机数据库暂时无法保存')};
 assert.equal((await write(api,replacement(snapshot))).reason,'storage_failed');
 assert.equal(c.state.notes[0].title,'原日程');assert.equal(queued(),1);
 c.saveDocumentDurably=async()=>{c.state.notes[0]=note('a','newer human');throw Error('与本机数据库连接中断')};
 assert.equal((await write(api,replacement(snapshot))).reason,'storage_disconnected');
 assert.equal(c.state.notes[0].title,'newer human');assert.equal(queued(),2);
});
for(const [reason,change] of [
 ['hydrating',c=>{c.storageHydrated=false}],['conflict',c=>{c.serverConflict=true}],
 ['busy',c=>{c.sendMessage.busy=true}],['trash_paused',c=>{c.purgeTrash.syncPaused=true}]
])test(`expected ${reason} is a structured wait, without saves or payloads`,async()=>{
 const {c,api,saves,flushes}=setup();const snapshot=await read(api);change(c);
 for(const result of [await read(api),await write(api,replacement(snapshot))]) {
  assert.equal(result.status,'deferred');assert.equal(result.reason,reason);
  assert.equal(result.notes,undefined);assert.equal(result.accepted,undefined);assert.equal(result.errorType,undefined);
 }
 assert.equal(saves(),0);assert.equal(flushes(),0);
});
test('hydration then a bounded flush still saving waits; next scheduled attempt succeeds without a new timer',async()=>{
 const {c,api,saves,flushes}=setup();c.storageHydrated=false;
 assert.equal((await read(api)).reason,'hydrating');
 c.storageHydrated=true;c.state._pendingLocalSave=true;c.serverSaveInFlight=true;
 // Simulate the real flushWorkspace 2.5-second deadline returning while the
 // request remains in flight. No added sleeps or bridge retry timer are needed.
 assert.equal((await read(api)).reason,'saving');assert.equal(flushes(),1);assert.equal(saves(),0);
 c.serverSaveInFlight=false;delete c.state._pendingLocalSave;
 assert.equal((await read(api)).status,'ready');assert.equal(flushes(),1);
});
test('queued snapshots are also a wait and a conflict arising during flush is reported precisely',async()=>{
 const {c,api}=setup();c.serverSaveQueued=true;
 assert.equal((await read(api)).reason,'saving');
 c.window.flushWorkspace=async()=>{c.serverSaveQueued=false;c.serverConflict=true};
 assert.equal((await read(api)).reason,'conflict');
});
test('writer rechecks saving after read and busy protects a concurrent native request',async()=>{
 const {c,api,saves}=setup();const snapshot=await read(api);c.serverSaveInFlight=true;
 assert.equal((await write(api,replacement(snapshot))).reason,'saving');assert.equal(saves(),0);
 c.serverSaveInFlight=false;let finish;
 c.saveDocumentDurably=()=>new Promise(resolve=>{finish=resolve});
 const inFlight=write(api,replacement(snapshot));
 assert.equal((await read(api)).reason,'busy');assert.equal((await write(api,replacement(snapshot))).reason,'busy');
 finish(true);assert.equal((await inFlight).status,'ready');
 assert.equal((await read(api)).status,'ready');
});
test('no ACK on false save result; exact durable writes alone appear in ACK',async()=>{
 const {c,api}=setup();const snapshot=await read(api);c.saveDocumentDurably=async()=>false;
 const failed=await write(api,replacement(snapshot));assert.equal(failed.reason,'storage_failed');assert.equal(failed.accepted,undefined);assert.equal(c.state.notes[0].title,'原日程');
 c.saveDocumentDurably=async()=>{c.state.notes[0]=note('a','human after save');return true};
 assert.deepEqual((await write(api,replacement(snapshot))).accepted,[]);
 assert.equal(c.state.notes[0].title,'human after save');
});
test('post-commit render failure never reverts committed data; later read can reconcile lost ACK',async()=>{
 const {c,api,queued}=setup();const snapshot=await read(api);c.renderAll=()=>{throw new TypeError('private body and credentials')};
 const result=await write(api,replacement(snapshot));
 assert.equal(result.status,'error');assert.equal(result.errorType,'TypeError');assert.equal(result.accepted,undefined);
 assert.equal(c.state.notes[0].title,'修改日程');assert.equal(queued(),0);
 assert.equal(JSON.parse((await read(api)).notes.a).title,'修改日程');
 assert.ok(!JSON.stringify(result).includes('private'));
});
test('arbitrary error names, messages and malformed note payloads do not enter status responses',async()=>{
 const {c,api}=setup();const snapshot=await read(api);
 const secret='synthetic-note-body-should-not-escape';
 c.saveDocumentDurably=async()=>{const e=Error(secret);e.name=secret;throw e};
 const result=await write(api,replacement(snapshot));
 assert.deepEqual(result,{version:1,stage:'write',status:'error',reason:'unexpected',errorType:'Error'});
 const bad=await write(api,[{id:'a',expected:snapshot.notes.a,note:secret}]);
 assert.equal(bad.reason,'invalid_note');assert.ok(!JSON.stringify(bad).includes(secret));
});
test('rollback requeue failure is visible and never acknowledged',async()=>{
 const {c,api}=setup();const snapshot=await read(api);
 c.saveDocumentDurably=async()=>{throw Error('本机数据库暂时无法保存')};c.save=()=>{throw Error('private path')};
 const result=await write(api,replacement(snapshot));
 assert.equal(result.reason,'rollback_failed');assert.equal(result.accepted,undefined);assert.equal(c.state.notes[0].title,'原日程');
});
test('persistence interruption reports expected reason after rolling back its own optimistic note',async()=>{
 for(const [message,reason]of [['本机数据库尚未就绪','hydrating'],['请先处理工作区同步冲突','conflict'],['回收站正在保存，请稍后重试','trash_paused']]) {
  const {c,api}=setup();const snapshot=await read(api);c.saveDocumentDurably=async()=>{throw Error(message)};
  const result=await write(api,replacement(snapshot));assert.equal(result.status,'deferred');assert.equal(result.reason,reason);assert.equal(c.state.notes[0].title,'原日程');
 }
});

test('a failed bounded workspace flush reports the storage error instead of indefinite saving',async()=>{
 const {c,api}=setup();const snapshot=await read(api);c.serverSaveQueued=true;
 c.window.flushWorkspace=async()=>{c.serverSaveFailure='与本机数据库连接中断';c.serverSaveInFlight=false};
 for(const result of [await read(api),await write(api,replacement(snapshot))]) {
  assert.equal(result.status,'error');assert.equal(result.reason,'storage_disconnected');assert.equal(result.notes,undefined);assert.equal(result.accepted,undefined);
 }
 c.serverSaveFailure=null;c.serverSaveQueued=false;
 assert.equal((await read(api)).status,'ready');
});
