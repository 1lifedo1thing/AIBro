/* Actual production Kit + permissions controller in an isolated renderer. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/halaska-controls-20260924');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-kit-controls-'));
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
let win, server; const checks = [], failures = [], errors = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { win?.destroy(); server?.close(); app.exit(1); }, 90000);
(async () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/liquid-glass.css"><style>body{display:block!important;padding:24px}main{display:grid;gap:22px;max-width:600px;margin:auto}</style></head><body class="liquid-glass light-mode" data-view="agent"><main><button id="composerPermission">权限</button><div id="controls"></div><div id="tabs"></div><div id="segments"></div><div id="radio"></div></main><script src="/halaska-ui.js"></script><script src="/permission-policy.js"></script><script src="/permission-picker.js"></script></body></html>`;
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.writeHead(200, {'Content-Type': 'text/html'}); return res.end(html); }
    const file = path.join(ROOT, 'app', path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'application/javascript'}); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await app.whenReady();
  win = new BrowserWindow({show:false,width:900,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('console-message', event => { if(event.level === 'error') errors.push(event.message); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (details, callback) => callback({cancel:!details.url.startsWith(origin+'/')}));
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const shot = async name => { await wait(200); fs.writeFileSync(path.join(OUT, name+'.png'),(await win.webContents.capturePage()).toPNG()); };
  const key = async keyCode => { keyCode=keyCode.replace(/^Arrow/, ''); win.webContents.focus(); win.webContents.sendInputEvent({type:'keyDown',keyCode}); win.webContents.sendInputEvent({type:'keyUp',keyCode}); await wait(30); };
  async function step(name, fn) { try { await fn(); checks.push(name); console.log('PASS', name); } catch(e) { failures.push({name,error:e.stack}); console.error('FAIL',name,e.message); } }
  await win.loadURL(origin);
  await evaluate(`window.conversation={id:'isolated',permissionMode:'smart',reviewerHalted:true,reviewerDenials:3};window.saved=[];window.changes=0;window.saveMode='resolve';window.saveResolve=null;WorkstationPermissions.init({getConversation:()=>conversation,save:()=>{saved.push(JSON.parse(JSON.stringify(conversation)));if(saveMode==='pending')return new Promise(r=>saveResolve=r);if(saveMode==='reject')return Promise.reject(Error('测试磁盘未能保存'));return Promise.resolve(true)},onChange:()=>changes++});`);
  await step('permission choice uses real Kit structure and controlled current state', async () => {
    await evaluate(`document.querySelector('#composerPermission').focus();document.querySelector('#composerPermission').click()`);
    assert.equal(await evaluate(`document.querySelector('.permission-picker [data-halaska-root]').dataset.halaskaRoot`),'KitPermissionPicker');
    assert.equal(await evaluate(`document.querySelectorAll('.permission-choice').length`),4);
    assert.equal(await evaluate(`document.activeElement.dataset.mode`),'smart');
    assert.equal(await evaluate(`document.querySelector('.permission-choice[data-mode=smart]').getAttribute('aria-pressed')`),'true');
    assert.match(await evaluate(`document.querySelector('.permission-picker').textContent`),/浏览器默认自动执行/);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.permission-choice')).borderRadius`),'16px');
    await shot('permission-light');
  });
  await step('reviewer switch is a real keyboard input and persists its exact existing semantics', async () => {
    await evaluate(`document.querySelector('#reviewerApprove').focus()`); await key('Space'); await wait(40);
    assert.deepEqual(await evaluate(`({approve:conversation.reviewerApprove,halted:'reviewerHalted' in conversation,denials:'reviewerDenials' in conversation,checked:document.querySelector('#reviewerApprove').checked,saves:saved.length})`),{approve:true,halted:false,denials:false,checked:true,saves:1});
    assert.equal(await evaluate(`document.querySelectorAll('.permission-picker button[role=switch][tabindex="-1"]').length`),1);
    assert.equal(await evaluate(`document.querySelector('.permission-picker').open`),true);
  });
  await step('choice waits for persistence and ignores repeated changes while saving', async () => {
    await evaluate(`saveMode='pending';document.querySelector('.permission-choice[data-mode=full]').click();document.querySelector('.permission-choice[data-mode=request]').click()`);
    assert.equal(await evaluate(`document.querySelector('.permission-picker').open`),true);
    assert.equal(await evaluate(`[...document.querySelectorAll('.permission-choice')].every(b=>b.disabled)`),true);
    assert.equal(await evaluate(`conversation.permissionMode`),'full');
    assert.equal(await evaluate(`saved.length`),2);
    await evaluate(`saveMode='resolve';saveResolve(true)`); await wait(30);
    assert.equal(await evaluate(`document.querySelector('.permission-picker')`),null);
    assert.equal(await evaluate(`document.querySelector('#composerPermission').textContent`),'完全访问');
    assert.equal(await evaluate(`document.activeElement.id`),'composerPermission');
  });
  await step('failed durable save restores mode, shows error and keeps picker usable', async () => {
    await click('#composerPermission'); await evaluate(`saveMode='reject';document.querySelector('.permission-choice[data-mode=request]').click()`); await wait(40);
    assert.equal(await evaluate(`conversation.permissionMode`),'full');
    assert.match(await evaluate(`document.querySelector('[role=alert]').textContent`),/测试磁盘未能保存/);
    assert.equal(await evaluate(`document.querySelector('.permission-choice[data-mode=full]').getAttribute('aria-pressed')`),'true');
    await evaluate(`saveMode='resolve';document.querySelector('.permission-choice[data-mode=legacy]').click()`); await wait(40);
    assert.equal(await evaluate(`'permissionMode' in conversation`),false);
    assert.equal(await evaluate(`document.querySelector('.permission-picker')`),null);
  });
  await step('Escape and backdrop close without writes and restore opener focus', async () => {
    await click('#composerPermission'); const count = await evaluate('saved.length'); await key('Escape');
    assert.equal(await evaluate(`document.querySelector('.permission-picker')`),null);
    assert.equal(await evaluate(`document.activeElement.id`),'composerPermission');
    await click('#composerPermission');
    win.webContents.sendInputEvent({type:'mouseDown',x:2,y:2,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:2,y:2,button:'left',clickCount:1});await wait(40);
    assert.equal(await evaluate(`document.querySelector('.permission-picker')`),null); assert.equal(await evaluate('saved.length'),count);
  });
  await step('dark and narrow permission dialog stays inside viewport with reachable actions', async () => {
    await evaluate(`document.body.classList.remove('light-mode');document.querySelector('#composerPermission').click()`); win.setSize(380,640); await wait(250);
    const geometry = await evaluate(`(()=>{const d=document.querySelector('.permission-picker'),r=d.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:d.scrollHeight>d.clientHeight,font:getComputedStyle(d.querySelector('.permission-choice')).fontFamily,theme:d.querySelector('[data-halaska-root]').dataset.halaskaTheme}})()`);
    assert.ok(geometry.left>=0&&geometry.right<=geometry.width&&geometry.top>=0&&geometry.bottom<=geometry.height);
    assert.match(geometry.font,/Geist/);assert.equal(geometry.theme,'dark');
    await shot('permission-dark-narrow'); await key('Escape');win.setSize(900,900);
  });
  await step('read approval resolves once; late abort does not reopen or change result', async () => {
    await evaluate(`window.readResults=[];window.readAbort=new AbortController();WorkstationPermissions.confirmRead({title:'允许读取项目资料',detail:'仅本次读取已连接目录中的设计文档。',signal:readAbort.signal}).then(v=>readResults.push(v));void 0;`);
    assert.equal(await evaluate(`document.querySelector('.permission-read [data-halaska-root]').dataset.halaskaRoot`),'KitReadConfirmation');
    assert.equal(await evaluate(`document.activeElement.textContent`),'取消');
    await shot('read-confirmation'); await evaluate(`[...document.querySelectorAll('.permission-read button')].find(b=>b.textContent==='允许本次读取').click();readAbort.abort()`);await wait(30);
    assert.deepEqual(await evaluate(`readResults`),[true]);assert.equal(await evaluate(`document.querySelector('.permission-read')`),null);
  });
  await step('pending or already-aborted reads cancel exactly once and remove their dialog', async () => {
    await evaluate(`readResults=[];readAbort=new AbortController();WorkstationPermissions.confirmRead({title:'读取目录',detail:'取消测试',signal:readAbort.signal}).then(v=>readResults.push(v));readAbort.abort();readAbort.abort();`);await wait(30);
    assert.deepEqual(await evaluate(`readResults`),[false]);assert.equal(await evaluate(`document.querySelector('.permission-read')`),null);
    assert.equal(await evaluate(`WorkstationPermissions.confirmRead({title:'已取消',signal:readAbort.signal})`),false);
    await evaluate(`readResults=[];WorkstationPermissions.confirmRead({title:'读取目录',detail:'Escape 测试'}).then(v=>readResults.push(v));void 0;`);await key('Escape');assert.deepEqual(await evaluate('readResults'),[false]);
  });
  await step('Kit tabs and segmented controls expose real controlled keyboard selection', async () => {
    await evaluate(`window.navChanges=[];window.navOptions=[{value:'preview',label:'预览',controls:'preview-panel'},{value:'edit',label:'编辑',controls:'edit-panel'},{value:'blocked',label:'禁用',disabled:true}];HalaskaUI.mount(document.querySelector('#tabs'),'KitTabs',{options:navOptions,value:'preview',label:'文档模式',onChange:v=>{navChanges.push(v);HalaskaUI.update(document.querySelector('#tabs'),{value:v})}});HalaskaUI.mount(document.querySelector('#segments'),'KitSegmentedControl',{options:navOptions,value:'preview',onChange:v=>{navChanges.push(v);HalaskaUI.update(document.querySelector('#segments'),{value:v})}});document.querySelector('#tabs [role=tab]').focus();`);
    await key('ArrowRight'); assert.equal(await evaluate(`document.querySelector('#tabs [aria-selected=true]').dataset.value`),'edit');assert.equal(await evaluate(`document.activeElement.getAttribute('aria-controls')`),'edit-panel');
    await key('ArrowRight');assert.equal(await evaluate(`document.activeElement.dataset.value`),'preview');
    await evaluate(`document.querySelector('#segments [role=radio]').focus()`);await key('End');assert.equal(await evaluate(`document.querySelector('#segments [aria-checked=true]').dataset.value`),'edit');
    assert.equal(await evaluate(`document.querySelectorAll('#tabs [tabindex="0"]').length`),1);await shot('controlled-navigation');
  });
  await step('Checkbox and RadioGroup keep upstream visuals with native labels, Space and arrows', async () => {
    await evaluate(`window.checkboxValue=false;HalaskaUI.mount(document.querySelector('#controls'),'KitCheckbox',{id:'real-check',label:'保存到项目',checked:false,onChange:v=>{checkboxValue=v;HalaskaUI.update(document.querySelector('#controls'),{checked:v})}});HalaskaUI.mount(document.querySelector('#radio'),'KitRadioGroup',{label:'范围',options:['本次','本对话'],value:'本次',onChange:v=>HalaskaUI.update(document.querySelector('#radio'),{value:v})});document.querySelector('#real-check').focus()`);await key('Space');
    assert.equal(await evaluate(`checkboxValue&&document.querySelector('#real-check').checked`),true);
    await evaluate(`document.querySelector('#radio input').focus()`);await key('ArrowDown');assert.equal(await evaluate(`document.querySelector('#radio input:checked').value`),'本对话');
  });
  await step('search preserves composition and sends a single final Chinese query with a native labelled filter', async () => {
    await evaluate(`window.searchCalls=[];HalaskaUI.mount(document.querySelector('#controls'),'KitSearchInput',{value:'',label:'搜索资料',attributes:{'data-cui-search':'test'},onChange:v=>{searchCalls.push(v);HalaskaUI.update(document.querySelector('#controls'),{value:v})}});HalaskaUI.mount(document.querySelector('#radio'),'KitSelect',{label:'资料类型',options:[{value:'all',label:'全部类型'},{value:'note',label:'笔记'}],value:'all',attributes:{'data-cui-type':'test'},onChange:v=>HalaskaUI.update(document.querySelector('#radio'),{value:v})});window.searchField=document.querySelector('[data-cui-search]');searchField.focus();searchField.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(searchField,'设计');searchField.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',isComposing:true,data:'设计'}));`);
    assert.deepEqual(await evaluate('searchCalls'),[]);assert.equal(await evaluate('searchField.value'),'设计');
    await evaluate(`searchField.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'设计'}))`);await wait(30);
    assert.deepEqual(await evaluate('searchCalls'),['设计']);assert.equal(await evaluate('searchField.value'),'设计');
    await click('#controls button');await wait(30);assert.deepEqual(await evaluate('searchCalls'),['设计','']);assert.equal(await evaluate('document.activeElement===searchField'),true);
    await evaluate(`document.querySelector('[data-cui-type]').value='note';document.querySelector('[data-cui-type]').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('[data-cui-type]').value`),'note');assert.equal(await evaluate(`document.querySelector('[data-cui-type]').getAttribute('aria-label')`),'资料类型');assert.equal(await evaluate(`document.querySelector('#radio button').tabIndex`),-1);
  });
  await step('controls honor reduced motion and produce no renderer errors', async () => {
    await evaluate(`document.body.classList.add('reduce-motion')`); await wait(40);
    assert.equal(await evaluate(`document.querySelector('#tabs').getAnimations({subtree:true}).filter(a=>a.playState==='running').length`),0);
    assert.deepEqual(errors,[]);
  });
  await step('English permission chrome, busy and error states render explicitly without DOM translation', async () => {
    await evaluate(`document.documentElement.lang='en';saveMode='resolve';WorkstationPermissions.render(conversation);document.querySelector('#composerPermission').click()`);
    const english=await evaluate(`({text:document.querySelector('.permission-picker').textContent,aria:document.querySelector('.permission-picker').getAttribute('aria-label'),reviewer:document.querySelector('#reviewerApprove').getAttribute('aria-label'),close:document.querySelector('.kit-dialog-heading button').getAttribute('aria-label')})`);
    assert.doesNotMatch(english.text,/[\u3400-\u9fff]/);assert.match(english.text,/Operation permissions/);assert.match(english.text,/Ask for approval/);assert.equal(english.aria,'This chat’s permissions');assert.equal(english.close,'Close permission picker');assert.match(english.reviewer,/reviewer/);
    await evaluate(`document.documentElement.lang='zh-CN';document.dispatchEvent(new CustomEvent('workstation-language-change'));`);
    assert.match(await evaluate(`document.querySelector('.permission-picker').textContent`),/请求批准/);assert.equal(await evaluate(`document.querySelector('.permission-picker').getAttribute('aria-label')`),'当前对话的操作权限');
    await evaluate(`document.documentElement.lang='en';document.dispatchEvent(new CustomEvent('workstation-language-change'));`);assert.doesNotMatch(await evaluate(`document.querySelector('.permission-picker').textContent`),/[\u3400-\u9fff]/);
    await evaluate(`saveMode='pending';document.querySelector('.permission-choice[data-mode=full]').click()`);assert.equal(await evaluate(`document.querySelector('.permission-picker [role=status]').textContent`),'Saving permissions…');
    await evaluate(`saveMode='resolve';saveResolve(false)`);await wait(30);
    assert.match(await evaluate(`document.querySelector('.permission-picker [role=alert]').textContent`),/Changes have not been saved/);assert.match(await evaluate(`document.querySelector('.permission-picker [role=alert]').textContent`),/Local saving did not finish/);
    await shot('permission-english');await key('Escape');
  });
  await step('English read confirmation localizes known templates while preserving project names and custom user text', async () => {
    await evaluate(`window.englishRead=null;WorkstationPermissions.confirmRead({title:'读取项目的最新文件',detail:'读取「我的项目 / 设计」关联目录中的少量代码与说明，并发送给当前对话的模型分析。'}).then(v=>englishRead=v);void 0`);
    assert.equal(await evaluate(`document.querySelector('.permission-read h3').textContent`),'Read the latest project files');assert.match(await evaluate(`document.querySelector('.permission-read p').textContent`),/“我的项目 \/ 设计”/);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.permission-read button')].map(b=>b.textContent)`),['Cancel','Allow this read']);
    await evaluate(`document.documentElement.lang='zh-CN';document.dispatchEvent(new CustomEvent('workstation-language-change'));`);assert.equal(await evaluate(`document.querySelector('.permission-read h3').textContent`),'读取项目的最新文件');assert.match(await evaluate(`document.querySelector('.permission-read p').textContent`),/「我的项目 \/ 设计」/);assert.equal(await evaluate(`document.querySelector('.permission-read button').textContent`),'取消');
    await evaluate(`document.documentElement.lang='en';document.dispatchEvent(new CustomEvent('workstation-language-change'));`);assert.equal(await evaluate(`document.querySelector('.permission-read h3').textContent`),'Read the latest project files');
    await shot('read-english');await key('Escape');assert.equal(await evaluate('englishRead'),false);
    await evaluate(`WorkstationPermissions.confirmRead({title:'用户原始标题',detail:'这段用户文字应保持不变。'});void 0`);assert.equal(await evaluate(`document.querySelector('.permission-read h3').textContent`),'用户原始标题');assert.equal(await evaluate(`document.querySelector('.permission-read p').textContent`),'这段用户文字应保持不变。');await key('Escape');
  });
  await step('English default input labels and clear control preserve Chinese search values', async () => {
    await evaluate(`HalaskaUI.unmount(document.querySelector('#controls'));HalaskaUI.mount(document.querySelector('#controls'),'KitSearchInput',{value:'原始中文查询',onChange:()=>{}});HalaskaUI.unmount(document.querySelector('#radio'));HalaskaUI.mount(document.querySelector('#radio'),'KitSelect',{options:['用户选项'],value:'用户选项'});HalaskaUI.mount(document.querySelector('#tabs'),'KitTabs',{options:['First','Second'],value:'First'});HalaskaUI.mount(document.querySelector('#segments'),'KitSegmentedControl',{options:['One','Two'],value:'One'});void 0;`);
    assert.deepEqual(await evaluate(`(()=>{const input=document.querySelector('#controls input');return{value:input.value,label:input.getAttribute('aria-label'),placeholder:input.placeholder,clear:document.querySelector('#controls button').getAttribute('aria-label'),select:document.querySelector('#radio select').getAttribute('aria-label'),option:document.querySelector('#radio select').value}})()`),{value:'原始中文查询',label:'Search',placeholder:'Search…',clear:'Clear search',select:'Select',option:'用户选项'});
    assert.equal(await evaluate(`document.querySelector('#tabs [role=tablist]').getAttribute('aria-label')`),'Switch page');assert.equal(await evaluate(`document.querySelector('#segments [role=radiogroup]').getAttribute('aria-label')`),'Switch view');
    assert.deepEqual(errors,[]);
  });
  const report = {passed:checks.length,checks,failures,errors,fixture:TEMP};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));clearTimeout(watchdog);win.destroy();server.close();app.exit(failures.length?1:0);
})().catch(error=>{console.error(error);clearTimeout(watchdog);win?.destroy();server?.close();app.exit(1)});
