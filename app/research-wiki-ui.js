(function(root){'use strict';const W=root.ResearchWiki,t=(zh,en)=>/^en(?:-|$)/i.test(root.WorkstationI18n?.getLanguage?.()||root.document?.documentElement?.lang||'')?en:zh;
const FIELD_LABELS={definition:'Definition and scope',distinctions:'Related concepts and differences',description:'Data and tasks',task:'Evaluation task',protocol:'Protocol and metrics',purpose:'Purpose and audience',question:'Research question',method:'Method and contributions',evidence:'Evidence and source locations',limitations:'Limitations and scope',principle:'Core principle',assumptions:'Assumptions and prerequisites',procedure:'Implementation and procedure',hypothesis:'Hypothesis',setup:'Setup and controls',versions:'Code and data versions',results:'Metrics and results',interpretation:'Interpretation and limitations',symptom:'Problem and symptoms',attempts:'Attempts and outcomes',conditions:'Reproduction conditions',feedback:'Original feedback and sources',response:'Response and decisions',validation:'Validation plan and evidence',status:'Status',connections:'Connections and inspiration',observations:'Observations and evidence',inferences:'Inferences to validate',contradictions:'Conflicts and invalidated conclusions',nextSteps:'Next steps and open questions'};
let hooks,host,headerRoot,headerIsland,cardsIsland,query='',filter='',projectId,dialog,composerIsland,composerSession,actionBusy='',actionError='';
const cardOperations=new Map(),cardErrors=new Map();
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
const button=(text,fn,cls='secondary')=>{const b=el('button',cls,text);b.type='button';b.onclick=fn;return b;};
// Header and keyed cards have separate React roots. The directory and unsaved
// entry dialog retain their original DOM lifecycle and storage contracts.
function init(h){
 hooks=h;host=document.getElementById('wiki');if(!host)return;
 headerIsland?.unmount();cardsIsland?.unmount();headerIsland=null;cardsIsland=null;headerRoot=el('div','wiki-header-root');
 const layout=el('div','wiki-layout'),tree=el('nav','wiki-tree');tree.setAttribute('aria-label',t('科研知识目录','Research knowledge directory'));
 layout.append(tree,el('div','wiki-grid'));host.replaceChildren(headerRoot,layout);
 document.removeEventListener('workstation-language-change',render);document.addEventListener('workstation-language-change',render);render();
}
function headerProps(){
 const state=hooks.getState(),projects=(state.projects||[]).filter(p=>W.active(p)&&p.workspace==='科研');
 if(projectId&&!projects.some(p=>p.id===projectId))projectId=undefined;
 const entries=W.entries(state,{projectId}),counts=Object.fromEntries(Object.keys(W.TYPES).map(type=>[type,0]));
 for(const note of entries)counts[W.typeOf(note)]++;
 return {
  query,type:filter,scope:projectId===undefined?'all':projectId===null?'unassigned':'project:'+projectId,
  count:W.entries(state,{projectId,type:filter,query}).length,
  scopes:[{value:'all',label:t('全部科研','All research')},{value:'unassigned',label:t('独立条目','Unassigned')},...projects.map(p=>({value:'project:'+p.id,label:p.name}))],
  types:[{value:'',label:t('全部类型','All types'),count:entries.length},...Object.entries(W.TYPES).map(([value,kind])=>({value,label:t(kind.zh,kind.en),count:counts[value]}))],
  canImport:!!root.WikiMigrationUI,canResearch:!!hooks.research,actions:[
   {id:'refresh',group:'storage',label:state._wikiEnabled?t('刷新 Markdown','Refresh Markdown'):t('建立 Markdown Wiki','Create Markdown Wiki')},
   ...(root.WikiExport?[{id:'export',group:'storage',label:t('导出目录与原件','Export Wiki and sources')}]:[]),
   ...(root.WikiMaintenance?[{id:'links',group:'checks',label:t('检查移动链接','Check moved links')}]:[]),
   ...(root.ResearchInspector?[{id:'health',group:'checks',label:t('知识检查','Knowledge checks')},{id:'search',group:'checks',label:t('检索试验','Retrieval lab')},{id:'sources',group:'checks',label:t('资料处理','Source processing')}]:[])
  ],
  busy:actionBusy,error:actionError||state._wikiError||'',
  onQuery:value=>{query=value;render();},onType:value=>{filter=value;render();},
  onScope:value=>{projectId=value==='all'?undefined:value==='unassigned'?null:value.slice('project:'.length);render();},
  onAction:performAction
 };
}
function renderHeader(){
 const props=headerProps();
 if(headerIsland)headerIsland.update(props);else headerIsland=root.HalaskaUI.mount(headerRoot,'ResearchWikiHeader',props);
}
function render(){if(!host)return;renderHeader();host.querySelector('.wiki-tree').setAttribute('aria-label',t('科研知识目录','Research knowledge directory'));renderCards();if(dialog?.open)renderComposer();}
async function performAction(id){
 if(actionBusy)return;
 const returnFocus=document.activeElement;
 actionError='';
 if(id==='new'){compose();return;}
 if(id==='refresh'){actionBusy=id;renderHeader();}
 try{
  switch(id){
   case 'refresh':await hooks.refresh(!hooks.getState()._wikiEnabled);hooks.toast(t('Wiki 已同步','Wiki synchronized'));break;
   case 'import':await root.WikiMigrationUI?.open();break;
   case 'research':await hooks.research?.(projectId);break;
   case 'export':await root.WikiExport?.open(W.entries(hooks.getState(),{projectId,type:filter,query}).map(n=>n.id));break;
   case 'links':await root.WikiMaintenance?.open();break;
   case 'health':await root.ResearchInspector?.openHealth({projectId});break;
   case 'search':await root.ResearchInspector?.openSearch({projectId});break;
   case 'sources':await root.ResearchInspector?.openSources({projectId});break;
  }
 }catch(error){actionError=error?.message||String(error);hooks.toast(actionError);}
 finally{actionBusy='';if(id==='refresh')render();else renderHeader();if(id==='refresh'&&document.activeElement===document.body&&returnFocus?.isConnected&&returnFocus.getClientRects().length)returnFocus.focus({preventScroll:true});}
}
function cardExcerpt(content){
 // Reuse the editor's display parser; never strip or write the stored note.
 const body=root.NoteEditor?.markdownBody?root.NoteEditor.markdownBody(content):String(content||'');
 return body.split('\n').filter(line=>line.trim()&&!/^\s*[#>]/.test(line)&&line.trim()!=='未记录。').slice(0,3).join('\n');
}
function cardView(note,state){
 const kind=W.TYPES[W.typeOf(note)],relation=W.related(state,note),owner=(state.projects||[]).find(p=>p.id===note.projectId);
 const date=note.updatedAt??note.createdAt,time=date===undefined?null:new Date(date);
 return {id:note.id,title:note.title||'',type:W.typeOf(note),typeLabel:t(kind.zh,kind.en),typeIcon:kind.icon,
  excerpt:cardExcerpt(note.content),owner:owner?.name||t('独立科研条目','Unassigned research'),
  date:time&&!Number.isNaN(time.valueOf())?time.toISOString():'',
  sourceCount:(note.sourceAttachmentIds||[]).length+relation.sources.length,backlinkCount:relation.backlinks.length,
  pendingDraft:!!note.aiDraft,fileError:note.wikiFileError||'',canMerge:!!root.WikiMerge,canRelations:!!root.ResearchInspector,
  pendingAction:cardOperations.get(note.id)?.action||'',actionError:cardErrors.get(note.id)||''};
}
function renderCards(){
 renderTree();const grid=host.querySelector('.wiki-grid'),state=hooks.getState(),notes=W.entries(state,{projectId,type:filter,query});
 const focus=document.activeElement,ownedFocus=grid.contains(focus);
 const props={notes:notes.map(note=>cardView(note,state)),filtered:!!(query.trim()||filter),onAction:performCardAction,onCreate:compose,
  onReset:()=>{query='';filter='';render();document.getElementById('wikiSearch')?.focus({preventScroll:true});}};
 if(cardsIsland)cardsIsland.update(props);else cardsIsland=root.HalaskaUI.mount(grid,'ResearchWikiCards',props);
 // Keyed retained cards keep their DOM and open menu. If an external update
 // removes the focused card, return to the stable search control, not body.
 if(ownedFocus&&document.activeElement===document.body){const target=focus.isConnected&&!focus.disabled?focus:!focus.isConnected?document.getElementById('wikiSearch'):null;if(target?.getClientRects().length)target.focus({preventScroll:true});}
}
function performCardAction(id,action){
 if(cardOperations.has(id))return cardOperations.get(id).promise;
 const note=W.entries(hooks.getState()).find(item=>item.id===id);
 if(!note)throw Error(t('条目已删除、归档或不在科研范围中。','This entry was removed, archived, or is no longer in research.'));
 const operation={action,promise:null,focus:document.activeElement};cardOperations.set(id,operation);cardErrors.delete(id);
 operation.promise=(async()=>{
  try{switch(action){
   case 'open':return await hooks.open(id);
   case 'continue':return await hooks.continue(id);
   case 'remove':return await hooks.remove(id);
   case 'merge':return await root.WikiMerge?.open(id);
   case 'relations':return hooks.sources ? await hooks.sources(id) : await root.ResearchInspector?.openRelations(id);
   case 'restore':if(note.wikiFileError)await hooks.restore(id);return;
  }}catch(error){cardErrors.set(id,error?.message||String(error));hooks.toast(error?.message||String(error));throw error;}
  finally{if(cardOperations.get(id)===operation){cardOperations.delete(id);render();const active=document.activeElement;if(operation.focus&&!operation.focus.isConnected&&(active===document.body||!active?.getClientRects().length)){const target=document.getElementById('wikiSearch');if(target?.getClientRects().length)target.focus({preventScroll:true});}}}
 })();return operation.promise;
}
function renderTree(){
 const tree=host.querySelector('.wiki-tree'),state=hooks.getState();const expanded=new Set([...tree.querySelectorAll('details[open]')].map(d=>d.dataset.path));const known=new Set([...tree.querySelectorAll('details')].map(d=>d.dataset.path));tree.replaceChildren();const nodes=new Map();
 const folder=(path)=>{let parent=tree,key='';for(const name of path){key+='/'+name;if(!nodes.has(key)){const d=el('details');d.dataset.path=key;d.open=!known.has(key)||expanded.has(key);d.append(el('summary','',name));parent.append(d);nodes.set(key,d);}parent=nodes.get(key);}return parent;};
 const projects=new Set((state.projects||[]).filter(p=>W.active(p)&&p.workspace==='科研').map(p=>p.id));
 const scoped=n=>W.active(n)&&(!n.projectId? n.workspace==='科研':projects.has(n.projectId))&&(projectId===undefined||(n.projectId||null)===projectId);
 const q=query.toLocaleLowerCase().trim();
 for(const note of (state.notes||[]).filter(scoped)){
  const type=W.typeOf(note);if(filter&&type!==filter)continue;if(q&&!`${note.title} ${note.content}`.toLocaleLowerCase().includes(q))continue;
  const diskPath=state._wikiFiles?.[note.id]?.path;const path=diskPath?diskPath.split('/').slice(0,-1):type==='paper'?['sources','papers']:type?[({method:'methods',concept:'concepts',dataset:'datasets',benchmark:'benchmarks',output:'outputs',experiment:'experiments',failure:'failures',review:'reviews',idea:'questions'})[type]]:['notes'];
  const b=button(note.title,()=>hooks.open(note.id),'wiki-tree-file');b.dataset.userContent='';b.title=note.title;b.dataset.wikiTreeNote=note.id;b.dataset.openNote=note.id;folder(path).append(b);
 }
 for(const source of (state.imports||[]).filter(scoped)){
  const name=source.name||source.originalName||source.id;if(q&&!name.toLocaleLowerCase().includes(q))continue;
  const parts=String(source.folderPath||'').split('/').filter(x=>x&&x!=='.'&&x!=='..');const b=button(name,()=>hooks.openSource(source.id),'wiki-tree-file');b.dataset.userContent='';b.title=name;b.dataset.wikiTreeSource=source.id;folder(source.wikiVaultPath?source.wikiVaultPath.split('/').slice(0,-1):['sources','files',...parts]).append(b);
 }
 if(!tree.children.length)tree.append(el('p','wiki-empty',t('暂无匹配资料','No matching documents')));
}
// New-entry creation is a single acknowledged transaction. The reader owns edits.
async function createEntryDurably(h,draft){
 const state=h.getState(),title=String(draft.title||'').trim(),pid=draft.projectId||null;
 if(draft.pendingNoteId)throw Object.assign(Error(t('上次创建的条目已被更新，请打开已有条目继续编辑。','The previous entry has changed. Open it to continue editing.')),{retainedNoteId:draft.pendingNoteId});
 if([...W.entries(state,{projectId:pid}),...(state.notes||[]).filter(note=>W.active(note)&&(note.projectId||null)===pid&&note.workspace==='科研')].some(note=>String(note.title||'').trim().toLocaleLowerCase()===title.toLocaleLowerCase()))throw Error(t('此范围已有同名条目，请使用不同标题，或打开已有条目编辑。','An entry with this title already exists in this scope. Choose another title or edit the existing entry.'));
 const sections=Object.fromEntries(Object.keys(W.fields(draft.type)).map(key=>[key,draft.sections[key]||'']));
 const note=h.create({wikiType:draft.type,title:draft.title,sections,projectId:pid}),created=JSON.stringify(note);
 const savedDraft=state.ui.wikiDraft;
 delete state.ui.wikiDraft;
 try{if(await h.persist()===false)throw Error(t('保存未得到确认，请重试。','The save was not acknowledged. Please retry.'));return note;}
 catch(error){
  const current=h.getState(),record=(current.notes||[]).find(item=>item.id===note.id);
  if(record&&JSON.stringify(record)===created)current.notes.splice(current.notes.indexOf(record),1);
  const retained=record&&JSON.stringify(record)!==created?note.id:null;
  if(!current.ui.wikiDraft)current.ui.wikiDraft={...(savedDraft||draft),sections:{...draft.sections},...(retained?{pendingNoteId:retained}:{})};
  try{h.save();}catch(_){} // Queue the rollback and retained draft; preserve the original error.
  if(retained)throw Object.assign(Error(t('保存未确认，且条目已被其他操作更新。已保留记录，请打开已有条目继续。','The save was not acknowledged and another operation changed the entry. The record was preserved; open it to continue.')),{retainedNoteId:retained});
  throw error;
 }
}
function composerProps(){
 const session=composerSession,draft=session.draft,state=hooks.getState(),projects=(state.projects||[]).filter(p=>W.active(p)&&p.workspace==='科研');
 const unavailable=draft.projectId&&!projects.some(p=>p.id===draft.projectId);
 return {draft,busy:session.saving,error:session.error,savedId:session.savedId,
  types:Object.entries(W.TYPES).map(([value,kind])=>({value,label:t(kind.zh,kind.en)})),
  scopes:[{value:'',label:t('独立科研条目','Unassigned research')},...projects.map(p=>({value:p.id,label:p.name})),...(unavailable?[{value:draft.projectId,label:t('原项目已不可用，请重新选择','Previous project unavailable — choose another'),disabled:true}]:[])],
  fields:Object.entries(W.fields(draft.type)).map(([key,label])=>({key,label:t(label,FIELD_LABELS[key]||label),common:Object.hasOwn(W.COMMON,key)})),
  onChange:patch=>{if(session.saving||session.savedId||draft.pendingNoteId)return;session.draft={...session.draft,...patch};stashComposer();renderComposer();},
  onSave:saveComposer,onClose:()=>{if(!session.saving)dialog.close();},onOpen:openComposedEntry};
}
function stashComposer(){hooks.getState().ui.wikiDraft={...composerSession.draft,sections:{...composerSession.draft.sections}};try{hooks.save();}catch(error){composerSession.error=error?.message||String(error);}}
function renderComposer(){
 if(!composerIsland||!composerSession)return;
 dialog.setAttribute('aria-label',t('新建科研 Wiki 条目','New research Wiki entry'));composerIsland.update(composerProps());
}
function compose(){
 if(dialog?.open)return;
 composerIsland?.unmount();dialog?.remove();
 const draft=hooks.getState().ui.wikiDraft||{type:filter||'experiment',projectId:projectId||null,title:'',sections:{}};
 composerSession={draft:{...draft,type:W.TYPES[draft.type]?draft.type:'experiment',projectId:draft.projectId||null,title:draft.title||'',sections:{...(draft.sections||{})}},saving:false,error:'',savedId:null,opener:document.activeElement};
 dialog=el('dialog','wiki-dialog wiki-compose-dialog');dialog.setAttribute('aria-label',t('新建科研 Wiki 条目','New research Wiki entry'));dialog.setAttribute('aria-describedby','wikiComposeDescription');
 const content=el('div','wiki-compose-root');dialog.append(content);document.body.append(dialog);
 composerIsland=root.HalaskaUI.mount(content,'ResearchWikiComposer',composerProps());
 dialog.addEventListener('cancel',event=>{if(composerSession.saving)event.preventDefault();});
 dialog.addEventListener('close',()=>{const session=composerSession;if(!session||session.opening)return;const active=document.activeElement;if(active===document.body||dialog.contains(active)){const target=session.opener?.isConnected?session.opener:document.querySelector('[data-wiki-action="new"]');if(target?.getClientRects().length)target.focus({preventScroll:true});}});
 dialog.showModal();dialog.querySelector('.wiki-title')?.focus();
}
async function openComposedEntry(){
 const session=composerSession,id=session.savedId||session.draft.pendingNoteId;if(!id||session.saving)return;
 session.saving=true;session.opening=true;session.error='';renderComposer();dialog.close();
 try{if(!W.entries(hooks.getState()).some(note=>note.id===id))throw Error(t('条目已归档、删除或暂不可用。','The entry is archived, removed, or currently unavailable.'));if(await hooks.open(id)===false)throw Error(t('阅读窗口尚未打开，可重试打开。','The reader did not open. Try opening it again.'));}
 catch(error){session.error=t('条目已保留。','The entry is preserved. ')+(error?.message||String(error));dialog.showModal();}
 finally{session.saving=false;session.opening=false;if(dialog.open){renderComposer();dialog.querySelector('[data-wiki-compose-action="open"]')?.focus();}}
}
async function saveComposer(){
 const session=composerSession;if(!session||session.saving||session.savedId||session.draft.pendingNoteId)return;
 session.saving=true;session.error='';stashComposer();renderComposer();
 try{
  const note=await createEntryDurably(hooks,session.draft);session.savedId=note.id;render();
 }catch(error){session.error=error?.message||String(error);if(error?.retainedNoteId)session.draft.pendingNoteId=error.retainedNoteId;}
 finally{session.saving=false;renderComposer();}
 if(session.savedId)await openComposedEntry();else dialog.querySelector('[data-wiki-save]')?.focus({preventScroll:true});
}
root.ResearchWikiUI={init,render,compose,cardExcerpt,cardView,createEntryDurably};
})(globalThis);
