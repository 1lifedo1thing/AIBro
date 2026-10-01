const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('production native surface gate owns only its disappearing responder and retains native focus',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-surface-unit-'));
 try {
  const binary=path.join(tmp,'surface');
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',path.join(root,'native/Sources/AIBro/NativeSurfaceVisibility.swift'),path.join(__dirname,'native-surface.swift'),'-o',binary,'-framework','AppKit'],{encoding:'utf8',timeout:90000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const ran=spawnSync(binary,[],{encoding:'utf8',timeout:15000});assert.equal(ran.status,0,ran.stdout+ran.stderr);assert.match(ran.stdout,/PASS: 6 native surface ownership checks/);
 } finally {fs.rmSync(tmp,{recursive:true,force:true})}
});
test('native interaction lifetime is independent of window occlusion and retains explicit focus requests',()=>{
 const host=fs.readFileSync(path.join(root,'native/Sources/AIBro/WebGlassHost.swift'),'utf8');
 const setter=host.slice(host.indexOf('func setSurfaceVisible'),host.indexOf('// Opacity-only'));
 assert.match(setter,/setNativeSurfaceVisibility\(web,visible:visible\)/);
 assert.doesNotMatch(setter,/occlusionState|isMiniaturized|NSApp\.isHidden/);
 assert.match(setter,/guard focusRequested,surfaceVisible,!web\.isHidden/);
 assert.match(host,/func cancelRequestedFocus\(\)\{focusRequested=false\}/);
 const main=fs.readFileSync(path.join(root,'native/Sources/AIBro/AIBro.swift'),'utf8');
 assert.match(main,/self\.webFocusGeneration == focusGeneration/);
 assert.match(main,/\.accessibilityHidden\(nativeContent\)/);
 assert.match(main,/\.disabled\(model\.spaceContent \|\| workspaceOverlay\)\.accessibilityHidden\(model\.spaceContent \|\| workspaceOverlay\)/);
 assert.match(main,/paused:reduceMotion \|\| !visible \|\| !surfaceVisible \|\| scenePhase != \.active/);
});
