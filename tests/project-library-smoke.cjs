const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=Number(process.env.AIBRO_PROJECT_LIBRARY_TEST_PORT||18952),ORIGIN=`http://127.0.0.1:${PORT}`,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-navigation-')),STORE=path.join(TEMP,'store'),OUT=path.join(ROOT,'test-results/project-library-20260924');
fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const checks=[],failures=[],rendererErrors=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const start=Date.now();while(Date.now()-start<15000){if(await fn())return;await wait(60)}throw Error('Timeout: '+label)}
const watchdog=setTimeout(()=>{server?.kill();win?.destroy();app.exit(1)},120000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(ORIGIN+'/__health',r=>{r.resume();resolve(r.statusCode===200)}).on('error',()=>resolve(false))),'server');
 await app.whenReady();win=new BrowserWindow({show:false,width:1680,height:980,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>cb({cancel:!details.url.startsWith(ORIGIN+'/')}));
 win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push(event.message)});
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=s=>evaluate(`document.querySelector(${JSON.stringify(s)}).click()`),shot=async name=>{await wait(200);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 async function step(label,fn){try{await fn();checks.push(label);console.log('PASS',label)}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message)}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 assert.equal(await evaluate(`!!window.WorkspaceNavigation&&!!document.querySelector('#workspaceNavigation')`),true,'navigation is loaded and initialized by the application');
 await evaluate(`(()=>{state.projects=[{id:'nav-p',name:'导航连续性',workspace:'日常'},{id:'nav-q',name:'其他项目',workspace:'科研'}];state.notes.forEach(n=>n.projectId='nav-p');const c=currentConversation();c.projectId='nav-p';c.messages.push(...Array.from({length:20},(_,i)=>({id:'long-'+i,role:i%2?'agent':'user',text:'导航记录 '+i+'。用于验证对话离开和返回时保留当前阅读位置。'.repeat(8),at:Date.now()+i})));state.conversations.push({id:'nav-newer',title:'同项目更新的对话',projectId:'nav-p',workspace:'日常',messages:[],attachments:[],draft:'',updatedAt:Date.now()+10000},{id:'nav-other',title:'另一个项目对话',projectId:'nav-q',workspace:'科研',messages:[],attachments:[],draft:''},{id:'nav-free',title:'独立对话',projectId:null,workspace:'auto',messages:[],attachments:[],draft:''});state.tasks=[{id:'nav-task',title:'只属于导航项目的任务',projectId:'nav-p',workspace:'日常',status:'todo'}];normalizeStateShape(state);showView('agent');renderAll();WorkspaceNavigation.afterRoute();})()`);

 await evaluate(`WorkspaceNavigation.go('knowledge','nav-p')`);
 await step('sources have one canonical collection and no tasks or repeated document cards',async()=>{
  assert.equal(await evaluate(`document.querySelector('#projectKnowledge').closest('article').hidden`),true);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#projectCollection [data-cui-kind]')].map(x=>x.dataset.cuiKind)`),['note','note']);
  assert.equal(await evaluate(`document.querySelectorAll('#projectTree [data-project-file-key]').length`),0);
  assert.equal(await evaluate(`document.querySelector('#projectAddTask').getClientRects().length`),0);
  assert.equal(await evaluate(`document.querySelector('#projectMemoryControls').closest('[data-project-panel]').dataset.projectPanel`),'overview');
 });
 await step('folder, search, selection and view switches retain their expected boundaries',async()=>{
  await click('[data-project-library-folder="design/research"]');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#projectCollection [data-cui-id]')].map(x=>x.dataset.cuiId)`),['ui-notes']);
  await click('#projectCollection [data-cui-check]');assert.match(await evaluate(`document.querySelector('#projectCollection .collection-batch').textContent`),/已选择 1 项/);
  await click('[data-project-library-all]');assert.equal(await evaluate(`document.querySelectorAll('#projectCollection [data-cui-id]').length`),2);
  await evaluate(`(()=>{const i=document.querySelector('#projectCollection [data-cui-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'交互');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#projectCollection [data-cui-id]')].map(x=>x.dataset.cuiId)`),['ui-plan']);assert.equal(await evaluate(`!!document.querySelector('#projectCollection .collection-batch')`),false);
  await evaluate(`(()=>{const i=document.querySelector('#projectCollection [data-cui-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  for(const mode of ['cards','tree','list']){await click(`#projectCollection [data-cui-view="${mode}"]`);assert.equal(await evaluate(`document.querySelector('#projectCollection [data-cui-view="${mode}"]').getAttribute('aria-pressed')`),'true');}
 });
 await step('1440, 1100, 800, 620 and 440 widths retain every toolbar control within its surface',async()=>{
  const metrics=[];
  for(const width of [1440,1100,800,620,440]){
   win.setSize(width,840);await wait(250);await evaluate(`WorkspaceLayout.refresh()`);await wait(100);
   const result=await evaluate(`(()=>{const host=document.querySelector('#projectCollection').getBoundingClientRect(),buttons=[...document.querySelectorAll('#projectCollection [data-cui-type],#projectCollection [data-cui-sort],#projectCollection [data-cui-view]')].map(e=>({name:e.getAttribute('aria-label'),x:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}));return {width:innerWidth,host:{left:host.left,right:host.right},buttons,overflow:document.documentElement.scrollWidth>innerWidth}})()`);metrics.push(result);
   assert.equal(result.overflow,false,`${width} page overflow`);assert.equal(result.buttons.length,5,'every Kit toolbar control is measured');for(const b of result.buttons){assert.ok(b.x>=result.host.left-1&&b.right<=result.host.right+1,`${width}: ${b.name} inside ${JSON.stringify(result)}`)}
   await shot(`sources-${width}`);
  }
  fs.writeFileSync(path.join(OUT,'dimensions.json'),JSON.stringify(metrics,null,2));
 });
 await step('task and overview columns contain their own content without the sources rail',async()=>{
  win.setSize(1100,840);await click('[data-workspace-route=tasks]');assert.equal(await evaluate(`document.querySelector('#projectTreePanel').getClientRects().length`),0);assert.equal(await evaluate(`document.querySelector('#projectAddSource').getClientRects().length`),0);assert.ok(await evaluate(`document.querySelector('#projectAddTask').getClientRects().length`));assert.match(await evaluate(`document.querySelector('#projectTasks').textContent`),/只属于导航项目的任务/);await shot('tasks-1100');
  await click('[data-workspace-route=overview]');assert.ok(await evaluate(`document.querySelector('#projectMemoryControls').getClientRects().length`));await shot('overview-1100');
 });
 await step('the source picker imports directly into the project without creating or consuming a conversation draft',async()=>{
  await click('[data-workspace-route=knowledge]');const before=await evaluate(`({id:state.currentConversationId,conversations:state.conversations.length,draft:currentConversation().draft})`);
  await evaluate(`(()=>{const input=document.querySelector('#projectLibraryInput'),data=new DataTransfer();data.items.add(new File(['# Imported into the current project\\n'], 'project-source.md',{type:'text/markdown'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await until(()=>evaluate(`!importMaterials.busy&&state.imports.some(i=>i.name==='project-source.md')`),'project source import');
  assert.equal(await evaluate(`state.imports.find(i=>i.name==='project-source.md').projectId`),'nav-p');assert.deepEqual(await evaluate(`({id:state.currentConversationId,conversations:state.conversations.length,draft:currentConversation().draft})`),before);
  assert.equal(await evaluate(`document.querySelectorAll('#projectCollection [data-cui-kind=task]').length`),0);await shot('source-imported');await evaluate(`state.ui.theme='dark';applyUiPreferences()`);win.setSize(800,840);await wait(150);await shot('sources-dark-800');
 });
 await step('Kit search retains its DOM, selection and Chinese IME through background updates',async()=>{
  await evaluate(`WorkspaceNavigation.go('knowledge','nav-p');state.ui.theme='light';applyUiPreferences();window.librarySearch=document.querySelector('#projectCollection [data-cui-search]');librarySearch.focus();`);
  await win.webContents.insertText('交互');
  assert.equal(await evaluate(`document.querySelectorAll('#projectCollection [data-cui-id]').length`),1);
  assert.equal(await evaluate(`document.activeElement===librarySearch`),true);
  await evaluate(`librarySearch.setSelectionRange(1,1);renderProject('nav-p')`);
  assert.equal(await evaluate(`document.querySelector('#projectCollection [data-cui-search]')===librarySearch&&librarySearch.selectionStart===1`),true);
  await evaluate(`librarySearch.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(librarySearch,'设计');librarySearch.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));renderProject('nav-p')`);
  assert.equal(await evaluate(`document.querySelector('#projectCollection [data-cui-search]')===librarySearch&&librarySearch.value==='设计'`),true);
  await evaluate(`librarySearch.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'设计'}))`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#projectCollection [data-cui-id]')].map(x=>x.dataset.cuiId)`),['ui-notes']);
  await evaluate(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(librarySearch,'no-matching-library-item');librarySearch.dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#projectCollection [data-halaska-root=LibraryEmpty]')!==null`),true);
  await click('#projectCollection [data-halaska-root=LibraryEmpty] button');
  assert.equal(await evaluate(`librarySearch.value`),'');assert.equal(await evaluate(`document.activeElement===librarySearch`),true);
 });
 await step('Kit view and project tabs activate by keyboard without remounting the selected control',async()=>{
  await evaluate(`document.querySelector('#projectCollection [data-cui-view=list]').focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(100);
  assert.equal(await evaluate(`document.activeElement.dataset.cuiView`),'cards');assert.ok(await evaluate(`document.querySelector('#projectCollection .collection-cards')!==null`));
  await evaluate(`document.querySelector('[data-workspace-route=knowledge]').focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(100);
  assert.equal(await evaluate(`document.activeElement.dataset.workspaceRoute`),'tasks');assert.equal(await evaluate(`state.ui.projectTab`),'tasks');
  await evaluate(`WorkspaceNavigation.go('overview','nav-p')`);assert.equal(await evaluate(`document.querySelector('#projectMetrics').dataset.halaskaRoot`),'ProjectMetrics');
  assert.equal(await evaluate(`document.querySelector('#projectMetrics [role=progressbar]').getAttribute('aria-valuenow')`),'0');
 });
 await step('zero-task overview uses one start action and restores analytics after a task is added',async()=>{
  await evaluate(`state.ui.theme='light';applyUiPreferences();window.libraryOriginalTasks=state.tasks;state.tasks=[];WorkspaceNavigation.go('overview','nav-p');renderProject('nav-p');WorkspaceNavigation.afterRoute()`);
  for(const selector of ['#projectMetrics','#projectSummary','#projectPlanning','#projectActivity','#projectAddTask'])assert.equal(await evaluate(`document.querySelector('${selector}')?.getClientRects().length||0`),0,selector+' is collapsed');
  assert.ok(await evaluate(`document.querySelector('#projectFirstInput').getClientRects().length`));assert.match(await evaluate(`document.querySelector('#projectOnboarding').textContent`),/把资料变成下一步行动/);
  assert.equal(await evaluate(`document.querySelector('#projectOnboarding').dataset.halaskaRoot`),'EmptyState');
  assert.equal(await evaluate(`document.querySelector('#projectFirstInput').type`),'button');
  win.setSize(1100,840);await shot('overview-no-tasks-1100');win.setSize(620,840);await shot('overview-no-tasks-620');
  await click('#projectFirstInput');assert.equal(await evaluate(`document.body.dataset.view`),'agent');assert.equal(await evaluate(`currentConversation().projectId`),'nav-p');
  await evaluate(`state.tasks=window.libraryOriginalTasks;WorkspaceNavigation.go('overview','nav-p');renderProject('nav-p');WorkspaceNavigation.afterRoute()`);
  assert.equal(await evaluate(`document.querySelector('#projectOnboarding').hidden`),true);assert.ok(await evaluate(`document.querySelector('#projectMetrics').getClientRects().length`));assert.ok(await evaluate(`document.querySelector('#projectPlanning').getClientRects().length`));
 });
 await step('new Kit controls switch languages without changing user content or search focus',async()=>{
  await evaluate(`WorkspaceNavigation.go('knowledge','nav-p');window.languageSearch=document.querySelector('#projectCollection [data-cui-search]');languageSearch.focus();WorkstationI18n.setLanguage('en')`);await wait(80);
  assert.equal(await evaluate(`document.activeElement===languageSearch`),true);
  const labels=await evaluate(`({sort:document.querySelector('#projectCollection [data-cui-sort]').textContent,count:document.querySelector('#projectCollection .collection-count').textContent,views:[...document.querySelectorAll('#projectCollection [data-cui-view]')].map(x=>x.textContent),title:state.notes.find(n=>n.id==='ui-plan').title})`);
  assert.match(labels.sort,/Updated/);assert.match(labels.count,/items/);assert.deepEqual(labels.views,['Tree','List','Cards']);assert.equal(labels.title,'交互改造计划');
  await click('#projectCollection [data-cui-check]');assert.match(await evaluate(`document.querySelector('#projectCollection .collection-batch').textContent`),/Clear selection/);
  await evaluate(`WorkstationI18n.setLanguage('zh-CN')`);await wait(50);
  assert.match(await evaluate(`document.querySelector('#projectCollection [data-cui-sort]').textContent`),/更新时间/);
 });
 await step('Kit integration has no renderer errors',async()=>assert.deepEqual(rendererErrors,[]));
 const report={rendererErrors,passed:checks.length,checks,failures,modelCalls:0,workspace:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');return failures.length?1:0;
}
run().then(code=>{clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(code)}).catch(e=>{console.error(e);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1)});
