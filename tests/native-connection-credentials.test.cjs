const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Mac connection vault: real cipher, CAS, shared-session flock and controlled export',()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-native-connection-check-'));
 try{
  const binary=path.join(dir,'checks');
  const build=spawnSync('xcrun',['swiftc','-swift-version','5','-parse-as-library',...['native/Sources/AIBro/AgendaCore.swift','native/Sources/AIBro/NativeCredentials.swift','tests/native-connection-credentials.swift'].map(f=>path.join(root,f)),'-o',binary],{encoding:'utf8',timeout:90000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/7 groups passed/);process.stdout.write(result.stdout);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
