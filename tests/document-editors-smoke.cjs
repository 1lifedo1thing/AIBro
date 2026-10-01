/* Renderer-only acceptance: the actual production CM6/Crepe bundle and native
 * CSS, real DOM/keyboard and editor document transactions. No model, backend,
 * workspace, parser mirror or native-app acceptance claim.
 * Run serially: node_modules/.bin/electron tests/document-editors-smoke.cjs */
'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),OUT=process.env.AIBRO_QA_OUTPUT||path.join(ROOT,'test-results/document-editors-20260930/renderer');
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-document-editors-'));
app.setPath('userData',path.join(TEMP,'profile'));fs.mkdirSync(OUT,{recursive:true});
const required=['document-editors.js','document-editors-bundle.js','document-editors.css'];
const checks=[],failures=[],rendererErrors=[],externalRequests=[],requests=[];let server,win,origin,stopping=false;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=value=>win.webContents.executeJavaScript(typeof value==='function'?`(${value.toString()})()`:value,true);
const modifier=process.platform==='darwin'?'meta':'control';
async function until(action,label,timeout=10000){const started=Date.now();while(Date.now()-started<timeout){if(await action())return;await wait(20);}throw Error(`Timed out: ${label}`);}
async function key(keyCode,modifiers=[]){win.webContents.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await wait(25);}
async function check(name,fn){try{const observation=await fn();checks.push({name,observation});console.log('PASS',name);}catch(error){failures.push({name,error:error.stack||String(error)});console.error('FAIL',name,error.message);}}
async function screenshot(name){await wait(60);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());}
function report(){const sha=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({scope:'Isolated Chromium renderer; not native WKWebView, real OS IME, app save/recovery or accessibility acceptance',passed:checks.length,checks,failures,rendererErrors,externalRequests,requests:[...new Set(requests)],modelCalls:0,userWorkspaceLoaded:false,artifacts:required.map(name=>({name,sha256:sha(path.join(ROOT,'app',name))})),temporaryProfileRemoved:!fs.existsSync(TEMP)},null,2));}
const watchdog=setTimeout(()=>{failures.push({name:'watchdog',error:'Timed out after 150 seconds'});void finish(1);},150000);
app.on('window-all-closed',()=>{});
async function finish(code){if(stopping)return;stopping=true;clearTimeout(watchdog);if(win&&!win.isDestroyed())win.destroy();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fs.rmSync(TEMP,{recursive:true,force:true});report();console.log(JSON.stringify({passed:checks.length,failures,rendererErrors,externalRequests},null,2));app.exit(code);}
function setup(){
 window.editor=null;window.editorHost=document.querySelector('#editor');window.changes=[];window.statuses=[];window.adapterErrors=[];
 window.assertTrue=(value,message)=>{if(!value)throw Error(message);};
 window.createEditor=async(kind,value,extra={})=>{
  await editor?.destroy();editorHost.replaceChildren();editorHost.scrollIntoView({block:'start'});changes=[];statuses=[];
  const api=kind==='source'?DocumentSourceEditor:DocumentVisualEditor;
  editor=api.mount(editorHost,{value,onChange:(value,meta)=>changes.push({value,meta}),onStatus:value=>statuses.push(value),onError:error=>adapterErrors.push(error.message),...extra});
  assertTrue(editor&&typeof editor.getValue==='function'&&editor.ready instanceof Promise,'mount must return the production synchronous handle');
  window.editorKind=kind;return editor.ready;
 };
 // User-visible DOM selection only: do not assume a private ProseMirror/CM view
 // property or expose a production test backdoor. Native selectionchange is
 // allowed to reach the real editor before Electron sends the input event.
 window.selectRenderedText=async(startText,endText=startText,{startOffset=0,endOffset=endText.length,selector='.ProseMirror'}={})=>{
  const content=editorHost.querySelector(selector);assertTrue(content,'Rendered editable content exists');
  const find=needle=>{const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){const offset=node.data.indexOf(needle);if(offset>=0)return{node,offset};}throw Error('Missing rendered text: '+needle);};
  const start=find(startText),end=find(endText);content.focus();getSelection().setBaseAndExtent(start.node,start.offset+startOffset,end.node,end.offset+endOffset);await animationFrame();
 };
 window.animationFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}
