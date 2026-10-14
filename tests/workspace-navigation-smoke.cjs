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
 // The project "对话" tab is the chat list; resuming a thread is the separate "继续对话" action (docs/PROJECT_WORKSPACE_DELIVERY_20260930.md §1).
 const section=async name=>{await click(`[data-workspace-route=${name}]`);await until(()=>evaluate(`document.body.dataset.view==='project'&&state.ui.projectTab===${JSON.stringify(name)}`),'section '+name);};
 const resume=async id=>{await click('#workspaceResumeChat');await until(()=>evaluate(`document.body.dataset.view==='agent'&&state.currentConversationId===${JSON.stringify(id)}`),'resume '+id);};
 // .message-list scrolls smoothly and ConversationReading only treats real input as reading intent, so scroll with a real wheel and wait for it to settle.
 const wheelUp=async()=>{const p=await evaluate(`(()=>{const r=document.querySelector('#messageList').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);for(let n=0;n<3;n++){win.webContents.sendInputEvent({type:'mouseWheel',...p,deltaX:0,deltaY:400,canScroll:true});await wait(40);}let last=-1;await until(async()=>{const top=await evaluate(`document.querySelector('#messageList').scrollTop`);const settled=top===last;last=top;await wait(80);return settled;},'wheel settled');};
 const editText=text=>evaluate(`(()=>{const e=document.querySelector('.document-visual-canvas .ProseMirror');e.focus();const r=document.createRange();r.selectNodeContents(e.querySelector('p'));const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('insertText',false,${JSON.stringify(text)});})()`);
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
  await evaluate(`(()=>{const i=document.querySelector('#agentInput');i.value='保留这段尚未发送的项目草稿';i.dispatchEvent(new Event('input',{bubbles:true}));i.setSelectionRange(2,7);})()`);
  await wheelUp();const expectedScroll=await evaluate(`document.querySelector('#messageList').scrollTop`);
  assert.ok(await evaluate(`InteractionSystem.distanceFromEnd(document.querySelector('#messageList'))>200`),'the reader scrolled into history before leaving');
  await section('knowledge');assert.equal(await evaluate(`state.currentProjectId`),'nav-p');
  assert.equal(await evaluate(`document.querySelector('[data-project-panel=knowledge]').hidden`),false);
  await shot('project-sources');await section('tasks');assert.match(await evaluate(`document.querySelector('#projectTasks').textContent`),/只属于导航项目/);
  await resume('ui-conversation');
  const resumed=()=>evaluate(`(()=>{const i=document.querySelector('#agentInput');return [i.value,i.selectionStart,i.selectionEnd,document.querySelector('#messageList').scrollTop]})()`);
  // The reading position is restored from a text anchor, so allow sub-pixel rounding.
  for(let n=0;n<20&&Math.abs((await resumed())[3]-expectedScroll)>1;n++)await wait(50);
  const [value,start,end,scrollTop]=await resumed();
  assert.deepEqual([value,start,end],['保留这段尚未发送的项目草稿',2,7]);assert.ok(Math.abs(scrollTop-expectedScroll)<=1,JSON.stringify({scrollTop,expectedScroll}));
  await shot('resumed-chat');
 });
 await step('project navigation retains the exact reader and an unsaved rich document',async()=>{
  // The local draft store only accepts notes that already exist on disk.
  assert.equal(await evaluate(`saveDocumentDurably()`),true);
  await evaluate(`openPreview('note','ui-notes')`);await until(()=>evaluate(`[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].some(n=>n.textContent.trim()==='编辑'&&!n.disabled)`),'edit mode');
  await evaluate(`[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].find(n=>n.textContent.trim()==='编辑').click()`);await until(()=>evaluate(`!!document.querySelector('.document-visual-canvas .ProseMirror[contenteditable=true]')`),'visual editor');
  await editText('尚未保存的连续编辑内容');await until(()=>evaluate(`!!NoteEditor.currentContent()?.content.includes('尚未保存的连续编辑内容')`),'draft');
  await evaluate(`window.navEditor=document.querySelector('.document-visual-canvas .ProseMirror');window.navReader=document.querySelector('#previewDialog');`);
  await section('tasks');await section('knowledge');await resume('ui-conversation');
  // Project routes park the reader instead of covering the destination (docs/PROJECT_WORKSPACE_DELIVERY_20260930.md §2); it is retained, not closed.
  assert.equal(await evaluate(`ReadingPane.snapshot().retained&&ReadingPane.snapshot().activeKey===JSON.stringify(['note','ui-notes'])`),true);
  await click('#readingToggle');await until(()=>evaluate(`document.body.classList.contains('reading-open')`),'reopen reader');
  assert.equal(await evaluate(`window.navReader===document.querySelector('#previewDialog')&&window.navEditor===document.querySelector('.document-visual-canvas .ProseMirror')`),true);
  assert.equal(await evaluate(`document.body.classList.contains('reading-open')&&state.previewRecord.id==='ui-notes'`),true);
  assert.match(await evaluate(`document.querySelector('.document-visual-canvas .ProseMirror').textContent`),/尚未保存的连续编辑内容/);
  assert.doesNotMatch(await evaluate(`state.notes.find(x=>x.id==='ui-notes').content`),/尚未保存的连续编辑内容/);
  await shot('reader-retained');
 });
 await step('global and different-project conversations show their own scope and never consume another draft',async()=>{
  await evaluate(`WorkspaceNavigation.beforeRoute();openConversation('nav-free');WorkspaceNavigation.afterRoute()`);
  assert.match(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/自动归属\/未归属项目\/独立对话/);
  assert.equal(await evaluate(`document.querySelector('#workspaceChooseProject')!==null`),true);
  await evaluate(`WorkspaceNavigation.beforeRoute();openConversation('nav-other');WorkspaceNavigation.afterRoute()`);
  assert.match(await evaluate(`document.querySelector('#workspaceBreadcrumbs').textContent`),/科研\/其他项目\/另一个项目对话/);
  assert.equal(await evaluate(`WorkspaceNavigation.go('tasks','nav-p')`),true);await resume('ui-conversation');
  assert.equal(await evaluate(`state.currentConversationId`),'ui-conversation');assert.equal(await evaluate(`document.querySelector('#agentInput').value`),'保留这段尚未发送的项目草稿');
 });
 await step('project chat list is scoped and keyboard navigation remains usable',async()=>{
  await section('conversations');assert.equal(await evaluate(`document.querySelector('[data-project-panel=conversations]').hidden`),false);
  assert.match(await evaluate(`document.querySelector('#projectConversations').textContent`),/同项目更新的对话/);
  assert.doesNotMatch(await evaluate(`document.querySelector('#projectConversations').textContent`),/另一个项目对话/);
  await evaluate(`document.querySelector('[data-workspace-route=conversations]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  assert.equal(await evaluate(`document.activeElement.dataset.workspaceRoute`),'knowledge');await until(()=>evaluate(`state.ui.projectTab==='knowledge'`),'arrow activates the next section');
  await resume('ui-conversation');await evaluate(`state.ui.theme='dark';applyUiPreferences()`);await shot('dark-navigation');
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
