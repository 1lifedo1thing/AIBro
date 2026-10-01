/* Real Chromium, production Kit/controller/composer, synthetic isolated state.
   No credentials, network provider, or user workspace is accessed. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/activity-motion-20260929');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-activity-motion-'));
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const appSource = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
const composer = appSource.slice(appSource.indexOf('function activeConversationRun('), appSource.indexOf('// 较早对话的整理入口'));
assert.match(composer, /function renderComposerActivity/);
const checks = [], failures = [], errors = [], externalRequests = [], observations = [];
let win, server, stopping = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { const end = Date.now()+5000; while(Date.now()<end) { if(await fn())return; await delay(35); } throw Error('Timeout: '+label); }
function report() { fs.writeFileSync(path.join(OUT,'report.json'), JSON.stringify({passed:checks.length,checks,failures,errors,externalRequests,observations,modelCalls:0,userWorkspaceLoaded:false,temporaryProfileRemoved:!fs.existsSync(TEMP)},null,2)); }
const watchdog = setTimeout(()=>{failures.push({name:'watchdog'});finish(1)},90000);
app.on('window-all-closed',()=>{});
app.on('quit',()=>{fs.rmSync(TEMP,{recursive:true,force:true});report()});
async function finish(code) { if(stopping)return;stopping=true;clearTimeout(watchdog);if(win&&!win.isDestroyed())win.destroy();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fs.rmSync(TEMP,{recursive:true,force:true});report();setImmediate(()=>app.exit(code)); }
function fixture() {
  window.$ = selector => document.querySelector(selector);
  window.WorkstationI18n = {getLanguage:()=>'zh',t:t=>t};
  window.state = {agentRuns:[]}; window.currentConversation = ()=>({id:'synthetic'});
  window.make = () => {
    const node=document.createElement('article');node.className='message-wrap agent-message'+(message.live?' live-message':'');
    node.innerHTML='<div class="message-identity">AI · 隔离验收</div>'+AgentProgress.markup(message);HalaskaConversation.enhance(node,message,run);return node;
  };
  window.reset = () => {
    if(window.current){HalaskaConversation.discard(current);current.remove();}
    const now=Date.now()-4300;
    window.message={id:'test-message',role:'agent',live:true,at:now,startedAt:now,phase:'reasoning',activities:[{id:'think-1',kind:'summary',name:'模型思考',text:'公开进展：正在核对来源',status:'running',at:now}]};
    window.run={id:'test-run',conversationId:'synthetic',status:'running',startedAt:now,steps:[{text:'正在核对来源',status:'running'}]};state.agentRuns=[run];
    $('#viewport').scrollTop=0;window.current=make();$('#mount').append(current);renderComposerActivity();
  };
  window.patch = () => AgentProgress.patchLive(current,make());
  window.host = visible => {window.__aibroPresentationVisible=visible;dispatchEvent(new CustomEvent('aibro:presentation-visibility',{detail:{visible}}));};
  window.motion = () => [...document.querySelectorAll('[data-halaska-orb] span')].map(n=>({name:getComputedStyle(n).animationName,state:getComputedStyle(n).animationPlayState})).filter(a=>a.name!=='none');
}
(async()=>{
  const css=['styles.css','agent-progress.css','agent-workbench.css','interaction-system.css','activity-motion.css','halaska-workspace.css'];
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:">${css.map(x=>`<link rel="stylesheet" href="/${x}">`).join('')}<style>body{display:block!important;overflow:hidden!important;padding:20px;margin:0}#viewport{height:350px;overflow:auto;border:1px solid var(--line);padding:10px}#mount{min-height:1700px}.message-wrap{width:100%;max-width:none}.progress-item-body{min-height:45px}#composerActivity{margin-top:16px}h1{font-size:18px}.spacer{height:1000px}</style></head><body class="light-mode interaction-system-ready"><h1>运行状态 · 隔离验收</h1><div id="viewport"><div id="mount"></div></div><div id="composerActivity" class="composer-activity" hidden></div><script src="/halaska-ui.js"></script><script src="/agent-progress.js"></script><script src="/activity-motion.js"></script><script src="/halaska-conversation.js"></script></body></html>`;
  server=http.createServer((request,response)=>{const name=new URL(request.url,'http://localhost').pathname;if(name==='/'){response.setHeader('Content-Type','text/html');return response.end(html)}const file=path.join(ROOT,'app',path.basename(name));if(!fs.existsSync(file)){response.writeHead(404);return response.end()}response.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'application/javascript');response.end(fs.readFileSync(file))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  await app.whenReady();win=new BrowserWindow({show:false,width:960,height:780,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>{const external=!request.url.startsWith(origin+'/');if(external)externalRequests.push(request.url);done({cancel:external})});
  const ev=code=>win.webContents.executeJavaScript(code,true);
  const shot=async name=>fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());
  async function check(name,fn){try{await fn();checks.push(name);console.log('PASS',name)}catch(error){failures.push({name,error:error.stack});console.error('FAIL',name,error.message);await shot('failure-'+checks.length)}}
  await win.loadURL(origin);await ev(composer);await ev('('+fixture.toString()+')()');
  await check('idle page owns no elapsed timer or observed status nodes',async()=>{assert.equal(await ev('ActivityMotion.inspect().timerActive'),false);assert.equal(await ev('ActivityMotion.inspect().tracked'),0)});
  await check('real Kit Orb and AICSS animate; two elapsed labels share one clock',async()=>{
    await ev('reset()');await until(()=>ev('ActivityMotion.inspect().visibleClocks===2 && motion().length>0'),'visible clocks and real Orb');
    assert.ok((await ev('motion()')).every(a=>a.state==='running'));
    const shimmer=await ev(`(()=>{const n=current.querySelector('.aicss-thinking-label[data-aicss-thinking-state="running"]');return n&&{animation:getComputedStyle(n).animationName,state:getComputedStyle(n).animationPlayState}})()`);assert.ok(shimmer.animation.includes('aicss'));assert.equal(shimmer.state,'running');observations.push({visible:await ev('ActivityMotion.inspect()'),shimmer});
    const before=await ev('ActivityMotion.inspect().writes');await delay(1100);assert.ok(await ev(`ActivityMotion.inspect().writes>${before}`));await shot('visible-light');
  });
  await check('closing timeline pauses its row shimmer while summary Orb continues',async()=>{
    await ev(`current.querySelector('.agent-progress').open=false`);
    await until(()=>ev(`current.querySelector('.halaska-activity-line .aicss-thinking-label').hasAttribute('data-activity-paused')`),'collapsed row');
    assert.ok((await ev('motion()')).every(a=>a.state==='running'));assert.equal(await ev('ActivityMotion.inspect().visibleClocks'),2);
    await ev(`current.querySelector('.agent-progress').open=true`);
    await until(()=>ev(`!current.querySelector('.halaska-activity-line .aicss-thinking-label').hasAttribute('data-activity-paused')`),'reopened row');
  });
  await check('scrolling the message offscreen pauses its Orb but leaves visible composer ticking',async()=>{
    await ev(`$('#viewport').scrollTop=1000`);await until(()=>ev('ActivityMotion.inspect().visibleClocks===1'),'only composer visible');assert.ok((await ev('motion()')).every(a=>a.state==='paused'));
    await ev(`$('#composerActivity').hidden=true`);await until(()=>ev('!ActivityMotion.inspect().timerActive'),'all clocks invisible');const before=await ev('ActivityMotion.inspect().ticks');await delay(1200);assert.equal(await ev('ActivityMotion.inspect().ticks'),before);
  });
  await check('revealing a retained surface catches up elapsed wall time immediately',async()=>{
    await ev(`$('#viewport').scrollTop=0;$('#composerActivity').hidden=false`);await until(()=>ev('ActivityMotion.inspect().visibleClocks===2'),'reveal');
    const value=await ev(`({actual:$('#composerActivity .activity-elapsed').textContent,expected:AgentProgress.duration(run.startedAt)})`);assert.equal(value.actual,value.expected);
  });
  await check('native presentation signal suspends clock and all live indicator descendants without deleting them',async()=>{
    await ev(`window.keptOrb=current.querySelector('[data-halaska-orb]');window.keptStop=$('[data-stop-run]');keptStop.focus();host(false)`);
    await until(()=>ev('!ActivityMotion.inspect().timerActive'),'native hidden');assert.ok((await ev('motion()')).every(a=>a.state==='paused'));const before=await ev('ActivityMotion.inspect().ticks');await delay(1200);assert.equal(await ev('ActivityMotion.inspect().ticks'),before);
    await ev('host(true)');await until(()=>ev('ActivityMotion.inspect().visibleClocks===2'),'native reveal');assert.equal(await ev(`keptOrb===current.querySelector('[data-halaska-orb]') && document.activeElement===keptStop`),true);
  });
  await check('stream deltas keep the same hidden Kit root; terminal receipt while hidden prevents stale running state',async()=>{
    await ev(`host(false);for(let i=0;i<12;i++){message.activities[0].text='隐藏期间进展 '+i;patch()}message.live=false;message.runStatus='completed';message.finishedAt=Date.now();run.status='completed';AgentProgress.finish(message,'completed');patch();renderComposerActivity();host(true)`);
    await until(()=>ev('ActivityMotion.inspect().tracked===0'),'all live targets disposed');assert.equal(await ev('ActivityMotion.inspect().timerActive'),false);assert.equal(await ev(`current.querySelectorAll('[data-halaska-orb],[data-progress-start]').length`),0);assert.match(await ev('current.textContent'),/已完成/);
  });
  await check('finite phase motion does not start offscreen and in-flight owned motion cancels when hidden',async()=>{
    await ev('reset()');await until(()=>ev('ActivityMotion.inspect().visibleClocks===2'),'reset');
    assert.equal(await ev(`!!ActivityMotion.animate(current.querySelector('summary'),[{opacity:.5},{opacity:1}],{duration:2000})`),true);
    await ev('host(false)');await until(()=>ev('ActivityMotion.inspect().transitions===0'),'cancelled finite transition');assert.equal(await ev(`ActivityMotion.animate(current.querySelector('summary'),[{opacity:.5},{opacity:1}],{duration:100})===null`),true);
    await ev(`host(true);$('#viewport').scrollTop=1000`);await delay(80);assert.equal(await ev(`ActivityMotion.canAnimate(current.querySelector('summary'))`),false);await ev(`$('#viewport').scrollTop=0`);
  });
  await check('zero-opacity phase entrance survives its own mutation refresh',async()=>{
    await ev(`$('#viewport').scrollTop=0;window.phaseTarget=current.querySelector('.progress-phase-label');window.entrance=ActivityMotion.animate(phaseTarget,[{opacity:0},{opacity:1}],{duration:1500});phaseTarget.classList.add('fixture-phase-transition')`);
    await delay(90);assert.equal(await ev(`entrance.playState`),'running');assert.ok(await ev(`Number(getComputedStyle(phaseTarget).opacity)>0`));assert.equal(await ev(`phaseTarget.querySelector('.aicss-thinking-label').hasAttribute('data-activity-paused')`),false);await ev('entrance.cancel()');
  });
  await check('app and system reduced motion keep labels readable and leave elapsed display current',async()=>{
    await ev(`document.body.classList.add('reduce-motion')`);await until(()=>ev('motion().length===0 || motion().every(a=>a.state==="paused")'),'app reduced');assert.equal(await ev(`ActivityMotion.canAnimate(current.querySelector('summary'))`),false);assert.equal(await ev('ActivityMotion.inspect().timerActive'),true);
    const colors=await ev(`(()=>{const n=current.querySelector('.aicss-thinking-label');const s=getComputedStyle(n);return{color:s.color,fill:s.webkitTextFillColor,animation:s.animationName}})()`);assert.equal(colors.fill,colors.color);assert.equal(colors.animation,'none');observations.push({reduced:colors});await shot('reduced-motion');
    await ev(`document.body.classList.remove('reduce-motion')`);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await until(()=>ev(`!ActivityMotion.canAnimate(current.querySelector('summary'))`),'system reduced');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});win.webContents.debugger.detach();
  });
  await check('status targets replaced repeatedly leave neither observers nor React roots detached',async()=>{
    await ev('for(let i=0;i<30;i++)reset()');await delay(180);const value=await ev(`({motion:ActivityMotion.inspect(),mounted:HalaskaUI.diagnostics().mounts,roots:document.querySelectorAll('[data-halaska-root]').length,targets:document.querySelectorAll('[data-progress-start],[data-halaska-orb],.aicss-thinking-label[data-aicss-thinking-state="running"],.progress-activity,.progress-spinner,.progress-active-mark,.activity-pulse,.progress-phase-label,.progress-signal,.live-message .message-identity').length})`);assert.equal(value.motion.tracked,value.targets);assert.equal(value.mounted,value.roots);observations.push({afterReplacements:value});
  });
  await check('narrow dark surface retains stop focus and current timing',async()=>{
    win.setSize(520,780);await ev(`document.body.classList.remove('light-mode');document.body.classList.add('dark-mode');$('[data-stop-run]').focus()`);await delay(220);assert.equal(await ev(`document.activeElement.matches('[data-stop-run]')`),true);assert.equal(await ev('ActivityMotion.inspect().visibleClocks'),2);await shot('narrow-dark');
  });
  await check('retained identity gains live animation and pauses its pseudo-element offscreen',async()=>{
    await ev(`current.classList.remove('live-message');host(false)`);await delay(50);await ev(`current.classList.add('live-message')`);
    await until(()=>ev(`current.querySelector('.message-identity').hasAttribute('data-activity-paused')`),'new live descendant');assert.equal(await ev(`getComputedStyle(current.querySelector('.message-identity'),'::before').animationPlayState`),'paused');await ev('host(true)');
  });
  await check('exact viewport-edge contact resumes on scrolling alone with every other clock hidden',async()=>{
    await ev(`current.hidden=true;$('#composerActivity').hidden=true;window.edge=document.createElement('span');edge.style.cssText='display:block;margin-top:480px;height:24px';edge.dataset.progressStart=Date.now()-3000;edge.textContent='边缘计时';$('#mount').append(edge);const box=$('#viewport'),r=box.getBoundingClientRect();box.scrollTop+=edge.getBoundingClientRect().top-(r.top+box.clientTop+box.clientHeight)`);
    await until(()=>ev('!ActivityMotion.inspect().timerActive'),'edge-only clock idle');await delay(100);
    await ev(`$('#viewport').scrollTop+=24`);await until(()=>ev('ActivityMotion.inspect().visibleClocks===1'),'edge-only clock resumes');
    await ev(`edge.remove();current.hidden=false;$('#composerActivity').hidden=false;$('#viewport').scrollTop=0`);
  });
  await check('invalid timestamps never start a timer; disposal releases every subscription',async()=>{
    await ev(`HalaskaConversation.discard(current);current.remove();run.status='completed';renderComposerActivity();const bad=document.createElement('span');bad.dataset.progressStart='invalid';bad.textContent='等待记录';document.body.append(bad)`);await until(()=>ev('!ActivityMotion.inspect().timerActive'),'invalid timestamp');assert.equal(await ev(`document.querySelector('[data-progress-start]').textContent`),'等待记录');await ev('ActivityMotion.destroy()');assert.equal(await ev('ActivityMotion.inspect().tracked'),0);assert.equal(await ev('ActivityMotion.inspect().timerActive'),false);assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  });
  await finish(failures.length?1:0);
})().catch(async error=>{failures.push({name:'setup',error:error.stack});console.error(error);await finish(1)});
