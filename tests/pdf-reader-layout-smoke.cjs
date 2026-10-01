/* Real PDF raster service and production renderer; native CSS emulation is
   explicit and does not claim acceptance in the WKWebView host. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict'), { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-pdf-layout-')), STORE = path.join(TEMP, 'store'), OUT = path.join(ROOT, 'test-results/pdf-reader-layout-20260929');
fs.mkdirSync(path.join(STORE, 'files'), { recursive: true }); fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const made = spawnSync(process.env.PYTHON || 'python3', ['-c', `import fitz,json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=fitz.open()
for index,size in enumerate([(595,842),(842,595)]):
 page=d.new_page(width=size[0],height=size[1]); page.insert_text((44,60),'PDF READING / PAGE '+str(index+1),fontsize=23)
 for row in range(24): page.insert_text((44,110+row*17),'Readable document text: context, references, interaction and review.',fontsize=11)
 page.draw_rect(fitz.Rect(38,78,size[0]-38,88),color=(0.12,0.48,0.43),fill=(0.12,0.48,0.43))
(p/'layout-pdf').write_bytes(d.tobytes()); (p/'layout-pdf.meta.json').write_text(json.dumps({'name':'Reading-layout.pdf','mimeType':'application/pdf'}))`, path.join(STORE, 'files')]);
assert.equal(made.status, 0, made.stderr.toString());
const original = fs.readFileSync(path.join(STORE, 'files', 'layout-pdf')), checks = [], failures = [], rendererErrors = [], externalRequests = [], measurements = [], accessibility = [];
let win, server; const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 250; n++) { if (await fn()) return; await delay(40); } throw Error('Timeout: ' + label); }
const watchdog = setTimeout(() => { win?.destroy(); server?.kill(); app.exit(1); }, 120000);
(async () => {
 const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); }); const origin = `http://127.0.0.1:${port}`;
 const log = fs.openSync(path.join(TEMP, 'server.log'), 'a'); server = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE }, stdio: ['ignore', log, log] });
 await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'fixture server'); await app.whenReady();
 win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
 win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => { const external = !request.url.startsWith(origin + '/'); if (external) externalRequests.push(request.url); done({ cancel: external }); });
 const evaluate = code => win.webContents.executeJavaScript(code, true), click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const inspectReaderAX = async label => {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  const {nodes} = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  const names = nodes.filter(node => !node.ignored).map(node => ({role:node.role?.value,name:node.name?.value}));
  const dom = await evaluate(`(()=>{const inspect=id=>{const e=document.getElementById(id),ancestors=[];for(let a=e;a;a=a.parentElement)ancestors.push({id:a.id,tag:a.tagName,hidden:a.hidden,inert:a.inert,ariaHidden:a.getAttribute('aria-hidden'),visibility:getComputedStyle(a).visibility,display:getComputedStyle(a).display});return ancestors};return{reader:inspect('readingPane'),dialog:inspect('previewDialog'),openDialogs:[...document.querySelectorAll('dialog[open]')].map(e=>({id:e.id,modal:e.matches(':modal'),glass:e.dataset.appkitGlass})),view:document.body.dataset.view,inspectorParent:document.querySelector('#conversationInspector').parentElement.id}})()`);
  const record={label,dom,names:names.filter(item=>/阅读|PDF|上一页|下一页|适合|全屏|页码/.test(item.name||''))};accessibility.push(record);
  assert.ok(names.some(item=>item.name==='资料阅读区'),JSON.stringify(record));
  assert.ok(names.some(item=>item.name==='下一页'),JSON.stringify(record));
  assert.ok(dom.reader.every(item=>!item.hidden&&!item.inert&&item.ariaHidden!=='true'&&item.visibility==='visible'&&item.display!=='none'),JSON.stringify(record));
  assert.deepEqual(dom.openDialogs.filter(item=>item.modal),[]);
 };
 const ready = page => until(() => evaluate(`document.querySelector('.pdf-sheet img')?.complete&&document.querySelector('.pdf-sheet img').naturalWidth>0&&Number(document.querySelector('[data-pdf-page]')?.value)===${page}`), 'PDF page ' + page);
 const screenshot = async name => { await delay(100); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
 async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await screenshot('failure-'+name.replace(/[^a-z0-9]+/gi,'-').slice(0,80)); } }
 const measure = () => evaluate(`(()=>{const rect=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return{width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth}};return{window:{width:innerWidth,height:innerHeight},reader:rect('#readingPane'),viewport:rect('.pdf-viewport'),image:rect('.pdf-sheet img'),dialog:rect('#previewDialog'),main:rect('.main'),overflow:document.documentElement.scrollWidth>innerWidth,focused:document.body.classList.contains('workspace-reader-focus'),pdf:document.body.classList.contains('reading-pdf')}})()`);
 await win.loadURL(origin); await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`), 'hydrate');
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};` + fs.readFileSync(path.join(ROOT, 'tests/fixtures/agent-workbench.js'), 'utf8'));
 await evaluate(`(()=>{state.projects=[{id:'pdf-project',name:'PDF 阅读验收',workspace:'课程'}];currentConversation().projectId='pdf-project';state.notes.forEach(note=>note.projectId='pdf-project');state.imports=[{id:'layout-pdf',name:'Reading-layout.pdf',mimeType:'application/pdf',content:'Indexed text from a real PDF.',pages:[{page:1,text:'Readable document text on the first original page.'},{page:2,text:'Landscape source page and preserved indexing.'}],workspace:'课程',projectId:'pdf-project'}];state.ui.inspectorOpen=false;state.ui.panelWidths={reader:420};state.settings.reduceMotion=true;applyUiPreferences();renderAll();openImport('layout-pdf',1);})()`); await ready(1);
 await check('web 1280 × 800 uses a document-sized reader and actual remaining height', async () => {
  const value = await measure(); measurements.push({ case: 'web-1280', ...value }); assert.equal(value.pdf, true); assert.equal(value.focused, false); assert.equal(value.overflow, false); assert.ok(value.reader.width >= 600, JSON.stringify(value)); assert.ok(value.main.width >= 350); assert.ok(value.viewport.height >= 480, JSON.stringify(value)); assert.ok(value.viewport.bottom <= 800); await screenshot('web-1280-light');
 });
 await check('fit-page and fit-width use the actual canvas after toolbar layout', async () => {
  await click('[data-pdf-fit-page]'); await delay(100); let value = await measure(); measurements.push({ case: 'web-fit-page', ...value }); assert.ok(value.image.height <= value.viewport.height - 20, JSON.stringify(value)); assert.ok(value.image.width <= value.viewport.width - 20); assert.equal(value.overflow, false); await screenshot('web-fit-page');
  await click('[data-pdf-fit]'); await delay(100); value = await measure(); assert.ok(value.image.width >= value.viewport.width - 60); assert.ok(value.image.width <= value.viewport.width - 20); assert.equal(value.overflow, false);
 });
 await check('PDF inspector overlays a constrained reader instead of reducing the page width again', async () => {
  const before = await measure(); await evaluate(`ContextWorkbench.open()`); await delay(80); const after = await measure(); measurements.push({ case: 'web-context', ...after }); assert.ok(Math.abs(before.dialog.width - after.dialog.width) <= 1); assert.ok(Math.abs(before.viewport.width - after.viewport.width) <= 1); assert.equal(after.overflow, false); await screenshot('web-context-overlay'); await click('.workspace-inspector-close');
 });
 await check('PDF remains accessible after conversation context recent/close and research Wiki reopening', async () => {
  await inspectReaderAX('before route');
  await evaluate(`ReadingPane.hide();openConversation('ui-conversation');ContextWorkbench.open()`);await delay(100);await click('#context-tab-recent');await click('.workspace-inspector-close');
  await evaluate(`showView('research');showView('wiki');openImport('layout-pdf',1)`);await ready(1);await delay(150);
  await inspectReaderAX('after context and Wiki');
  assert.equal(await evaluate(`document.querySelector('#conversationInspector').contains(document.querySelector('#readingPane'))`),false);
  await screenshot('reader-accessibility-wiki');await evaluate(`showView('agent')`);
 });
 await check('narrow web content becomes a full reader with an explicit return control', async () => {
  win.setContentSize(1100, 760); await delay(150); const value = await measure(); measurements.push({ case: 'web-1100', ...value }); assert.equal(value.focused, true); assert.ok(value.reader.width >= 1060); assert.equal(value.main.width, 0); assert.equal(value.overflow, false); assert.ok(await evaluate(`document.querySelector('#readingBack').getBoundingClientRect().width>20`)); await screenshot('web-1100-focus');
 });
 await evaluate(`(()=>{const style=document.createElement('style');style.id='native-layout-fixture';style.textContent=${JSON.stringify(fs.readFileSync(path.join(ROOT, 'native/Resources/workspace.css'), 'utf8'))};document.head.append(style);document.body.classList.add('aibro-native');WorkspaceLayout.refresh();})()`);
 for (const [width, height, focused] of [[1280, 800, false], [1024, 720, false], [880, 720, true]]) await check(`native CSS at ${width} × ${height} preserves a large PDF canvas`, async () => {
  win.setContentSize(width, height); await evaluate(`WorkspaceLayout.refresh()`); await delay(150); const value = await measure(); measurements.push({ case: `native-css-${width}`, ...value }); assert.equal(value.focused, focused); assert.equal(value.overflow, false); assert.ok(value.viewport.height >= height * .6, JSON.stringify(value)); assert.ok(value.reader.width >= (focused ? width - 2 : width * .6), JSON.stringify(value)); if (!focused) assert.ok(value.main.width >= 399); await screenshot(`native-css-${width}-light`);
 });
 await check('non-modal model panel preserves the visible reader and native material before and after closing', async () => {
  win.setContentSize(1280,800);
  await evaluate(`state.settings.reduceMotion=false;applyUiPreferences()`);
  // Only the AppKit material acknowledgement is simulated. Production geometry
  // collection, CSS, native model dialog, and host routing stay unchanged.
  await evaluate(`window.webkit={messageHandlers:{glassRegions:{postMessage(){queueMicrotask(()=>NativeGlassSurface.acknowledge(true));}}}};` + fs.readFileSync(path.join(ROOT,'native/Resources/glass-regions.js'),'utf8'));
  await until(()=>evaluate(`document.documentElement.classList.contains('appkit-web-glass')`),'native glass acknowledgement');
  await evaluate(`ConversationModels.open()`);await until(()=>evaluate(`!document.querySelector('#modelPicker').hidden`),'model panel');
  assert.equal(await evaluate(`document.querySelector('#modelPicker').matches(':modal')`),false);
  assert.notEqual(await evaluate(`document.querySelector('#modelPicker').dataset.appkitGlass`),'modal');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#readingPane')).visibility`),'visible');
  await inspectReaderAX('reader stays accessible while model panel is open');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until(()=>evaluate(`!!document.querySelector('#modelPicker').hidden&&getComputedStyle(document.querySelector('#readingPane')).visibility==='visible'`),'reader visibility after modal');
  await evaluate(`openConversation('ui-conversation');ContextWorkbench.open()`);await delay(100);await click('#context-tab-recent');await click('.workspace-inspector-close');
  await evaluate(`showView('research');showView('wiki');openImport('layout-pdf',1)`);await ready(1);await delay(150);await inspectReaderAX('native CSS and glass after model/context/Wiki');
  await click('#readingCollapse');await click('#readingToggle');await ready(1);await inspectReaderAX('native CSS and glass after collapse and reopen');
  await evaluate(`ReadingPane.setExpanded(true)`);await delay(100);await inspectReaderAX('native CSS and glass expanded');
  await evaluate(`ReadingPane.setExpanded(false);showView('agent')`);
 });
 await check('note/PDF switches and reopen recompute the right layout without overwriting note width', async () => {
  win.setContentSize(1280, 800); await evaluate(`openNote('ui-notes')`); await until(() => evaluate(`!document.body.classList.contains('reading-pdf')`), 'note layout'); assert.equal(await evaluate(`Math.round(document.querySelector('#readingPane').getBoundingClientRect().width)`), 420);
  await evaluate(`openImport('layout-pdf',2)`); await ready(2); assert.ok((await measure()).reader.width >= 768); await click('#readingCollapse'); assert.equal(await evaluate(`document.body.classList.contains('reading-pdf')`), false); await click('#readingToggle'); await ready(2); assert.equal((await measure()).pdf, true); assert.equal(await evaluate(`state.ui.panelWidths.reader`), 420);
  await evaluate(`state.ui.theme='dark';applyUiPreferences()`); await screenshot('native-css-1280-dark-page2');
 });
 await check('keyboard paging and full-reader expansion keep page identity and a bounded canvas', async () => {
  await evaluate(`document.querySelector('.pdf-viewport').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`); await ready(1); await click('[data-pdf-fullscreen]'); assert.equal(await evaluate(`document.body.classList.contains('reading-expanded')`), true); await delay(100); const value = await measure(); measurements.push({ case: 'native-css-expanded', ...value }); assert.equal(value.overflow, false); assert.ok(value.reader.width >= 1278); assert.ok(value.viewport.height >= 480); await screenshot('native-css-expanded-dark');
 });
 await check('360px and 440px content keep all PDF controls available without horizontal overflow', async () => {
  for(const width of [440,360]){win.setContentSize(width,720); await delay(150); await click('[data-pdf-fit-page]'); await delay(80); const value=await measure();measurements.push({case:`native-css-narrow-${width}`,...value});assert.equal(value.overflow,false);assert.ok(value.viewport.height>=300,JSON.stringify(value));assert.ok(value.image.width<=value.viewport.width);assert.ok(value.image.height<=value.viewport.height);const toolbar=await evaluate(`(()=>{const e=document.querySelector('.pdf-reader-toolbar');return{scroll:e.scrollWidth,client:e.clientWidth}})()`);assert.ok(toolbar.scroll<=toolbar.client+1,JSON.stringify(toolbar));await screenshot(`native-css-${width}-dark`);}
 });
 await check('fixture document bytes are intact and there were no external calls or renderer errors', async () => { assert.deepEqual(fs.readFileSync(path.join(STORE, 'files', 'layout-pdf')), original); assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []); });
 const report = { passed: checks.length, checks, failures, measurements, rendererErrors, externalRequests, accessibility, modelCalls: 0, workspace: TEMP, scope: 'Production web renderer and real PDF raster service; native CSS emulated in Electron, not native WKWebView acceptance.' }; fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); clearTimeout(watchdog); win.destroy(); server.kill(); app.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error); clearTimeout(watchdog); win?.destroy(); server?.kill(); app.exit(1); });
