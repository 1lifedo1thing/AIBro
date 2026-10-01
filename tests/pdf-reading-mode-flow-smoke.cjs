/* Actual root renderer, Kit selects, send/retry/queue, KnowledgeAccess, real PDF
 * upload and read-text HTTP adapter, editor and temporary durable workspace.
 * Only provider and credentials are synthetic. Run serially after UI build:
 * node_modules/.bin/electron tests/pdf-reading-mode-flow-smoke.cjs
 * Renderer aid only; native WKWebView acceptance is a separate gate. */
'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'test-results/pdf-reading-mode-20260930/renderer');
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-pdf-mode-')),STORE=path.join(TEMP,'store'),FIXTURE=path.join(ROOT,'tests/fixtures/pdf-reading-mode.js');
fs.mkdirSync(STORE);fs.mkdirSync(OUT,{recursive:true});
fs.writeFileSync(path.join(path.dirname(OUT),'native-fixture-client.js'),'window.__AIBRO_PDF_MODE_ISOLATED_QA__=true;\n'+fs.readFileSync(FIXTURE,'utf8'));
app.setPath('userData',path.join(TEMP,'profile'));app.on('window-all-closed',()=>{});
let win,server,origin,ending=false;
const checks=[],failures=[],observations=[],rendererErrors=[],externalRequests=[],modelRequests=[],fileRequests=[];
const q=JSON.stringify,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=code=>win.webContents.executeJavaScript(code,true);
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await wait(40);}throw Error('Timed out: '+label);}
async function shot(name){if(win&&!win.isDestroyed()){await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await wait(80);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());}}
async function check(label,fn){try{await fn();checks.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);await shot('failure-'+failures.length);try{observations.push({failure:label,state:await evaluate('({runs:state.agentRuns.map(r=>({id:r.id,status:r.status,pdfReadMode:r.pdfReadMode,error:r.error,errorCode:r.errorCode,knowledgeReads:r.knowledgeReads})),pending:currentConversation().pendingSubmits,calls:window.__pdfModeProviderCalls,composer:document.querySelector("#composerPdfReadMode")?.outerHTML})')});}catch(_){}}}
const click=selector=>evaluate(`(()=>{const n=document.querySelector(${q(selector)});if(!n)throw Error('Missing '+${q(selector)});if(n.disabled)throw Error('Disabled '+${q(selector)});n.click()})()`);
async function select(value,id='composerPdfReadMode'){
  await until(()=>evaluate(`!!document.getElementById(${q(id)})&&!document.getElementById(${q(id)}).disabled`),'enabled PDF select '+id);
  await evaluate(`(()=>{const n=document.getElementById(${q(id)});n.focus();Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,${q(value)});n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>evaluate(`document.getElementById(${q(id)})?.value===${q(value)}`),'PDF mode selected '+value);
  if(id==='composerPdfReadMode')await until(()=>evaluate(`currentConversation().pdfReadMode===${q(value)}`),'conversation owns PDF mode');
}
async function settle(){await evaluate('saveDocumentDurably()');await evaluate('flushWorkspace()');await until(()=>evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'),'durable state');}
const snapshot=()=>evaluate('(async()=>{const r=await fetch("/__state",{cache:"no-store"});if(!r.ok)throw Error("Cannot inspect fixture state");return r.json()})()');
async function stage(marker,ids=['pdf-mode-source']){
  const goal=['TEXT-READ','QUEUE-EDIT'].includes(marker)?'整理这份 PDF 并保存分析笔记':'检查 PDF 读取与队列行为';
  await evaluate(`(()=>{currentConversation().draftAttachmentIds=${q(ids)};renderStagedAttachments();const n=document.querySelector('#agentInput');n.value=${q(goal+' [PDF-QA:'+marker+']')};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function waitRun(marker,count){await until(()=>evaluate(`state.agentRuns.length>${count}&&!sendMessage.busy&&!sendMessage.preflight&&!sendMessage.preparingWiki`),'terminal '+marker,35000);await settle();return evaluate('structuredClone(state.agentRuns.at(-1))');}
async function submit(marker,mode,ids){await stage(marker,ids);if(mode)await select(mode);const count=await evaluate('state.agentRuns.length');await click('#agentSend');return waitRun(marker,count);}
async function enqueue(marker){await stage(marker);await evaluate(`document.querySelector('#agentInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);await until(()=>evaluate(`AgentQueue.list(currentConversation()).some(item=>item.goal.includes(${q('[PDF-QA:'+marker+']')}))`),'queued '+marker);return evaluate(`structuredClone(AgentQueue.list(currentConversation()).find(item=>item.goal.includes(${q('[PDF-QA:'+marker+']')})))`);}
async function openNote(id){await evaluate(`openPreview('note',${q(id)})`);await until(()=>evaluate(`NoteEditor.inlineActive(${q(id)})&&!!document.querySelector('.document-toolbar-kit [role=radio]:not([disabled])')`),'real note editor');}
async function noteMode(label){await evaluate(`(()=>{const n=[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].find(n=>n.textContent.trim()===${q(label)}&&!n.disabled);if(!n)throw Error('Document mode unavailable');n.click()})()`);await until(()=>evaluate(label==='源码'?'!!document.querySelector(".cm-content[contenteditable=true]")':'!!document.querySelector(".note-document-preview [data-document-markdown]")'),'document mode '+label);}
const watchdog=setTimeout(()=>{failures.push({label:'watchdog'});void finish(1)},240000);
async function finish(code){
  if(ending)return;ending=true;clearTimeout(watchdog);
  if(win&&!win.isDestroyed()){if(win.webContents.debugger.isAttached())win.webContents.debugger.detach();win.destroy();}
  if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),wait(2500)]);}
  const stopped=!server||server.exitCode!==null||server.signalCode!==null;if(stopped)fs.rmSync(TEMP,{recursive:true,force:true});else failures.push({label:'fixture server remains alive'});
  if(!code&&!failures.length)for(const name of fs.readdirSync(OUT))if(/^(?:failure-.*|fatal)\.png$/.test(name))fs.rmSync(path.join(OUT,name));
  const files=['app/app.js','app/attachment-delivery.js','app/knowledge-access.js','app/server.py','app/agent-queue.js','app/agent-queue-ui.js','app/ui/composer-surfaces.jsx','app/ui/queue-surfaces.jsx','tests/fixtures/pdf-reading-mode.js'];
  const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex')]));
  fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({passed:checks.length,checks,failures,observations,rendererErrors,externalRequests,modelRequests,fileRequests,externalModelCalls:modelRequests.length,userWorkspaceLoaded:false,temporaryProfileRemoved:!fs.existsSync(TEMP),fixtureServerStopped:stopped,sourceHashes,scope:'Synthetic provider and credentials only. Actual PDF upload/read-text HTTP, root renderer, Kit native select, actual send/queue/retry, durable execution and document edit/reload. Not real model quality or native WKWebView acceptance.'},null,2));
  console.log(JSON.stringify({passed:checks.length,failures,report:path.join(OUT,'report.json')},null,2));app.exit(code||failures.length?1:0);
}
async function renderer(){
  win=new BrowserWindow({show:false,width:1440,height:980,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error'){rendererErrors.push(event.message);console.error('RENDERER',event.message);}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>{const local=request.url.startsWith(origin+'/'),url=new URL(request.url),model=local&&/^\/(?:__proxy|__api|__llm|__models|__codex\/respond)(?:[/?]|$)/.test(url.pathname);if(!local)externalRequests.push(request.url);if(model)modelRequests.push(request.url);if(local&&url.pathname.startsWith('/__files/'))fileRequests.push({method:request.method,path:url.pathname+url.search});done({cancel:!local||model});});
  await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`window.webkit={messageHandlers:{workspace:{postMessage(){}}}};window.addEventListener('DOMContentLoaded',()=>{document.body.classList.add('aibro-native');const s=document.createElement('style');s.textContent=${q(fs.readFileSync(path.join(ROOT,'native/Resources/workspace.css'),'utf8'))};document.head.append(s)});`});
  await win.loadURL(origin);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydrated root');
}
(async()=>{
  const port=await new Promise(resolve=>{const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});origin='http://127.0.0.1:'+port;
  const log=fs.openSync(path.join(OUT,'server.log'),'w');server=spawn(process.env.PYTHON||'python3',['-B',path.join(ROOT,'app/server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(port),AI_WORKSTATION_DATA_DIR:STORE,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore',log,log]});fs.closeSync(log);
  await until(()=>new Promise(resolve=>http.get(origin+'/__health',response=>{response.resume();resolve(response.statusCode===200);}).on('error',()=>resolve(false))),'fixture server');
  await app.whenReady();await renderer();await evaluate('window.__AIBRO_PDF_MODE_ISOLATED_QA__=true;\n'+fs.readFileSync(FIXTURE,'utf8'));await until(()=>evaluate('window.__pdfReadingModeFixtureReady'),'PDF fixture');await settle();
  let textRun,noteId,expectedBody,failedRun;
  await check('two real PDFs are uploaded, initial index omits the second-page fact, and mode defaults to original',async()=>{
    const s=await snapshot();assert.equal(s.imports.length,2);assert.equal(s.imports[0].pageCount,2);assert.doesNotMatch(s.imports[0].content+JSON.stringify(s.imports[0].pages),/SECOND_PAGE_FACT_74219/);
    assert.equal(await evaluate('document.querySelector("#composerPdfReadMode")?.tagName'),'SELECT');assert.equal(await evaluate('document.querySelector("#composerPdfReadMode").value'),'original');
    assert.equal(fileRequests.filter(r=>r.method==='POST'&&r.path.startsWith('/__files/')).length,2);assert.deepEqual(await evaluate('__pdfModeProviderCalls'),[]);
  });
  await check('actual text-mode send reads missing page from saved PDF and creates a source-linked document without file/image request blocks',async()=>{
    const before=fileRequests.length;textRun=await submit('TEXT-READ','text');assert.equal(textRun.status,'completed');assert.equal(textRun.pdfReadMode,'text');assert.equal(textRun.executionReceipt.phase,'committed');
    const requests=fileRequests.slice(before);assert.ok(requests.some(r=>r.path.includes('/pdf-mode-source/read-text?')&&new URL(origin+r.path).searchParams.get('page')==='2'));assert.ok(requests.every(r=>!/^\/__files\/pdf-mode-source(?:\?|$)/.test(r.path)&&!/(?:render|read-page|page-image)/.test(r.path)),JSON.stringify(requests));
    const calls=await evaluate(`__pdfModeProviderCalls.filter(call=>call.runId===${q(textRun.id)})`);assert.equal(calls[0].includesSecondPageFact,false);assert.ok(calls.slice(1).some(call=>call.includesSecondPageFact));assert.ok(calls.every(call=>!call.blockTypes.some(type=>['input_file','input_image'].includes(type))));
    assert.ok(textRun.knowledgeReads.some(read=>read.type==='read_page'&&read.page===2&&read.readMode==='extracted_text'&&!read.error));
    const pageEvidence=textRun.evidenceSources.find(source=>source.id==='pdf-mode-source'&&source.page===2&&source.origin==='read_page');
    assert.ok(pageEvidence?.provided);assert.match(pageEvidence.excerpt,/SECOND_PAGE_FACT_74219/);assert.match(pageEvidence.excerpt,/count is 73/);assert.equal(pageEvidence.media,null);
    const s=await snapshot(),note=s.notes.find(note=>note.title==='PDF 文字成果 TEXT-READ');assert.ok(note);noteId=note.id;expectedBody=note.content;assert.match(note.content,/SECOND_PAGE_FACT_74219/);assert.deepEqual(note.sourceAttachmentIds,['pdf-mode-source']);
    assert.equal(s.conversations.find(c=>c.id==='pdf-mode-chat').messages.find(m=>m.id===textRun.userMessageId).pdfReadMode,'text');observations.push({textRunId:textRun.id,noteId,pageEvidence,calls,fileRequests:requests});await shot('text-mode-result');
  });
  await check('generated output opens in the actual editor, saves an additional line, and survives a fresh renderer without provider replay',async()=>{
    assert.ok(noteId);await openNote(noteId);await noteMode('源码');await evaluate(`NoteEditor.restorePosition({mode:'source',selection:{start:${expectedBody.length},end:${expectedBody.length}}})`);await evaluate('document.querySelector(".cm-content[contenteditable=true]").focus()');
    await win.webContents.insertText('\n\nPDF text roundtrip verified.');await until(()=>evaluate('NoteEditor.currentContent()?.content.includes("PDF text roundtrip verified.")'),'actual CodeMirror edit');
    expectedBody=await evaluate('NoteEditor.currentContent().content');assert.equal(await evaluate('NoteEditor.saveInline()'),true);await settle();assert.equal((await snapshot()).notes.find(note=>note.id===noteId).content,expectedBody);await noteMode('阅读');await shot('saved-source-linked-document');
    win.webContents.debugger.detach();win.destroy();await renderer();assert.equal(await evaluate('typeof __pdfReadingModeFixtureReady'),'undefined');await openNote(noteId);await noteMode('阅读');assert.equal(await evaluate('NoteEditor.currentContent().content'),expectedBody);await shot('reloaded-document');
    await evaluate('window.__AIBRO_PDF_MODE_ISOLATED_QA__=true;\n'+fs.readFileSync(FIXTURE,'utf8'));await until(()=>evaluate('__pdfReadingModeFixtureReady'),'provider fixture restored');
  });
  await check('original mode still sends the original input_file representation',async()=>{
    const run=await submit('ORIGINAL','original');assert.equal(run.status,'completed');assert.equal(run.pdfReadMode,'original');
    const calls=await evaluate(`__pdfModeProviderCalls.filter(call=>call.runId===${q(run.id)})`);assert.ok(calls.some(call=>call.blockTypes.includes('input_file')));assert.ok(calls.every(call=>!call.blockTypes.includes('input_image')));observations.push({originalRunId:run.id,calls});
  });
  await check('unsupported original remains failed until the real adjust-attachments form explicitly chooses text and retries',async()=>{
    failedRun=await submit('ORIGINAL-FAIL','original');assert.equal(failedRun.status,'failed');assert.equal(failedRun.errorCode,'PROTOCOL_UNSUPPORTED');
    const count=await evaluate('state.agentRuns.length');await click(`[data-adjust-run="${failedRun.id}"]`);await select('text','retry-pdf-mode-'+failedRun.id);await click('.retry-attachment-editor button[type=submit]');
    const retry=await waitRun('retry text',count);assert.equal(retry.status,'completed');assert.equal(retry.pdfReadMode,'text');assert.equal(retry.userMessageId,failedRun.userMessageId);assert.equal(await evaluate('currentConversation().pdfReadMode'),'original');
    const calls=await evaluate(`__pdfModeProviderCalls.filter(call=>call.runId===${q(retry.id)})`);assert.ok(calls.every(call=>!call.blockTypes.includes('input_file')&&!call.blockTypes.includes('input_image')));observations.push({failedRunId:failedRun.id,retryRunId:retry.id,calls});await shot('explicit-text-retry');
  });
  await check('no-text PDF fails before provider use rather than silently sending a blank index or original',async()=>{
    const before=await evaluate('__pdfModeProviderCalls.length'),run=await submit('NO-TEXT','text',['pdf-mode-scan']);assert.equal(run.status,'failed');assert.equal(run.errorCode,'PDF_TEXT_UNAVAILABLE');assert.equal(await evaluate('__pdfModeProviderCalls.length'),before);assert.equal(run.executionReceipt,undefined);await shot('no-text-error');
  });
  await check('queued messages freeze reading mode; editing one item changes only it, then actual sending follows each saved mode',async()=>{
    await stage('HOLD');await select('original');await click('#agentSend');await until(()=>evaluate('typeof __pdfModeReleaseHold==="function"&&sendMessage.busy'),'synthetic pending provider');
    const first=await enqueue('QUEUE-ORIGINAL'),second=await enqueue('QUEUE-EDIT');assert.equal(first.pdfReadMode,'original');assert.equal(second.pdfReadMode,'original');
    await select('text');await click('#queue-edit-'+second.id);await select('text','queue-pdf-mode-'+second.id);await click('#queue-save-'+second.id);await until(()=>evaluate('!AgentQueueUI.isBusy()&&!AgentQueueUI.isEditing()'),'queue edit saved');await settle();
    const queue=await evaluate('structuredClone(AgentQueue.list(currentConversation()))');assert.equal(queue.find(item=>item.id===first.id).pdfReadMode,'original');assert.equal(queue.find(item=>item.id===second.id).pdfReadMode,'text');assert.equal(await evaluate('currentConversation().pdfReadMode'),'text');await shot('frozen-queue-modes');
    await evaluate('__pdfModeReleaseHold()');await until(()=>evaluate('!sendMessage.busy&&!sendMessage.preflight'),'hold finished');await until(()=>evaluate('!!document.querySelector("#queueSendNext")&&!document.querySelector("#queueSendNext").disabled'),'queue ready');await click('#queueSendNext');
    await until(()=>evaluate('AgentQueue.list(currentConversation()).length===0&&!sendMessage.busy&&!sendMessage.preflight'),'queued sends terminal',60000);await settle();
    const runs=await evaluate('state.agentRuns.filter(run=>/\\[PDF-QA:QUEUE-/.test(run.goal)).map(run=>({id:run.id,goal:run.goal,status:run.status,pdfReadMode:run.pdfReadMode}))');assert.equal(runs.length,2);assert.deepEqual(runs.map(run=>run.status),['completed','completed']);assert.deepEqual(runs.map(run=>run.pdfReadMode),['original','text']);
    const calls=await evaluate('__pdfModeProviderCalls.filter(call=>call.marker.startsWith("QUEUE-"))');assert.ok(calls.filter(call=>call.marker==='QUEUE-ORIGINAL').some(call=>call.blockTypes.includes('input_file')));assert.ok(calls.filter(call=>call.marker==='QUEUE-EDIT').every(call=>!call.blockTypes.includes('input_file')&&!call.blockTypes.includes('input_image')));observations.push({queue,runs,calls});
  });
  await check('composer PDF mode remains reachable in light/dark narrow layouts and a new chat has an independent default',async()=>{
    await stage('ORIGINAL');await select('text');
    for(const theme of ['light','dark']){win.setContentSize(900,900);await evaluate(`state.ui.theme=${q(theme)};applyUiPreferences();renderAll()`);await until(()=>evaluate('!!document.querySelector("#composerPdfReadMode")'),'mode after theme');
      const box=await evaluate('(()=>{const n=document.querySelector("#composerPdfReadMode"),r=n.getBoundingClientRect();return {value:n.value,width:r.width,left:r.left,right:r.right,viewport:innerWidth,description:document.getElementById(n.getAttribute("aria-describedby"))?.textContent,scroll:document.documentElement.scrollWidth,lightClass:document.body.classList.contains("light-mode"),background:getComputedStyle(document.body).getPropertyValue("--bg").trim()}})()');assert.equal(box.value,'text');assert.ok(box.width>30&&box.left>=0&&box.right<=box.viewport);assert.match(box.description,/图像|OCR/);assert.equal(box.lightClass,theme==='light');assert.equal(box.background,theme==='light'?'#f5faf8':'#1b1e20');observations.push({theme,layout:box});await shot('composer-'+theme+'-narrow');}
    win.setContentSize(1440,980);await evaluate('newConversation("日常","pdf-mode-project")');await until(()=>evaluate('currentConversation().id!=="pdf-mode-chat"'),'new chat');await stage('ORIGINAL');assert.equal(await evaluate('document.querySelector("#composerPdfReadMode").value'),'original');assert.equal(await evaluate('state.conversations.find(c=>c.id==="pdf-mode-chat").pdfReadMode'),'text');await shot('new-chat-original-default');
  });
  observations.push({allProviderCalls:await evaluate('__pdfModeProviderCalls')});assert.deepEqual(externalRequests,[]);assert.deepEqual(modelRequests,[]);await finish(failures.length||rendererErrors.length?1:0);
})().catch(async error=>{failures.push({label:'fatal',error:error.stack});console.error(error);await shot('fatal');await finish(1);});
