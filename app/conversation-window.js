/* Viewport-owned transcript content. The model is never sliced or persisted.
 * Lightweight, measured slots retain IDs/order; forms, focus and selections
 * retain their actual DOM. Complete reading is an explicit accessible escape. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ConversationWindow=api;})(globalThis,root=>{
 'use strict';
 const controllers=new WeakMap(),THRESHOLD=60,OVERSCAN=900;
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 const abort=()=>new DOMException('Search superseded','AbortError');
 function dispose(node){
  if(!node)return;
  root.CitationEvidence?.discard?.(node);
  root.AnswerFeedback?.unmount?.(node);
  node.querySelectorAll('.plan-review-host').forEach(host=>root.PlanReview?.dispose(host));
  const hosts=[...(node.matches?.('[data-halaska-root]')?[node]:[]),...node.querySelectorAll('[data-halaska-root]')];
  hosts.forEach(host=>root.HalaskaUI?.unmount(host));
 }
 function texts(node){
  const out=[],doc=node.ownerDocument,walker=doc.createTreeWalker(node,4,{acceptNode(value){return !value.nodeValue?.trim()||value.parentElement?.closest('script,style,input,textarea,select')?2:1;}});
  let value;while((value=walker.nextNode())){const path=[];let child=value;while(child!==node){path.unshift([...child.parentNode.childNodes].indexOf(child));child=child.parentNode;}out.push({path,text:value.nodeValue});}return out;
 }
 function estimate(message,width=760){
  const chars=Math.max(24,Math.floor(width/12)),lines=String(message.text||'').split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/chars)),0);
  return Math.max(90,Math.min(2600,lines*24+(message.role==='user'?80:200)));
 }
 function create(list){
  const doc=list.ownerDocument,win=doc.defaultView||root;
  let id='',rows=[],byId=new Map(),render=null,shouldPin=()=>false,full=false,loading=false,frame=0,revision=0,searchVersion=0,epoch=0,busy=false,disposed=false;
  let requested=new Set(),control=null,controlSignature='',lastWidth=list.clientWidth,contextVersion;
  // Callers may opt in with complete immutable render-dependency snapshots.
  // Mutable objects, missing tokens or failed snapshots stay conservative; an
  // unchanged object reference is never evidence that its content is unchanged.
  const versionValid=value=>typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value));
  const searchCache=new Map(),INDEX_BUDGET=2*1024*1024;let indexSize=0;
  function forgetIndex(key){const value=searchCache.get(key);if(value){indexSize-=value.size;searchCache.delete(key);}}
  function cacheIndex(key,index){forgetIndex(key);const size=index.reduce((total,part)=>total+part.text.length+part.path.length*8,0);if(size>INDEX_BUDGET)return;while(indexSize+size>INDEX_BUDGET&&searchCache.size)forgetIndex(searchCache.keys().next().value);searchCache.set(key,{index,size});indexSize+=size;}
  const on=(target,type,fn,options)=>{target.addEventListener(type,fn,options);off.push(()=>target.removeEventListener(type,fn,options));},off=[];
  const contentChanged=(kind='content')=>list.dispatchEvent(new win.CustomEvent('conversation-window-content',{detail:{kind}}));
  const windowed=()=>rows.length>THRESHOLD&&(!full||loading);
  const yieldFrame=()=>new Promise(resolve=>win.setTimeout(resolve,0));
  function placeholder(row){
   const node=doc.createElement('div');node.className='message-wrap message-window-placeholder';node.dataset.messageId=row.id;node.dataset.windowPlaceholder='';
   node.setAttribute('aria-hidden','true');node.style.height=`${row.height??estimate(row.message,lastWidth)}px`;
   node.style.marginTop=`${row.marginTop??8}px`;node.style.marginBottom=`${row.marginBottom??28}px`;return node;
  }
  function nodeFor(row){return [...list.children].find(node=>node.dataset.messageId===row.id)||null;}
  function currentNode(row){return row.node?.parentElement===list?row.node:null;}
  function interactionPinned(row,refresh=false){
   const node=currentNode(row);if(!node||node.dataset.windowPlaceholder!==undefined)return false;
   if(node.querySelector('.message-edit,.retry-attachment-editor'))return true;
   if(node.contains(doc.activeElement)&&(!refresh||doc.activeElement.matches('input,textarea,select,[contenteditable="true"]')))return true;
   if([...node.querySelectorAll('audio,video')].some(media=>!media.paused&&!media.ended))return true;
   const selection=doc.getSelection();
   // Preserve all mounted content during a drag/cross-message selection. Range
   // endpoints alone miss the rows between them and corrupt copying.
   if(selection&&!selection.isCollapsed&&(list.contains(selection.anchorNode)||list.contains(selection.focusNode)))return true;
   return false;
  }
  function measure(row){const node=currentNode(row);if(!node||node.dataset.windowPlaceholder!==undefined)return;const style=win.getComputedStyle(node);row.height=node.getBoundingClientRect().height;row.marginTop=parseFloat(style.marginTop)||0;row.marginBottom=parseFloat(style.marginBottom)||0;}
  function saveDisclosure(row){row.disclosures=[...row.node.querySelectorAll('details')].map(node=>node.open);}
  function saveMedia(row,node){row.media=[...node.querySelectorAll('audio,video')].map(media=>({src:media.getAttribute('src'),time:media.currentTime,volume:media.volume,muted:media.muted,rate:media.playbackRate}));}
  function restoreMedia(row,node){[...node.querySelectorAll('audio,video')].forEach((media,i)=>{const saved=row.media?.[i];if(!saved||saved.src!==media.getAttribute('src'))return;media.volume=saved.volume;media.muted=saved.muted;media.playbackRate=saved.rate;const seek=()=>{try{if(Number.isFinite(saved.time))media.currentTime=saved.time;}catch{}};if(media.readyState)seek();else media.addEventListener('loadedmetadata',seek,{once:true});});}
  function mount(row,refresh=false){
   const previous=currentNode(row),real=previous&&previous.dataset.windowPlaceholder===undefined;
   if(real&&(!refresh||interactionPinned(row,true)))return previous;
   // `previous` is reserved for AgentProgress.patchLive: it stages deferred
   // React roots. This owner replaces a settled row, so build complete roots.
   const holder=doc.createElement('div');render(row.message,holder,{});const next=holder.firstElementChild;
   if(!next)return previous;
   if(!refresh&&row.disclosures)[...next.querySelectorAll('details')].forEach((node,i)=>{if(row.disclosures[i]!==undefined)node.open=row.disclosures[i];});
   const focus=real&&previous.contains(doc.activeElement)?doc.activeElement:null;
   const focusKey=focus?{tag:focus.tagName,id:focus.id,label:focus.getAttribute('aria-label')||focus.textContent,fields:{...focus.dataset}}:null;
   if(real)saveMedia(row,previous);
   if(previous){resize?.unobserve(previous);dispose(previous);previous.replaceWith(next);}else list.append(next);
   next._messageAttached?.();
   restoreMedia(row,next);
   if(focusKey&&!focus.isConnected){const candidates=[...next.querySelectorAll('button,a,input,textarea,select,summary,[tabindex]')];const match=candidates.find(node=>node.tagName===focusKey.tag&&(focusKey.id?node.id===focusKey.id:(node.getAttribute('aria-label')||node.textContent)===focusKey.label)&&Object.entries(focusKey.fields).every(([key,value])=>node.dataset[key]===value));if(match)match.focus({preventScroll:true});else {next.tabIndex=-1;next.focus({preventScroll:true});}}
   row.node=next;row.dirty=false;resize?.observe(next);return next;
  }
  function evict(row){
   const previous=currentNode(row);if(!previous||previous.dataset.windowPlaceholder!==undefined)return;
   measure(row);saveDisclosure(row);saveMedia(row,previous);const next=placeholder(row);resize?.unobserve(previous);dispose(previous);previous.replaceWith(next);row.node=next;
  }
  function transact(fn){
   if(busy)return fn();busy=true;
   const reading=root.ConversationReading?.beforeRender(list,id),box=list.getBoundingClientRect();
   const anchor=rows.find(row=>currentNode(row)?.getBoundingClientRect().bottom>box.top+3);
   const offset=anchor?.node?.getBoundingClientRect().top;
   const following=root.ConversationReading?.inspect(list)?.following;
   try{fn();
    // Correct geometry even during wheel/drag input, when the reading controller
    // deliberately suspends its own restoration. Never animate this correction.
    if(following)list.scrollTo({top:list.scrollHeight,behavior:'instant'});
    else if(anchor?.node?.isConnected&&offset!==undefined){const delta=anchor.node.getBoundingClientRect().top-offset;if(Math.abs(delta)>.5)list.scrollTo({top:list.scrollTop+delta,behavior:'instant'});}
   }finally{mutation?.takeRecords();busy=false;if(reading)root.ConversationReading.afterRender(list,reading);}
  }
  function updateControl(){
   if(!control){control=doc.createElement('div');control.className='conversation-reading-mode';control.id='conversationReadingMode';list.before(control);}
   control.hidden=rows.length<=THRESHOLD;
   if(control.hidden)return;
   const signature=[rows.length,full,loading].join(':');if(signature===controlSignature)return;controlSignature=signature;
   root.HalaskaUI?.mount(control,'ConversationReadingMode',{count:rows.length,full,loading,onToggle:()=>setFull(!full)});
  }
  function update(){
   frame=0;if(disposed||busy||!list.clientHeight||!rows.length)return;
   const box=list.getBoundingClientRect(),desired=new Set(requested);requested.clear();
   if(!windowed())rows.forEach(row=>desired.add(row.id));
   else if(loading)rows.forEach(row=>{if(currentNode(row)?.dataset.windowPlaceholder===undefined)desired.add(row.id);});
   else {
    // All shells are cheap and keep stable order/height; expensive message DOM
    // and React roots are limited to the viewport, overscan and active controls.
    rows.forEach((row,i)=>{const rect=currentNode(row)?.getBoundingClientRect();if(rect&&rect.bottom>=box.top-OVERSCAN&&rect.top<=box.bottom+OVERSCAN)for(let n=Math.max(0,i-1);n<=Math.min(rows.length-1,i+1);n++)desired.add(rows[n].id);});
    rows.forEach(row=>{if(row.message.live||shouldPin(row.message)||interactionPinned(row))desired.add(row.id);});
   }
   transact(()=>{for(const row of rows){if(desired.has(row.id))mount(row,row.dirty);else evict(row);}});
   rows.forEach(measure);updateControl();
  }
  function schedule(){if(!frame&&!disposed)frame=win.requestAnimationFrame(update);}
  const resize=win.ResizeObserver?new win.ResizeObserver(()=>{if(list.clientWidth!==lastWidth){lastWidth=list.clientWidth;rows.forEach(row=>{if(row.node?.dataset.windowPlaceholder!==undefined){row.height=null;row.node.style.height=`${estimate(row.message,lastWidth)}px`;}});}schedule();}):null;
  resize?.observe(list);
  function set(options){
   const changed=id!==options.id,wasLoading=loading,widthChanged=lastWidth!==list.clientWidth,versioned=typeof options.rowVersion==='function'&&versionValid(options.contextVersion);
   const contextChanged=changed||!versioned||!Object.is(contextVersion,options.contextVersion);
   render=options.render;shouldPin=options.pin||(()=>false);lastWidth=list.clientWidth;
   if(contextChanged){searchCache.clear();indexSize=0;controlSignature='';}
   contextVersion=versioned?options.contextVersion:undefined;
   if(changed){rows.forEach(row=>{dispose(currentNode(row));resize?.unobserve(row.node);});list.replaceChildren();rows=[];byId.clear();id=options.id;full=false;loading=false;controlSignature='';requested.clear();}
   const old=byId,previousRows=rows;let contentUpdated=contextChanged;byId=new Map();
   rows=(options.messages||[]).filter(message=>!message.deletedAt).map((message,at)=>{
    const previous=old.get(message.id),row=previous||{id:message.id,node:null};let version;
    if(versioned){try{version=options.rowVersion(message);}catch{/* A failed snapshot must not leave stale content mounted. */}}
    const invalid=contextChanged||!previous||!versionValid(version)||!Object.is(row.version,version);
    if(invalid){row.dirty=true;forgetIndex(row.id);contentUpdated=true;}
    if(previousRows[at]?.id!==row.id)contentUpdated=true;
    row.message=message;row.version=versionValid(version)?version:undefined;byId.set(row.id,row);return row;
   });
   for(const [key,row] of old)if(!byId.has(key)){forgetIndex(key);dispose(currentNode(row));resize?.unobserve(row.node);row.node?.remove();contentUpdated=true;}
   if(contentUpdated){revision++;searchVersion++;epoch++;}
   // Insert only missing/moved slots. Moving all existing nodes through a
   // fragment would blur textareas and destroy the user's live selection.
   if(changed){const fragment=doc.createDocumentFragment();for(const row of rows){row.node=placeholder(row);fragment.append(row.node);}list.append(fragment);}
   else {let cursor=list.firstElementChild;for(const row of rows){let node=currentNode(row);if(!node)row.node=node=placeholder(row);if(node!==cursor)list.insertBefore(node,cursor);cursor=node.nextElementSibling;}}
   const intent=root.ConversationReading?.inspect(list),anchor=byId.get(intent?.anchor?.messageId);
   if(changed){const at=anchor?rows.indexOf(anchor):Math.max(0,rows.length-8);for(let i=Math.max(0,at-3);i<Math.min(rows.length,at+8);i++)requested.add(rows[i].id);}
   // A settled no-op does not need a second geometry pass. Scroll/focus/resize
   // events retain their own scheduled frame; dirty offscreen placeholders are
   // refreshed when they actually enter the viewport, not on every host tick.
   const needsUpdate=contentUpdated||widthChanged||requested.size>0||rows.some(row=>row.dirty&&currentNode(row)?.dataset.windowPlaceholder===undefined);
   if(needsUpdate&&(rows.length<=THRESHOLD||(full&&!loading)))rows.forEach(row=>requested.add(row.id));
   // On initial entry geometry still refers to the previous conversation.
   if(changed)transact(()=>{for(const row of rows)if(requested.has(row.id)||row.message.live||shouldPin(row.message))mount(row);});
   else if(needsUpdate)update();
   updateControl();if(needsUpdate)schedule();if(contentUpdated)contentChanged();if(wasLoading&&!changed&&contentUpdated)void setFull(true);return api;
  }
  function ensure(key){
   const row=byId.get(String(key));if(!row)return null;
   requested.add(row.id);let node;transact(()=>{node=mount(row,row.dirty);});schedule();return node;
  }
  function changed(key,message){let row=byId.get(key);if(!row&&message&&!message.deletedAt){row={id:key,message,node:null};rows.push(row);byId.set(key,row);searchVersion++;}if(row){const previous=row.node;row.node=nodeFor(row);if(message)row.message=message;if(previous!==row.node){if(previous)resize?.unobserve(previous);if(row.node)resize?.observe(row.node);}row.dirty=false;row.version=undefined;forgetIndex(key);}mutation?.takeRecords();revision++;updateControl();contentChanged('stream');schedule();}
  async function setFull(value){
   full=!!value;const ticket=++epoch;loading=full;updateControl();
   if(!full){loading=false;schedule();updateControl();contentChanged();return;}
   // Frame-sized batches keep the cancel/mode control and input responsive.
   for(let i=0;i<rows.length;i+=8){if(ticket!==epoch||disposed)return;transact(()=>{rows.slice(i,i+8).forEach(row=>mount(row,row.dirty));});await yieldFrame();}
   if(ticket===epoch){loading=false;updateControl();contentChanged();}
  }
  async function searchRows(query,{signal,onProgress}={}){
   const ticket=searchVersion,owner=id,hits=[],needle=String(query).toLowerCase();let capped=false;
   if(!needle)return {hits,capped,total:rows.length};
   const snapshot=rows.slice(),scratch=doc.createElement('div');scratch.className='conversation-search-scratch';scratch.inert=true;scratch.setAttribute('aria-hidden','true');scratch.style.width=`${list.clientWidth}px`;doc.body.append(scratch);
   const valid=()=>{if(signal?.aborted||disposed||ticket!==searchVersion||owner!==id)throw abort();};
   try{for(let i=0;i<snapshot.length;i++){
    valid();const row=snapshot[i];let index=searchCache.get(row.id)?.index;
    if(!index){
     const mounted=currentNode(row),real=mounted&&mounted.dataset.windowPlaceholder===undefined;
     if(real&&!row.dirty&&!mounted.querySelector('.safe-preview,[data-citation-deferred]'))index=texts(mounted);
     else {render(row.message,scratch,{search:true});await Promise.resolve();valid();index=texts(scratch.firstElementChild);dispose(scratch);scratch.replaceChildren();}
     cacheIndex(row.id,index);
    }
    for(const part of index){const haystack=part.text.toLowerCase();let start=0;while((start=haystack.indexOf(needle,start))>=0){if(hits.length===800){capped=true;break;}hits.push({messageId:row.id,path:part.path,start,end:start+needle.length,text:part.text});start+=needle.length;}if(capped)break;}
    if(capped)break;
    if(i%8===7){onProgress?.({done:i+1,total:snapshot.length});await yieldFrame();}
   }valid();return {hits,capped,total:snapshot.length};}finally{dispose(scratch);scratch.remove();}
  }
  function ensureHit(hit){
   const message=ensure(hit.messageId);if(!message)return null;
   message.querySelector('[data-preview-action="expand"]')?.click();
   const find=()=>{
    let node=message;for(const at of hit.path||[])node=node?.childNodes[at];
    if(node?.nodeType===3&&node.nodeValue===hit.text)return node;
    const walker=doc.createTreeWalker(message,4);node=null;let next;
    while((next=walker.nextNode()))if(next.nodeValue===hit.text){if(node)return null;node=next;}return node;
   };
   let node=find();
   // A full-history search can include source text that the ordinary collapsed
   // row has not materialized. Only an explicit hit reveal opens that panel.
   if(!node&&message.querySelector('[data-citation-deferred]')){root.CitationEvidence?.materializeForSearch?.(message);node=find();}
   return node&&Number.isInteger(hit.start)&&Number.isInteger(hit.end)&&hit.start>=0&&hit.end>hit.start&&hit.end<=node.length?{node,start:hit.start,end:hit.end}:null;
  }
  on(list,'scroll',schedule,{passive:true});on(doc,'selectionchange',schedule);on(list,'focusin',schedule);on(list,'focusout',schedule);
  for(const event of ['play','pause','ended'])on(list,event,schedule,true);
  on(list,'keydown',event=>{if(event.key!=='Tab'||event.altKey||event.metaKey||event.ctrlKey)return;const key=event.target.closest?.('[data-message-id]')?.dataset.messageId;const at=rows.findIndex(row=>row.id===key);if(at<0)return;const next=rows[at+(event.shiftKey?-1:1)];if(next)ensure(next.id);});
  const mutation=win.MutationObserver?new win.MutationObserver(records=>{
   let edited=false;
   for(const record of records){if(record.target===list)continue;const element=record.target.nodeType===1?record.target:record.target.parentElement;const row=element?.closest?.('[data-message-id]');if(row&&row.parentElement===list&&!row.hasAttribute('data-window-placeholder')){forgetIndex(row.dataset.messageId);edited=true;}}
   if(edited){revision++;searchVersion++;contentChanged();}schedule();
  }):null;mutation?.observe(list,{childList:true,subtree:true,characterData:true});
  on(doc,'workstation-language-change',()=>{searchCache.clear();indexSize=0;revision++;searchVersion++;contentChanged();});
  const api={set,ensure,ensureHit,searchRows,changed,setFull,entries:()=>rows.map(row=>row.message),isWindowed:windowed,
   inspect:()=>({id,total:rows.length,mounted:rows.filter(row=>currentNode(row)?.dataset.windowPlaceholder===undefined).length,windowed:windowed(),full,loading,revision,indexCharacters:indexSize}),
   destroy(){disposed=true;epoch++;revision++;win.cancelAnimationFrame(frame);resize?.disconnect();mutation?.disconnect();off.forEach(fn=>fn());rows.forEach(row=>dispose(currentNode(row)));dispose(control);control?.remove();controllers.delete(list);}
  };return api;
 }
 return {render(list,options){let controller=controllers.get(list);if(!controller){controller=create(list);controllers.set(list,controller);}return controller.set(options);},active:list=>controllers.get(list)||null,destroy:list=>controllers.get(list)?.destroy(),_pure:{estimate,THRESHOLD}};
});
