/* Real root renderer and temporary backend, with synthetic records only.
 * Run serially: ./node_modules/.bin/electron tests/document-origin-flow-smoke.cjs
 * Native CSS is loaded, but this is Chromium evidence, not WKWebView acceptance. */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..'), OUT = process.env.AIBRO_DOCUMENT_ORIGIN_OUT || path.join(ROOT, 'test-results/document-origin-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-document-origin-')), STORE = path.join(TEMP, 'store');
const FIXTURE = path.join(ROOT, 'tests/fixtures/document-origin.js');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(FIXTURE, path.join(path.dirname(OUT), 'fixture-client.js'));
app.setPath('userData', path.join(TEMP, 'profile')); app.on('window-all-closed', () => {});
let server, win, origin, ending = false;
const checks = [], failures = [], observations = [], rendererErrors = [], externalRequests = [], modelRequests = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
const quote = JSON.stringify;
const tabKey = (kind, id) => JSON.stringify([kind, id]);
const noteKey = id => tabKey('note', id);
const originalOutput = '# 甲项目成果\n\n正式知识库里的原文。\n\n## 证据\n\n返回入口不能覆盖这段原文。';
const draftOutput = '# 尚未发布的成果草稿\n\n返回与重新打开后必须保留。\n\n中文输入、正文与源文件不能被自动保存覆盖。';
async function until(fn, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(40); } throw Error('Timed out: ' + label); }
async function shot(name) { if (win && !win.isDestroyed()) fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function inspect() { return evaluate(`({view:document.body.dataset.view,project:state.currentProjectId,section:state.ui.projectTab,preview:state.previewRecord,reader:ReadingPane.snapshot(),back:{text:document.querySelector('#readingBack')?.textContent,disabled:document.querySelector('#readingBack')?.disabled},leave:!!document.querySelector('.note-document-leave:not([hidden])'),draft:NoteEditor.currentContent()})`); }
async function check(label, fn) {
  try { await fn(); checks.push(label); console.log('PASS', label); }
  catch (error) { failures.push({ label, error: error.stack }); console.error('FAIL', label, error.message); await shot('failure-' + failures.length); try { observations.push({ label, state: await inspect() }); } catch (_) {} }
}
async function click(selector) {
  const point = await evaluate(`(()=>{const n=document.querySelector(${quote(selector)});if(!n)throw Error('Missing '+${quote(selector)});n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);if(n.disabled||!r.width||!r.height||!(n===hit||n.contains(hit)))throw Error('Disabled or covered '+${quote(selector)});return {x,y};})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await wait(50);
}
async function settle() {
  await evaluate('saveDocumentDurably()'); await evaluate('flushWorkspace()');
  await until(() => evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'), 'durable workspace settled');
}
const readAPI = pathname => evaluate(`(async()=>{const r=await fetch(${quote(pathname)},{cache:'no-store'});if(!r.ok)throw Error('Read '+r.status);return r.json();})()`);
async function route(projectId, section) {
  assert.equal(await evaluate(`openProject(${quote(projectId)},{section:${quote(section)}})`), true);
  await until(() => evaluate(`document.body.dataset.view==='project'&&state.currentProjectId===${quote(projectId)}&&state.ui.projectTab===${quote(section)}&&!ReadingPane.snapshot().visible`), 'route ' + projectId + '/' + section);
}
async function noteReady(id) {
  await until(() => evaluate(`state.previewRecord?.type==='note'&&state.previewRecord.id===${quote(id)}&&ReadingPane.snapshot().visible&&NoteEditor.inlineActive(${quote(id)})&&!!document.querySelector('.document-toolbar-kit [role=radio]:not([disabled])')`), 'note ' + id);
}
async function selectTab(kind, id) {
  const key = tabKey(kind, id);
  await evaluate(`(()=>{const n=[...document.querySelectorAll('#readingTabs [role=tab]')].find(n=>n.dataset.readingKey===${quote(key)});if(!n)throw Error('Missing retained tab');n.click();})()`);
  if (kind === 'note') await noteReady(id); else await until(() => evaluate(`ReadingPane.snapshot().visible&&state.previewRecord?.id===${quote(id)}`), 'import tab');
}
const getOrigin = (kind, id) => evaluate(`ReadingPane.snapshot().tabs.find(t=>t.kind===${quote(kind)}&&t.id===${quote(id)})?.origin`);
async function openKnowledge(projectId, id) {
  await route(projectId, 'knowledge');
  await click(`#projectCollection [data-cui-id="${id}"] [data-cui-open]`); await noteReady(id);
}
async function mode(label) {
  await until(() => evaluate(`[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].some(n=>n.textContent.trim()===${quote(label)}&&!n.disabled)`), 'mode enabled');
  await evaluate(`(()=>{const n=[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].find(n=>n.textContent.trim()===${quote(label)});n.click();})()`);
  await until(() => evaluate(label === '源码' ? '!!document.querySelector("#previewContent .cm-content[contenteditable=true]")' : '!!document.querySelector(".note-document-preview [data-document-markdown]")'), 'mode ' + label);
}
const watchdog = setTimeout(() => { failures.push({ label: 'watchdog' }); void finish(1); }, 240000);
async function finish(code) {
  if (ending) return; ending = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(2500)]); }
  const stopped = !server || server.exitCode !== null || server.signalCode !== null;
  if (!stopped) { failures.push({ label: 'fixture server did not stop' }); code = 1; }
  if (stopped) fs.rmSync(TEMP, { recursive: true, force: true });
  if (!code && !failures.length) for (const name of fs.readdirSync(OUT)) if (/^(?:failure-.*|fatal)\.png$/.test(name)) fs.rmSync(path.join(OUT,name));
  const sourceHashes = Object.fromEntries(['app/document-origin.js','app/reading-pane.js','app/app.js','app/note-editor.js','native/Resources/workspace.css','tests/fixtures/document-origin.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, observations, rendererErrors, externalRequests, modelRequests, modelCalls: modelRequests.length,
    userWorkspaceLoaded: false, temporaryProfileRemoved: !fs.existsSync(TEMP), fixtureServerStopped: stopped, sourceHashes,
    scope: 'Actual root app + real temporary server/draft store + real Halaska controls; native CSS in isolated Chromium. Fresh renderer recreation uses persisted state and no fixture replay. Separate native WKWebView gate.' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failures, report: path.join(OUT, 'report.json') }, null, 2)); app.exit(code);
}
async function createRenderer() {
  win = new BrowserWindow({ show: false, width: 1440, height: 980, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') { rendererErrors.push(event.message); console.error('RENDERER', event.message); } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
    const local = request.url.startsWith(origin + '/');
    const model = local && /^\/(?:__proxy|__api|__llm|__models|__codex\/respond)(?:[/?]|$)/.test(new URL(request.url).pathname);
    if (!local) externalRequests.push(request.url); if (model) modelRequests.push(request.url); done({ cancel: !local || model });
  });
  await win.loadURL('about:blank'); win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `window.webkit={messageHandlers:{workspace:{postMessage(){}}}};window.addEventListener('DOMContentLoaded',()=>{document.body.classList.add('aibro-native');const s=document.createElement('style');s.textContent=${quote(fs.readFileSync(path.join(ROOT,'native/Resources/workspace.css'),'utf8'))};document.head.append(s);window.__originLeavePrompts=[];new MutationObserver(()=>{for(const n of document.querySelectorAll('.note-document-leave:not([hidden])'))if(!n.dataset.originObserved){n.dataset.originObserved='true';__originLeavePrompts.push(n.textContent)}}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});});` });
  await win.loadURL(origin); await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'hydrate');
}
(async () => {
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(OUT, 'server.log'), 'w');
  server = spawn(process.env.PYTHON || 'python3', ['-B', path.join(ROOT,'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', log, log] }); fs.closeSync(log);
  await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'fixture server');
  await app.whenReady(); await createRenderer(); await evaluate(fs.readFileSync(FIXTURE, 'utf8'));
  await until(() => evaluate('window.__documentOriginFixtureReady'), 'fixture'); await settle();

  await check('project output opens from a real output card with a real Halaska return action', async () => {
    await route('origin-alpha', 'outputs'); await click('[aria-label="打开 甲项目成果"]'); await noteReady('origin-output');
    assert.deepEqual(await getOrigin('note','origin-output'), { view: 'project', projectId: 'origin-alpha', section: 'outputs' });
    assert.equal(await evaluate('!!document.querySelector(".reading-origin-action[data-halaska-root=Button] #readingBack")'), true);
    assert.match(await evaluate('document.querySelector("#readingBack").textContent'), /返回成果/);
    assert.match(await evaluate('document.querySelector(".reading-caption").textContent'), /甲 · 从项目成果/);
    await wait(250);
    assert.match(await evaluate(`document.querySelector('#readingBack').getAttribute('aria-label')`), /返回成果：.*甲.*成果/,
      'legacy interaction refresh must not overwrite the per-document accessible return destination');
    await shot('output-origin-light');
  });
  await check('switching to project B and reopening the retained tab returns to project A outputs', async () => {
    await route('origin-beta', 'tasks'); await selectTab('note', 'origin-output');
    assert.deepEqual(await getOrigin('note','origin-output'), { view: 'project', projectId: 'origin-alpha', section: 'outputs' });
    await click('#readingBack'); await until(() => evaluate('document.body.dataset.view==="project"&&state.currentProjectId==="origin-alpha"&&state.ui.projectTab==="outputs"&&!ReadingPane.snapshot().visible'), 'back A outputs');
    assert.ok((await evaluate('ReadingPane.snapshot().tabs')).some(t => t.id === 'origin-output'));
  });
  await check('two retained document tabs keep independent project origins and the knowledge section', async () => {
    await openKnowledge('origin-beta', 'origin-beta-note');
    assert.deepEqual(await getOrigin('note','origin-beta-note'), { view: 'project', projectId: 'origin-beta', section: 'knowledge' });
    await selectTab('note','origin-output'); await click('#readingBack');
    await until(() => evaluate('state.currentProjectId==="origin-alpha"&&state.ui.projectTab==="outputs"&&!ReadingPane.snapshot().visible'), 'first origin');
    await selectTab('note','origin-beta-note'); await click('#readingBack');
    await until(() => evaluate('state.currentProjectId==="origin-beta"&&state.ui.projectTab==="knowledge"&&!ReadingPane.snapshot().visible'), 'second origin');
    await openKnowledge('origin-alpha','origin-knowledge'); await click('#readingBack');
    await until(() => evaluate('state.currentProjectId==="origin-alpha"&&state.ui.projectTab==="knowledge"&&!ReadingPane.snapshot().visible'), 'A knowledge preserved');
  });
  await check('attachment origin retains exact message and returns focus to that message after a different conversation', async () => {
    assert.equal(await evaluate('navigateWorkspaceConversation("origin-chat-a")'), true);
    await evaluate('ConversationWindow.active(document.querySelector("#messageList"))?.ensure("origin-message-first")');
    await click('[data-message-id="origin-message-first"] [data-open-import="origin-attachment"]');
    await until(() => evaluate('state.previewRecord?.id==="origin-attachment"&&ReadingPane.snapshot().visible'), 'attachment');
    assert.deepEqual(await getOrigin('import','origin-attachment'), { view: 'agent', conversationId: 'origin-chat-a', messageId: 'origin-message-first' });
    assert.equal(await evaluate('navigateWorkspaceConversation("origin-chat-b")'), true);
    await selectTab('import','origin-attachment'); await click('#readingBack');
    await until(() => evaluate('state.currentConversationId==="origin-chat-a"&&document.activeElement?.dataset.messageId==="origin-message-first"&&!ReadingPane.snapshot().visible'), 'exact message focus');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await wait(300);
    const rect = await evaluate('(()=>{const n=document.querySelector("[data-message-id=origin-message-first]"),r=n.getBoundingClientRect(),list=document.querySelector("#messageList"),lr=list.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,focused:document.activeElement?.dataset.messageId,list:{top:lr.top,bottom:lr.bottom,scrollTop:list.scrollTop,height:list.clientHeight,scrollHeight:list.scrollHeight}};})()');
    observations.push({ returnedMessage: rect });
    assert.ok(rect.top >= rect.list.top-1 && rect.top < rect.list.bottom, JSON.stringify(rect)); assert.ok(rect.bottom > rect.list.top);
    await shot('returned-exact-message');
  });
  await check('document body links form a back trail without overwriting the original document origin or creating a cycle', async () => {
    await openKnowledge('origin-alpha','origin-trail-a'); await mode('阅读');
    await click('.note-document-preview [data-open-note="origin-trail-b"]'); await noteReady('origin-trail-b'); await mode('阅读');
    assert.deepEqual(await getOrigin('note','origin-trail-b'), { view: 'document', kind: 'note', id: 'origin-trail-a' });
    await click('.note-document-preview [data-open-note="origin-trail-a"]'); await noteReady('origin-trail-a');
    assert.deepEqual(await getOrigin('note','origin-trail-a'), { view: 'project', projectId: 'origin-alpha', section: 'knowledge' });
    await selectTab('note','origin-trail-b'); await mode('阅读');
    await click('.note-document-preview [data-open-note="origin-trail-c"]'); await noteReady('origin-trail-c');
    assert.deepEqual(await getOrigin('note','origin-trail-c'), { view: 'document', kind: 'note', id: 'origin-trail-b' });
    await click('#readingBack'); await noteReady('origin-trail-b'); await click('#readingBack'); await noteReady('origin-trail-a');
    await click('#readingBack'); await until(() => evaluate('state.currentProjectId==="origin-alpha"&&state.ui.projectTab==="knowledge"&&!ReadingPane.snapshot().visible'), 'trail root');
  });
  await check('task-related document retains task origin and returns to that task without altering it', async () => {
    await evaluate('openTask("origin-task")'); await until(() => evaluate('document.querySelector("#taskDialog").open'), 'task dialog');
    await click('#taskDialog [data-open-note="origin-knowledge"]'); await noteReady('origin-knowledge');
    assert.deepEqual(await getOrigin('note','origin-knowledge'), { view: 'task', id: 'origin-task', entry: { view: 'project', projectId: 'origin-alpha', section: 'knowledge' } });
    await click('#readingBack'); await until(() => evaluate('document.querySelector("#taskDialog").open&&state.openTaskId==="origin-task"&&!ReadingPane.snapshot().visible'), 'return task');
    assert.equal(await evaluate('document.querySelector("#taskTitleInput").value'), '核对文档入口');
    await click('#taskDialog button.secondary[value="cancel"]');
  });
  await check('two task forms retain separate unpublished fields, criteria and planning destinations across document tabs', async () => {
    await evaluate(`state.tasks.push({id:'origin-task-beta',title:'乙任务原名',description:'乙任务原详情',projectId:'origin-beta',workspace:'课程',status:'todo',priority:'medium',checklist:[],sourceNoteIds:['origin-beta-note']});save();`);
    await route('origin-alpha', 'tasks'); await evaluate('openTask("origin-task")');
    await evaluate(`document.querySelector('#taskTitleInput').value='甲任务未保存标题';document.querySelector('#taskDescriptionInput').value='甲任务未保存详情';document.querySelector('#taskDeliverableKind').value='text';document.querySelector('#taskDeliverableKind').dispatchEvent(new Event('change'));document.querySelector('#taskDeliverableRef').value='甲任务未保存验收词';document.querySelector('#taskProjectInput').value='origin-beta';document.querySelector('#taskProjectInput').dispatchEvent(new Event('change'));document.querySelector('#taskStartInput').value='2026-10-03';`);
    await click('#taskDialog [data-open-note="origin-knowledge"]'); await noteReady('origin-knowledge');
    assert.deepEqual(await getOrigin('note','origin-knowledge'), { view:'task', id:'origin-task', entry:{view:'project',projectId:'origin-alpha',section:'tasks'} });
    await route('origin-beta','tasks'); await evaluate('openTask("origin-task-beta")');
    await evaluate(`document.querySelector('#taskTitleInput').value='乙任务未保存标题';document.querySelector('#taskDeliverableKind').value='text';document.querySelector('#taskDeliverableKind').dispatchEvent(new Event('change'));document.querySelector('#taskDeliverableRef').value='乙任务未保存验收词';`);
    await click('#taskDialog [data-open-note="origin-beta-note"]'); await noteReady('origin-beta-note');
    await selectTab('note','origin-knowledge'); await click('#readingBack');
    await until(()=>evaluate('document.querySelector("#taskDialog").open&&state.openTaskId==="origin-task"'),'return task A draft');
    assert.deepEqual(await evaluate(`({title:document.querySelector('#taskTitleInput').value,description:document.querySelector('#taskDescriptionInput').value,kind:document.querySelector('#taskDeliverableKind').value,criterion:document.querySelector('#taskDeliverableRef').value,project:document.querySelector('#taskProjectInput').value,space:document.querySelector('#taskWorkspaceInput').value,start:document.querySelector('#taskStartInput').value,entryProject:state.currentProjectId,section:state.ui.projectTab})`),
      {title:'甲任务未保存标题',description:'甲任务未保存详情',kind:'text',criterion:'甲任务未保存验收词',project:'origin-beta',space:'课程',start:'2026-10-03',entryProject:'origin-alpha',section:'tasks'});
    assert.equal(await evaluate('state.tasks.find(t=>t.id==="origin-task").title'),'核对文档入口');
    await shot('task-return-retained-fields');
    await click('#taskDialog [data-open-note="origin-knowledge"]'); await noteReady('origin-knowledge');
    await selectTab('note','origin-beta-note'); await click('#readingBack');
    await until(()=>evaluate('document.querySelector("#taskDialog").open&&state.openTaskId==="origin-task-beta"'),'return task B draft');
    assert.equal(await evaluate('document.querySelector("#taskTitleInput").value'),'乙任务未保存标题');
    assert.equal(await evaluate('document.querySelector("#taskDeliverableRef").value'),'乙任务未保存验收词');
    assert.equal(await evaluate('state.currentProjectId'),'origin-beta');
    await click('#taskDialog button.secondary[value="cancel"]');
    await selectTab('note','origin-knowledge'); await click('#readingBack'); await until(()=>evaluate('document.querySelector("#taskDialog").open'),'return task A for cancel');
    await click('#taskDialog button.secondary[value="cancel"]');
    await settle(); const stored=await readAPI('/__state');
    assert.equal(stored.tasks.find(t=>t.id==='origin-task').title,'核对文档入口');
    assert.equal(stored.tasks.find(t=>t.id==='origin-task-beta').title,'乙任务原名');
    assert.doesNotMatch(JSON.stringify(stored.ui),/甲任务未保存|乙任务未保存/);
  });
  await check('explicit task cancel discards its suspended fields when returning through the retained document again', async () => {
    await selectTab('note','origin-knowledge'); await click('#readingBack'); await until(()=>evaluate('document.querySelector("#taskDialog").open'),'cancelled A return');
    assert.equal(await evaluate('document.querySelector("#taskTitleInput").value'),'核对文档入口');
    assert.equal(await evaluate('document.querySelector("#taskDeliverableKind").value'),'');
    assert.equal(await evaluate('document.querySelector("#taskProjectInput").value'),'origin-alpha');
    await click('#taskDialog button.secondary[value="cancel"]');
    await selectTab('note','origin-beta-note'); await click('#readingBack'); await until(()=>evaluate('document.querySelector("#taskDialog").open'),'cancelled B return');
    assert.equal(await evaluate('document.querySelector("#taskTitleInput").value'),'乙任务原名');
    await click('#taskDialog button.secondary[value="cancel"]');
  });
  await check('revoked task parent entry keeps the live document and unpublished task form without jumping elsewhere', async () => {
    await route('origin-beta','tasks'); await evaluate('openTask("origin-task")');
    await evaluate(`document.querySelector('#taskTitleInput').value='入口撤销时保留的甲任务草稿'`);
    await click('#taskDialog [data-open-note="origin-knowledge"]'); await noteReady('origin-knowledge');
    await evaluate(`state.projects.find(p=>p.id==='origin-beta').archived=true;ReadingPane.refreshTabs()`);
    await until(()=>evaluate('document.querySelector("#readingBack").disabled'),'revoked task entry disabled');
    assert.equal(await evaluate('ReadingPane.returnToOrigin()'),false);
    assert.equal(await evaluate('ReadingPane.snapshot().visible'),true);
    assert.equal(await evaluate('document.querySelector("#taskDialog").open'),false);
    assert.equal(await evaluate('taskEditorContexts.get("origin-task").draft.fields.taskTitleInput'),'入口撤销时保留的甲任务草稿');
    await evaluate(`state.projects.find(p=>p.id==='origin-beta').archived=false;ReadingPane.refreshTabs()`);
    await click('#readingBack'); await until(()=>evaluate('document.querySelector("#taskDialog").open'),'restored entry permits retained task');
    assert.equal(await evaluate('document.querySelector("#taskTitleInput").value'),'入口撤销时保留的甲任务草稿');
    await click('#taskDialog button.secondary[value="cancel"]');
  });
  await check('returning from an edited document durably parks its draft without Save/Discard or changing the formal note', async () => {
    await selectTab('note','origin-output'); await mode('源码');
    await evaluate('document.querySelector("#previewContent .cm-content").focus()'); win.webContents.focus(); await wait(50);
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers }); await wait(30);
    await win.webContents.insertText(draftOutput);
    await until(() => evaluate(`NoteEditor.currentContent()?.content===${quote(draftOutput)}`), 'typed source draft');
    await click('#readingBack');
    await until(() => evaluate('state.currentProjectId==="origin-alpha"&&state.ui.projectTab==="outputs"&&!ReadingPane.snapshot().visible'), 'draft return');
    assert.deepEqual(await evaluate('__originLeavePrompts'), []);
    assert.equal(await evaluate('state.notes.find(n=>n.id==="origin-output").content'), originalOutput);
    assert.equal((await readAPI('/__state')).notes.find(n => n.id === 'origin-output').content, originalOutput);
    assert.equal((await readAPI('/__note-draft?id=origin-output')).session.content, draftOutput);
    await selectTab('note','origin-output');
    assert.equal(await evaluate('NoteEditor.currentContent().content'), draftOutput);
    assert.equal(await evaluate('NoteEditor.currentContent().dirty'), true);
    assert.ok(['edit','rich'].includes(await evaluate('document.querySelector(".note-document").dataset.mode')));
    await shot('reopened-draft');
  });
  await check('a fresh renderer restores tab origins and acknowledged draft from disk without replaying fixture setup', async () => {
    await click('#readingBack'); await until(() => evaluate('!ReadingPane.snapshot().visible'), 'park before restart'); await settle();
    const expected = await evaluate('ReadingPane.snapshot().tabs.map(({kind,id,origin})=>({kind,id,origin}))');
    win.webContents.debugger.detach(); win.destroy(); await createRenderer();
    assert.equal(await evaluate('typeof __documentOriginFixtureReady'), 'undefined');
    await until(() => evaluate('ReadingPane.snapshot().tabs.length>=2'), 'restored tabs');
    assert.deepEqual(await evaluate('ReadingPane.snapshot().tabs.map(({kind,id,origin})=>({kind,id,origin}))'), expected);
    await selectTab('note','origin-output');
    await until(() => evaluate(`NoteEditor.currentContent()?.content===${quote(draftOutput)}`), 'restored real draft');
    assert.equal(await evaluate('state.notes.find(n=>n.id==="origin-output").content'), originalOutput);
    await click('#readingBack'); await until(() => evaluate('state.currentProjectId==="origin-alpha"&&state.ui.projectTab==="outputs"&&!ReadingPane.snapshot().visible'), 'restored origin return');
    assert.deepEqual(await evaluate('__originLeavePrompts'), []);
  });
  await check('deleted or private original route disables only Return while independent document and Collapse remain available', async () => {
    for (const unavailable of ['missing','private']) {
      await evaluate('state.notes.find(n=>n.id==="origin-portable").projectId="origin-alpha";state.notes.find(n=>n.id==="origin-portable").workspace="科研"');
      await openKnowledge('origin-alpha','origin-portable');
      await evaluate(`window.__originProjectCopy={...state.projects.find(p=>p.id==='origin-alpha')};state.notes.find(n=>n.id==='origin-portable').projectId='origin-beta';state.notes.find(n=>n.id==='origin-portable').workspace='课程';${unavailable === 'missing' ? "state.projects=state.projects.filter(p=>p.id!=='origin-alpha');" : "state.projects.find(p=>p.id==='origin-alpha').private=true;"}ReadingPane.reconcile();`);
      await until(() => evaluate('document.querySelector("#readingBack")?.disabled'), unavailable + ' disabled');
      assert.equal(await evaluate('ReadingPane.snapshot().visible'), true);
      assert.match(await evaluate('document.querySelector(".reading-caption").textContent'), /原入口不可用/);
      assert.doesNotMatch(await evaluate('document.querySelector("#readingBack").getAttribute("aria-label")'), /甲 · 从项目成果/);
      await click('#readingCollapse'); await until(() => evaluate('!ReadingPane.snapshot().visible'), 'collapse ' + unavailable);
      assert.ok((await evaluate('ReadingPane.snapshot().tabs')).some(tab => tab.id === 'origin-portable'));
      await evaluate(`state.projects=state.projects.filter(p=>p.id!=='origin-alpha');state.projects.push(window.__originProjectCopy);delete state.projects.find(p=>p.id==='origin-alpha').private;ReadingPane.reconcile();renderAll()`);
    }
  });
  await check('440px light and dark reader fits Return, caption and Collapse without horizontal overflow', async () => {
    await openKnowledge('origin-alpha','origin-trail-a');
    win.setContentSize(440,900); await wait(100);
    for (const theme of ['light','dark']) {
      await evaluate(`state.ui.theme=${quote(theme)};applyUiPreferences();ReadingPane.setExpanded(true)`); await wait(100);
      const layout = await evaluate(`(()=>{const pane=document.querySelector('#readingPane'),bar=pane.querySelector('.reading-toolbar'),back=document.querySelector('#readingBack'),collapse=document.querySelector('#readingCollapse'),article=pane.querySelector('[data-document-markdown]');return {width:innerWidth,body:document.documentElement.scrollWidth,pane:{left:pane.getBoundingClientRect().left,right:pane.getBoundingClientRect().right,width:pane.clientWidth,scroll:pane.scrollWidth},bar:{width:bar.clientWidth,scroll:bar.scrollWidth},controls:[back,collapse].map(n=>({left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width,disabled:n.disabled})),article:article&&{width:article.clientWidth,scroll:article.scrollWidth},kit:!!back.closest('[data-halaska-root=Button]')};})()`);
      observations.push({ theme, layout }); assert.equal(layout.width,440); assert.ok(layout.body<=442); assert.ok(layout.pane.left>=-1&&layout.pane.right<=441);
      assert.ok(layout.pane.scroll<=layout.pane.width+2); assert.ok(layout.bar.scroll<=layout.bar.width+2);
      for(const control of layout.controls) assert.ok(control.width>20&&control.left>=-1&&control.right<=441&&!control.disabled);
      assert.ok(!layout.article||layout.article.scroll<=layout.article.width+2); assert.equal(layout.kit,true);
      await shot('origin-440-'+theme);
    }
  });
  assert.deepEqual(modelRequests,[]); assert.deepEqual(externalRequests,[]);
  await finish(failures.length||rendererErrors.length?1:0);
})().catch(async error => { failures.push({label:'fatal',error:error.stack});console.error(error);await shot('fatal');await finish(1); });
