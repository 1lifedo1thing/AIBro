(function(root){
 const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text)x.textContent=text;if(cls)x.className=cls;return x;};
 const contexts=new WeakMap(),pendingNotes=new WeakSet();
 const active=value=>!!value&&!value.archived&&!value.archivedAt&&!value.deleted&&!value.deletedAt&&!value.wikiFileError&&!['archived','deleted'].includes(value.status);
 function publicRecord(kind,record,owner){
  if(!active(record)||record.private||record.ephemeral||record.incognito)return false;
  const access=root.CitationEvidence?.createAccessContext?.(owner);
  const ref=kind==='local'?{type:'local',projectId:record.id,candidateId:record.localFolder?.id}:{type:kind,id:record.id};
  return !!access&&access.access(ref).kind==='available'&&!access.isAmbiguous(ref);
 }
 function render(project){
  const overview=document.querySelector('#project [data-project-panel="overview"]');
  if(!overview||!root.HalaskaUI)return false;
  let box=document.querySelector('#projectMemoryControls');
  if(!box){box=el('div',null,'context-source-links');box.id='projectMemoryControls';}
  // The overview owns this host. It must not depend on a removed source banner.
  if(box.parentElement!==overview)overview.prepend(box);
  let context=contexts.get(box);
  if(!context||context.owner!==state||context.project!==project){context={owner:state,project,box,busy:false};contexts.set(box,context);}
  const current=()=>contexts.get(box)===context&&box.isConnected&&document.querySelector('#projectMemoryControls')===box&&state===context.owner&&state.currentProjectId===project.id&&state.projects.filter(item=>item.id===project.id).length===1&&state.projects.includes(project)&&publicRecord('local',project,state);
  const intentCurrent=()=>current()&&document.body.dataset.view==='project'&&state.ui?.projectTab==='overview';
  const english=()=>root.WorkstationI18n?.getLanguage?.()==='en';
  function draw(){
   if(!current())return;
   root.HalaskaUI.mount(box,'ProjectMemoryActions',{busy:context.busy,onOpen:open,onAutomation:root.ProjectAutomation?()=>{if(intentCurrent()&&!context.busy)root.ProjectAutomation.open(project);}:undefined});
  }
  async function open(kind,anchor){
   if(!['long','plan','daily'].includes(kind)||!intentCurrent()||context.busy||anchor&&!box.contains(anchor))return false;
   const readable=note=>note?.projectId===project.id&&note.projectMemoryType===kind&&state.notes.includes(note)&&publicRecord('note',note,state);
   try{
    let note=state.notes.filter(readable).sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))[0];
    if(!note&&kind!=='daily'){
     const canonical=state.notes.find(item=>item.id===root.ProjectMemory.id(project.id,kind));
     // A hidden, unavailable or ambiguous canonical entry cannot be recreated.
     if(canonical&&!readable(canonical))return false;
     const before=new Set(state.notes);
     note=kind==='plan'?root.ProjectMemory.refreshPlan(state,project.id):root.ProjectMemory.ensure(state,project,'long');
     if(note&&!before.has(note))pendingNotes.add(note);
    }
    if(!note){toast(english()?'No project run recorded yet.':'完成项目对话后会记录进展日记。');return false;}
    const canOpen=()=>intentCurrent()&&readable(note);
    if(!canOpen())return false;
    if(pendingNotes.has(note)){
     context.busy=true;draw();
     if(await saveDocumentDurably()===false)throw Error(english()?'Project record has not been saved. Retry to continue.':'项目记录尚未保存，请重试。');
     pendingNotes.delete(note);
     if(!canOpen())return false;
    }
    return await openPreview('note',note.id,undefined,undefined,canOpen,{anchor});
   }catch(error){if(intentCurrent())toast(error.message);return false;}
   finally{context.busy=false;if(current())draw();}
  }
  draw();return true;
 }
 function relations(box,note){
  if(!note.projectMemoryType)return;
  for(const id of note.memoryRunIds||[]){const run=state.agentRuns.find(r=>r.id===id);const chat=state.conversations.find(c=>c.id===run?.conversationId&&!c.deletedAt&&!c.archived&&c.projectId===note.projectId);if(!chat)continue;const b=el('button','执行来源 · '+chat.title,'source-link');b.onclick=e=>{e.stopPropagation();openConversation(chat.id);};box.append(b);}
  if(note.projectMemoryType==='plan')for(const task of state.tasks.filter(t=>t.projectId===note.projectId&&!t.deletedAt&&!t.archived)){const b=el('button',task.title,'source-link');b.onclick=e=>{e.stopPropagation();openTask(task.id);};box.append(b);}
 }
 root.ProjectMemoryUI={render,relations};
})(globalThis);
