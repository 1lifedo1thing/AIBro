/* Native CSS and bridge integration in an isolated real renderer. No user data or AI calls. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18968,ORIGIN=`http://127.0.0.1:${PORT}`,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-native-tour-')),OUT=path.join(ROOT,'test-results/native-tour-20260925');
for(const p of ['store','profile'])fs.mkdirSync(path.join(TEMP,p));fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const checks=[],failures=[],errors=[],remoteRequests=[],modelRequests=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const start=Date.now();while(Date.now()-start<15000){if(await fn())return;await wait(60);}throw Error('Timeout: '+label);}
const watchdog=setTimeout(()=>{server?.kill();win?.destroy();app.exit(1)},120000);
async function run(){
 await new Promise((resolve,reject)=>{const p=net.createServer();p.once('error',reject);p.listen(PORT,'127.0.0.1',()=>p.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:path.join(TEMP,'store')},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(ORIGIN+'/__health',r=>{r.resume();resolve(r.statusCode===200)}).on('error',()=>resolve(false))),'server');await app.whenReady();
 win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>{const remote=!details.url.startsWith(ORIGIN+'/'),model=/\/__(?:chat|agent|responses)(?:\/|\?|$)/.test(details.url);if(remote)remoteRequests.push(details.url);if(model)modelRequests.push(details.url);cb({cancel:remote||model});});
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const visible=selector=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return !n.hidden&&getComputedStyle(n).display!=='none'&&r.width>0&&r.height>0;})()`);
 const shot=async name=>{await wait(180);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 async function step(label,fn){try{await fn();checks.push(label);console.log('PASS',label)}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message)}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await evaluate(`WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:1,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 await evaluate(`(()=>{const css=document.createElement('style');css.textContent=${JSON.stringify(fs.readFileSync(path.join(ROOT,'native/Resources/workspace.css'),'utf8'))};document.head.append(css);window.tourSnapshots=[];window.webkit={messageHandlers:{workspace:{postMessage:value=>tourSnapshots.push(value)}}};const input=document.querySelector('#agentInput');input.value='保留这段未发送草稿';input.dispatchEvent(new Event('input',{bubbles:true}));window.beforeTour=JSON.stringify([state.projects,state.notes,state.imports,state.tasks,state.conversations]);})()`);
 await evaluate(fs.readFileSync(path.join(ROOT,'native/Resources/bridge.js'),'utf8'));
 await step('native settings entries open visible guides and hand off instead of silently blocking',async()=>{
  await evaluate(`showView('settings')`);await click('#openOnboarding');assert.equal(await visible('#onboardingLayer'),true);assert.equal(await visible('#onboardingCard'),true);
  await click('#openWorkspaceTour');assert.equal(await evaluate('WorkstationOnboarding.isOpen()'),false);assert.equal(await visible('#workspaceTour'),true);assert.equal(await evaluate('document.body.dataset.view'),'agent');
  await until(()=>evaluate('tourSnapshots.at(-1)?.tourOpen===true'),'native shell guide visibility snapshot');await shot('workspace-tour-native');
  await evaluate(`showView('settings')`);await click('#openOnboarding');assert.equal(await evaluate('WorkspaceTour.isOpen()'),false);assert.equal(await visible('#onboardingCard'),true);await shot('onboarding-native');
 });
 await step('native onboarding next, back, every route and completion work without changing the draft',async()=>{
  const routes=['agent','courses','agent','dashboard'];for(const route of routes){await click('#onboardingNext');await until(()=>evaluate(`document.body.dataset.view===${JSON.stringify(route)}&&!document.querySelector('#onboardingNext').disabled`),route);assert.equal(await visible('#onboardingCard'),true);}
  await click('#onboardingBack');await until(()=>evaluate(`document.body.dataset.view==='agent'&&!document.querySelector('#onboardingNext').disabled`),'back');
  await click('#onboardingNext');await until(()=>evaluate(`document.body.dataset.view==='dashboard'&&!document.querySelector('#onboardingNext').disabled`),'return final');await click('#onboardingNext');assert.equal(await evaluate('WorkstationOnboarding.isOpen()'),false);assert.equal(await evaluate('state.ui.onboarding.status'),'completed');
  assert.equal(await evaluate(`JSON.stringify([state.projects,state.notes,state.imports,state.tasks,state.conversations])===beforeTour`),true);
  await until(()=>evaluate('tourSnapshots.at(-1)?.tourOpen===false'),'native shell released');
 });
 await step('workspace guide is replayable and its visible controls navigate all five steps',async()=>{
  await evaluate(`showView('settings')`);await click('#openWorkspaceTour');for(const step of ['files','review','activity','browser']){await click('#workspaceTourNext');assert.equal(await evaluate(`document.querySelector('#workspaceTour').dataset.step`),step);assert.equal(await visible('#workspaceTourCard'),true);}
  await click('#workspaceTourBack');assert.equal(await evaluate(`document.querySelector('#workspaceTour').dataset.step`),'activity');await click('#workspaceTourNext');await click('#workspaceTourNext');assert.equal(await evaluate('WorkspaceTour.isOpen()'),false);assert.equal(await evaluate('state.ui.workspaceTour.status'),'completed');
  await evaluate(`showView('settings')`);await click('#openWorkspaceTour');assert.equal(await evaluate(`document.querySelector('#workspaceTour').dataset.step`),'conversation');await click('#workspaceTourSkip');
 });
 await step('active decisions prevent replay and keep focus and content intact',async()=>{
  await evaluate(`showView('settings');window.tourModal=document.createElement('dialog');tourModal.innerHTML='<button id="tourDecision">Keep editing</button>';document.body.append(tourModal);tourModal.showModal();document.querySelector('#tourDecision').focus();`);
  assert.equal(await evaluate('WorkspaceTour.start()'),false);assert.equal(await evaluate('WorkstationOnboarding.open()'),false);assert.equal(await evaluate(`document.activeElement.id`),'tourDecision');assert.equal(await evaluate(`tourModal.open`),true);await evaluate('tourModal.close();tourModal.remove()');
  assert.equal(await evaluate(`JSON.stringify([state.projects,state.notes,state.imports,state.tasks,state.conversations])===beforeTour`),true);
 });
 await step('native dark and narrow guides stay visible and honor reduced motion',async()=>{
  await evaluate(`state.ui.theme='dark';applyUiPreferences();document.body.classList.add('reduce-motion');WorkstationOnboarding.open()`);win.setSize(430,700);await evaluate('dispatchEvent(new Event("resize"))');await wait(100);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#onboardingCard')).animationName`),'none');let r=await evaluate(`(()=>{const r=document.querySelector('#onboardingCard').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`);assert.ok(r.left>=15&&r.top>=15&&r.right<=r.width-15&&r.bottom<=r.height-15);await shot('onboarding-native-dark-narrow');
  await evaluate('WorkspaceTour.start()');assert.equal(await visible('#workspaceTourCard'),true);assert.equal(await evaluate(`getComputedStyle(document.querySelector('#workspaceTourCard')).animationName`),'none');await shot('workspace-tour-native-dark-narrow');await click('#workspaceTourSkip');
 });
 await step('no renderer errors, model calls, external requests or content mutations',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(remoteRequests,[]);assert.deepEqual(modelRequests,[]);assert.equal(await evaluate(`JSON.stringify([state.projects,state.notes,state.imports,state.tasks,state.conversations])===beforeTour`),true);});
 const report={passed:checks.length,checks,failures,rendererErrors:errors,remoteRequests,modelRequests,workspace:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));return failures.length?1:0;
}
run().then(code=>{clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(code)}).catch(e=>{console.error(e);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1)});
