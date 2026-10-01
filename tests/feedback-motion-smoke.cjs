/* Real renderer, isolated data. No model calls. Tests result-driven feedback and
   phase animation continuity, plus visible light/dark/narrow component states. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-feedback-')),OUT=path.join(ROOT,'test-results/feedback-motion-20260924');
fs.mkdirSync(path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const checks=[],failures=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let n=0;n<250;n++){if(await fn())return;await wait(40)}throw Error('Timeout: '+label)}
const watchdog=setTimeout(()=>{win?.destroy();server?.kill();app.exit(1)},120000);
(async()=>{
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});const origin=`http://127.0.0.1:${port}`;
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn('python3',[path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:path.join(TEMP,'store')},stdio:['ignore',log,log]});
 await until(()=>new Promise(r=>http.get(origin+'/__health',v=>{v.resume();r(v.statusCode===200)}).on('error',()=>r(false))),'server');await app.whenReady();
 win=new BrowserWindow({show:false,width:1280,height:940,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,cb)=>cb({cancel:!d.url.startsWith(origin+'/')}));
 const evaluate=code=>win.webContents.executeJavaScript(code,true),click=sel=>evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
 async function step(label,fn){try{await fn();checks.push(label);console.log('PASS',label)}catch(e){failures.push({label,error:e.stack});console.error('FAIL',label,e.message)}}
 const shot=async name=>{await wait(80);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 await win.loadURL(origin);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrate');await wait(900);
 if(!await evaluate('!!window.FeedbackMotion'))await evaluate(fs.readFileSync(path.join(ROOT,'app/feedback-motion.js'),'utf8'));
 await win.webContents.insertCSS(fs.readFileSync(path.join(ROOT,'app/feedback-motion.css'),'utf8'));
 await evaluate(`WorkstationOnboarding?.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};`+fs.readFileSync(path.join(ROOT,'tests/fixtures/agent-workbench.js'),'utf8'));
 await evaluate(`(()=>{const c=currentConversation(),m=c.messages[1];m.text='我已经检查完界面记录。还需要你补充两项偏好：';m.progressPins={feed:true};m.clarify={questions:ClarifyQuestions.validate([{id:'detail',question:'执行过程默认怎么展示？',options:['显示简短状态，需要时展开全部记录','保持完整过程展开']},{id:'sources',question:'这次要一起处理哪些内容？',options:['项目文档','文件审阅','网页操作'],multiple:true}]),draft:{detail:['显示简短状态，需要时展开全部记录'],sources:['项目文档']},submittedAt:0};renderAll();document.querySelector('#messageList').scrollTop=0;})()`);
 await step('choices keep real single/multiple selection and no large nested card',async()=>{
  await click('[data-clarify-value="网页操作"]');
  const p=await evaluate(`(()=>{const card=document.querySelector('.clarify-card');return {picks:currentConversation().messages[1].clarify.draft.sources,outline:getComputedStyle(card).borderLeftWidth,single:getComputedStyle(card.querySelector('[data-choice-kind=single] .clarify-option'),':before').borderRadius,multi:getComputedStyle(card.querySelector('[data-choice-kind=multiple] .clarify-option'),':before').borderRadius,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert.deepEqual(p.picks,['项目文档','网页操作']);assert.equal(p.outline,'0px');assert.notEqual(p.single,p.multi);assert.equal(p.overflow,false);assert.equal(await evaluate("document.body.dataset.view"),'agent');await evaluate(`document.querySelector('.clarify-card').scrollIntoView({block:'center',behavior:'instant'})`);await shot('light-process-choices');
 });
 await step('phase change animates once; streaming deltas preserve that same animation',async()=>{
  const p=await evaluate(`(()=>{window.__motionHost=document.createElement('article');document.querySelector('#messageList').append(__motionHost);window.__motionMessage={live:true,at:Date.now(),activities:[{id:'one',kind:'summary',text:'读取需求',status:'running',at:Date.now()}]};__motionHost.innerHTML=AgentProgress.markup(__motionMessage);window.__motionPatch=()=>{const n=document.createElement('article');n.innerHTML=AgentProgress.markup(__motionMessage);AgentProgress.patchLive(__motionHost,n)};__motionMessage.activities[0].status='completed';__motionMessage.activities.push({id:'two',kind:'tool',name:'读取项目文件',text:'design/note.md',status:'running',at:Date.now()});__motionPatch();const node=__motionHost.querySelector('.progress-phase-label'),animation=node.getAnimations()[0];for(let i=0;i<12;i++){__motionMessage.activities[1].text+='资料';__motionPatch()}return {animations:node.getAnimations().length,same:node.getAnimations()[0]===animation,signal:__motionHost.querySelectorAll('.progress-activity').length,rowSpinners:__motionHost.querySelectorAll('.progress-spinner,.progress-signal').length};})()`);
  assert.equal(p.animations,1);assert.equal(p.same,true);assert.equal(p.signal,1);assert.equal(p.rowSpinners,0);
 });
 await step('settled runs remove the only activity animation and retain full public detail',async()=>{
  await evaluate(`__motionMessage.live=false;__motionMessage.runStatus='completed';__motionMessage.activities.forEach(x=>x.status='completed');__motionMessage.progressPins={feed:true,two:true};__motionPatch()`);await wait(260);
  const p=await evaluate(`({signals:__motionHost.querySelectorAll('.progress-activity').length,animations:__motionHost.getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations===Infinity).length,text:__motionHost.textContent})`);assert.equal(p.signals,0);assert.equal(p.animations,0);assert.match(p.text,/design\/note.md资料/);await evaluate('__motionHost.remove()');
 });
 await step('confirmed clipboard promise resolves into the same control; rejected copy has no success',async()=>{
  await evaluate(`window.__copyProbe=document.createElement('button');__copyProbe.textContent='复制';__copyProbe.dataset.copyMessage='fixture';__copyProbe.className='secondary';document.querySelector('#messageList').append(__copyProbe);window.__copyWidth=__copyProbe.getBoundingClientRect().width;window.__copyWork=new Promise(r=>window.__copyResolve=r).then(()=>FeedbackMotion.success(__copyProbe,{label:'已复制'}));void 0;`);
  assert.equal(await evaluate('__copyProbe.classList.contains("feedback-confirmed")'),false);await evaluate('__copyResolve();__copyWork');
  assert.equal(await evaluate('__copyProbe.classList.contains("feedback-confirmed")'),true);assert.equal(await evaluate('__copyProbe.getBoundingClientRect().width'),await evaluate('__copyWidth'));await evaluate('FeedbackMotion.clear(__copyProbe);Promise.reject(Error("Denied")).then(()=>FeedbackMotion.success(__copyProbe)).catch(()=>{})');assert.equal(await evaluate('__copyProbe.classList.contains("feedback-confirmed")'),false);await evaluate('__copyProbe.remove()');
 });
 await step('actual durable note save gives original-place confirmation after persistence',async()=>{
  await evaluate(`openPreview('note','ui-plan')`);await until(()=>evaluate('!!document.querySelector("[data-note-action=edit]")'),'note');await click('[data-note-action="edit"]');
  await evaluate(`(()=>{const s=document.querySelector('.note-document-source textarea');s.value+='\\n\\n已验证原位保存反馈。';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await evaluate('!!document.querySelector("[data-note-action=save].feedback-confirmed")'),false);
  await click('[data-note-action="save"]');await until(()=>evaluate('!!document.querySelector("[data-note-action=save].feedback-confirmed")'),'confirmed save');
  const stored=await evaluate(`fetch('/__state',{cache:'no-store'}).then(r=>r.json()).then(s=>s.notes.find(n=>n.id==='ui-plan').content)`);assert.match(stored,/已验证原位保存反馈/);await shot('confirmed-save');
  await evaluate(`document.querySelector('.note-document-source textarea').dispatchEvent(new Event('input',{bubbles:true}))`);assert.equal(await evaluate('!!document.querySelector("[data-note-action=save].feedback-confirmed")'),false);
 });
 await step('failed persistence retains draft and never shows Saved',async()=>{
  await evaluate(`window.__failedHost=document.createElement('section');__failedHost.style.cssText='position:fixed;inset:60px;z-index:99999;background:var(--panel)';document.body.append(__failedHost);window.__failedState={notes:[{id:'failure-note',title:'失败保护',content:'原文'}],projects:[]};window.__failedEditor=NoteEditor.createInlineController({getState:()=>__failedState,save:()=>Promise.reject(Error('fixture disk unavailable'))});__failedEditor.mount(__failedHost,'failure-note',{mode:'edit'});`);await wait(30);
  await evaluate(`(()=>{const s=__failedHost.querySelector('.note-document-source textarea');s.value='保留的未保存草稿';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);assert.equal(await evaluate('__failedEditor.save()'),false);await wait(40);
  assert.equal(await evaluate('!!__failedHost.querySelector(".feedback-confirmed")'),false);assert.match(await evaluate('__failedHost.querySelector(".note-document-status").textContent'),/保存失败/);assert.equal(await evaluate('__failedHost.querySelector(".note-document-source textarea").value'),'保留的未保存草稿');assert.equal(await evaluate('__failedState.notes[0].content'),'原文');await evaluate('__failedEditor.unmount({force:true});__failedHost.remove()');
 });
 await step('dark, narrow, and reduced motion preserve readable selection and all records',async()=>{
  await evaluate(`ReadingPane?.close?.();document.querySelector('#readingCollapse')?.click();state.ui.theme='dark';applyUiPreferences();document.querySelector('.clarify-card').scrollIntoView({block:'center',behavior:'instant'})`);await wait(150);await shot('dark-process-choices');win.setSize(780,920);await wait(200);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await evaluate(`document.querySelector('.clarify-card').scrollIntoView({block:'center',behavior:'instant'})`);await shot('narrow-process-choices');
  await evaluate(`document.body.classList.add('reduce-motion');window.__reduceHost=document.createElement('article');document.querySelector('#messageList').append(__reduceHost);window.__reduceMessage={live:true,at:Date.now(),activities:[{id:'a',kind:'summary',text:'静态运行状态',status:'running',at:Date.now()}]};__reduceHost.innerHTML=AgentProgress.markup(__reduceMessage);__reduceMessage.activities[0].status='completed';__reduceMessage.activities.push({id:'b',kind:'tool',text:'仍在运行',status:'running',at:Date.now()});const n=document.createElement('article');n.innerHTML=AgentProgress.markup(__reduceMessage);AgentProgress.patchLive(__reduceHost,n);`);
  assert.equal(await evaluate('__reduceHost.getAnimations({subtree:true}).length'),0);assert.match(await evaluate('__reduceHost.textContent'),/正在执行/);await evaluate('__reduceHost.remove()');
 });
 const report={checks,passed:checks.length,failures,modelCalls:0,workspace:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));clearTimeout(watchdog);win.destroy();server.kill();app.exit(failures.length?1:0);
})().catch(e=>{console.error(e);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1)});
