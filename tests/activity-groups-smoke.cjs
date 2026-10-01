/* Real bundled Halaska + actual progress patching and app capture listener.
   Synthetic recorded events only: no user's data, model calls, or external assets. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/activity-groups-20260929');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-activity-groups-'));
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const checks = [], failures = [], errors = [], remoteRequests = [], performance = [], captures = [];
let win, server, cleaned = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('Activity group renderer timed out'); finish(1); }, 90000);
process.on('exit', () => { try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch {} });
async function check(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); } }
async function finish(code) {
  if (cleaned) return; cleaned = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  if (server?.listening) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
  try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch {}
  app.exit(code);
}
(async () => {
  const source = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
  const pinStart = source.indexOf("document.addEventListener('click', event => {", source.indexOf('// 执行过程段的'));
  const pinEnd = source.indexOf('}, true);', pinStart) + '}, true);'.length;
  assert.ok(pinStart > 0 && pinEnd > pinStart, 'capture the actual production pin handler');
  const pinHandler = source.slice(pinStart, pinEnd);
  assert.match(pinHandler, /dataset\.progressKey/);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:">
  <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/liquid-glass.css"><link rel="stylesheet" href="/agent-progress.css">
  <style>html,body{min-width:0!important}body{display:block!important;padding:24px;overflow:auto!important}main{max-width:740px;margin:auto;min-width:0}.message-wrap{width:100%;max-width:100%;box-sizing:border-box;min-width:0}.message-body{white-space:pre-wrap}h1{font-size:20px}.fixture-intro{font-size:12px;color:var(--muted)}@media(max-width:500px){body{padding:16px}}</style></head>
  <body class="liquid-glass light-mode"><main><h1>AI Bro · 工具活动</h1><p class="fixture-intro">隔离记录验收 · 完整明细保留，按实际状态收拢。</p><section id="transcript"></section></main>
  <script src="/halaska-ui.js"></script><script src="/agent-progress.js"></script><script src="/halaska-conversation.js"></script></body></html>`;
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
    const file = path.join(ROOT, 'app', path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'application/javascript' }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 960, height: 960, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('RENDERER', event.message); } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { const external = !details.url.startsWith(origin + '/'); if (external) remoteRequests.push(details.url); callback({ cancel: external }); });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { await delay(80); const filename=name+'.png'; fs.writeFileSync(path.join(OUT, filename), (await win.webContents.capturePage()).toPNG()); captures.push(filename); };
  const key = async value => { win.webContents.sendInputEvent({ type:'keyDown',keyCode:value }); win.webContents.sendInputEvent({ type:'keyUp',keyCode:value }); await delay(70); };
  await win.loadURL(origin); win.show(); win.focus(); win.webContents.focus(); await delay(100);
  await evaluate(`window.state={conversations:[{messages:[]}]};window.savedPins=0;window.save=()=>savedPins++;${pinHandler}
    window.mountCalls=0;window.unmountCalls=0;window.baseKit=HalaskaUI;
    window.HalaskaUI={...baseKit,mount(...args){mountCalls++;return baseKit.mount(...args)},unmount(...args){unmountCalls++;return baseKit.unmount(...args)}};
    window.makeMessage=(message,previous)=>{const wrapper=document.createElement('article');wrapper.className='message-wrap';wrapper.dataset.messageId=message.id;wrapper.innerHTML=AgentProgress.markup(message)+'<div class="message-body"></div>';wrapper.querySelector('.message-body').textContent=message.text||'';HalaskaConversation.enhance(wrapper,message,{id:'run-'+message.id,status:message.runStatus||'running',startedAt:message.at},{previous});return wrapper};
    window.tool=(n,status='completed')=>({id:'read-'+n,kind:'tool',name:'读取项目文档',text:'docs/设计/操作记录-'+n+'.md\\n'+('完整工具内容；'.repeat(n===19?250:3))+'\\nEND-OF-CALL-'+n,status,at:1000+n*2000,updatedAt:2500+n*2000});
    window.reset=(message)=>{if(window.current)HalaskaConversation.discard(current);document.querySelector('#transcript').replaceChildren();window.message=message;state.conversations[0].messages=[message];window.current=makeMessage(message);document.querySelector('#transcript').append(current);window.scrollTo(0,0)};
    window.repaint=()=>{AgentProgress.patchLive(current,makeMessage(message,current))};
    window.makeRecorded=()=>({id:'recorded',role:'agent',at:1000,finishedAt:41000,live:false,runStatus:'completed',progressPins:{feed:true},activities:Array.from({length:20},(_,n)=>tool(n,n===8?'failed':'completed')),text:'共记录 20 次文件读取，其中 1 次失败。失败细节可在活动中展开查看。'});
    reset(makeRecorded());`);
  await check('20 actual calls collapse into one top-level group with visible truthful failure count and real Kit summaries', async () => {
    const result=await evaluate(`(()=>{const feed=current.querySelector('.agent-progress'),group=feed.querySelector('.progress-group-details'),summary=group.querySelector(':scope>summary');return{topRows:feed.querySelector(':scope>.progress-timeline').children.length,children:group.querySelectorAll('[data-activity-id]').length,open:group.open,summary:summary.innerText,visible:summary.getBoundingClientRect().height>0,hiddenRows:[...group.querySelectorAll('[data-activity-id]')].every(n=>!n.checkVisibility({checkVisibilityCSS:true,contentVisibilityAuto:true})),kit:summary.querySelector('[data-halaska-root]')?.dataset.halaskaRoot,roots:HalaskaUI.diagnostics().mounts}})()`);
    await shot('collapsed-light');
    assert.equal(result.topRows,1); assert.equal(result.children,20); assert.equal(result.open,false); assert.equal(result.visible,true); assert.equal(result.hiddenRows,true,JSON.stringify(result));
    assert.match(result.summary,/20 次/); assert.match(result.summary,/失败 1/); assert.match(result.summary,/已完成 19/); assert.equal(result.kit,'AgentActivitySummary'); assert.equal(result.roots,22);
    assert.equal(await evaluate("getComputedStyle(current.querySelector('.halaska-lifecycle-line>.progress-chevron')).transform"),'matrix(0, 1, -1, 0, 0, 0)','expanded feed chevron follows the real disclosure state');
  });
  await check('trusted Enter and Space toggle the group through the actual production capture listener and persist pins once', async () => {
    await evaluate(`current.querySelector('.progress-group-details>summary').focus()`);
    const saved=await evaluate('savedPins'); await key('Enter');
    assert.equal(await evaluate(`current.querySelector('.progress-group-details').open`),true); assert.equal(await evaluate(`message.progressPins['group:read-0']`),true); assert.equal(await evaluate('savedPins'),saved+1);
    await key('Space'); assert.equal(await evaluate(`current.querySelector('.progress-group-details').open`),false); assert.equal(await evaluate(`message.progressPins['group:read-0']`),false); assert.equal(await evaluate('savedPins'),saved+2);
    await key('Enter'); assert.equal(await evaluate(`current.querySelector('.progress-group-details').open`),true);
  });
  await check('expanding retains every original call and full final line without nested scrolling or truncation', async () => {
    const result=await evaluate(`(()=>{current.querySelectorAll('.progress-item-content>details:not([open])>summary').forEach(s=>s.click());const rows=[...current.querySelectorAll('[data-activity-id]')];return{all:rows.every((row,i)=>row.querySelector('.progress-item-body').textContent===message.activities[i].text),count:rows.length,last:rows.at(-1).querySelector('.progress-item-body').textContent.endsWith('END-OF-CALL-19'),clamped:rows.some(row=>{const s=getComputedStyle(row.querySelector('.progress-item-body'));return s.maxHeight!=='none'||['auto','scroll','hidden'].includes(s.overflowY)}),lastVisible:rows.at(-1).getBoundingClientRect().height>0}})()`);
    assert.equal(result.all,true);assert.equal(result.count,20);assert.equal(result.last,true);assert.equal(result.clamped,false);assert.equal(result.lastVisible,true);
  });
  await check('a second tool wrapping the first preserves exact DOM, focused summary, selected text, and Kit root', async () => {
    const result=await evaluate(`(()=>{reset({id:'growing',role:'agent',at:1000,live:true,runStatus:'running',progressPins:{feed:true,'read-0':true},activities:[tool(0,'running')]});window.firstRow=current.querySelector('[data-activity-id="read-0"]');window.firstSummary=firstRow.querySelector('summary');window.firstHost=firstSummary.querySelector('[data-halaska-root]');window.firstText=firstRow.querySelector('.progress-item-body').firstChild;firstSummary.focus();const selection=getSelection();selection.setBaseAndExtent(firstText,0,firstText,18);const chosen=selection.toString(),beforeMounts=mountCalls,beforeUnmounts=unmountCalls;message.activities[0].status='completed';message.activities.push(tool(1,'running'));repaint();return{sameRow:firstRow===current.querySelector('[data-activity-id="read-0"]'),sameHost:firstHost===current.querySelector('[data-activity-id="read-0"] [data-halaska-root]'),sameSummary:firstSummary===current.querySelector('[data-activity-id="read-0"] summary'),focused:document.activeElement===firstSummary,selection:getSelection().toString()===chosen,anchor:getSelection().anchorNode===firstText,groupOpen:current.querySelector('.progress-group-details').open,mountDelta:mountCalls-beforeMounts,unmountDelta:unmountCalls-beforeUnmounts,roots:HalaskaUI.diagnostics().mounts,connectedRoots:current.querySelectorAll('[data-halaska-root]').length,summaryText:firstSummary.textContent}})()`);
    assert.equal(result.sameRow,true);assert.equal(result.sameHost,true);assert.equal(result.sameSummary,true);assert.equal(result.focused,true);assert.equal(result.selection,true);assert.equal(result.anchor,true);assert.equal(result.groupOpen,true);assert.equal(result.mountDelta,3,'new group and new row plus one conservative transitional mount');assert.equal(result.unmountDelta,1,'transitional duplicate is disposed in the same patch');assert.equal(result.roots,4);assert.equal(result.connectedRoots,4);assert.match(result.summaryText,/读取项目文档/);
  });
  await check('append preserves a collapsed group and its original pinned child, while exposing the new failure count', async () => {
    await evaluate(`getSelection().removeAllRanges();current.querySelector('.progress-group-details>summary').focus()`);await key('Enter');
    assert.equal(await evaluate(`message.progressPins['group:read-0']`),false);
    const result=await evaluate(`(()=>{const group=current.querySelector('.progress-group-details');message.activities.push(tool(2,'failed'));repaint();return{same:group===current.querySelector('.progress-group-details'),closed:!group.open,pin:message.progressPins['read-0'],summary:group.querySelector('summary').innerText,visible:group.querySelector('summary').getBoundingClientRect().height>0}})()`);
    assert.equal(result.same,true);assert.equal(result.closed,true);assert.equal(result.pin,true);assert.match(result.summary,/失败 1/);assert.equal(result.visible,true);
  });
  for(const width of [960,440,360])for(const theme of ['light','dark'])await check(`${width}px ${theme} palette keeps group, statuses, and expanded details inside viewport`,async()=>{
    win.setSize(width,960);await delay(80);
    await evaluate(`reset(makeRecorded());document.body.classList.toggle('light-mode',${theme==='light'});message.progressPins['group:read-0']=true;message.progressPins['read-0']=true;repaint();window.scrollTo(0,0)`);await delay(70);
    const layout=await evaluate(`(()=>{const rows=[...current.querySelectorAll('summary,.progress-item-body')].filter(n=>n.getBoundingClientRect().height>0);return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:rows.filter(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>innerWidth+1}).map(n=>n.className),theme:current.querySelector('[data-halaska-root]').dataset.halaskaTheme}})()`);
    assert.ok(layout.scrollWidth<=layout.width+1,JSON.stringify(layout));assert.deepEqual(layout.overflow,[]);assert.equal(layout.theme,theme);
    await shot(`groups-${width}-${theme}`);
  });
  await check('reduced motion retains actual live status with no running animations',async()=>{
    await evaluate(`document.body.classList.add('reduce-motion');message.live=true;message.runStatus='running';message.activities[19].status='running';message.progressPins['group:read-0']=true;repaint()`);await delay(120);
    assert.match(await evaluate(`current.querySelector('.progress-group-details>summary').innerText`),/进行中/);
    assert.equal(await evaluate(`current.getAnimations({subtree:true}).filter(a=>a.playState==='running').length`),0);
    await shot('reduced-motion-running');
  });
  for(const count of [100,150])await check(`${count} calls and 20 deltas reuse connected Kit roots without transient remounts`,async()=>{
    const result=await evaluate(`(()=>{reset({id:'perf-${count}',role:'agent',at:1000,live:true,runStatus:'running',progressPins:{feed:true,'group:read-0':false},activities:Array.from({length:${count}},(_,n)=>tool(n,n===${count}-1?'running':'completed'))});const initialRoots=HalaskaUI.diagnostics().mounts,startMounts=mountCalls,startUnmounts=unmountCalls,start=performance.now(),first=current.querySelector('[data-activity-id="read-0"] [data-halaska-root]');for(let i=0;i<20;i++){message.activities[${count}-1].text+='\\n实际流式增量 '+i;message.activities[${count}-1].updatedAt+=20;repaint()}return{calls:${count},updates:20,ms:performance.now()-start,initialRoots,finalRoots:HalaskaUI.diagnostics().mounts,mounts:mountCalls-startMounts,unmounts:unmountCalls-startUnmounts,sameFirst:first===current.querySelector('[data-activity-id="read-0"] [data-halaska-root]'),closed:!current.querySelector('.progress-group-details').open,connectedRoots:document.querySelectorAll('[data-halaska-root]').length}})()`);
    performance.push(result);assert.equal(result.initialRoots,count+2);assert.equal(result.finalRoots,result.initialRoots);assert.equal(result.mounts,0);assert.equal(result.unmounts,0);assert.equal(result.sameFirst,true);assert.equal(result.closed,true);assert.equal(result.connectedRoots,result.finalRoots);
  });
  await check('all roots dispose and strict local CSP produces no remote traffic or renderer errors',async()=>{
    await evaluate(`HalaskaConversation.discard(current);document.querySelector('#transcript').replaceChildren()`);await delay(40);
    assert.equal(await evaluate(`HalaskaUI.diagnostics().mounts`),0);assert.deepEqual(errors,[]);assert.deepEqual(remoteRequests,[]);
  });
  const report={passed:checks.length,checks,failures,rendererErrors:errors,remoteRequests,modelCalls:0,performance,captures,pinHandler:'extracted directly from app/app.js',temporaryFixtureRemovedOnExit:true};
  fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await finish(failures.length?1:0);
})().catch(async error=>{console.error(error);failures.push({name:'fixture setup',error:error.stack});fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({checks,failures,errors,remoteRequests},null,2));await finish(1)});
