/* Real sidebar renderer + real Kit; synthetic workspace, hidden isolated window. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'test-results/sidebar-disclosure-20260924'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-sidebar-disclosure-'));
fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
const source=fs.readFileSync(path.join(ROOT,'app/app.js'),'utf8');
const renderer=source.slice(source.indexOf('function sidebarProjectWorkspace('),source.indexOf('\nasync function commitConversationOrganization('));
const fixture={projects:[{id:'p1',name:'AI Bro',workspace:'科研',folderId:'f1'}],folders:{projects:[{id:'f1',name:'项目组'}],conversations:[{id:'f1',name:'工作台体验'},{id:'f2',name:'文件与资料'},{id:'f3',name:'一个需要在窄栏完整保留但不挤出操作按钮的超长文件夹标题'}]},conversations:[
{id:'c1',title:'本地部署 codex-router 路由项目',folderId:'f1',workspace:'科研',updatedAt:5,messages:[]},
{id:'c2',title:'类似 Codex 客户端的开源 Agent 盘点',folderId:'f2',workspace:'科研',updatedAt:4,messages:[]},
{id:'c3',title:'没有归属的独立对话',workspace:'日常',updatedAt:3,messages:[]},
{id:'old',title:'归档的工作台讨论',folderId:'f1',archived:true,updatedAt:2,messages:[]},
{id:'orphan',title:'旧文件夹已经不存在',folderId:'missing',workspace:'日常',updatedAt:1,messages:[]}
],tasks:[],currentConversationId:'c1',currentProjectId:'p1'};
let win,server;const checks=[],failures=[],errors=[],remote=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const watchdog=setTimeout(()=>{win?.destroy();server?.close();app.exit(1)},90000);
(async()=>{
 const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/liquid-glass.css"><link rel="stylesheet" href="/interaction-system.css"><style>body{display:flex!important;gap:24px;padding:24px;align-items:flex-start;min-height:100vh}main{width:320px;min-width:0}#conversationList{width:100%;max-height:760px}#projectList{width:240px}.sidebar-item-row{display:flex}button{cursor:pointer}</style></head><body class="liquid-glass light-mode" data-view="agent"><main><h3>对话文件夹 <span id="conversationCount"></span></h3><div id="conversationList"></div></main><aside><h3 id="projectListLabel"></h3><div id="projectList"></div></aside><script src="/halaska-ui.js"></script><script src="/conversation-organization.js"></script><script src="/conversation-organizer.js"></script></body></html>`;
 server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname;if(name==='/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(html)}const file=path.join(ROOT,'app',path.basename(name));if(!fs.existsSync(file)){res.writeHead(404);return res.end()}res.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'application/javascript'});res.end(fs.readFileSync(file))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));await app.whenReady();
 win=new BrowserWindow({show:false,width:900,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});const origin=`http://127.0.0.1:${server.address().port}`;
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{const external=!details.url.startsWith(origin+'/');if(external)remote.push(details.url);callback({cancel:external})});
 const evaluate=code=>win.webContents.executeJavaScript(code,true);
 const mount=async()=>{await win.loadURL(origin);await evaluate(`window.state=${JSON.stringify(fixture)};window.conversationQuery='';window.opened=[];window.managed=[];window.notices=[];window.commits=[];window.$=s=>document.querySelector(s);window.$$=s=>[...document.querySelectorAll(s)];window.normalize=v=>String(v??'').trim().toLowerCase().replace(/[\\s·_-]+/g,'');window.workspaceName=v=>v||'日常';window.formatRelative=()=> '刚刚';window.visibleTask=()=>true;window.esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window.uiIcon=n=>n==='more'?'⋯':'';window.openConversation=id=>opened.push(id);window.openProject=id=>opened.push(id);window.openManageDialog=(kind,id)=>managed.push([kind,id]);window.openFolderDialog=id=>managed.push(id);${renderer};window.group=(kind,folder,archive=false)=>[...document.querySelectorAll('[data-folder-toggle]')].find(b=>b.dataset.folderToggle===JSON.stringify([kind,archive?'archive':'active',folder]));ConversationOrganizer.init({getState:()=>state,commit:async command=>{commits.push(command);state=ConversationOrganization.apply(state,command,{now:1000,makeId:()=> 'generated'});renderSidebar();return state},openConversation,toast:v=>notices.push(v)});renderSidebar();void 0;`)};
 const shot=async name=>{await win.webContents.capturePage();await wait(160);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 async function step(name,fn){try{await fn();checks.push(name);console.log('PASS',name)}catch(e){failures.push({name,error:e.stack});console.error('FAIL',name,e.message)}}
 await mount();
 await step('real Kit headers own their nested children, count only matching members and retain orphan chats',async()=>{
  assert.equal(await evaluate(`group('conversations','f1').closest('[data-halaska-root]').dataset.halaskaRoot`),'Button');
  assert.equal(await evaluate(`document.getElementById(group('conversations','f1').getAttribute('aria-controls')).querySelectorAll('[data-conversation-id]').length`),1);
  assert.equal(await evaluate(`document.getElementById(group('conversations',null).getAttribute('aria-controls')).querySelectorAll('[data-conversation-id]').length`),2);
  assert.match(await evaluate(`group('conversations','f3').textContent`),/0$/);
  assert.equal(await evaluate(`new Set([...document.querySelectorAll('[aria-controls]')].map(b=>b.getAttribute('aria-controls'))).size === document.querySelectorAll('[data-folder-toggle]').length`),true);
  await shot('light-expanded');
 });
 await step('collapse keeps selected chat and focus, preserves unrelated preferences and never saves workspace',async()=>{
  await evaluate(`localStorage.setItem('workstation-ui',JSON.stringify({unrelated:'keep'}));window.originalState=JSON.stringify(state);window.header=group('conversations','f1');header.focus();header.click()`);
  assert.equal(await evaluate(`header.getAttribute('aria-expanded')`),'false');assert.equal(await evaluate(`document.getElementById(header.getAttribute('aria-controls')).hidden`),true);
  assert.equal(await evaluate(`document.activeElement===header&&header===group('conversations','f1')`),true);
  assert.equal(await evaluate(`JSON.stringify(state)===originalState`),true);assert.equal(await evaluate(`commits.length`),0);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('workstation-ui')).unrelated`),'keep');
  assert.equal(await evaluate(`group('conversations','f1',true).getAttribute('aria-expanded')`),'true');assert.equal(await evaluate(`group('projects','f1').getAttribute('aria-expanded')`),'true');
 });
 await step('menu is independent of disclosure and a real reload restores the collapsed preference',async()=>{
  await evaluate(`group('conversations','f1').closest('.sidebar-folder').querySelector('[data-folder-menu]').click()`);
  assert.deepEqual(await evaluate('managed'),['conversations:f1']);assert.equal(await evaluate(`group('conversations','f1').getAttribute('aria-expanded')`),'false');
  await mount();assert.equal(await evaluate(`group('conversations','f1').getAttribute('aria-expanded')`),'false');assert.equal(await evaluate(`state.currentConversationId`),'c1');
 });
 await step('search reveals matching descendants temporarily and clearing search restores the saved collapse',async()=>{
  await evaluate(`window.beforeSearch=localStorage.getItem('workstation-ui');conversationQuery='本地部署';renderSidebar()`);
  assert.equal(await evaluate(`group('conversations','f1').getAttribute('aria-expanded')`),'true');assert.equal(await evaluate(`document.querySelectorAll('#conversationList [data-conversation-id]').length`),1);
  await evaluate(`group('conversations','f1').click();renderSidebar()`);assert.equal(await evaluate(`group('conversations','f1').getAttribute('aria-expanded')`),'false');
  assert.equal(await evaluate(`localStorage.getItem('workstation-ui')===beforeSearch`),true);
  await evaluate(`conversationQuery='';renderSidebar()`);assert.equal(await evaluate(`group('conversations','f1').getAttribute('aria-expanded')`),'false');
 });
 await step('left/right keyboard disclosure preserves focus and does not route the selected conversation',async()=>{
  await evaluate(`window.keyHeader=group('conversations','f1');keyHeader.focus();keyHeader.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`keyHeader.getAttribute('aria-expanded')`),'true');
  await evaluate(`keyHeader.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`keyHeader.getAttribute('aria-expanded')`),'false');assert.equal(await evaluate('document.activeElement===keyHeader'),true);assert.deepEqual(await evaluate('opened'),[]);
 });
 await step('a collapsed folder remains a real organizer drop target and moving changes membership only',async()=>{
  await evaluate(`(()=>{const data=new DataTransfer();data.setData('application/x-aibro-conversation','c2');const header=group('conversations','f1').closest('.sidebar-folder');header.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}))})()`);await wait(50);
  assert.equal(await evaluate(`state.conversations.find(c=>c.id==='c2').folderId`),'f1');assert.equal(await evaluate('commits.length'),1);assert.equal(await evaluate(`group('conversations','f1').getAttribute('aria-expanded')`),'false');
  assert.match(await evaluate(`group('conversations','f1').textContent`),/2$/);assert.equal(await evaluate(`state.currentConversationId`),'c1');assert.deepEqual(await evaluate('opened'),[]);
 });
 await step('narrow dark layout keeps long titles and menus within the column, reduced motion and English unfiled heading work',async()=>{
  win.setSize(480,800);await evaluate(`document.body.classList.remove('light-mode');document.body.classList.add('reduce-motion');document.documentElement.lang='en';document.querySelector('main').style.width='280px';document.querySelector('aside').style.display='none';renderSidebar()`);await wait(30);
  const layout=await evaluate(`(()=>{const h=group('conversations','f3').closest('.sidebar-folder'),m=h.querySelector('.folder-menu'),b=group('conversations','f3');return {overflow:h.scrollWidth>h.clientWidth,menuInside:m.getBoundingClientRect().right<=h.getBoundingClientRect().right,theme:b.closest('[data-halaska-root]').dataset.halaskaTheme,motion:getComputedStyle(b,'::before').transitionDuration,bodyOverflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert.equal(layout.overflow,false);assert.equal(layout.menuInside,true);assert.equal(layout.theme,'dark');assert.equal(layout.motion,'0s');assert.equal(layout.bodyOverflow,false);assert.match(await evaluate(`group('conversations',null).textContent`),/^Unfiled chats/);await shot('dark-narrow');
 });
 await step('repeated snapshot renders clean up owned Kit roots and make no remote calls or renderer errors',async()=>{
  const before=await evaluate('HalaskaUI.diagnostics().mounts');await evaluate('for(let i=0;i<8;i++)renderSidebar()');assert.equal(await evaluate('HalaskaUI.diagnostics().mounts'),before);assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
 });
 const report={passed:checks.length,checks,failures,errors,remote,fixture:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));clearTimeout(watchdog);win.destroy();server.close();app.exit(failures.length?1:0);
})().catch(e=>{console.error(e);clearTimeout(watchdog);win?.destroy();server?.close();app.exit(1)});
