/* Selection rewrites are proposals. Only the existing note editor saves documents. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.CanvasEdit=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const MAX_SELECTION=24000,MAX_OUTPUT=64000;
 const string=value=>String(value??'');
 const ENGLISH={
  '选区位置无效，请重新选择。':'The selection position is invalid. Please select the text again.',
  '选区位置已变化，请重新选择。':'The selection position changed. Please select the text again.',
  '请等待当前文档保存完成，再选择文字。':'Wait for the document to finish saving, then select text.',
  '笔记已有外部更新，请先保留草稿并合并最新版本。':'The note changed elsewhere. Keep your draft and merge the latest version first.',
  '请先选择完整文字，再使用 AI 改写。':'Select complete text before using AI rewrite.',
  '一次最多改写 24,000 个字符，请缩小选区。':'Select no more than 24,000 characters for one rewrite.',
  '当前文档已切换或不可用，改写结果仍保留在这里。':'The document changed or is unavailable. Your rewrite remains here.',
  '文档正在保存，请稍候再试。':'The document is saving. Please try again when it finishes.',
  '文档或草稿已有更新，未覆盖任何文字。请复制改写结果，再重新选择并合并。':'The document or draft changed. Nothing was overwritten. Copy this result, then select again and merge.',
  '请填写改写要求。':'Enter your rewrite instructions.',
  'AI 改写尚未连接，请检查模型配置。':'AI rewrite is not connected. Check the model configuration.',
  '已停止；未完成的内容不能应用。':'Stopped. An incomplete response cannot be applied.',
  '改写结果过长，已停止。请缩小选区或简化要求。':'The rewrite is too long and was stopped. Select less text or simplify your instructions.',
  '模型没有返回完整改写文本，请重试。':'The model did not return a complete rewrite. Please try again.',
  '改写结果过长，请缩小选区。':'The rewrite is too long. Select less text.',
  '改写后文档过长，请缩小选区。':'The rewritten document would be too long. Select less text.',
  '编辑器状态已变化，未应用改写。':'The editor changed. The rewrite was not applied.',
  '编辑器状态已变化，未撤销后续修改。':'The editor changed. Later edits were not undone.',
  'AI 改写界面尚未载入，请重新打开应用。':'AI rewrite has not loaded. Please reopen the app.',
  '改写结果已复制。':'Rewrite copied.',
  '无法访问剪贴板，请选中结果复制。':'Clipboard access failed. Select the result and copy it manually.',
  '请先在正文中选择要改写的文字。':'Select the text to rewrite in the document first.',
  '请在源码中选择要改写的文字，再点击 AI 改写。':'Select text in the Markdown source, then choose AI rewrite.',
  '当前富文本选区含格式或跨段落。已定位对应源码，请确认或重新选择准确范围，再点击 AI 改写。':'This rich-text selection contains formatting or spans paragraphs. Its Markdown block is selected. Confirm or refine the range, then choose AI rewrite.',
  '已更新未保存草稿；点击「保存」后才写入笔记。':'The unsaved draft was updated. Use Save to store it in the note.',
 };
 const message=value=>/^en(?:-|$)/i.test(root.document?.documentElement?.lang||root.WorkstationI18n?.getLanguage?.()||'')?(ENGLISH[value]||value):value;
 const boundary=(value,index)=>!(index>0&&index<value.length&&/[\uD800-\uDBFF]/.test(value[index-1])&&/[\uDC00-\uDFFF]/.test(value[index]));
 const display=value=>string(value).replace(/\r\n?/g,'\n');
 function sourceOffset(value,offset){
  value=string(value);if(!Number.isInteger(offset)||offset<0)throw Error('选区位置无效，请重新选择。');
  let shown=0,index=0;while(index<value.length&&shown<offset){index+=value[index]==='\r'&&value[index+1]==='\n'?2:1;shown++;}
  if(shown!==offset)throw Error('选区位置已变化，请重新选择。');return index;
 }
 function displayRange(value,start,end){return {start:sourceOffset(value,start),end:sourceOffset(value,end)};}
 function toDisplayOffset(value,offset){return display(string(value).slice(0,offset)).length;}
 function textareaEdit(before,afterDisplay){
  before=string(before);afterDisplay=display(afterDisplay);const previous=display(before);if(previous===afterDisplay)return before;
  let start=0;while(start<previous.length&&start<afterDisplay.length&&previous[start]===afterDisplay[start])start++;
  let a=previous.length,b=afterDisplay.length;while(a>start&&b>start&&previous[a-1]===afterDisplay[b-1]){a--;b--;}
  const newline=before.includes('\r\n')?'\r\n':before.includes('\r')&&!before.includes('\n')?'\r':'\n';
  return before.slice(0,sourceOffset(before,start))+afterDisplay.slice(start,b).replace(/\n/g,newline)+before.slice(sourceOffset(before,a));
 }
 function selection(document,start,end){
  const content=string(document?.content);
  if(!document?.id||document.available===false||document.saving)throw Error('请等待当前文档保存完成，再选择文字。');
  if(document.baseVersion!==document.version)throw Error('笔记已有外部更新，请先保留草稿并合并最新版本。');
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>content.length||!boundary(content,start)||!boundary(content,end))throw Error('请先选择完整文字，再使用 AI 改写。');
  if(end-start>MAX_SELECTION)throw Error('一次最多改写 24,000 个字符，请缩小选区。');
  return {id:document.id,title:string(document.title),content,version:document.version,baseVersion:document.baseVersion,start,end,text:content.slice(start,end)};
 }
 function changedParts(before,after){
  before=string(before);after=string(after);let start=0,end=0;
  while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  while(!boundary(before,start)||!boundary(after,start))start--;
  while(end<before.length-start&&end<after.length-start&&before[before.length-end-1]===after[after.length-end-1])end++;
  while(end>0&&(!boundary(before,before.length-end)||!boundary(after,after.length-end)))end--;
  return {prefix:before.slice(0,start),removed:before.slice(start,before.length-end),added:after.slice(start,after.length-end),suffix:end?before.slice(-end):''};
 }
 function createSession(hooks){
  let value=null,aborter=null,epoch=0,disposed=false;
  const publish=()=>hooks.onChange?.(snapshot());
  // Streaming snapshots avoid scanning the growing response for a diff on
  // every token. Compute the actual replacement diff only when it settles.
  const snapshot=()=>value?{...value,error:message(value.error),selection:{...value.selection},diff:value.status==='generating'?{prefix:'',removed:value.selection.text,added:value.output,suffix:''}:changedParts(value.selection.text,value.output)}:null;
  const read=()=>hooks.read?.();
  function guard(expectedContent,expectedVersion){
   const current=read();
   if(!current||current.available===false||current.id!==value?.selection.id)throw Error('当前文档已切换或不可用，改写结果仍保留在这里。');
   if(current.saving)throw Error('文档正在保存，请稍候再试。');
   if(current.content!==expectedContent||current.version!==expectedVersion||current.baseVersion!==current.version)throw Error('文档或草稿已有更新，未覆盖任何文字。请复制改写结果，再重新选择并合并。');
   return current;
  }
  function open(range){
   if(disposed)return false;stop(false);const picked=selection(read(),range.start,range.end);
   value={selection:picked,instruction:'',output:'',status:'editing',error:'',appliedContent:null,appliedVersion:null};publish();return true;
  }
  function instruction(next){if(!value||value.status==='generating')return;value.instruction=string(next).slice(0,4000);publish();}
  function stop(announce=true){epoch++;aborter?.abort();aborter=null;if(value?.status==='generating'){value.status='stopped';value.error='已停止；未完成的内容不能应用。';if(announce)publish();}}
  async function generate(){
   if(!value||disposed||value.status==='generating')return false;
   const item=value,instruction=string(item.instruction).trim();
   try{guard(item.selection.content,item.selection.version);if(!instruction)throw Error('请填写改写要求。');if(typeof hooks.generate!=='function')throw Error('AI 改写尚未连接，请检查模型配置。');}
   catch(error){item.error=error.message;publish();return false;}
   const generation=++epoch;aborter=new AbortController();const signal=aborter.signal;
   item.status='generating';item.error='';item.output='';publish();
   const selected=item.selection;
   try{
    const result=await hooks.generate({noteId:selected.id,title:selected.title,instruction,selection:{start:selected.start,end:selected.end,text:selected.text},context:{before:selected.content.slice(Math.max(0,selected.start-1600),selected.start),after:selected.content.slice(selected.end,selected.end+1600)},signal,onDelta:delta=>{
     if(disposed||generation!==epoch||signal.aborted||value!==item)return;
     const addition=string(delta);if(item.output.length+addition.length>MAX_OUTPUT){item.output=(item.output+addition).slice(0,MAX_OUTPUT);stop(false);item.status='error';item.error='改写结果过长，已停止。请缩小选区或简化要求。';publish();return;}item.output+=addition;publish();
    }});
    if(disposed||generation!==epoch||signal.aborted||value!==item)return false;
    const output=typeof result==='string'?result:result?.text;
    if(typeof output!=='string'||!output.trim())throw Error('模型没有返回完整改写文本，请重试。');
    if(output.length>MAX_OUTPUT)throw Error('改写结果过长，请缩小选区。');
    item.output=output;item.status='ready';aborter=null;
    try{guard(selected.content,selected.version);}catch(error){item.error=error.message;}
    publish();return true;
   }catch(error){if(disposed||generation!==epoch||value!==item)return false;aborter=null;item.status=signal.aborted?'stopped':'error';item.error=signal.aborted?'已停止；未完成的内容不能应用。':string(error?.message||error);publish();return false;}
  }
  function apply(){
   if(!value||value.status!=='ready')return false;
   try{const picked=value.selection;guard(picked.content,picked.version);
    const next=picked.content.slice(0,picked.start)+value.output+picked.content.slice(picked.end);
    if(next.length>1000000)throw Error('改写后文档过长，请缩小选区。');
    if(hooks.writeDraft(next,{start:picked.start,end:picked.start+value.output.length,expected:picked.content})===false)throw Error('编辑器状态已变化，未应用改写。');
    value.appliedContent=next;value.appliedVersion=picked.version;value.status='applied';value.error='';publish();return true;
   }catch(error){value.error=error.message;publish();return false;}
  }
  function saved(){
   if(value?.status!=='applied')return;const current=read();
   if(current?.id===value.selection.id&&current.content===value.appliedContent&&current.baseVersion===current.version){value.appliedVersion=current.version;value.saved=true;publish();}
  }
  function undo(){
   if(value?.status!=='applied')return false;
   try{guard(value.appliedContent,value.appliedVersion);const picked=value.selection;
    if(hooks.writeDraft(picked.content,{start:picked.start,end:picked.end,expected:value.appliedContent})===false)throw Error('编辑器状态已变化，未撤销后续修改。');
    value.status='undone';value.error='';publish();return true;
   }catch(error){value.error=error.message;publish();return false;}
  }
  function close(){stop(false);value=null;publish();}
  return {open,instruction,generate,stop,apply,undo,saved,close,snapshot,dispose(){stop(false);disposed=true;value=null;}};
 }
 function mount(container,hooks,environment=root){
  const doc=container.ownerDocument;let island=null,closed=true,opener=null,frame=null,streamTimer=null,streamValue=null,renderedStatus=null;
  const clearStream=()=>{if(streamTimer!==null)(environment.clearTimeout||clearTimeout)(streamTimer);streamTimer=null;streamValue=null;};
  const render=value=>{
   if(closed||!value)return;renderedStatus=value.status;const props={...value,onInstruction:session.instruction,onGenerate:session.generate,onStop:()=>session.stop(),onApply:session.apply,onUndo:session.undo,onClose:close,onCopy:async()=>{try{await environment.navigator.clipboard.writeText(value.output);hooks.report?.(message('改写结果已复制。'));}catch{hooks.report?.(message('无法访问剪贴板，请选中结果复制。'));}}};
   if(island)island.update(props);else island=environment.HalaskaUI.mount(container,'CanvasEditSurface',props);
  };
  const session=createSession({...hooks,onChange:value=>{
   if(value?.status==='generating'&&renderedStatus==='generating'){
    streamValue=value;if(streamTimer===null)streamTimer=(environment.setTimeout||setTimeout)(()=>{const latest=streamValue;streamTimer=null;streamValue=null;render(latest);},60);
   }else{clearStream();render(value);}
  }});
  function close(){clearStream();session.close();closed=true;container.hidden=true;island?.unmount();island=null;opener?.focus?.({preventScroll:true});}
  function open(range){
   if(!environment.HalaskaUI?.componentNames?.includes('CanvasEditSurface'))throw Error('AI 改写界面尚未载入，请重新打开应用。');
   opener=doc.activeElement;closed=false;container.hidden=false;
   try{session.open(range);}catch(error){close();throw error;}
   frame=(environment.requestAnimationFrame||environment.setTimeout)(()=>{frame=null;container.querySelector('textarea')?.focus({preventScroll:true});container.scrollIntoView?.({block:'nearest',behavior:'auto'});});return true;
  }
  container.classList.add('canvas-edit-host');container.hidden=true;
  const keydown=event=>{if(event.isComposing||event.keyCode===229)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
  container.addEventListener('keydown',keydown);
  return {open,close,saved:session.saved,stop:()=>session.stop(),snapshot:session.snapshot,isOpen:()=>!closed,dispose(){clearStream();session.dispose();closed=true;container.removeEventListener('keydown',keydown);if(frame!==null)(environment.cancelAnimationFrame||environment.clearTimeout)(frame);island?.unmount();island=null;container.hidden=true;}};
 }
 return {MAX_SELECTION,MAX_OUTPUT,boundary,display,displayRange,toDisplayOffset,textareaEdit,selection,changedParts,message,createSession,mount};
});
