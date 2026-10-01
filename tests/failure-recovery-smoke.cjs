/* Real diagnostic, outcome, adapter and production Kit modules with an isolated
 * run fixture. Delegated actions are recorded, not executed: routing, network
 * recovery and the actual user's credentials need separate host acceptance. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/failure-recovery-20260929');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-failure-recovery-'));
const appSource = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
const routeStart = appSource.indexOf('function openRunFailureRecovery('), routeEnd = appSource.indexOf('function retryAttachmentIdsFor(', routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'Locate production recovery route');
const recoveryRoute = appSource.slice(routeStart, routeEnd);
const disclosureStart=appSource.indexOf('// Failure diagnosis disclosures persist'), disclosureEnd=appSource.indexOf('// 输入区上方的就地操作',disclosureStart);
assert.ok(disclosureStart>0&&disclosureEnd>disclosureStart);
const disclosureListener=appSource.slice(disclosureStart,disclosureEnd);
const delegation = appSource.match(/else if \(target\.dataset\.runRecoverySettings\)[^\n]+\n\s*else if \(target\.dataset\.runRecoveryContext\)[^\n]+/);
assert.ok(delegation, 'Locate production delegated recovery branches');
const recoveryDelegation = `window.dispatchRecoveryFixture=(target,event)=>{${delegation[0].replace(/^else if/, 'if')}};`;
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const checks = [], failures = [], rendererErrors = [], externalRequests = [];
let win, server, stopping = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: '90 second timeout' }); finish(1); }, 90000);
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, rendererErrors, externalRequests,
    modelCalls: 0, userWorkspaceLoaded: false, actionFixture: 'Production recovery route and delegated branches; isolated state with navigation sinks, no full app navigation or retry execution', temporaryProfileRemoved: !fs.existsSync(TEMP) }, null, 2));
  setImmediate(() => app.exit(code));
}
async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); } }
function fixture() {
  window.WorkstationI18n = { getLanguage: () => 'zh', t: value => value };
  window.actionLog = [];
  window.routeLog = [];
  window.saveCount=0;window.save=()=>{saveCount++;localStorage.setItem('recovery-fixture',JSON.stringify(state));};
  window.state = { currentConversationId: 'fixture-conversation', agentRuns: [], conversations: [{ id: 'fixture-conversation', messages: [] }] };
  window.openConversation = id => { state.currentConversationId = id; routeLog.push({ conversation: id }); };
  window.showView = view => { document.body.dataset.view = view; routeLog.push({ view }); };
  window.ContextWorkbench = { open: () => routeLog.push({ context: true }) };
  const fields = document.createElement('div'); fields.id = 'route-fixture-fields';
  fields.innerHTML = '<input id="apiBase" aria-label="Fixture API address"><select id="provider" aria-label="Fixture provider"><option>Fixture</option></select><section id="contextWorkbench"></section>';
  document.body.append(fields);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-run-recovery-settings],[data-run-recovery-context],[data-retry-run]');
    if (button) { actionLog.push({ ...button.dataset }); dispatchRecoveryFixture(button, event); }
  });
  window.makeCard = (run, options = {}) => {
    const prior=state.conversations[0].messages.find(item=>item.id===run.id+'-message');
    const message = { ...prior, id: run.id + '-message', role: 'agent', retryRunId: run.id, text: options.answer || '' };
    const wrapper = document.createElement('article'); wrapper.className = 'message-wrap';wrapper.dataset.messageId=message.id;
    const answer = document.createElement('div'); answer.className = 'message-body'; answer.textContent = message.text; wrapper.append(answer);
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const retry = document.createElement('button'); retry.dataset.retryRun = run.id; retry.textContent = '重试'; actions.append(retry); wrapper.append(actions);
    const outcome = RunOutcomePresentation.present(message, run);
    if (options.extraDetails) outcome.diagnosticDetails.push(...options.extraDetails);
    HalaskaConversation.enhance(wrapper, message, run, { outcome });
    run.conversationId ||= 'fixture-conversation';
    state.agentRuns = state.agentRuns.filter(item => item.id !== run.id).concat(run);
    state.conversations[0].messages = state.conversations[0].messages.filter(item => item.id !== message.id).concat(message);
    return wrapper;
  };
  window.authRun = { id: 'auth-fixture', status: 'failed', error: '服务拒绝认证', errorDiagnostic: RunFailureDiagnostics.fromHttp(401, {}) };
  window.current = makeCard(authRun, { answer: '已经阅读到第二章，这一段结果仍保留。' }); document.querySelector('main').append(current);
}
(async () => {
  const modules = ['halaska-ui', 'run-failure-diagnostics', 'run-outcome-presentation', 'halaska-conversation'];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/liquid-glass.css"><link rel="stylesheet" href="/agent-progress.css"><style>body{display:block!important;padding:20px;overflow:auto!important}main{max-width:700px;margin:auto}.message-wrap{width:100%;max-width:100%;box-sizing:border-box}.message-actions{display:block!important;margin:14px 0}.message-body{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body class="liquid-glass light-mode"><main></main>${modules.map(name => `<script src="/${name}.js"></script>`).join('')}</body></html>`;
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
    const file = path.join(ROOT, 'app', path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'application/javascript' }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 960, height: 850, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { const external = !details.url.startsWith(origin + '/'); if (external) externalRequests.push(details.url); callback({ cancel: external }); });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { await delay(70); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const enter = async () => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await delay(50); };
  await win.loadURL(origin); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate(recoveryRoute + recoveryDelegation + `(${fixture.toString()})()` + disclosureListener);
  await check('real diagnostic module produces one Kit recovery action with unchanged retry dispatch and partial answer', async () => {
    assert.equal(await evaluate(`current.querySelectorAll('[data-run-recovery-settings]').length`), 1);
    assert.equal(await evaluate(`current.querySelector('[data-run-recovery-settings]').tagName`), 'BUTTON');
    assert.match(await evaluate(`getComputedStyle(current.querySelector('[data-run-recovery-settings]')).fontFamily`), /Geist/);
    await evaluate(`current.querySelector('[data-run-recovery-settings]').click();current.querySelector('[data-retry-run]').click()`);
    assert.deepEqual(await evaluate(`actionLog`), [{ runRecoverySettings: 'auth-fixture' }, { retryRun: 'auth-fixture' }]);
    assert.deepEqual(await evaluate(`routeLog`), [{ view: 'settings' }]);
    assert.equal(await evaluate(`document.activeElement.id`), 'apiBase');
    assert.match(await evaluate(`current.querySelector('.message-body').textContent`), /这一段结果仍保留/);
    assert.equal(await evaluate(`current.querySelector('.halaska-failure-diagnostics').open`), false);
  });
  await check('diagnostic summary opens and closes with Enter, while composing and repeating keys do nothing', async () => {
    await evaluate(`current.querySelector('.halaska-failure-diagnostics>summary').focus()`); await enter();
    assert.equal(await evaluate(`current.querySelector('.halaska-failure-diagnostics').open`), true);
    await evaluate(`for(const props of [{repeat:true},{isComposing:true},{ctrlKey:true}]) current.querySelector('.halaska-failure-diagnostics>summary').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...props}))`);
    assert.equal(await evaluate(`current.querySelector('.halaska-failure-diagnostics').open`), true);
    assert.equal(await evaluate(`getComputedStyle(document.activeElement).outlineStyle`), 'solid');
    await enter(); assert.equal(await evaluate(`current.querySelector('.halaska-failure-diagnostics').open`), false);
  });
  await check('owned Kit updates preserve the focused diagnostic disclosure without transferring React children', async () => {
    const result = await evaluate(`(()=>{const oldHost=current.querySelector('[data-halaska-conversation]');const detail=current.querySelector('.halaska-failure-diagnostics');const summary=detail.querySelector('summary');detail.open=true;summary.focus();const next=makeCard(authRun);const nextHost=next.querySelector('[data-halaska-conversation]');const patched=HalaskaConversation.patchIsland(oldHost,nextHost);HalaskaConversation.discard(next);return{patched,same:detail===current.querySelector('.halaska-failure-diagnostics'),open:detail.open,focused:document.activeElement===summary};})()`);
    assert.deepEqual(result, { patched: true, same: true, open: true, focused: true });
  });
  await check('context recovery is keyboard actionable and cancellation or unclassified history adds no settings shortcut', async () => {
    await evaluate(`window.contextCard=makeCard({id:'context-fixture',status:'failed',error:'输入过长',errorDiagnostic:RunFailureDiagnostics.receipt('CONTEXT_LENGTH_EXCEEDED',{phase:'response'})});document.querySelector('main').append(contextCard);contextCard.querySelector('[data-run-recovery-context]').focus()`);
    assert.equal(await evaluate(`document.activeElement===contextCard.querySelector('[data-run-recovery-context]')`), true, 'context action receives focus before keyboard activation');
    await enter(); assert.deepEqual(await evaluate(`actionLog.at(-1)`), { runRecoveryContext: 'context-fixture' });
    assert.deepEqual(await evaluate(`routeLog.slice(-2)`), [{ view: 'agent' }, { context: true }]);
    assert.equal(await evaluate(`document.activeElement.id`), 'contextWorkbench');
    assert.equal(await evaluate(`(()=>{const card=makeCard({...authRun,status:'cancelled'});const count=card.querySelectorAll('[data-run-recovery-settings],.halaska-failure-diagnostics').length;HalaskaConversation.discard(card);return count})()`), 0);
    assert.equal(await evaluate(`(()=>{const card=makeCard({id:'historical',status:'failed',error:'HTTP 502 invalid key'});const count=card.querySelectorAll('[data-run-recovery-settings],.halaska-failure-diagnostics').length;HalaskaConversation.discard(card);return count})()`), 0);
  });
  await check('explicit diagnostic disclosure intent survives full redraw and stored-state reload without passive saves',async()=>{
    await evaluate(`(()=>{const panel=current.querySelector('.halaska-failure-diagnostics');panel.open=false;panel.querySelector('summary').click()})()`);
    assert.equal(await evaluate(`state.conversations[0].messages.find(m=>m.id==='auth-fixture-message').failureDiagnosticOpen`),true);
    const result=await evaluate(`(()=>{const count=saveCount;HalaskaConversation.discard(current);current.remove();window.state=JSON.parse(localStorage.getItem('recovery-fixture'));window.current=makeCard(authRun);document.querySelector('main').prepend(current);return{open:current.querySelector('.halaska-failure-diagnostics').open,passiveSaves:saveCount-count}})()`);
    assert.deepEqual(result,{open:true,passiveSaves:0});
    await evaluate(`current.querySelector('.halaska-failure-diagnostics>summary').click()`);
    assert.equal(await evaluate(`state.conversations[0].messages.find(m=>m.id==='auth-fixture-message').failureDiagnosticOpen`),false);
  });
  await check('production recovery route rejects unrelated, unclassified, cancelled and archived records without navigation', async () => {
    const result = await evaluate(`(()=>{const count=routeLog.length;const context=state.agentRuns.find(item=>item.id==='context-fixture');const other=state.conversations[0];const wrongDestination=openRunFailureRecovery(context.id,'settings');context.status='cancelled';const stopped=openRunFailureRecovery(context.id,'context');context.status='failed';other.archived=true;const archived=openRunFailureRecovery(context.id,'context');other.archived=false;const old=openRunFailureRecovery('historical','settings');return{wrongDestination,stopped,archived,old,unchanged:count===routeLog.length};})()`);
    assert.deepEqual(result, { wrongDestination: false, stopped: false, archived: false, old: false, unchanged: true });
  });
  await check('440px light/dark and reduced motion retain readable long details as escaped text', async () => {
    win.setSize(440, 950); await delay(70);
    await evaluate(`document.querySelector('#route-fixture-fields').remove();HalaskaConversation.discard(current);current.remove();HalaskaConversation.discard(contextCard);contextCard.remove();window.current=makeCard(authRun,{extraDetails:[{label:'转义边界',value:'<img src=x onerror=alert(1)>'},{label:'长字段布局',value:'可见诊断'.repeat(100)}]});document.querySelector('main').append(current);current.querySelector('.halaska-failure-diagnostics').open=true;document.body.classList.add('reduce-motion')`);
    assert.equal(await evaluate(`current.querySelectorAll('.halaska-failure-diagnostics img').length`), 0);
    assert.match(await evaluate(`current.querySelector('.halaska-failure-diagnostics').textContent`), /<img src=x onerror=alert\(1\)>/);
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.body.classList.toggle('light-mode',${theme === 'light'})`); await delay(50);
      assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
      assert.equal(await evaluate(`current.querySelector('[data-halaska-root]').dataset.halaskaTheme`), theme);
      assert.equal(await evaluate(`current.getAnimations({subtree:true}).filter(a=>a.playState==='running').length`), 0);
      await shot('narrow-' + theme);
    }
  });
  await check('CSP stays local and all connected or detached fixture roots dispose cleanly', async () => {
    await evaluate(`document.querySelector('main').replaceChildren()`); await delay(30);
    assert.equal(await evaluate(`HalaskaUI.diagnostics().mounts`), 0); assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []);
  });
  await finish(failures.length ? 1 : 0);
})().catch(error => { failures.push({ name: 'fatal', error: error.stack }); console.error(error); finish(1); });
