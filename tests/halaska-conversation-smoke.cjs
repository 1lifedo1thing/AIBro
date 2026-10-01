/* Real bundled Kit + real progress controller, isolated recorded-run fixture.
   No model requests and no user's workspace are loaded. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/halaska-conversation-20260924');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-lifecycle-'));
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const checks = [], failures = [], errors = [], remoteRequests = [];
let win, server; const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { win?.destroy(); server?.close(); app.exit(1); }, 60000);
async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); } }
(async () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:">
  <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/liquid-glass.css"><link rel="stylesheet" href="/agent-progress.css">
  <style>body{display:block!important;padding:24px;overflow:auto!important}main{max-width:700px;margin:auto}article{margin-bottom:24px}.message-wrap{width:100%;max-width:100%;box-sizing:border-box}.message-body{white-space:pre-wrap}h1{font-size:20px}.message-actions,.pending-actions{margin:12px 0}.message-result-links{margin:12px 0}</style></head>
  <body class="liquid-glass light-mode"><main><h1>AI Bro · 执行过程</h1><p>隔离运行记录，用于组件验收。</p><section id="transcript"></section></main>
  <script src="/halaska-ui.js"></script><script src="/agent-progress.js"></script><script src="/halaska-conversation.js"></script></body></html>`;
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
    const file = name === '/native-workspace.css' ? path.join(ROOT, 'native/Resources/workspace.css') : path.join(ROOT, 'app', path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'application/javascript' }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 960, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('RENDERER', event.message); } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { const external = !details.url.startsWith(origin + '/'); if (external) remoteRequests.push(details.url); callback({ cancel: external }); });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { await delay(90); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  await win.loadURL(origin); win.webContents.focus();
  await evaluate(`window.actionLog=[];document.addEventListener('click',e=>{const button=e.target.closest('[data-stop-run],[data-retry-run],[data-adjust-run],[data-approve-run],[data-reject-run],[data-review-run]');if(button)actionLog.push({...button.dataset})});
    window.makeMessage=(message,run)=>{const wrapper=document.createElement('article');wrapper.className='message-wrap';wrapper.dataset.messageId=message.id;wrapper.innerHTML=AgentProgress.markup({...message,runStatus:run.status})+'<div class="message-body"></div>';wrapper.querySelector('.message-body').textContent=message.text||'';
    if(message.live){const b=document.createElement('button');b.dataset.stopRun=run.id;b.className='stop-run';b.textContent='停止';wrapper.append(b)}
    if(message.pendingRunId){const p=document.createElement('div');p.className='pending-actions';p.innerHTML='<button data-approve-run="'+run.id+'">批准并执行</button><button data-reject-run="'+run.id+'">拒绝</button><button data-review-run="'+run.id+'">让审查者先看</button><label data-retained-control>保留原有会话授权范围</label>';wrapper.append(p)}
    if(message.retryRunId){const p=document.createElement('div');p.className='message-actions';p.innerHTML='<button data-retry-run="'+run.id+'">重试</button><button data-adjust-run="'+run.id+'">调整附件后重试</button>';wrapper.append(p)}
    if(message.results?.length){const p=document.createElement('div');p.className='message-result-links';p.innerHTML='<div class="message-result-heading">已归入「设计项目」<small>新建 1 项</small></div><button data-open-note="created-note">交互方案</button>';wrapper.append(p)}
    HalaskaConversation.enhance(wrapper,message,run);return wrapper};
    window.message={id:'lifecycle-live',role:'agent',live:true,text:'',at:Date.now()-2000,progressPins:{feed:true},activities:[{id:'public',kind:'summary',text:'检查项目结构与已有交互记录。',status:'completed',at:Date.now()-2000},{id:'tool',kind:'tool',name:'读取项目文档',text:'docs/interaction.md\\n已读取真实工具记录中的正文。',status:'running',at:Date.now()-1000}]};
    window.run={id:'run-fixture',status:'running',startedAt:message.at};window.current=makeMessage(message,run);document.querySelector('#transcript').append(current);`);
  await check('real lifecycle renders Orb and live public/tool events, with exactly one stop callback', async () => {
    assert.equal(await evaluate(`current.querySelectorAll('[data-halaska-orb]').length`), 1);
    assert.match(await evaluate(`current.textContent`), /正在执行.*读取项目文档/s);
    assert.equal(await evaluate(`current.querySelector('[data-stop-run]').tagName`), 'BUTTON');
    await evaluate(`current.querySelector('[data-stop-run]').click()`);
    assert.deepEqual(await evaluate(`actionLog`), [{ stopRun: 'run-fixture' }]);
    assert.match(await evaluate(`getComputedStyle(current.querySelector('[data-stop-run]')).fontFamily`), /Geist/);
    await shot('running-light');
  });
  await check('stream updates preserve the connected Kit root, Orb, manual folds and full tool content', async () => {
    const result = await evaluate(`(()=>{window.beforeHost=current.querySelector('.halaska-lifecycle-summary');window.beforeOrb=current.querySelector('[data-halaska-orb]');window.beforeTool=current.querySelector('[data-progress-key=tool]');AgentProgress.pin(message,'tool',false);beforeTool.open=false;
      for(let i=0;i<8;i++){message.activities[1].text+='\\n公开记录 '+i+' '+('正文'.repeat(80));AgentProgress.patchLive(current,makeMessage(message,run))}
      return{sameHost:beforeHost===current.querySelector('.halaska-lifecycle-summary'),sameOrb:beforeOrb===current.querySelector('[data-halaska-orb]'),sameTool:beforeTool===current.querySelector('[data-progress-key=tool]'),open:beforeTool.open,full:beforeTool.querySelector('.progress-item-body').textContent===message.activities[1].text,roots:HalaskaUI.diagnostics().mounts};})()`);
    assert.equal(result.sameHost, true); assert.equal(result.sameOrb, true); assert.equal(result.sameTool, true); assert.equal(result.open, false); assert.equal(result.full, true);
    await delay(30); assert.equal(await evaluate(`HalaskaUI.diagnostics().mounts`), await evaluate(`document.querySelectorAll('[data-halaska-root]').length`), 'Each connected Kit island has one root and discarded holders leave no mounts');
  });
  await check('summary supports actual Enter toggling and presents the Kit keyboard hint on focus', async () => {
    win.show(); win.focus(); win.webContents.focus(); await delay(100);
    await evaluate(`current.querySelector('.agent-progress>summary').focus()`); await delay(50);
    const before = await evaluate(`current.querySelector('.agent-progress').open`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await delay(80);
    assert.equal(await evaluate(`current.querySelector('.agent-progress').open`), !before);
    assert.equal(await evaluate(`current.querySelector('.halaska-lifecycle-key kbd')?.textContent`), '↵');
  });
  await check('completed status stops all infinite activity animation and shows only actual result receipt', async () => {
    await evaluate(`message.live=false;message.runStatus='completed';message.text='已整理这份交互方案。';message.results=[{type:'note',id:'created-note'}];run.status='completed';run.finishedAt=Date.now();message.activities.forEach(a=>a.status='completed');AgentProgress.patchLive(current,makeMessage(message,run))`);
    await delay(380);
    assert.equal(await evaluate(`current.querySelectorAll('[data-halaska-orb]').length`), 0);
    assert.equal(await evaluate(`current.getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations===Infinity).length`), 0);
    assert.match(await evaluate(`current.querySelector('[data-halaska-root=AgentReceipt]').textContent`), /已归入「设计项目」.*新建 1 项/s);
    assert.equal(await evaluate(`current.querySelector('[data-open-note]').dataset.openNote`), 'created-note');
    await shot('completed-receipt');
  });
  await check('approval transfers the existing action contract once, leaving scope controls intact', async () => {
    await evaluate(`window.pending=makeMessage({id:'pending',role:'agent',text:'准备新建一条项目笔记。',pendingRunId:'approval-fixture',steps:[{id:'plan',text:'已生成方案',status:'done'}]}, {id:'approval-fixture',status:'awaiting-approval',pendingActions:[{type:'create_note'}]});document.querySelector('#transcript').append(pending);pending.querySelector('[data-approve-run]').click()`);
    assert.equal(await evaluate(`pending.querySelectorAll('[data-approve-run]').length`), 1);
    assert.match(await evaluate(`pending.textContent`), /1 项待批准操作/);
    assert.equal(await evaluate(`!!pending.querySelector('[data-retained-control]')`), true);
    assert.deepEqual(await evaluate(`actionLog.at(-1)`), { approveRun: 'approval-fixture' });
    assert.equal(await evaluate(`actionLog.filter(a=>a.approveRun).length`), 1);
    await shot('approval');
  });
  await check('failure keeps actual error and new-run retry semantics without fictitious repair or undo', async () => {
    await evaluate(`window.failure=makeMessage({id:'failure',role:'agent',text:'调用失败，原有内容仍可查看。',retryRunId:'failed-fixture',steps:[{id:'request',text:'读取资料',status:'failed'}]}, {id:'failed-fixture',status:'failed',error:'服务返回 503。请稍后重试。'});document.querySelector('#transcript').append(failure);failure.querySelector('[data-adjust-run]').click()`);
    assert.match(await evaluate(`failure.textContent`), /503.*重试会按原始请求发起新一轮执行/s);
    assert.doesNotMatch(await evaluate(`failure.textContent`), /已修复|安全续跑|撤销|nothing else|Acme|Alpha/);
    assert.deepEqual(await evaluate(`actionLog.at(-1)`), { adjustRun: 'failed-fixture' });
    await shot('failure');
  });
  await check('440px layout, both palettes and reduced motion preserve readable controls and status', async () => {
    win.setSize(440, 1100); await delay(100); await evaluate(`document.querySelector('#transcript').scrollIntoView({block:'start'})`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    await shot('narrow-light'); await evaluate(`document.body.classList.remove('light-mode')`); await delay(100); await shot('narrow-dark');
    assert.equal(await evaluate(`failure.querySelector('[data-halaska-root]').dataset.halaskaTheme`), 'dark');
    await evaluate(`document.body.classList.add('reduce-motion');message.live=true;run.status='running';message.activities[1].status='running';AgentProgress.patchLive(current,makeMessage(message,run));`); await delay(100);
    assert.equal(await evaluate(`current.getAnimations({subtree:true}).filter(a=>a.playState==='running').length`), 0);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
  });
  await check('strict CSP uses local assets, no remote requests or renderer errors, and removed roots are cleaned', async () => {
    await evaluate(`document.querySelector('#transcript').replaceChildren()`); await delay(40);
    assert.equal(await evaluate(`HalaskaUI.diagnostics().mounts`), 0); assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
  });
  const report = { passed: checks.length, checks, failures, rendererErrors: errors, remoteRequests, modelCalls: 0, fixture: TEMP };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  clearTimeout(watchdog); win.destroy(); server.close(); fs.rmSync(TEMP, {recursive:true,force:true}); app.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error); clearTimeout(watchdog); win?.destroy(); server?.close(); app.exit(1); });
