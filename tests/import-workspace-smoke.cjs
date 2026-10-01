/* Whole production import controller and pipeline; temporary server/store/profile only.
 * Only explicit network faults, one captured webpage response and an acknowledgement delay are injected. Successful
 * text parsing, original-byte upload and metadata persistence use the real backend. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/import-workspace-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-import-workspace-'));
const STORE = path.join(TEMP, 'store'), HOME_FIXTURE = path.join(TEMP, 'home');
for (const directory of [OUT, STORE, HOME_FIXTURE]) fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
app.on('window-all-closed', () => {});
const tracked = ['app/app.js', 'app/import-workspace.js', 'app/import-workspace.css', 'app/ui/import-surfaces.jsx', 'app/halaska-ui.js', 'app/i18n-en.js', 'app/reading-pane.css', 'native/Resources/workspace.css'];
const nativeWorkspaceCSS = fs.readFileSync(path.join(ROOT, 'native/Resources/workspace.css'), 'utf8');
const hashes = () => Object.fromEntries(tracked.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
const startedHashes = hashes();
const checks = [], failures = [], rendererErrors = [], remoteRequests = [], blockedRequests = [], requests = [], screenshots = [], layout = [], evidence = [];
let server, win, origin, fatalError, cleaned = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await fn()) return; await wait(50); } throw Error('Timed out: ' + label); }
const request = route => new Promise((resolve, reject) => http.get(origin + route, response => { const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) })); }).on('error', reject));
async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); } }
async function cleanup() {
  if (cleaned) return; cleaned = true;
  if (win && !win.isDestroyed()) win.destroy();
  if (server && server.exitCode == null) { const ended = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await Promise.race([ended, wait(2500)]); if (server.exitCode == null) { server.kill('SIGKILL'); await ended; } }
  if (fs.existsSync(path.join(TEMP, 'server.log'))) fs.copyFileSync(path.join(TEMP, 'server.log'), path.join(OUT, 'server.log'));
  fs.rmSync(TEMP, { recursive: true, force: true });
}
const watchdog = setTimeout(async () => { fatalError = 'Import workspace renderer timeout'; await finish(); }, 180000);
async function finish() {
  clearTimeout(watchdog); await cleanup();
  const finishedHashes = hashes(), sourceHashesStable = JSON.stringify(startedHashes) === JSON.stringify(finishedHashes);
  if (!sourceHashesStable) failures.push({ name: 'source unchanged during acceptance', error: 'Production source hashes changed during this run.' });
  const report = { passed: checks.length, checks, failures, rendererErrors, remoteRequests, blockedRequests, realModelCalls: 0,
    requests: requests.filter(row => !/\.(?:js|css|woff2|svg|ico|png)$/.test(row.path)), screenshots, layout, evidence,
    startedHashes, finishedHashes, sourceHashesStable, fatalError, fixtureRemoved: !fs.existsSync(TEMP),
    scope: 'Production ImportSurface, ImportWorkspace and importMaterials with real local text parser, file storage and metadata backend. Only URL/upload/save failures, one synthetic captured webpage response and a delayed acknowledgement are injected. Isolated store/profile/HOME/CODEX_HOME. Native picker and WK accessibility require separate native acceptance.' };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failures: failures.length, rendererErrors, remoteRequests, blockedRequests, sourceHashesStable, fixtureRemoved: report.fixtureRemoved, fatalError }));
  app.exit(fatalError || failures.length || rendererErrors.length || remoteRequests.length || blockedRequests.length ? 1 : 0);
}
(async () => {
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(TEMP, 'server.log'), 'a');
  server = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, HOME: HOME_FIXTURE, CODEX_HOME: path.join(HOME_FIXTURE, '.codex'), AI_WORKSTATION_DATA_DIR: STORE, AI_WORKSTATION_ASSET_DIR: path.join(ROOT, 'app'), AI_WORKSTATION_PORT: String(port) }, stdio: ['ignore', log, log] }); fs.closeSync(log);
  await until(async () => { if (server.exitCode != null) throw Error('Isolated service exited'); try { return (await request('/__health')).status === 200; } catch (_) { return false; } }, 'isolated server');
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 1180, height: 960, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (row, callback) => {
    const url = new URL(row.url), remote = url.origin !== origin, blocked = /^\/__(?:proxy|codex\/respond|cloud\/(?:connect|sync|disconnect)|ssh\/(?:connect|probe))/.test(url.pathname);
    if (remote) remoteRequests.push(url.origin); else requests.push({ method: row.method, path: url.pathname });
    if (blocked) blockedRequests.push(url.pathname); callback({ cancel: remote || blocked });
  });
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const key = async keyCode => { win.webContents.focus(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await wait(50); };
  const click = selector => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Missing or disabled '+${JSON.stringify(selector)});n.click()})()`);
  const pointerClick = async selector => {
    const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Missing or disabled control');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);if(!(n===hit||n.contains(hit)))throw Error('Control covered');return{x,y}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(50);
  };
  const snapshot = async name => { await until(() => evaluate(`!document.querySelector('#toast')?.classList.contains('visible')`), 'toast settled before evidence'); assert.equal(await evaluate(`!!WorkstationOnboarding.isOpen()||!!WorkspaceTour.isOpen()`), false, 'Evidence must not be covered by a first-run guide'); await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await wait(80); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); screenshots.push(name + '.png'); };
  const idle = async () => { await until(() => evaluate('!importMaterials.busy'), 'import completed'); await wait(80); };
  const durable = async () => { await evaluate('saveDocumentDurably()'); await until(() => evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave'), 'real metadata settled'); };
  const setFiles = files => evaluate(`(()=>{const d=new DataTransfer();for(const f of ${JSON.stringify(files)})d.items.add(new File([f.content],f.name,{type:f.type||'text/plain'}));document.querySelector('#fileInput').files=d.files;document.querySelector('#fileInput').dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const editUrl = value => evaluate(`(()=>{const n=document.querySelector('#urlInput');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const setTarget = value => evaluate(`(()=>{const n=document.querySelector('#importTarget');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const fresh = async route => {
    await evaluate(`(async()=>{document.querySelector('#importDialog').close();document.querySelector('#fileInput').value='';document.querySelector('#urlInput').value='';ImportWorkspace.selectionChanged();await (${route});openImportDialog();})()`);
    await until(() => evaluate(`document.querySelector('#importDialog').open&&!!document.querySelector('#importTarget')`), 'real import modal');
  };
  const submit = () => pointerClick('#importDialog .import-footer button:last-child');
  const records = name => evaluate(`state.imports.filter(item=>item.name===${JSON.stringify(name)})`);
  const assertRetained = async label => {
    assert.equal(await evaluate(`Object.entries(importRefs).every(([id,node])=>document.getElementById(id)===node&&document.querySelectorAll('#'+CSS.escape(id)).length===1)`), true, label);
    assert.equal(await evaluate(`document.querySelector('#nativePickFiles').onclick===importPickerHandler`), true, label);
  };
  await win.loadURL(origin); await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated&&!!window.ImportWorkspace&&!!document.querySelector('[data-halaska-root="ImportSurface"]')`), 'production import Kit hydration');
  await evaluate(`(async()=>{WorkstationOnboarding.close('skipped');await WorkspaceTour.open();WorkspaceTour.close('skipped');})()`);
  const now = Date.now();
  const fixture = { projects: [{ id: 'import-project', name: '资料导入的目标课程项目', workspace: '课程', createdAt: now }, { id: 'import-other-project', name: '不可误挂的科研项目', workspace: '科研', createdAt: now }], conversations: [{ id: 'import-chat-a', title: '保留原草稿的对话 A', workspace: '课程', projectId: 'import-project', attachments: [], draftAttachmentIds: [], messages: [], draft: '原对话未发送草稿', createdAt: now }, { id: 'import-chat-b', title: '不可误挂的对话 B', workspace: '科研', projectId: 'import-other-project', attachments: [], draftAttachmentIds: [], messages: [], draft: '另一个未发送草稿', createdAt: now }], imports: [], attachments: [], currentConversationId: 'import-chat-a' };
  await evaluate(`WorkstationOnboarding.close('skipped');WorkspaceTour.close('skipped');Object.assign(state,${JSON.stringify(fixture)});normalizeStateShape(state);state.ui.theme='light';state.ui.inspectorOpen=false;applyUiPreferences();renderAll();showView('dashboard','总览');window.importRefs=Object.fromEntries(['importForm','fileInput','urlInput','startImport','nativePickFiles','importProgress','selectedFileSummary'].map(id=>[id,document.getElementById(id)]));window.importPickerHandler=document.querySelector('#nativePickFiles').onclick;void 0;`);
  await durable();
  await evaluate(`window.importRealFetch=window.fetch.bind(window);window.importFault={stateMode:'normal',matchName:'',held:false,release:null,failUploadName:'',calls:[]};window.fetch=async(url,options={})=>{const route=String(url),method=options.method||'GET';if(route==='/__fetch'){const requested=JSON.parse(options.body).url;if(importFault.urlContent&&requested==='https://fixture.invalid/article'){importFault.calls.push({kind:'webpage-fixture',url:requested});return new Response(JSON.stringify({name:'fixture-article.html',content:'# Captured webpage\\n\\nSaved webpage text remains readable without an uploaded local file.',mimeType:'text/html',parser:'synthetic-web-extract',finalUrl:requested}),{status:200,headers:{'content-type':'application/json'}})}importFault.calls.push({kind:'url-fault',url:requested});return new Response(JSON.stringify({error:'Fixture webpage unavailable'}),{status:502,headers:{'content-type':'application/json'}})}if(route.startsWith('/__files/')&&method==='POST'){const name=decodeURIComponent(options.headers?.['X-Filename']||'');importFault.calls.push({kind:'upload',id:decodeURIComponent(route.split('/').pop()),name});if(name===importFault.failUploadName)return new Response(JSON.stringify({error:'Fixture disk rejected this file'}),{status:507,headers:{'content-type':'application/json'}})}if(route==='/__state'&&method==='POST'&&importFault.matchName){let body;try{body=JSON.parse(options.body)}catch{}if(body?.imports?.some(item=>item.name===importFault.matchName)){if(importFault.stateMode==='fail'){importFault.calls.push({kind:'save-fault'});return new Response(JSON.stringify({error:'Fixture metadata storage unavailable'}),{status:503,headers:{'content-type':'application/json'}})}if(importFault.stateMode==='hold'&&!importFault.held){const response=await importRealFetch(url,options);importFault.held=true;await new Promise(resolve=>importFault.release=resolve);return response}}}return importRealFetch(url,options)};void 0;`);
  await check('overview defaults to a library and waits for the actual metadata acknowledgement after real text parsing/upload', async () => {
    await fresh(`showView('dashboard','总览')`);
    assert.equal(await evaluate(`document.querySelector('#importTarget').value`), 'workspace:日常');
    assert.equal(await evaluate(`document.querySelector('#importTarget')===document.activeElement`), true);
    const before = await evaluate(`JSON.stringify({conversations:state.conversations,attachments:state.attachments,current:state.currentConversationId})`);
    const file = { name: 'overview-library.txt', content: '真实文本解析与原件存储。\nThis source must stay in the daily library.' };
    await setFiles([file]); await evaluate(`importFault.stateMode='hold';importFault.matchName='overview-library.txt';void 0;`); await submit();
    await until(() => evaluate('importFault.held&&typeof importFault.release===\'function\''), 'held real metadata acknowledgement');
    assert.equal(await evaluate('!!importMaterials.busy'), true);
    assert.equal(await evaluate(`document.querySelectorAll('[data-import-status="saved"]').length`), 0);
    assert.equal(await evaluate(`document.querySelector('#fileInput').files.length`), 1);
    const item = (await records(file.name))[0]; assert.ok(item.id); assert.equal(item.fileStored, true); assert.equal(item.importOrigin, 'workspace'); assert.equal(item.workspace, '日常'); assert.equal(item.projectId, undefined); assert.match(item.content, /真实文本解析/);
    assert.deepEqual((await request('/__files/' + item.id)).body, Buffer.from(file.content));
    await snapshot('durable-ack-wait'); await evaluate(`importFault.stateMode='normal';importFault.release();void 0;`); await idle();
    assert.equal(await evaluate(`JSON.stringify({conversations:state.conversations,attachments:state.attachments,current:state.currentConversationId})`), before);
    assert.equal(await evaluate(`document.querySelectorAll('[data-import-status="saved"]').length`), 1);
    assert.equal(await evaluate(`document.querySelector('#importDialog').open`), true);
    assert.equal(await evaluate(`document.querySelector('#fileInput').files.length`), 0);
    evidence.push({ name: file.name, id: item.id, originalBytesVerified: true, parser: item.parser, workspace: item.workspace }); await assertRetained('overview successful import');
  });
  await check('chat destination is explicit at open and cannot follow another conversation selected before submission', async () => {
    await fresh(`openConversation('import-chat-a')`);
    assert.equal(await evaluate(`document.querySelector('#importTarget').value`), 'conversation:import-chat-a');
    await evaluate(`openConversation('import-chat-b');void 0;`);
    assert.equal(await evaluate(`document.querySelector('#importTarget').value`), 'conversation:import-chat-a');
    await setFiles([{ name: 'captured-chat-target.txt', content: 'Must belong only to chat A.' }]); await submit(); await idle();
    const item = (await records('captured-chat-target.txt'))[0]; assert.equal(item.projectId, 'import-project');
    assert.equal(await evaluate(`state.conversations.find(c=>c.id==='import-chat-a').draftAttachmentIds.includes(${JSON.stringify(item.id)})`), true);
    assert.equal(await evaluate(`state.conversations.find(c=>c.id==='import-chat-b').attachments.includes(${JSON.stringify(item.id)})`), false);
    assert.equal(await evaluate(`state.currentConversationId`), 'import-chat-b');
    assert.equal(await evaluate(`state.conversations.find(c=>c.id==='import-chat-b').draft`), '另一个未发送草稿'); await assertRetained('captured chat');
  });
  await check('project defaults and explicit space selection persist only the chosen ownership without changing conversations', async () => {
    await fresh(`openProject('import-project')`);
    assert.equal(await evaluate(`document.querySelector('#importTarget').value`), 'project:import-project');
    const before = await evaluate(`JSON.stringify(state.conversations)`);
    await setFiles([{ name: 'project-original.txt', content: 'The project library owns this source.' }]); await submit(); await idle();
    const projectItem = (await records('project-original.txt'))[0]; assert.equal(projectItem.projectId, 'import-project'); assert.equal(projectItem.importOrigin, 'project');
    await setFiles([{ name: 'research-space-original.txt', content: 'The research space owns this source.' }]); await setTarget('workspace:科研'); await submit(); await idle();
    const spaceItem = (await records('research-space-original.txt'))[0]; assert.equal(spaceItem.workspace, '科研'); assert.equal(spaceItem.projectId, undefined); assert.equal(spaceItem.importOrigin, 'workspace');
    assert.equal(await evaluate(`JSON.stringify(state.conversations)`), before); await assertRetained('project and space choices');
  });
  await check('a failed webpage fetch never becomes a successful import and preserves the original URL for retry', async () => {
    await fresh(`showView('dashboard','总览')`); await editUrl('https://fixture.invalid/unavailable');
    const count = await evaluate('state.imports.length'); await submit(); await idle();
    assert.equal(await evaluate('state.imports.length'), count);
    assert.equal(await evaluate(`document.querySelectorAll('[data-import-status="saved"]').length`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('[data-import-status="failed"]').length`), 1);
    assert.equal(await evaluate(`document.querySelector('#urlInput').value`), 'https://fixture.invalid/unavailable');
    assert.match(await evaluate(`document.querySelector('.import-result').textContent`), /0 项|0 saved/);
    assert.equal(await evaluate(`document.querySelector('.import-footer button:last-child').disabled`), false);
    await snapshot('webpage-failed'); await assertRetained('failed URL');
  });
  await check('partial success retains only failed files and retry does not duplicate the saved source or upload', async () => {
    await fresh(`showView('dashboard','总览')`); await evaluate(`importFault.failUploadName='retry-only-failed.txt';void 0;`);
    await setFiles([{ name: 'partial-saved.txt', content: 'Upload this only once.' }, { name: 'retry-only-failed.txt', content: 'The first original write will fail.' }]);
    await submit(); await idle();
    assert.equal((await records('partial-saved.txt')).length, 1); assert.equal((await records('retry-only-failed.txt')).length, 0);
    assert.deepEqual(await evaluate(`[...document.querySelector('#fileInput').files].map(f=>f.name)`), ['retry-only-failed.txt']);
    assert.equal(await evaluate(`document.querySelector('.import-footer button:last-child').disabled`), false);
    await snapshot('partial-failure'); await evaluate(`importFault.failUploadName='';void 0;`); await submit(); await idle();
    assert.equal((await records('partial-saved.txt')).length, 1); assert.equal((await records('retry-only-failed.txt')).length, 1);
    assert.equal(await evaluate(`importFault.calls.filter(c=>c.kind==='upload'&&c.name==='partial-saved.txt').length`), 1);
    assert.equal(await evaluate(`importFault.calls.filter(c=>c.kind==='upload'&&c.name==='retry-only-failed.txt').length`), 2); await assertRetained('partial retry');
  });
  await check('failed durable metadata save locks the batch and retry reuses the same original id without another upload', async () => {
    await fresh(`showView('dashboard','总览')`); await setFiles([{ name: 'pending-metadata.txt', content: 'Persist once, retry metadata only.' }]);
    await evaluate(`importFault.stateMode='fail';importFault.matchName='pending-metadata.txt';void 0;`); await submit(); await idle();
    assert.equal(await evaluate('!!importMaterials.pendingSave'), true); const pending = (await records('pending-metadata.txt'))[0];
    assert.equal(await evaluate(`document.querySelector('#importTarget').disabled&&document.querySelector('#urlInput').disabled&&document.querySelector('#fileInput').disabled`), true);
    assert.equal(await evaluate(`document.querySelectorAll('[data-import-status="saved"]').length`), 0);
    assert.match(await evaluate(`document.querySelector('.import-result').textContent`), /尚未确认|unconfirmed/);
    assert.deepEqual((await request('/__files/' + pending.id)).body, Buffer.from('Persist once, retry metadata only.'));
    await snapshot('metadata-save-failed');
    await evaluate(`document.querySelector('#importDialog').close();showView('research','科研');openImportDialog();void 0;`);
    assert.equal(await evaluate(`document.querySelector('#importTarget').value`), 'workspace:日常');
    await evaluate(`importFault.stateMode='normal';void 0;`); await submit(); await idle();
    assert.equal(await evaluate('!!importMaterials.pendingSave'), false);
    assert.deepEqual((await records('pending-metadata.txt')).map(item => item.id), [pending.id]);
    assert.equal(await evaluate(`importFault.calls.filter(c=>c.kind==='upload'&&c.name==='pending-metadata.txt').length`), 1);
    assert.equal(await evaluate(`document.querySelector('#importTarget').disabled`), false);
    const savedState = JSON.parse((await request('/__state')).body.toString()); assert.equal((savedState.state || savedState).imports.filter(item => item.id === pending.id).length, 1);
    evidence.push({ name: pending.name, id: pending.id, pendingThenSaved: true, uploadCount: 1 }); await assertRetained('durable retry');
  });
  await check('a captured webpage waits for metadata without claiming an upload, then opens saved text without a legacy-file warning', async () => {
    await fresh(`showView('dashboard','总览')`); await editUrl('https://fixture.invalid/article');
    await evaluate(`importFault.urlContent=true;importFault.stateMode='fail';importFault.matchName='fixture-article.html';void 0;`); await submit(); await idle();
    assert.equal(await evaluate('!!importMaterials.pendingSave'), true);
    assert.doesNotMatch(await evaluate(`document.querySelector('.import-result').textContent`), /原件已上传|Originals uploaded/);
    assert.equal(await evaluate(`importFault.calls.filter(c=>c.kind==='upload'&&c.name==='fixture-article.html').length`), 0);
    await evaluate(`importFault.stateMode='normal';void 0;`); await submit(); await idle();
    const item = (await records('fixture-article.html'))[0]; assert.equal(item.fileStored, false); assert.equal(item.url, 'https://fixture.invalid/article');
    await click('[data-import-status="saved"] button');
    await until(() => evaluate(`ReadingPane.isActive('import',${JSON.stringify(item.id)})&&document.querySelector('#previewContent').textContent.includes('Saved webpage text')`), 'actual saved webpage preview');
    await until(() => evaluate(`!document.querySelector('#previewVisual .pdf-loading')`), 'webpage preview completed');
    const preview = await evaluate(`document.querySelector('#previewVisual').textContent`);
    assert.doesNotMatch(preview, /旧版本导入|重新添加原始文件|legacy attachment|re-add the original/i);
    assert.match(preview, /已保存网页正文|webpage text/i);
    const previewBounds = await evaluate(`(()=>{const visual=document.querySelector('#previewVisual'),note=visual.querySelector('.preview-file-note'),content=document.querySelector('#previewContent');return{visualHeight:visual.getBoundingClientRect().height,noteHeight:note?.getBoundingClientRect().height,contentHeight:content.getBoundingClientRect().height,visualFlex:getComputedStyle(visual).flex}})()`);
    evidence.push({ name: 'saved webpage preview layout', ...previewBounds });
    assert.ok(previewBounds.visualHeight < 160, JSON.stringify(previewBounds));
    await snapshot('saved-webpage-preview'); await evaluate(`ReadingPane.hide();void 0;`); await assertRetained('webpage preview');
  });
  await check('a 100-message conversation with a restored reader keeps import above the background, focusable and node-stable across repeated opens', async () => {
    const hadNativeClass = await evaluate(`document.body.classList.contains('aibro-native')`);
    const hadGlassClass = await evaluate(`document.documentElement.classList.contains('appkit-web-glass')`);
    const oldGlassAttribute = await evaluate(`document.querySelector('#importDialog').getAttribute('data-appkit-glass')`);
    try {
      const source = (await records('overview-library.txt'))[0];
      await evaluate(`(async()=>{document.querySelector('#importDialog').close();document.querySelector('#fileInput').value='';document.querySelector('#urlInput').value='';ImportWorkspace.selectionChanged();const chat={id:'import-long-chat',title:'100条历史与已恢复阅读区',workspace:'日常',messages:Array.from({length:100},(_,i)=>({id:'import-long-message-'+i,role:i%2?'assistant':'user',text:(i%2?'这是已完成的历史回答。':'这是用户保留的历史消息。')+' 第 '+(i+1)+' 条。',createdAt:Date.now()+i})),attachments:[${JSON.stringify(source.id)}],draftAttachmentIds:[${JSON.stringify(source.id)}],draft:'长对话未发送的草稿必须保留',createdAt:Date.now()};state.conversations.push(chat);openConversation(chat.id);await openImport(${JSON.stringify(source.id)});await ReadingPane.hide();await ReadingPane.reopen();document.body.classList.add('aibro-native');window.importLongBaseline=JSON.stringify({chat:state.conversations.find(c=>c.id==='import-long-chat'),input:document.querySelector('#agentInput').value,attachments:state.attachments});})()`);
      await until(() => evaluate(`!document.querySelector('#readingPane').hidden`), 'reader reopened before modal');
      // Mirror the native shell's actual CSS and environment markers, not a
      // simplified component demo. WK compositing/AX still needs native QA.
      await evaluate(`(()=>{const style=document.createElement('style');style.id='import-native-css-fixture';style.textContent=${JSON.stringify(nativeWorkspaceCSS)};document.head.append(style);document.documentElement.classList.add('appkit-web-glass');document.querySelector('#importDialog').setAttribute('data-appkit-glass','');})()`);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const backgroundBefore = await evaluate(`['.main','.reading-pane','.workspace-separator'].map(selector=>{const node=document.querySelector(selector),r=node?.getBoundingClientRect();return{selector,width:r?.width,height:r?.height}})`);
      await evaluate(`openImportDialog();void 0;`);
      await until(() => evaluate(`!document.querySelector('#readingPane').hidden&&document.querySelector('#importDialog').open`), 'restored reader and import modal');
      assert.equal(await evaluate(`state.conversations.find(c=>c.id==='import-long-chat').messages.length`), 100);
      assert.equal(await evaluate(`document.querySelector('#importTarget').value`), 'conversation:import-long-chat');
      await setFiles([{ name: 'retained-selection-in-long-chat.txt', content: 'Selection survives closing and reopening.' }]);
      await editUrl('https://fixture.invalid/retained-long-chat-link');
      const states = [];
      for (let iteration = 0; iteration < 3; iteration++) {
        const modal = await evaluate(`(()=>{const d=document.querySelector('#importDialog'),style=getComputedStyle(d),backdrop=getComputedStyle(d,'::backdrop'),url=document.querySelector('#urlInput'),r=url.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{iteration:${iteration},first:document.body.firstElementChild===d,modal:d.matches(':modal'),focus:document.activeElement.id,target:document.querySelector('#importTarget').value,transform:style.transform,transition:style.transitionDuration,background:style.backgroundColor,backdropBackground:backdrop.backgroundColor,backdropFilter:backdrop.backdropFilter,backgroundSurfaces:['.main','.reading-pane','.workspace-separator'].map(selector=>{const n=document.querySelector(selector),q=n?.getBoundingClientRect(),s=n&&getComputedStyle(n);return{selector,width:q?.width,height:q?.height,opacity:s?.opacity,pointerEvents:s?.pointerEvents}}),hitUrl:hit===url||url.contains(hit),files:[...document.querySelector('#fileInput').files].map(f=>f.name),url:url.value}})()`);
        states.push(modal); assert.equal(modal.first, true); assert.equal(modal.modal, true); assert.equal(modal.hitUrl, true); assert.equal(modal.transform, 'none'); assert.equal(modal.transition, '0s'); assert.equal(modal.backdropFilter, 'none');
        assert.match(modal.background, /^rgb\(/, 'Native dialog surface must be opaque'); assert.notEqual(modal.backdropBackground, 'rgba(0, 0, 0, 0)');
        for (const surface of modal.backgroundSurfaces) {
          if (surface.width === undefined) continue;
          assert.equal(surface.opacity, '0', surface.selector); assert.equal(surface.pointerEvents, 'none', surface.selector);
          const before = backgroundBefore.find(row => row.selector === surface.selector);
          assert.ok(Math.abs(surface.width - before.width) <= 1 && Math.abs(surface.height - before.height) <= 1, JSON.stringify({ surface, before }));
        }
        assert.equal(modal.target, 'conversation:import-long-chat'); assert.deepEqual(modal.files, ['retained-selection-in-long-chat.txt']); assert.equal(modal.url, 'https://fixture.invalid/retained-long-chat-link');
        await pointerClick('#urlInput'); assert.equal(await evaluate('document.activeElement.id'), 'urlInput');
        await evaluate(`document.querySelector('#importTarget').focus();void 0;`); await key('Tab'); await key('Tab'); assert.equal(await evaluate('document.activeElement.id'), 'urlInput');
        await assertRetained('long-chat modal repeat ' + iteration);
        await pointerClick('#importDialog .import-footer button:first-child'); assert.equal(await evaluate(`document.querySelector('#importDialog').open`), false);
        assert.equal(await evaluate(`['.main','.reading-pane'].every(selector=>{const s=getComputedStyle(document.querySelector(selector));return s.opacity!=='0'&&s.pointerEvents!=='none'})`), true, 'Closing the modal restores background surfaces');
        await evaluate(`openImportDialog();void 0;`); assert.equal(await evaluate('document.activeElement.id'), 'importTarget');
      }
      assert.equal(await evaluate(`JSON.stringify({chat:state.conversations.find(c=>c.id==='import-long-chat'),input:document.querySelector('#agentInput').value,attachments:state.attachments})===importLongBaseline`), true);
      evidence.push({ name: 'long conversation restored reader modal', messages: 100, states, draftAndAttachmentsPreserved: true });
      await snapshot('long-chat-restored-reader-import');
    } finally {
      await evaluate(`document.querySelector('#importDialog').close();document.querySelector('#fileInput').value='';document.querySelector('#urlInput').value='';ImportWorkspace.selectionChanged();ReadingPane.hide();document.body.classList.toggle('aibro-native',${hadNativeClass});document.documentElement.classList.toggle('appkit-web-glass',${hadGlassClass});document.querySelector('#import-native-css-fixture')?.remove();${oldGlassAttribute === null ? "document.querySelector('#importDialog').removeAttribute('data-appkit-glass')" : `document.querySelector('#importDialog').setAttribute('data-appkit-glass',${JSON.stringify(oldGlassAttribute)})`};void 0;`);
    }
  });
  await check('keyboard reaches actual retained inputs and modal controls without exposing hidden original actions', async () => {
    await fresh(`showView('dashboard','总览')`);
    await evaluate(`document.querySelector('#importTarget').focus();void 0;`); await key('Tab');
    assert.equal(await evaluate(`document.activeElement.closest('#importDialog')!==null&&!document.activeElement.closest('[hidden]')`), true);
    await key('Tab'); assert.equal(await evaluate('document.activeElement.id'), 'urlInput');
    await key('Tab'); assert.equal(await evaluate(`document.activeElement.closest('.import-footer')!==null`), true);
    await key('Escape'); assert.equal(await evaluate(`document.querySelector('#importDialog').open`), false); await assertRetained('keyboard modal close');
  });
  await check('long names, light/dark themes, English and reduced motion stay within real 1180/680/430 pixel viewports', async () => {
    const filename = '课程讲义与科研记录_'.repeat(16) + '.txt';
    await fresh(`showView('dashboard','总览')`); await setFiles([{ name: filename, content: 'Long names remain readable.' }]);
    for (const width of [1180, 680, 430]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, 930); await evaluate(`state.ui.theme=${JSON.stringify(theme)};state.settings.reduceMotion=true;applyUiPreferences();WorkstationI18n.setLanguage(${JSON.stringify(width === 430 ? 'en' : 'zh-CN')});void 0;`); await wait(100);
      const bounds = await evaluate(`(()=>{const d=document.querySelector('#importDialog'),r=d.getBoundingClientRect();return{viewport:innerWidth,left:r.left,right:r.right,width:r.width,client:d.clientWidth,scroll:d.scrollWidth,overflows:[...d.querySelectorAll('.import-heading,.import-main,.import-footer,.import-items,.import-target,.import-file-picker,.import-url-slot')].filter(e=>{const q=e.getBoundingClientRect();return q.left<r.left-1||q.right>r.right+1||e.scrollWidth>e.clientWidth+2}).map(e=>e.className),reducedMotion:document.body.classList.contains('reduce-motion'),animations:d.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({name:a.animationName||a.transitionProperty||'',target:a.effect?.target?.id||a.effect?.target?.className||a.effect?.target?.tagName,duration:a.effect?.getComputedTiming().duration,iterations:a.effect?.getComputedTiming().iterations,currentTime:a.currentTime})),name:document.querySelector('.import-item-name').textContent}})()`);
      layout.push({ requestedWidth: width, theme, ...bounds }); assert.ok(bounds.left >= -1 && bounds.right <= width + 1); assert.ok(bounds.scroll <= bounds.client + 2, JSON.stringify(bounds)); assert.deepEqual(bounds.overflows, [], JSON.stringify(bounds)); assert.equal(bounds.reducedMotion, true); assert.ok(bounds.animations.every(animation => Number(animation.duration) <= 1 && Number(animation.iterations) <= 1), JSON.stringify(bounds.animations)); assert.equal(bounds.name, filename); await assertRetained('locale and layout'); await snapshot(`${width}-${theme}-long-name`);
    }
    assert.match(await evaluate(`document.querySelector('.import-heading').textContent`), /Add sources/);
  });
  await check('saved text sources and ownership survive a real reload without a generation or external request', async () => {
    await evaluate(`document.querySelector('#importDialog').close();importFault.stateMode='normal';void 0;`); await durable();
    const before = await evaluate(`state.imports.map(({id,name,workspace,projectId})=>({id,name,workspace,projectId:projectId||null}))`);
    const reload = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.reload(); await reload; await until(() => evaluate(`typeof storageHydrated!=='undefined'&&storageHydrated`), 'real reload');
    assert.deepEqual(await evaluate(`state.imports.map(({id,name,workspace,projectId})=>({id,name,workspace,projectId:projectId||null}))`), before);
    assert.deepEqual(remoteRequests, []); assert.deepEqual(blockedRequests, []);
    assert.ok(requests.some(row => row.path === '/__parse' && row.method === 'POST'));
    assert.ok(requests.some(row => row.path.startsWith('/__files/') && row.method === 'POST'));
    assert.ok(requests.some(row => row.path === '/__state' && row.method === 'POST'));
  });
  await finish();
})().catch(async error => { console.error(error); fatalError = error.stack; await finish(); });
