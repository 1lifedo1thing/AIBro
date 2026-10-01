/* Real production renderer, isolated HTTP fixture, no SSH or credentials. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'test-results/ssh-recovery-20260930');
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-ssh-recovery-'));app.setPath('userData',path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});
const config={target:'fixture-research-host',sshPort:0,localPort:18787,remotePort:8787};
let job={id:'c'.repeat(32),state:'uncertain',phase:'prepared',config,source:'/srv/research/original',destination:'/srv/research/new/长目录验证'.repeat(3),recovered:true,message:'发现上次尚未确认的目录迁移。自动同步已暂停，请核对服务器回执。'};
let remote=null, failReconcile=true, missingConfig=false, win,server;
const state={connected:true,state:'paused',autoSync:false,pending:1,conflicts:0,target:{serverUrl:'http://127.0.0.1:18787',accountId:'fixture'},serverUrl:'http://127.0.0.1:18787',account:{username:'研究工作区'},device:{name:'隔离验收 Mac'}};
const calls=[],checks=[],errors=[],forbidden=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
const html='<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/cloud-sync-ui.css"><style>body{display:block!important;padding:16px;overflow:auto!important}main{max-width:980px;margin:auto}.settings-grid{display:block}.cloud-sync-card{padding:20px;min-width:0}</style></head><body class="light-mode" data-view="settings"><main id="settings"><div class="settings-grid"></div></main><script src="/halaska-ui.js"></script><script src="/cloud-sync-ui.js"></script><script>window.cloud=CloudSyncUI.createController({flush:async()=>true,fetch:window.fetch.bind(window)},{document,navigator,HalaskaUI,disablePolling:true}).init()</script></body></html>';
const metadata=()=>({config:missingConfig?null:config,remote,job,hosts:[]});
const watchdog=setTimeout(()=>finish(1),90000);
async function run(){
 server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost').pathname;
  if(url.startsWith('/__cloud/')){let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;calls.push({url,body});res.setHeader('Content-Type','application/json');
   if(url==='/__cloud/status')return res.end(JSON.stringify(state));
   if(url==='/__cloud/ssh')return res.end(JSON.stringify(metadata()));
   if(url==='/__cloud/ssh/reconcile'){
    assert.deepEqual(body,{jobId:job.id});if(failReconcile){res.statusCode=503;return res.end(JSON.stringify({error:'模拟连接中断，任务记录保留'}));}
    job={...job,state:'completed',phase:'verified',message:'已通过服务器回执确认复制校验与目录切换。自动同步保持暂停。'};
    remote={dataPath:job.destination,databasePath:job.destination+'/cloud.sqlite3',active:true,remotePort:8787};return res.end(JSON.stringify({...metadata(),cloudStatus:state}));
   }res.statusCode=409;return res.end(JSON.stringify({error:'fixture rejects unexpected mutation'}));
  }
  if(url==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
  const file=path.join(ROOT,'app',path.basename(url));if(!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',url.endsWith('.css')?'text/css':url.endsWith('.woff2')?'font/woff2':'application/javascript');res.end(fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;await app.whenReady();
 win=new BrowserWindow({show:false,width:1080,height:1040,webPreferences:{sandbox:true,contextIsolation:true}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,cb)=>{const bad=/^https?:/.test(d.url)&&!d.url.startsWith(origin+'/');if(bad)forbidden.push(d.url);cb({cancel:bad})});
 const ev=code=>win.webContents.executeJavaScript(code,true),click=s=>ev(`document.querySelector(${JSON.stringify(s)}).click()`);
 const until=async code=>{for(let i=0;i<160;i++){if(await ev(code))return;await wait(20);}throw new Error('waiting for '+code);};
 const step=async(name,fn)=>{await fn();checks.push(name);console.log('PASS',name)};
 await win.loadURL(origin);await until(`!!document.querySelector('#cloudSSHResumeMaintenance')`);
 await step('startup exposes retained migration and disables sync/connection without remote requests',async()=>{
  assert.equal(calls.some(c=>c.body),false);assert.equal(await ev(`document.querySelector('#cloudSyncNow').disabled`),true);
  assert.equal(await ev(`document.querySelector('#cloudAutoSync').disabled`),true);assert.equal(await ev(`document.querySelector('#cloudSSHConnect').disabled`),true);
  await click('#cloudSSHResumeMaintenance');await until(`!!document.querySelector('#cloudSSHReconcile')`);
  assert.equal(await ev(`document.activeElement.id`),'cloudSSHReconcile');assert.equal(await ev(`document.querySelector('#cloudSSHSave').disabled`),true);
  assert.match(await ev(`document.querySelector('#cloudSSHMessage').textContent`),/cccccccccccccccccccccccccccccccc/);
  assert.equal(await ev(`document.querySelector('#cloudSSHDataPath').value`),job.destination);
 });
 await step('local refresh performs GET only while explicit reconcile is single targeted POST',async()=>{
  await click('#cloudSSHRefresh');await until(`!document.querySelector('#cloudSSHRefresh').disabled`);assert.equal(calls.some(c=>c.body),false);
  await click('#cloudSSHReconcile');await until(`document.querySelector('#cloudSSHMessage').textContent.includes('模拟连接中断')`);
  assert.equal(calls.filter(c=>c.body).length,1);assert.equal(await ev(`document.querySelector('#cloudSSHMove').disabled`),true);
  assert.equal(await ev(`document.querySelector('#cloudSSHReconcile').disabled`),false);
 });
 await step('reloaded renderer restores the same receipt even with no tunnel configuration',async()=>{
  missingConfig=true;await win.loadURL(origin);await until(`!!document.querySelector('#cloudSSHResumeMaintenance')`);await click('#cloudSSHResumeMaintenance');await until(`!!document.querySelector('#cloudSSHReconcile')`);
  assert.equal(await ev(`document.querySelector('#cloudSSH-target').value`),config.target);assert.equal(calls.filter(c=>c.body).length,1);
  assert.equal(await ev(`document.querySelector('#cloudSSHDataPath').value`),job.destination);
 });
 await step('long receipt paths remain readable at 300px and reduced motion creates no running animation',async()=>{
  for(const width of [1080,390,300]){win.setSize(width,1040);await ev(`document.body.classList.toggle('light-mode',${width!==390});document.body.classList.add('reduce-motion')`);await wait(100);
   assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),true);assert.equal(await ev(`(()=>{const e=document.querySelector('.cloud-sync-dialog-body');return e.scrollWidth<=e.clientWidth+1})()`),true);
   assert.equal(await ev(`document.querySelector('#cloudSSHMessage').dataset.state`),'uncertain');
   fs.writeFileSync(path.join(OUT,`recovery-${width}.png`),(await win.webContents.capturePage()).toPNG());
  }
  win.setSize(1080,1040);
 });
 await step('confirmed receipt unlocks maintenance but never enables migration consent or auto sync',async()=>{
  failReconcile=false;missingConfig=false;await click('#cloudSSHReconcile');await until(`document.querySelector('#cloudSSHMessage').dataset.state==='completed'`);
  assert.equal(await ev(`document.querySelector('#cloudSSHMove').disabled`),true);assert.equal(await ev(`document.querySelector('#cloudSSHMoveConfirmed').checked`),false);
  assert.equal(await ev(`document.querySelector('#cloudSSHSave').disabled`),false);assert.equal(await ev(`!!document.querySelector('#cloudSSHReconcile')`),false);
  assert.equal(state.autoSync,false);assert.equal(calls.filter(c=>c.url==='/__cloud/ssh/move').length,0);
  await ev(`document.querySelector('#cloudSyncDialog').close()`);await click('#cloudSSHSettings');await until(`!!document.querySelector('#cloudSSHMessage')`);
  assert.match(await ev(`document.querySelector('#cloudSSHMessage').textContent`),/自动同步保持暂停/);
 });
 await step('teardown releases UI ownership and only the selected receipt crossed the local API',async()=>{
  assert.equal(calls.filter(c=>c.body).length,2);assert.ok(calls.filter(c=>c.body).every(c=>c.url==='/__cloud/ssh/reconcile'));
  await ev('cloud.destroy()');assert.equal(await ev('HalaskaUI.diagnostics().mounts'),0);assert.deepEqual(forbidden,[]);
  // Expected 503 is represented in UI; no uncaught JS errors are accepted.
  assert.deepEqual(errors.filter(e=>!e.includes('503')),[]);
 });
 fs.writeFileSync(path.join(OUT,'renderer.json'),JSON.stringify({checks,errors,forbidden,scope:'synthetic local HTTP only; no real SSH, credentials or user data'},null,2));
}
function finish(code){clearTimeout(watchdog);win?.destroy();server?.close();fs.rmSync(TEMP,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0)).catch(error=>{console.error(error);fs.writeFileSync(path.join(OUT,'renderer-failure.json'),JSON.stringify({error:error.stack,checks,errors},null,2));finish(1)});
