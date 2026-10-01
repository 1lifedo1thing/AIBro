/* Allowlisted migration bridge. Existing JS remains the sole workspace writer. */
(()=>{
document.body.classList.add('aibro-native');
// Native dashboards hide this persistent WebView by opacity, which does not
// reliably change document.hidden. Keep presentation separate from snapshots.
const syncVisibility=()=>document.body.classList.toggle('native-background-render',document.hidden||window.__aibroPresentationVisible===false);
syncVisibility();document.addEventListener('visibilitychange',syncVisibility);
window.addEventListener('aibro:presentation-visibility',syncVisibility);
let previousNativeView=null;let entranceTimer=null;
let commandSearchNavigationVersion=0;
document.addEventListener('aibro-command-search-success',()=>{commandSearchNavigationVersion++;snapshot();});
document.addEventListener('aibro-activity-center-change',()=>snapshot());
document.addEventListener('aibro-comparison-change',()=>snapshot());
document.addEventListener('close',event=>{if(event.target?.id==='searchDialog')snapshot();},true);
function tidyReaderHeading(){
 const title=document.querySelector('#previewTitle'),first=document.querySelector('.reading-pane .note-document[data-mode=read] .note-document-preview > h1:first-child');
 if(!title)return;
 const duplicate=!!first&&first.textContent.trim()===title.textContent.trim();
 if(duplicate)title.setAttribute('data-native-duplicate-title','true');else title.removeAttribute('data-native-duplicate-title');
}
// CitationEvidence.access privacy semantics, indexed for the 500 ms native
// projection. This index belongs to one snapshot/command, never to a save or
// record identity cache. Missing public origins remain visible; trash only
// contributes privacy ancestry and must not revive a deleted record.
function nativePrivacy(state){
 const list=value=>Array.isArray(value)?value:[];
 const names=['projects','notes','imports','tasks','conversations','agentRuns'];
 const indexes=Object.fromEntries(names.map(name=>[name,new Map()]));
 const add=(name,values)=>{for(const value of list(values)){const id=value?.id;if(!id)continue;const found=indexes[name].get(id)||[];found.push(value);indexes[name].set(id,found);}};
 for(const name of names)add(name,state[name]);
 for(const bundle of list(state.trash)){
  for(const name of names)add(name,bundle?.data?.[name]);
  add('agentRuns',bundle?.data?.runs);
 }
 const matches=(name,id)=>id?indexes[name].get(id)||[]:[];
 return (name,id)=>{
  const queue=[...matches(name,id)],seen=new Set();
  for(let at=0;at<queue.length;at++){
   const value=queue[at];if(!value||seen.has(value))continue;seen.add(value);
   if(value.private||value.ephemeral||value.incognito)return true;
   if(value.provenance?.origin)queue.push(value.provenance.origin);
   queue.push(...matches('projects',value.projectId));
   for(const id of [value.agentRunId,value.runId])queue.push(...matches('agentRuns',id));
   for(const id of [value.sourceConversationId,value.conversationId])queue.push(...matches('conversations',id));
  }
  return false;
 };
}
const conversationPreviewCache=new WeakMap();
function conversationPreview(item){
 const messages=item.messages||[],last=messages.at(-1),language=document.documentElement?.lang?.startsWith('en')?'en':'zh',previous=conversationPreviewCache.get(item);
 if(previous&&previous.messages===messages&&previous.count===messages.length&&previous.text===last?.text&&previous.updated===item.updatedAt&&previous.title===item.title&&previous.language===language)return previous.value;
 const value=window.ConversationOrganization?.summarize(item,{maxLength:900,language})||{};
 conversationPreviewCache.set(item,{messages,count:messages.length,text:last?.text,updated:item.updatedAt,title:item.title,language,value});return value;
}
function snapshot(){refreshNativeChoices();tidyReaderHeading();const view=document.body.dataset.view;document.body.classList.toggle('aibro-native-space-navigation',!!window.__aibroSpaceNavigationView&&(view===window.__aibroSpaceNavigationView||(view==='wiki'&&window.__aibroSpaceNavigationView==='research')));if(view!==previousNativeView){previousNativeView=view;if(document.body.classList.remove){document.body.classList.remove('native-enter');void document.body.offsetWidth;document.body.classList.add('native-enter');clearTimeout(entranceTimer);entranceTimer=setTimeout(()=>document.body.classList.remove('native-enter'),500);}}if(typeof storageHydrated==='undefined'||!storageHydrated)return;const active=x=>!x.deletedAt&&!x.deleted&&!x.archivedAt&&!x.archived&&!x.private&&!x.ephemeral&&!x.incognito&&!(["archived","deleted"].includes(x.status));
 const date=x=>{if(x==null||x==='')return null;const n=typeof x==='number'?x:Date.parse(x);return Number.isFinite(n)?n:null;};
 const spaceName=value=>typeof workspaceName==='function'?workspaceName(value):(value||'日常');
 const projectOwners=new Map();for(const project of state.projects){const owners=projectOwners.get(project.id)||[];owners.push(project);projectOwners.set(project.id,owners);}
 const isPrivate=nativePrivacy(state);
 const visibleProject=x=>active(x)&&projectOwners.get(x.id)?.length===1&&!isPrivate('projects',x.id);
 const visibleRecords=(items,collection)=>items.filter(x=>{const owners=projectOwners.get(x.projectId)||[];return active(x)&&owners.length<=1&&(!owners.length||active(owners[0]))&&!isPrivate(collection,x.id);});
 const visibleTasks=visibleRecords(state.tasks,'tasks'),visibleNotes=visibleRecords(state.notes,'notes'),visibleImports=visibleRecords(state.imports,'imports');
 // Only this snapshot owns the index. Use raw typed identities/workspaces and
 // the existing project normalization, so display labels cannot satisfy a
 // dependency from another scope. Hidden tasks never enter this index.
 const completedTasks=new Map();
 for(const task of visibleTasks){
  if(task.status!=='done')continue;
  const id=task.id,workspace=task.workspace,projectId=task.projectId||null;
  // Map/Set consider NaN equal to itself; the original strict comparison did not.
  if(id!==id||workspace!==workspace)continue;
  let projects=completedTasks.get(id);if(!projects)completedTasks.set(id,projects=new Map());
  let workspaces=projects.get(projectId);if(!workspaces)projects.set(projectId,workspaces=new Set());
  workspaces.add(workspace);
 }
 const dependencyDone=(id,task)=>completedTasks.get(id)?.get(task.projectId||null)?.has(task.workspace)===true;
 const records=(items,kind)=>items.map(x=>({id:x.id,title:x.title||x.name||'',workspace:spaceName(projectOwners.get(x.projectId)?.[0]?.workspace||x.workspace),projectId:x.projectId||'',kind,status:x.status||'todo',priority:x.priority||'medium',waitingOnDependencies:kind==='task'&&(x.dependsOn||[]).some(id=>!dependencyDone(id,x)),start:date(x.startAt),due:date(x.dueAt),dueDay:typeof x.dueAt==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.dueAt)?x.dueAt:null,completed:date(x.completedAt),updated:date(x.updatedAt||x.createdAt),reminderMinutes:Number.isInteger(x.reminderMinutes)&&x.reminderMinutes>=0&&x.reminderMinutes<=10080?x.reminderMinutes:null,reminderDisabled:Object.hasOwn(x,'reminderMinutes')&&x.reminderMinutes===null}));
 const library=state.conversations.filter(x=>!x.deletedAt&&!x.deleted&&!x.ephemeral&&!x.private&&!x.incognito).map(x=>{const summary=conversationPreview(x);return {id:x.id,title:x.title||'新对话',folderId:x.folderId||'',projectId:x.projectId||'',updatedAt:Number(x.updatedAt)||0,archived:!active(x),pinned:!!(x.favorite||x.pinned||x.pinnedAt),summary:String(summary.text||'').slice(0,180),summaryGoal:summary.goal||'',summaryOutcome:summary.outcome||'',messageCount:summary.messageCount||0};});
 const folders=(state.folders?.conversations||[]).filter(x=>!x.deletedAt&&!x.deleted).map(x=>({id:x.id,title:x.name||'文件夹',archived:!active(x)}));
 const data={privateMode:!!window.PrivateMode?.isOn?.(),spaceSection:['daily','courses','research'].includes(view)?(typeof resolveSpaceSection==='function'?resolveSpaceSection(view,state.ui.spaceTabs?.[view]):state.ui.spaceTabs?.[view]||'projects'):null,comparisonOpen:!!window.SourceComparison?.isOpen?.(),activityCenterOpen:!!window.ActivityCenter?.isOpen?.(),activityUnread:window.PrivateMode?.isOn?.()?0:(window.ActivityCenter?.unreadCount?.(state)||0),commandSearchOpen:!!document.querySelector('#searchDialog[open]')||!!window.CommandSearch?.isExecuting?.(),commandSearchNavigationVersion,tourOpen:!!document.querySelector('#onboardingLayer:not([hidden]), #workspaceTour:not([hidden])'),conversationLibrary:library,conversationFolders:folders,tasks:records(visibleTasks,'task'),documents:[...records(visibleNotes,'note'),...records(visibleImports,'import')],modalOpen:!!document.querySelector('dialog:modal'),taskOpen:!!document.querySelector('#taskDialog[open]'),taskEntry:document.querySelector('#taskDialog[open]')&&typeof taskDocumentOrigin==='function'?taskDocumentOrigin()?.entry||null:null,readingOpen:document.body.classList.contains('reading-open'),readerAvailable:!!document.querySelector('#readingToggle:not([hidden])'),projects:state.projects.filter(visibleProject).map(x=>({id:x.id,title:x.name||'Project',workspace:spaceName(x.workspace)})),conversations:state.conversations.filter(active).map(x=>({id:x.id,title:x.title||'Conversation',workspace:x.workspace||''})),taskCount:visibleTasks.filter(x=>x.status!=='done').length,noteCount:visibleNotes.length,sourceCount:visibleImports.length,projectId:state.currentProjectId||'',projectSection:view==='project'?(state.ui.projectTab||'conversations'):null,view:document.body.dataset.view||'agent',conversationId:state.currentConversationId||'',busy:!!sendMessage.busy};
 const json=JSON.stringify(data);if(json!==snapshot.last){snapshot.last=json;window.webkit.messageHandlers.workspace.postMessage(data);}}

// Progressive enhancement: every single-value select keeps its original form and change handlers.
const choiceRegistry=new WeakMap();let activeChoice=null;let choiceSerial=0;
const shortChoices='#provider,#conversationProvider,#polishStyle,#interfaceLanguage,.permission-row select';
const english=()=>document.documentElement.lang.startsWith('en');
function chooseValue(select,value){const option=[...select.options].find(o=>o.value===value);if(select.disabled||!option||option.disabled||option.hidden||option.parentElement?.disabled)return;select.value=value;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));refreshNativeChoices();}
function choiceLabel(select){return (select.labels?.[0]?.textContent||select.getAttribute('aria-label')||select.title||(english()?'Choose':'选择')).trim();}
// Only a route/layout change dismisses transient menus. Window occlusion must
// retain input composition, dialogs, reading handles and preference saves.
window.addEventListener('aibro:surface-visibility',()=>{
 if(window.__aibroSurfaceVisible!==false)return;
 closeChoice(false);
 window.ConversationModels?.close({restoreFocus:false,force:true});
 window.ComposerAddMenu?.close({restoreFocus:false});
 window.WorkspaceNavigation?.dismissTransient?.();
});
function closeChoice(focus=false){if(!activeChoice)return;const c=activeChoice;activeChoice=null;c.trigger.setAttribute('aria-expanded','false');c.panel.remove();if(focus&&c.trigger.isConnected)c.trigger.focus();}
function openChoice(select,trigger){
 if(activeChoice?.trigger===trigger){closeChoice(true);return;}closeChoice();if(select.disabled)return;
 const panel=document.createElement('div');panel.className='native-select-panel';panel.setAttribute('popover','manual');
 const label=choiceLabel(select), options=[...select.options].filter(o=>!o.hidden), searchable=options.length>6;
 const caption=document.createElement('div');caption.className='native-select-caption';caption.textContent=label;panel.append(caption);
 let search;if(searchable){search=document.createElement('input');search.type='search';search.placeholder=english()?'Search options…':'搜索选项…';search.setAttribute('aria-label',search.placeholder);panel.append(search);}
 const list=document.createElement('div');list.className='native-select-options';list.id='native-options-'+(++choiceSerial);list.setAttribute('role','listbox');list.setAttribute('aria-label',label);panel.append(list);
 const empty=document.createElement('p');empty.className='native-select-empty';empty.textContent=english()?'No matching options':'没有匹配的选项';empty.hidden=true;panel.append(empty);
 let buttons=[];
 function render(query=''){
  list.replaceChildren();buttons=[];let lastGroup=null;
  options.filter(o=>o.textContent.toLocaleLowerCase().includes(query.toLocaleLowerCase())).forEach(option=>{
   const group=option.parentElement?.tagName==='OPTGROUP'?option.parentElement:null;
   if(group&&group!==lastGroup){const heading=document.createElement('div');heading.className='native-select-caption';heading.textContent=group.label;list.append(heading);}lastGroup=group;
   const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.setAttribute('aria-selected',String(option.value===select.value));button.disabled=option.disabled||!!group?.disabled;button.dataset.value=option.value;button.tabIndex=-1;
   const dot=document.createElement('span');dot.className='native-option-dot';dot.dataset.value=option.value;dot.setAttribute('aria-hidden','true');button.append(dot);
   const title=document.createElement('span');title.textContent=option.textContent;button.append(title);
   const check=document.createElement('span');check.className='native-option-check';check.textContent=option.value===select.value?'✓':'';check.setAttribute('aria-hidden','true');button.append(check);
   button.addEventListener('click',()=>{if(button.disabled)return;closeChoice(true);chooseValue(select,option.value);});list.append(button);if(!button.disabled)buttons.push(button);
  });empty.hidden=!!buttons.length;
 }
 render();search?.addEventListener('input',()=>render(search.value));
 panel.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeChoice(true);return;}
  if(e.key==='Tab'){closeChoice(true);return;}
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
   if(search===document.activeElement&&['Home','End'].includes(e.key))return;
   e.preventDefault();const index=buttons.indexOf(document.activeElement),step=e.key==='ArrowUp'?-1:1;
   const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:index<0?(step>0?0:buttons.length-1):(index+step+buttons.length)%buttons.length;buttons[next]?.focus();
  }else if(!search&&e.key.length===1&&!e.metaKey&&!e.ctrlKey){buttons.find(b=>b.textContent.trim().toLocaleLowerCase().startsWith(e.key.toLocaleLowerCase()))?.focus();}
 });
 // A popover belongs to the top layer even when its trigger is inside a modal dialog.
 (select.closest('dialog[open]')||document.body).append(panel);if(panel.showPopover)panel.showPopover();
 const r=trigger.getBoundingClientRect(), width=Math.min(Math.max(r.width,250),window.innerWidth-24);
 panel.style.width=width+'px';panel.style.left=Math.max(12,Math.min(r.left,window.innerWidth-width-12))+'px';
 const below=window.innerHeight-r.bottom-12,above=r.top-12,up=below<230&&above>below;
 panel.style.maxHeight=Math.max(100,Math.min(360,up?above:below))+'px';
 panel.style.top=(up?Math.max(12,r.top-Math.min(panel.scrollHeight,360,above)-6):r.bottom+6)+'px';
 trigger.setAttribute('aria-expanded','true');trigger.setAttribute('aria-controls',list.id);activeChoice={select,trigger,panel,optionKey:JSON.stringify([...select.options].map(o=>[o.value,o.textContent,o.disabled,o.hidden])),value:select.value};
 (search||buttons.find(b=>b.getAttribute('aria-selected')==='true')||buttons[0])?.focus();
}
function refreshNativeChoices(){
 if(!document.querySelectorAll)return;
 if(activeChoice&&(!activeChoice.select.isConnected||activeChoice.select.closest('dialog:not([open])')||!activeChoice.trigger.getClientRects().length||activeChoice.select.disabled))closeChoice();
 document.querySelectorAll('select:not([multiple])').forEach(select=>{
  // React islands provide their own accessible native hit target and Kit
  // presentation. Inserting a second trigger would corrupt their owned DOM.
  if(select.closest('[data-halaska-root]'))return;
  if(select.size>1)return;
  let control=choiceRegistry.get(select);const short=select.matches(shortChoices);
  if(!control||!control.isConnected){
   control=document.createElement(short?'div':'button');control.className=short?'native-choices'+(select.id==='provider'?' native-connection-cards':' native-segments'):'native-select-trigger';
   if(short){control.setAttribute('role','radiogroup');control.addEventListener('click',e=>{const button=e.target.closest('[data-choice]');if(button&&!button.disabled)chooseValue(select,button.dataset.choice);});
    control.addEventListener('keydown',e=>{const buttons=[...control.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);if(i<0||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(['ArrowRight','ArrowDown'].includes(e.key)?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();buttons[next]?.click();});
   }else{control.type='button';control.setAttribute('aria-haspopup','listbox');control.setAttribute('aria-expanded','false');control.addEventListener('click',()=>openChoice(select,control));control.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();openChoice(select,control);}});}
   select.after(control);select.classList.add('native-choice-source');choiceRegistry.set(select,control);
   select.addEventListener('change',refreshNativeChoices);select.addEventListener('invalid',()=>control.focus());
   for(const label of select.labels||[])label.addEventListener('click',e=>{if(e.target===label||e.target.closest('label')===label){e.preventDefault();(short?control.querySelector('[aria-checked=true]'):control)?.focus();}});
  }
  const label=choiceLabel(select);control.setAttribute('aria-label',label);control.hidden=select.hidden||select.classList.contains('hidden')||select.style.display==='none';
  const options=[...select.options],key=JSON.stringify(options.map(o=>[o.value,o.textContent,o.disabled,o.hidden]));
  if(activeChoice?.select===select&&(activeChoice.optionKey!==key||activeChoice.value!==select.value))closeChoice();
  if(short){if(control.dataset.options!==key){control.replaceChildren();control.dataset.options=key;for(const option of options){const button=document.createElement('button');button.type='button';button.dataset.choice=option.value;button.setAttribute('role','radio');
    if(select.id==='provider'){const icon=document.createElement('span');icon.className='native-choice-icon';icon.setAttribute('aria-hidden','true');icon.textContent=option.value==='api'?'⌘':'◎';button.append(icon);}
    const copy=document.createElement('span');copy.className='native-choice-copy';const title=document.createElement('strong');title.textContent=option.textContent;copy.append(title);
    if(select.id==='provider'){const detail=document.createElement('small');detail.textContent=option.value==='api'?(english()?'Your endpoint, key and model':'使用自己的服务地址、密钥与模型'):(english()?'Connect your existing account':'连接已有账号，选择可用模型');copy.append(detail);}
    const check=document.createElement('span');check.className='native-choice-check';check.setAttribute('aria-hidden','true');check.textContent='✓';button.append(copy,check);control.append(button);
   }}[...control.children].forEach((button,i)=>{const checked=button.dataset.choice===select.value;button.hidden=options[i].hidden;button.disabled=select.disabled||options[i].disabled;button.setAttribute('aria-checked',String(checked));button.tabIndex=checked?0:-1;});
  }else{control.disabled=select.disabled;const title=select.selectedOptions[0]?.textContent|| (english()?'Choose…':'请选择…');if(control.dataset.title!==title){control.dataset.title=title;control.replaceChildren();const text=document.createElement('span');text.textContent=title;const chevron=document.createElement('span');chevron.className='native-select-chevron';chevron.textContent='⌄';chevron.setAttribute('aria-hidden','true');control.append(text,chevron);}control.setAttribute('aria-label',label+'：'+title);}
 });
}
if(typeof MutationObserver!=='undefined'){
 let scheduled=false;new MutationObserver(records=>{if(!records.some(r=>r.target.tagName==='SELECT'||r.target.tagName==='OPTION'||r.target.tagName==='DIALOG'||r.target.id==='previewDialog'||r.target.id==='readingPane'||[...(r.addedNodes||[])].some(n=>n.nodeType===1&&(n.matches?.('select')||n.querySelector?.('select')))))return;if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;refreshNativeChoices();});}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','hidden','style','open']});
 document.addEventListener('pointerdown',e=>{if(activeChoice&&!activeChoice.panel.contains(e.target)&&!activeChoice.trigger.contains(e.target))closeChoice();},true);
 document.addEventListener('scroll',e=>{if(activeChoice&&!activeChoice.panel.contains(e.target))closeChoice();},true);
 document.addEventListener('close',()=>closeChoice(),true);window.addEventListener('resize',()=>closeChoice());
}

