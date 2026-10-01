/* Proposals are separate from state actions; only a user's review button writes to disk. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.LocalFileEdits=api;})(globalThis,root=>{
 'use strict';
 const F=root.FileContext||(typeof require==='function'?require('./file-context.js'):null);
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 // Browser script order precedes FileReview. Resolve its shared access policy
 // at use time, including when a retained callback runs after privacy changes.
 const reviewAccess=()=>root.FileReview||(typeof require==='function'?require('./file-review.js'):null);
 function allowed(state,kind,run){const result=reviewAccess()?.availableRun?.(state,kind,run?.id,{privateMode:root.PrivateMode?.isOn?.()===true});return result?.run===run?result:null;}
 function validate(edits,state,run,context){
  if(edits===undefined)return [];
  if(!Array.isArray(edits))throw Error('fileEdits 必须是数组。');
  const seen=new Set();
  return edits.map(edit=>{
   if(!edit)throw Error('无效的文件提案。');
   if(edit.operation!=='mkdir'&&(typeof edit.content!=='string'||edit.content.includes('\0')||new TextEncoder().encode(edit.content).length>4*1024*1024))throw Error('文件提案必须包含完整的 UTF-8 文本（不超过 4 MB）。');
   let ref;
   if(edit.operation==='update'){
    ref=context.snapshots.find(r=>r.type==='local'&&F.key(r)===edit.refKey);
    if(!ref||!context.fullyRead(edit.refKey))throw Error('改写前必须读取本轮明确引用文件的全部正文，不能省略未读部分。');
   }else if(['create','mkdir'].includes(edit.operation)){
    if(!run.projectId||edit.projectId!==run.projectId)throw Error('新建本机文件必须属于当前对话项目。');
    const project=state.projects.find(p=>p.id===run.projectId&&F.active(p));ref={projectId:project?.id,candidateId:project?.localFolder?.id,path:edit.path};
   }else throw Error('本机文件提案只支持 create / update / mkdir。');
   const project=state.projects.find(p=>F.active(p)&&p.id===ref.projectId&&p.localFolder?.id&&p.localFolder.id===ref.candidateId);
   if(!project)throw Error('文件所在项目已断开或归档。');
   if(typeof ref.path!=='string'||!ref.path||/[\\%\0]/.test(ref.path)||ref.path.split('/').some(p=>!p||p.startsWith('.'))||(edit.operation!=='mkdir'&&!(/\.(docx|xlsx|pptx|md|mdx|txt|json|html|htm|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|swift|sql|csv|xml|sh|c|h|cpp|py|toml|yaml|yml|go|rs|rb|php|java)$/i.test(ref.path))))throw Error('请使用已有父目录下的普通相对路径；文件需为 Markdown、代码或配置文本。');
   if(/\.(docx|xlsx|pptx)$/i.test(ref.path)){try{const spec=JSON.parse(edit.content);if(!spec||Array.isArray(spec)||typeof spec!=='object')throw Error();}catch{throw Error('Office 提案内容必须是结构化 JSON。');}}
   const key=JSON.stringify([ref.candidateId,ref.path]);if(seen.has(key))throw Error('同一轮不能重复修改同一个文件。');seen.add(key);
   return {operation:edit.operation,content:edit.content||'',candidateId:ref.candidateId,projectId:ref.projectId,path:ref.path,version:ref.version,runId:run.id};
  });
 }
 // Rebuild from durable run records, never from the currently visible messages.
 function outputs(state,conversationId){
  const rows=[],seen=new Set();
  // This script loads before DraftReview in the browser. Resolve the shared
  // status API when projecting, without creating an editor/review session.
  const review=root.DraftReview||(typeof require==='function'?require('./draft-review.js'):null);
  for(const run of [...(state.agentRuns||[])].filter(r=>r.conversationId===conversationId&&F.active(r)).sort((a,b)=>(b.startedAt||0)-(a.startedAt||0))){
   for(const edit of allowed(state,'local-review',run)?.changes||[])rows.push({kind:'local',runId:run.id,id:edit.id,title:edit.path,status:edit.status,pending:['pending','partial'].includes(edit.status)});
   for(const change of allowed(state,'review',run)?.changes||[]){
    const key=JSON.stringify([change.type,change.id]);if(seen.has(key))continue;
    const current=F.available(state,change.type,change.id);if(!current||change.undoneAt)continue;
    const proposal=change.operation==='drafted'?review?.proposalStatus?.(state,change,{runId:run.id,includeReview:false}):null;
    if(change.operation==='drafted'&&!['pending','adopted'].includes(proposal?.status))continue;
    // Rejected/superseded proposals are historical changes, not saved outputs.
    // They must not hide a valid saved result from an earlier run either.
    seen.add(key);
    rows.push({kind:change.type,runId:run.id,id:change.id,title:current.title||current.name||change.title,pending:proposal?.status==='pending',...(proposal?{status:proposal.status}:{})});
   }
  }
  return rows.sort((a,b)=>Number(b.pending)-Number(a.pending));
 }
 function followUp(state,run,edit,action){
  if(edit.directory)return;
  const conversation=(state.conversations||[]).find(c=>c.id===run.conversationId&&F.active(c));if(!conversation)return;
  const old=edit.transition?edit.transition.beforeVersion:action==='apply'?edit.beforeVersion:edit.afterVersion,next=edit.transition?edit.transition.afterVersion:action==='apply'?edit.afterVersion:edit.beforeVersion;
  const identity={type:'local',candidateId:edit.candidateId,projectId:edit.projectId,path:edit.path};
  const refs=F.references(conversation),existing=refs.find(r=>F.key(r)===F.key(identity));
  if(existing&&existing.version===old){if(next)F.refresh(conversation,{...existing,version:next,selectedAt:Date.now()});else F.remove(conversation,existing);}
  else if(['apply','accept-hunk'].includes(action)&&old===null&&next&&!existing&&!(conversation.excludedFileReferenceKeys||[]).includes(F.key(identity))){
   F.stage(conversation,{...identity,title:edit.path.split('/').at(-1),version:next,selectedAt:Date.now()});
  }
 }
 function tray(conversation){
  if(!hooks||!conversation)return;
  let host=root.document.getElementById('conversationOutputs');
  if(!host){host=el('details','conversation-outputs');host.id='conversationOutputs';root.document.getElementById('composer')?.before(host);}
  if(host.dataset.conversationId!==conversation.id)host.open=false;
  host.dataset.conversationId=conversation.id;const rows=outputs(hooks.getState(),conversation.id);host.hidden=!rows.length;host.replaceChildren();if(!rows.length)return;
  const pending=rows.filter(r=>r.pending).length,summary=el('summary');summary.append(el('span','',t('对话产出','Conversation files')+` · ${rows.length}`));if(pending)summary.append(el('span','output-pending',`${pending} `+t('项待审阅','to review')));host.append(summary);
  const list=el('div','conversation-output-list');
  for(const row of rows){const current=()=>outputs(hooks.getState(),conversation.id).some(item=>item.kind===row.kind&&item.runId===row.runId&&item.id===row.id),item=el('div','conversation-output-row'),open=btn(row.title,event=>{
   if(!current())return false;const navigation={anchor:event?.currentTarget};return row.kind==='local'?hooks.open(row.runId,row.id,navigation):hooks.openFile(row.kind,row.id,undefined,undefined,current,navigation);
  });open.className='output-file';open.title=row.title;
   item.append(open,el('small','',row.kind==='local'?status(row.status):row.pending?t('待采纳草稿','Draft to review'):t('已入库','In library')));
   if(row.kind!=='local'){const review=btn(t('查看修改','Review changes'),event=>current()?hooks.openReview(row.runId,row.id,{anchor:event?.currentTarget}):false);review.className='output-review';item.append(review);}list.append(item);
  }host.append(list);
 }
 let hooks;
 const renderOwners=new WeakMap();
 const el=(tag,cls,text)=>{const node=root.document.createElement(tag);node.className=cls||'';if(text!==undefined)node.textContent=text;return node;};
 const btn=(text,fn)=>{const b=el('button','secondary',text);b.type='button';b.onclick=fn;return b;};
 const status=s=>({pending:t('待保存到本机','Ready to save'),partial:t('部分已审阅','Partially reviewed'),applied:t('已保存到本机','Saved to file'),undone:t('已撤销','Undone'),dismissed:t('已放弃','Dismissed'),interrupted:t('需要检查当前文件','Check current file'),applying:t('正在确认保存结果','Checking save result'),undoing:t('正在确认撤销结果','Checking undo result')})[s]||s;
 function card(run){
  if(!run?.localFileEdits?.length)return null;
  const eligible=allowed(hooks?.getState?.(),'local-review',run);if(!eligible)return null;
  const open=(id,event)=>{const latest=allowed(hooks?.getState?.(),'local-review',run);if(!latest||id&&!latest.changes.some(edit=>edit.id===id))return false;return hooks.open(run.id,id,{anchor:event?.currentTarget});};
  const card=el('section','file-change-card local-file-change-card'),head=el('header');head.append(el('strong','',t('本机文件修改','Local file changes')+` · ${eligible.changes.length}`),btn(t('审阅文件','Review files'),event=>open(undefined,event)));card.append(head,el('p','local-file-notice',t('提案已保存在此设备。接受修改块或保存到本机后，才会写入对应修改。','Proposals are stored on this device. Only changes you accept or save are written to the file.')));
  for(const edit of eligible.changes){const row=btn('',event=>open(edit.id,event));row.className='file-change-row';row.append(el('span','file-change-name',edit.path),el('span','local-file-status',status(edit.status)));if(edit.status==='applied')row.dataset.fileRef=JSON.stringify({type:'local',...edit});card.append(row);}
  return card;
 }
 function render(container,run,selectedId,bookmark){
  const owner={},workspace=hooks.getState();renderOwners.set(container,owner);
  let epoch=0,workbench,acting=false;
  const active=value=>F.active(value)&&!value.private&&!value.ephemeral&&!value.incognito;
  const unique=(items,id)=>{const matches=(items||[]).filter(item=>item.id===id);return matches.length===1?matches[0]:null;};
  const valid=(edit,action)=>{const state=hooks.getState();if(hooks.isBusy?.()||!active(run)||unique(state.agentRuns,run.id)!==run||(action==='dismiss'?['running']:['running','failed','cancelled']).includes(run.status))throw Error(t('请等待对话完成，并从有效的执行记录审阅。','Wait for the conversation to finish and review an active run.'));if(action!=='dismiss'&&!state.projects.some(p=>active(p)&&p.id===edit.projectId&&p.localFolder?.id===edit.candidateId))throw Error(t('项目目录已断开或归档。','The project is disconnected or archived.'));};
  async function select(file,viewer,viewState){
   const summary=file.edit,ticket=++epoch,project=unique(workspace.projects,summary.projectId),conversationId=run.conversationId,runProjectId=run.projectId,conversation=conversationId?unique(workspace.conversations,conversationId):null;
   const identity={id:summary.id,runId:run.id,projectId:summary.projectId,candidateId:summary.candidateId,path:summary.path},folderId=project?.localFolder?.id;
   const matches=edit=>edit&&Object.keys(identity).every(key=>edit[key]===identity[key]);
   // A response belongs to this render and these exact workspace objects, not
   // merely a reused run ID after navigation, hydration or a folder rebind.
   const owned=()=>renderOwners.get(container)===owner&&hooks.getState()===workspace&&!!allowed(workspace,'local-review',run)
    &&run.id===identity.runId&&run.conversationId===conversationId&&run.projectId===runProjectId&&unique(workspace.agentRuns,run.id)===run&&active(run)&&unique(run.localFileEdits,summary.id)===summary
    &&(!summary.runId||summary.runId===identity.runId)
    &&Object.keys(identity).filter(key=>key!=='runId').every(key=>summary[key]===identity[key])
    &&unique(workspace.projects,identity.projectId)===project&&active(project)&&project.localFolder?.id===folderId
    &&(!run.conversationId||unique(workspace.conversations,run.conversationId)===conversation&&active(conversation));
   const current=()=>owned()&&ticket===epoch&&viewer.isConnected;
   if(!current())return;
   root.ReviewWorkbench.dispose?.(viewer);
   viewer.replaceChildren(el('p','muted',t('正在读取修改快照…','Loading change snapshots…')));
   try{
    let edit=await F.request('/__local/edits/get',{id:identity.id});if(!current())return;
    if(!matches(edit))throw Error(t('修改快照与此文件不一致，请重新读取。','The change snapshot does not match this file. Reload it.'));
    if(summary.status!==edit.status){summary.status=edit.status;hooks.save();}file.status=status(edit.status);workbench?.refresh(file);
    function draw(){
     const actions=el('div','file-review-actions'),error=el('p','file-review-error');error.hidden=true;error.setAttribute('role','alert');
     async function act(action,hunkId){
      if(acting||!current())return false;acting=true;
      try{valid(edit,action);viewer.querySelectorAll('.review-file-actions button,.review-hunk-actions button').forEach(b=>b.disabled=true);const result=await F.request('/__local/edits/'+action,{id:edit.id,...(hunkId?{hunkId,reviewRevision:edit.reviewRevision}:{})});
       if(!owned())return false;
       if(!matches(result))throw Error(t('保存结果与此文件不一致，请重新读取快照核对。','The save result does not match this file. Reload the snapshot to check it.'));
       edit=result;if(['apply','undo','accept-hunk','undo-hunk'].includes(action))hooks.fileChanged?.(run,result,action);summary.status=result.status;hooks.save();
       file.status=status(result.status);workbench?.refresh(file);if(current()){draw();if(hunkId){const section=[...viewer.querySelectorAll('.review-hunk')].find(n=>n.dataset.hunkId===hunkId);(section?.querySelector('button')||section)?.focus({preventScroll:true});}}return true;
      }catch(e){if(current()){viewer.querySelectorAll('.review-file-actions button,.review-hunk-actions button').forEach(b=>b.disabled=false);error.textContent=e.message;error.hidden=false;error.scrollIntoView({block:'nearest'});}return false;}
      finally{acting=false;}
     }
     if(['pending','partial'].includes(edit.status)){const save=btn(edit.status==='partial'?t('接受其余修改','Accept remaining changes'):t('保存到本机','Save to file'),()=>act('apply'));save.dataset.localEditAction='apply';actions.append(save);const dismiss=btn(edit.status==='partial'?t('拒绝其余修改','Reject remaining changes'):t('放弃提案','Dismiss proposal'),()=>act('dismiss'));dismiss.dataset.localEditAction='dismiss';actions.append(dismiss);}
     if(edit.status==='applied'||edit.hunks?.some(h=>h.status==='accepted')){const undo=btn(t('撤销已接受修改','Undo accepted changes'),()=>act('undo'));undo.dataset.localEditAction='undo';actions.append(undo);}
     const source={type:'local',projectId:edit.projectId,candidateId:edit.candidateId,path:edit.path,runId:run.id,...(run.conversationId?{conversationId:run.conversationId}:{})};
     const canOpen=()=>current()&&!edit.directory&&!edit.office&&(!edit.creating||edit.status==='applied'||edit.hunks?.some(h=>h.status==='accepted'))
      &&!!root.ProjectFiles?.parseLocal?.(root.ProjectFiles.localId(source),hooks.getState())&&(!root.CitationEvidence||root.CitationEvidence.access(hooks.getState(),source).available);
     if(hooks.openFile&&canOpen())actions.append(btn(t('打开当前文件','Open current file'),event=>hooks.openFile('local-file',root.ProjectFiles.localId(source),undefined,source,canOpen,{anchor:event?.currentTarget})));
     if(!edit.creating||edit.status==='applied')actions.append(btn(t('在 Finder 中显示','Show in Finder'),async()=>{try{await root.FileActions.reveal({type:'local',...edit});}catch(e){hooks.toast(e.message);}}));
     const doc=root.ReviewWorkbench.document(viewer,{path:edit.path,before:edit.before,after:edit.after,preview:/\.md$/i.test(edit.path),markdown:hooks.markdown,notice:status(edit.status)+' · '+(edit.hunks?.length?t('接受立即写入该块，拒绝保留原文；这里保留完整提案快照。','Accept writes this block; reject keeps the original. The complete proposal is preserved here.'):t('此处保留本轮快照；文件的后续修改不会覆盖它。','This review preserves the snapshots from this turn.')),actions:[...actions.children],hunks:edit.hunks||[],onHunk:['pending','partial','applied'].includes(edit.status)?act:null},viewState);
     doc.footer.append(error);
    }draw();
   }catch(error){if(current()){
    const message=el('p','file-review-error',error.message);message.setAttribute('role','alert');const retryHost=el('div','review-retry-actions');
    viewer.replaceChildren(message,retryHost);const retry=()=>current()?select(file,viewer,viewState):false;
    if(root.HalaskaUI?.componentNames?.includes('Button'))root.HalaskaUI.mount(retryHost,'Button',{variant:'secondary',size:'sm',children:t('重新读取','Reload snapshot'),onClick:retry});
    else retryHost.append(btn(t('重新读取','Reload snapshot'),retry));
   }}
  }
  workbench=root.ReviewWorkbench.create(container,{key:'local:'+run.id,files:(allowed(workspace,'local-review',run)?.changes||[]).map(edit=>({id:edit.id,path:edit.path,status:status(edit.status),edit})),selectedId,bookmark,onSelect:select});
  return workbench;
 }
 return {validate,outputs,followUp,tray,card,render,init(value){hooks=value;}};
});
