/* Real cross-panel navigation: tree, editable document, context and conversation. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18949,ORIGIN=`http://127.0.0.1:${PORT}`,TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-workspace-')),STORE=path.join(TEMP,'store'),OUT=path.join(ROOT,'test-results/interaction-system-20260924');
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
 // Notes use the Kit DocumentToolbar: segmented 阅读/编辑/源码, where 编辑 is the Crepe/ProseMirror canvas.
 const modeButton=label=>`[...document.querySelectorAll('#previewDialog .document-toolbar-kit [role=radio]')].find(n=>n.textContent.trim()===${JSON.stringify(label)})`;
 const mode=async label=>{await until(()=>evaluate(`!!${modeButton(label)}&&!${modeButton(label)}.disabled`),'mode '+label);await evaluate(`${modeButton(label)}.click()`);if(label==='编辑')await until(()=>evaluate(`!!document.querySelector('.document-visual-canvas .ProseMirror[contenteditable=true]')`),'visual editor');};
 // The Kit segmented control draws its own sliding pill: the absolutely positioned sibling of its options.
 const pill=`(()=>{const g=document.querySelector('#previewDialog .document-toolbar-kit [role=radiogroup]'),p=[...g.querySelectorAll('div')].find(d=>getComputedStyle(d).position==='absolute'),s=g.querySelector('[aria-checked=true]'),a=p.getBoundingClientRect(),b=s.getBoundingClientRect();return{selected:s.textContent.trim(),left:a.left,covers:Math.abs(a.left-b.left)<1.5&&Math.abs(a.width-b.width)<1.5&&b.width>0}})()`;
 // .message-list scrolls smoothly and ConversationReading only treats real input as reading intent, so read history with a real wheel and wait for it to settle.
 const wheelUp=async()=>{const p=await evaluate(`(()=>{const r=document.querySelector('#messageList').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);for(let n=0;n<3;n++){win.webContents.sendInputEvent({type:'mouseWheel',...p,deltaX:0,deltaY:400,canScroll:true});await wait(40);}let last=-1;await until(async()=>{const top=await evaluate(`document.querySelector('#messageList').scrollTop`);const settled=top===last;last=top;await wait(80);return settled;},'wheel settled');};
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 await evaluate(`(()=>{const p={id:'workspace-project',name:'工作台设计',workspace:'日常'};state.projects=[p];state.notes.forEach(n=>n.projectId=p.id);currentConversation().projectId=p.id;const r=state.agentRuns[0];r.contextMetrics={estimatedTokens:2400,characters:5600,loadedCapabilities:['knowledge','files'],history:{includedMessages:4,totalMessages:18,omittedMessages:14}};r.knowledgeReads=[{type:'read',title:'设计原则',id:'ui-notes',offset:0}];r.toolCalls=[];state.ui.inspectorOpen=false;save();renderAll();showView('agent');})()`);
 // The local draft store only accepts notes already on disk; otherwise the editor shows a "草稿仅保留在当前窗口" notice above the text (native/Resources/qa-harness-ux.js §17).
 assert.equal(await evaluate(`saveDocumentDurably()`),true,'fixture notes are saved before the first open');

 await step('composer keeps send at the trailing edge across narrow, split, and wide widths',async()=>{
  for(const width of [1500,1100,840,620,440]){
   win.setSize(width,900);await wait(140);await evaluate('WorkspaceLayout.refresh()');
   const result=await evaluate(`(()=>{const f=document.querySelector('.composer-primary-row').getBoundingClientRect(),s=document.querySelector('#agentSend').getBoundingClientRect(),c=document.querySelector('#composer').getBoundingClientRect();return {gap:f.right-s.right,inside:s.left>=c.left&&s.bottom<=c.bottom,overflow:document.documentElement.scrollWidth>innerWidth,hidden:getComputedStyle(document.querySelector('#composerPermission')).display};})()`);
   assert.ok(result.inside&&result.gap<3,JSON.stringify({width,...result}));assert.equal(result.overflow,false);
   await shot('composer-'+width);
  }
 });
 await step('secondary tools remain reachable with outside click and Escape dismissal',async()=>{
  // #composerPermission now sits in the primary row (app/interaction-system.js move(['composerPermission'],primary)), so the menu's first tool is the Kit 上下文 entry.
  win.setSize(1100,900);assert.equal(await evaluate(`!!document.querySelector('.composer-primary-row #composerPermission')&&!document.querySelector('#composerExtraTools #composerPermission')`),true);
  await click('#composerMore');assert.equal(await evaluate(`document.querySelector('#composerExtraTools').hidden`),false);
  assert.deepEqual(await evaluate(`({first:document.querySelector('#composerExtraTools button')===document.activeElement,owner:document.activeElement.closest('#composerExtraTools>[id]')?.id,label:document.activeElement.textContent.trim()})`),{first:true,owner:'composerContextWorkbench',label:'上下文'});
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#composerExtraTools').hidden`),true);assert.equal(await evaluate(`document.activeElement.id`),'composerMore');
  // A real press outside the menu closes it.
  await click('#composerMore');assert.equal(await evaluate(`document.querySelector('#composerExtraTools').hidden`),false);
  const outside=await evaluate(`(()=>{const r=document.querySelector('#messageList').getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+12)}})()`);
  win.webContents.sendInputEvent({type:'mouseDown',...outside,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...outside,button:'left',clickCount:1});
  await until(()=>evaluate(`document.querySelector('#composerExtraTools').hidden&&document.querySelector('#composerMore').getAttribute('aria-expanded')==='false'`),'outside press closes the menu');
  // Choosing a tool closes the menu and opens that tool.
  await click('#composerMore');await evaluate(`document.querySelector('#composerContextWorkbench button').click()`);
  assert.equal(await evaluate(`document.querySelector('#composerExtraTools').hidden`),true);await until(()=>evaluate(`state.ui.inspectorOpen&&state.ui.inspector==='context'`),'context tool opens');
  await evaluate(`state.ui.inspectorOpen=false;applyUiPreferences();document.querySelectorAll('dialog[open]').forEach(d=>d.close())`);
 });
 await step('jump to latest follows the actual scroller and leaves a reader of history in place',async()=>{
  await evaluate(`(()=>{const c=currentConversation();c.messages=Array.from({length:18},(_,i)=>({id:'scroll-'+i,role:i%2?'assistant':'user',text:'第 '+i+' 条消息。'+('这是保留在历史中的段落。'.repeat(35)),createdAt:Date.now()}));renderConversation();ConversationReading.follow(document.querySelector('#messageList'),{behavior:'instant'});})()`);
  await until(()=>evaluate(`InteractionSystem.distanceFromEnd(document.querySelector('#messageList'))<10`),'conversation starts at the end');
  // Setting scrollTop without input is layout and the view keeps following (app/conversation-reading.js); a reader scrolls with a real wheel.
  await wheelUp();assert.ok(await evaluate(`InteractionSystem.distanceFromEnd(document.querySelector('#messageList'))>200`),'the reader scrolled into history');
  await until(()=>evaluate(`!document.querySelector('#conversationLatest').hidden`),'jump to latest appears');
  const pos=await evaluate(`document.querySelector('#messageList').scrollTop`);
  await evaluate(`currentConversation().messages.push({id:'new-tail',role:'assistant',text:'最新回复'});renderConversation()`);await wait(250);
  assert.ok(Math.abs(await evaluate(`document.querySelector('#messageList').scrollTop`)-pos)<=1,'a new reply leaves the history reader in place');
  assert.equal(await evaluate(`document.querySelector('#conversationLatest').hidden`),false);
  await click('#conversationLatest');await until(()=>evaluate(`InteractionSystem.distanceFromEnd(document.querySelector('#messageList'))<10`),'latest');
  assert.equal(await evaluate(`document.querySelector('#conversationLatest').hidden`),true);await shot('latest-reached');
 });

 await step('source previews show a real saved source and Escape closes without reopening on focus return',async()=>{
  // The composer More menu also listens for Escape on document; start from a closed menu so this check owns Escape.
  win.webContents.focus();await evaluate(`document.querySelector('#composerExtraTools').hidden||document.querySelector('#composerMore').click()`);
  await evaluate(`(()=>{const b=document.createElement('button');b.dataset.openNote='ui-plan';b.id='qa-source-chip';b.textContent='交互改造计划';document.querySelector('#messageList').append(b);b.focus()})()`);
  assert.equal(await evaluate(`document.querySelector('#sourcePeek').hidden`),false);
  assert.match(await evaluate(`document.querySelector('#sourcePeek').textContent`),/交互改造计划/);
  await evaluate(`document.querySelector('#sourcePeek button').focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#sourcePeek').hidden`),true);assert.equal(await evaluate(`document.activeElement.id`),'qa-source-chip');
  await evaluate(`document.querySelector('#qa-source-chip').remove()`);
 });
 await step('one Escape closes one layer: the source preview above the More menu first, then the menu',async()=>{
  const key=keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});};
  const layers=`({menu:!document.querySelector('#composerExtraTools').hidden,peek:!document.querySelector('#sourcePeek').hidden,focus:document.activeElement.closest('[id]')?.id})`;
  win.webContents.focus();await evaluate(`document.querySelector('#composerExtraTools').hidden||document.querySelector('#composerMore').click()`);
  await evaluate(`(()=>{const b=document.createElement('button');b.dataset.openNote='ui-plan';b.id='qa-layer-chip';b.textContent='交互改造计划';document.querySelector('#messageList').append(b)})()`);
  // A pointer preview opens over the menu while keyboard focus stays in the menu.
  await click('#composerMore');await evaluate(`SourcePeek.show(document.querySelector('#qa-layer-chip'))`);
  assert.deepEqual(await evaluate(layers),{menu:true,peek:true,focus:'composerContextWorkbench'});
  key('Escape');await until(()=>evaluate(`document.querySelector('#sourcePeek').hidden`),'first Escape closes the preview');
  assert.deepEqual(await evaluate(layers),{menu:true,peek:false,focus:'composerContextWorkbench'},'the menu stays open and keeps focus');
  key('Escape');await until(()=>evaluate(`document.querySelector('#composerExtraTools').hidden`),'second Escape closes the menu');
  assert.equal(await evaluate(`document.activeElement.id`),'composerMore');
  // Keyboard focus leaving the menu for a source closes the menu; Escape then closes only the preview and keeps focus on the source.
  await click('#composerMore');await evaluate(`document.querySelector('#qa-layer-chip').focus()`);
  await until(()=>evaluate(`document.querySelector('#composerExtraTools').hidden&&!document.querySelector('#sourcePeek').hidden`),'focus leaving the menu closes it and opens the preview');
  key('Escape');await until(()=>evaluate(`document.querySelector('#sourcePeek').hidden`),'Escape closes the preview');
  assert.equal(await evaluate(`document.activeElement.id`),'qa-layer-chip');
  await evaluate(`document.querySelector('#qa-layer-chip').remove()`);
 });
 await step('shared mode indicator tracks selection and accordion can reverse without getting stuck',async()=>{
  // The Kit DocumentToolbar's segmented control owns its sliding pill. The shared .motion-selection indicator covers only legacy groups whose buttons are direct children (InteractionSystem indicators()), so it must not draw a second pill here.
  await evaluate(`openPreview('note','ui-plan')`);await mode('编辑');
  await until(()=>evaluate(`(${pill}).selected==='编辑'&&(${pill}).covers`),'pill reaches 编辑');const x=(await evaluate(pill)).left;
  await mode('阅读');await until(()=>evaluate(`(${pill}).selected==='阅读'&&(${pill}).covers`),'pill follows to 阅读');
  assert.notEqual((await evaluate(pill)).left,x);assert.equal(await evaluate(`document.querySelector('#previewDialog .note-document-toolbar').classList.contains('motion-selection')`),false);
  // The reader's metadata disclosure is the visible accordion; reversing it mid-animation settles back to closed.
  const closed=await evaluate(`document.querySelector('.reader-document-details').open`);assert.equal(closed,false);
  await evaluate(`(()=>{const s=document.querySelector('.reader-document-details>summary');s.click();s.click();})()`);await wait(400);
  assert.deepEqual(await evaluate(`(()=>{const d=document.querySelector('.reader-document-details');return{open:d.open,overflow:d.style.overflow,height:d.style.height}})()`),{open:false,overflow:'',height:''});
 });
 await step('native actual-width fitting switches to focus mode before columns become unusable',async()=>{
  const css=fs.readFileSync(path.join(ROOT,'native/Resources/workspace.css'),'utf8');await evaluate(`(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);document.body.classList.add('aibro-native');})()`);
  for(const width of [1440,1024,840,800,620]){
   win.setSize(width,900);await wait(150);await evaluate(`WorkspaceLayout.refresh();state.ui.inspectorOpen=false;applyUiPreferences()`);
   const value=await evaluate(`(()=>{const d=document.querySelector('#previewDialog').getBoundingClientRect(),m=document.querySelector('.main').getBoundingClientRect(),r=document.querySelector('#readingPane').getBoundingClientRect();return{focus:document.body.classList.contains('workspace-reader-focus'),doc:d.width,main:m.width,reader:r.width,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
   assert.equal(value.overflow,false,JSON.stringify({width,...value}));assert.ok(value.doc>=390,JSON.stringify({width,...value}));if(width<840){assert.ok(value.focus);assert.equal(value.main,0);}else assert.ok(value.main>=400);
   await shot('native-'+width);
  }
 });
 await step('reader keeps editable content above the fold while metadata and rename stay available',async()=>{
  // The editable body is the Crepe/ProseMirror canvas; its formatting top bar sits above it, as the legacy .markdown-editor-toolbar sat above .markdown-editor-body.
  win.setSize(620,740);await evaluate(`state.ui.theme='light';applyUiPreferences();openPreview('note','ui-plan')`);await mode('编辑');await wait(350);
  const result=await evaluate(`(()=>{const body=document.querySelector('.document-visual-canvas .ProseMirror'),toolbar=document.querySelector('.note-document-toolbar');return{top:body.getBoundingClientRect().top,height:innerHeight,infoOpen:document.querySelector('.reader-document-details').open,toolbarTop:toolbar.getBoundingClientRect().top,toolbarHeight:toolbar.getBoundingClientRect().height,heading:body.querySelector('h1')?.getBoundingClientRect().top}})()`);
  assert.ok(result.top<270&&result.top<result.height*.4,JSON.stringify(result));assert.equal(result.infoOpen,false);
  await click('.reader-document-details>summary');await wait(320);assert.ok(await evaluate(`document.querySelector('#previewTitle').getBoundingClientRect().height>0`));await click('.reader-document-details>summary');await wait(250);
  await click('.note-document-properties>summary');assert.equal(await evaluate(`document.querySelector('.note-document-properties').open`),true);
  await evaluate(`document.querySelector('.note-document-title-field input').focus();document.querySelector('.note-document-title-field input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('.note-document-properties').open`),false);assert.equal(await evaluate(`document.querySelector('.note-document').dataset.mode`),'rich');
  const readerMetrics=await evaluate(`['.reader-document-details','.note-document-toolbar','.document-toolbar-kit','.note-document-count','.note-document-recovery','.milkdown-top-bar','.document-visual-canvas .ProseMirror','.document-visual-canvas .ProseMirror h1'].map(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect(),c=e&&getComputedStyle(e);return{selector:s,top:r?.top,height:r?.height,margin:c?.margin,padding:c?.padding}})`);fs.writeFileSync(path.join(OUT,'reader-metrics.json'),JSON.stringify(readerMetrics,null,2));
  await shot('reader-compact-620');
 });
 await step('idle interaction observers settle, dark colors and reduced motion remain inherited',async()=>{
  await evaluate(`state.ui.theme='dark';state.settings.reduceMotion=true;applyUiPreferences()`);await wait(150);
  const mutations=await evaluate(`new Promise(resolve=>{let n=0;const o=new MutationObserver(a=>n+=a.length);o.observe(document.body,{attributes:true,subtree:true,attributeFilter:['class','hidden']});setTimeout(()=>{o.disconnect();resolve(n)},300)})`);
  assert.ok(mutations<10,'idle mutation loop: '+mutations);await shot('native-dark-reduced');
 });
 const report={checks,passed:checks.length,failures,modelCalls:0,workspace:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));return failures.length?1:0;
}
run().then(code=>{clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(code)}).catch(e=>{console.error(e);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1)});
