/* One durable ledger for read tools, provider tools and controlled commands. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ToolScheduler=api;})(globalThis,root=>{
  'use strict';
  const reads=new Set(['task_list','list','search','neighbors','read','read_page','read_file','wiki_list','memory_read','delegate','capabilities','history_search','history_read','library_overview','evidence_log']);
  const pending=new Set(['queued','running','awaiting-approval']);
  const clone=x=>JSON.parse(JSON.stringify(x));
  const cancelled=()=>Object.assign(Error('已停止工具执行'),{code:'CANCELLED'});
  const label=type=>({evidence_log:'读取账本',library_overview:'资料概览',capabilities:'操作说明',history_search:'搜索对话',history_read:'读取对话',task_list:'任务目录',list:'资料目录',search:'检索',neighbors:'相邻证据',read:'读取正文',read_page:'读取原件',read_file:'工作区文件',wiki_list:'Wiki 目录',memory_read:'项目记忆',delegate:'子代理',terminal:'终端',web_read:'网页读取',web_search:'网页搜索'})[type]||type;
  function safeRequest(request){
    const out={};for(const key of ['type','id','recordType','query','offset','page','refKey','variant','chunkId','version','radius','argv','cwd','timeout','task','title','url','name','messageId','maxTokens','runId','tabId','sessionId','snapshotId','ref','text','x','y'])if(request[key]!==undefined)out[key]=clone(request[key]);
    return out;
  }
  function resultSnapshot(value){
    // Model context is bounded separately by KnowledgeAccess. The durable
    // execution record must retain received text, including long tool output.
    const {blocks,...data}=value||{};
    return {result:data,truncated:false};
  }
  function create({run,execute,signal,checkpoint=async()=>{},changed=()=>{},validate=()=>{},concurrency=3,parentId=null}){
    run.toolCalls ||= []; let serial=Promise.resolve();
    // Saves are ordered even while independent network/file reads overlap.
    const persist=()=>{changed();const next=serial.then(checkpoint);serial=next.catch(()=>{});return next;};
    const check=()=>{if(signal?.aborted)throw cancelled();validate();};
    async function batch(requests){
      check();if(!Array.isArray(requests)||requests.length>32)throw Error('每批最多 32 个工具请求，请分批继续。');
      // 空转预警：同一工具用相同参数被反复调用时先停下来，把"要不要继续"交回用户。
      // 判据是机械的（参数逐字相同 + 计数达阈值），参数变化的分页读取不会被误伤。
      const guard=root.ToolLoopGuard?.inspect(run.toolCalls.filter(call=>(call.parentId||null)===(parentId||null)),undefined,requests);
      if(guard&&guard.repeated.length){const item=guard.repeated[0];throw Object.assign(Error(root.ToolLoopGuard.describe(item,guard.limit)),{code:'REPEATED_TOOL',toolType:item.type,toolCount:item.count});}
      const entries=requests.map(request=>{if(!request||typeof request.type!=='string')throw Error('无效工具请求');return {id:'tool_'+Date.now()+'_'+Math.random().toString(36).slice(2),parentId,type:request.type,request:safeRequest(request),status:'queued',createdAt:Date.now()};});
      // A control or persistence failure stops this batch, including workers
      // already waiting for their pre-execution checkpoint. Received results
      // still pass through save(), so stopping never discards a tool receipt.
      let stopped;
      const stop=error=>{stopped ||= error;};
      const checkBatch=()=>{if(stopped)throw stopped;try{check();}catch(error){stop(error);throw error;}};
      const save=async()=>{try{await persist();}catch(error){stop(error);throw error;}};
      run.toolCalls.push(...entries);try{await save();checkBatch();}catch(error){for(const entry of entries){entry.status=error.code==='CANCELLED'||signal?.aborted?'cancelled':'failed';entry.error=error.message;entry.finishedAt=Date.now();}throw error;}const results=new Array(entries.length);
      async function invoke(i){
        const entry=entries[i];
        try{
          checkBatch();entry.status='running';entry.startedAt=Date.now();await save();checkBatch();
          let result,received=false;
          // Only an execute rejection is an ordinary tool failure. Scope checks
          // and durable-save failures must escape and stop later operations.
          try{result=await execute(clone(entry.request),{signal,entry});received=true;}
          catch(error){entry.status=error.code==='CANCELLED'||signal?.aborted?'cancelled':'failed';entry.error=error.message;results[i]={error:error.message};if(error.code==='CANCELLED')stop(error);}
          if(received){
            const value=result||{};
            Object.assign(entry,resultSnapshot(value));results[i]=value;
            entry.status=['cancelled','rejected'].includes(value.status)?'cancelled':value.error||['failed','timed_out','interrupted'].includes(value.status)?'failed':'completed';
          }
        }catch(error){stop(error);if(pending.has(entry.status)){entry.status=error.code==='CANCELLED'||signal?.aborted?'cancelled':'failed';entry.error=error.message;}throw error;}
        finally{entry.finishedAt=Date.now();await save();}
        // Persist the authoritative returned outcome before honoring a stop or
        // scope change. Cancellation is not evidence that effects rolled back.
        checkBatch();
      }
      try{
        let start=0;
        while(start<entries.length){
          checkBatch();if(!reads.has(entries[start].type)){await invoke(start++);continue;}
          let end=start;while(end<entries.length&&reads.has(entries[end].type))end++;
          let cursor=start;const workers=Array.from({length:Math.min(Math.max(1,concurrency),end-start)},async()=>{while(cursor<end){checkBatch();const i=cursor++;await invoke(i);}});
          const settled=await Promise.allSettled(workers);const failure=settled.find(x=>x.status==='rejected');if(failure)throw failure.reason;start=end;
        }
        return results;
      }finally{
        for(const entry of entries)if(pending.has(entry.status)){entry.status='cancelled';entry.error='本批中止，未执行或未完成';entry.finishedAt=Date.now();}
        await save();
      }
    }
    return {batch,persist};
  }
  function provider(run,activity,parentId=null){
    if(activity?.kind!=='tool')return false;run.toolCalls ||= [];
    const id='provider:'+String(parentId||'main')+':'+activity.id;
    let entry=run.toolCalls.find(x=>x.id===id);
    if(!entry){entry={id,parentId,type:activity.name||'provider',createdAt:Date.now(),request:{type:activity.name||'provider'}};run.toolCalls.push(entry);}
    if(!pending.has(entry.status)&&entry.finishedAt)return false;
    if(activity.url)entry.request.url=activity.url;
    entry.status=activity.status==='pending'?'queued':activity.status||'running';entry.summary=activity.text;
    if(entry.status==='running')entry.startedAt ||= Date.now();if(!pending.has(entry.status))entry.finishedAt=Date.now();return true;
  }
  function finish(run,status){for(const entry of run.toolCalls||[])if(pending.has(entry.status)){entry.status=status==='cancelled'?'cancelled':'interrupted';entry.finishedAt=Date.now();entry.error='未收到工具完成结果，请核对执行记录。';}}
  function recover(state,instanceId){
    if(!instanceId)return false;let changed=false;
    for(const run of state.agentRuns||[])if(run.status==='running'&&run.executionInstanceId&&run.executionInstanceId!==instanceId){
      run.status='interrupted';run.error='上次执行随本机服务结束而中断。已保存的输出保留，请核对后继续。';run.finishedAt=Date.now();finish(run,'interrupted');
      for(const child of run.delegations||[])if(pending.has(child.status)){child.status='interrupted';child.finishedAt=Date.now();}
      for(const step of run.steps||[])if(step.status==='running')step.status='interrupted';
      const c=(state.conversations||[]).find(x=>x.id===run.conversationId);const m=c?.messages?.find(x=>x.runId===run.id);
      if(m){m.live=false;m.runStatus='interrupted';m.retryRunId=run.id;m.text=(m.text||'')+'\n\n'+run.error;}
      changed=true;
    }return changed;
  }
  function card(run,{embedded=false}={}){
    if(!run?.toolCalls?.length||!root.document)return null;
    const el=(tag,text,cls)=>{const x=root.document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;};
    const en=root.WorkstationI18n?.getLanguage?.()==='en';
    // 工具记录与过程段一样“呼吸”：本轮未结束时自动展开（能实时看到正在调用什么工具、
    // 参数与结果），进入终态后自动收敛成一行摘要，把正文让给最终答案。用户手动开合过的
    // 以用户为准（run.toolLedgerPins）——流式重绘与完成收束都不会覆盖它。
    const settled=['completed','cancelled','rejected','failed','interrupted','awaiting-approval'].includes(run.status);
    const live=!settled&&!run.finishedAt;
    const picked=(key,auto)=>{const pins=run.toolLedgerPins;return pins&&Object.prototype.hasOwnProperty.call(pins,key)?pins[key]===true:!!auto;};
    const inspectingRaw=run.toolCalls.some(call=>picked('raw:'+call.id,false));
    // A conversation process panel already owns the outer disclosure. Keep
    // standalone cards unchanged for run history and other existing callers.
    const box=el(embedded?'div':'details',undefined,embedded?'tool-ledger tool-ledger-embedded':'tool-ledger message-steps');
    if(!embedded){if(picked('ledger',live||inspectingRaw))box.open=true;box.append(el('summary',(en?'Tool history · ':'工具执行记录 · ')+run.toolCalls.length));}
    const names=en?{queued:'Queued',running:'Running',completed:'Completed',failed:'Failed',cancelled:'Cancelled',interrupted:'Interrupted'}:{queued:'等待',running:'进行中',completed:'完成',failed:'失败',cancelled:'已停止',interrupted:'已中断'};
    // 人类可读优先：参数与结果以键值行呈现，长文本字段（正文/摘要/说明）完整成块；
    // 原始 JSON 一律收进“查看原始数据”二级折叠——可核查性不变，但不再整屏灌 JSON。
    const BODY=new Set(['content','text','markdown','body','output','nextStep','summary','excerpt','abstract','chapter']);
    const shown=value=>{if(value===undefined||value===null)return'';if(typeof value==='string')return value;if(typeof value==='number'||typeof value==='boolean')return String(value);try{const raw=JSON.stringify(value);return raw.length>200?raw.slice(0,200)+' …':raw;}catch(_){return String(value);}};
    const list=(row,caption,value,part)=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      const keys=Object.keys(value).filter(key=>value[key]!==undefined&&value[key]!==null);
      if(!keys.length)return;
      const block=el('div',undefined,'tool-ledger-block');
      block.dataset.liveKey=part;
      block.append(el('div',caption,'tool-ledger-caption'));
      for(const key of keys.slice(0,24)){
        const text=shown(value[key]);
        if(!text)continue;
        if(BODY.has(key)&&typeof value[key]==='string'&&text.length>120){block.append(el('pre',text.length>8000?text.slice(0,8000)+' …':text,'tool-ledger-text'));continue;}
        const line=el('div',undefined,'tool-ledger-line');
        line.append(el('span',key+'：','tool-ledger-key'),el('span',text.length>300?text.slice(0,300)+' …':text));
        block.append(line);
      }
      if(keys.length>24)block.append(el('div',en?`… ${keys.length-24} more fields`:`…另有 ${keys.length-24} 项`,'tool-ledger-line'));
      row.append(block);
    };
    for(const call of run.toolCalls){const row=el('details',undefined,'tool-ledger-row');row.dataset.toolId=call.id;
      if(picked(call.id,(live&&call.status==='running')||picked('raw:'+call.id,false)))row.open=true;
      const resultData=call.result&&typeof call.result==='object'&&call.result.result!==undefined?call.result.result:call.result;
      const subject=call.request?.title||resultData?.title||call.request?.query||call.request?.name||call.request?.id||'';
      const title=[(en?call.type:label(call.type))||(en?'Tool operation':'工具操作'),subject].filter(Boolean).join(' · ');
      row.append(el('summary',`${call.parentId?'↳ ':''}${title} · ${names[call.status]||(en?'Unconfirmed':'未确认')}`));
      list(row,en?'Parameters':'参数',call.request,'parameters');
      list(row,en?'Result':'结果',resultData,'result');
      if(call.error)row.append(el('p',call.error));if(call.summary)row.append(el('p',call.summary));if(call.truncated)row.append(el('p',en?'History preview truncated; original tool pagination remains available.':'日志预览已截断；原工具仍可分页读取。'));
      const raw=el('details',undefined,'tool-ledger-raw');
      raw.dataset.toolLedgerKey='raw:'+call.id;
      if(picked(raw.dataset.toolLedgerKey,false))raw.open=true;
      raw.append(el('summary',en?'Raw data':'查看原始数据'));
      raw.append(el('pre',JSON.stringify(call.request,null,2)));
      if(call.result)raw.append(el('pre',JSON.stringify(call.result,null,2)));
      row.append(raw);
      box.append(row);
    }return box;
  }
  return {create,provider,finish,recover,card,safeRequest,resultSnapshot};
});