window.NativeConversationActions={perform(command){
 if(typeof storageHydrated==='undefined'||!storageHydrated)throw Error('工作区尚未就绪。');
 if(sendMessage.busy)throw Error('请等待当前对话生成完成后再整理。');
 if(command.kind==='folder'&&command.action==='create')return commitConversationOrganization({action:'createFolder',name:command.name}).then(()=>{snapshot();return true});
 if(['pin','move'].includes(command.action))return commitConversationOrganization({action:command.action,conversationId:command.id,folderId:command.folderId||null,pinned:command.pinned==='true'}).then(()=>{snapshot();return true});
 state=NativeConversationLibrary.apply(state,command);
 normalizeStateShape(state);save();renderAll();snapshot();return true;
}};
let nativeNavigationVersion=0;
let lastWorkspaceRequest=null;
function nativeRendererIntent(){return JSON.stringify([
 typeof showView==='function'?(showView.navigationVersion||0):0,
 typeof previewOpenIntent==='undefined'?0:previewOpenIntent,
 typeof workspaceRouteIntent==='undefined'?0:workspaceRouteIntent
]);}
function nativeRouteAck(accepted,version,startedAt){
 const view=document.body.dataset.view||'agent';
 const destination={view,projectId:view==='project'?(state.currentProjectId||''):(state.conversations.find(x=>x.id===state.currentConversationId)?.projectId||''),conversationId:state.currentConversationId||'',projectSection:view==='project'?(state.ui.projectTab||'conversations'):null,spaceSection:['daily','courses','research'].includes(view)?(typeof resolveSpaceSection==='function'?resolveSpaceSection(view,state.ui.spaceTabs?.[view]):state.ui.spaceTabs?.[view]||'projects'):null};
 const current=version===nativeNavigationVersion;
 snapshot();
 return {accepted:current&&accepted===true,supersededByPage:current&&accepted!==true&&nativeRendererIntent()!==startedAt,destination};
}
window.NativeShell={getNavigationVersion(){return nativeNavigationVersion;},isWorkspaceRequestCurrent(requestId){return !!lastWorkspaceRequest&&lastWorkspaceRequest.requestId===requestId&&lastWorkspaceRequest.version===nativeNavigationVersion&&lastWorkspaceRequest.rendererIntent===nativeRendererIntent();},cancelNavigation(){nativeNavigationVersion++;},perform(command){if(typeof storageHydrated==='undefined'||!storageHydrated)return false;const {type,id}=command;
 const route=['view','workspace-view','project','conversation','new','new-space-conversation','new-project-conversation','new-research-conversation'].includes(type);
 const version=route?++nativeNavigationVersion:nativeNavigationVersion;
 const active=x=>!x.deletedAt&&!x.deleted&&!x.archivedAt&&!x.archived&&!x.private&&!x.ephemeral&&!x.incognito&&!(["archived","deleted"].includes(x.status));
 const privacyCollection={task:'tasks','complete-task':'tasks','reopen-task':'tasks',note:'notes',import:'imports',project:'projects','create-project-task':'projects','new-project-conversation':'projects'}[type];
 if(typeof privacyCollection==='string'&&nativePrivacy(state)(privacyCollection,id))return false;
 switch(type){case'view':if(id==='history'){WorkstationRunHistory.open();break;}if(!['captures','wiki','agent','dashboard','overview','daily','courses','research','history','trash','settings'].includes(id))return false;showView(id,id);break;
 case'workspace-view':{
  if(!['overview','conversations','agenda','daily','courses','research','captures','wiki','dashboard','trash','agent','settings'].includes(id))return false;
  const section=command.section;
  if(section!==undefined&&(!['daily','courses','research'].includes(id)||!['projects','knowledge','tasks','overview',...(id==='research'?['papers']:[])].includes(section)))return false;
  const isCurrent=()=>version===nativeNavigationVersion&&(!command.requestId||(typeof taskDocumentReturnCurrent==='function'&&taskDocumentReturnCurrent(command.requestId)));
  const nativeOnly=['overview','conversations','agenda'].includes(id);
  const opened=nativeOnly?prepareWorkspaceRoute({isCurrent}).then(current=>!!current?.()):navigateWorkspaceView(id,{section,isCurrent});
  const startedAt=nativeRendererIntent();
  return Promise.resolve(opened).then(result=>{
   const ack=nativeRouteAck(result===true,version,startedAt);
   if(ack.accepted&&nativeOnly){window.ReadingPane?.revealWorkspace({force:true});ack.destination={view:id};}
   if(ack.accepted&&typeof command.requestId==='string')lastWorkspaceRequest={requestId:command.requestId,version,rendererIntent:nativeRendererIntent()};
   return ack;
  },error=>{const ack=nativeRouteAck(false,version,startedAt);if(ack.supersededByPage)return ack;throw error;});
 }
 case'search':if(typeof openSearchDialog!=='function')return false;openSearchDialog();break;
 case'activity-center':if(!window.ActivityCenter)return false;ActivityCenter.open();break;
 case'project':{
  if(!state.projects.some(x=>x.id===id&&active(x)))return false;
  const section=command.section;
  if(section!==undefined&&!['conversations','knowledge','outputs','tasks','schedule','overview'].includes(section))return false;
  // The project controller owns durable draft parking. Await its actual ACK;
  // Recheck origin privacy after draft parking as well as navigation intent.
  const isCurrent=()=>version===nativeNavigationVersion&&!nativePrivacy(state)('projects',id);
  const opened=openProject(id,{section,isCurrent});
  // Capture after the controller claims its own route intent, before its
  // first awaited draft flush settles. Later in-page navigation is distinct
  // from a failed flush and must remain the native shell's actual location.
  const startedAt=nativeRendererIntent();
  return Promise.resolve(opened).then(result=>nativeRouteAck(result===true,version,startedAt),error=>{const ack=nativeRouteAck(false,version,startedAt);if(ack.supersededByPage)return ack;throw error;});
 }
 case'conversation':{
  if(!state.conversations.some(x=>x.id===id&&active(x)))return false;
  const isCurrent=()=>version===nativeNavigationVersion;
  const opened=typeof navigateWorkspaceConversation==='function'?navigateWorkspaceConversation(id,{isCurrent}):openConversation(id);
  const startedAt=nativeRendererIntent();
  return Promise.resolve(opened).then(result=>nativeRouteAck(result!==false,version,startedAt),error=>{const ack=nativeRouteAck(false,version,startedAt);if(ack.supersededByPage)return ack;throw error;});
 }
 case'complete-task':case'reopen-task':{const task=state.tasks.find(x=>x.id===id&&active(x));if(!task)return false;const done=type==='complete-task';if((task.status==='done')!==done)toggleTaskStatus(id);break;}
 case'task':if(!state.tasks.some(x=>x.id===id&&active(x)))return false;if(openTask(id,{origin:command.origin})!==true)return false;break;
 case'note':if(!state.notes.some(x=>x.id===id&&active(x)))return false;if(command.origin)openPreview('note',id,undefined,undefined,undefined,{origin:command.origin});else openNote(id);break;
 case'import':if(!state.imports.some(x=>x.id===id&&active(x)))return false;if(command.origin)openPreview('import',id,undefined,undefined,undefined,{origin:command.origin});else openImport(id);break;
 case'create-task':if(!['日常','课程','科研'].includes(id))return false;PlanningWorkbench.createTask({workspace:id});break;
 case'create-project-task':{const project=state.projects.find(x=>x.id===id&&active(x));if(!project)return false;PlanningWorkbench.createTask({workspace:project.workspace,projectId:project.id});break;}
 case'reader':document.getElementById('readingToggle')?.click();break;
 case'new':case'new-space-conversation':case'new-research-conversation':case'new-project-conversation':{
  let workspace='auto',projectId=null;
  if(type==='new-research-conversation')workspace='科研';
  if(type==='new-space-conversation'){if(!['日常','课程','科研'].includes(id))return false;workspace=id;}
  if(type==='new-project-conversation'){const project=state.projects.find(x=>x.id===id&&active(x));if(!project)return false;workspace=project.workspace;projectId=project.id;}
  const isCurrent=()=>version===nativeNavigationVersion&&(!projectId||!nativePrivacy(state)('projects',projectId));
  const opened=navigateWorkspaceNewConversation(workspace,projectId,{isCurrent}),startedAt=nativeRendererIntent();
  return Promise.resolve(opened).then(result=>nativeRouteAck(result===true,version,startedAt),error=>{const ack=nativeRouteAck(false,version,startedAt);if(ack.supersededByPage)return ack;throw error;});
 }
 case'organize-conversations':if(!window.ConversationOrganizer)return false;window.ConversationOrganizer.open();break;
 case'theme':if(!['light','dark'].includes(id))return false;state.ui.theme=id;applyUiPreferences();save();break;
 default:return false;}snapshot();return true;}};
window.addEventListener('aibro-native-space-navigation',snapshot);
setInterval(snapshot,500);snapshot();
})();
