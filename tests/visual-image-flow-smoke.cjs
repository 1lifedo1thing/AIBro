/* Actual production CodeMirror/Crepe adapter acceptance. Synthetic upload ACKs
 * and images; no user workspace, external requests or native acceptance claim.
 * Run serially after build:editors: electron tests/visual-image-flow-smoke.cjs */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = process.env.AIBRO_QA_OUTPUT || path.join(ROOT, 'test-results/document-images-20260930/editor-renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-image-editors-'));
app.setPath('userData', path.join(TEMP, 'profile')); fs.mkdirSync(OUT, { recursive: true });
let server, win, origin, stopping = false;
const checks = [], failures = [], rendererErrors = [], externalRequests = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = value => win.webContents.executeJavaScript(typeof value === 'function' ? `(${value.toString()})()` : value, true);
async function until(fn, label, timeout = 6000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(20); } throw Error('Timed out: ' + label); }
async function check(name, fn) { try { const observation = await fn(); checks.push({ name, observation }); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack || String(error) }); console.error('FAIL', name, error.message); } }
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: '150 second timeout' }); void finish(1); }, 150000);
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(TEMP, { force: true, recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ scope: 'Isolated production editor renderer; upload ACKs and PNG bytes synthetic, not native or backend acceptance', passed: checks.length, checks, failures, rendererErrors, externalRequests, userWorkspaceLoaded: false, modelCalls: 0, temporaryProfileRemoved: !fs.existsSync(TEMP) }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failures, rendererErrors, externalRequests }, null, 2)); app.exit(code);
}
function setup() {
  window.editorHost = document.querySelector('#editor'); window.editor = null;
  window.calls = []; window.errors = []; window.busy = []; window.changes = [];
  window.imageFile = (name = 'one.png', type = 'image/png') => new File([new Uint8Array([1, 2, 3])], name, { type });
  window.gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  window.assertTrue = (value, message) => { if (!value) throw Error(message); };
  window.create = async (kind, extra = {}) => {
    await editor?.destroy(); editorHost.replaceChildren(); calls = []; errors = []; busy = []; changes = [];
    editor = (kind === 'source' ? DocumentSourceEditor : DocumentVisualEditor).mount(editorHost, {
      value: 'Alpha paragraph.\n\nBeta paragraph.\n',
      onError: error => errors.push(error.message), onImageBusy: count => busy.push(count), onChange: value => changes.push(value),
      onUploadImage: async file => { calls.push(file.name); return { url: '/__files/' + file.name, alt: file.name }; },
      resolveImageUrl: () => '/fixture.png', ...extra,
    });
    return editor.ready;
  };
}
(async () => {
  const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\'; font-src \'self\' data:; connect-src \'self\'"><link rel="stylesheet" href="/styles.css"><style>body{display:block!important;overflow:auto!important;height:auto!important;min-width:0!important;padding:16px!important}#editor{max-width:860px;margin:auto;min-height:450px} .document-source-editor{height:600px!important}</style></head><body class="light-mode reduced-motion"><section id="editor"></section><script src="/document-editors.js"></script></body></html>';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDfsAAAAASUVORK5CYII=', 'base64');
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(html); }
    if (pathname === '/fixture.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(png); }
    const file = path.resolve(ROOT, 'app', '.' + pathname), type = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)];
    if (!file.startsWith(path.join(ROOT, 'app') + path.sep) || !type || !fs.existsSync(file)) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'Content-Type': type }); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { const external = !details.url.startsWith(origin + '/'); if (external) externalRequests.push(details.url); callback({ cancel: external }); });
  await win.loadURL(origin); await evaluate('DocumentEditors.ensure()'); await evaluate(setup);
  for (const kind of ['visual', 'source']) {
    await check(kind + ': upload ACK and mapped insertion survive concurrent typing and retain canonical Markdown', async () => {
      await evaluate(`create(${JSON.stringify(kind)}, {onUploadImage: file => {calls.push(file.name); return imageGate.promise.then(()=>({url:'/__files/'+file.name,alt:file.name}));}})`);
      await evaluate(() => { window.imageGate = gate(); const at = editor.getValue().indexOf('Beta'); assertTrue(editor.setSelectionRange(at), 'Source caret maps'); window.job = editor.insertImageFiles([imageFile('a.png'), imageFile('b.png')]); window.flushDone = false; window.flushJob = editor.flushPending().then(value => { flushDone = true; return value; }); });
      assert.equal(await evaluate('editor.isImageBusy()'), true); assert.equal(await evaluate('flushDone'), false);
      assert.equal(await evaluate("editor.getValue().includes('/__files/')"), false);
      await evaluate(() => { editor.setSelectionRange(0); editor.focus(); }); await win.webContents.insertText('Concurrent ');
      await until(() => evaluate("editor.getValue().startsWith('Concurrent ')") , 'real typing during upload');
      await evaluate(() => { imageGate.resolve(); }); assert.equal(await evaluate('job'), true); assert.equal(await evaluate('flushJob'), true);
      const result = await evaluate(() => ({ value: editor.getValue(), busy, errors, decorations: editorHost.querySelectorAll('.document-image-upload,.source-image-upload').length, images: [...editorHost.querySelectorAll('img')].map(image => ({ src: image.getAttribute('src'), alt: image.getAttribute('alt') })) }));
      assert.ok(result.value.startsWith('Concurrent ')); assert.ok(result.value.indexOf('/__files/a.png') < result.value.indexOf('/__files/b.png')); assert.ok(result.value.includes('Beta paragraph.')); assert.equal(result.value.includes('/fixture.png'), false); assert.equal(result.decorations, 0); assert.equal(result.busy.at(-1), 0); assert.deepEqual(result.errors, []);
      if (kind === 'visual') { await until(() => evaluate("editorHost.querySelectorAll('img[src=\"/fixture.png\"]').length>=2"), 'resolved image DOM'); }
      return { typingPreserved: true, batchOrder: true, canonicalReferences: true, flushAcknowledged: true };
    });
    await check(kind + ': rejected upload clears loading, changes no Markdown and can retry', async () => {
      await evaluate(`create(${JSON.stringify(kind)}, {onUploadImage: async()=>{throw Error('injected durable save failure')}})`);
      const before = await evaluate('editor.getValue()'); const result = await evaluate(async () => { const job = editor.insertImageFiles([imageFile()]); const flush = editor.flushPending(); return { job: await job, flush: await flush, value: editor.getValue(), errors, pending: editorHost.querySelectorAll('.document-image-upload,.source-image-upload').length }; });
      assert.equal(result.job, false); assert.equal(result.flush, false); assert.equal(result.value, before); assert.equal(result.pending, 0); assert.match(result.errors[0], /durable save failure/);
      await evaluate(`create(${JSON.stringify(kind)})`); assert.equal(await evaluate('editor.insertImageFiles([imageFile()])'), true); return { rejectedAcknowledgment: true, sourceUnchanged: true, retry: true };
    });
    await check(kind + ': paste and drop share actual upload path, unsafe formats do not insert', async () => {
      await evaluate(`create(${JSON.stringify(kind)})`);
      await evaluate(() => { const content = editorHost.querySelector('[contenteditable=true]'); const transfer = new DataTransfer(); transfer.items.add(imageFile('pasted.png')); content.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); });
      await until(() => evaluate("editor.getValue().includes('/__files/pasted.png')"), 'paste upload');
      await evaluate(() => { const content = editorHost.querySelector('[contenteditable=true]'); const transfer = new DataTransfer(); transfer.items.add(imageFile('dropped.webp', 'image/webp')); const box = content.getBoundingClientRect(); content.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 15, clientY: box.top + 10 })); });
      await until(() => evaluate("editor.getValue().includes('/__files/dropped.webp')"), 'drop upload');
      const before = await evaluate('editor.getValue()'); assert.equal(await evaluate("editor.insertImageFiles([imageFile('bad.svg','image/svg+xml')])"), false); assert.equal(await evaluate('editor.getValue()'), before);
      return { paste: true, drop: true, rejectedSVG: true };
    });
    await check(kind + ': host replacement and destroy prevent late writes or callbacks', async () => {
      await evaluate(`create(${JSON.stringify(kind)}, {onUploadImage:()=>imageGate.promise})`);
      await evaluate(() => { window.imageGate = gate(); window.job = editor.insertImageFiles([imageFile()]); }); await sleep(10);
      await evaluate(() => { editor.setValue('Replacement document.\n'); imageGate.resolve({ url: '/__files/stale.png' }); }); assert.equal(await evaluate('job'), false); await sleep(40); assert.equal(await evaluate('editor.getValue()'), 'Replacement document.\n');
      await evaluate(`create(${JSON.stringify(kind)}, {onUploadImage:()=>imageGate.promise})`);
      await evaluate(() => { window.imageGate = gate(); window.job = editor.insertImageFiles([imageFile()]); }); await sleep(10);
      await evaluate(() => { editor.destroy(); window.afterDestroy = { changes: changes.length, errors: errors.length, busy: busy.length }; imageGate.resolve({ url: '/__files/stale.png' }); }); assert.equal(await evaluate('job'), false); await sleep(40);
      const result = await evaluate(() => ({ afterDestroy, after: { changes: changes.length, errors: errors.length, busy: busy.length }, dom: editorHost.childNodes.length })); assert.deepEqual(result.after, result.afterDestroy); assert.equal(result.dom, 0); return { replacementSafe: true, lateCallbacks: 0 };
    });
    await check(kind + ': upload completion waits for composition instead of replacing active IME text', async () => {
      await evaluate(`create(${JSON.stringify(kind)}, {onUploadImage:()=>imageGate.promise})`);
      await evaluate(() => { window.imageGate = gate(); window.job = editor.insertImageFiles([imageFile()]); }); await sleep(10);
      await evaluate(() => { editorHost.querySelector('[contenteditable=true]').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); imageGate.resolve({ url: '/__files/ime.png' }); }); await sleep(40);
      assert.equal(await evaluate("editor.getValue().includes('/__files/ime.png')"), false); assert.equal(await evaluate('editor.isImageBusy()'), true);
      await evaluate(() => editorHost.querySelector('[contenteditable=true]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
      assert.equal(await evaluate('job'), true); return { compositionGated: true, realOSIME: false };
    });
  }
  await check('visual toolbar selects image files without inserting an empty upstream image block', async () => {
    await evaluate("create('visual')"); const before = await evaluate('editor.getValue()');
    await evaluate(() => { window.pickerClicks = 0; editorHost.querySelector('input[aria-label="选择文档图片"]').click = () => { pickerClicks++; }; editorHost.querySelector('[data-document-command="image"]').closest('.top-bar-item').click(); });
    assert.equal(await evaluate('pickerClicks'), 1); assert.equal(await evaluate('editor.getValue()'), before);
    await evaluate(() => { const picker = editorHost.querySelector('input[aria-label="选择文档图片"]'), transfer = new DataTransfer(); transfer.items.add(imageFile('picked.png')); picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    await until(() => evaluate("editor.getValue().includes('/__files/picked.png')"), 'picker insert');
    fs.writeFileSync(path.join(OUT, 'visual-inserted.png'), (await win.webContents.capturePage()).toPNG());
    return { fileSelectionAction: true, noPlaceholderOnCanceledPicker: true };
  });
  await check('source inserted standard images reopen in visual editing and readonly without null captions', async () => {
    await evaluate("create('source')");
    assert.equal(await evaluate("editor.insertImageFiles([imageFile('standard.png')])"), true);
    const raw = await evaluate('editor.getValue()'); assert.match(raw, /!\[standard\.png\]\(<\/__files\/standard\.png>\)/);
    for (let cycle = 0; cycle < 2; cycle++) {
      assert.equal(await evaluate(`create('visual', {value:${JSON.stringify(raw)}})`), true);
      await until(() => evaluate("!!editorHost.querySelector('img[src=\"/fixture.png\"]')"), 'source image rendered in visual');
      assert.equal(await evaluate('editor.getValue()'), raw);
      await evaluate(() => { editor.setDisabled(true); }); await sleep(40);
      assert.equal(await evaluate('editor.getValue()'), raw);
      await evaluate(() => { editor.setDisabled(false); }); await sleep(40);
      assert.deepEqual(await evaluate('errors'), []);
    }
    // A regular source image with a title must preserve the actual caption too.
    const titled = 'Before.\n\n![Diagram](/__files/titled.png "Exact caption")\n\nAfter.\n';
    assert.equal(await evaluate(`create('visual', {value:${JSON.stringify(titled)}})`), true);
    await until(() => evaluate("!!editorHost.querySelector('img[alt=\"Exact caption\"]')"), 'named caption preserved');
    await evaluate(() => { editor.setDisabled(true); }); await sleep(40);
    assert.equal(await evaluate('editor.getValue()'), titled); assert.deepEqual(await evaluate('errors'), []);
    return { sourceToVisual: true, visualReopenCycles: 2, readonlyRoundTrips: 2, namedTitlePreserved: true };
  });
  await check('offline renderer has no network or unhandled errors', async () => { assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []); return { externalRequests: 0, rendererErrors: 0 }; });
  await finish(failures.length || rendererErrors.length || externalRequests.length ? 1 : 0);
})().catch(error => { failures.push({ name: 'runner', error: error.stack || String(error) }); void finish(1); });