(async()=>{
 for(const name of required)assert.ok(fs.existsSync(path.join(ROOT,'app',name)),`Build production asset before running: ${name}`);
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/native-workspace.css"><style>html,body{margin:0;min-width:0!important;width:100%;height:auto!important;overflow:auto!important}body{display:block!important;padding:14px!important;box-sizing:border-box}main{width:100%;max-width:920px;min-width:0;margin:auto}h1{font:600 18px/1.5 system-ui;margin:0 0 8px}#editor{min-width:0;min-height:360px;width:100%;box-sizing:border-box}#editor.note-document{display:block!important}#editor .document-source-editor{height:470px}#after-editor{margin-top:12px}.fixture-note{font:12px/1.5 system-ui;color:var(--muted);margin:0 0 12px}</style></head><body class="aibro-native light-mode reduced-motion"><main><h1>Document editor · isolated renderer</h1><p class="fixture-note">Synthetic text only. This is not a native app acceptance result.</p><button id="before-editor">Before editor</button><section id="editor" class="note-document" aria-label="Document fixture"></section><button id="after-editor">After editor</button></main><script src="/document-editors.js"></script></body></html>`;
 server=http.createServer((request,response)=>{const pathname=new URL(request.url,'http://localhost').pathname;requests.push(pathname);if(pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return response.end(html);}const file=pathname==='/native-workspace.css'?path.join(ROOT,'native/Resources/workspace.css'):path.resolve(ROOT,'app','.'+decodeURIComponent(pathname));if(!file.startsWith(path.join(ROOT,'app')+path.sep)&&pathname!=='/native-workspace.css'){response.writeHead(403);return response.end();}if(!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);return response.end();}const extension=path.extname(file),mime={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml','.png':'image/png'}[extension];if(!mime){response.writeHead(403);return response.end();}response.writeHead(200,{'Content-Type':mime});response.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
 await app.whenReady();win=new BrowserWindow({show:false,width:1080,height:860,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')rendererErrors.push(event.message);});win.webContents.on('render-process-gone',(_,details)=>rendererErrors.push(`Renderer exited: ${details.reason}`));
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{const external=!details.url.startsWith(origin+'/');if(external)externalRequests.push(details.url);callback({cancel:external});});
 await win.loadURL(origin);await evaluate(`DocumentEditors.ensure()`);await evaluate(setup);
 await check('production loader supplies real source and visual editor handles offline',async()=>{
  return evaluate(()=>{assertTrue(DocumentEditors.available(),'Both production APIs loaded');assertTrue(!!document.querySelector('#document-editors-style')?.sheet,'Production CSS loaded');return{source:typeof DocumentSourceEditor.mount,visual:typeof DocumentVisualEditor.mount,styles:document.styleSheets.length};});
 });
 await check('CM6 renders Markdown highlighting and exposes exact raw UTF-16 selection with BOM and mixed endings',async()=>{
  const raw='\uFEFF# Heading\r\n\r\nAlpha 中文😀 paragraph.\r\n\r\nBeta paragraph.\n\n```js\nconst value = 42;\n```\n';
  await evaluate(`window.rawFixture=${JSON.stringify(raw)};createEditor('source',rawFixture)`);
  const result=await evaluate(async()=>{await animationFrame();const start=rawFixture.indexOf('中文'),end=start+'中文😀'.length;editor.setSelectionRange(start,end,'backward');const selected=editor.selectionSource();const cm=editorHost.querySelector('.cm-editor');assertTrue(cm&&cm.querySelector('.cm-gutters')&&cm.querySelector('.cm-content[contenteditable=true]'),'Actual CodeMirror document, line gutters and editable content');assertTrue(cm.querySelectorAll('.cm-line span').length>0,'Markdown syntax highlighting has real token spans');return{value:editor.getValue(),selected,outline:editor.outline(),changes:changes.length};});
  assert.equal(result.value,raw);assert.equal(result.selected.value,raw);assert.equal(result.selected.start,raw.indexOf('中文'));assert.equal(result.selected.end,raw.indexOf('中文')+'中文😀'.length);assert.equal(result.selected.direction,'backward');assert.equal(result.selected.exact,true);assert.equal(result.changes,0);assert.ok(result.outline.some(heading=>heading.text.includes('Heading')));return{rawCharacters:raw.length,selection:result.selected.start+'–'+result.selected.end,outline:result.outline.length};
 });
 await check('real source typing across paragraphs and undo restore the exact original raw document',async()=>{
  await evaluate(()=>{editor.setSelectionRange(rawFixture.indexOf('Alpha')+6,rawFixture.indexOf('Beta')+4);editor.focus();});
  await win.webContents.insertText('Merged 中文😀\nSecond inserted line');await until(()=>evaluate(`editor.getValue().includes('Merged 中文😀')`),'CM input transaction');
  const changed=await evaluate(()=>({value:editor.getValue(),changes:changes.length,last:changes.at(-1)?.value}));assert.ok(changed.changes>0);assert.equal(changed.last,changed.value);assert.ok(changed.value.startsWith('\uFEFF# Heading\r\n'));assert.ok(!changed.value.includes('Beta'));
  await key('z',[modifier]);await until(()=>evaluate('editor.getValue()===rawFixture'),'exact source undo');
  const redo=await evaluate(()=>({value:editor.getValue(),last:changes.at(-1)}));assert.equal(redo.last.meta.origin,'undo');return{typedCharacters:changed.value.length,undoExact:true};
 });
 await check('CodeMirror find and replace are actual searchable document commands and keep keyboard focus local',async()=>{
  await evaluate(()=>createEditor('source','# Find\n\nalpha one\n\nalpha two\n'));await evaluate(()=>editor.focus());await key('f',[modifier]);await until(()=>evaluate(`!!editorHost.querySelector('.cm-search input[name=search]')`),'native CM find panel');
  await evaluate(()=>{const field=editorHost.querySelector('input[name=search]');field.focus();field.select();});await win.webContents.insertText('alpha');await evaluate(()=>editorHost.querySelector('input[name=search]').dispatchEvent(new Event('change',{bubbles:true})));
  await evaluate(()=>{const field=editorHost.querySelector('input[name=replace]');field.focus();field.select();});await win.webContents.insertText('OMEGA');await evaluate(()=>{editorHost.querySelector('input[name=replace]').dispatchEvent(new Event('change',{bubbles:true}));editorHost.querySelector('button[name=replaceAll]').click();});
  await until(()=>evaluate(()=>editor.getValue()==='# Find\n\nOMEGA one\n\nOMEGA two\n'),'replace-all command');await evaluate(()=>editorHost.querySelector('input[name=search]').focus());await key('Escape');assert.equal(await evaluate(`!!editorHost.querySelector('.cm-search')`),false);assert.equal(await evaluate(`editorHost.contains(document.activeElement)`),true);await key('z',[modifier]);assert.equal(await evaluate('editor.getValue()'),'# Find\n\nalpha one\n\nalpha two\n');return{matchesReplaced:2,undoExact:true};
 });
 await check('visual no-edit mode round trips preserve raw BOM, frontmatter, CRLF and unusual standard Markdown formatting',async()=>{
  const raw='\uFEFF---\r\ntitle: "Exact raw"\r\n---\r\n\r\n#  Heading\r\n\r\nAn **emphasized** paragraph.\r\n\r\n-   one\r\n-   two\r\n';
  const result=await evaluate(`(async()=>{window.modeRaw=${JSON.stringify(raw)};let value=modeRaw;const statusesSeen=[];for(let n=0;n<3;n++){assertTrue(await createEditor('visual',value),'Supported visual document');statusesSeen.push(...statuses);assertTrue(editor.getValue()===modeRaw,'Visual ready must not normalize raw');assertTrue(changes.length===0,'Mounting a visual editor is not an edit');const start=modeRaw.indexOf('emphasized'),end=start+'emphasized'.length;assertTrue(editor.setSelectionRange(start,end,'backward'),'Literal visual source range maps across BOM/frontmatter');const selected=editor.selectionSource();assertTrue(selected.exact&&selected.start===start&&selected.end===end&&selected.direction==='backward','Visual selection preserves raw UTF16 offsets and direction');assertTrue(await editor.flushPending(),'Visual flush settled');value=editor.getValue();assertTrue(await createEditor('source',value),'Source ready');assertTrue(editor.getValue()===modeRaw,'Mode round trip must preserve raw');value=editor.getValue();}return{value,statusesSeen,cycles:3};})()`);
 assert.equal(result.value,raw);return{cycles:result.cycles,rawCharacters:raw.length,bomAndCRLFPreserved:true};
 });
 await check('selection-only focus in documents ending with code or table never normalizes pristine raw',async()=>{
  const samples=['#  Code end\r\n\r\nPreface text.\r\n\r\n```js\r\nconst x=1;\r\n```','Preface text.\r\n\r\n| A | B |\r\n| --- | --- |\r\n| one | two |'];
  for(const raw of samples){await evaluate(`createEditor('visual',${JSON.stringify(raw)})`);const result=await evaluate(async()=>{const original=editor.getValue(),start=original.indexOf('Preface');assertTrue(editor.setSelectionRange(start,start+7),'Pristine literal text range maps');editor.focus();await animationFrame();await editor.flushPending();return{value:editor.getValue(),changes:changes.length};});assert.equal(result.value,raw);assert.equal(result.changes,0);await evaluate(`createEditor('source',${JSON.stringify(result.value)})`);assert.equal(await evaluate('editor.getValue()'),raw);}return{fixtures:samples.length,selectionOnlyRawRetained:true};
 });
 await check('visual document supports real cross-paragraph input, synchronous getValue and actual undo',async()=>{
  const raw='# Heading\n\nAlpha paragraph.\n\nBeta paragraph.\n';await evaluate(`createEditor('visual',${JSON.stringify(raw)})`);
  await evaluate(()=>selectRenderedText('Alpha','Beta',{startOffset:6,endOffset:4}));await win.webContents.insertText('Merged visual 中文😀');await until(()=>evaluate(`editor.getValue().includes('Merged visual 中文😀')`),'visual input');assert.equal(await evaluate(`editor.getValue().includes('Beta paragraph.')`),false);
  await key('z',[modifier]);await until(()=>evaluate(`editor.getValue()===${JSON.stringify(raw)}`),'visual undo raw');
  await until(()=>evaluate(`!!editorHost.querySelector('[data-document-command="bold"]')`),'actual format command');
  const result=await evaluate(()=>{const value=editor.getValue(),at=value.indexOf('Alpha');assertTrue(editor.setSelectionRange(at,at+5),'Bold target maps');editor.focus();const button=editorHost.querySelector('[data-document-command="bold"]').closest('.top-bar-item');assertTrue(button,'Production bold button exists');button.click();const beforeDebounce=editor.getValue();assertTrue(beforeDebounce.includes('**Alpha**'),'Synchronous getValue must include the real toolbar transaction before listener debounce');return{value:beforeDebounce,status:statuses.at(-1)};});assert.ok(result.value.includes('**Alpha**'));return{synchronousToolbarRead:true,undoRestoredRaw:true};
 });
 await check('visual table cells are editable ProseMirror transactions and serialize as a real Markdown table',async()=>{
  const raw='| Name | Value |\n| --- | --- |\n| Row one | Original |\n\nAfter table.\n';await evaluate(`createEditor('visual',${JSON.stringify(raw)})`);
  // Upstream TableBlock renders a hidden drag-preview table before the actual
  // contentDOM table.children (components/src/table-block/view/component.tsx).
  assert.equal(await evaluate(`editorHost.querySelectorAll('.ProseMirror .milkdown-table-block table.children td').length`),2);
  await evaluate(()=>{const at=editor.getValue().indexOf('Original');assertTrue(editor.setSelectionRange(at,at+'Original'.length),'Actual table cell maps to raw');editor.focus();});await win.webContents.insertText('Edited cell 中文');await until(()=>evaluate(`editor.getValue().includes('Edited cell 中文')`),'table cell edit');
  const result=await evaluate(()=>{const table=editorHost.querySelector('.ProseMirror .milkdown-table-block table.children');return{text:table?.textContent,value:editor.getValue(),cells:table?.querySelectorAll('td').length,visible:!!table?.getClientRects().length,html:editorHost.querySelector('.milkdown-table-block')?.outerHTML.slice(0,5000)};});assert.match(result.text,/Edited cell 中文/,result.html);assert.match(result.value,/\|/);assert.ok(result.value.includes('After table.'));assert.equal(result.cells,2,result.html);assert.equal(result.visible,true,result.html);await screenshot('visual-table');return{cells:result.cells,edited:true,visible:true};
 });
 await check('code blocks use the actual embedded code editor and mathematical notation renders locally',async()=>{
  const raw='# Code and mathematics\n\n```javascript\nconst meaning = 42;\n```\n\nInline $x^2 + y^2$.\n\n$$\n\\frac{a}{b}\n$$\n';await evaluate(`createEditor('visual',${JSON.stringify(raw)})`);
  await evaluate(()=>editorHost.querySelector('.milkdown-code-block').scrollIntoView({block:'center'}));await until(()=>evaluate(`!!editorHost.querySelector('.milkdown-code-block .cm-content')`),'visible embedded code editor');
  const code=await evaluate(()=>editorHost.querySelector('.milkdown-code-block .cm-content').textContent);assert.match(code,/const meaning = 42/);
  await evaluate(()=>selectRenderedText('42','42',{selector:'.milkdown-code-block .cm-content'}));await win.webContents.insertText('84');await until(()=>evaluate(`editor.getValue().includes('const meaning = 84')`),'embedded CM edit reaches document');await key('z',[modifier]);await until(()=>evaluate(`editor.getValue()===${JSON.stringify(raw)}`),'embedded CM undo restores raw');
  await evaluate(()=>[...editorHost.querySelectorAll('.milkdown-code-block')].at(-1).scrollIntoView({block:'center'}));await until(()=>evaluate(`!!editorHost.querySelector('.katex-display')&&!!editorHost.querySelector('[data-type="math_inline"] .katex')`),'block and inline KaTeX');
  const result=await evaluate(()=>({math:editorHost.querySelectorAll('.katex').length,inlineMath:editorHost.querySelectorAll('[data-type="math_inline"]').length,value:editor.getValue()}));assert.ok(result.math>=2);assert.ok(result.inlineMath>=1);assert.equal(result.value,raw);await screenshot('visual-code-math');return{embeddedCode:true,codeEditedAndUndo:true,mathElements:result.math};
 });
 await check('unknown syntax and unsafe HTML decline visual editing while preserving complete raw source for source mode',async()=>{
  const samples=['Before\n\n<div data-fixture="unknown">HTML retained</div>\n','Wiki [[Unknown page|label]]\n','Footnote[^1].\n\n[^1]: Footnote body.\n','[Reference][target]\n\n[target]: https://example.invalid\n','[Unsafe](javascript:alert(1))\n'];
  const observations=[];
  for(const raw of samples){const result=await evaluate(`(async()=>{const ready=await createEditor('visual',${JSON.stringify(raw)});const value=editor.getValue(),status=statuses.at(-1),editable=!!editorHost.querySelector('[contenteditable=true]');assertTrue(value===${JSON.stringify(raw)},'Unsupported raw text must survive');return{ready,status,editable};})()`);assert.equal(result.ready,false);assert.equal(result.editable,false);assert.equal(result.status?.supported,false);assert.ok(result.status.reason);await evaluate(`createEditor('source',${JSON.stringify(raw)})`);assert.equal(await evaluate('editor.getValue()'),raw);observations.push({supported:false,sourceRetained:true});}
  await evaluate(()=>createEditor('visual','Supported paragraph.\n'));
  const accepted=await evaluate(()=>{const value='<aside>New unsupported raw</aside>\n';const accepted=editor.setValue(value);return{accepted,value:editor.getValue(),status:statuses.at(-1)};});assert.equal(accepted.accepted,true);assert.equal(accepted.value,'<aside>New unsupported raw</aside>\n');assert.equal(accepted.status.supported,false);
  return{cases:observations.length,automaticNormalization:false};
 });
 await check('source and visual composition gates flush and replacement until committed input is available',async()=>{
  const observations=[];
  for(const kind of ['source','visual']){
   await evaluate(`createEditor(${JSON.stringify(kind)},${JSON.stringify('Composition paragraph.\n')})`);
   const result=await evaluate(async()=>{const target=editorKind==='source'?editorHost.querySelector('.document-source-editor .cm-content'):editorHost.querySelector('.ProseMirror');target.focus();target.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));const composing=editor.isComposing(),flushed=await editor.flushPending(),replaced=editor.setValue('SHOULD_NOT_REPLACE');target.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));return{composing,flushed,replaced,value:editor.getValue()};});
   assert.equal(result.composing,true);assert.equal(result.flushed,false);assert.equal(result.replaced,false);assert.equal(result.value,'Composition paragraph.\n');
   // These are actual post-composition input transactions; dispatched composition
   // events prove adapter gating, not an OS IME candidate-window acceptance.
   await wait(70);await evaluate(()=>{assertTrue(editor.setSelectionRange(editor.getValue().indexOf('paragraph.'),editor.getValue().indexOf('paragraph.')+'paragraph.'.length),'Committed-input selection maps to the literal source');editor.focus();});await win.webContents.insertText('committed 中文');await until(()=>evaluate(`editor.getValue().includes('committed 中文')`),kind+' composition tail input');await until(()=>evaluate('editor.flushPending()'),kind+' composition flush settled');assert.ok((await evaluate('editor.getValue()')).includes('committed 中文'));observations.push({kind,gated:true,committedTextRetained:true});
  }
  return{observations,realOSIME:false};
 });
 await check('same-value updates do not reset selection or history and read-only mode prevents input',async()=>{
  const observations=[];
  for(const kind of ['source','visual']){
   await evaluate(`createEditor(${JSON.stringify(kind)},${JSON.stringify('Read only paragraph.\n')})`);await evaluate(()=>{editor.setSelectionRange(0,4,'forward');editor.focus();});await win.webContents.insertText('Edited');await until(()=>evaluate(`editor.getValue().startsWith('Edited')`),kind+' editable input');
   const retained=await evaluate(()=>{const before=editor.selectionSource(),value=editor.getValue();editor.setValue(value);const after=editor.selectionSource();editor.setDisabled(true);editor.focus();return{before,after,value,contenteditables:editorHost.querySelectorAll('[contenteditable=true]').length};});assert.equal(retained.before.start,retained.after.start);assert.equal(retained.before.end,retained.after.end);assert.equal(retained.value,retained.after.value);assert.equal(retained.contenteditables,0);
   await win.webContents.insertText('FORBIDDEN');assert.equal(await evaluate('editor.getValue()'),retained.value);await evaluate(()=>{editor.setDisabled(false);editor.focus();});await key('z',[modifier]);await until(()=>evaluate(()=>editor.getValue()==='Read only paragraph.\n'),kind+' history preserved after same-value update');
   if(kind==='visual') {
    await until(()=>evaluate(`!!editorHost.querySelector('[data-document-command="bold"]')`),'visual toolbar returns after save readonly cycle');
    const value=await evaluate(()=>{editor.setSelectionRange(0,4);editor.focus();editorHost.querySelector('[data-document-command="bold"]').closest('.top-bar-item').click();return editor.getValue();});
    assert.match(value,/\*\*Read\*\*/,'Restored formatting controls execute actual document commands');
   }
   const replaced=await evaluate(()=>{editor.setDisabled(true);const accepted=editor.setValue('Replacement read-only.\r\n');return{accepted,value:editor.getValue(),editable:!!editorHost.querySelector('[contenteditable=true]')};});assert.equal(replaced.accepted,true);assert.equal(replaced.editable,false);await win.webContents.insertText('STILL_FORBIDDEN');assert.equal(await evaluate('editor.getValue()'),'Replacement read-only.\r\n');observations.push({kind,selectionRetained:true,historyRetained:true,readonlySurvivesSetValue:true});
  }
  return observations;
 });
 await check('destroy before visual ready and repeated mount/unmount cannot install late DOM or callbacks',async()=>{
  return evaluate(async()=>{editor?.destroy();editorHost.replaceChildren();const events=[];const pending=DocumentVisualEditor.mount(editorHost,{value:'# Late\n\nText.\n',onChange:()=>events.push('change'),onStatus:()=>events.push('status'),onError:error=>adapterErrors.push(error.message)});pending.destroy();pending.destroy();const count=events.length,ready=await pending.ready;await new Promise(resolve=>setTimeout(resolve,230));assertTrue(ready===false,'Destroyed visual ready must be false');assertTrue(editorHost.childNodes.length===0,'No late visual DOM');assertTrue(events.length===count,'No callbacks after destroy');const source=DocumentSourceEditor.mount(editorHost,{value:'Source\r\n'});source.destroy();source.destroy();await source.ready;assertTrue(editorHost.childNodes.length===0,'No source DOM after destroy');return{lateReady:ready,postDestroyCallbacks:events.length-count,childNodes:editorHost.childNodes.length};});
 });
 await check('native palettes, 320px width, keyboard Tab and reduced motion stay usable',async()=>{
  const observations=[];
  for(const light of [true,false])for(const kind of ['source','visual']){
   win.setSize(320,760);await evaluate(`document.body.classList.toggle('light-mode',${light});createEditor(${JSON.stringify(kind)},${JSON.stringify('# Narrow\n\nA short editable paragraph.\n\n| A | B |\n| --- | --- |\n| One | Two |\n')})`);await evaluate(()=>animationFrame());
   const layout=await evaluate(()=>{const box=editorHost.getBoundingClientRect(),content=editorKind==='source'?editorHost.querySelector('.cm-content'):editorHost.querySelector('.ProseMirror'),style=getComputedStyle(content);return{width:innerWidth,scroll:document.documentElement.scrollWidth,right:box.right,left:box.left,color:style.color,background:getComputedStyle(document.body).backgroundColor,font:style.fontFamily};});assert.ok(layout.left>=0&&layout.right<=layout.width);assert.ok(layout.scroll<=layout.width,`${kind} ${light?'light':'dark'} horizontally overflows: ${JSON.stringify(layout)}`);assert.ok(layout.color&&layout.background);observations.push({kind,light,...layout});await screenshot(`narrow-${kind}-${light?'light':'dark'}`);
  }
  win.setSize(1080,860);await evaluate(()=>{document.body.classList.add('light-mode');return createEditor('source','Tab remains focus navigation.\n');});await evaluate(()=>{editor.setSelectionRange(0);editor.focus();});const value=await evaluate('editor.getValue()');await key('Tab');assert.equal(await evaluate('editor.getValue()'),value);assert.equal(await evaluate('document.activeElement.id'),'after-editor');
  return{layouts:observations,tabDoesNotInsertText:true};
 });
 await check('real native engine segments preserve fine undo across modes, toolbar and keyboard share history',async()=>{
  await evaluate(async()=>{
   await editor?.destroy();editorHost.replaceChildren();window.historyRaw='\ufeff---\r\ntitle: Keep\r\n---\r\n\r\nAlpha paragraph.\r\n\r\nBeta paragraph.\r\n';
   window.timeline=DocumentEditHistory.create();window.engines={};window.engineHosts={};window.historyValues=[historyRaw];
   window.showHistoryMode=mode=>{window.historyMode=mode;for(const key of ['edit','rich'])engineHosts[key].hidden=key!==mode;window.editor=engines[mode];editor.focus();};
   window.requestHistory=async direction=>{if(!await editor.flushPending())return false;return timeline.move(direction,({mode})=>showHistoryMode(mode));};
   for(const mode of ['edit','rich']){
    const host=document.createElement('div');editorHost.append(host);engineHosts[mode]=host;
    engines[mode]=(mode==='edit'?DocumentSourceEditor:DocumentVisualEditor).mount(host,{value:historyRaw,onHistory:direction=>void requestHistory(direction),onHistoryChange:()=>timeline.changed(mode),onError:error=>adapterErrors.push(error.message)});
    assertTrue(await engines[mode].ready,'Real engine ready');timeline.attach(mode,engines[mode]);
   }
   window.switchHistoryMode=async mode=>{assertTrue(await editor.flushPending(),'Committed mode switch');const value=editor.getValue();assertTrue(timeline.activate(mode,value),'History projection ready');showHistoryMode(mode);};
   timeline.activate('rich',historyRaw);showHistoryMode('rich');
   window.replaceHistoryText=(needle)=>{const at=editor.getValue().indexOf(needle);assertTrue(at>=0&&editor.setSelectionRange(at,at+needle.length),'Exact literal range');editor.focus();};
  });
  for(const [needle,replacement]of[['Alpha','VISUAL-A'],['Beta','VISUAL-B']]){await evaluate(`replaceHistoryText(${JSON.stringify(needle)})`);await win.webContents.insertText(replacement);await until(()=>evaluate(`editor.getValue().includes(${JSON.stringify(replacement)})`),'visual history edit');await evaluate('historyValues.push(editor.getValue())');}
  await evaluate("switchHistoryMode('edit')");
  for(const [needle,replacement]of[['VISUAL-A','SOURCE-A'],['VISUAL-B','SOURCE-B']]){await evaluate(`replaceHistoryText(${JSON.stringify(needle)})`);await win.webContents.insertText(replacement);await until(()=>evaluate(`editor.getValue().includes(${JSON.stringify(replacement)})`),'source history edit');await evaluate('historyValues.push(editor.getValue())');}
  await evaluate("switchHistoryMode('rich')");
  // AX/button activation takes exactly the same route as Cmd-Z.
  await evaluate(()=>engineHosts.rich.querySelector('[data-document-command="undo"]').closest('.top-bar-item').click());
  await until(()=>evaluate("historyMode==='edit'&&editor.getValue()===historyValues[3]"),'toolbar undo switches to source segment');
  for(let index=2;index>=0;index--){await key('z',[modifier]);await until(()=>evaluate(`editor.getValue()===historyValues[${index}]`),'fine undo '+index);}
  assert.equal(await evaluate('editor.getValue()'),await evaluate('historyRaw'));
  for(let index=1;index<=4;index++){await key('z',[modifier,'shift']);await until(()=>evaluate(`editor.getValue()===historyValues[${index}]`),'fine redo '+index);}
  await key('z',[modifier]);await until(()=>evaluate('editor.getValue()===historyValues[3]'),'undo before branch');
  await evaluate("switchHistoryMode('rich');replaceHistoryText('SOURCE-A')");await win.webContents.insertText('BRANCH');await until(()=>evaluate("editor.getValue().includes('BRANCH')"),'branch input');assert.equal(await evaluate("requestHistory('redo')"),false);
  const result=await evaluate(async()=>{const count=timeline.snapshot().segments;timeline.dispose();for(const handle of Object.values(engines))await handle.destroy();editor=null;editorHost.replaceChildren();return{segments:count,undoRestoredExactRaw:true,realPMandCM:true,toolbarAndKeyboard:true,branchRedoRejected:true};});
  return result;
 });
 await check('actual source proposal history keeps unchanged mixed line endings through undo and redo',async()=>{
  const raw='\ufeff---\r\ntitle: Original\r\n---\n\nFirst paragraph.\r\n\nSecond paragraph.\r\n';
  const result=await evaluate(`(async()=>{const raw=${JSON.stringify(raw)};await createEditor('source',raw);assertTrue(editor.setValue(raw+'AI replacement',{addToHistory:true}),'Proposal accepted');assertTrue(editor.undo(),'Native undo');assertTrue(editor.getValue()===raw,'Mixed newline bytes unchanged by inverse full replacement');assertTrue(editor.redo(),'Native redo');assertTrue(editor.getValue()===raw+'AI replacement','Proposal restored exactly');return{exactRaw:true,undo:true,redo:true};})()`);return result;
 });
 await check('production editor run has no external requests, adapter errors or renderer errors',async()=>{const errors=await evaluate('adapterErrors');assert.deepEqual(errors,[]);assert.deepEqual(rendererErrors,[]);assert.deepEqual(externalRequests,[]);return{remoteRequests:0,adapterErrors:0,rendererErrors:0};});
 await finish(failures.length||rendererErrors.length||externalRequests.length?1:0);
})().catch(error=>{failures.push({name:'runner',error:error.stack||String(error)});void finish(1);});
