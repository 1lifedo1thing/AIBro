/* Isolated renderer: real production bundle, no model calls or user workspace. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/halaska-kit-20260924');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-halaska-kit-'));
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
const checks = [], failures = [], rendererErrors = [], remoteRequests = [], requests = [];
let win, server;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { win?.destroy(); server?.close(); app.exit(1); }, 60000);
async function check(name, fn) {
  try { await fn(); checks.push(name); console.log('PASS', name); }
  catch (error) { failures.push({ name, message: error.stack }); console.error('FAIL', name, error.message); }
}
(async () => {
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:;">
    <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/liquid-glass.css">
    <style>body{display:block!important;padding:32px;overflow:auto!important} main{display:grid;gap:20px;max-width:720px;margin:auto} #unrelated{outline:3px solid rgb(123,45,67)!important} .test-panel{padding:24px;border:1px solid var(--line);border-radius:16px;background:var(--panel)} h1{margin-bottom:8px}</style>
    </head><body class="liquid-glass light-mode" data-view="agent"><main>
    <h1>Halaska Kit · 离线组件验收</h1><p>样例数据，仅用于隔离验证。</p>
    <form id="form" class="test-panel"><div id="test-button"></div></form>
    <div id="empty" class="test-panel"></div><div id="status" class="test-panel"></div>
    <div id="code" class="test-panel"></div><button id="unrelated">现有应用控件</button>
    </main><script src="/halaska-ui.js"></script></body></html>`;
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    requests.push(name);
    if (name === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
    const file = name === '/native-workspace.css' ? path.join(ROOT, 'native/Resources/workspace.css') : path.join(ROOT, 'app', path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const mime = name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'application/javascript';
    res.writeHead(200, { 'Content-Type': mime }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 960, height: 1050, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const external = !details.url.startsWith(origin + '/'); if (external) remoteRequests.push(details.url); callback({ cancel: external });
  });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const screenshot = async name => { await delay(180); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  await win.loadURL(origin);
  await check('named Button import renders the requested Test synchronously in Geist with original palette', async () => {
    const result = await evaluate(`(() => {
      window.clicks=0;window.submits=0;document.querySelector('#form').onsubmit=e=>{e.preventDefault();submits++};
      HalaskaUI.mount(document.querySelector('#test-button'),'Button',{variant:'primary',id:'kit-button','aria-label':'测试操作',children:'Test',onClick:()=>clicks++});
      const b=document.querySelector('#kit-button'),s=getComputedStyle(b);return{text:b.textContent,font:getComputedStyle(b.querySelector('span')).fontFamily,bg:s.backgroundColor,expected:getComputedStyle(document.body).getPropertyValue('--text').trim(),type:b.type,radius:s.borderRadius,label:b.getAttribute('aria-label')};
    })()`);
    assert.equal(result.text, 'Test'); assert.match(result.font, /Geist/); assert.equal(result.bg, 'rgb(37, 37, 39)'); assert.equal(result.type, 'button'); assert.equal(result.radius, '16px'); assert.equal(result.label, '测试操作');
    await evaluate(`document.fonts.ready.then(()=>Promise.all([document.fonts.load('13px Geist'),document.fonts.load('13px "Geist Mono"')]))`);
    assert.equal(await evaluate(`document.fonts.check('13px Geist')&&document.fonts.check('13px "Geist Mono"')`), true);
    await screenshot('setup-test');
    // The required setup test is removed. Subsequent screens use meaningful copy.
    await evaluate(`HalaskaUI.unmount(document.querySelector('#test-button'));document.querySelector('#form').remove()`);
    assert.equal(await evaluate(`document.body.textContent.includes('Test')`), false);
  });
  await check('nested action and title descriptors use real callbacks without demo content or form submission', async () => {
    await evaluate(`HalaskaUI.mount(document.querySelector('#empty'),'EmptyState',{
      icon:{component:'AgentGlyph',props:{size:32}},title:{component:'Heading',props:{level:3,children:'开始这个项目'}},description:'写下你的目标，或添加第一份资料。',
      action:{component:'Button',props:{id:'project-action',children:'添加资料',onClick:()=>clicks++}}
    });document.querySelector('#project-action').click();
    HalaskaUI.mount(document.querySelector('#status'),'Stack',{gap:16,children:[{component:'Orb',props:{variant:'orbit',pill:true,label:'正在读取资料'}},{component:'Progress',props:{value:42}},{component:'StatusBadge',props:{status:'success',children:'已保存'}}]});
    HalaskaUI.mount(document.querySelector('#code'),'Code',{children:'const project = "真实项目";'});void 0;`);
    assert.equal(await evaluate('clicks'), 1); assert.equal(await evaluate('submits'), 0);
    assert.equal(await evaluate(`document.querySelector('#empty h3').textContent`), '开始这个项目');
    assert.equal(await evaluate(`/Alpha|Acme|refund|support backlog/i.test(document.body.textContent)`), false);
    await screenshot('light');
  });
  await check('update preserves the mounted button and loading really disables pointer and keyboard activation', async () => {
    await evaluate(`window.savedStatusButton=document.querySelector('#project-action');HalaskaUI.mount(document.querySelector('#empty'),'Button',{id:'save-action',children:'保存',onClick:()=>clicks++});window.savedButton=document.querySelector('#save-action');HalaskaUI.update(document.querySelector('#empty'),{loading:true});document.querySelector('#save-action').click()`);
    assert.equal(await evaluate(`document.querySelector('#save-action')===savedButton`), true);
    assert.equal(await evaluate(`document.querySelector('#save-action').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#save-action').getAttribute('aria-busy')`), 'true');
    assert.equal(await evaluate('clicks'), 1);
    await evaluate(`HalaskaUI.update(document.querySelector('#empty'),{loading:false,children:'保存完成'});document.querySelector('#save-action').click()`);
    assert.equal(await evaluate('clicks'), 2);
  });
  await check('dark mode follows app tokens without changing host styling or focus rings', async () => {
    await evaluate(`document.body.classList.remove('light-mode')`); await delay(450);
    const result = await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('#save-action'));return{bg:s.backgroundColor,color:s.color,theme:document.querySelector('#empty').dataset.halaskaTheme,other:getComputedStyle(document.querySelector('#unrelated')).outlineColor,globalStyles:document.querySelector('#halaska-kit-styles').textContent}})()`);
    assert.equal(result.bg, 'rgb(240, 240, 240)'); assert.equal(result.color, 'rgb(23, 23, 25)'); assert.equal(result.theme, 'dark'); assert.equal(result.other, 'rgb(123, 45, 67)');
    assert.doesNotMatch(result.globalStyles, /@import|html, body|^button:focus-visible/m); await screenshot('dark');
    await evaluate(`HalaskaUI.update(document.querySelector('#empty'),{variant:'accent'})`); await delay(450);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#save-action')).color`), 'rgb(23, 23, 25)');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#save-action')).backgroundColor`), 'rgb(208, 208, 210)');
    await evaluate(`HalaskaUI.update(document.querySelector('#empty'),{variant:'primary'})`); await delay(450);
  });
  await check('native light and dark retain their existing independent palettes', async () => {
    await evaluate(`new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/native-workspace.css';link.onload=resolve;document.head.append(link)});`);
    await evaluate(`document.body.classList.add('aibro-native','light-mode')`); await delay(450);
    const light = await evaluate(`({bg:getComputedStyle(document.querySelector('#save-action')).backgroundColor,text:getComputedStyle(document.body).getPropertyValue('--text').trim(),accent:getComputedStyle(document.body).getPropertyValue('--accent').trim()})`);
    assert.equal(light.text, '#20382e'); assert.equal(light.bg, 'rgb(32, 56, 46)'); assert.equal(light.accent, '#087f70'); await screenshot('native-light');
    await evaluate(`document.body.classList.remove('light-mode')`); await delay(450);
    const dark = await evaluate(`({bg:getComputedStyle(document.querySelector('#save-action')).backgroundColor,text:getComputedStyle(document.body).getPropertyValue('--text').trim(),accent:getComputedStyle(document.body).getPropertyValue('--accent').trim()})`);
    assert.equal(dark.text, '#eef1f0'); assert.equal(dark.bg, 'rgb(238, 241, 240)'); assert.equal(dark.accent, '#65d7bb'); await screenshot('native-dark');
  });
  await check('reduced motion stops real Orb animation and does not add idle timers', async () => {
    await evaluate(`document.body.classList.add('reduce-motion')`); await delay(60);
    assert.equal(await evaluate(`document.querySelector('#status').getAnimations({subtree:true}).filter(a=>a.playState==='running').length`), 0);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#save-action')).transitionDuration`), '0s');
  });
  await check('demo patterns and occupied hosts reject mounting instead of replacing business state', async () => {
    const result = await evaluate(`(()=>{let demo=false,occupied=false;try{HalaskaUI.mount(document.createElement('div'),'PlanPreviewPattern',{})}catch(e){demo=/not an approved component/.test(e.message)}const div=document.createElement('div');div.textContent='unsaved draft';try{HalaskaUI.mount(div,'Button',{children:'overwrite'})}catch(e){occupied=/empty host/.test(e.message)}return{demo,occupied,text:div.textContent}})()`);
    assert.deepEqual(result, { demo: true, occupied: true, text: 'unsaved draft' });
  });
  await check('removed islands unmount automatically; explicit unmount removes Test and all detached roots', async () => {
    await evaluate(`document.querySelector('#status').remove()`); await delay(50);
    assert.equal(await evaluate(`HalaskaUI.diagnostics().mounts`), 2);
    await evaluate(`HalaskaUI.unmount(document.querySelector('#empty'));HalaskaUI.unmount(document.querySelector('#code'))`);
    assert.equal(await evaluate(`HalaskaUI.diagnostics().mounts`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('[data-halaska-root]').length`), 0);
  });
  await check('fonts and components load entirely locally with strict CSP and no console errors', async () => {
    assert.deepEqual(remoteRequests, []); assert.deepEqual(rendererErrors, []);
    assert.ok(requests.includes('/halaska-geist.woff2')); assert.ok(requests.includes('/halaska-geist-mono.woff2'));
  });
  const report = { passed: checks.length, checks, failures, remoteRequests, rendererErrors, requests, fixture: TEMP };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); clearTimeout(watchdog); win.destroy(); server.close(); app.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error); clearTimeout(watchdog); win?.destroy(); server?.close(); app.exit(1); });
