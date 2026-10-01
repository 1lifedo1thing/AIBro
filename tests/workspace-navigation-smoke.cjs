const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18951,ORIGIN=`http://127.0.0.1:${PORT}`,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-navigation-')),STORE=path.join(TEMP,'store'),OUT=path.join(ROOT,'test-results/workspace-navigation-20260924');
fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const checks=[],failures=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const start=Date.now();while(Date.now()-start<15000){if(await fn())return;await wait(60)}throw Error('Timeout: '+label)}
const watchdog=setTimeout(()=>{server?.kill();win?.destroy();app.exit(1)},120000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(ORIGIN+'/__health',r=>{r.resume();resolve(r.statusCode===200)}).on('error',()=>resolve(false))),'server');
 await app.whenReady();win=new BrowserWindow({show:false,width:1680,height:980,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>cb({cancel:!details.url.startsWith(ORIGIN+'/')}));
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=s=>evaluate(`document.querySelector(${JSON.stringify(s)}).click()`),shot=async name=>{await wait(200);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 async function step(label,fn){try{await fn();checks.push(label);console.log('PASS',label)}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message)}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 assert.equal(await evaluate(`!!window.WorkspaceNavigation&&!!document.querySelector('#workspaceNavigation')`),true,'navigation is loaded and initialized by the application');
 await evaluate(`(()=>{state.projects=[{id:'nav-p',name:'导航连续性',workspace:'日常'},{id:'nav-q',name:'其他项目',workspace:'科研'}];state.notes.forEach(n=>n.projectId='nav-p');const c=currentConversation();c.projectId='nav-p';c.messages.push(...Array.from({length:20},(_,i)=>({id:'long-'+i,role:i%2?'agent':'user',text:'导航记录 '+i+'。用于验证对话离开和返回时保留当前阅读位置。'.repeat(8),at:Date.now()+i})));state.conversations.push({id:'nav-newer',title:'同项目更新的对话',projectId:'nav-p',workspace:'日常',messages:[],attachments:[],draft:'',updatedAt:Date.now()+10000},{id:'nav-other',title:'另一个项目对话',projectId:'nav-q',workspace:'科研',messages:[],attachments:[],draft:''},{id:'nav-free',title:'独立对话',projectId:null,workspace:'auto',messages:[],attachments:[],draft:''});state.tasks=[{id:'nav-task',title:'只属于导航项目的任务',projectId:'nav-p',workspace:'日常',status:'todo'}];normalizeStateShape(state);showView('agent');renderAll();WorkspaceNavigation.afterRoute();})()`);
 await step('breadcrumb follows conversation ownership rather than a stale project view',async()=>{
  await evaluate(`state.currentProjectId='nav-q';WorkspaceNavigation.afterRoute()`);
  assert.match(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/日常\/导航连续性\/让 Agent/);
  assert.doesNotMatch(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/其他项目/);
 });
 await step('project and chat auto scopes display readable labels with project precedence',async()=>{
  await evaluate(`currentConversation().workspace='auto';WorkspaceNavigation.afterRoute()`);assert.match(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/日常\/导航连续性/);
  await evaluate(`state.projects.find(p=>p.id==='nav-p').workspace='auto';renderAll();WorkspaceNavigation.afterRoute()`);assert.match(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/自动归属\/导航连续性/);assert.doesNotMatch(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/auto/);assert.match(await evaluate(`document.querySelector('#composerContext').textContent`),/自动归属/);assert.equal(await evaluate(`state.projects.find(p=>p.id==='nav-p').workspace`),'auto');
  await click('#workspaceConversationsToggle');assert.match(await evaluate(`document.querySelector('[data-workspace-conversation="ui-conversation"]').textContent`),/自动归属/);await evaluate(`document.querySelector('.workspace-conversation-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));state.projects.find(p=>p.id==='nav-p').workspace='日常';WorkspaceNavigation.afterRoute()`);
 });
 await step('chat to sources to tasks returns to the exact conversation with its draft, selection and scroll',async()=>{
  await evaluate(`(()=>{const i=document.querySelector('#agentInput');i.value='保留这段尚未发送的项目草稿';i.dispatchEvent(new Event('input',{bubbles:true}));i.setSelectionRange(2,7);const m=document.querySelector('#messageList');m.scrollTop=260;window.navExpectedScroll=m.scrollTop;})()`);
  await click('[data-workspace-route=knowledge]');assert.equal(await evaluate(`document.body.dataset.view`),'project');assert.equal(await evaluate(`state.currentProjectId`),'nav-p');assert.equal(await evaluate(`state.ui.projectTab`),'knowledge');
  assert.equal(await evaluate(`document.querySelector('[data-project-panel=knowledge]').hidden`),false);
  await shot('project-sources');await click('[data-workspace-route=tasks]');assert.equal(await evaluate(`state.ui.projectTab`),'tasks');assert.match(await evaluate(`document.querySelector('#projectTasks').textContent`),/只属于导航项目/);
  await click('[data-workspace-route=conversation]');await wait(100);
  assert.equal(await evaluate(`state.currentConversationId`),'ui-conversation');
  assert.deepEqual(await evaluate(`(()=>{const i=document.querySelector('#agentInput');return [i.value,i.selectionStart,i.selectionEnd,document.querySelector('#messageList').scrollTop]})()`),['保留这段尚未发送的项目草稿',2,7,await evaluate('window.navExpectedScroll')]);
  await shot('resumed-chat');
 });
 await step('project navigation retains the exact reader and an unsaved rich document',async()=>{
  await evaluate(`openPreview('note','ui-notes')`);await click('[data-note-action=rich]');
  await evaluate(`(()=>{window.navEditor=document.querySelector('.markdown-editor-paragraph');window.navEditor.querySelector('p').textContent='尚未保存的连续编辑内容';window.navEditor.dispatchEvent(new InputEvent('input',{bubbles:true}));window.navReader=document.querySelector('#previewDialog');})()`);
  await click('[data-workspace-route=tasks]');await click('[data-workspace-route=knowledge]');await click('[data-workspace-route=conversation]');await wait(100);
  assert.equal(await evaluate(`window.navReader===document.querySelector('#previewDialog')&&window.navEditor===document.querySelector('.markdown-editor-paragraph')`),true);
  assert.equal(await evaluate(`document.body.classList.contains('reading-open')&&state.previewRecord.id==='ui-notes'`),true);
  assert.match(await evaluate(`document.querySelector('.markdown-editor-paragraph').textContent`),/尚未保存的连续编辑内容/);
  assert.doesNotMatch(await evaluate(`state.notes.find(x=>x.id==='ui-notes').content`),/尚未保存的连续编辑内容/);
  await shot('reader-retained');
 });
 await step('global and different-project conversations show their own scope and never consume another draft',async()=>{
  await evaluate(`WorkspaceNavigation.beforeRoute();openConversation('nav-free');WorkspaceNavigation.afterRoute()`);
  assert.match(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/自动归属\/未归属项目\/独立对话/);
  assert.equal(await evaluate(`document.querySelector('#workspaceChooseProject')!==null`),true);
  await evaluate(`WorkspaceNavigation.beforeRoute();openConversation('nav-other');WorkspaceNavigation.afterRoute()`);
  assert.match(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/科研\/其他项目\/另一个项目对话/);
  await evaluate(`WorkspaceNavigation.go('tasks','nav-p')`);await click('[data-workspace-route=conversation]');
  assert.equal(await evaluate(`state.currentConversationId`),'ui-conversation');assert.equal(await evaluate(`document.querySelector('#agentInput').value`),'保留这段尚未发送的项目草稿');
 });
 await step('project chat list is scoped and keyboard navigation remains usable',async()=>{
  await click('#workspaceChatList');assert.equal(await evaluate(`state.ui.projectTab`),'conversations');
  assert.match(await evaluate(`document.querySelector('#projectConversations').textContent`),/同项目更新的对话/);
  assert.doesNotMatch(await evaluate(`document.querySelector('#projectConversations').textContent`),/另一个项目对话/);
  await evaluate(`document.querySelector('[data-workspace-route=conversation]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  assert.equal(await evaluate(`document.activeElement.dataset.workspaceRoute`),'knowledge');
  await click('[data-workspace-route=conversation]');await evaluate(`state.ui.theme='dark';applyUiPreferences()`);await shot('dark-navigation');
 });
 await step('all chats search opens any conversation directly without a project detour',async()=>{
  await click('#workspaceConversationsToggle');assert.equal(await evaluate(`document.querySelector('#workspaceConversationsToggle').getAttribute('aria-expanded')`),'true');
  assert.equal(await evaluate(`document.querySelectorAll('[data-workspace-conversation]').length`),4);
  win.setSize(620,650);await wait(150);assert.equal(await evaluate(`(()=>{const r=document.querySelector('#workspaceConversationMenu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`),true,'open menu follows a narrower and shorter window');win.setSize(1680,980);await wait(100);
  await evaluate(`(()=>{const s=document.querySelector('.workspace-conversation-search');s.value='独立';s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-workspace-conversation]').length`),1);
  await click('[data-workspace-conversation="nav-free"]');assert.equal(await evaluate(`state.currentConversationId`),'nav-free');assert.equal(await evaluate(`document.body.dataset.view`),'agent');assert.equal(await evaluate(`document.querySelector('#workspaceConversationMenu')`),null);
  assert.match(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/未归属项目/);
  await click('#workspaceConversationsToggle');await evaluate(`document.querySelector('.workspace-conversation-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);assert.equal(await evaluate(`document.activeElement.id`),'workspaceConversationsToggle');
 });
 await step('global route labels do not retain a previous project breadcrumb',async()=>{await evaluate(`showView('settings')`);assert.equal(await evaluate(`document.querySelector('#currentContext').textContent`),'设置');await evaluate(`showView('daily')`);assert.equal(await evaluate(`document.querySelector('#currentContext').textContent`),'日常空间');});
 const report={passed:checks.length,checks,failures,modelCalls:0,workspace:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');return failures.length?1:0;
}
run().then(code=>{clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(code)}).catch(e=>{console.error(e);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1)});
