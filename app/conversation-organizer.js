/* Read-only recommendations and explicit durable organization commands.
 * This controller owns its dialog island, never conversation transcripts. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ConversationOrganizer=api;})(globalThis,root=>{
 'use strict';
 let hooks={},shell=null,busy=false;
 const MIME='application/x-aibro-conversation';
 const t=(zh,en)=>/^en(?:-|$)/i.test(root.document?.documentElement.lang||'')?en:zh;
 const core=()=>root.ConversationOrganization;
 const current=()=>hooks.getState?.()||{};
 const visible=chat=>core().eligible(chat)&&(!root.PrivateMode?.shows||root.PrivateMode.shows(chat));
 const failed=()=>t('本机保存未完成，请重试。','Local saving did not finish. Please try again.');
 const syncSidebarBusy=()=>root.document?.querySelectorAll('[data-organizer-pin]').forEach(button=>{button.disabled=busy;});
 function model(){
  const state=current(),conversations=core().sort((state.conversations||[]).filter(visible));
  return {
   conversations:conversations.map(chat=>({id:chat.id,title:chat.title||t('新对话','New conversation'),folderId:chat.folderId||null,pinned:core().isPinned(chat),projectId:chat.projectId||null,
    projectName:(state.projects||[]).find(project=>project.id===chat.projectId)?.name||'',workspace:chat.workspace||'',updatedAt:core().activity(chat),messageCount:(chat.messages||[]).filter(m=>['user','agent','assistant'].includes(m.role)&&!m.hidden&&!m.internal&&!m.deletedAt&&!m.deleted&&!['analysis','reasoning','tool'].includes(m.channel)).length})),
   folders:(state.folders?.conversations||[]).filter(core().active).map(folder=>({id:folder.id,name:folder.name})),
   recommendations:core().recommend({...state,conversations},{limit:8})
  };
 }
 function summary(id){
  const conversation=(current().conversations||[]).find(chat=>chat.id===id&&visible(chat));
  if(!conversation)return null;
  return {id:conversation.id,title:conversation.title||t('新对话','New conversation'),...core().summarize(conversation,{maxLength:900,language:/^en(?:-|$)/i.test(root.document.documentElement.lang)?'en':'zh'})};
 }
 function render(){
  if(!shell||shell.closed)return;
  shell.dialog.setAttribute('aria-label',t('整理对话','Organize conversations'));
  const selected=summary(shell.conversationId);
  root.HalaskaUI.mount(shell.host,'ConversationOrganizerView',{
   ...shell.model,initialTab:shell.tab,initialConversationId:shell.conversationId,selection:selected,busy,error:shell.error,notice:shell.notice,generation:shell.generation,
   onClose:close,onRefresh:()=>refresh({reset:true}),
   onInspect:id=>{if(busy)return;shell.conversationId=id;render();},
   onCommand:command=>commit(command),
   onOpenConversation:id=>{if(busy)return;const item=(current().conversations||[]).find(chat=>chat.id===id&&visible(chat));if(!item)return;close();hooks.openConversation?.(id);}
  });
 }
 function refresh({reset=false}={}){
  if(!shell||busy)return;
  try{shell.model=model();shell.error='';if(reset){shell.generation++;shell.notice=t('已根据当前对话更新建议。','Recommendations refreshed from current conversations.');}render();}
  catch(error){shell.error=error.message||t('无法读取当前对话。','Could not read the current conversations.');render();}
 }
 async function commit(command){
  if(busy)return false;
  if(typeof hooks.commit!=='function'){const message=t('对话保存接口尚未连接。','Conversation saving is not connected.');if(shell){shell.error=message;render();}else hooks.toast?.(message);return false;}
  busy=true;syncSidebarBusy();if(shell){shell.error='';shell.notice='';render();}
  try{
   const result=await hooks.commit(command);if(result===false)throw Error(failed());
   busy=false;syncSidebarBusy();
   const message=command.action==='dismiss'?t('已忽略这条建议。','Recommendation dismissed.'):t('对话整理已保存。','Conversation organization saved.');
   if(shell&&!shell.closed){shell.model=model();shell.notice=message;shell.error='';render();}else hooks.toast?.(message);
   enhanceSidebar();return true;
  }catch(error){busy=false;syncSidebarBusy();const message=error.message||failed();if(shell&&!shell.closed){shell.error=message;render();}else hooks.toast?.(message);return false;}
 }
 function close(){
  if(!shell||shell.closed||busy)return false;
  const previous=shell;previous.closed=true;shell=null;
  root.document.removeEventListener('workstation-language-change',previous.onLanguage);
  root.HalaskaUI?.unmount(previous.host);
  if(previous.dialog.open)previous.dialog.close();previous.dialog.remove();
  queueMicrotask(()=>{if(previous.opener?.isConnected&&!root.document.querySelector('dialog[open]')&&!root.ConversationModels?.isOpen?.())previous.opener.focus({preventScroll:true});});return true;
 }
 function open(options={}){
  if(!core()||!root.HalaskaUI?.componentNames?.includes('ConversationOrganizerView')){hooks.toast?.(t('对话整理组件尚未就绪，请重新打开应用。','Conversation organizer is not ready. Reopen the app.'));return false;}
  if(shell&&!shell.closed){if(options.conversationId){shell.conversationId=options.conversationId;shell.tab='all';shell.generation++;render();}shell.dialog.focus();return true;}
  const document=root.document,dialog=document.createElement('dialog'),host=document.createElement('div'),opener=document.activeElement;
  dialog.className='conversation-organizer-dialog';dialog.append(host);
  shell={dialog,host,opener,closed:false,error:'',notice:'',conversationId:options.conversationId||null,tab:options.tab||(options.conversationId?'all':'suggestions'),generation:0,model:{conversations:[],folders:[],recommendations:[]}};
  let outsideStart=false;
  const outside=event=>{const r=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',event=>{outsideStart=outside(event);});
  dialog.addEventListener('click',event=>{if(outsideStart&&outside(event))close();outsideStart=false;});
  dialog.addEventListener('cancel',event=>{event.preventDefault();if(!event.isComposing)close();});
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape'&&(event.isComposing||event.keyCode===229))event.preventDefault();});
  dialog.addEventListener('close',()=>{if(shell?.dialog!==dialog)return;if(busy){dialog.showModal();return;}close();});
  shell.onLanguage=()=>refresh();document.addEventListener('workstation-language-change',shell.onLanguage);
  document.body.append(dialog);refresh();dialog.showModal();dialog.querySelector('#organizerClose')?.focus({preventScroll:true});return true;
 }
 function dropId(event){return event.dataTransfer?.getData(MIME)||'';}
 function enhanceSidebar(container=root.document?.getElementById('conversationList')){
  if(!container||!core())return;
  for(const button of container.querySelectorAll('[data-conversation-id]')){
   const id=button.dataset.conversationId,chat=(current().conversations||[]).find(item=>item.id===id&&visible(item));if(!chat)continue;
   button.draggable=true;
   if(!button.dataset.organizerDrag){button.dataset.organizerDrag='true';button.addEventListener('dragstart',event=>{if(busy){event.preventDefault();return;}event.dataTransfer.setData(MIME,button.dataset.conversationId);event.dataTransfer.effectAllowed='move';});}
   const row=button.closest('.sidebar-item-row');if(!row)continue;
   let pin=row.querySelector('[data-organizer-pin]');
   if(!pin){pin=root.document.createElement('button');pin.type='button';pin.className='organizer-sidebar-pin';pin.dataset.organizerPin=id;pin.addEventListener('click',event=>{event.stopPropagation();const item=(current().conversations||[]).find(item=>item.id===id&&visible(item));if(item)commit({action:'pin',conversationId:id,pinned:!core().isPinned(item)});});row.append(pin);}
   pin.textContent=core().isPinned(chat)?'★':'☆';pin.setAttribute('aria-pressed',String(core().isPinned(chat)));pin.setAttribute('aria-label',core().isPinned(chat)?t('取消置顶此对话','Unpin this conversation'):t('置顶此对话','Pin this conversation'));pin.title=core().isPinned(chat)?t('取消置顶','Unpin'):t('置顶','Pin');pin.disabled=busy;
   if(!row.querySelector('[data-organizer-quick-preview]')){const preview=root.document.createElement('button');preview.type='button';preview.className='organizer-sidebar-preview';preview.dataset.organizerQuickPreview=id;preview.textContent='⋯';preview.setAttribute('aria-label',t(`查看「${chat.title||'新对话'}」的摘要和整理操作`,`Preview and organize “${chat.title||'New conversation'}”`));preview.title=t('摘要与整理','Preview and organize');preview.addEventListener('click',event=>{event.stopPropagation();open({conversationId:id,tab:'all'});});row.append(preview);}
  }
  for(const menu of container.querySelectorAll('[data-folder-menu^="conversations:"]')){
   const target=menu.closest('.sidebar-folder');if(!target||target.dataset.organizerDrop)continue;
   const id=menu.dataset.folderMenu.slice('conversations:'.length);target.dataset.organizerDrop=id;
   target.addEventListener('dragover',event=>{if(!busy&&Array.from(event.dataTransfer?.types||[]).includes(MIME)){event.preventDefault();event.dataTransfer.dropEffect='move';target.classList.add('organizer-drop-active');}});
   target.addEventListener('dragleave',()=>target.classList.remove('organizer-drop-active'));
   target.addEventListener('drop',event=>{target.classList.remove('organizer-drop-active');const conversationId=dropId(event);if(!conversationId||busy)return;event.preventDefault();commit({action:'move',conversationIds:[conversationId],folderId:id});});
  }
 }
 return {init(value){hooks=value||{};enhanceSidebar();},open,close,refresh,summary,enhanceSidebar};
});
