/* Real cross-panel navigation: tree, editable document, context and conversation. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18946,ORIGIN=`http://127.0.0.1:${PORT}`,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-workspace-')),STORE=path.join(TEMP,'store'),OUT=path.join(ROOT,'test-results/context-workspace-integration-20260924');
fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const checks=[],failures=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const start=Date.now();while(Date.now()-start<15000){if(await fn())return;await wait(60);}throw Error('Timeout: '+label);}
const watchdog=setTimeout(()=>{server?.kill();win?.destroy();app.exit(1)},120000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(ORIGIN+'/__health',r=>{r.resume();resolve(r.statusCode===200)}).on('error',()=>resolve(false))),'server');
 await app.whenReady();win=new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>cb({cancel:!details.url.startsWith(ORIGIN+'/')}));
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),shot=async name=>{await wait(250);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 async function step(label,fn){try{await fn();checks.push(label);console.log('PASS',label)}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message)}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 await evaluate(`(()=>{const p={id:'workspace-project',name:'工作台设计',workspace:'日常'};state.projects=[p];state.notes.forEach(n=>n.projectId=p.id);currentConversation().projectId=p.id;const r=state.agentRuns[0];r.contextMetrics={estimatedTokens:2400,characters:5600,loadedCapabilities:['knowledge','files'],history:{includedMessages:4,totalMessages:18,omittedMessages:14}};r.knowledgeReads=[{type:'read',recordType:'note',title:'设计原则',id:'ui-notes',offset:0}];r.toolCalls=[];state.ui.inspectorOpen=false;save();renderAll();showView('agent');})()`);
 await step('project tree docks beside the document without hiding the conversation; file and tab selection stay connected',async()=>{
  await click('#workspaceFilesToggle');await until(()=>evaluate(`document.querySelectorAll('#conversationProjectFiles [data-project-file-key]').length===2`),'files');
  await evaluate(`[...document.querySelectorAll('#conversationProjectFiles [data-project-file-key]')].find(x=>x.textContent.includes('交互改造计划')).click()`);
  await until(()=>evaluate(`state.previewRecord?.id==='ui-plan'&&document.querySelector('#conversationInspector').parentElement.id==='readingPane'`),'docked');
  assert.ok(await evaluate(`document.querySelector('#previewDialog').getBoundingClientRect().width>270`));
  await click('[data-note-action="rich"]');assert.equal(await evaluate(`document.querySelector('.note-document').dataset.mode`),'rich');
  await evaluate(`document.querySelector('#agentInput').value='审阅时保持可输入';document.querySelector('#agentInput').focus()`);assert.equal(await evaluate(`document.activeElement.id`),'agentInput');
  assert.equal(await evaluate(`document.querySelector('#previewDialog').matches(':modal')`),false);
  await shot('light-editor-tree');
 });
 await step('a dirty rendered document blocks tree navigation until explicit Save and Continue',async()=>{
  await evaluate(`(()=>{const e=document.querySelector('.markdown-editor-paragraph');e.querySelector('p').textContent='来自排版编辑的新内容';e.dispatchEvent(new InputEvent('input',{bubbles:true}));[...document.querySelectorAll('#conversationProjectFiles [data-project-file-key]')].find(x=>x.textContent.includes('设计原则')).click();})()`);
  await until(()=>evaluate(`!document.querySelector('.note-document-leave').hidden`),'leave guard');assert.equal(await evaluate(`state.previewRecord.id`),'ui-plan');
  await click('[data-note-action="save-leave"]');await until(()=>evaluate(`state.previewRecord.id==='ui-notes'`),'saved switch');
  assert.match(await evaluate(`state.notes.find(n=>n.id==='ui-plan').content`),/来自排版编辑/);
  await shot('selected-second-file');
 });
 await step('request evidence remains readable next to an open document and never invents model capacity',async()=>{
  await click('[data-inspector="context"]');await until(()=>evaluate(`!document.querySelector('#inspectorContext').classList.contains('hidden')`),'context tab');
  assert.equal(await evaluate(`document.querySelector('#conversationInspector').parentElement.id`),'readingPane');
  await click('#context-tab-recent');await until(()=>evaluate(`document.querySelector('#context-tab-recent').getAttribute('aria-selected')==='true'`),'request tab');
  assert.equal(await evaluate(`document.querySelector('#requestContextEvidence')`),null);
  await evaluate(`[...document.querySelectorAll('#context-panel-recent details')].find(x=>x.textContent.includes('历史覆盖与准备规模')).open=true`);
  const text=await evaluate(`document.querySelector('#context-panel-recent').textContent`);assert.match(text,/2,400/);assert.match(text,/4 \/ 18/);assert.match(text,/14 条历史原文/);assert.match(text,/不是模型剩余额度/);
  assert.match(text,/设计原则/);assert.match(text,/旧记录没有保存实际请求摘录/);
  await shot('context-evidence');await click('[data-inspector="files"]');
 });
 await step('stream refresh, close/reopen and conversation switching retain one Kit root and correct owner',async()=>{
  await click('[data-inspector="context"]');await click('#context-tab-recent');
  await evaluate(`(()=>{const input=document.querySelector('#context-panel-recent input');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'设计');input.dispatchEvent(new Event('input',{bubbles:true}));window.__contextInput=input;window.__contextRoot=document.querySelector('#contextWorkbench');})()`);
  await wait(50);await evaluate(`for(let n=0;n<20;n++){state.agentRuns[0].contextMetrics.characters++;AgentWorkspace.sync();}`);
  assert.deepEqual(await evaluate(`({same:window.__contextInput===document.querySelector('#context-panel-recent input'),focus:document.activeElement===window.__contextInput,value:window.__contextInput.value,roots:document.querySelectorAll('#contextWorkbench[data-halaska-root]').length})`),{same:true,focus:true,value:'设计',roots:1});
  await click('.workspace-inspector-close');await until(()=>evaluate(`!state.ui.inspectorOpen`),'close context');assert.equal(await evaluate(`document.activeElement.id`),'inspectorToggle');
  await click('#inspectorToggle');await until(()=>evaluate(`state.ui.inspectorOpen`),'reopen context');
  assert.equal(await evaluate(`window.__contextInput===document.querySelector('#context-panel-recent input')&&window.__contextInput.value==='设计'`),true);
  await evaluate(`window.__originalContextConversation=state.currentConversationId;state.conversations.push({id:'context-other-owner',title:'独立上下文',projectId:'workspace-project',messages:[],draftAttachmentIds:[]});openConversation('context-other-owner')`);
  await until(()=>evaluate(`document.querySelector('#context-tab-next').getAttribute('aria-selected')==='true'`),'new conversation context');
  assert.equal(await evaluate(`window.__contextInput===document.querySelector('#context-panel-recent input')`),false);assert.equal(await evaluate(`document.querySelector('#contextWorkbench')===window.__contextRoot`),true);
  await evaluate(`openConversation(window.__originalContextConversation)`);await click('[data-inspector="files"]');
  assert.equal(await evaluate(`document.querySelectorAll('#conversationProjectFiles').length`),1);
 });
 await step('dark mode, reader closure and narrow navigation preserve one accessible tree and no page overflow',async()=>{
  await evaluate(`state.ui.theme='dark';applyUiPreferences()`);await shot('dark-editor-tree');
  await click('#readingCollapse');await until(()=>evaluate(`document.querySelector('#conversationInspector').parentElement.classList.contains('chat-grid')`),'restored tree');
  assert.equal(await evaluate(`document.querySelectorAll('#conversationProjectFiles').length`),1);
  win.setSize(800,900);await evaluate(`WorkspaceLayout.refresh();openPreview('note','ui-plan')`);await until(()=>evaluate(`document.body.classList.contains('reading-open')`),'narrow reader');
  assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
  await evaluate(`state.ui.inspectorOpen=false;applyUiPreferences()`);await click('#readerFilesToggle');
  assert.equal(await evaluate(`document.querySelector('#readerFilesToggle').getAttribute('aria-expanded')`),'true');
  await shot('narrow-files');
 });
 await step('ordinary-width context keeps controls and text inside its existing layout budget',async()=>{
  win.setSize(1180,1000);await evaluate(`ReadingPane.hide();state.ui.theme='light';applyUiPreferences()`);await click('[data-inspector="context"]');await click('#context-tab-next');
  await until(()=>evaluate(`document.querySelector('#conversationInspector').parentElement.classList.contains('chat-grid')`),'ordinary context');
  const fit=await evaluate(`(()=>{const host=document.querySelector('#contextWorkbench'),pane=document.querySelector('#conversationInspector');return{host:host.scrollWidth<=host.clientWidth+1,pane:pane.scrollWidth<=pane.clientWidth+1,body:document.documentElement.scrollWidth<=innerWidth,width:Math.round(pane.getBoundingClientRect().width)}})()`);
  assert.equal(fit.host,true);assert.equal(fit.pane,true);assert.equal(fit.body,true);assert.ok(fit.width>=230&&fit.width<=260);await shot('ordinary-context-light');
  await evaluate(`state.ui.theme='dark';applyUiPreferences()`);await shot('ordinary-context-dark');
 });
 const report={checks,passed:checks.length,failures,modelCalls:0,workspace:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));return failures.length?1:0;
}
run().then(code=>{clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(code)}).catch(e=>{console.error(e);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1)});
