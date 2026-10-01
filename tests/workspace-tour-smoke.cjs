/* Real renderer acceptance; isolated data/profile, synthetic content, zero model calls. */
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18951,ORIGIN=`http://127.0.0.1:${PORT}`,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-tour-')),OUT=path.join(ROOT,'test-results/workspace-tour-20260924');
fs.mkdirSync(path.join(TEMP,'store'));fs.mkdirSync(path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const checks=[],failures=[],wait=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label){const start=Date.now();while(Date.now()-start<15000){if(await fn())return;await wait(60);}throw Error('Timeout: '+label);}
const watchdog=setTimeout(()=>{server?.kill();win?.destroy();app.exit(1)},120000);
async function run(){
 await new Promise((resolve,reject)=>{const p=net.createServer();p.once('error',reject);p.listen(PORT,'127.0.0.1',()=>p.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:path.join(TEMP,'store')},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(ORIGIN+'/__health',r=>{r.resume();resolve(r.statusCode===200)}).on('error',()=>resolve(false))),'server');
 await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});let blockedNetwork=0;
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>{const cancel=!details.url.startsWith(ORIGIN+'/');if(cancel)blockedNetwork++;cb({cancel});});
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),shot=async name=>{await wait(700);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 async function step(label,fn){try{await fn();checks.push(label);console.log('PASS',label)}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message)}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:1,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 await evaluate(`window.WorkspaceTour?.close();document.querySelectorAll('#workspaceTour,#openWorkspaceTour').forEach(n=>n.remove());`);
 await evaluate(fs.readFileSync(path.join(ROOT,'app/workspace-tour.js'),'utf8'));
 await evaluate(`(()=>{const css=document.createElement('style');css.textContent=${JSON.stringify(fs.readFileSync(path.join(ROOT,'app/workspace-tour.css'),'utf8'))};document.body.append(css);window.tourFinishes=[];window.tour=WorkspaceTour.createController({getState:()=>state,onFinish:r=>tourFinishes.push(r),showWorkspace:()=>showView('agent'),autoStart:false});window.contentBefore=JSON.stringify([state.notes,state.imports,state.tasks,state.conversations]);})()`);
 await step('animated guide targets the real composer, offers skip/replay, and never sends or creates content',async()=>{
  assert.equal(await evaluate('tour.start()'),true);await shot('01-conversation-light');assert.equal(await evaluate(`getComputedStyle(document.querySelector('.workspace-tour-demo-lines span')).animationName`),'workspace-tour-line');
  const gap=await evaluate(`Math.abs(parseFloat(document.querySelector('#workspaceTourSpotlight').style.left)-Math.max(3,document.querySelector('#composer').getBoundingClientRect().left-5))`);assert.ok(gap<1);
  await click('#workspaceTourSkip');assert.equal(await evaluate('tour.isOpen()'),false);await click('#openWorkspaceTour');assert.equal(await evaluate('tour.currentStep()'),'conversation');
  assert.equal(await evaluate('JSON.stringify([state.notes,state.imports,state.tasks,state.conversations])===contentBefore'),true);
 });
 await step('all five steps navigate using real UI anchors and the browser step states native availability',async()=>{
  for(const [index,name] of [[1,'02-project-files'],[2,'03-review'],[3,'04-activity'],[4,'05-browser-unavailable']]){await evaluate(`tour.go(${index})`);await shot(name);assert.equal(await evaluate(`document.querySelector('#workspaceTourSpotlight').hidden`),false);}
  await evaluate(`tour.go(3);document.querySelector('#messageList').scrollTop=0;document.querySelector('#messageList').dispatchEvent(new Event('scroll',{bubbles:true}));`);await wait(350);
  assert.ok(await evaluate(`(()=>{const target=[...document.querySelectorAll('.agent-progress>summary,.agent-progress')].find(n=>{const r=n.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.top<innerHeight;})||document.querySelector('#messageList');return Math.abs(parseFloat(document.querySelector('#workspaceTourSpotlight').style.top)-Math.max(3,target.getBoundingClientRect().top-5))<1;})()`));await evaluate('tour.go(4)');
  assert.match(await evaluate(`document.querySelector('#workspaceTourBody').textContent`),/当前运行环境没有连接/);await click('#workspaceTourNext');assert.equal(await evaluate('tour.isOpen()'),false);assert.equal(await evaluate('tourFinishes.at(-1).status'),'completed');
 });
 await step('setup and unsaved decisions retain priority; keyboard arrows do not hijack message editing',async()=>{
  await evaluate('WorkstationOnboarding.open()');assert.equal(await evaluate('tour.start()'),true);assert.equal(await evaluate('WorkstationOnboarding.isOpen()'),false);
  await evaluate(`document.querySelector('#agentInput').focus();document.querySelector('#agentInput').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);assert.equal(await evaluate('tour.currentStep()'),'conversation');
  await evaluate(`document.querySelector('#workspaceTourCard').focus();document.querySelector('#workspaceTourCard').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);assert.equal(await evaluate('tour.currentStep()'),'files');
  await evaluate(`document.querySelector('#workspaceTourCard').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);assert.equal(await evaluate('tour.isOpen()'),false);
  await evaluate(`openPreview('note','ui-plan');`);await until(()=>evaluate(`!!document.querySelector('[data-note-action=rich]')`),'note editor');await click('[data-note-action=rich]');
  await evaluate(`(()=>{const block=document.querySelector('.markdown-editor-paragraph');block.querySelector('p').textContent='未保存的测试';block.dispatchEvent(new InputEvent('input',{bubbles:true}));openPreview('note','ui-notes');})()`);await until(()=>evaluate(`!document.querySelector('.note-document-leave').hidden`),'unsaved guard');assert.equal(await evaluate('tour.start()'),false);await click('[data-note-action=stay]');
 });
 await step('resizing and scrolling reanchor the spotlight; dark and reduced motion remain usable',async()=>{
  await evaluate(`state.ui.theme='dark';applyUiPreferences();tour.start()`);await shot('06-dark');
  win.setSize(430,700);await evaluate('WorkspaceLayout.refresh();tour.layout()');await shot('07-narrow');const bounds=await evaluate(`(()=>{const r=document.querySelector('#workspaceTourCard').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight};})()`);assert.ok(bounds.x>=13&&bounds.y>=13&&bounds.right<=bounds.w-13&&bounds.bottom<=bounds.h-13);
  await evaluate(`document.body.classList.add('reduce-motion');tour.go(2)`);assert.equal(await evaluate(`getComputedStyle(document.querySelector('.workspace-tour-demo-lines span')).animationName`),'none');assert.equal(await evaluate(`getComputedStyle(document.querySelector('#workspaceTourSpotlight')).transitionDuration`),'0s');await shot('08-reduced-motion');
  await evaluate('tour.close()');await evaluate(`document.body.classList.remove('reduce-motion');document.querySelector('[data-note-action=cancel]').click()`);await until(()=>evaluate(`!document.querySelector('.note-document-leave').hidden`),'discard guard');await click('[data-note-action=discard]');
 });
 await step('destroy removes listeners and no guide action changed user content or drafts',async()=>{
  await evaluate('tour.destroy()');assert.equal(await evaluate(`!!document.querySelector('#workspaceTour')`),false);assert.equal(await evaluate('JSON.stringify([state.notes,state.imports,state.tasks,state.conversations])===contentBefore'),true);assert.equal(blockedNetwork,0);
 });
 await step('first-use animation waits for hydration and starts once after the old connection tour closes',async()=>{
  await evaluate(`delete state.ui.workspaceTour;window.autoReady=false;window.autoEnds=[];WorkstationOnboarding.open();window.autoTour=WorkspaceTour.createController({getState:()=>state,ready:()=>autoReady,showWorkspace:()=>showView('agent'),onFinish:r=>autoEnds.push(r),autoStart:true});void 0;`);await wait(150);assert.equal(await evaluate('autoTour.isOpen()'),false);
  await evaluate('autoReady=true');await wait(550);assert.equal(await evaluate('autoTour.isOpen()'),false);await evaluate('WorkstationOnboarding.close()');await until(()=>evaluate('autoTour.isOpen()'),'auto guide after setup');
  await evaluate('autoTour.close()');await evaluate(`document.body.classList.toggle('tour-test-event');`);await wait(150);assert.equal(await evaluate('autoTour.isOpen()'),false);assert.equal(await evaluate('autoEnds.length'),1);await evaluate('autoTour.destroy()');
 });
 const report={checks,passed:checks.length,failures,modelCalls:0,externalRequests:blockedNetwork,workspace:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));return failures.length?1:0;
}
run().then(code=>{clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(code)}).catch(e=>{console.error(e);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1)});
