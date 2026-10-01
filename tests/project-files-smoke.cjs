/* Production document workspace renderer + isolated real local service/files.
 * Run serially. This is not native WKWebView acceptance. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/document-workspace-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-document-workspace-')), STORE = path.join(TEMP, 'store'), PROJECT = path.join(TEMP, 'project');
for (const dir of [STORE, PROJECT, path.join(PROJECT, 'docs/research'), path.join(PROJECT, 'src'), OUT]) fs.mkdirSync(dir, { recursive: true });
const diskFile = path.join(PROJECT, 'docs/research/plan.md'), original = '# Plan\n\nOriginal text.\n';
fs.writeFileSync(diskFile, original); fs.writeFileSync(path.join(PROJECT, 'src/app.js'), 'export const ready = false;\n');
app.setPath('userData', path.join(TEMP, 'profile'));
const checks = [], failures = [], rendererErrors = []; let server, win, origin, ending = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
async function until(fn, label, timeout = 16000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await wait(35); } throw Error('Timed out: ' + label); }
async function check(label, fn) { try { await fn(); checks.push(label); console.log('PASS', label); } catch (error) { failures.push({ label, error: error.stack }); console.error('FAIL', label, error.message); } }
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function mode(label, local = true) { await evaluate(`(()=>{const host=document.querySelector(${JSON.stringify(local ? '.local-document-toolbar' : '.note-document-toolbar-island')});const control=[...host.querySelectorAll('[role="radio"]')].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!control)throw Error('Missing mode');control.click();})()`); await until(() => evaluate(local ? 'ProjectFiles.current()&&!ProjectFiles.current().loading' : '!document.querySelector(".note-document").classList.contains("loading")'), 'mode ready'); }
async function edit(value, local = true) {
  const selector = local ? '.local-document .cm-content' : '#previewContent .cm-content';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), 'source editor');
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  win.webContents.focus(); await wait(80);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  await wait(40); await win.webContents.insertText(value);
  try { await until(() => evaluate(`(${local ? 'ProjectFiles' : 'NoteEditor'}.currentContent()?.content)===${JSON.stringify(value)}`), 'typed canonical content'); } catch (error) { console.error('EDIT STATE',await evaluate(`({current:${local ? 'ProjectFiles' : 'NoteEditor'}.currentContent(),focus:document.activeElement.outerHTML.slice(0,500)})`)); throw error; }
}
async function openLocal() { await evaluate(`openPreview('local-file',ProjectFiles.localId({projectId:'editor-project',candidateId:window.__cid||state.projects.find(p=>p.id==='editor-project').localFolder.id,path:'docs/research/plan.md'}))`); await until(() => evaluate('ProjectFiles.current()&&!ProjectFiles.current().loading'), 'local ready'); }
async function shot(name) { await wait(70); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const watchdog = setTimeout(() => { failures.push({ label: 'watchdog', error: 'Timed out' }); void finish(1); }, 180000);
app.on('window-all-closed', () => {});
async function finish(code) { if (ending) return; ending = true; clearTimeout(watchdog); win?.destroy(); if (server) { server.kill(); await Promise.race([new Promise(r=>server.once('exit',r)),wait(1500)]); } fs.rmSync(TEMP,{recursive:true,force:true}); fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({passed:checks.length,checks,failures,rendererErrors,modelCalls:0,userWorkspaceLoaded:false,temporaryStoreRemoved:!fs.existsSync(TEMP)},null,2)); app.exit(code); }
(async () => {
 const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); }); origin='http://127.0.0.1:'+port;
 const log=fs.openSync(path.join(OUT,'server.log'),'w');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore',log,log]});
 await until(()=>new Promise(resolve=>http.get(origin+'/__health',r=>{r.resume();resolve(r.statusCode===200);}).on('error',()=>resolve(false))),'server'); await app.whenReady();
 win=new BrowserWindow({show:false,width:1500,height:1040,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>cb({cancel:!details.url.startsWith(origin+'/')}));
 win.webContents.on('console-message',event=>{if(event.level==='error'){rendererErrors.push(event.message);console.error('RENDERER',event.message);}});
 await win.loadURL(origin);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');
 await evaluate(`(async()=>{window.__exportBlobs=new Map();const originalCreate=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=originalCreate(blob);__exportBlobs.set(url,blob);return url;};WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};document.querySelectorAll('dialog[open]').forEach(n=>n.close());const root=await FileContext.request('/__local/roots',{path:${JSON.stringify(PROJECT)}});window.__cid=root.candidate.id;state.projects.push({id:'editor-project',name:'文档工作区',workspace:'科研',localFolder:{id:__cid,name:'project',path:${JSON.stringify(PROJECT)}}});state.notes.push({id:'editor-note',title:'研究计划',projectId:'editor-project',workspace:'科研',content:"# Research\\n\\nSaved note.",folderPath:'Research',createdAt:Date.now(),updatedAt:Date.now()},{id:'other-note',title:'未在对话使用的资料',projectId:'editor-project',workspace:'科研',content:'Other'});state.imports.push({id:'editor-import',name:'Paper.txt',projectId:'editor-project',workspace:'科研',content:'Original source',mimeType:'text/plain'});const conversation=currentConversation();conversation.projectId='editor-project';conversation.messages=[{id:'sent',role:'user',text:'Review sources',attachmentIds:['editor-import'],fileReferences:[{type:'note',id:'editor-note'}],at:Date.now()}];conversation.attachments=['editor-import'];conversation.draftAttachmentIds=[];state.ui.inspector='files';state.ui.inspectorOpen=true;await saveDocumentDurably();renderAll();showView('agent');state.ui.inspector='files';state.ui.inspectorOpen=true;applyUiPreferences();AgentWorkspace.sync();})()`);
 await check('real Kit file scopes distinguish sent conversation files from the project library',async()=>{
  await until(()=>evaluate('!!document.querySelector(".document-files-kit")'),'file island');
  assert.match(await evaluate('document.querySelector("#conversationProjectFiles").textContent'),/Paper.txt/);
  assert.doesNotMatch(await evaluate('document.querySelector("#conversationProjectFiles").textContent'),/未在对话使用的资料/);
  await evaluate(`document.querySelectorAll('#conversationProjectFiles [role="radio"]').forEach(n=>{if(n.textContent==='所有文件')n.click()})`);
  assert.match(await evaluate('document.querySelector("#conversationProjectFiles").textContent'),/未在对话使用的资料/);
 });
 await check('local Markdown uses the production editor and raw no-edit mode switches preserve bytes',async()=>{
  await openLocal();await mode('源码');assert.equal(await evaluate('ProjectFiles.currentContent().content'),original);
  await mode('编辑');await until(()=>evaluate('!!document.querySelector(".local-document .ProseMirror")'),'visual editor');await mode('源码');assert.equal(await evaluate('ProjectFiles.currentContent().content'),original);assert.equal(fs.readFileSync(diskFile,'utf8'),original);
 });
 const localDraft='# Plan\n\nUnsaved local draft.\n';
 await check('ordinary file switches persist drafts without writing files or prompting Save',async()=>{
  await edit(localDraft);await evaluate('openPreview("note","editor-note")');assert.equal(await evaluate('state.previewRecord.type'),'note');assert.equal(fs.readFileSync(diskFile,'utf8'),original);
  await openLocal();assert.equal(await evaluate('ProjectFiles.currentContent().content'),localDraft);assert.equal(await evaluate('ProjectFiles.current().mode'),'edit');
  assert.equal(await evaluate('document.querySelectorAll(".local-document .cm-editor").length'),1);
 });
 await check('both note and local draft exports contain current unsaved text',async()=>{
  await evaluate(`(()=>{const link=document.querySelector('#previewDownload');link.addEventListener('click',event=>event.preventDefault(),{once:true});link.click();})()`);
  assert.equal(await evaluate('__exportBlobs.get(document.querySelector("#previewDownload").href).text()'),localDraft);
  await evaluate('openPreview("note","editor-note")');await mode('源码',false);await edit('# Research\n\nUnsaved export note.',false);
  await evaluate(`(()=>{const link=document.querySelector('#previewDownload');link.addEventListener('click',event=>event.preventDefault(),{once:true});link.click();})()`);
  assert.match(await evaluate('__exportBlobs.get(document.querySelector("#previewDownload").href).text()'),/Unsaved export note/);
  assert.equal(await evaluate('state.notes.find(n=>n.id==="editor-note").content'),'# Research\n\nSaved note.');
 });
 await check('native-close hooks and renderer restart restore both tabs, drafts and editor modes',async()=>{
  assert.equal(await evaluate('flushLocalDrafts()'),true);await evaluate('saveDocumentDurably()');await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated&&NoteEditor.inlineActive("editor-note")'),'restored note');
  await until(()=>evaluate('NoteEditor.currentContent()?.content.includes("Unsaved export note")'),'restored note draft');assert.ok(await evaluate('ReadingPane.snapshot().tabs.length>=2'));
  await openLocal();assert.equal(await evaluate('ProjectFiles.currentContent().content'),localDraft);assert.equal(await evaluate('ProjectFiles.current().mode'),'edit');
 });
 await check('explicit close restores an inactive dirty file before asking its own save decision',async()=>{
  await evaluate('openPreview("note","editor-note")');await evaluate(`void ReadingPane.close(JSON.stringify(['local-file',ProjectFiles.localId({projectId:'editor-project',candidateId:state.projects.find(p=>p.id==='editor-project').localFolder.id,path:'docs/research/plan.md'})]))`);
  await until(()=>evaluate('!!document.querySelector(".local-document .note-document-leave:not([hidden])")'),'own close guard');
  await click('[data-local-document-action="stay"]');assert.equal(await evaluate('state.previewRecord.type'),'local-file');assert.equal(await evaluate('ProjectFiles.currentContent().content'),localDraft);
  assert.equal(await evaluate('ProjectFiles.save()'),true);assert.equal(fs.readFileSync(diskFile,'utf8'),localDraft);
 });
 await check('external disk edits reject stale saves and support explicit compare and merge',async()=>{
  await edit('# Plan\n\nMy competing change.\n');fs.writeFileSync(diskFile,'# Plan\n\nExternal update.\n');assert.equal(await evaluate('ProjectFiles.save()'),false);assert.match(await evaluate('ProjectFiles.currentContent().content'),/competing/);assert.match(fs.readFileSync(diskFile,'utf8'),/External update/);
  await click('[data-local-document-action="compare"]');await until(()=>evaluate('!document.querySelector("[data-local-document-action=use-latest]").hidden'),'compare');await click('[data-local-document-action="use-latest"]');await click('[data-local-document-action="restore-draft"]');await edit('# Plan\n\nExternal update.\n\nMerged safely.\n');assert.equal(await evaluate('ProjectFiles.save()'),true);assert.match(fs.readFileSync(diskFile,'utf8'),/Merged safely/);await shot('local-editor-merged');
 });
 await check('file pane remains available on document routes with selected and opened identities',async()=>{
  await evaluate('showView("wiki");ReadingPane.setExpanded(true);state.ui.inspector="files";state.ui.inspectorOpen=true;AgentWorkspace.sync()');assert.equal(await evaluate('document.querySelector("#readerFilesToggle").hidden'),false);assert.ok(await evaluate('document.querySelector("#readingPane").contains(document.querySelector("#conversationInspector"))')); await evaluate('openPreview("note","editor-note")'); assert.match(await evaluate('document.querySelector("#conversationProjectFiles .is-selected").textContent'),/研究计划/); await openLocal();
  await shot('workbench-files');
 });
 await check('disconnected folder retains a recoverable draft tab after restart without writing disk',async()=>{
  await edit('# Plan\n\nKeep after disconnect.\n');assert.equal(await evaluate('flushLocalDrafts()'),true);await evaluate(`(()=>{window.__oldLocal=ProjectFiles.current().id;delete state.projects.find(p=>p.id==='editor-project').localFolder;})()`);await evaluate('saveDocumentDurably()');
  await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated&&ProjectFiles.current()&&!ProjectFiles.current().loading'),'disconnected recovery');assert.match(await evaluate('ProjectFiles.currentContent().content'),/Keep after disconnect/);assert.equal(await evaluate('ProjectFiles.save()'),false);assert.match(fs.readFileSync(diskFile,'utf8'),/Merged safely/);
 });
 console.log(JSON.stringify({passed:checks.length,failures,rendererErrors},null,2));await finish(failures.length?1:0);
})().catch(error=>{failures.push({label:'setup',error:error.stack});console.error(error);void finish(1);});
