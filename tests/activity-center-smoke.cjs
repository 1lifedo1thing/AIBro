/* Production renderer and isolated local persistence. No user data or models. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/activity-center-20260924'), TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-activity-center-')), STORE = path.join(TEMP, 'store');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(STORE); app.setPath('userData', path.join(TEMP, 'profile'));
const checks = [], failures = [], errors = [], remote = []; let server, win, ORIGIN;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => finish(1), 150000);
async function until(fn, label, timeout = 20000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await wait(40); } throw Error('Timed out: ' + label); }
async function run() {
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); }); ORIGIN = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(TEMP, 'server.log'), 'a'); server = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, AI_WORKSTATION_ASSET_DIR: path.join(ROOT, 'app') }, stdio: ['ignore', log, log] });
  await until(() => new Promise(resolve => http.get(ORIGIN + '/__health', res => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false))), 'isolated server');
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 1180, height: 980, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => { const external = !request.url.startsWith(ORIGIN + '/'); if (external) remote.push(request.url); callback({ cancel: external }); });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).click()`);
  const button = (text, scope = '#activityCenterDialog') => evaluate(`([...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)})).click()`);
  const key = async keyCode => { win.webContents.focus(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await wait(50); };
  const shot = async name => { await wait(100); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const saved = () => until(() => evaluate('!ActivityCenter.isBusy()&&!state._pendingLocalSave&&!serverSaveInFlight'), 'durable save');
  async function step(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); console.error('STATE', await evaluate(`({active:document.activeElement?.id,dialog:document.querySelector('#activityCenterDialog')?.textContent?.slice(0,4000),count:state.ui.activityCenter?.events?.length})`)); } }
  await win.loadURL(ORIGIN); await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated&&!!window.ActivityCenter'), 'hydration');
  await evaluate(`(()=>{WorkstationOnboarding?.close?.();WorkspaceTour?.close?.();state.ui.onboarding={version:1,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};state.projects=[{id:'activity-project',name:'通知中心验收项目',workspace:'科研',createdAt:Date.now()}];state.notes=[{id:'activity-note',title:'实际执行生成的笔记',content:'# 可追溯的结果\\n\\n这是隔离工作区中的文档。',projectId:'activity-project',workspace:'科研',createdAt:Date.now(),updatedAt:Date.now()}];state.conversations=[{id:'activity-conversation',title:'通知中心来源对话',projectId:'activity-project',workspace:'科研',messages:[],attachments:[],createdAt:Date.now(),updatedAt:Date.now()}];state.currentConversationId='activity-conversation';state.currentProjectId='activity-project';state.agentRuns=[{id:'activity-old',status:'completed',conversationId:'activity-conversation',startedAt:Date.now()-10000,finishedAt:Date.now()-9000,goal:'启用之前的历史执行'}];delete state.ui.activityCenter;ActivityCenter.capture(state);renderAll();})()`); await evaluate('saveDocumentDurably()');
  await step('initial baseline does not replay existing history; real completion and approval transitions produce durable events', async () => {
    assert.equal(await evaluate('ActivityCenter.unreadCount(state)'), 0);
    await evaluate(`(()=>{window.addActivity=(id,status='completed',results=[])=>{const run={id,status,results,conversationId:'activity-conversation',projectId:'activity-project',goal:id==='activity-success'?'整理本周阅读记录，形成可审阅的总结与后续任务':id==='activity-approval'?'修改两篇已有笔记，需要你确认':'检查执行结果：'+id,startedAt:Date.now()-2000,finishedAt:status==='awaiting-approval'?null:Date.now()};state.agentRuns.push(run);save();renderAll();return run;};addActivity('activity-success','completed',[{type:'note',id:'activity-note',operation:'created'}]);addActivity('activity-approval','awaiting-approval');addActivity('activity-failure','failed');addActivity('activity-stopped','cancelled');})()`); await saved();
    assert.equal(await evaluate('ActivityCenter.unreadCount(state)'), 4);
    assert.equal(await evaluate(`fetch('/__state').then(r=>r.json()).then(s=>s.ui.activityCenter.events.length)`), 4);
    const badge = await evaluate(`(()=>{const b=document.querySelector('#activityCenterButton').getBoundingClientRect(),n=document.querySelector('#activityCenterBadge').getBoundingClientRect();return{width:b.width,height:b.height,contained:n.left>=b.left&&n.right<=b.right+1&&n.top>=b.top&&n.bottom<=b.bottom,top:n.top<b.top+b.height/2}})()`);
    assert.ok(badge.width >= 36 && badge.height >= 36 && badge.contained && badge.top);
  });
  await step('real Kit surface opens with truthful digest, remains unread, and persists a separate visit watermark', async () => {
    await click('#activityCenterButton'); await saved(); assert.equal(await evaluate('ActivityCenter.isOpen()'), true);
    assert.match(await evaluate(`document.querySelector('.activity-center-digest').textContent`), /4 条变化/);
    assert.equal(await evaluate('ActivityCenter.unreadCount(state)'), 4); assert.equal(await evaluate('state.ui.activityCenter.lastViewedSeq'), 4);
    assert.equal(await evaluate(`document.querySelector('#activityCenterDialog [data-halaska-root]')!==null`), true); await shot('light-wide');
  });
  await step('marking read and archiving are separate, with durable restore and no source mutation', async () => {
    const row = '[data-activity-id="activity:activity-success:1"]';
    await button('标为已读', row); await saved(); assert.equal(await evaluate('ActivityCenter.unreadCount(state)'), 3);
    await button('归档', row); await saved(); assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row)})===null`), true);
    await button('已归档'); assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row)})!==null`), true);
    await button('恢复', row); await saved(); await button('收件箱'); assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row)}).classList.contains('is-read')`), true);
    assert.equal(await evaluate('state.notes[0].content'), '# 可追溯的结果\n\n这是隔离工作区中的文档。');
  });
  await step('project, type and unread controls compose; source deletion is an explicit recoverable state', async () => {
    await evaluate(`(()=>{const select=document.querySelector('select[aria-label="按活动类型筛选"]');select.value='approval';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await evaluate(`document.querySelectorAll('.activity-center-item').length`), 1);
    await button('仅未读'); assert.equal(await evaluate(`document.querySelectorAll('.activity-center-item').length`), 1);
    await evaluate(`state.agentRuns.find(r=>r.id==='activity-approval').status='completed';state.agentRuns.find(r=>r.id==='activity-approval').finishedAt=Date.now();save();renderAll();`); await saved();
    assert.match(await evaluate(`document.querySelector('.activity-center-list').textContent`), /确认已处理/);
    await evaluate(`state.conversations[0].archived=true;ActivityCenter.refresh()`); assert.match(await evaluate(`document.querySelector('.activity-center-list').textContent`), /来源对话已删除或归档/);
    await evaluate(`state.conversations[0].archived=false;ActivityCenter.refresh()`);
    await evaluate(`(()=>{const select=document.querySelector('select[aria-label="按活动类型筛选"]');select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));})()`); await button('仅未读');
  });
  await step('result navigation uses the host document route and closes only after success', async () => {
    await button('笔记 · 实际执行生成的笔记', '[data-activity-id="activity:activity-success:1"]');
    await until(() => evaluate('!ActivityCenter.isOpen()'), 'source navigation');
    assert.equal(await evaluate(`state.ui.previewTabs?.some?.(t=>t.id==='activity-note') || document.body.textContent.includes('可追溯的结果')`), true);
  });
  await step('dirty editor navigation releases modal inertness and cancelling restores the activity list without losing edits', async () => {
    await click('[data-note-action="edit"]');
    await evaluate(`(()=>{const area=document.querySelector('textarea[aria-label="Markdown 正文"]');area.value+='\\n\\n尚未保存的用户修改';area.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('#activityCenterButton'); await saved(); await button('打开对话 ↗', '[data-activity-id="activity:activity-success:1"]');
    await until(() => evaluate(`document.querySelector('.note-document-leave')?.hidden===false`), 'inline editor leave decision');
    assert.equal(await evaluate('ActivityCenter.isOpen()'), true); assert.equal(await evaluate(`document.querySelector('#activityCenterDialog').open`), false);
    assert.equal(await evaluate(`document.activeElement.dataset.noteAction`), 'stay'); await click('[data-note-action="stay"]');
    await until(() => evaluate(`document.querySelector('#activityCenterDialog').open&&!ActivityCenter.isBusy()`), 'activity restored after cancellation');
    assert.match(await evaluate(`document.querySelector('.activity-center-feedback').textContent`), /没有打开来源/); assert.match(await evaluate(`document.querySelector('textarea[aria-label="Markdown 正文"]').value`), /尚未保存的用户修改/);
    await key('Escape'); await click('[data-note-action="cancel"]'); await click('[data-note-action="discard"]');
  });
  await step('opening a task preserves focus in its modal instead of returning it to the activity bell', async () => {
    await evaluate(`state.tasks.push({id:'activity-task',title:'可打开的任务',projectId:'activity-project',workspace:'科研',status:'todo',priority:'medium',checklist:[],createdAt:Date.now()});addActivity('activity-task-result','completed',[{type:'task',id:'activity-task',operation:'created'}]);`); await saved();
    await click('#activityCenterButton'); await saved(); await button('任务 · 可打开的任务', '[data-activity-id="activity:activity-task-result:1"]');
    await until(() => evaluate(`!ActivityCenter.isOpen()&&document.querySelector('#taskDialog').open`), 'task opened');
    assert.equal(await evaluate(`document.activeElement.closest('#taskDialog')!==null`), true); await evaluate(`document.querySelector('#taskDialog').close()`);
  });
  // Keep real host routing and real durable writes; only failures and hold points
  // below are injected. No provider is involved.
  await evaluate(`window.__activitySaveMode='normal';window.__activityPrivate=false;ActivityCenter.init({getState:()=>state,save:async()=>{if(__activitySaveMode==='reject')throw Error('Isolated activity save rejected');if(__activitySaveMode==='hold')await new Promise((yes,no)=>{window.__activityResolve=yes;window.__activityReject=no;});return saveDocumentDurably();},openTarget:openActivityTarget,isPrivate:()=>__activityPrivate,toast});void 0;`);
  await step('failed read save restores only its field, preserves concurrent activity and allows retry', async () => {
    await click('#activityCenterButton'); await saved(); await evaluate(`__activitySaveMode='hold'`);
    const row = '[data-activity-id="activity:activity-failure:1"]'; await button('标为已读', row);
    await until(() => evaluate('!!window.__activityReject'), 'save hold');
    await evaluate(`addActivity('activity-concurrent');__activitySaveMode='normal';__activityReject(Error('Isolated activity save rejected'));`);
    await until(() => evaluate('!ActivityCenter.isBusy()'), 'save rejected');
    assert.match(await evaluate(`document.querySelector('.activity-center-feedback').textContent`), /save rejected/);
    assert.equal(await evaluate(`state.ui.activityCenter.events.find(e=>e.runId==='activity-failure').readAt`), null);
    assert.ok(await evaluate(`state.ui.activityCenter.events.some(e=>e.runId==='activity-concurrent')`)); await button('标为已读', row); await saved();
  });
  await step('IME Escape does not dismiss and pending saves keep focus contained until settled', async () => {
    await evaluate(`document.querySelector('#activityCenterDialog').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));document.querySelector('#activityCenterDialog').dispatchEvent(new Event('cancel',{cancelable:true}));`); assert.equal(await evaluate('ActivityCenter.isOpen()'), true); await evaluate(`document.querySelector('#activityCenterDialog').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
    await evaluate(`__activitySaveMode='hold';window.__activityResolve=null`); await button('标为已读', '[data-activity-id="activity:activity-concurrent:1"]'); await until(() => evaluate('!!window.__activityResolve'), 'held mark read');
    await key('Escape'); assert.equal(await evaluate('ActivityCenter.isOpen()'), true); await evaluate(`__activitySaveMode='normal';__activityResolve()`); await saved(); await key('Tab'); assert.equal(await evaluate(`document.activeElement.closest('#activityCenterDialog')!==null`), true);
  });
  await step('440px dark English layout contains long titles, filters and reduced-motion controls', async () => {
    await evaluate(`addActivity('activity-long-title');state.ui.activityCenter.events.at(-1).title='A long recorded activity title — '.repeat(9);document.body.classList.remove('light-mode');document.body.classList.add('reduce-motion');document.documentElement.lang='en';document.dispatchEvent(new CustomEvent('workstation-language-change'));`); await saved(); win.setSize(440, 840); await wait(100);
    const geometry = await evaluate(`(()=>{const d=document.querySelector('#activityCenterDialog'),r=d.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth,scroll:d.scrollWidth,client:d.clientWidth}})()`);
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width); assert.ok(geometry.scroll <= geometry.client + 1); assert.equal(await evaluate(`document.querySelector('#activityCenterTitle').textContent`), 'Activity & updates');
    const title = await evaluate(`(()=>{const h=document.querySelector('[data-activity-id="activity:activity-long-title:1"] h4');return{text:h.textContent,title:h.title,height:h.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(h).lineHeight)}})()`);
    assert.equal(title.text, 'A long recorded activity title — '.repeat(9)); assert.equal(title.title, title.text); assert.ok(title.height <= title.lineHeight * 3 + 1);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.activity-center-item')).transitionDuration`), '0s'); await shot('dark-narrow-en');
    await key('Escape'); assert.equal(await evaluate('ActivityCenter.isOpen()'), false); assert.equal(await evaluate(`document.activeElement!==document.body&&document.activeElement.getClientRects().length>0&&!document.activeElement.closest('dialog:not([open])')`), true);
  });
  await step('private mode refuses ordinary activity and private runs leave no ledger entries', async () => {
    await evaluate(`__activityPrivate=true;ActivityCenter.refresh();ActivityCenter.open();state.conversations.push({id:'private-activity',ephemeral:true,title:'PRIVATE_TITLE'});state.agentRuns.push({id:'private-activity-run',conversationId:'private-activity',goal:'PRIVATE_GOAL',status:'completed'});ActivityCenter.capture(state);`);
    assert.equal(await evaluate('ActivityCenter.isOpen()'), false); assert.doesNotMatch(await evaluate('JSON.stringify(state.ui.activityCenter)'), /PRIVATE_GOAL|PRIVATE_TITLE|private-activity/); assert.equal(await evaluate(`document.querySelector('#activityCenterBadge')?.textContent||''`), '');
    await evaluate(`__activityPrivate=false;state.conversations=state.conversations.filter(c=>!c.ephemeral);state.agentRuns=state.agentRuns.filter(r=>r.id!=='private-activity-run');ActivityCenter.refresh();`);
  });
  await step('page size is bounded and full application reload retains read state, archive and watermark without duplicates', async () => {
    await evaluate(`for(let i=0;i<30;i++)addActivity('activity-page-'+i);`); await evaluate('saveDocumentDurably()');
    await click('#activityCenterButton'); await saved(); assert.equal(await evaluate(`document.querySelectorAll('.activity-center-item').length`), 20);
    await click('button[aria-label="Next activity page"]'); assert.ok(await evaluate(`document.querySelectorAll('.activity-center-item').length`)>0); await key('Escape');
    const before = await evaluate(`({count:state.ui.activityCenter.events.length,viewed:state.ui.activityCenter.lastViewedSeq,read:state.ui.activityCenter.events.find(e=>e.runId==='activity-success').readAt})`);
    await win.reload(); await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'reload');
    const after = await evaluate(`({count:state.ui.activityCenter.events.length,viewed:state.ui.activityCenter.lastViewedSeq,read:state.ui.activityCenter.events.find(e=>e.runId==='activity-success').readAt})`); assert.deepEqual(after, before);
  });
  const report = { checks, passed: checks.length, failures, rendererErrors: errors, remoteRequests: remote, modelCalls: 0, store: TEMP }; fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); assert.deepEqual(failures, []); assert.deepEqual(errors, []); assert.deepEqual(remote, []);
}
function finish(code) { clearTimeout(watchdog); win?.destroy(); server?.kill('SIGTERM'); code ? app.exit(code) : app.quit(); }
run().then(() => finish(0)).catch(error => { console.error(error, JSON.stringify(errors)); finish(1); });
