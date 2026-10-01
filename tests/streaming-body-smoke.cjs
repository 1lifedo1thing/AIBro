/* Real Chromium DOM acceptance, isolated from the user workspace/provider.
 * Uses the exact production Markdown parser and production decoration/preview.
 * Run serially: node_modules/.bin/electron tests/streaming-body-smoke.cjs
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/streaming-body-20260929');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-streaming-body-'));
app.setPath('userData', path.join(TEMP, 'profile')); fs.mkdirSync(OUT, { recursive: true });
const source = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
const start = source.indexOf('function renderRichText('), end = source.indexOf('\nfunction renderMessage(', start);
assert.ok(start >= 0 && end > start, 'Locate the actual production Markdown parser');
const renderer = source.slice(start, end), checks = [], failures = [], errors = [], externalRequests = [];
let win, server, origin, stopping = false;
const evaluate = value => win.webContents.executeJavaScript(value, true);
function report() { fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, rendererErrors: errors, externalRequests, modelCalls: 0, userWorkspaceLoaded: false, parserSha256: crypto.createHash('sha256').update(renderer).digest('hex'), temporaryProfileRemoved: !fs.existsSync(TEMP) }, null, 2)); }
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: 'Timed out after 90 seconds' }); finish(1); }, 90000);
app.on('window-all-closed', () => {});
app.on('quit', () => { fs.rmSync(TEMP, { recursive: true, force: true }); report(); });
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(TEMP, { recursive: true, force: true }); report();
  setImmediate(() => app.exit(code));
}
async function check(name, fn) { try { const value = await fn(); checks.push({ name, observation: value }); } catch (error) { failures.push({ name, error: error.stack || String(error) }); } }
function initialize() {
  window.WorkstationI18n = { getLanguage: () => 'zh' };
  window.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.state = { notes: [{ id: 'n1', title: '合成资料一', content: 'Saved excerpt', updatedAt: 1 }, { id: 'n2', title: '合成资料二', content: 'Second excerpt', updatedAt: 1 }], imports: [], projects: [], agentRuns: [] };
  window.run = { id: 'synthetic-run', status: 'running' }; state.agentRuns = [run];
  window.message = { id: 'synthetic-answer', role: 'agent', live: true, runId: run.id, text: '' };
  window.cacheOwner = {};
  window.renderFixture = () => {
    if (!message.live) StreamMarkdown.release(cacheOwner);
    const wrapper = document.createElement('article'); wrapper.className = 'message-wrap agent-message'; wrapper.dataset.messageId = message.id; wrapper.dataset.liveState = message.live ? 'running' : 'completed';
    const identity = document.createElement('div'); identity.className = 'message-identity'; identity.textContent = 'AI · 隔离验收';
    const body = document.createElement('div'); body.className = 'message-body';
    // This closure intentionally owns exactly this body and this immutable
    // message snapshot, matching production renderMessage and SafePreview.
    const snapshot = { ...message };
    const render = (host, text) => { host.innerHTML = StreamMarkdown.render(cacheOwner, text, renderRichText, !!snapshot.live); CitationEvidence.decorate(host, snapshot, run, state); };
    SafePreview.mount(body, snapshot, { render }); body.hidden = !snapshot.text;
    wrapper.append(identity, body); return wrapper;
  };
  window.install = (text, options = {}) => {
    StreamMarkdown.release(cacheOwner); cacheOwner = {};
    message = { ...message, ...options, text };
    window.current = renderFixture(); document.querySelector('main').replaceChildren(current); return current;
  };
  window.repaint = (text, options = {}) => {
    message = { ...message, ...options, text };
    const fresh = renderFixture(), expected = fresh.querySelector('.message-body').innerHTML;
    const reference = document.createElement('div'); const snapshot = { ...message };
    SafePreview.mount(reference, snapshot, { render: (host, value) => { host.innerHTML = renderRichText(value); CitationEvidence.decorate(host, snapshot, run, state); } });
    if (expected !== reference.innerHTML) throw Error('Incremental render differs from full parser plus current citation state');
    AgentProgress.patchLive(current, fresh); current = document.querySelector('main > article');
    if (current.querySelector('.message-body').innerHTML !== expected) throw Error('Patched body differs from the production fresh render');
  };
}
(async () => {
  await app.whenReady();
  const styles=[...fs.readFileSync(path.join(ROOT,'app/index.html'),'utf8').matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)].map(m=>m[1]);
  const assets = ['stream-markdown.js', 'code-highlight.js', 'citation-evidence.js', 'safe-preview.js', 'streaming-body.js', 'agent-progress.js'];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'">${styles.map(file=>`<link rel="stylesheet" href="/${file}">`).join('')}<style>body{display:block!important;overflow:auto!important;padding:24px}main{max-width:760px;margin:auto}.message-wrap{width:100%;max-width:none}.message-body{overflow-wrap:anywhere}.markdown-table-scroll{max-width:100%;overflow:auto}</style></head><body class="light-mode reduce-motion interaction-system-ready"><main></main>${assets.map(file => `<script src="/${file}"></script>`).join('')}</body></html>`;
  const allowed = new Set([...assets,...styles,'halaska-geist.woff2','halaska-geist-mono.woff2']);
  server = http.createServer((request, response) => {
    const file = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
    if (!file) { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return; }
    if (!allowed.has(file)) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2')?'font/woff2':'application/javascript' }); response.end(fs.readFileSync(path.join(ROOT, 'app', file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 980, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => { const external = !details.url.startsWith(origin + '/') && !details.url.startsWith('data:'); if (external) externalRequests.push(details.url); callback({ cancel: external }); });
  win.webContents.on('console-message', (_, level, text) => { if (level >= 2 && !/favicon/.test(text)) errors.push(text); });
  await win.loadURL(origin + '/'); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate(renderer + '\nwindow.renderRichText = renderRichText;(' + initialize.toString() + ')();');

  await check('20 deltas retain body, completed blocks, focused link, selected text and tail without any progress root', async () => {
    const result = await evaluate(`(() => {
      const base = '# 固定标题\\n\\n首段 selected text 与 [参考链接](https://example.com/doc) 一直保留。\\n\\n正在生成';
      install(base, {live:true}); const wrapper = current, body = current.querySelector('.message-body'), heading = body.firstElementChild, paragraph = body.querySelector('p'), node = paragraph.firstChild, link = paragraph.querySelector('a'), tail = body.lastElementChild.firstChild;
      link.focus(); const at = node.data.indexOf('selected text'); getSelection().setBaseAndExtent(node,at,node,at+'selected text'.length);
      for(let n=1;n<=20;n++) { repaint(base+'。'.repeat(n)); if(current!==wrapper||current.querySelector('.message-body')!==body||body.firstElementChild!==heading||paragraph.firstChild!==node||body.lastElementChild.firstChild!==tail||document.activeElement!==link||getSelection().toString()!=='selected text') throw Error('Identity, focus, selection or tail changed at delta '+n); }
      return {deltas:20,selection:getSelection().toString(),bodySame:current.querySelector('.message-body')===body,progressRoots:current.querySelectorAll('.agent-progress,.tool-ledger').length};
    })()`);
    assert.equal(result.deltas, 20); assert.equal(result.progressRoots, 0); return result;
  });
  await check('retained citation chip refreshes WeakMap evidence and privacy while keeping focus across 20 deltas', async () => {
    const result = await evaluate(`(() => {
      CitationEvidence.capture(run,{type:'note',id:'n1',excerpt:'Saved excerpt'},state); const id=run.evidenceSources[0].sourceId;
      const base='事实说明 [[cite:'+id+']]\\n\\n正在生成'; install(base,{live:true}); const body=current.querySelector('.message-body'),chip=body.querySelector('[data-citation-source]'); chip.focus();
      CitationEvidence.capture(run,{type:'note',id:'n2',excerpt:'Second excerpt'},state);
      for(let n=1;n<=20;n++){if(n===20)state.notes[0].private=true;repaint(base+'。'.repeat(n));if(current.querySelector('[data-citation-source]')!==chip||document.activeElement!==chip)throw Error('Citation node/focus lost');}
      const target=CitationEvidence.resolveTarget(state,chip);return{sameBody:current.querySelector('.message-body')===body,siblings:target.siblings.length,private:target.source.private,excerpt:target.source.excerpt};
    })()`);
    assert.equal(result.sameBody, true); assert.equal(result.siblings, 2); assert.equal(result.private, true); assert.equal(result.excerpt, null); return result;
  });
  await check('selected unchanged suffix survives prepend and earlier correction without selecting appended or replacement text', async () => {
    return await evaluate(`(() => {
      for(const backward of [false,true]) {
        install('old selected suffix',{live:true,id:'offset-synthetic'}); const node=current.querySelector('.message-body p').firstChild,at=node.data.indexOf('selected suffix'),end=node.length;
        getSelection().setBaseAndExtent(node,backward?end:at,node,backward?at:end);
        for(const text of ['PREFIX old selected suffix','PREFIX much longer corrected selected suffix','selected suffix','selected suffix APPENDED']) {
          repaint(text); const selection=getSelection(); if(current.querySelector('.message-body p').firstChild!==node||selection.toString()!=='selected suffix'||(selection.anchorOffset>selection.focusOffset)!==backward)throw Error('Suffix selection moved after '+text);
        }
        getSelection().setBaseAndExtent(node,0,node,'selected suffix'.length);repaint('REPLACED APPENDED');if(!getSelection().isCollapsed)throw Error('Replaced selection now selects unrelated text');
      }
      return{directions:2,correctionsPerDirection:4,replacedSelectionCollapsed:true};
    })()`);
  });
  await check('completed inline syntax, code highlighting, tables, lists and non-append corrections match the production parser', async () => {
    const phases = [
      'Stable first paragraph.\n\nOpening **bold',
      'Stable first paragraph.\n\nOpening **bold** text',
      'Stable first paragraph.\n\n- First\n- Sec',
      'Stable first paragraph.\n\n- First\n- Second\n- Third',
      'Stable first paragraph.\n\n```javascript\nconst x = "incomplete',
      'Stable first paragraph.\n\n```javascript\nconst x = "complete";\nconsole.log(x);\n```',
      'Stable first paragraph.\n\n| Name | Value |',
      'Stable first paragraph.\n\n| Name | Value |\n| --- | ---: |\n| A | 1 |',
      'Stable first paragraph.\n\n| Name | Value |\n| --- | ---: |\n| A | 1 |\n| B | 2 |',
      'Inserted paragraph.\n\nStable first paragraph.\n\n> Corrected quotation\n> Next line',
    ];
    return await evaluate(`(() => {const phases=${JSON.stringify(phases)};install(phases[0],{live:true});const stable=current.querySelector('.message-body > p'),text=stable.firstChild;for(const phase of phases.slice(1)){repaint(phase);if(!stable.isConnected||stable.firstChild!==text)throw Error('Completed unchanged paragraph lost');}return{phases:phases.length,stableText:text.data,quoted:current.querySelectorAll('blockquote p').length};})()`);
  });
  await check('untrusted HTML and unsafe links stay literal throughout append and correction', async () => {
    const result = await evaluate(`(() => {const text='<img src=x onerror="window.__injected=true"> <script>window.__injected=true</script>\\n\\n[bad](javascript:alert(1))';install(text.slice(0,24),{live:true});repaint(text);return{injected:window.__injected===true,images:current.querySelectorAll('img').length,scripts:current.querySelectorAll('script').length,badLinks:current.querySelectorAll('a').length,text:current.querySelector('.message-body').textContent};})()`);
    assert.equal(result.injected, false); assert.equal(result.images, 0); assert.equal(result.scripts, 0); assert.equal(result.badLinks, 0); assert.match(result.text, /onerror/); return result;
  });
  await check('SafePreview transfers its fresh host so expand and restore use latest content', async () => {
    const result = await evaluate(`(() => {const old='OLD '+ 'x'.repeat(13000),latest='LATEST '+ 'y'.repeat(14000)+' CURRENT_TAIL';install(old,{live:false,id:'large-synthetic'});const detached=current.querySelector('.message-body');repaint(latest,{live:false});const fresh=current.querySelector('.message-body');if(fresh===detached)throw Error('Preview closure host incorrectly retained');fresh.querySelector('[data-preview-action="expand"]').click();if(!fresh.textContent.includes('CURRENT_TAIL')||detached.textContent.includes('CURRENT_TAIL'))throw Error('Expand affected stale host/text');fresh.querySelector('[data-preview-action="restore"]').click();return{bodyReplaced:fresh!==detached,restored:!!fresh.querySelector('[data-safe-preview]'),notice:fresh.querySelector('.safe-preview-notice').textContent,oldStillPreview:!!detached.querySelector('[data-safe-preview]'),wrapperState:current.dataset.liveState};})()`);
    assert.equal(result.bodyReplaced, true); assert.equal(result.restored, true); assert.equal(result.oldStillPreview, true); assert.equal(result.wrapperState, 'completed'); assert.match(result.notice, /14020/); return result;
  });
  await check('controller-owned body roots are transferred whole instead of reconciled', async () => {
    const result = await evaluate(`(() => {install('Before',{live:true,id:'owner-synthetic'});const previousBody=current.querySelector('.message-body'),owned=document.createElement('div');owned.dataset.halaskaRoot='fixture-owner';owned.textContent='Owned';previousBody.append(owned);repaint('After');return{bodyReplaced:current.querySelector('.message-body')!==previousBody,notMoved:owned.parentElement===previousBody,detached:!owned.isConnected,text:current.querySelector('.message-body').textContent};})()`);
    assert.deepEqual(result, { bodyReplaced: true, notMoved: true, detached: true, text: 'After' }); return result;
  });
  await check('empty-to-visible-to-hidden body preserves the root and reflects current attributes', async () => {
    return await evaluate(`(() => {install('',{live:true,id:'empty-synthetic'});const body=current.querySelector('.message-body');if(!body.hidden)throw Error('Initial hidden state missing');repaint('Visible answer');if(body.hidden||current.querySelector('.message-body')!==body)throw Error('Answer reveal failed');repaint('');if(!body.hidden||current.querySelector('.message-body')!==body)throw Error('Answer hide failed');return{rootRetained:true,hidden:body.hidden};})()`);
  });


  await check('measure production parser and body patch pipeline without a model request', async () => {
    return await evaluate(`(() => {
      const unit='# Topic\\nA paragraph with **emphasis**, [source](https://example.com/a), inline code and enough context.\\n\\n- one\\n- two\\n\\n| key | value |\\n| --- | ---: |\\n| a | 2 |\\n\\n';
      const text=unit.repeat(65),frames=[];for(let end=96;end<text.length;end+=96)frames.push(text.slice(0,end));frames.push(text);
      function measure(incremental,pipeline){
        const pool=StreamMarkdown.create(),owner={};let current=document.createElement('div'),last='';
        current.className='message-body';const mount=document.createElement('div');mount.append(current);document.body.append(mount);
        const started=performance.now();
        for(const frame of frames){
          last=incremental?pool.render(owner,frame,renderRichText,true):renderRichText(frame);
          if(pipeline){const next=document.createElement('div');next.className='message-body';next.innerHTML=last;CitationEvidence.decorate(next,{...message,text:frame},run,state);StreamingBody.patch(current,next);current.getBoundingClientRect();}
        }
        const elapsedMs=performance.now()-started;mount.remove();return {elapsedMs,characters:last.length};
      }
      measure(false,false);measure(true,false);
      const fullParser=measure(false,false),incrementalParser=measure(true,false),fullBodyPipeline=measure(false,true),incrementalBodyPipeline=measure(true,true);
      if(fullParser.characters!==incrementalParser.characters||fullBodyPipeline.characters!==incrementalBodyPipeline.characters)throw Error('Measured output differs');
      return{inputCharacters:text.length,frames:frames.length,fullParser,incrementalParser,fullBodyPipeline,incrementalBodyPipeline,scope:'Chromium synthetic one-body parser + HTML + citations + patch + layout. Excludes complete conversation, native, network and model.'};
    })()`);
  });
  await check('bounded cache evicts abandoned streams and final preview releases before lazy render', async () => {
    const result = await evaluate(`(() => {
      const text = '## Saved block\\n\\nParagraph one\\n\\nParagraph two\\n\\nLast';
      install(text,{live:true,id:'cache-final'}); repaint(text+' more');
      if(StreamMarkdown.inspect().entries!==1)throw Error('No live parser cache');
      const pool=StreamMarkdown.create({maxEntries:2,maxCharacters:1000});
      for(let n=0;n<8;n++)pool.render({},text,renderRichText,true);
      if(pool.inspect().entries>2)throw Error('Abandoned stream count unbounded');
      const huge='full text '.repeat(1600)+' END_OF_OUTPUT';
      const owner={};if(pool.render(owner,huge,renderRichText,true)!==renderRichText(huge))throw Error('Eviction truncated output');
      if(pool.inspect().characters>1000)throw Error('Over-budget cache retained');
      repaint(huge,{live:false});
      if(StreamMarkdown.inspect().entries)throw Error('Final SafePreview retained cache');
      current.querySelector('[data-preview-action="expand"]').click();
      if(!current.textContent.includes('END_OF_OUTPUT'))throw Error('Full final content lost');
      return{entries:StreamMarkdown.inspect().entries,budget:pool.inspect(),finalTailPresent:true};
    })()`);
    assert.equal(result.entries,0);return result;
  });
  await check('narrow light and dark layouts keep a long rendered answer readable', async () => {
    const result = [];
    for (const theme of ['light', 'dark']) {
      win.setSize(440, 850); await evaluate(`document.body.classList.toggle('light-mode',${theme === 'light'});install('## 持续生成的回答\\n\\n这里是正在阅读的 **固定正文** 与 [来源链接](https://example.com/doc)。\\n\\n| 项目 | 结果 |\\n| --- | --- |\\n| 读取原件 | 已返回合成内容 |\\n\\n后续内容继续出现。',{live:true,id:'visual-synthetic'});`);
      await evaluate(`new Promise(resolve=>{const deadline=performance.now()+1000,expected=${JSON.stringify(theme==='light'?'rgb(36, 41, 53)':'rgb(238, 240, 246)')};function settle(){if([...current.querySelectorAll('.message-body, p, h2, th, td')].every(node=>getComputedStyle(node).color===expected)||performance.now()>deadline)resolve();else setTimeout(settle,30);}settle();})`);
      const bounds = await evaluate(`(() => {const node=current.querySelector('.message-body');return{width:node.clientWidth,scrollWidth:node.scrollWidth,color:getComputedStyle(node).color,textColors:[...node.querySelectorAll('p,h2,th,td')].map(n=>getComputedStyle(n).color),token:getComputedStyle(document.body).getPropertyValue('--text').trim(),animations:node.getAnimations().map(a=>({state:a.playState,time:a.currentTime,frames:a.effect.getKeyframes()}))};})()`);
      assert.equal(bounds.color,theme==='light'?'rgb(36, 41, 53)':'rgb(238, 240, 246)','Theme foreground must match production palette '+JSON.stringify(bounds)); assert.ok(bounds.textColors.every(color=>color===bounds.color),'Nested text theme settles before capture'); assert.ok(bounds.scrollWidth <= bounds.width + 1, 'Body overflow at narrow width');
      fs.writeFileSync(path.join(OUT, `narrow-${theme}.png`), (await win.webContents.capturePage()).toPNG()); result.push({ theme, ...bounds });
    }
    return result;
  });
  assert.equal(externalRequests.length, 0, 'Fixture must stay offline'); assert.equal(errors.length, 0, 'No renderer errors');
  await finish(failures.length ? 1 : 0);
})().catch(error => { failures.push({ name: 'setup or teardown', error: error.stack || String(error) }); finish(1); });
