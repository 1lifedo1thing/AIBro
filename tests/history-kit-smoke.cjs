/* Real production Halaska bundle + history controller, synthetic in-memory data.
   No user's store, model service, credential, or external request is available. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'test-results/history-kit-20260929');fs.mkdirSync(OUT,{recursive:true});
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-history-kit-'));app.setPath('userData',TEMP);
const wait=ms=>new Promise(r=>setTimeout(r,ms));let server,win;const passes=[],errors=[],external=[];
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="run-history-actions.css"></head><body><button id="launch">执行历史</button><script src="halaska-ui.js"></script><script src="workstation-core.js"></script><script src="run-outcome-presentation.js"></script><script src="citation-evidence.js"></script><script src="note-consolidation.js"></script><script src="run-history.js"></script></body></html>`;
async function run(){
 server=http.createServer((request,response)=>{const name=decodeURIComponent(request.url.split('?')[0]).slice(1);if(!name){response.setHeader('Content-Type','text/html');response.end(html);return;}if(!/^[a-zA-Z0-9.-]+$/.test(name)){response.statusCode=404;response.end();return;}const file=path.join(ROOT,'app',name);if(!fs.existsSync(file)){response.statusCode=404;response.end();return;}response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'application/octet-stream');response.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 await app.whenReady();win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const blocked=/^https?:/.test(details.url)&&new URL(details.url).origin!==origin;if(blocked)external.push(details.url);callback({cancel:blocked});});
 const evalJS=code=>win.webContents.executeJavaScript(code,true);
 async function click(selector){const point=await evalJS(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||e.disabled||!(hit===e||e.contains(hit)))throw Error('Covered or disabled '+${JSON.stringify(selector)});return{x,y}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await wait(80);}
 async function input(selector,value){await click(selector);await evalJS(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(60);}
 async function step(name,fn){await fn();passes.push(name);console.log('PASS',name)}
 await win.loadURL(origin);
 await evalJS(`window.fixture={projects:[{id:'p',name:'研究项目'}],conversations:[{id:'c',title:'课程资料',projectId:'p'}],notes:[{id:'n',title:'已保存的分析笔记',content:'真实内容',projectId:'p'}],imports:[{id:'pdf',name:'章节讲义.pdf',projectId:'p'}],tasks:[],papers:[],trash:[],agentRuns:Array.from({length:86},(_,i)=>({id:'r'+i,goal:i===0?'整理自然语言处理课程讲义并结合长中文标题'.repeat(9):'历史执行 '+i,status:i===1?'running':'completed',conversationId:'c',projectId:'p',startedAt:100000-i*100,steps:Array.from({length:14},(_,j)=>({id:'s'+j,text:'逐页读取与核对材料 '+j,status:j===13&&i===1?'running':'done'})),results:i===0?[{type:'note',id:'n',text:'先前的名称'},{type:'import',id:'pdf'},{type:'note',id:'missing',text:'缺失的旧产出'}]:[],toolCalls:i<2?[{id:'read-1',type:'read_page',status:i===1?'running':'completed',request:{id:'pdf',page:2},result:{text:'证据原文'}}]:[]}))};window.saved=0;window.opened=[];window.failSave=false;window.toastMessages=[];window.historyController=WorkstationRunHistory.createController({getState:()=>fixture,openConversation:id=>opened.push(['conversation',id]),openResult:(type,id)=>{if(document.querySelector('#runHistoryDialog').open)throw Error('modal still open');opened.push([type,id]);return true;},toast:message=>toastMessages.push(message),save:async()=>{saved++;if(failSave)throw Error('磁盘已满');return true;}});document.querySelector('#launch').onclick=()=>historyController.open();void 0;`);
 await step('real Kit toolbar, list and detail use authoritative results with disabled missing targets',async()=>{
  await click('#launch');assert.equal(await evalJS(`document.querySelectorAll('[data-halaska-root^="RunHistory"]').length`),3);
  assert.equal(await evalJS(`document.querySelectorAll('[data-run-id]').length`),80);await click('[data-run-id="r0"]');
  assert.equal(await evalJS(`document.querySelector('.history-kit-goal h3').classList.contains('is-collapsed')`),true);await click('.history-kit-goal button');assert.equal(await evalJS(`document.querySelector('.history-kit-goal h3').classList.contains('is-collapsed')`),false);await click('.history-kit-goal button');
  assert.equal(await evalJS(`document.querySelector('[aria-label="打开知识：已保存的分析笔记"]').disabled`),false);assert.equal(await evalJS(`document.querySelector('[aria-label="打开知识：缺失的旧产出"]').disabled`),true);
  assert.match(await evalJS(`document.querySelector('.run-history-detail').textContent`),/成果已移入回收站/);
  await click('[aria-label="打开知识：已保存的分析笔记"]');assert.deepEqual(await evalJS('opened'),[['note','n']]);assert.equal(await evalJS('saved'),0);
 });
 await step('unchanged and changed live ticks retain focused button, detail scroll and disclosures',async()=>{
  await click('#launch');await click('[data-run-id="r1"]');await click('.history-kit-tools>summary');await click('.history-kit-tool>summary');await click('.history-kit-context>summary');
  await evalJS(`window.kept={details:document.querySelector('.history-kit-tool'),button:document.querySelector('.history-kit-origin button'),scroll:document.querySelector('.run-history-detail').scrollTop};kept.button.focus({preventScroll:true});fixture.agentRuns[1].steps.push({id:'new',text:'新的实际步骤',status:'running'});fixture.agentRuns[1].toolCalls[0].result={text:'更新后的真实读取结果'};`);
  await wait(2700);assert.equal(await evalJS(`document.activeElement===kept.button&&document.querySelector('.history-kit-tool')===kept.details&&kept.details.open`),true);
  assert.equal(await evalJS(`document.querySelector('.run-history-detail').scrollTop`),await evalJS('kept.scroll'));
  assert.match(await evalJS(`document.querySelector('.history-kit-tool').textContent`),/更新后的真实读取结果/);
  await evalJS(`fixture.agentRuns[1].status='completed';fixture.agentRuns[1].toolCalls[0].status='completed';`);await wait(2700);
  assert.match(await evalJS(`document.querySelector('[data-run-id="r1"]').textContent`),/已完成/);assert.equal(await evalJS('document.activeElement===kept.button'),true);assert.equal(await evalJS(`document.querySelector('.history-kit-context').open`),false);
 });
 await step('IME commits search once without removing the composing input or corrupting its value',async()=>{
  await evalJS(`historyController.close();historyController.open();window.composingInput=document.querySelector('#runHistorySearch');composingInput.focus();composingInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(composingInput,'自然语言');composingInput.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'自然语言'}));`);
  assert.equal(await evalJS(`document.querySelectorAll('[data-run-id]').length`),80);await wait(2700);assert.equal(await evalJS('document.activeElement===composingInput'),true);
  await evalJS(`composingInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'自然语言'}));`);await wait(100);
  assert.equal(await evalJS(`document.querySelectorAll('[data-run-id]').length`),1);assert.equal(await evalJS('composingInput.value'),'自然语言');assert.equal(await evalJS('document.activeElement===composingInput'),true);
 });
 await step('bulk delete still needs exact confirmation and failed durable save restores selected logs',async()=>{
  await input('#runHistorySearch','历史执行 2');assert.equal(await evalJS(`document.querySelectorAll('[data-run-id]').length`),11);await click('#runHistorySelectAll');await click('#runHistoryDeleteSelected');
  assert.equal(await evalJS(`document.activeElement.id`),'runHistoryDeleteCancel');await click('#runHistoryDeleteCancel');assert.equal(await evalJS('fixture.agentRuns.length'),86);
  await click('#runHistoryDeleteSelected');await evalJS('failSave=true');await click('#runHistoryDeleteConfirm');assert.equal(await evalJS('fixture.agentRuns.length'),86);assert.match(await evalJS(`document.querySelector('#runHistoryDeleteStatus').textContent`),/日志已保留.*磁盘已满/);
  await evalJS('failSave=false');await click('#runHistoryDeleteConfirm');assert.equal(await evalJS('fixture.agentRuns.length'),75);assert.equal(await evalJS('fixture.notes[0].content'),'真实内容');
 });
 await step('light and dark 1440px, 650px, 390px layouts contain long text and allow keyboard return',async()=>{
  for(const width of [1440,650,390])for(const theme of ['light','dark']){
   win.setSize(width,960);await evalJS(`document.body.classList.toggle('light-mode',${theme==='light'});historyController.close();historyController.open();`);await wait(100);await click('[data-run-id="r0"]');
   const boxes=await evalJS(`[...document.querySelectorAll('#runHistoryDialog,.run-history-controls,.run-history-bulk,.run-history-detail,.history-kit-result')].filter(e=>e.getBoundingClientRect().width).map(e=>({name:e.className,client:e.clientWidth,scroll:e.scrollWidth,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))`);
   for(const box of boxes){assert.ok(box.scroll<=box.client+1,`${width}/${theme} ${JSON.stringify(box)}`);assert.ok(box.left>=0&&box.right<=width+1,`${width}/${theme} outside: ${JSON.stringify(box)}`)}
   fs.writeFileSync(path.join(OUT,`detail-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());
   await click('.history-kit-detail-top button');assert.equal(await evalJS(`document.activeElement.dataset.runId`),'r0');
   fs.writeFileSync(path.join(OUT,`list-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());
  }
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(100);assert.equal(await evalJS(`document.querySelector('#runHistoryDialog').open`),false);assert.equal(await evalJS('document.activeElement.id'),'launch');
 });
 await step('reduced motion, no external request, no runtime errors, no guessed completion',async()=>{
  await evalJS(`document.body.classList.add('reduce-motion');historyController.open();`);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  const timing=await evalJS(`getComputedStyle(document.querySelector('.run-history-row')).transitionDuration`);assert.ok(timing==='0s',timing);
 });
 fs.rmSync(path.join(OUT,'failure.txt'),{force:true});
 fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({passed:passes.length,checks:passes,errors,external,fixtureOnly:true,formalApp:false},null,2));console.log(JSON.stringify({passed:passes.length,out:OUT}));
}
const watchdog=setTimeout(()=>{console.error('timed out');finish(1)},75000);
app.on('window-all-closed',()=>{});
let finishing=false;
async function finish(code){
 if(finishing)return;finishing=true;clearTimeout(watchdog);
 if(win&&!win.isDestroyed())win.destroy();
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 fs.rmSync(TEMP,{recursive:true,force:true});
 setImmediate(()=>app.exit(code));
}

run().then(()=>finish(0)).catch(error=>{console.error(error);fs.writeFileSync(path.join(OUT,'failure.txt'),String(error.stack||error));finish(1)});
