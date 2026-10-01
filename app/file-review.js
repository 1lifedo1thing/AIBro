(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.FileReview=api;})(globalThis,root=>{
'use strict';
const clone=x=>x==null?null:JSON.parse(JSON.stringify(x));
const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
const fields={note:['title','content','folderPath','projectId','workspace','sourceAttachmentIds','aiDraft','userEdited','userEditedAt','updatedAt'],import:['name','folderPath','projectId','workspace','updatedAt']};
function record(type,item){if(!item)return null;return Object.fromEntries(fields[type].filter(k=>Object.hasOwn(item,k)).map(k=>[k,clone(item[k])]));}
function body(type,value){if(!value)return '';return type==='note'?String(value.aiDraft?.content ?? value.content ?? ''):Object.entries(value).filter(([key])=>key!=='updatedAt').map(([key,val])=>`${key}: ${val??''}`).join('\n');}
function lines(value){return value===''?[]:String(value).split('\n');}
// Bounded Myers search handles distant sparse edits without allocating an N×M
// matrix. The work cap also bounds repetitive/adversarial input; the fallback
// below remains a complete, lossless replacement rather than dropping content.
function sparseDiff(a,b){
 const distance=Math.min(a.length+b.length,512),offset=distance+1;
 const frontier=new Int32Array(distance*2+3),trace=[];let work=0;
 for(let d=0;d<=distance;d++){
  trace.push(frontier.slice());
  for(let k=-d;k<=d;k+=2){
   if(++work>1000000)return null;
   const index=offset+k;let x=k===-d||(k!==d&&frontier[index-1]<frontier[index+1])?frontier[index+1]:frontier[index-1]+1,y=x-k;
   while(x<a.length&&y<b.length&&a[x]===b[y]){x++;y++;if(++work>1000000)return null;}
   frontier[index]=x;
   if(x<a.length||y<b.length)continue;
   const result=[];
   for(let depth=d;depth>=0;depth--){
    const previous=trace[depth],diagonal=x-y,i=offset+diagonal;
    const previousDiagonal=diagonal===-depth||(diagonal!==depth&&previous[i-1]<previous[i+1])?diagonal+1:diagonal-1;
    const previousX=previous[offset+previousDiagonal],previousY=previousX-previousDiagonal;
    while(x>previousX&&y>previousY){result.push({type:'same',text:a[--x]});y--;}
    if(depth>0){if(x===previousX)result.push({type:'add',text:b[--y]});else result.push({type:'remove',text:a[--x]});}
   }
   return result.reverse();
  }
 }
 return null;
}
function diff(before,after){
 const a=lines(before),b=lines(after);let start=0,end=0;
 while(start<a.length&&start<b.length&&a[start]===b[start])start++;
 while(end<a.length-start&&end<b.length-start&&a[a.length-end-1]===b[b.length-end-1])end++;
 const x=a.slice(start,a.length-end),y=b.slice(start,b.length-end),middle=[];
 if(x.length*y.length<=1000000){
  const table=Array.from({length:x.length+1},()=>new Uint32Array(y.length+1));
  for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)table[i][j]=x[i]===y[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
  let i=0,j=0;while(i<x.length||j<y.length){if(i<x.length&&j<y.length&&x[i]===y[j]){middle.push({type:'same',text:x[i++]});j++;}else if(j<y.length&&(i===x.length||table[i][j+1]>table[i+1][j]))middle.push({type:'add',text:y[j++]});else middle.push({type:'remove',text:x[i++]});}
 }else{
  const sparse=sparseDiff(x,y);
  if(sparse)for(const row of sparse)middle.push(row);
  else{for(const text of x)middle.push({type:'remove',text});for(const text of y)middle.push({type:'add',text});}
 }
 let old=0,next=0;return [...a.slice(0,start).map(text=>({type:'same',text})),...middle,...a.slice(a.length-end).map(text=>({type:'same',text}))].map(row=>({...row,old:row.type==='add'?null:++old,next:row.type==='remove'?null:++next}));
}
// Server hunks are authoritative byte-preserving decisions. Display their exact
// line ranges instead of splitting them again with a different diff algorithm.
function hunkRows(hunk,before='',context=0){
 const split=value=>{const rows=String(value).split('\n');if(rows.at(-1)==='')rows.pop();return rows.map(row=>row.endsWith('\r')?row.slice(0,-1):row);};
 const original=split(before),old=hunk.oldStart-1,next=hunk.newStart-1,result=[];
 for(let i=Math.max(0,old-context);i<old;i++)result.push({type:'same',text:original[i],old:i+1,next:next-(old-i)+1});
 split(hunk.before).forEach((text,i)=>result.push({type:'remove',text,old:old+i+1,next:null}));
 split(hunk.after).forEach((text,i)=>result.push({type:'add',text,old:null,next:next+i+1}));
 for(let i=old+hunk.oldCount;i<Math.min(original.length,old+hunk.oldCount+context);i++)result.push({type:'same',text:original[i],old:i+1,next:next+hunk.newCount+(i-old-hunk.oldCount)+1});
 return result;
}
function capture(before,after,results){
 const unique=new Map();for(const result of results||[]){if(!fields[result.type])continue;unique.set(`${result.type}:${result.id}`,result);}
 return [...unique.values()].flatMap(result=>{
  const key=result.type==='note'?'notes':'imports',old=(before[key]||[]).find(x=>x.id===result.id),next=(after[key]||[]).find(x=>x.id===result.id);if(!next)return [];
  const a=record(result.type,old),b=record(result.type,next);if(JSON.stringify(a)===JSON.stringify(b))return [];
  const rows=diff(body(result.type,a),body(result.type,b));
  return [{type:result.type,id:result.id,title:next.title||next.name,folderPath:next.folderPath||'',before:a,after:b,added:rows.filter(x=>x.type==='add').length,removed:rows.filter(x=>x.type==='remove').length,operation:result.operation||(!old?'created':'updated')}];
 });
}
function undo(state,change,now=Date.now()){
 if(change.undoneAt)throw Error('这项修改已经撤销。');
 const key=change.type==='note'?'notes':'imports',item=(state[key]||[]).find(x=>x.id===change.id);
 if(!item||JSON.stringify(record(change.type,item))!==JSON.stringify(change.after))throw Error('文件已有后续修改，不能覆盖。请查看当前文件后手动编辑。');
 if(!change.before){
  if(change.type!=='note')throw Error('原始资料请在资料详情中管理。');
  const links=(state.links||[]).filter(x=>x.sourceId===item.id||x.targetId===item.id);
  state.trash ||= [];state.trash.push({id:`trash_review_${now}_${Math.random().toString(36).slice(2)}`,type:'note',title:item.title,deletedAt:now,data:{notes:[clone(item)],links:clone(links)}});
  state.notes=state.notes.filter(x=>x.id!==item.id);state.links=(state.links||[]).filter(x=>x.sourceId!==item.id&&x.targetId!==item.id);
 }else{
  if(change.type==='note'){item.revisionHistory ||= [];item.revisionHistory.push({title:item.title,content:item.content,savedAt:now,updatedAt:item.updatedAt});}
  for(const field of fields[change.type]){if(Object.hasOwn(change.before,field))item[field]=clone(change.before[field]);else delete item[field];}
  item.updatedAt=now;
 }
 change.undoneAt=now;
}
// Persistence is asynchronous. A failed save must reverse only this undo,
// without replacing edits, restores or deletions performed while it was pending.
async function undoDurably(state,change,saveDurably){
 const key=change.type==='note'?'notes':'imports',item=(state[key]||[]).find(x=>x.id===change.id);
 const before=clone(item),originalIndex=(state[key]||[]).indexOf(item),hadUndo=Object.hasOwn(change,'undoneAt'),previousUndo=change.undoneAt;
 const previousTrash=new Set((state.trash||[]).map(x=>x.id));
 const previousLinks=(state.links||[]).filter(x=>x.sourceId===change.id||x.targetId===change.id);
 const historyLength=Array.isArray(item?.revisionHistory)?item.revisionHistory.length:0;
 undo(state,change);
 const after=clone(item),undoStamp=change.undoneAt;
 const ownTrash=(state.trash||[]).find(x=>!previousTrash.has(x.id)&&x.data?.notes?.some(note=>note.id===change.id));
 const ownRevision=change.before&&change.type==='note'?item.revisionHistory?.[historyLength]:null;
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 try{
  if(await saveDurably()===false)throw Error('撤销没有成功保存。');
  return true;
 }catch(error){
  const current=(state[key]||[]).find(x=>x.id===change.id);
  if(change.before){
   // A replacement object with the same ID may have been restored or loaded
   // independently. Its owner, like an explicit subsequent deletion, wins.
   if(current===item){
    for(const field of new Set([...Object.keys(before||{}),...Object.keys(after||{})])){
     if(field==='revisionHistory')continue;
     if(Object.hasOwn(current,field)!==Object.hasOwn(after,field)||!same(current[field],after[field]))continue;
     if(Object.hasOwn(before,field))current[field]=clone(before[field]);else delete current[field];
    }
    if(ownRevision&&Array.isArray(current.revisionHistory)){
     const index=current.revisionHistory.indexOf(ownRevision);
     if(index>=0&&same(ownRevision,after.revisionHistory?.[historyLength]))current.revisionHistory.splice(index,1);
     if(!current.revisionHistory.length&&!Object.hasOwn(before,'revisionHistory'))delete current.revisionHistory;
    }
   }
  }else if(ownTrash){
   const stillOwned=(state.trash||[]).includes(ownTrash);
   const deletedAgain=(state.trash||[]).some(entry=>entry!==ownTrash&&!previousTrash.has(entry.id)&&entry.data?.notes?.some(note=>note.id===change.id));
   if(!current&&stillOwned&&!deletedAgain){
    state[key].splice(Math.min(originalIndex,state[key].length),0,before);
    state.links ||= [];
    for(const link of previousLinks)if(!state.links.some(entry=>entry.id===link.id))state.links.push(link);
   }
   // Remove the exact tombstone we created, never another deletion of this file.
   state.trash=(state.trash||[]).filter(entry=>entry!==ownTrash);
  }
  if(change.undoneAt===undoStamp){if(hadUndo)change.undoneAt=previousUndo;else delete change.undoneAt;}
  throw error;
 }
}
let hooks;
const renderOwners=new WeakMap();
const draftReview=()=>root.DraftReview||(typeof require==='function'?require('./draft-review.js'):null);
function proposal(run,change,workspace=hooks?.getState?.()||{}){return change.operation==='drafted'?draftReview()?.proposalStatus(workspace,change,{runId:run.id,includeReview:false}):null;}
function changeStatus(run,change,workspace){return change.undoneAt?t('已撤销','Undone'):proposal(run,change,workspace)?.label||'';}
const element=(tag,cls,text)=>{const el=root.document.createElement(tag);el.className=cls||'';if(text!==undefined)el.textContent=text;return el;};
const button=(text,action)=>{const el=element('button','secondary',text);el.type='button';el.onclick=action;return el;};
const active=item=>item&&!item.deleted&&!item.deletedAt&&!item.archived&&!item.archivedAt&&!item.hidden&&!item.hiddenAt&&!item.tombstone&&!item.wikiFileError&&!['deleted','archived','hidden'].includes(item.status);
// Review is a retained snapshot, not a grant to open today's document. A public
// deleted/archived source remains reviewable; private ancestry and ambiguous
// identities do not. Resolve anew on each render/action, never across an await.
function availableRun(state={},kind,id,{privateMode=root.PrivateMode?.isOn?.()===true}={}){
 if(privateMode||!['review','local-review'].includes(kind)||typeof id!=='string'||!id)return null;
 state ||= {};
 const list=value=>Array.isArray(value)?value:[],names=['projects','conversations','agentRuns','notes','imports'],live=new Map(),all=new Map(),retired=new Map();
 const insert=(index,name,item)=>{if(!item||typeof item!=='object'||typeof item.id!=='string'||!item.id)return;const key=JSON.stringify([name,item.id]);if(!index.has(key))index.set(key,[]);index.get(key).push(item);};
 for(const name of names)for(const item of list(state[name])){insert(live,name,item);insert(all,name,item);}
 for(const item of list(state.runs))insert(all,'agentRuns',item);
 for(const bundle of list(state.trash))for(const name of names){for(const item of list(bundle?.data?.[name])){insert(all,name,item);insert(retired,name,item);}if(name==='agentRuns')for(const item of list(bundle?.data?.runs)){insert(all,name,item);insert(retired,name,item);}}
 const lookup=(index,name,id)=>index.get(JSON.stringify([name,id]))||[];
 const owner=(name,id)=>{const found=lookup(live,name,id);return found.length===1&&lookup(all,name,id).length===1&&!lookup(retired,name,id).length&&active(found[0])?found[0]:null;};
 function publicAncestry(...values){
  const queue=values.filter(value=>value&&typeof value==='object'),seen=new Set();
  for(let at=0;at<queue.length;at++){
   const value=queue[at];if(seen.has(value))continue;seen.add(value);
   if(value.private||value.ephemeral||value.incognito)return false;
   for(const [name,ids]of [['projects',[value.projectId]],['conversations',[value.conversationId,value.sourceConversationId]],['agentRuns',[value.runId,value.agentRunId]]])for(const parentId of ids){
    if(!parentId)continue;const parents=lookup(all,name,parentId);if(parents.length>1)return false;queue.push(...parents);
   }
   for(const nested of [value.provenance?.origin,value.aiDraft])if(nested&&typeof nested==='object')queue.push(nested);
  }
  return true;
 }
 const run=owner('agentRuns',id),conversation=run&&owner('conversations',run.conversationId);
 if(!run||!conversation||!publicAncestry(run,conversation))return null;
 for(const projectId of [run.projectId,conversation.projectId])if(projectId&&!owner('projects',projectId))return null;
 const values=list(kind==='review'?run.fileChanges:run.localFileEdits),counts=new Map();
 for(const change of values)if(change&&typeof change.id==='string')counts.set(change.id,(counts.get(change.id)||0)+1);
 const changes=values.filter(change=>{
  if(!change||typeof change.id!=='string'||!change.id||counts.get(change.id)!==1)return false;
  if(kind==='local-review')return (!change.runId||change.runId===run.id)&&typeof change.path==='string'&&!!change.path&&typeof change.candidateId==='string'&&!!change.candidateId&&!!owner('projects',change.projectId)&&publicAncestry(change);
  const name=({note:'notes',import:'imports'})[change.type];if(!name)return false;
  const records=lookup(all,name,change.id);if(records.length>1)return false;
  return publicAncestry(change,change.before,change.after,...records);
 });
 // LocalFileEdits still owns its complete run list. Reject an unsafe mixed
 // local run instead of returning a filtered list its controller would ignore.
 return changes.length&&(kind!=='local-review'||changes.length===values.length)?{run,changes}:null;
}
function currentCardTarget(run,change,workspace,eligible=availableRun(workspace,'review',run.id)){
 if(!workspace||!hooks?.openFile||root.PrivateMode?.isOn?.()||!['note','import'].includes(change?.type)||change.undoneAt)return null;
 if(eligible?.run!==run||!eligible.changes.includes(change))return null;
 const runs=(workspace.agentRuns||[]).filter(item=>item.id===run.id);
 if(runs.length!==1||runs[0]!==run||!active(run)||!run.fileChanges.includes(change)||run.fileChanges.filter(item=>item.id===change.id).length!==1)return null;
 if(run.conversationId){const conversations=(workspace.conversations||[]).filter(item=>item.id===run.conversationId);if(conversations.length!==1||!active(conversations[0]))return null;}
 const review=proposal(run,change,workspace);
 if(change.operation==='drafted'&&review?.status!=='adopted')return null;
 if(run.approvalReceipt?.savePending||run.executionReceipt&&(run.executionReceipt.version!==1||run.executionReceipt.phase!=='committed')||run.status!=='completed'&&review?.status!=='adopted')return null;
 const source={type:change.type,id:change.id,runId:run.id,...(run.conversationId?{conversationId:run.conversationId}:{})};
 const access=root.CitationEvidence?.access(workspace,source);
 if(!access?.available||access.record?.aiDraft)return null;
 return {source,record:access.record};
}
function card(run,workspace){
 if(!run?.fileChanges?.length)return null;
 workspace ||= hooks?.getState?.()||{};
 const eligible=availableRun(workspace,'review',run.id);if(eligible?.run!==run)return null;
 const section=element('section','file-change-card file-change-results');
 const onReview=(id,anchor)=>{const latest=availableRun(hooks?.getState?.(),'review',run.id);if(latest?.run!==run||id&&!latest.changes.some(change=>change.id===id))return false;return hooks.open(run.id,id,...(anchor?[{anchor}]:[]));};
 const onSelect=(id,anchor)=>{
  const change=run.fileChanges.find(item=>item.id===id),target=currentCardTarget(run,change,hooks?.getState?.());
  if(!target)return onReview(id,anchor);
  // Carry the originating run into the existing reader, and revalidate after
  // its asynchronous Save/Discard decision rather than trusting this card.
  return hooks.openFile(change.type,change.id,{sourceGuard:target.source,anchor,canOpen:()=>{const current=currentCardTarget(run,change,hooks?.getState?.());return !!current&&current.record===target.record&&JSON.stringify(current.source)===JSON.stringify(target.source);}});
 };
 const changes=eligible.changes.map(change=>{const review=proposal(run,change,workspace),canOpen=!!currentCardTarget(run,change,workspace,eligible),waitingSave=run.status==='awaiting-save'||run.executionReceipt?.phase==='applied'||run.approvalReceipt?.savePending,status=change.undoneAt?t('已撤销','Undone'):review?.label||(canOpen?t('已保存','Saved'):waitingSave?t('等待保存','Awaiting save'):t('历史变更','Historical change'));return {id:change.id,path:`${change.folderPath?change.folderPath+'/':''}${change.title}${change.type==='note'&&!/\.md$/i.test(change.title)?'.md':''}`,added:change.added,removed:change.removed,undone:!!change.undoneAt,draft:!change.undoneAt&&review?.status==='pending',reviewStatus:review?.status,label:status,status,canOpen,openLabel:canOpen?(change.type==='note'?t('打开文档','Open document'):t('打开资料','Open source')):review?.status==='pending'?t('审阅草稿','Review draft'):t('查看修改','View changes')};});
 if(root.HalaskaUI?.componentNames?.includes('ReviewChangeCard')){
  root.HalaskaUI.mount(section,'ReviewChangeCard',{changes,commandCount:(run.commands||[]).filter(command=>command.startedAt).length,onOpen:()=>onReview(),onSelect,onReview});return section;
 }
 const header=element('header');header.append(element('strong','',t(`本轮文件 · ${changes.length} 项`,`Files this turn · ${changes.length}`)));section.append(header);
 const list=element('div','file-change-list');
 changes.forEach(change=>{const row=element('div','file-change-row'),entry=button('',event=>onSelect(change.id,event?.currentTarget));entry.className='file-result-entry';entry.append(element('span','file-change-name',change.path),element('small','file-result-status',change.status),element('span','file-result-open',change.openLabel));row.append(entry);if(change.canOpen)row.append(button(t('审阅修改','Review changes'),event=>onReview(change.id,event?.currentTarget)));list.append(row);});section.append(list);
 // 回滚覆盖面要在撤销之前说清：终端命令的效果不会随文件回滚一起撤销（口径与失败提示一致）。
 const executed=(run.commands||[]).filter(command=>command.startedAt);
 if(executed.length)section.append(element('p','file-change-caution',`本轮还执行过 ${executed.length} 条终端命令：其效果不会随撤销回滚，请先在命令记录中核对。`));
 return section;
}
function render(container,run,selectedId,bookmark){
 const owner={};renderOwners.set(container,owner);let epoch=0,acting=false,workbench;
 const eligible=availableRun(hooks?.getState?.(),'review',run.id);
 const permitted=change=>{const latest=availableRun(hooks?.getState?.(),'review',run.id);return latest?.run===run&&latest.changes.includes(change);};
 const files=(eligible?.run===run?eligible.changes:[]).map(change=>({id:change.id,path:`${change.folderPath?change.folderPath+'/':''}${change.title}${change.type==='note'&&!/\.md$/i.test(change.title)?'.md':''}`,added:change.added,removed:change.removed,status:changeStatus(run,change),change}));
 function select(file,viewer,state){
  const ticket=++epoch,change=file.change,current=()=>renderOwners.get(container)===owner&&ticket===epoch&&viewer.isConnected&&permitted(change);
  if(!current()){root.ReviewWorkbench.dispose?.(viewer);viewer.replaceChildren(element('p','review-empty',t('这份修改已不可用。','This change is no longer available.')));return;}
  const status=proposal(run,change),pending=!change.undoneAt&&status?.status==='pending';
  const error=element('p','file-review-error');error.hidden=true;error.setAttribute('role','alert');
  const actions=[];
  async function decide(action){
   if(acting||!current())return false;acting=true;error.hidden=true;actions.forEach(button=>{button.disabled=true;});
   try{
    if(proposal(run,change)?.status!=='pending')throw Error(t('这份草稿已变化，请重新查看当前文件。','This proposal changed. Open the current file to review it.'));
    const result=await hooks.reviewDraft(run,change,action);if(result===false)return false;
    if(renderOwners.get(container)!==owner)return true;
    for(const entry of files){entry.status=changeStatus(run,entry.change);workbench?.refresh(entry);}
    if(current()){select(file,viewer,state);viewer.querySelector('.review-file-actions button')?.focus({preventScroll:true});}
    return true;
   }catch(failure){if(current()){error.textContent=failure.message||String(failure);error.hidden=false;error.scrollIntoView?.({block:'nearest'});}return false;}
   finally{acting=false;if(current())actions.forEach(button=>{button.disabled=false;});}
  }
  if(pending&&hooks.reviewDraft)for(const [label,action]of [[t('采纳并保存','Adopt and save'),'adopt'],[t('放弃草稿','Discard draft'),'discard']]){const control=button(label,()=>decide(action));control.dataset.draftReviewAction=action;control.disabled=!!status.saving;actions.push(control);}
  const openCurrent=event=>current()?hooks.openFile(change.type,change.id,{anchor:event?.currentTarget,canOpen:()=>current()}):false;
  if(pending){const edit=button(t('打开编辑器','Open editor'),event=>current()?(hooks.editDraft?hooks.editDraft(run,change,{anchor:event?.currentTarget,canOpen:()=>current()}):openCurrent(event)):false);edit.dataset.draftReviewAction='edit';actions.push(edit);}
  actions.push(button(t('打开当前文件','Open current file'),openCurrent));
  if(!change.undoneAt&&change.operation!=='drafted'&&(change.before||change.type==='note'))actions.push(button(t('撤销此项','Undo this edit'),async()=>{if(!current()||!root.confirm(t('撤销这项修改？只有文件仍与本轮修改后版本一致时才会执行。新建笔记会进入回收站。','Undo this edit? Only unchanged files can be restored. New notes go to Trash.')))return;try{if(!current())return false;await hooks.undo(run,change);if(current())render(container,run,change.id);}catch(failure){hooks.toast(failure.message);}}));
  const notice=change.undoneAt?t('已撤销 · 以下保留本轮历史变更','Undone · Historical changes are preserved'):status?`${status.label} · ${pending?t('采纳后替换正文；本轮提案保留用于对比','Adopting replaces the body; this proposal remains available for comparison'):t('以下保留历史提案，请打开当前文件查看最新正文','Historical proposal preserved; open the current file for its latest body')}`:t('本轮变更快照 · 当前文件可能已有后续修改','Snapshot from this turn · The current file may have newer edits');
  const doc=root.ReviewWorkbench.document(viewer,{path:file.path,before:body(change.type,change.before),after:body(change.type,change.after),preview:change.type==='note',markdown:hooks.markdown,notice,actions},state);doc?.footer?.append(error);
 }
 workbench=root.ReviewWorkbench.create(container,{key:'library:'+run.id,files,selectedId,onSelect:select,bookmark});return workbench;
}
return {capture,diff,hunkRows,undo,undoDurably,record,availableRun,init(value){hooks=value;},card,render};
});
