/* Full production app + Kit project navigation, using a fresh temporary server
 * store and Electron profile. No user workspace, provider or SSH is involved.
 * Run only after the parent's normal build:ui step; this script never builds.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/project-library-navigation-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-project-library-navigation-'));
const STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
app.on('window-all-closed', () => {});
let server, win, origin, stopping = false;
const checks = [], failures = [], observations = [], rendererErrors = [], externalRequests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = source => win.webContents.executeJavaScript(source, true);
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: '120 second deadline' }); void finish(1); }, 120000);
async function until(predicate, label) {
  const start = Date.now();
  while (Date.now() - start < 15000) { if (await predicate()) return; await delay(60); }
  throw new Error('Timeout: ' + label);
}
async function check(name, action) {
  try { await action(); checks.push(name); console.log('PASS', name); }
  catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); }
}
async function paint() {
  await evaluate(`new Promise(resolve => { document.getAnimations().forEach(animation => { try { animation.finish(); } catch {} }); requestAnimationFrame(() => requestAnimationFrame(resolve)); })`);
}
async function click(selector) {
  await evaluate(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target || !target.getClientRects().length || target.disabled) throw Error('Unavailable control: '+${JSON.stringify(selector)}); target.click(); })()`);
  await paint();
}
async function screenshot(name) {
  await paint(); fs.writeFileSync(path.join(OUT, 'navigation-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function report() {
  fs.writeFileSync(path.join(OUT, 'renderer-report.json'), JSON.stringify({ passed: checks.length, checks, failures, observations, rendererErrors, externalRequests,
    scope: 'Full production app, real Kit/ProjectLibrary/CollectionUI/ProjectOutputs/reader routing; synthetic notes and runs only.',
    excluded: 'No native acceptance, provider requests, SSH, external data, draft adoption or filesystem imports.',
    userWorkspaceLoaded: false, workspace: TEMP, temporaryWorkspaceRemoved: !fs.existsSync(TEMP), origin,
  }, null, 2) + '\n');
}
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(1500)]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(500)]); }
  }
  fs.rmSync(TEMP, { recursive: true, force: true }); report(); app.exit(code);
}
const folder = value => '#projectLibraryNavigation [data-project-library-folder=' + JSON.stringify(value) + ']';
const disclosure = (value, open) => '#projectLibraryNavigation button[aria-label=' + JSON.stringify((open ? '收起 ' : '展开 ') + value) + ']';
const selected = () => evaluate(`state.ui.projectLibraryFolders?.['library-p'] ?? null`);
const visibleIds = () => evaluate(`[...document.querySelectorAll('#projectCollection [data-cui-id]')].map(row => row.dataset.cuiId).sort()`);
async function project(id, section = 'knowledge') {
  assert.equal(await evaluate(`WorkspaceNavigation.go(${JSON.stringify(section)},${JSON.stringify(id)})`), true);
  await paint();
}

async function run() {
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
  origin = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(OUT, 'renderer-server.log'), 'w');
  server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE }, stdio: ['ignore', log, log] }); fs.closeSync(log);
  await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'isolated server');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1280, height: 880, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, done) => {
    const allowed = request.url.startsWith(origin + '/');
    if (!allowed) externalRequests.push(request.url);
    done({ cancel: !allowed });
  });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  await win.loadURL(origin);
  await until(() => evaluate(`typeof storageHydrated !== 'undefined' && storageHydrated`), 'workspace hydration');
  assert.equal(await evaluate(`!!window.ProjectLibrary && HalaskaUI.componentNames.includes('ProjectLibraryNavigation') && HalaskaUI.componentNames.includes('ProjectLibraryBreadcrumb')`), true, 'Build the current production Kit bundle before running this fixture');
  await evaluate(`(() => {
    WorkstationOnboarding.close(); WorkspaceTour.close(); state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'}; state.ui.workspaceTour={version:WorkspaceTour.VERSION,status:'skipped'};
    state.projects=[{id:'library-p',name:'目录与文档（合成验收）',workspace:'日常'},{id:'library-q',name:'第二项目（合成验收）',workspace:'日常'}];
    const note=(id,title,folderPath,projectId='library-p')=>({id,title,folderPath,projectId,workspace:'日常',kind:'note',content:'# '+title+'\\n\\nSynthetic fixture document body.',sourceAttachmentIds:[],createdAt:10,updatedAt:20});
    state.notes=[note('library-open','可打开的真实笔记','design/research/deep'),note('library-draft','待审阅笔记','design/research/deep'),note('library-loose','未分类笔记',''),note('library-long','长名称与目录边界的合成笔记','很长的中文目录名称用于窄窗布局检查/第二级也有较长名称'),note('library-q-note','第二项目资料','design/research/deep','library-q')];
    state.notes.find(note=>note.id==='library-draft').aiDraft={content:'A proposal, not an adopted body.',createdAt:30};
    state.tasks=[];state.imports=[];state.papers=[];state.trash=[];state.links=[];
    state.conversations=[{id:'library-chat',title:'成果来源（合成验收）',projectId:'library-p',workspace:'日常',attachments:[],draftAttachmentIds:[],draft:'',messages:[{id:'library-answer',role:'agent',text:'Synthetic saved output.',runId:'library-run',results:[{type:'note',id:'library-open',operation:'created'}]}]}];
    state.agentRuns=[{id:'library-run',conversationId:'library-chat',projectId:'library-p',status:'completed',startedAt:10,finishedAt:20,results:[{type:'note',id:'library-open',operation:'created'}],steps:[]}];
    state.currentConversationId='library-chat';state.currentProjectId='library-p';state.ui.projectLibraryFolders={};state.ui.projectLibraryExpansion={};state.ui.workspaceNavigation={projects:{}};state.ui.theme='light';state.ui.reducedMotion=true;
    normalizeStateShape(state);applyUiPreferences();renderAll();
    window.libraryOriginCalls=[];const original=captureDocumentOrigin;
    captureDocumentOrigin=function(kind,id,navigation={}) { const value=original(kind,id,navigation);libraryOriginCalls.push({kind,id,exactAnchor:navigation.anchor===window.expectedLibraryAnchor,anchorPresent:!!navigation.anchor,origin:value});return value; };
  })()`);
  await project('library-p');

  await check('real Kit directory buttons keep selection separate from disclosure', async () => {
    assert.equal(await selected(), null);
    await click(folder('design'));
    assert.equal(await selected(), 'design');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(disclosure('design', false))}).getAttribute('aria-expanded')`), 'false');
    const before = await visibleIds(); await click(disclosure('design', false));
    assert.equal(await selected(), 'design'); assert.deepEqual(await visibleIds(), before);
    await click(disclosure('design/research', false)); await click(folder('design/research/deep'));
    assert.equal(await selected(), 'design/research/deep');
    assert.deepEqual(await visibleIds(), ['library-draft', 'library-open']);
  });

  await check('collapsed selected ancestors retain location and breadcrumb reveal restores the exact folder focus', async () => {
    await click(disclosure('design', true));
    assert.equal(await selected(), 'design/research/deep');
    assert.match(await evaluate(`document.querySelector('#projectLibraryLocation').textContent`), /design.*research.*deep/s);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(folder('design/research/deep'))}).getClientRects().length`), 0);
    await click('#projectLibraryLocation button[aria-label="在目录中显示当前位置"]');
    assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(folder('design/research/deep'))})`), true);
    assert.deepEqual(await visibleIds(), ['library-draft', 'library-open']);
  });

  await check('same-project data refresh retains the actual owned directory node and focused control', async () => {
    const result = await evaluate(`(() => { const host=document.querySelector('#projectLibraryNavigation'),nav=host.firstElementChild,button=document.querySelector(${JSON.stringify(folder('design/research/deep'))});button.focus();const before=button;state.notes.push({...state.notes.find(note=>note.id==='library-open'),id:'library-refresh',title:'Background count update'});for(let i=0;i<5;i++)renderProject('library-p');return {sameHost:document.querySelector('#projectLibraryNavigation')===host,sameNav:host.firstElementChild===nav,sameButton:document.querySelector(${JSON.stringify(folder('design/research/deep'))})===before,focused:document.activeElement===before,count:before.textContent};})()`);
    observations.push({ refresh: result }); assert.equal(result.sameHost && result.sameNav && result.sameButton && result.focused, true); assert.match(result.count, /3/);
  });

  await check('A/B projects retain independent selected folders and disclosure preferences', async () => {
    await click(disclosure('design', true)); await project('library-q');
    assert.equal(await evaluate(`state.ui.projectLibraryFolders?.['library-q']??null`), null);
    await click(disclosure('design', false)); await click(disclosure('design/research', false)); await click(folder('design/research/deep'));
    await project('library-p'); assert.equal(await selected(), 'design/research/deep');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(disclosure('design', false))}).getAttribute('aria-expanded')`), 'false');
    await project('library-q');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(disclosure('design', true))}).getAttribute('aria-expanded')`), 'true');
    assert.deepEqual(await visibleIds(), ['library-q-note']); await project('library-p');
    await click('#projectLibraryLocation button[aria-label="在目录中显示当前位置"]');
  });

  await check('wide and narrow layouts avoid horizontal overflow and keep pending-review metadata visible', async () => {
    for (const width of [1280, 800, 440]) {
      win.setSize(width, 880); await delay(100); await evaluate(`WorkspaceLayout.refresh()`); await paint();
      const result = await evaluate(`(() => { const rect=node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width,centerY:box.top+box.height/2,height:box.height};};const inspect=selector=>{const node=document.querySelector(selector);return {...rect(node),scroll:node.scrollWidth,client:node.clientWidth};};const status=document.querySelector('#projectCollection [data-cui-id="library-draft"] .collection-status');return {width:innerWidth,page:document.documentElement.scrollWidth,nav:inspect('#projectLibraryNavigation'),location:inspect('#projectLibraryLocation'),collection:inspect('#projectCollection'),pending:{text:status.textContent,visible:!!status.getClientRects().length,display:getComputedStyle(status).display},buttons:[...document.querySelectorAll('#projectLibraryNavigation button')].filter(button=>button.getClientRects().length).map(rect),labels:[...document.querySelectorAll('#projectLibraryNavigation .kit-project-folder-select button')].filter(button=>button.getClientRects().length).map(button=>({text:button.querySelector('.kit-project-folder-name').textContent,button:rect(button),icon:rect(button.querySelector('.kit-project-folder-icon')),name:rect(button.querySelector('.kit-project-folder-name')),count:rect(button.querySelector('.kit-project-folder-count'))}))};})()`);
      observations.push({ dimensions: result }); assert.ok(result.page <= result.width + 1, 'page overflow at ' + width);
      for (const name of ['nav', 'location', 'collection']) assert.ok(result[name].scroll <= result[name].client + 2, name + ' overflow at ' + width);
      assert.equal(result.pending.visible, true, 'pending review must remain visible at ' + width); assert.match(result.pending.text, /待审阅/);
      for (const button of result.buttons) assert.ok(button.left >= result.nav.left - 1 && button.right <= result.nav.right + 1, 'directory control bounds at ' + width);
      assert.ok(result.labels.some(label => label.text.length >= 16), 'long folder label is exercised');
      for (const label of result.labels) {
        assert.ok(label.count.width > 0 && label.count.right <= label.button.right + 1, 'visible count inside long folder control at ' + width);
        assert.ok(label.icon.right <= label.name.left + 1 && label.name.right <= label.count.left + 1, 'icon, name and count do not overlap at ' + width);
        assert.ok(Math.abs(label.icon.centerY - label.count.centerY) <= 3 && Math.abs(label.name.centerY - label.count.centerY) <= 3, 'icon, name and count stay on one row at ' + width);
      }
      await screenshot('sources-' + width);
    }
  });

  await check('actual collection button passes its anchor into the reader and returns to project sources', async () => {
    win.setSize(1280, 880); await paint();
    await evaluate(`window.expectedLibraryAnchor=document.querySelector('#projectCollection [data-cui-id="library-open"] [data-cui-open]');window.libraryOriginCalls=[];`);
    await click('#projectCollection [data-cui-id="library-open"] [data-cui-open]');
    await until(() => evaluate(`ReadingPane.isActive('note','library-open') && state.previewRecord?.id==='library-open'`), 'source note reader');
    await until(() => evaluate(`document.querySelector('#previewContent')?.textContent.includes('Synthetic fixture document body')`), 'asynchronous document renderer');
    const result = await evaluate(`({call:libraryOriginCalls.find(item=>item.id==='library-open'),tab:ReadingPane.snapshot().tabs.find(tab=>tab.kind==='note'&&tab.id==='library-open'),text:document.querySelector('#previewContent').textContent})`);
    observations.push({ sourceNavigation: result }); assert.equal(result.call.exactAnchor, true); assert.deepEqual(result.tab.origin, { view: 'project', projectId: 'library-p', section: 'knowledge' }); assert.match(result.text, /Synthetic fixture document body/);
    await screenshot('source-reader'); await click('#readingBack');
    await until(() => evaluate(`document.body.dataset.view==='project' && state.ui.projectTab==='knowledge' && !ReadingPane.snapshot().visible`), 'return to sources');
    assert.equal(await selected(), 'design/research/deep');
  });

  await check('actual project output button opens the document and returns to outputs instead of its former sources entry', async () => {
    await project('library-p', 'outputs');
    await until(() => evaluate(`!!document.querySelector('#projectOutputs .project-output-title')`), 'actual output row');
    await evaluate(`window.expectedLibraryAnchor=document.querySelector('#projectOutputs .project-output-title');window.libraryOriginCalls=[];`);
    await click('#projectOutputs .project-output-title');
    await until(() => evaluate(`ReadingPane.isActive('note','library-open') && ReadingPane.snapshot().visible`), 'output document reader');
    const result = await evaluate(`({call:libraryOriginCalls.find(item=>item.id==='library-open'),tab:ReadingPane.snapshot().tabs.find(tab=>tab.kind==='note'&&tab.id==='library-open')})`);
    observations.push({ outputNavigation: result }); assert.equal(result.call.exactAnchor, true); assert.deepEqual(result.tab.origin, { view: 'project', projectId: 'library-p', section: 'outputs' });
    await click('#readingBack'); await until(() => evaluate(`document.body.dataset.view==='project' && state.ui.projectTab==='outputs' && !ReadingPane.snapshot().visible`), 'return to outputs');
    await screenshot('outputs-return');
  });

  await check('fixture makes no external requests and reports no renderer errors', async () => { assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []); });
  return failures.length ? 1 : 0;
}
run().then(finish).catch(error => { failures.push({ name: 'infrastructure', error: error.stack }); console.error(error); void finish(1); });
