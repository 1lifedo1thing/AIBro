/* Real app state/server persistence; isolated fixture, no model request. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18974,ORIGIN=`http://127.0.0.1:${PORT}`,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-permissions-')),STORE=path.join(TEMP,'store'),OUT=path.join(ROOT,'test-results/halaska-controls-20260924');
fs.mkdirSync(STORE);fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const checks=[],errors=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const start=Date.now();while(Date.now()-start<15000){if(await fn())return;await wait(50)}throw Error('Timeout: '+label)}
const watchdog=setTimeout(()=>{server?.kill();win?.destroy();app.exit(1)},90000);
(async()=>{
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(ORIGIN+'/__health',r=>{r.resume();resolve(r.statusCode===200)}).on('error',()=>resolve(false))),'server');
 await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!details.url.startsWith(ORIGIN+'/')}));
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 const evaluate=code=>win.webContents.executeJavaScript(code,true);
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 await evaluate(`document.querySelector('#composerPermission').focus();WorkstationPermissions.open();document.querySelector('.permission-choice[data-mode=request]').click()`);
 await until(()=>evaluate(`!document.querySelector('.permission-picker')`),'mode persisted');
 assert.equal(await evaluate(`currentConversation().permissionMode`),'request');
 assert.equal(await evaluate(`fetch('/__state',{cache:'no-store'}).then(r=>r.json()).then(s=>s.conversations.find(c=>c.id==='ui-conversation').permissionMode)`),'request');
 checks.push('actual permission option writes request mode to local server snapshot before closing');
 await evaluate(`WorkstationPermissions.open();document.querySelector('#reviewerApprove').click()`);
 await until(()=>evaluate(`!document.querySelector('.kit-permission-content').hasAttribute('aria-busy')`),'reviewer persisted');
 assert.equal(await evaluate(`fetch('/__state',{cache:'no-store'}).then(r=>r.json()).then(s=>s.conversations.find(c=>c.id==='ui-conversation').reviewerApprove)`),true);
 await wait(450);fs.writeFileSync(path.join(OUT,'workspace-permissions.png'),(await win.webContents.capturePage()).toPNG());
 checks.push('actual reviewer switch writes conversation-scoped reviewer approval');
 await evaluate(`document.querySelector('.permission-picker').close()`);await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload hydrate');
 assert.equal(await evaluate(`currentConversation().permissionMode`),'request');assert.equal(await evaluate(`currentConversation().reviewerApprove`),true);
 await evaluate(`WorkstationPermissions.open()`);assert.equal(await evaluate(`document.querySelector('.permission-choice[data-mode=request]').getAttribute('aria-pressed')`),'true');assert.equal(await evaluate(`document.querySelector('#reviewerApprove').checked`),true);
 checks.push('full page reload restores real saved mode and Kit selected switch state');
 assert.deepEqual(errors,[]);checks.push('real app renderer produces no console errors');
 const report={passed:checks.length,checks,errors,fixture:TEMP};fs.writeFileSync(path.join(OUT,'workspace-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));clearTimeout(watchdog);win.destroy();server.kill();app.exit(0);
})().catch(error=>{console.error(error);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1)});
