(function(root,factory){
  const common=typeof module==='object'&&module.exports;
  const api=factory(root,common?require('./citation-evidence.js'):null,common?require('./task-deliverable.js'):null);
  if(common)module.exports=api;else root.ProjectBoard=api;
})(globalThis,(root,evidence,deliverable)=>{
  'use strict';
  const statuses=['todo','in_progress','blocked','done'],list=value=>Array.isArray(value)?value:[];
  const active=value=>!!value?.id&&!value.archived&&!value.archivedAt&&!value.deleted&&!value.deletedAt&&!value.wikiFileError&&!['archived','deleted'].includes(value.status);
  const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
  function accessFor(state){return (evidence||root.CitationEvidence)?.createAccessContext?.(state);}
  function readable(access,type,item){
    if(!active(item)||!access)return false;
    const ref=type==='project'?{type:'local',projectId:item.id,candidateId:item.localFolder?.id}:{type,id:item.id};
    return access.access(ref).kind==='available'&&!access.isAmbiguous(ref);
  }
  function scope(state,projectId){
    const access=accessFor(state),projects=list(state.projects).filter(item=>item.id===projectId);
    const project=projects.length===1&&readable(access,'project',projects[0])?projects[0]:null;
    const tasks=project?list(state.tasks).filter(item=>item.projectId===projectId&&readable(access,'task',item)):[];
    return {access,project,tasks};
  }
  function model(state={},projectId,current=scope(state,projectId)){
    const tasks=current.tasks.map(task=>({id:task.id,title:String(task.title||t('未命名任务','Untitled task')),status:statuses.includes(task.status)?task.status:'todo',dueAt:task.dueAt||null,priority:task.priority||'medium',
      prerequisitesIncomplete:list(task.dependsOn).some(id=>!current.tasks.some(other=>other.id===id&&other.workspace===task.workspace&&other.status==='done'))}));
    return {available:!!current.project,projectId,tasks,counts:Object.fromEntries(statuses.map(status=>[status,tasks.filter(task=>task.status===status).length]))};
  }
  function move(state,id,projectId,status,version,now=Date.now()){
    const current=scope(state,projectId),task=current.tasks.find(item=>item.id===id);
    if(!task)throw Error(t('任务或所属项目已变化，请刷新。','The task or its project is no longer available.'));
    if(JSON.stringify(task)!==version)throw Error(t('任务已更新，请按最新状态重试。','The task changed. Retry from its latest state.'));
    if(!statuses.includes(status))throw Error(t('无效任务状态。','Invalid task status.'));
    const before={...task};
    if(task.status===status)return {task,before,changed:false};
    if(status==='done'){
      const validator=deliverable||root.TaskDeliverable;
      if(!validator?.validate)throw Error(t('任务产出校验当前不可用，请稍后重试。','Task output validation is unavailable. Please retry.'));
      const verdict=validator.validate(task,{projectId,notes:list(state.notes).filter(item=>readable(current.access,'note',item)),tasks:list(state.tasks).filter(item=>readable(current.access,'task',item))});
      if(!verdict.ok)throw Error(validator.message?.(task,verdict)||verdict.reason||t('任务产出尚未满足。','The required task output is not ready.'));
    }
    task.status=status;task.completedAt=status==='done'?(task.completedAt||now):null;task.updatedAt=now;
    return {task,before,changed:true,after:{status:task.status,completedAt:task.completedAt,updatedAt:task.updatedAt}};
  }
  // Restore only fields owned by this status transition. A concurrent title,
  // description or newer status edit must never be overwritten by rollback.
  function rollback(owner,result){
    const {task,before,after}=result;
    if(!list(owner.tasks).includes(task)||task.status!==after.status||task.completedAt!==after.completedAt)return;
    for(const key of ['status','completedAt']){if(Object.hasOwn(before,key))task[key]=before[key];else delete task[key];}
    if(task.updatedAt===after.updatedAt){if(Object.hasOwn(before,'updatedAt'))task.updatedAt=before.updatedAt;else delete task.updatedAt;}
  }
  let hooks={},contexts=new WeakMap(),modes=new WeakMap(),pending=new WeakMap(),drag=null,pendingCount=0;
  const emptyState={};
  const stateNow=()=>hooks.getState?.()||emptyState;
  const documentNow=()=>hooks.document||root.document;
  const projectNow=()=>hooks.getProjectId?.()??stateNow().currentProjectId;
  function modeFor(owner,id){let byProject=modes.get(owner);if(!byProject)modes.set(owner,byProject=new Map());return {get:()=>byProject.get(id)||'list',set:value=>byProject.set(id,value)};}
  function current(context){return context&&context.hooks===hooks&&contexts.get(context.host)===context&&context.host.isConnected!==false&&stateNow()===context.owner&&(projectNow()===undefined||projectNow()===context.projectId);}
  function render(projectId){
    const doc=documentNow(),host=doc?.getElementById('projectTasks');if(!host)return false;
    // Root transfers the list host once; the retired DOM board owns no island.
    doc.getElementById('projectBoardToolbar')?.remove();
    const legacyBoard=doc.getElementById('projectTaskBoard');if(legacyBoard&&!host.contains?.(legacyBoard))legacyBoard.remove();
    host.hidden=false;host.classList?.remove('entity-list','empty-list');
    const owner=stateNow();let context=contexts.get(host);
    if(!context||context.owner!==owner||context.projectId!==projectId||context.hooks!==hooks){
      context?.island?.unmount();if(!context)host.replaceChildren();drag=null;context={host,owner,projectId,hooks,island:null};contexts.set(host,context);
    }
    const visible=scope(owner,projectId),data=model(owner,projectId,visible),preference=modeFor(owner,projectId),snapshot=new Map();
    const readableTasks=visible.tasks;
    for(const task of readableTasks)snapshot.set(task.id,{task,version:JSON.stringify(task)});
    const valid=()=>current(context)&&!!scope(owner,projectId).project;
    async function change(id,status,version=snapshot.get(id)?.version){
      if(!valid())return false;
      const selected=snapshot.get(id);if(!selected||pending.has(selected.task))return false;
      let result,acknowledged=false;const token={};
      try{
        result=move(owner,id,projectId,status,version,hooks.now?.()??Date.now());
        if(!result.changed)return true;
        pending.set(result.task,token);pendingCount++;render(projectId);
        if(typeof context.hooks.persist!=='function'||await context.hooks.persist()!==true)throw Error(t('任务状态尚未保存，请重试。','Task status was not saved. Please retry.'));
        acknowledged=true;
        if(valid()&&list(owner.tasks).includes(result.task)&&result.task.status===status)context.hooks.toast?.(t('任务状态已保存','Task status saved'));
        return true;
      }catch(error){
        if(result?.changed&&!acknowledged)rollback(owner,result);
        if(current(context))context.hooks.toast?.(error.message||String(error));
        return false;
      }finally{
        if(result?.task&&pending.get(result.task)===token){pending.delete(result.task);pendingCount--;}
        if(current(context)){render(projectId);if(acknowledged)context.hooks.renderAll?.();}
      }
    }
    const props={...data,mode:preference.get(),busyIds:readableTasks.filter(task=>pending.has(task)).map(task=>task.id),
      onMode:value=>{if(!valid()||!['list','board'].includes(value))return false;preference.set(value);render(projectId);return true;},
      onOpen:(id,anchor)=>{if(!valid()||!scope(owner,projectId).tasks.some(task=>task.id===id))return false;const guard=()=>valid()&&scope(owner,projectId).tasks.some(task=>task.id===id);return context.hooks.open?.(id,{guard,anchor,origin:{view:'project',projectId,section:'tasks'}});},
      onCreate:typeof hooks.onCreate==='function'?()=>valid()&&context.hooks.onCreate(projectId,valid):undefined,
      onStatus:change,
      onDragStart:id=>{const selected=snapshot.get(id);if(!valid()||!selected||pending.has(selected.task)||JSON.stringify(selected.task)!==selected.version)return false;drag={context,id,version:selected.version};return true;},
      onDragEnd:()=>{if(drag?.context===context)drag=null;},
      canDrop:()=>valid()&&drag?.context===context,
      onDrop:status=>{if(!valid()||drag?.context!==context)return false;const selected=drag;drag=null;return change(selected.id,status,selected.version);}
    };
    if(context.island)context.island.update(props);else context.island=(hooks.mount||((host,name,props)=>root.HalaskaUI.mount(host,name,props)))(host,'ProjectBoard',props);
    return data;
  }
  return {move,model,render,isBusy:()=>pendingCount>0,init:next=>{hooks=next||{};drag=null;}};
});
