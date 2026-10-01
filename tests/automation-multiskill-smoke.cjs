/* Actual app, Kit inputs and AgentTransport serialization; all data is disposable.
   The transport's final fetch is intercepted, so no external model is called. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 18984, ORIGIN = `http://127.0.0.1:${PORT}`, TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-automation-skills-')), STORE = path.join(TEMP, 'store'), OUT = path.join(ROOT, 'test-results/automation-multiskill-20260925');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
let server, win; const checks = [], errors = [], remote = [], wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { const start = Date.now(); while (Date.now() - start < 20000) { if (await fn()) return; await wait(70); } throw Error('Timeout: ' + label); }
const watchdog = setTimeout(() => { server?.kill(); win?.destroy(); app.exit(1); }, 180000);
(async () => {
 await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(PORT, '127.0.0.1', () => probe.close(resolve)); });
 const log = fs.openSync(path.join(TEMP, 'server.log'), 'a'); server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(PORT), AI_WORKSTATION_DATA_DIR: STORE }, stdio: ['ignore', log, log] });
 await until(() => new Promise(resolve => http.get(ORIGIN + '/__health', r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false))), 'server');
 await app.whenReady(); win = new BrowserWindow({ show: false, width: 1280, height: 940, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { const external = !details.url.startsWith(ORIGIN + '/'); if (external) remote.push(details.url); callback({ cancel: external }); });
 win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
 const evaluate = code => win.webContents.executeJavaScript(code.includes('await ')?'(async()=>{'+code+'})()':code, true).catch(error=>{console.error('EVALUATION:',code.slice(0,500),'RENDERER:',errors);throw error}), click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const shot = async name => { await wait(200); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
 await win.loadURL(ORIGIN); await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'hydration');
 await evaluate(`WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};` + fs.readFileSync(path.join(ROOT, 'tests/fixtures/agent-workbench.js'), 'utf8'));


 await evaluate(`state.projects=[{id:'automation-project',name:'多技能任务验收',workspace:'科研'}];state.skills=[{id:'skill_alpha',name:'证据检查',command:'evidence',description:'逐项核查证据与判断',instructions:'ALPHA_ORIGINAL: evidence before conclusions.'},{id:'skill_beta',name:'输出排版与下一步行动建议',command:'format',description:'为长标题提供完整可读的操作区域',instructions:'BETA_ORIGINAL: concise results with next actions.'},{id:'skill_disabled',name:'暂停的技能',command:'paused',instructions:'DISABLED_NEVER_SENT',enabled:false}];state.settings.skillsEnabled=true;await saveDocumentDurably();await ProjectAutomation.open(state.projects[0]);`);
 await until(()=>evaluate(`document.querySelector('#automation-skill-skill_alpha')`),'Kit skills');
 await click('#automation-skill-skill_beta');
 await evaluate(`document.querySelector('#automation-skill-skill_alpha').focus()`);win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
 await until(()=>evaluate(`document.querySelector('#automation-skill-skill_alpha').checked`),'keyboard second choice');
 assert.equal(await evaluate(`document.activeElement.id`),'automation-skill-skill_alpha');
 await click('#automation-skill-builtin-course');
 assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-automation-skill-chip]')].map(e=>e.dataset.automationSkillChip)`),['skill_beta','skill_alpha','builtin-course']);
 assert.equal(await evaluate(`document.querySelector('#automation-skill-skill_disabled').disabled`),true);
 checks.push('real Kit checkbox selection preserves ordered choices and keyboard focus; disabled new choices cannot be selected');
 await evaluate(`document.querySelector('#projectAutomationForm [name=name]').value='隔离组合任务';document.querySelector('#projectAutomationForm [name=prompt]').value='核对计划并给出摘要';`);
 for(const theme of ['light','dark']){await evaluate(`state.ui.theme=${JSON.stringify(theme)};applyUiPreferences();document.querySelector('.automation-skills').scrollIntoView({block:'center'})`);win.setSize(440,820);await wait(100);assert.equal(await evaluate(`document.querySelector('#projectAutomationDialog').scrollWidth>document.querySelector('#projectAutomationDialog').clientWidth`),false);await shot(theme+'-440');}
 await evaluate(`document.body.classList.add('reduce-motion')`);assert.equal(await evaluate(`document.querySelector('#projectAutomationDialog').getAnimations({subtree:true}).filter(a=>a.playState==='running').length`),0);win.setSize(1280,940);
 checks.push('long labels and ordered removal chips fit a 440px window in light/dark; reduced motion has no active animations');
 await evaluate(`document.querySelector('#projectAutomationForm').requestSubmit()`);
 await until(()=>evaluate(`document.querySelector('.automation-form-status').textContent==='自动任务已保存。'`),'create persisted');
 let jobs=await evaluate(`fetch('/__project/jobs').then(r=>r.json()).then(r=>r.jobs)`);const jobId=jobs[0].id;
 assert.deepEqual(jobs[0].skillIds,['skill_beta','skill_alpha','builtin-course']);assert.equal(jobs[0].skillId,'skill_beta');
 await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload');await evaluate(`WorkstationOnboarding.close();WorkspaceTour.close();await ProjectAutomation.open(state.projects[0]);[...document.querySelectorAll('[data-automation-job] button')].find(b=>b.textContent==='编辑').click()`);
 assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-automation-skill-chip]')].map(e=>e.dataset.automationSkillChip)`),['skill_beta','skill_alpha','builtin-course']);
 checks.push('create, real project-jobs.json storage, full reload and Edit restore ordered skillIds and its legacy mirror');
 // A backend failure must preserve all fields and choices without announcing success.
 await evaluate(`(()=>{window.__automationFetch=fetch.bind(window);window.fetch=async(url,options)=>String(url).endsWith('/__project/jobs/upsert')?new Response(JSON.stringify({error:'Synthetic storage failure'}),{status:500,headers:{'content-type':'application/json'}}):__automationFetch(url,options);document.querySelector('#projectAutomationForm [name=name]').value='保留失败草稿';document.querySelector('#projectAutomationForm').requestSubmit()})()`);
 await until(()=>evaluate(`document.querySelector('.automation-form-status').textContent==='Synthetic storage failure'`),'save error');
 assert.equal(await evaluate(`document.querySelector('#projectAutomationForm [name=name]').value`),'保留失败草稿');
 assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-automation-skill-chip]')].map(e=>e.dataset.automationSkillChip)`),['skill_beta','skill_alpha','builtin-course']);
 assert.equal((await evaluate(`__automationFetch('/__project/jobs').then(r=>r.json()).then(r=>r.jobs)`))[0].name,'隔离组合任务');
 checks.push('failed durable save retains the edited name and all selections, exposes the error and leaves the persisted job unchanged');
 // While the real request waits, close/Escape and repeated submission cannot race it.
 await evaluate(`window.fetch=async(url,options)=>{if(String(url).endsWith('/__project/jobs/upsert'))await new Promise(resolve=>window.__resumeAutomationSave=resolve);return __automationFetch(url,options)};document.querySelector('#projectAutomationForm').requestSubmit()`);
 await until(()=>evaluate(`typeof __resumeAutomationSave==='function'`),'held save');
 assert.equal(await evaluate(`document.querySelector('#automation-skill-skill_beta').disabled`),true);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(60);assert.equal(await evaluate(`document.querySelector('#projectAutomationDialog').open`),true);
 await evaluate(`__resumeAutomationSave()`);await until(()=>evaluate(`document.querySelector('.automation-form-status').textContent==='自动任务已保存。'`),'saved edit');
 assert.equal((await evaluate(`__automationFetch('/__project/jobs').then(r=>r.json()).then(r=>r.jobs)`))[0].name,'保留失败草稿');
 checks.push('pending save locks Kit choices and prevents Escape dismissing unfinished edits; success only follows backend acknowledgement');
 await evaluate(`window.fetch=__automationFetch;document.querySelector('#projectAutomationDialog').close();(()=>{window.__automationRequests=[];const actual=window.fetch.bind(window);window.fetch=async(url,options)=>{if(String(url).includes('/__proxy')){__automationRequests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({workspace:'科研',message:'组合工作流执行完毕。',actions:[]})},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});}return actual(url,options);};getApiConnection=async()=>({base:'https://fixture.invalid/v1',token:'synthetic-only'});ConversationModels.configuration=()=>({provider:'api',model:'automation-fixture',effort:'medium'});ConversationModels.resolve=async value=>value;AgentTransport.configure({protocol:'chat'});})()`);
 await evaluate(`(()=>{const prepare=FileContext.prepare;FileContext.prepare=async(...args)=>{await new Promise(resolve=>window.__resumeAutomationPrepare=resolve);FileContext.prepare=prepare;return prepare(...args)};void (async()=>{await fetch('/__project/jobs/now',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:${JSON.stringify(jobId)}})});const claim=await fetch('/__project/jobs/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:${JSON.stringify(jobId)}})}).then(r=>r.json());await ProjectAutomation.executeClaim(claim);window.__automationDone=true;})()})()`);
 await until(()=>evaluate(`typeof __resumeAutomationPrepare==='function'`),'automatic run preparation');
 await evaluate(`state.skills.find(s=>s.id==='skill_beta').instructions='BETA_AFTER_SUBMISSION';__resumeAutomationPrepare()`);
 await until(()=>evaluate(`window.__automationDone===true`),'automatic complete');
 assert.equal(await evaluate(`__automationRequests.length`),1);
 const request=await evaluate(`__automationRequests[0].messages.map(m=>m.content).join('\\n')`);
 assert.match(request,/BETA_ORIGINAL/);assert.match(request,/ALPHA_ORIGINAL/);assert.match(request,/'课程学习'|课程学习/);assert.doesNotMatch(request,/BETA_AFTER_SUBMISSION|DISABLED_NEVER_SENT/);
 assert.ok(request.indexOf('BETA_ORIGINAL')<request.indexOf('ALPHA_ORIGINAL'));
 assert.deepEqual(await evaluate(`state.agentRuns.at(-1).skillIds`),['skill_beta','skill_alpha','builtin-course']);
 assert.equal((await evaluate(`fetch('/__project/jobs').then(r=>r.json()).then(r=>r.jobs)`))[0].attempt.status,'completed');
 checks.push('real scheduler claim executes sendMessage and AgentTransport with every selected skill in order; later catalog edits cannot change the submitted snapshot');
 await evaluate(`state.skills=state.skills.filter(s=>s.id!=='skill_alpha');state.skills.find(s=>s.id==='skill_beta').enabled=false;await saveDocumentDurably();window.__automationDone=false;void(async()=>{await fetch('/__project/jobs/now',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:${JSON.stringify(jobId)}})});const claim=await fetch('/__project/jobs/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:${JSON.stringify(jobId)}})}).then(r=>r.json());await ProjectAutomation.executeClaim(claim);window.__automationDone=true;})()`);
 await until(()=>evaluate(`__automationDone`),'disabled and deleted run');
 assert.deepEqual(await evaluate(`state.agentRuns.at(-1).skillIds`),['builtin-course']);
 const latest=await evaluate(`__automationRequests.at(-1).messages.filter(m=>m.role==='system').map(m=>m.content).join('\\n')`);assert.doesNotMatch(latest,/BETA_AFTER_SUBMISSION|ALPHA_ORIGINAL/);
 assert.deepEqual(await evaluate(`state.conversations.find(c=>c.id==='auto_'+${JSON.stringify(jobId)}).skillIds`),['skill_beta','builtin-course']);
 checks.push('subsequent automatic runs skip removed/disabled instructions while retaining paused selections like normal conversations');
 await evaluate(`await ProjectAutomation.open(state.projects[0]);[...document.querySelectorAll('[data-automation-job] button')].find(b=>b.textContent==='编辑').click()`);
 assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-automation-skill-chip]')].map(e=>e.dataset.automationSkillChip)`),['skill_beta','builtin-course']);
 assert.equal(await evaluate(`document.querySelector('#automation-skill-skill_beta').disabled`),false);
 await click('[data-automation-skill-chip="skill_beta"] button');assert.equal(await evaluate(`document.querySelector('#automation-skill-skill_beta').disabled`),true);
 await evaluate(`document.querySelector('#projectAutomationForm').requestSubmit()`);await until(()=>evaluate(`document.querySelector('.automation-form-status').textContent==='自动任务已保存。'`),'removed saved');
 assert.deepEqual((await evaluate(`fetch('/__project/jobs').then(r=>r.json()).then(r=>r.jobs)`))[0].skillIds,['builtin-course']);
 checks.push('Edit prunes deleted choices, permits removal of an already selected disabled skill and saves only remaining selections');
 assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);checks.push('zero renderer errors and zero external requests');
 const report={passed:checks.length,checks,errors,remote,fixture:TEMP,actualModelCalls:0};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));clearTimeout(watchdog);win.destroy();server.kill();app.exit(0);
})().catch(error=>{console.error(error,errors);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1);});
