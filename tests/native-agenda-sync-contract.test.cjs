const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('real JS envelopes are consumed by the compiled Swift reconciliation path',{skip:process.platform!=='darwin',timeout:120000},async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-agenda-contract-'));
 try {
  const c={window:{flushWorkspace:async()=>{}},storageHydrated:true,serverConflict:false,serverSaveInFlight:false,serverSaveQueued:false,sendMessage:{busy:false},purgeTrash:{syncPaused:false},state:{notes:[]},saveDocumentDurably:async()=>true,save(){},renderAll(){}};
  vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'native/Resources/agenda-sync.js'),'utf8'),c);
  const fixtures={empty:await c.window.NativeAgendaSync.read()};
  c.storageHydrated=false;fixtures.hydrating=await c.window.NativeAgendaSync.read();c.storageHydrated=true;
  c.serverSaveInFlight=true;fixtures.saving=await c.window.NativeAgendaSync.read();c.serverSaveInFlight=false;
  c.serverConflict=true;fixtures.conflict=await c.window.NativeAgendaSync.read();c.serverConflict=false;
  c.sendMessage.busy=true;fixtures.busy=await c.window.NativeAgendaSync.read();c.sendMessage.busy=false;
  const note={id:'a',kind:'日程',title:'Synthetic',content:JSON.stringify({format:'aibro.agenda.v1',title:'Synthetic',start:1000,end:3601000})};
  fixtures.write=await c.window.NativeAgendaSync.write([{id:'a',expected:null,note:JSON.stringify(note)}]);fixtures.read=await c.window.NativeAgendaSync.read();
  c.saveDocumentDurably=async()=>{throw Error('与本机数据库连接中断')};
  fixtures.disconnected=await c.window.NativeAgendaSync.write([{id:'a',expected:JSON.parse(fixtures.read).notes.a,note:JSON.stringify({...note,title:'Changed'})}]);
  const fixturePath=path.join(tmp,'envelopes.json');fs.writeFileSync(fixturePath,JSON.stringify(fixtures));
  const binary=path.join(tmp,'contract');
  const files=['native/Sources/AIBro/AgendaCore.swift','native/Sources/AIBro/AgendaSync.swift','native/Sources/AIBro/AgendaSyncBridge.swift','native/Sources/AIBro/AgendaSyncWorkspace.swift','tests/native-agenda-sync-contract.swift'];
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...files.map(f=>path.join(root,f)),'-o',binary,'-framework','WebKit'],{encoding:'utf8',timeout:90000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[fixturePath],{encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/PASS: \d+ native agenda status and reconciliation checks/);
  console.log(run.stdout.trim());
 } finally {fs.rmSync(tmp,{recursive:true,force:true})}
});
test('native owner keeps its existing ten-second retry cadence',()=>{
 const code=fs.readFileSync(path.join(root,'native/Sources/AIBro/AIBro.swift'),'utf8');
 assert.match(code,/agendaSyncTimer=Timer\.scheduledTimer\(withTimeInterval:10,repeats:true\)/);
 const bridge=fs.readFileSync(path.join(root,'native/Resources/agenda-sync.js'),'utf8');
 assert.doesNotMatch(bridge,/setTimeout|setInterval/);
});
