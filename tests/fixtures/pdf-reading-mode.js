/* ISOLATED STORE ONLY: set window.__AIBRO_PDF_MODE_ISOLATED_QA__ = true first.
 * Synthetic provider and credentials; real PDF upload/read-text/file adapters.
 * No message is sent by setup. Use the real composer select and send button:
 * 整理这份 PDF 并保存分析笔记 [PDF-QA:TEXT-READ]
 * 核验 PDF 原件连接 [PDF-QA:ORIGINAL-FAIL] (choose original, then adjust/retry text)
 * 检查原件输入 [PDF-QA:ORIGINAL]
 * 等待队列验收 [PDF-QA:HOLD] (release via __pdfModeReleaseHold())
 * Initial index intentionally omits PDF page 2. Only the actual read-text
 * response can supply SECOND_PAGE_FACT_74219 to the synthetic provider.
 */
;(async function pdfReadingModeFixture() {
  if (window.__AIBRO_PDF_MODE_ISOLATED_QA__ !== true) throw Error('PDF fixture requires an explicitly isolated store.');
  while (!storageHydrated) await new Promise(resolve => setTimeout(resolve,25));
  const projectId='pdf-mode-project',conversationId='pdf-mode-chat',sourceId='pdf-mode-source',scanId='pdf-mode-scan';
  const firstPage='Page one: reading mode is an explicit choice. Preserve the original file.';
  const secondPage='SECOND_PAGE_FACT_74219: The verified rehearsal count is 73. This sentence is absent from the initial text index.';
  function pdfBytes(lines) {
    const fontId=3+lines.length*2,objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${lines.map((_,index)=>`${3+index*2} 0 R`).join(' ')}] /Count ${lines.length} >>`];
    lines.forEach((text,index)=>{
      const commands=`BT /F1 10 Tf 36 760 Td (${text.replace(/([\\()])/g,'\\$1')}) Tj ET`;
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 800] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4+index*2} 0 R >>`,`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`);
    });
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    let source='%PDF-1.4\n',offsets=[0];
    objects.forEach((body,index)=>{offsets.push(source.length);source+=`${index+1} 0 obj\n${body}\nendobj\n`;});
    const start=source.length;source+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('');
    source+=`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return new TextEncoder().encode(source);
  }
  if(!state.projects.some(project=>project.id===projectId)) {
    const now=Date.now(),source=pdfBytes([firstPage,secondPage]),scan=pdfBytes(['']);
    state.projects=[{id:projectId,name:'PDF 读取方式 · 隔离验收',workspace:'日常',createdAt:now}];
    state.imports=[{id:sourceId,name:'两页文字读取验收.pdf',originalName:'two-page-reading.pdf',mimeType:'application/pdf',content:firstPage,pages:[{page:1,text:firstPage}],pageCount:2,contentTruncated:true,fileStored:true,size:source.length,workspace:'日常',projectId,status:'parsed',createdAt:now,updatedAt:now},
      {id:scanId,name:'无文字页面验收.pdf',originalName:'empty-text-page.pdf',mimeType:'application/pdf',content:'',pages:[],pageCount:1,fileStored:true,size:scan.length,workspace:'日常',projectId,status:'original-only',createdAt:now,updatedAt:now}];
    state.notes=[];state.tasks=[];state.papers=[];state.trash=[];state.agentRuns=[];
    state.conversations=[{id:conversationId,title:'PDF 读取验收',workspace:'日常',projectId,permissionMode:'auto',pdfReadMode:'original',modelConfig:{provider:'api',model:'synthetic-pdf-mode',effort:'medium'},messages:[],attachments:[sourceId],draftAttachmentIds:[sourceId],draft:'',createdAt:now}];
    state.currentConversationId=conversationId;state.currentProjectId=projectId;
    state.ui.onboarding={version:window.WorkstationOnboarding?.VERSION||1,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};
    state.ui.inspectorOpen=false;state.ui.theme='light';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};state.settings.reduceMotion=true;
    normalizeStateShape(state);await saveDocumentDurably();
    for(const [id,bytes,name]of[[sourceId,source,'two-page-reading.pdf'],[scanId,scan,'empty-text-page.pdf']]) {
      const response=await fetch('/__files/'+id,{method:'POST',headers:{'Content-Type':'application/pdf','X-Filename':name},body:bytes});
      if(!response.ok)throw Error('Fixture PDF upload failed: '+response.status);
    }
  }
  captureApiConnection=()=>({base:'https://synthetic-fixture.invalid/v1',token:'FICTIONAL-NONSECRET-FIXTURE-KEY',protocol:'responses'});
  getApiConnection=async()=>({base:'https://synthetic-fixture.invalid/v1',token:'FICTIONAL-NONSECRET-FIXTURE-KEY',protocol:'responses'});
  ConversationModels.resolve=async config=>({...config,provider:'api',model:'synthetic-pdf-mode'});
  window.__pdfModeProviderCalls||=[];window.__pdfModeHeldRuns||=[];
  const blocksOf=input=>Array.isArray(input)?input.flatMap(message=>Array.isArray(message.content)?message.content:[]):[];
  AgentTransport.requestPlan=async options=>{
    const run=state.agentRuns.find(item=>item.id===activeRunId)||state.agentRuns.at(-1),marker=String(run?.goal||'').match(/\[PDF-QA:([A-Z-]+)\]/)?.[1];
    const input=typeof options.input==='string'?options.input:JSON.stringify(options.input),blocks=blocksOf(options.input);
    if(!marker||!input.includes(`[PDF-QA:${marker}]`))throw Object.assign(Error('PDF fixture only handles explicitly marked synthetic tasks.'),{code:'SYNTHETIC_MARKER_REQUIRED'});
    if(options.signal?.aborted)throw Object.assign(Error('Stopped synthetic response'),{code:'CANCELLED'});
    window.__pdfModeProviderCalls.push({runId:run.id,marker,pdfReadMode:run.pdfReadMode,blockTypes:blocks.map(block=>block.type),fileNames:blocks.filter(block=>block.type==='input_file').map(block=>block.filename),includesSecondPageFact:input.includes('SECOND_PAGE_FACT_74219'),inputCharacters:input.length});
    if(marker==='HOLD'&&!window.__pdfModeHeldRuns.includes(run.id)) {
      window.__pdfModeHeldRuns.push(run.id);
      await new Promise((resolve,reject)=>{const stop=()=>{window.__pdfModeReleaseHold=null;reject(Object.assign(Error('Stopped synthetic response'),{code:'CANCELLED'}));};options.signal?.addEventListener('abort',stop,{once:true});window.__pdfModeReleaseHold=()=>{options.signal?.removeEventListener('abort',stop);window.__pdfModeReleaseHold=null;resolve();};});
    }
    if(marker==='ORIGINAL-FAIL'&&run.pdfReadMode==='original')throw Object.assign(Error('合成兼容接口拒绝 PDF 原件，请主动选择读取文字重试。'),{code:'PROTOCOL_UNSUPPORTED'});
    if(run.pdfReadMode==='text'&&['TEXT-READ','ORIGINAL-FAIL','QUEUE-EDIT'].includes(marker)) {
      if(!run.knowledgeReads?.some(read=>read.type==='read_page'&&read.id===sourceId&&read.page===2&&!read.error)||!input.includes('SECOND_PAGE_FACT_74219'))return JSON.stringify({knowledgeRequests:[{type:'read_page',recordType:'import',id:sourceId,page:2,offset:0}],workingSummary:'首轮仅有第1页文字；需要读取第2页核对。',actions:[]});
      const body='# PDF 文字读取成果\n\n## 已核对文字\n\n第2页实际返回：SECOND_PAGE_FACT_74219，rehearsal count 为 73。此句未包含在初始文字索引中，通过保存的 PDF 原件按页提取后补充。\n\n## 范围\n\n本次仅核对可提取文字，未提供页面图像，未执行 OCR，也没有声称读懂图表与版式。原件仍保留，可返回来源继续核对。';
      return JSON.stringify({workspace:'日常',message:'已从原件第2页文字核对 rehearsal count 为 73，并保存带来源的文字成果；图像与版式未核对。',actions:[{type:'create_knowledge_item',title:'PDF 文字成果 '+marker,content:body,workspace:'日常',projectId,sourceAttachmentIds:[sourceId]}]});
    }
    return JSON.stringify({workspace:'日常',message:'这是一条合成连接验收响应；附件表示已经记录，未据此产生真实模型分析。',actions:[]});
  };
  window.WorkstationOnboarding?.close();window.WorkspaceTour?.close();applyUiPreferences();renderAll();
  if(document.body.dataset.view!=='agent'||state.currentConversationId!==conversationId)await navigateWorkspaceConversation(conversationId);
  window.__pdfReadingModeFixtureReady=true;
})();
