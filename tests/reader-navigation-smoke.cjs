/* Full production renderer, local Python PDF service and synthetic workspace.
 * Native CSS emulation and Chromium AX checks are not WKWebView acceptance. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/reader-navigation-20260929');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-reader-navigation-')), STORE = path.join(TEMP, 'store');
const PYTHON = process.env.PYTHON || 'python3';
fs.mkdirSync(path.join(STORE, 'files'), { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile')); app.on('window-all-closed', () => {});
const checks = [], failures = [], observations = [], rendererErrors = [], externalRequests = [];
let win, server, finished = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog' }); void finish(1); }, 180000);
async function until(fn, label, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(45); } throw Error('Timeout: ' + label); }
async function finish(code) {
  if (finished) return; finished = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]); }
  const stopped = !server || server.exitCode !== null || server.signalCode !== null;
  if (!stopped) { failures.push({ name: 'fixture server did not exit after SIGTERM' }); code = 1; }
  if (fs.existsSync(path.join(TEMP, 'server.log'))) fs.copyFileSync(path.join(TEMP, 'server.log'), path.join(OUT, 'server.log'));
  if (stopped) fs.rmSync(TEMP, { recursive: true, force: true });
  const hashes = Object.fromEntries(['app/reading-pane.js', 'app/pdf-reader.js', 'app/app.js', 'app/note-editor.js', 'app/note-capture.js', 'app/citation-evidence.js', 'app/project-files.js'].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
  if (!code && !failures.length) for (const name of fs.readdirSync(OUT)) if (/^failure-.*\.png$/.test(name)) fs.rmSync(path.join(OUT, name));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, observations, rendererErrors, externalRequests, sourceHashes: hashes, modelCalls: 0, userWorkspaceLoaded: false, scope: 'Full production renderer with native CSS emulation, real local PDF backend and Chromium accessibility tree; not native WKWebView QA.', temporaryProfileRemoved: !fs.existsSync(TEMP), fixtureServerStopped: stopped }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failures, report: path.join(OUT, 'report.json') }, null, 2)); app.exit(code);
}
(async () => {
  const made = spawnSync(PYTHON, ['-B', '-c', `import fitz,json,sys
from pathlib import Path
p=Path(sys.argv[1]); d=fitz.open()
for index in range(2):
 page=d.new_page(width=600,height=1800)
 page.insert_text((45,70),'NAVIGATION PAGE '+str(index+1)+' ORIGINAL',fontsize=22)
 for row in range(60): page.insert_text((45,110+row*25),'Original source line '+str(row)+' / document reading position.',fontsize=12)
(p/'navigation-pdf').write_bytes(d.tobytes())
(p/'navigation-pdf.meta.json').write_text(json.dumps({'name':'Navigation-source.pdf','mimeType':'application/pdf'}))`, path.join(STORE, 'files')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(made.status, 0, made.stderr.toString());
  const original = fs.readFileSync(path.join(STORE, 'files', 'navigation-pdf'));
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
  const origin = `http://127.0.0.1:${port}`, log = fs.openSync(path.join(TEMP, 'server.log'), 'a');
  server = spawn(PYTHON, ['-B', path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE }, stdio: ['ignore', log, log] }); fs.closeSync(log);
  await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'fixture server');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1440, height: 880, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => { const external = !request.url.startsWith(origin + '/'); if (external) externalRequests.push(request.url); done({ cancel: external }); });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const click = selector => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing control '+${JSON.stringify(selector)});node.click();})()`);
  const shot = async name => { await delay(80); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); await shot('failure-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 85)); observations.push({ failure: name, state: await evaluate(`({view:document.body.dataset.view,reading:ReadingPane.snapshot(),bodyClass:document.body.className,preview:state.previewRecord,noteValue:document.querySelector('.note-document-source textarea')?.value})`) }); } }
  const ready = page => until(() => evaluate(`(()=>{const image=document.querySelector('.pdf-sheet img');return image?.complete&&image.naturalWidth>0&&document.querySelector('[data-pdf-page]')?.value==='${page}'&&document.querySelector('[data-pdf-text-status]')?.dataset.pdfTextStatus==='ready';})()`), 'PDF page ' + page);
  const axNames = async () => (await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree')).nodes.filter(node => !node.ignored).map(node => node.name?.value || '');
  await win.loadURL('about:blank'); win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable'); await win.webContents.debugger.sendCommand('Accessibility.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: 'window.webkit={messageHandlers:{workspace:{postMessage(){}}}};' });
  await win.loadURL(origin); await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`), 'workspace hydrated');
  await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};` + fs.readFileSync(path.join(ROOT, 'tests/fixtures/agent-workbench.js'), 'utf8'));
  await evaluate(`(()=>{const now=Date.now();state.projects=[{id:'navigation-project',name:'导航与阅读验收',workspace:'课程'}];state.conversations.push({id:'navigation-search-chat',title:'导航搜索目标',workspace:'课程',projectId:'navigation-project',draft:'',messages:[{id:'navigation-answer',role:'agent',text:'这里是搜索打开的目标对话。',at:now}],attachments:[],draftAttachmentIds:[],createdAt:now});currentConversation().projectId='navigation-project';state.imports=[{id:'navigation-pdf',name:'Navigation-source.pdf',mimeType:'application/pdf',workspace:'课程',projectId:'navigation-project',content:'Synthetic PDF with two real source pages.',pages:[{page:1,text:'NAVIGATION PAGE 1 ORIGINAL'},{page:2,text:'NAVIGATION PAGE 2 ORIGINAL'}]}];state.notes=[{id:'navigation-note',title:'导航中的未保存笔记',content:'# 原始笔记\\n\\n来源为实际生成的 PDF。',workspace:'课程',projectId:'navigation-project',sourceAttachmentIds:['navigation-pdf'],createdAt:now},{id:'navigation-note-other',title:'切换目标笔记',content:'另一份记录',workspace:'课程',projectId:'navigation-project',createdAt:now}];state.ui.panelWidths={reader:500};state.ui.inspectorOpen=false;state.settings.reduceMotion=true;state.ui.theme='light';const style=document.createElement('style');style.textContent=${JSON.stringify(fs.readFileSync(path.join(ROOT, 'native/Resources/workspace.css'), 'utf8'))};document.head.append(style);document.body.classList.add('aibro-native');normalizeStateShape(state);applyUiPreferences();renderAll();WorkspaceLayout.refresh();save();window.__navigationRequests=[];const fetchOriginal=fetch.bind(window);window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname.includes('/__files/'))__navigationRequests.push(url.pathname+url.search);return fetchOriginal(input,init);};})()`);

  await check('expanded PDF yields settings and leaves no PDF words in the accessible tree', async () => {
    await evaluate(`openImport('navigation-pdf',2)`); await ready(2); await click('[data-pdf-fullscreen]'); await delay(200);
    await evaluate(`window.__navigationPdf=document.querySelector('.pdf-reader');window.__navigationViewport=document.querySelector('.pdf-viewport');__navigationViewport.scrollTop=460;`); await delay(180);
    await evaluate(`window.__navigationScroll=__navigationViewport.scrollTop;window.__navigationPreview=state.previewRecord;window.__navigationRequestCount=__navigationRequests.length;`);
    assert.equal(await evaluate(`ReadingPane.snapshot().expanded`), true); assert.ok(await evaluate('__navigationScroll') > 200);
    assert.match((await axNames()).join(' '), /NAVIGATION\s+PAGE\s+2\s+ORIGINAL/, 'visible source words are exposed before navigation');
    await evaluate(`showView('settings','设置')`); await delay(100);
    const result = await evaluate(`({view:document.body.dataset.view,snapshot:ReadingPane.snapshot(),readerHidden:document.getElementById('readingPane').hidden,settingsWidth:document.getElementById('settings').getBoundingClientRect().width,mainWidth:document.querySelector('.main').getBoundingClientRect().width,pdfSame:document.querySelector('.pdf-reader')===__navigationPdf,previewSame:state.previewRecord===__navigationPreview,busy:cloudHostBusy(),expandedClass:document.body.classList.contains('reading-expanded')})`);
    observations.push({ expandedToSettings: result });
    assert.equal(result.view, 'settings'); assert.equal(result.snapshot.visible, false); assert.equal(result.snapshot.retained, true); assert.equal(result.snapshot.expanded, true);
    assert.equal(result.readerHidden, true); assert.ok(result.settingsWidth > 250); assert.ok(result.mainWidth > 250); assert.equal(result.pdfSame, true); assert.equal(result.previewSame, true); assert.equal(result.busy, true); assert.equal(result.expandedClass, false);
    assert.doesNotMatch((await axNames()).join(' '), /NAVIGATION\s+PAGE\s+2\s+ORIGINAL/);
    await shot('expanded-pdf-parked-settings');
  });
  await check('reading toggle resumes the same PDF and viewport at page two with its expanded reading position', async () => {
    await click('#readingToggle'); await ready(2); await delay(240);
    const result = await evaluate(`({same:document.querySelector('.pdf-reader')===__navigationPdf,viewport:document.querySelector('.pdf-viewport')===__navigationViewport,scroll:__navigationViewport.scrollTop,before:__navigationScroll,snapshot:ReadingPane.snapshot(),classExpanded:document.body.classList.contains('reading-expanded'),newRequests:__navigationRequests.slice(__navigationRequestCount)})`);
    observations.push({ resumedPdf: result }); assert.equal(result.same, true); assert.equal(result.viewport, true); assert.ok(Math.abs(result.scroll - result.before) <= 2, JSON.stringify(result)); assert.equal(result.snapshot.visible, true); assert.equal(result.snapshot.retained, false); assert.equal(result.snapshot.expanded, true); assert.equal(result.classExpanded, true);
    assert.equal(result.newRequests.some(url => /preview-info|preview-text|preview-metadata/.test(url)), false, 'resume does not reconstruct the document'); await shot('same-pdf-resumed-page-two');
  });
  await check('wide split project and conversation navigation keeps the existing reader visible', async () => {
    await click('[data-pdf-fullscreen]'); await delay(180);
    for (const route of [`openProject('navigation-project')`, `openConversation('navigation-search-chat')`]) {
      await evaluate(route); await delay(100);
      const result = await evaluate(`({snapshot:ReadingPane.snapshot(),reader:document.getElementById('readingPane').getBoundingClientRect().width,main:document.querySelector('.main').getBoundingClientRect().width,same:document.querySelector('.pdf-reader')===__navigationPdf,page:document.querySelector('[data-pdf-page]').value})`);
      observations.push({ wideSplit: route, result }); assert.equal(result.snapshot.visible, true); assert.equal(result.snapshot.retained, false); assert.equal(result.same, true); assert.equal(result.page, '2'); assert.ok(result.reader >= 300); assert.ok(result.main >= 250);
    }
    await shot('wide-split-conversation-and-pdf');
  });
  await check('narrow navigation and real search-result activation reveal their conversation instead of a covering PDF', async () => {
    win.setContentSize(760, 840); await evaluate(`WorkspaceLayout.refresh();ReadingPane.resume();`); await delay(180);
    await evaluate(`openConversation('ui-conversation')`); await delay(100);
    assert.equal(await evaluate(`ReadingPane.snapshot().retained&&!ReadingPane.snapshot().visible&&document.querySelector('.main').getBoundingClientRect().width>200`), true);
    await click('#readingToggle'); await ready(2); await evaluate(`openSearchDialog()`); await until(() => evaluate(`document.getElementById('searchDialog').open`), 'search dialog');
    await evaluate(`const input=document.getElementById('globalSearchInput');input.value='导航搜索目标';input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await until(() => evaluate(`!!document.querySelector('[data-search-result="conversation:navigation-search-chat"]')`), 'actual conversation search result');
    await click('[data-search-result="conversation:navigation-search-chat"]');
    await until(() => evaluate(`state.currentConversationId==='navigation-search-chat'&&!document.getElementById('searchDialog').open`), 'search target opened');
    assert.equal(await evaluate(`document.body.dataset.view==='agent'&&ReadingPane.snapshot().retained&&!ReadingPane.snapshot().visible&&document.querySelector('.main').getBoundingClientRect().width>200`), true);
    assert.doesNotMatch((await axNames()).join(' '), /NAVIGATION\s+PAGE\s+2\s+ORIGINAL/);
    const focus = await evaluate(`({tag:document.activeElement.tagName,id:document.activeElement.id,hiddenAncestor:!!document.activeElement.closest('[hidden]')})`); observations.push({ searchDestinationFocus: focus }); assert.equal(focus.hiddenAncestor, false);
    await shot('narrow-search-conversation-visible');
  });
  await check('dirty note parks for settings without a prompt or draft loss and reopens the exact editor', async () => {
    win.setContentSize(1440, 880); await evaluate(`WorkspaceLayout.refresh();openNote('navigation-note')`); await until(() => evaluate(`NoteEditor.inlineActive('navigation-note')`), 'inline note');
    await click('[data-note-action="edit"]'); await evaluate(`window.__navigationNote=document.querySelector('.note-document');window.__navigationTextarea=document.querySelector('.note-document-source textarea');window.__navigationOriginal=state.notes.find(n=>n.id==='navigation-note').content;__navigationTextarea.value='# 草稿仍在\\n\\n导航后保留这段尚未保存的修改。';__navigationTextarea.dispatchEvent(new Event('input',{bubbles:true}));window.__navigationDraft=__navigationTextarea.value;ReadingPane.setExpanded(true);showView('settings','设置');`); await delay(100);
    assert.equal(await evaluate(`ReadingPane.snapshot().retained&&!ReadingPane.snapshot().visible&&document.querySelector('.note-document')===__navigationNote&&__navigationTextarea.value===__navigationDraft&&state.notes.find(n=>n.id==='navigation-note').content===__navigationOriginal&&document.querySelector('.note-document-leave').hidden&&cloudHostBusy()`), true);
    assert.equal((await axNames()).some(name => name === 'Markdown 正文'), false);
    await click('#readingToggle'); await delay(100);
    assert.equal(await evaluate(`ReadingPane.snapshot().visible&&ReadingPane.snapshot().expanded&&document.querySelector('.note-document')===__navigationNote&&document.querySelector('.note-document-source textarea')===__navigationTextarea&&__navigationTextarea.value===__navigationDraft`), true); await shot('dirty-note-resumed');
  });
  await check('switching documents from a parked dirty note reveals its save-discard-stay prompt and stay retains the note', async () => {
    await evaluate(`showView('settings','设置');window.__navigationSwitchResolved=false;window.__navigationSwitch=Promise.resolve(openNote('navigation-note-other')).then(value=>{__navigationSwitchResolved=true;return value});true;`);
    await until(() => evaluate(`!document.querySelector('.note-document-leave')?.hidden`), 'leave prompt');
    const result = await evaluate(`({reading:ReadingPane.snapshot(),same:document.querySelector('.note-document')===__navigationNote,active:state.previewRecord?.id,focused:document.activeElement.dataset.noteAction,promptWidth:document.querySelector('.note-document-leave').getBoundingClientRect().width,choices:[...document.querySelectorAll('.note-document-leave button')].map(x=>x.textContent),resolved:__navigationSwitchResolved})`);
    observations.push({ parkedLeavePrompt: result }); assert.equal(result.reading.visible, true); assert.equal(result.reading.retained, false); assert.equal(result.same, true); assert.equal(result.active, 'navigation-note'); assert.equal(result.focused, 'stay'); assert.ok(result.promptWidth > 200); assert.equal(result.resolved, false); assert.deepEqual(result.choices, ['保存并继续', '放弃修改', '继续编辑']);
    const names = await axNames(); for (const label of result.choices) assert.ok(names.includes(label), label + ' present in accessible tree');
    await shot('parked-draft-visible-decision');
    await evaluate(`showView('settings','设置');window.__navigationRepeat=Promise.resolve(openNote('navigation-note-other'));true;`);
    assert.equal(await evaluate(`ReadingPane.snapshot().visible&&!document.querySelector('.note-document-leave').hidden&&document.querySelector('.note-document')===__navigationNote`), true, 'existing leave promise becomes visible again after a second parked navigation');
    await click('[data-note-action="stay"]'); await until(() => evaluate('__navigationSwitchResolved'), 'stay resolves navigation');
    assert.equal(await evaluate(`ReadingPane.snapshot().visible&&state.previewRecord.id==='navigation-note'&&document.querySelector('.note-document')===__navigationNote&&__navigationTextarea.value===__navigationDraft&&document.querySelector('.note-document-leave').hidden`), true);
  });
  await check('saving the resumed draft preserves its real PDF source and original bytes', async () => {
    assert.equal(await evaluate(`NoteEditor.saveInline()`), true);
    await evaluate(`flushWorkspace()`);
    const result = await evaluate(`(()=>{const note=state.notes.find(n=>n.id==='navigation-note');return{saved:note.content===__navigationDraft,sources:note.sourceAttachmentIds,preview:state.previewRecord.id,userEdited:note.userEdited,revisionCount:note.revisionHistory?.length||0,pending:!!state._pendingLocalSave,conflict:!!serverConflict};})()`);
    observations.push({ savedDraft: result }); assert.equal(result.saved, true); assert.deepEqual(result.sources, ['navigation-pdf']); assert.equal(result.preview, 'navigation-note'); assert.equal(result.pending, false); assert.equal(result.conflict, false); assert.ok(result.revisionCount >= 1);
    const durable = JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8'));
    const storedNote = (durable.state || durable).notes.find(note => note.id === 'navigation-note');
    assert.equal(storedNote.content, await evaluate('__navigationDraft')); assert.deepEqual(storedNote.sourceAttachmentIds, ['navigation-pdf']);
    await evaluate(`openImport('navigation-pdf',2)`); await ready(2); assert.match(await evaluate(`document.querySelector('.pdf-text-layer').textContent`), /NAVIGATION PAGE 2 ORIGINAL/);
    assert.deepEqual(fs.readFileSync(path.join(STORE, 'files', 'navigation-pdf')), original);
  });
  await check('cited AI reply saves a durable editable document with page-two evidence and reopens without overwriting manual edits', async () => {
    await ready(2);
    // Observe the real export Blob assigned to the download link. Fetching a
    // blob URL is intentionally disallowed by production connect-src; do not
    // weaken CSP or substitute re-generated Markdown in this assertion.
    await evaluate(`window.__captureExportBlobs=new Map();window.__captureCreateURL=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=__captureCreateURL(blob);if(blob.type.startsWith('text/markdown'))__captureExportBlobs.set(url,blob);return url;};true;`);
    await evaluate(`(()=>{const excerpt=document.querySelector('.pdf-text-layer').textContent.match(/NAVIGATION PAGE 2 ORIGINAL/)[0];openConversation('navigation-search-chat');const conversation=currentConversation(),run={id:'navigation-capture-run',conversationId:conversation.id,status:'completed',workspace:'课程',projectId:'navigation-project',startedAt:Date.now()-1000,finishedAt:Date.now(),attachmentIds:['navigation-pdf']};state.agentRuns.push(run);const retained=CitationEvidence.captureRetained(run,[{request:{type:'read',recordType:'import',id:'navigation-pdf'},result:{type:'import',id:'navigation-pdf',title:'Navigation-source.pdf',page:2,text:excerpt}}],state);const source=retained[0].result.evidenceRef,message={id:'navigation-capture-answer',role:'agent',runId:run.id,runStatus:'completed',text:'# 可编辑的第二页资料整理'+String.fromCharCode(10,10)+'第二页原件包含标题 NAVIGATION PAGE 2 ORIGINAL。[[cite:'+source+']]',at:Date.now()};conversation.messages.push(message);window.__captureEvidence={ref:source,page:run.evidenceSources[0].page,provided:run.evidenceSources[0].provided,excerpt:run.evidenceSources[0].excerpt};window.__captureOriginalMessage=JSON.stringify(message);window.__captureOriginalRun=JSON.stringify(run);window.__captureExpected=CitationEvidence.exportText(message,run,state);window.__captureNoteCount=state.notes.length;save();renderConversation();})()`);
    const evidence = await evaluate('__captureEvidence'); assert.equal(evidence.page, 2); assert.equal(evidence.provided, true); assert.equal(evidence.excerpt, 'NAVIGATION PAGE 2 ORIGINAL');
    assert.equal(await evaluate(`!!document.querySelector('[data-message-id="navigation-capture-answer"] .citation-chip')`), true);
    await click('[data-save-note="navigation-capture-answer"]');
    await until(() => evaluate(`(()=>{const note=state.notes.find(n=>n.sourceMessageId==='navigation-capture-answer');return note&&state.previewRecord?.id===note.id&&NoteEditor.inlineActive(note.id)&&['rich','edit'].includes(document.querySelector('.note-document')?.dataset.mode)&&!saveMessageAsNote.pending?.has('navigation-capture-answer');})()`), 'captured document opened in edit mode');
    const captured = await evaluate(`(()=>{const note=state.notes.find(n=>n.sourceMessageId==='navigation-capture-answer');window.__captureNoteId=note.id;return{id:note.id,content:note.content,expected:__captureExpected,sources:note.sourceAttachmentIds,conversation:note.sourceConversationId,project:note.projectId,count:state.notes.length,before:__captureNoteCount,mode:document.querySelector('.note-document').dataset.mode};})()`);
    assert.equal(captured.content, captured.expected); assert.match(captured.content, /第 2 页/); assert.match(captured.content, /> NAVIGATION PAGE 2 ORIGINAL/); assert.doesNotMatch(captured.content, /\[\[cite:/); assert.deepEqual(captured.sources, ['navigation-pdf']); assert.equal(captured.conversation, 'navigation-search-chat'); assert.equal(captured.project, 'navigation-project'); assert.equal(captured.count, captured.before + 1);
    const durable = JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8'));
    assert.equal((durable.state || durable).notes.find(note => note.id === captured.id).content, captured.content);
    const exported = await evaluate(`__captureExportBlobs.get(document.getElementById('previewDownload').href).text()`);
    assert.match(exported, /第 2 页/); assert.match(exported, /> NAVIGATION PAGE 2 ORIGINAL/); assert.doesNotMatch(exported, /\[\[cite:/); fs.writeFileSync(path.join(OUT, 'captured-source-document.md'), exported);
    await click('[data-note-action="edit"]');
    await evaluate(`(()=>{const input=document.querySelector('.note-document-source textarea');input.value+=String.fromCharCode(10,10)+'人工补充：本段需要在重复存为文档后继续保留。';input.dispatchEvent(new Event('input',{bubbles:true}));window.__captureManual=input.value;})()`);
    await click('[data-note-action="save"]');
    await until(() => evaluate(`state.notes.find(n=>n.id===__captureNoteId)?.content===__captureManual&&document.querySelector('.note-document-status')?.textContent.includes('已保存')&&!document.querySelector('[data-note-action="save"]').disabled`), 'manual edits saved');
    await evaluate('flushWorkspace()');
    const edited = JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8'));
    assert.equal((edited.state || edited).notes.find(note => note.id === captured.id).content, await evaluate('__captureManual'));
    if (!await evaluate(`document.querySelector('.reader-document-details').open`)) await click('.reader-document-details > summary');
    if (!await evaluate(`document.getElementById('previewRelatedSources').open`)) await click('#previewRelatedSources > summary');
    assert.ok(await evaluate(`document.querySelector('[data-preview-source="navigation-pdf"]').getBoundingClientRect().width`) > 60);
    await shot('captured-document-with-cited-source');
    await click('[data-preview-source="navigation-pdf"]'); await ready(1);
    assert.equal(await evaluate(`state.previewRecord.type==='import'&&state.previewRecord.id==='navigation-pdf'`), true);
    assert.match(await evaluate(`document.querySelector('.pdf-text-layer').textContent`), /NAVIGATION PAGE 1 ORIGINAL/);
    assert.deepEqual(fs.readFileSync(path.join(STORE, 'files', 'navigation-pdf')), original);
    await evaluate(`openConversation('navigation-search-chat')`); await click('[data-save-note="navigation-capture-answer"]');
    await until(() => evaluate(`state.previewRecord?.id===__captureNoteId&&NoteEditor.inlineActive(__captureNoteId)&&!saveMessageAsNote.pending?.has('navigation-capture-answer')`), 'existing document reopened');
    const repeated = await evaluate(`(()=>{const note=state.notes.find(n=>n.id===__captureNoteId),message=currentConversation().messages.find(m=>m.id==='navigation-capture-answer'),run=state.agentRuns.find(r=>r.id==='navigation-capture-run');return{id:note.id,preserved:note.content===__captureManual,count:state.notes.filter(n=>n.sourceMessageId==='navigation-capture-answer').length,sourceUnchanged:JSON.stringify(message)===__captureOriginalMessage&&JSON.stringify(run)===__captureOriginalRun,sources:note.sourceAttachmentIds,mode:document.querySelector('.note-document').dataset.mode};})()`);
    assert.equal(repeated.id, captured.id); assert.equal(repeated.preserved, true); assert.equal(repeated.count, 1); assert.equal(repeated.sourceUnchanged, true); assert.deepEqual(repeated.sources, ['navigation-pdf']); assert.ok(['edit', 'rich'].includes(repeated.mode));
    observations.push({ capturedReply: { evidence, noteId: captured.id, savedBodyMatchesExport: captured.content === captured.expected, pageInExport: 2, originalOpenedAtPage: 1, durableManualEdits: true, repeated } }); await shot('reopened-capture-keeps-manual-edits');
  });
  await check('renderer has no errors or outbound requests and only synthetic conversations', async () => {
    assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []);
    assert.equal(await evaluate(`state.conversations.every(c=>['ui-conversation','navigation-search-chat'].includes(c.id))`), true);
  });
  await finish(failures.length ? 1 : 0);
})().catch(error => { failures.push({ name: 'suite setup/runtime', error: error.stack }); console.error(error); void finish(1); });
