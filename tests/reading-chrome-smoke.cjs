/* Real production renderer + synthetic PDF/state only. Native CSS is emulated
 * in Electron, not native WKWebView acceptance. Baseline mode records untouched
 * source geometry; no DOM reconstruction or fabricated before measurements. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict'), { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-reading-chrome-')), STORE = path.join(TEMP, 'store'), OUT = path.resolve(process.env.READING_CHROME_OUT || path.join(ROOT, 'test-results/reading-chrome-20260929'));
fs.mkdirSync(path.join(STORE, 'files'), { recursive: true }); fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const made = spawnSync(process.env.PYTHON || 'python3', ['-B', '-c', `import fitz,json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=fitz.open()
for index,size in enumerate([(595,842),(842,595)]):
 page=d.new_page(width=size[0],height=size[1]); page.insert_text((44,60),'PDF READING / PAGE '+str(index+1),fontsize=23)
 for row in range(24): page.insert_text((44,110+row*17),'Readable document text: context, references, interaction and review.',fontsize=11)
 page.draw_rect(fitz.Rect(38,78,size[0]-38,88),color=(0.12,0.48,0.43),fill=(0.12,0.48,0.43))
(p/'layout-pdf').write_bytes(d.tobytes()); (p/'layout-pdf.meta.json').write_text(json.dumps({'name':'Reading-layout.pdf','mimeType':'application/pdf'}))`, path.join(STORE, 'files')]);
assert.equal(made.status, 0, made.stderr.toString());
const original = fs.readFileSync(path.join(STORE, 'files', 'layout-pdf')), checks = [], skipped = [], failures = [], rendererErrors = [], externalRequests = [], measurements = [];
let win, server; const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 250; n++) { if (await fn()) return; await delay(40); } throw Error('Timeout: ' + label); }
const watchdog = setTimeout(() => { win?.destroy(); server?.kill(); app.exit(1); }, 120000);
(async () => {
 const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); }); const origin = `http://127.0.0.1:${port}`;
 const log = fs.openSync(path.join(TEMP, 'server.log'), 'a'); server = spawn(process.env.PYTHON || 'python3', ['-B', path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE }, stdio: ['ignore', log, log] });
 await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'fixture server'); await app.whenReady();
 win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
 win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => { const external = !request.url.startsWith(origin + '/'); if (external) externalRequests.push(request.url); done({ cancel: external }); });
 const evaluate = code => win.webContents.executeJavaScript(code, true), click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const ready = page => until(() => evaluate(`document.querySelector('.pdf-sheet img')?.complete&&document.querySelector('.pdf-sheet img').naturalWidth>0&&Number(document.querySelector('[data-pdf-page]')?.value)===${page}`), 'PDF page ' + page);
 const screenshot = async name => { await delay(100); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
 async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await screenshot('failure-'+name.replace(/[^a-z0-9]+/gi,'-').slice(0,80)); } }
 // This suite emulates native CSS below. Install only the native-shell identity
 // before controller creation so it also exercises the actual native DOM order.
 // This is still Chromium layout coverage, not a WKWebView accessibility check.
 await win.loadURL('about:blank');
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Page.enable');
 await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {source:'window.webkit={messageHandlers:{workspace:{postMessage(){}}}};'});
 await win.loadURL(origin); await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`), 'hydrate');
 assert.equal(await evaluate(`!!(document.getElementById('readingPane').compareDocumentPosition(document.querySelector('.main')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true);
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};` + fs.readFileSync(path.join(ROOT, 'tests/fixtures/agent-workbench.js'), 'utf8'));
 await evaluate(`(()=>{state.projects=[{id:'pdf-project',name:'PDF 阅读验收',workspace:'课程'}];currentConversation().projectId='pdf-project';state.notes.forEach(note=>note.projectId='pdf-project');state.imports=[{id:'layout-pdf',name:'Reading-layout.pdf',mimeType:'application/pdf',content:'Indexed text from a real PDF.',pages:[{page:1,text:'Readable document text on the first original page.'},{page:2,text:'Landscape source page and preserved indexing.'}],workspace:'课程',projectId:'pdf-project'}];state.ui.inspectorOpen=false;state.ui.panelWidths={reader:420};state.settings.reduceMotion=true;applyUiPreferences();renderAll();openImport('layout-pdf',1);})()`); await ready(1);

 const chromeMeasure = label => evaluate(`(()=>{const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect(),style=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom,right:r.right,scroll:e.scrollWidth,client:e.clientWidth,display:style.display,hidden:e.hidden}};return {label:${JSON.stringify(label)},window:{width:innerWidth,height:innerHeight},header:rect('.reading-toolbar'),tabs:rect('#readingTabs'),details:rect('.reader-document-details'),summary:rect('.reader-document-details>summary'),pdfToolbar:rect('.pdf-reader-toolbar'),viewport:rect('.pdf-viewport'),frame:rect('.reader-document-frame'),reader:rect('#readingPane'),tabParent:document.querySelector('#readingTabs')?.parentElement.className,bodyClasses:document.body.className,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
 const phase=process.env.READING_CHROME_BASELINE==='1'?'before':'after';
 await evaluate(`(()=>{const style=document.createElement('style');style.id='native-layout-fixture';style.textContent=${JSON.stringify(fs.readFileSync(path.join(ROOT,'native/Resources/workspace.css'),'utf8'))};document.head.append(style);document.body.classList.add('aibro-native');WorkspaceLayout.refresh();})()`);
 for(const [width,height] of [[1280,800],[1024,720],[440,720],[360,720]]) {win.setContentSize(width,height);await evaluate('WorkspaceLayout.refresh()');await delay(200);measurements.push(await chromeMeasure('native-css-'+width));await screenshot(phase+'-'+width);}
 const hashes=Object.fromEntries(['app/reading-pane.js','app/reading-pane.css','app/agent-workspace.js','native/Resources/workspace.css'].map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex')]));
 fs.writeFileSync(path.join(OUT,phase+'.json'),JSON.stringify({phase,measuredAt:new Date().toISOString(),scope:'Real unmodified app renderer; synthetic state; native CSS emulation only.',hashes,measurements,rendererErrors,externalRequests},null,2));

 if(phase==='before'){console.log(JSON.stringify({phase,OUT,measurements},null,2));clearTimeout(watchdog);win.destroy();server.kill();app.exit(0);return;}
 const key=async value=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:value});win.webContents.sendInputEvent({type:'keyUp',keyCode:value});await delay(80);};
 const selected=()=>evaluate(`ReadingPane.snapshot().activeKey`);
 const tabState=()=>evaluate(`(()=>{const tabs=[...document.querySelectorAll('#readingTabs [role=tab]')];return{active:ReadingPane.snapshot().activeKey,focused:document.activeElement.dataset.readingKey||null,tabStops:tabs.filter(t=>t.tabIndex===0).map(t=>t.dataset.readingKey),selected:tabs.filter(t=>t.getAttribute('aria-selected')==='true').map(t=>t.dataset.readingKey)}})()`);
 const selectImport=async()=>{await evaluate(`openImport('layout-pdf',1)`);await ready(1);};
 const resetWidth=async()=>{win.setContentSize(1280,800);await evaluate('WorkspaceLayout.refresh()');await delay(120);};
 await resetWidth();
 await evaluate(`window.__chromeTabs=document.getElementById('readingTabs');window.__chromeToolbar=document.querySelector('.reading-toolbar');window.__chromeSurface=document.getElementById('previewDialog');window.__chromePdf=document.querySelector('.pdf-sheet');`);
 await check('PDF uses one 44px header and a compact details summary at all target widths',async()=>{
  for(const value of measurements){assert.equal(value.tabParent,'reading-toolbar',JSON.stringify(value));assert.ok(Math.abs(value.header.height-44)<=1,JSON.stringify(value));assert.ok(value.tabs.top>=value.header.top&&value.tabs.bottom<=value.header.bottom+1,JSON.stringify(value));assert.ok(value.summary.height<=24.5,JSON.stringify(value));assert.equal(value.overflow,false);}
  const value=await evaluate(`({heading:getComputedStyle(document.querySelector('.reading-heading')).display,caption:getComputedStyle(document.querySelector('.reading-caption')).display,expand:getComputedStyle(document.getElementById('readingExpand')).display})`);
  assert.deepEqual(value,{heading:'none',caption:'none',expand:'none'});
 });
 if(fs.existsSync(path.join(OUT,'before.json'))) await check('actual saved before measurements show increased PDF viewport height without moving the bottom',async()=>{
  const file=path.join(OUT,'before.json');
  const before=JSON.parse(fs.readFileSync(file));assert.equal(before.phase,'before');assert.equal(before.scope,'Real unmodified app renderer; synthetic state; native CSS emulation only.');
  for(const value of measurements){const previous=before.measurements.find(entry=>entry.label===value.label);assert.ok(previous);assert.equal(previous.window.height,value.window.height);assert.ok(previous.header.height+previous.tabs.height-value.header.height>=40);assert.ok(value.viewport.height-previous.viewport.height>=40,JSON.stringify({before:previous,after:value}));assert.ok(Math.abs(previous.viewport.bottom-value.viewport.bottom)<=1);}
 });else skipped.push('No genuine saved before baseline supplied; after geometry is recorded without a fabricated comparison.');
 await check('tablist and reader surface keep their identity through note/PDF switching, collapse and reopening',async()=>{
  await evaluate(`openNote('ui-notes')`);await until(()=>evaluate(`NoteEditor.inlineActive('ui-notes')`),'note surface');
  assert.equal(await evaluate(`document.getElementById('readingTabs')===__chromeTabs&&__chromeTabs.parentElement===document.getElementById('readingPane')&&__chromeTabs.nextElementSibling===__chromeSurface`),true);
  assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('readingExpand')).display`),'none');
  await selectImport();assert.equal(await evaluate(`document.getElementById('readingTabs')===__chromeTabs&&__chromeTabs.parentElement===__chromeToolbar`),true);
  await click('#readingCollapse');assert.equal(await evaluate(`document.getElementById('readingPane').hidden&&document.getElementById('readingTabs')===__chromeTabs`),true);
  await click('#readingToggle');await ready(1);assert.equal(await evaluate(`document.getElementById('readingTabs')===__chromeTabs&&__chromeTabs.parentElement===__chromeToolbar&&document.getElementById('previewDialog')===__chromeSurface`),true);
 });
 await check('trusted renderer keyboard Tab, Home, End and arrows activate and focus the intended reader tab',async()=>{
  await evaluate(`openNote('ui-plan')`);await until(()=>evaluate(`NoteEditor.inlineActive('ui-plan')`),'third tab');
  await evaluate(`document.querySelector('#readingTabs [aria-selected=true]').focus()`);await key('Home');await ready(1);let value=await tabState();assert.equal(value.active,JSON.stringify(['import','layout-pdf']));assert.equal(value.focused,value.active,JSON.stringify(value));assert.deepEqual(value.tabStops,[value.active]);assert.deepEqual(value.selected,[value.active]);
  await key('Tab');assert.equal(await evaluate(`document.activeElement.dataset.readingCloseKey`),value.active,'Tab reaches the active tab close button');
  await evaluate(`document.querySelector('#readingTabs [aria-selected=true]').focus()`);await key('End');await until(()=>evaluate(`NoteEditor.inlineActive('ui-plan')`),'End selects last');value=await tabState();assert.equal(value.focused,value.active,JSON.stringify(value));assert.equal(value.active,JSON.stringify(['note','ui-plan']));
  await key('Left');await until(()=>evaluate(`NoteEditor.inlineActive('ui-notes')`),'ArrowLeft selects previous');value=await tabState();assert.equal(value.focused,value.active,JSON.stringify(value));assert.equal(value.active,JSON.stringify(['note','ui-notes']));
  await key('Right');await until(()=>evaluate(`NoteEditor.inlineActive('ui-plan')`),'ArrowRight selects next');value=await tabState();assert.equal(value.focused,value.active,JSON.stringify(value));
 });
 await check('Delete closes the selected tab and focuses its surviving neighbor without deleting the document',async()=>{
  await evaluate(`document.querySelector('#readingTabs [aria-selected=true]').focus()`);const prior=await selected();await key('Delete');await until(()=>evaluate(`!ReadingPane.snapshot().tabs.some(tab=>tab.key===${JSON.stringify(prior)})`),'Delete closes tab');
  const value=await tabState();assert.equal(value.focused,value.active,JSON.stringify(value));assert.deepEqual(value.tabStops,[value.active]);assert.equal(await evaluate(`!!state.notes.find(note=>note.id==='ui-plan')`),true);
 });
 await check('many long tabs keep the selected close control reachable at 1280, 1024, 440 and 360px',async()=>{
  await evaluate(`state.notes.push(...Array.from({length:6},(_,i)=>({id:'chrome-long-'+i,title:'Long document title '+i+' — continued reading and references',content:'# Synthetic note '+i,workspace:'课程',projectId:'pdf-project'})))`);
  for(let i=0;i<6;i++)await evaluate(`openNote('chrome-long-${i}')`);await evaluate(`state.imports.find(item=>item.id==='layout-pdf').name='Long selected PDF filename — document context and references.pdf'`);await selectImport();
  for(const width of [1280,1024,440,360]){win.setContentSize(width,720);await evaluate('WorkspaceLayout.refresh()');await delay(160);
   const value=await evaluate(`(()=>{const h=document.querySelector('.reading-toolbar'),s=document.getElementById('readingTabs'),a=s.querySelector('.reading-tab.active'),c=a.querySelector('.reading-tab-close'),r=c.getBoundingClientRect(),hr=h.getBoundingClientRect(),sr=s.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,headerOverflow:h.scrollWidth>h.clientWidth+1,headerHeight:hr.height,close:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width},strip:{left:sr.left,right:sr.right},hit:hit===c||c.contains(hit)}})()`);
   assert.equal(value.overflow,false,JSON.stringify(value));assert.equal(value.headerOverflow,false,JSON.stringify(value));assert.equal(value.hit,true,JSON.stringify(value));assert.ok(value.close.width>=20);assert.ok(value.close.left>=value.strip.left-1&&value.close.right<=value.strip.right+1,JSON.stringify(value));await screenshot('after-many-tabs-'+width);
  }
 });
 await check('project file tree docks directly below the merged header and remains the same tree when expanded',async()=>{
  await resetWidth();await evaluate(`showView('agent');AgentWorkspace.sync()`);await selectImport();await click('#readerFilesToggle');await until(()=>evaluate(`document.getElementById('readingPane').classList.contains('with-project-files')`),'file tree dock');
  const measureDock=()=>evaluate(`(()=>{const r=document.getElementById('conversationInspector').getBoundingClientRect(),h=document.querySelector('.reading-toolbar').getBoundingClientRect();return{top:r.top,headerBottom:h.bottom,width:r.width,parent:document.getElementById('conversationInspector').parentElement.id}})()`);
  let value=await measureDock();assert.equal(value.parent,'readingPane');assert.ok(Math.abs(value.top-value.headerBottom)<=1,JSON.stringify(value));assert.ok(value.width>=150);
  await evaluate(`window.__chromeTree=document.getElementById('conversationProjectFiles');window.__chromeTreeChild=__chromeTree.firstElementChild;ReadingPane.setExpanded(true)`);await delay(100);value=await measureDock();assert.ok(Math.abs(value.top-value.headerBottom)<=1,JSON.stringify(value));assert.equal(await evaluate(`document.getElementById('conversationProjectFiles')===__chromeTree&&__chromeTree.firstElementChild===__chromeTreeChild`),true);
  await screenshot('after-project-tree');await click('.workspace-inspector-close');await evaluate(`ReadingPane.setExpanded(false)`);
 });
 await check('rejecting a dirty note leave keeps its draft, active tab and non-PDF header intact',async()=>{
  await resetWidth();await evaluate(`openNote('ui-notes')`);await until(()=>evaluate(`NoteEditor.inlineActive('ui-notes')`),'editable note');await click('[data-note-action=edit]');
  await evaluate(`(()=>{const source=document.querySelector('.note-document-source textarea');source.value+=String.fromCharCode(10,10)+'Unsaved isolated chrome draft';source.dispatchEvent(new Event('input',{bubbles:true}));window.__chromeDraft=source.value;window.__chromeNoteRoot=document.querySelector('.note-document');window.__chromeNoteTabs=ReadingPane.snapshot().tabs.map(tab=>tab.key);document.querySelector('[data-reading-key='+CSS.escape(JSON.stringify(['import','layout-pdf']))+']').click()})()`);
  await until(()=>evaluate(`!!document.querySelector('.note-document-leave:not([hidden])')`),'dirty leave prompt');await click('[data-note-action=stay]');await delay(80);
  const value=await evaluate(`({active:ReadingPane.snapshot().activeKey,tabs:ReadingPane.snapshot().tabs.map(tab=>tab.key),sameEditor:document.querySelector('.note-document')===__chromeNoteRoot,draftIntact:document.querySelector('.note-document-source textarea').value===__chromeDraft,savedUnchanged:!state.notes.find(note=>note.id==='ui-notes').content.includes('Unsaved isolated'),pdf:document.body.classList.contains('reading-pdf'),tablistSame:document.getElementById('readingTabs')===__chromeTabs,parent:__chromeTabs.parentElement.id})`);
  assert.equal(value.active,JSON.stringify(['note','ui-notes']));assert.deepEqual(value.tabs,await evaluate('__chromeNoteTabs'));for(const key of ['sameEditor','draftIntact','savedUnchanged','tablistSame'])assert.equal(value[key],true,JSON.stringify(value));assert.equal(value.pdf,false);assert.equal(value.parent,'readingPane');
  // Settle the real guard explicitly so later independent tests do not hang.
  await evaluate(`document.querySelector('[data-reading-key='+CSS.escape(JSON.stringify(['import','layout-pdf']))+']').click()`);await until(()=>evaluate(`!!document.querySelector('.note-document-leave:not([hidden])')`),'discard leave prompt');await click('[data-note-action=discard]');await ready(1);
 });
 await check('non-PDF expand toggles preserve a synthetic video element rather than remounting media',async()=>{
  // This is shell identity coverage, not codec/playback acceptance. No video URL
  // or fake playback success is used: insert a src-less media probe in a real
  // non-PDF import tab and count DOM replacement via direct object identity.
  await evaluate(`state.imports.push({id:'chrome-video',name:'Synthetic-video.mp4',mimeType:'video/mp4',workspace:'课程',projectId:'pdf-project'});ReadingPane.present('import','chrome-video');const visual=document.getElementById('previewVisual');visual.replaceChildren();const v=document.createElement('video');v.controls=true;v.dataset.fixture='media-identity-only';visual.append(v);window.__chromeVideo=v;window.__chromeMediaMutations=0;window.__chromeMediaObserver=new MutationObserver(records=>{for(const r of records)if([...r.removedNodes].includes(v))__chromeMediaMutations++});__chromeMediaObserver.observe(visual,{childList:true});`);
  assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('readingExpand')).display`),'none');await click('#readingExpand');await delay(60);assert.equal(await evaluate(`ReadingPane.snapshot().expanded`),true);assert.equal(await evaluate(`document.querySelector('video[data-fixture]')===__chromeVideo&&__chromeVideo.isConnected&&__chromeMediaMutations===0`),true);
  await click('#readingExpand');await delay(60);assert.equal(await evaluate(`ReadingPane.snapshot().expanded`),false);assert.equal(await evaluate(`document.querySelector('video[data-fixture]')===__chromeVideo&&__chromeVideo.isConnected&&__chromeMediaMutations===0`),true);await evaluate('__chromeMediaObserver.disconnect()');await selectImport();
 });
 await check('Wiki PDF hides the conversation-owned project button and returning to Agent restores it',async()=>{
  await evaluate(`showView('wiki');AgentWorkspace.sync()`);await selectImport();await evaluate('AgentWorkspace.sync()');assert.equal(await evaluate(`document.getElementById('readerFilesToggle').hidden||getComputedStyle(document.getElementById('readerFilesToggle')).display==='none'`),true);await screenshot('after-wiki');
  await evaluate(`showView('agent');AgentWorkspace.sync()`);assert.equal(await evaluate(`document.getElementById('readerFilesToggle').hidden`),false);assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('readerFilesToggle')).display`),'none');
 });
 await check('fixture PDF bytes stay unchanged, with no external requests or renderer errors',async()=>{assert.deepEqual(fs.readFileSync(path.join(STORE,'files','layout-pdf')),original);assert.deepEqual(externalRequests,[]);assert.deepEqual(rendererErrors,[]);});
 const report={passed:checks.length,checks,skipped,failures,measurements,rendererErrors,externalRequests,modelCalls:0,workspace:TEMP,output:OUT,hashes,scope:'Production renderer + real PDF raster service with synthetic state. Native CSS is emulated in Electron; synthetic media checks DOM identity only, not playback. No native WKWebView acceptance claim.'};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks,failures:report.failures,rendererErrors:report.rendererErrors,externalRequests:report.externalRequests,output:OUT},null,2));clearTimeout(watchdog);win.destroy();server.kill();app.exit(failures.length?1:0);
})().catch(error=>{console.error(error);fs.writeFileSync(path.join(OUT,'fatal.json'),JSON.stringify({error:error.stack,checks,failures,rendererErrors,externalRequests},null,2));clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1);});
