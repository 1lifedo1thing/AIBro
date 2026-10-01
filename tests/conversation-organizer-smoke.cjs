/* Actual Kit bundle + organizer controller, isolated renderer and synthetic data.
   Durable-hook failures are injected; this is not native or production-data QA. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'test-results/conversation-organizer-20260924'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-conversation-organizer-'));
fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let win,server;const checks=[],failures=[],errors=[],remote=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const watchdog=setTimeout(()=>{win?.destroy();server?.close();app.exit(1);},90000);
const fixture={projects:[{id:'project',name:'AI Bro 设计'},{id:'paper',name:'论文投稿'}],folders:{projects:[],conversations:[{id:'existing',name:'待办讨论',createdAt:1}]},conversations:[
 {id:'c1',title:'交互方案讨论',projectId:'project',workspace:'科研',updatedAt:500,messages:[{id:'u1',role:'user',text:'请整理 AI Bro 对话工作台的交互方案，重点设计消息反馈。'},{id:'a1',role:'agent',live:false,planPreview:true,runId:'actual-shape-run',steps:[{text:'Step details must not become a summary'}],text:'工作台采用并排审阅布局，并保留对话中的工具执行记录。'}]},
 {id:'c2',title:'界面视觉设计',projectId:'project',workspace:'科研',updatedAt:400,messages:[{id:'u2',role:'user',text:'请完善 AI Bro 的界面视觉设计和文件审阅体验。'},{id:'a2',role:'assistant',text:'保留原有配色，改善文字层级、文件导航和小窗口布局。'}]},
 {id:'c3',title:'工具调用验证',projectId:'project',workspace:'科研',updatedAt:300,messages:[{id:'u3',role:'user',text:'验证 AI Bro 的工具调用、取消与人工接管流程。'}]},
 {id:'c4',title:'会议投稿检查',projectId:'paper',workspace:'科研',updatedAt:200,messages:[{id:'u4',role:'user',text:'检查会议投稿中的作者栏和参考文献。'},{id:'a4',role:'assistant',text:'作者栏需要按官方模板排版，参考文献已经逐项核对。'}]},
 {id:'private',title:'PRIVATE SHOULD NOT APPEAR',private:true,messages:[{role:'user',text:'private'}]},
 {id:'archived',title:'ARCHIVED SHOULD NOT APPEAR',archived:true,messages:[{role:'user',text:'archived'}]}
]};
(async()=>{
 const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/liquid-glass.css"><style>body{display:block!important;padding:24px}#conversationList{width:280px}.sidebar-item-row{display:flex}button{cursor:pointer}</style></head><body class="liquid-glass light-mode" data-view="agent"><button id="opener">整理对话</button><div id="conversationList"><div class="sidebar-folder"><span>待办讨论</span><button data-folder-menu="conversations:existing">管理</button></div><div class="sidebar-item-row"><button class="conversation-item" data-conversation-id="c1">交互方案讨论</button></div></div><script src="/halaska-ui.js"></script><script src="/conversation-organization.js"></script><script src="/conversation-organizer.js"></script></body></html>`;
 server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname;if(name==='/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(html);}const file=path.join(ROOT,'app',path.basename(name));if(!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'application/javascript'});res.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await app.whenReady();
 win=new BrowserWindow({show:false,width:1240,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});const origin=`http://127.0.0.1:${server.address().port}`;
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{const external=!details.url.startsWith(origin+'/');if(external)remote.push(details.url);callback({cancel:external});});
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const fill=(selector,value)=>evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const select=(selector,value)=>evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const key=async(keyCode,modifiers=[])=>{win.show();win.focus();win.webContents.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode:keyCode.replace(/^Arrow/,''),modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode:keyCode.replace(/^Arrow/,''),modifiers});await wait(30);};
 const shot=async name=>{await wait(150);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const reset=async(options={})=>{await evaluate(`ConversationOrganizer.close();window.state=structuredClone(fixture);window.commands=[];window.mode='resolve';window.opened=[];document.querySelector('#opener').focus();ConversationOrganizer.open(${JSON.stringify(options)});`);await wait(30);};
 async function step(name,fn){try{await fn();checks.push(name);console.log('PASS',name);}catch(error){failures.push({name,error:error.stack});console.error('FAIL',name,error.message);}}
 await win.loadURL(origin);await evaluate(`window.fixture=${JSON.stringify(fixture)};window.state=structuredClone(fixture);window.commands=[];window.mode='resolve';window.opened=[];window.notices=[];ConversationOrganizer.init({getState:()=>state,commit:async command=>{commands.push(command);if(mode==='pending')await new Promise((resolve,reject)=>{window.resolveSave=resolve;window.rejectSave=reject});if(mode==='reject')throw Error('测试磁盘保存失败');state=ConversationOrganization.apply(state,command,{now:1000,makeId:()=> 'folder-'+commands.length});return state;},openConversation:id=>opened.push(id),toast:value=>notices.push(value)});document.querySelector('#opener').onclick=()=>ConversationOrganizer.open();void 0;`);
 await step('opening and refreshing use actual recommendations and never modify conversations or folders',async()=>{
  await click('#opener');assert.equal(await evaluate(`document.querySelector('.conversation-organizer-dialog [data-halaska-root]').dataset.halaskaRoot`),'ConversationOrganizerView');
  assert.equal(await evaluate(`document.querySelectorAll('[data-recommendation-id]').length`),1);assert.equal(await evaluate(`document.querySelectorAll('[data-organizer-member]').length`),3);
  assert.match(await evaluate(`document.querySelector('.organizer-reason').textContent`),/AI Bro/);assert.doesNotMatch(await evaluate(`document.querySelector('.conversation-organizer-dialog').textContent`),/PRIVATE|ARCHIVED/);
  await click('#organizerRefresh');assert.equal(await evaluate('commands.length'),0);assert.equal(await evaluate('JSON.stringify(state)===JSON.stringify(fixture)'),true);
  assert.match(await evaluate(`getComputedStyle(document.querySelector('#organizerApprove')).fontFamily`),/Geist/);await shot('recommendations-light');
 });
 await step('draft edits and member preview preserve draft state until explicit confirmation',async()=>{
  await fill('#organizerProposedName','工作台体验');await click('[data-organizer-member="c3"]');
  assert.equal(await evaluate('commands.length'),0);assert.equal(await evaluate('JSON.stringify(state)===JSON.stringify(fixture)'),true);
  await evaluate(`document.querySelector('.organizer-member button[aria-label="预览 交互方案讨论"]').click()`);await wait(30);
  assert.match(await evaluate(`document.querySelector('.organizer-summary').textContent`),/并排审阅布局/);
  assert.equal(await evaluate(`ConversationOrganizer.summary('c1').messageCount`),2);assert.doesNotMatch(await evaluate(`document.querySelector('.organizer-summary').textContent`),/等待答复|Step details/);
  await evaluate(`[...document.querySelectorAll('.organizer-detail button')].find(button=>button.textContent.includes('返回建议')).click()`);await wait(30);
  assert.equal(await evaluate(`document.querySelector('#organizerProposedName').value`),'工作台体验');assert.equal(await evaluate(`document.querySelector('[data-organizer-member="c3"]').checked`),false);
  await click('#organizerApprove');await wait(50);
  assert.deepEqual(await evaluate(`state.conversations.slice(0,3).map(chat=>chat.folderId||null)`),['folder-1','folder-1',null]);assert.equal(await evaluate(`state.folders.conversations.find(folder=>folder.id==='folder-1').name`),'工作台体验');
  assert.equal(await evaluate(`JSON.stringify(state.conversations.map(chat=>chat.messages))===JSON.stringify(fixture.conversations.map(chat=>chat.messages))`),true);assert.equal(await evaluate('commands.length'),1);
 });
 await step('existing target accepts edited membership while dismiss changes only suggestion metadata',async()=>{
  await reset();await select('#organizerTargetFolder','existing');await click('[data-organizer-member="c2"]');await click('[data-organizer-member="c3"]');await click('#organizerApprove');await wait(40);
  assert.equal(await evaluate('state.folders.conversations.length'),1);assert.deepEqual(await evaluate(`state.conversations.slice(0,3).map(chat=>chat.folderId||null)`),['existing',null,null]);
  await reset();await click('#organizerDismiss');await wait(40);assert.equal(await evaluate('state.conversationOrganization.dismissed.length'),1);assert.equal(await evaluate('JSON.stringify(state.conversations)===JSON.stringify(fixture.conversations)'),true);assert.equal(await evaluate('JSON.stringify(state.folders)===JSON.stringify(fixture.folders)'),true);
  assert.equal(await evaluate(`document.querySelectorAll('[data-recommendation-id]').length`),0);
 });
 await step('manual folder, keyboard move alternative, pin and summary opening call real commands',async()=>{
  await reset({tab:'all'});await click('#organizerCreateFolder');await fill('#organizerFolderName','手工归档');await click('#organizerSaveFolder');await wait(40);
  assert.equal(await evaluate(`state.folders.conversations.at(-1).name`),'手工归档');await click('[data-organizer-preview="c4"]');await wait(20);
  assert.equal(await evaluate(`document.querySelector('[data-organizer-nav="all"]').getAttribute('aria-current')`),'page');assert.match(await evaluate(`document.querySelector('.organizer-summary').textContent`),/作者栏/);
  await select('#organizerMoveTarget','folder-1');await evaluate(`document.querySelector('#organizerMove').focus()`);await key('Space');await wait(40);assert.equal(await evaluate(`state.conversations.find(chat=>chat.id==='c4').folderId`),'folder-1');
  await click('#organizerPin');await wait(40);assert.equal(await evaluate(`ConversationOrganization.isPinned(state.conversations.find(chat=>chat.id==='c4'))`),true);
  assert.equal(await evaluate(`document.querySelector('[data-organizer-conversation]').dataset.organizerConversation`),'c4');await click('#organizerPin');await wait(40);assert.equal(await evaluate(`ConversationOrganization.isPinned(state.conversations.find(chat=>chat.id==='c4'))`),false);
  await click('#organizerOpenConversation');await wait(20);assert.deepEqual(await evaluate('opened'),['c4']);assert.equal(await evaluate(`document.querySelector('.conversation-organizer-dialog')`),null);
 });
 await step('pending save disables actions and closing; rejection keeps draft and actionable error',async()=>{
  await reset();await fill('#organizerProposedName','等待保存');await evaluate(`mode='pending'`);await click('#organizerApprove');await wait(20);
  assert.equal(await evaluate(`document.querySelector('#organizerClose').disabled&&document.querySelector('#organizerApprove').disabled`),true);await key('Escape');assert.equal(await evaluate(`document.querySelector('.conversation-organizer-dialog').open`),true);assert.equal(await evaluate('commands.length'),1);
  assert.equal(await evaluate('JSON.stringify(state)===JSON.stringify(fixture)'),true);await evaluate(`rejectSave(Error('测试磁盘保存失败'));mode='resolve'`);await wait(40);
  assert.match(await evaluate(`document.querySelector('[role=alert]').textContent`),/测试磁盘保存失败/);assert.equal(await evaluate(`document.querySelector('#organizerApprove').disabled`),false);assert.equal(await evaluate(`document.querySelector('#organizerProposedName').value`),'等待保存');assert.equal(await evaluate('JSON.stringify(state)===JSON.stringify(fixture)'),true);
  await click('#organizerApprove');await wait(40);assert.equal(await evaluate(`state.folders.conversations.at(-1).name`),'等待保存');
 });
 await step('drag and drop plus sidebar enhancements use the same organization commands',async()=>{
  await reset({tab:'all'});await evaluate(`(()=>{const data=new DataTransfer();document.querySelector('[data-organizer-conversation="c4"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));document.querySelector('[data-organizer-drop="existing"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);await wait(40);assert.equal(await evaluate(`state.conversations.find(chat=>chat.id==='c4').folderId`),'existing');
  await evaluate(`ConversationOrganizer.close();ConversationOrganizer.enhanceSidebar();`);assert.equal(await evaluate(`document.querySelector('[data-conversation-id="c1"]').draggable`),true);
  await click('[data-organizer-pin="c1"]');await wait(40);assert.equal(await evaluate(`ConversationOrganization.isPinned(state.conversations[0])`),true);
  await click('[data-organizer-quick-preview="c1"]');await wait(30);assert.match(await evaluate(`document.querySelector('.organizer-summary').textContent`),/交互方案/);
 });
 await step('IME search retains its node and applies only completed Chinese input',async()=>{
  await reset({tab:'all'});await evaluate(`window.searchField=document.querySelector('[data-organizer-search]');searchField.focus();searchField.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(searchField,'会议');searchField.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',isComposing:true,data:'会议'}));`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-organizer-conversation]').length`),4);await evaluate(`searchField.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'会议'}))`);await wait(30);
  assert.equal(await evaluate(`document.querySelectorAll('[data-organizer-conversation]').length`),1);assert.equal(await evaluate(`document.querySelector('[data-organizer-search]')===searchField`),true);assert.equal(await evaluate('commands.length'),0);
  await evaluate(`searchField.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',isComposing:true,keyCode:229}))`);assert.equal(await evaluate(`document.querySelector('.conversation-organizer-dialog').open`),true);await evaluate(`document.querySelector('#organizerClose').focus()`);await key('Escape');assert.equal(await evaluate(`document.activeElement.id`),'opener');
 });
 await step('native and web themes, long content, narrow width, keyboard focus and reduced motion remain usable',async()=>{
  await reset({tab:'all',conversationId:'c1'});await evaluate(`state.conversations[0].title='非常长的对话标题需要在小窗口中正确换行'.repeat(10);document.body.classList.remove('light-mode');ConversationOrganizer.refresh()`);win.setSize(380,700);await wait(150);
  const geometry=await evaluate(`(()=>{const d=document.querySelector('.conversation-organizer-dialog'),r=d.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:d.scrollWidth>d.clientWidth,theme:d.querySelector('[data-halaska-root]').dataset.halaskaTheme}})()`);
  assert(geometry.left>=0&&geometry.right<=geometry.width&&geometry.top>=0&&geometry.bottom<=geometry.height);assert.equal(geometry.overflow,false);assert.equal(geometry.theme,'dark');await click('[data-organizer-preview="c2"]');await wait(40);assert.equal(await evaluate(`document.activeElement.classList.contains('organizer-summary')`),true);assert.equal(await evaluate(`document.querySelector('.organizer-summary').getBoundingClientRect().top<innerHeight`),true);await shot('dark-narrow-summary');await click('[data-organizer-preview="c1"]');await wait(30);
  await evaluate(`document.body.classList.add('native-desktop','reduce-motion');document.querySelector('#organizerClose').focus()`);await key('Tab',['shift']);assert.equal(await evaluate(`document.activeElement.closest('dialog')?.className`),'conversation-organizer-dialog');
  assert.equal(await evaluate(`document.querySelector('.conversation-organizer-dialog').getAnimations({subtree:true}).filter(a=>a.playState==='running').length`),0);
  win.setSize(1240,900);await evaluate(`document.body.classList.add('light-mode');document.body.classList.remove('native-desktop');document.documentElement.lang='en';document.dispatchEvent(new CustomEvent('workstation-language-change'))`);await wait(40);
  assert.equal(await evaluate(`document.querySelector('.organizer-heading h2').textContent`),'Organize conversations');assert.match(await evaluate(`document.querySelector('.organizer-summary').textContent`),/非常长的对话标题/);await shot('english-summary');
 });
 await step('closing removes the React root and no external requests or renderer errors occurred',async()=>{
  await evaluate(`ConversationOrganizer.close()`);await wait(40);assert.equal(await evaluate(`HalaskaUI.diagnostics().mounts`),0);assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
 });
 const report={passed:checks.length,checks,failures,errors,remote,fixture:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));clearTimeout(watchdog);win.destroy();server.close();app.exit(failures.length?1:0);
})().catch(error=>{console.error(error);clearTimeout(watchdog);win?.destroy();server?.close();app.exit(1)});
