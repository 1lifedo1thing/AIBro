/* Independent integration checks; temporary profile, local static fixture, no workspace/model calls. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-kit-audit-')),OUT=path.join(ROOT,'test-results/kit-integration-audit-20260924');
app.setPath('userData',path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});
const checks=[],failures=[],errors=[];let win,server;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const watchdog=setTimeout(()=>{win?.destroy();server?.close();app.exit(1)},90000);
async function run(){
 const html='<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/liquid-glass.css"><link rel="stylesheet" href="/collection-ui.css"><link rel="stylesheet" href="/workspace-navigation.css"><style>body{display:block!important;padding:16px;overflow:auto!important}.main{display:block!important;min-width:0!important;margin:0!important;width:100%!important}#collection{container:collection / inline-size}</style></head><body class="liquid-glass light-mode" data-view="project"><main class="main"><div id="project"></div><div id="collection"></div></main><script src="/halaska-ui.js"></script><script src="/collection-ui.js"></script><script src="/workspace-navigation.js"></script></body></html>';
 server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname;if(name==='/'){res.setHeader('Content-Type','text/html');return res.end(html)}const file=path.join(ROOT,'app',path.basename(name));if(!fs.existsSync(file)){res.statusCode=404;return res.end()}res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'application/javascript');res.end(fs.readFileSync(file))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 await app.whenReady();win=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!details.url.startsWith(origin+'/')}));
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 async function step(name,fn){try{await fn();checks.push(name);console.log('PASS',name)}catch(error){failures.push({name,error:error.stack});console.error('FAIL',name,error.message)}}
 await win.loadURL(origin);
 await evaluate(`window.fixture={projects:[{id:'p',name:'项目',workspace:'日常'}],tasks:[{id:'t',title:'智能任务',projectId:'p',status:'todo'}],notes:[{id:'n',title:'智能笔记',projectId:'p',content:'note'}],imports:[{id:'i',name:'Original.pdf',projectId:'p'}],currentProjectId:'p',ui:{projectTab:'overview'},conversations:[]};window.saves=0;window.saveState='ok';window.savedResolve=null;window.opened=[];window.host=document.querySelector('#collection');CollectionUI.init({getState:()=>fixture,save:()=>{saves++;return saveState==='pending'?new Promise(resolve=>savedResolve=resolve):true},openNote:id=>opened.push(id),deleteItems:async()=>false,toast:()=>{}});CollectionUI.render(host,{projectId:'p'});window.renderAgain=()=>CollectionUI.render(host,{projectId:'p'});void 0;`);
 await step('real collection toolbar uses Kit and stable search survives background render',async()=>{
  assert.equal(await evaluate(`host.querySelector('[data-halaska-root]').dataset.halaskaRoot`),'LibraryToolbar');
  await evaluate(`window.originalSearch=host.querySelector('[data-cui-search]');originalSearch.focus();renderAgain()`);
  assert.equal(await evaluate(`document.activeElement===originalSearch&&host.querySelector('[data-cui-search]')===originalSearch`),true);
 });
 await step('real keyboard input filters and retains the input node and caret',async()=>{
  win.webContents.focus();await win.webContents.insertText('智能');await wait(40);
  assert.deepEqual(await evaluate(`({same:host.querySelector('[data-cui-search]')===originalSearch,value:originalSearch.value,start:originalSearch.selectionStart,ids:[...host.querySelectorAll('[data-cui-id]')].map(x=>x.dataset.cuiId)})`),{same:true,value:'智能',start:2,ids:['n','t']});
 });
 await step('composition blocks background render and commits the actual final query once',async()=>{
  await evaluate(`originalSearch.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(originalSearch,'原稿');originalSearch.dispatchEvent(new InputEvent('input',{bubbles:true,data:'稿',isComposing:true}));renderAgain();`);
  assert.equal(await evaluate(`originalSearch===host.querySelector('[data-cui-search]')&&document.activeElement===originalSearch`),true);
  await evaluate(`originalSearch.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'原稿'}))`);await wait(30);
  assert.equal(await evaluate(`originalSearch.value`),'原稿');assert.match(await evaluate('host.textContent'),/没有匹配内容/);
  await click('.kit-library-empty button');assert.equal(await evaluate(`originalSearch.value`),'');assert.equal(await evaluate(`document.activeElement===originalSearch`),true);
 });
 await step('sort is single execution despite existing DOM delegation',async()=>{
  assert.match(await evaluate(`host.querySelector('[data-cui-sort]').textContent`),/↓/);await click('[data-cui-sort]');
  assert.match(await evaluate(`host.querySelector('[data-cui-sort]').textContent`),/更新时间 ↑/);
 });
 await step('selection action submits once, disables while pending, retains state until resolved',async()=>{
  await click('[data-cui-id="t"] [data-cui-check]');await evaluate(`saveState='pending'`);await click('[data-cui-complete]');
  assert.equal(await evaluate('saves'),1);assert.equal(await evaluate(`host.querySelector('[data-cui-clear]').disabled`),true);
  await click('[data-cui-clear]');await evaluate(`savedResolve(true)`);await wait(30);
  assert.equal(await evaluate(`fixture.tasks[0].status`),'done');assert.equal(await evaluate('saves'),1);assert.equal(await evaluate(`host.querySelector('[data-cui-complete]')`),null);
 });
 await step('collection roots do not accumulate after repeated render and empty transitions',async()=>{
  await evaluate(`for(let i=0;i<40;i++){fixture.notes.push({id:'temporary-'+i,title:'x',projectId:'p'});renderAgain();fixture.notes.pop();renderAgain();}`);await wait(30);
  assert.equal(await evaluate('HalaskaUI.diagnostics().mounts'),2);
 });
 await step('Kit project tabs preserve focused button across route and prevent double routing',async()=>{
  await evaluate(`window.routes=[];window.nav=WorkspaceNavigation.createController({getState:()=>fixture,applySectionTabs:()=>routes.push(fixture.ui.projectTab),openProject:id=>fixture.currentProjectId=id,newConversation:()=>{},openConversation:()=>{},showView:()=>{},save:()=>{}});nav.afterRoute();document.querySelector('[data-workspace-route=knowledge]').focus();window.knowledgeTab=document.activeElement;knowledgeTab.click()`);
  assert.deepEqual(await evaluate('routes'),['knowledge']);assert.equal(await evaluate(`document.activeElement===knowledgeTab`),true);
  await evaluate(`knowledgeTab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  assert.deepEqual(await evaluate('routes'),['knowledge','tasks']);assert.equal(await evaluate(`document.activeElement.dataset.workspaceRoute`),'tasks');
 });
 await step('narrow data and navigation controls stay inside their scroll boundaries',async()=>{
  win.setSize(380,740);await wait(150);
  const result=await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,controls:[...host.querySelectorAll('input,select,[data-cui-sort],.kit-segments')].map(x=>({name:x.getAttribute('aria-label'),left:x.getBoundingClientRect().left,right:x.getBoundingClientRect().right})),width:innerWidth})`);
  assert.equal(result.overflow,false,JSON.stringify(result));assert.ok(result.controls.every(c=>c.left>=0&&c.right<=result.width),JSON.stringify(result));
  fs.writeFileSync(path.join(OUT,'narrow.png'),(await win.webContents.capturePage()).toPNG());
 });
 await step('theme changes preserve focused controls and disconnected islands are collected',async()=>{
  await evaluate(`originalSearch.focus();document.body.classList.remove('light-mode')`);await wait(30);
  assert.equal(await evaluate(`document.activeElement===originalSearch`),true);assert.equal(await evaluate(`host.querySelector('[data-halaska-root]').dataset.halaskaTheme`),'dark');
  await evaluate(`document.querySelector('.main').replaceChildren()`);await wait(30);assert.equal(await evaluate('HalaskaUI.diagnostics().mounts'),0);
 });
 await step('no renderer errors',async()=>assert.deepEqual(errors,[]));
 fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({checks,failures,errors,profile:TEMP,modelCalls:0},null,2)+'\n');return failures.length?1:0;
}
run().then(code=>{clearTimeout(watchdog);win?.destroy();server?.close();app.exit(code)}).catch(error=>{console.error(error);clearTimeout(watchdog);win?.destroy();server?.close();app.exit(1)});
