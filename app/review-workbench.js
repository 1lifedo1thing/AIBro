/* Shared snapshot reader for library changes and local file proposals. No writes here. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ReviewWorkbench=api;})(globalThis,root=>{
 'use strict';
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 const sessions=new Map(),cleanups=new WeakMap(),handles=new WeakMap();let sequence=0;
 const kit=()=>root.HalaskaUI?.componentNames?.includes('ReviewHeading');
 const mount=(host,name,props)=>root.HalaskaUI.mount(host,name,props);
 const el=(tag,cls,text)=>{const n=root.document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
 const button=(label,fn,cls='review-control')=>{const n=el('button',cls,label);n.type='button';n.onclick=fn;return n;};
 function session(key){if(!sessions.has(key)){if(sessions.size>=32)sessions.delete(sessions.keys().next().value);sessions.set(key,{mode:'diff',split:false,folders:new Map(),documents:new Map()});}return sessions.get(key);}
 function dispose(host){const cleanup=host&&cleanups.get(host);if(cleanup){cleanups.delete(host);cleanup();}if(host)handles.delete(host);}
 // Presentation identity only; never used to authorize writes or file versions.
 function snapshotKey(path,before,after){let hash=2166136261;for(const text of [path,before,after]){for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);hash=Math.imul(hash^0,16777619);}return `${before.length}:${after.length}:${hash>>>0}`;}
 function stats(rows){return {added:rows.filter(r=>r.type==='add').length,removed:rows.filter(r=>r.type==='remove').length};}
 function contextRows(rows,context=3){
  const keep=new Set();rows.forEach((r,i)=>{if(r.type!=='same')for(let k=Math.max(0,i-context);k<=Math.min(rows.length-1,i+context);k++)keep.add(k);});
  const result=[];let hidden=[];
  const flush=()=>{if(hidden.length){result.push({type:'gap',rows:hidden});hidden=[];}};
  rows.forEach((row,i)=>{if(keep.has(i)){flush();result.push(row);}else hidden.push(row);});flush();return result;
 }
 function pairedRows(rows){
  const result=[];let removed=[],added=[];
  const flush=()=>{for(let i=0;i<Math.max(removed.length,added.length);i++)result.push({left:removed[i]||null,right:added[i]||null});removed=[];added=[];};
  for(const row of rows){if(row.type==='remove')removed.push(row);else if(row.type==='add')added.push(row);else{flush();result.push(row.type==='gap'?row:{left:row,right:row});}}flush();return result;
 }
 function counters(added,removed){const n=el('span','review-stats');if(Number.isFinite(added))n.append(el('span','review-added',`+${added}`));if(Number.isFinite(removed))n.append(el('span','review-removed',`−${removed}`));return n;}
 function create(container,{key,files,selectedId,onSelect,bookmark}){
  dispose(container);
  const state=session(key);if(files.some(f=>f.id===selectedId))state.selectedId=selectedId;
  if(bookmark?.review){const saved=bookmark.review;if(!files.some(f=>f.id===selectedId)&&files.some(f=>f.id===saved.selectedId))state.selectedId=saved.selectedId;for(const file of files){const view=saved.documents?.find(item=>item.id===file.id);if(view&&!state.documents.has(file.id))state.documents.set(file.id,{...view,positions:{...(view.positions||{})}});}}
  container.replaceChildren();const layout=el('section','file-review review-workbench'),head=el('div','review-overview');
  head.append(el('span','review-overview-label',t('本轮变更','Changes this turn')),el('span','review-file-count',`${files.length} ${t('个文件','files')}`));
  const known=files.every(f=>Number.isFinite(f.added)&&Number.isFinite(f.removed));if(known)head.append(counters(files.reduce((n,f)=>n+f.added,0),files.reduce((n,f)=>n+f.removed,0)));
  if(kit()){head.replaceChildren();const summary=el('div','review-summary-island');head.append(summary);mount(summary,'ReviewSummary',{count:files.length,...(known?{added:files.reduce((n,f)=>n+f.added,0),removed:files.reduce((n,f)=>n+f.removed,0)}:{})});}
  const tree=el('nav','file-review-tree');tree.setAttribute('aria-label',t('本轮修改文件','Changed files'));
  const search=el('input','review-search');search.type='search';search.placeholder=t('查找文件…','Find a file…');search.setAttribute('aria-label',t('筛选本轮文件','Filter changed files'));
  const branches=el('div','review-tree-branches'),empty=el('div','review-empty',t('没有匹配的文件','No matching files'));empty.hidden=true;tree.append(search,branches,empty);
  if(kit()){empty.replaceChildren();mount(empty,'ReviewEmptyState',{title:t('没有匹配的文件','No matching files'),description:t('试试文件名或目录名。','Try a filename or folder name.'),onClear:()=>{search.value='';search.oninput();search.focus();}});}
  const viewer=el('div','file-review-viewer');viewer.setAttribute('aria-label',t('文件内容','File content'));
  const treeToggle=button(t('文件','Files'),()=>{state.treeOpen=!state.treeOpen;fit();if(state.treeOpen)search.focus();},'review-files-toggle');treeToggle.hidden=true;treeToggle.setAttribute('aria-expanded','false');tree.id=`review-files-${++sequence}`;treeToggle.setAttribute('aria-controls',tree.id);head.append(treeToggle);
  layout.append(head,tree,viewer);
  let compact=false,observed=false;
  function fit(){
   const width=layout.getBoundingClientRect().width;if(!width)return;
   layout.style.setProperty('--review-header-height',`${head.getBoundingClientRect().height}px`);
   const next=width<760;if(next&&!compact&&tree.contains(root.document.activeElement))state.treeOpen=true;
   compact=next;layout.classList.toggle('review-compact',compact);treeToggle.hidden=!compact;
   tree.hidden=compact&&!state.treeOpen;treeToggle.setAttribute('aria-expanded',String(!tree.hidden));
  }
  tree.addEventListener('keydown',event=>{if(event.key==='Escape'&&compact&&!tree.hidden){event.preventDefault();event.stopPropagation();state.treeOpen=false;fit();treeToggle.focus();}});
  const controls=new Map(),folders=[],searchIndex=[];const rootFolder={dirs:new Map(),files:[]};let selectedButton=null;
  for(const file of files){const parts=String(file.path||file.id).split('/').filter(Boolean);let node=rootFolder;for(const part of parts.slice(0,-1)){if(!node.dirs.has(part))node.dirs.set(part,{dirs:new Map(),files:[]});node=node.dirs.get(part);}node.files.push(file);}
  function select(file){const previous=state.documents.get(state.selectedId);dispose(viewer);state.selectedId=file.id;selectedButton?.setAttribute('aria-pressed','false');const b=controls.get(file.id);b?.setAttribute('aria-pressed','true');selectedButton=b;for(let n=b?.parentElement;n&&n!==tree;n=n.parentElement)if(n.tagName==='DETAILS')n.open=true;treeToggle.textContent=t('文件 · ','Files · ')+(file.path||file.id).split('/').pop();treeToggle.title=file.path||file.id;
   if(compact&&state.treeOpen){const focused=tree.contains(root.document.activeElement);state.treeOpen=false;fit();if(focused)treeToggle.focus();}
   if(!state.documents.has(file.id))state.documents.set(file.id,{mode:'diff',split:previous?.split||false,wrap:previous?.wrap!==false});
   return onSelect(file,viewer,state.documents.get(file.id));}
  function draw(node,parent,path='',ancestors=[]){
   for(const [name,folder]of [...node.dirs].sort((a,b)=>a[0].localeCompare(b[0]))){
    const full=path?path+'/'+name:name,details=el('details','review-folder'),summary=el('summary');details.open=state.folders.get(full)!==false;
    summary.append(el('span','review-folder-icon'),el('span','',name));summary.addEventListener('click',()=>state.folders.set(full,!details.open));details.append(summary);parent.append(details);const entry={element:details,path:full,matched:false};folders.push(entry);draw(folder,details,full,[...ancestors,entry]);
   }
   for(const file of node.files.sort((a,b)=>a.path.localeCompare(b.path))){const b=button('',()=>select(file),'file-review-file');b.dataset.reviewFile=file.id;b.title=file.path;b.setAttribute('aria-pressed','false');b.append(el('span','review-file-icon'),el('span','review-file-name',file.path.split('/').pop()),counters(file.added,file.removed));if(file.status){const mark=el('span','review-file-status',file.status);b.append(mark);}controls.set(file.id,b);searchIndex.push({button:b,path:file.path.toLocaleLowerCase(),ancestors});parent.append(b);}
  }
  draw(rootFolder,branches);container.append(layout);
  // Filtering uses the known hierarchy rather than querying every ancestor's
  // entire DOM subtree on each keystroke. All files remain present and searchable.
  search.oninput=()=>{const q=search.value.trim().toLocaleLowerCase();let matches=0;for(const folder of folders)folder.matched=false;for(const entry of searchIndex){const match=entry.path.includes(q);if(entry.button.hidden===match)entry.button.hidden=!match;if(match){matches++;for(const ancestor of entry.ancestors)ancestor.matched=true;}}for(const folder of folders){const node=folder.element;if(node.hidden===folder.matched)node.hidden=!folder.matched;const open=q?folder.matched:state.folders.get(folder.path)!==false;if(node.open!==open)node.open=open;}empty.hidden=matches>0;};
  tree.addEventListener('keydown',event=>{if(event.target===search||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;const nodes=[...tree.querySelectorAll('summary,.file-review-file')].filter(n=>n.getClientRects().length);const index=nodes.indexOf(root.document.activeElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?nodes.length-1:Math.max(0,Math.min(nodes.length-1,index+(event.key==='ArrowDown'?1:-1)));nodes[next]?.focus();});
  function refresh(file){const b=controls.get(file.id);if(b&&file.status){let mark=b.querySelector('.review-file-status');if(!mark){mark=el('span','review-file-status');b.append(mark);}mark.textContent=file.status;}}
  const first=files.find(f=>f.id===state.selectedId)||files[0];if(first)select(first);else{const empty=el('div','review-empty');viewer.append(empty);if(kit())mount(empty,'ReviewEmptyState',{title:t('本轮没有文件变更','No file changes in this turn')});else empty.textContent=t('本轮没有文件变更','No file changes in this turn');}
  fit();
  const observer=typeof root.ResizeObserver==='function'?new root.ResizeObserver(()=>{if(!layout.isConnected&&observed){observer.disconnect();return;}observed=layout.isConnected;fit();}):null;
  observer?.observe(layout);cleanups.set(container,()=>{observer?.disconnect();dispose(viewer);});
  handles.set(container,{capture(){handles.get(viewer)?.capture();return {review:{selectedId:state.selectedId,documents:[...state.documents].map(([id,view])=>({id,mode:view.mode,split:!!view.split,wrap:view.wrap!==false,full:!!view.full,snapshot:view.snapshot,positions:view.positions,limits:view.limits,expandedGaps:view.expandedGaps,hunkLimit:view.hunkLimit}))}};}});
  return {layout,viewer,state,select,refresh,fit};
 }
 function documentView(host,{path,before='',after='',markdown,preview=false,notice='',actions=[],hunks=[],onHunk},state={mode:'diff',split:false}){
  dispose(host);
  before=String(before??'');after=String(after??'');
  const identity=snapshotKey(path,before,after);
  if(state.snapshot!==identity){state.positions={};state.limits=[];state.coverage=[];state.expandedGaps=[];state.hunkLimit=0;state.snapshot=identity;}
  state.positions ||= {};
  host.replaceChildren();const id=`review-document-${++sequence}`,heading=el('div','review-document-heading');
  const title=el('h3','',path.split('/').pop()),breadcrumb=el('p','review-breadcrumb',path);breadcrumb.title=path;heading.append(breadcrumb,title);host.append(heading);
  const rows=root.FileReview.diff(before,after),count=hunks.length?{added:hunks.reduce((n,h)=>n+h.newCount,0),removed:hunks.reduce((n,h)=>n+h.oldCount,0)}:stats(rows);heading.append(counters(count.added,count.removed));
  if(kit()){heading.replaceChildren();heading.classList.add('review-heading-island');mount(heading,'ReviewHeading',{path,added:count.added,removed:count.removed,notice});}
  else if(notice)host.append(el('p','review-notice',notice));
  const toolbar=el('div','review-toolbar'),tabs=el('div','review-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',t('文件视图','File view'));
  const content=el('div','file-review-content');content.id=id;content.setAttribute('role','tabpanel');content.setAttribute('data-user-content','');content.tabIndex=0;
  const readerSurface=host.closest?.('#previewDialog');let readerShown=!readerSurface?.hidden,readerResumePending=!readerShown;
  const options=[['diff','Diff'],['source',t('源码','Source')],...(preview?[['preview',t('预览','Preview')]]:[])];
  const controls=[],diffTools=el('div','review-diff-tools');
  let narrow=false,renderedSplit=false,renderedMode=null,pendingPosition,lastWidth=0,resizePosition,scrollFrame=null,horizontalFrame=null,horizontalOffset=0,horizontalMaximum=0,horizontalReady=false,horizontalDisposed=false;const expandedGaps=new Set(state.expandedGaps||[]),limits=new Map(state.limits||[]),coverage=new Map((state.coverage||[]).map(([key,values])=>[key,new Set(values)]));
  const split=button(t('并排','Split'),()=>toggle('split'));split.title=t('切换统一 / 并排差异','Switch unified / split diff');split.dataset.reviewSplit='';
  const context=button(t('完整内容','Full context'),()=>toggle('full'));context.dataset.reviewContext='';
  const wrap=button(t('自动换行','Wrap lines'),()=>toggle('wrap'));wrap.dataset.reviewWrap='';diffTools.append(split,context,wrap);
  options.forEach(([mode,label],index)=>{const b=button(label,()=>show(mode),'review-tab');b.dataset.mode=mode;b.id=id+'-'+mode;b.setAttribute('role','tab');b.setAttribute('aria-controls',id);b.onkeydown=event=>{let next;if(event.key==='ArrowRight')next=(index+1)%options.length;if(event.key==='ArrowLeft')next=(index+options.length-1)%options.length;if(event.key==='Home')next=0;if(event.key==='End')next=options.length-1;if(next!==undefined){event.preventDefault();show(options[next][0]);controls[next].focus();}};controls.push(b);tabs.append(b);});
  const useKit=kit();if(useKit){tabs.replaceChildren();tabs.className='review-mode-island';tabs.removeAttribute('role');diffTools.replaceChildren();}
  const horizontal=el('div','review-horizontal-scroll'),horizontalTrack=el('div','review-horizontal-track');
  horizontal.hidden=true;horizontal.tabIndex=0;horizontal.setAttribute('role','scrollbar');horizontal.setAttribute('aria-orientation','horizontal');horizontal.setAttribute('aria-controls',id);horizontal.setAttribute('aria-label',t('同步横向滚动修改前与修改后的代码','Scroll before and after code horizontally together'));horizontal.title=t('左右滚动代码；行号保持可见。方向键微调，Home / End 到首尾。','Scroll code while keeping line numbers visible. Use arrows, Home or End.');horizontalTrack.setAttribute('aria-hidden','true');horizontal.append(horizontalTrack);
  toolbar.append(tabs,diffTools,horizontal);host.append(toolbar,content);
  const footer=el('div','file-review-actions review-file-actions');host.append(footer);
  if(useKit&&actions.length){const island=el('div','review-actions-island');footer.append(island);mount(island,'ReviewActions',{actions});}else for(const action of actions)footer.append(action);
  function code(text){const node=el('code');const lang=path.split('.').pop();const highlighted=root.CodeHighlight?.highlight(text,lang);if(highlighted!==null&&highlighted!==undefined)node.innerHTML=highlighted;else node.textContent=text;return node;}
  const rowKey=row=>`${row.old??''}:${row.next??''}`;
  function single(row){const line=el('div','diff-line '+row.type);line.dataset.reviewRow=rowKey(row);line.append(el('span','diff-number',row.old??''),el('span','diff-number',row.next??''),el('span','diff-sign',row.type==='add'?'+':row.type==='remove'?'−':' '),code(row.text));return line;}
  function pair(row){const line=el('div','diff-pair');for(const [side,item]of [['left',row.left],['right',row.right]]){const half=el('div','diff-half '+(item?.type||'empty'));if(item)half.dataset.reviewRow=rowKey(item);const viewport=el('span','diff-code-viewport');viewport.append(code(item?.text||''));half.append(el('span','diff-number',item?(side==='left'?item.old:item.next):''),el('span','diff-sign',item?.type==='add'?'+':item?.type==='remove'?'−':' '),viewport);line.append(half);}return line;}
  function hasHorizontal(){return renderedMode==='diff'&&renderedSplit&&state.wrap===false;}
  function setHorizontal(value){
   horizontalOffset=Math.max(0,Math.min(horizontalReady?horizontalMaximum:Infinity,Number(value)||0));
   content.style.setProperty('--review-code-offset',`${-horizontalOffset}px`);
   if(horizontalReady&&Math.abs(horizontal.scrollLeft-horizontalOffset)>.1)horizontal.scrollLeft=horizontalOffset;
   horizontal.setAttribute('aria-valuenow',String(Math.round(horizontalOffset)));
   if(resizePosition)resizePosition={...resizePosition,left:horizontalOffset};
   if(state.positions.diff)state.positions.diff={...state.positions.diff,left:horizontalOffset};
  }
  function cancelHorizontal(){if(horizontalFrame!==null){root.cancelAnimationFrame(horizontalFrame);horizontalFrame=null;}}
  function scheduleHorizontal(){
   if(horizontalDisposed||!readerShown||readerResumePending||!hasHorizontal()||horizontalFrame!==null)return;
   horizontalFrame=root.requestAnimationFrame(()=>{
    horizontalFrame=null;if(horizontalDisposed||!readerShown||readerResumePending||!content.isConnected||!hasHorizontal()||!content.getBoundingClientRect().width)return;
    // Measure only after render, pagination, expansion or resize. Scrolling
    // changes one inherited offset; it never remeasures every row.
    const position=pendingPosition||resizePosition||readingPosition(),wasHidden=horizontal.hidden;
    horizontalMaximum=0;
    for(const viewport of content.querySelectorAll('.diff-code-viewport'))horizontalMaximum=Math.max(horizontalMaximum,(viewport.firstElementChild?.scrollWidth||0)-viewport.clientWidth);
    horizontalReady=true;horizontal.hidden=horizontalMaximum<=1;
    horizontalTrack.style.width=`calc(100% + ${horizontalMaximum}px)`;
    horizontal.setAttribute('aria-valuemin','0');horizontal.setAttribute('aria-valuemax',String(Math.ceil(horizontalMaximum)));
    setHorizontal(horizontalOffset);
    if(wasHidden!==horizontal.hidden){restorePosition({...position,left:horizontalOffset});resizePosition=readingPosition();}
   });
  }
  function horizontalScroll(){if(horizontalReady&&hasHorizontal())setHorizontal(horizontal.scrollLeft);}
  function horizontalKey(event){
   if(!hasHorizontal()||!['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key))return;
   event.preventDefault();event.stopPropagation();const step=event.shiftKey?120:40;
   const next=event.key==='Home'?0:event.key==='End'?horizontalMaximum:horizontalOffset+(event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:(event.key==='PageUp'?-1:1)*horizontal.clientWidth);
   setHorizontal(next);
  }
  function horizontalWheel(event){
   if(!hasHorizontal()||horizontal.hidden||!event.target.closest?.('.diff-code-viewport'))return;
   let amount=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.shiftKey?event.deltaY:0;
   if(!amount)return;if(event.deltaMode===1)amount*=16;else if(event.deltaMode===2)amount*=horizontal.clientWidth;
   const next=Math.max(0,Math.min(horizontalMaximum,horizontalOffset+amount));
   if(next!==horizontalOffset){event.preventDefault();setHorizontal(next);}
  }
  horizontal.addEventListener('scroll',horizontalScroll);horizontal.addEventListener('keydown',horizontalKey);content.addEventListener('wheel',horizontalWheel,{passive:false});
  function appendRows(table,data,paired,key){
   let shown=0;const seen=coverage.get(key)||new Set();coverage.set(key,seen);const identities=row=>row.type==='gap'?['gap:'+rowKey(row.rows[0])]:paired?[row.left,row.right].filter(Boolean).map(rowKey):[rowKey(row)];
   let initial=limits.get(key)||400;data.forEach((row,index)=>{if(identities(row).some(id=>seen.has(id)))initial=Math.max(initial,index+1);});
   const more=button(t('继续显示','Show more'),()=>append(400),'review-more');
   function append(count){const chunk=root.document.createDocumentFragment();
    for(const row of data.slice(shown,shown+count)){
     identities(row).forEach(id=>seen.add(id));
     if(row.type==='gap'){
      const gap=el('div','diff-gap'),gapKey='gap:'+rowKey(row.rows[0]);
      const reveal=()=>{expandedGaps.add(gapKey);const body=el('div','diff-expanded-context');appendRows(body,paired?pairedRows(row.rows):row.rows,paired,gapKey);gap.replaceWith(body);};
      gap.append(button(`${t('展开','Show')} ${row.rows.length} ${t('行未修改内容','unchanged lines')}`,reveal));chunk.append(gap);if(expandedGaps.has(gapKey))reveal();
     }else chunk.append(paired?pair(row):single(row));
    }
    table.insertBefore(chunk,more);shown=Math.min(data.length,shown+count);limits.set(key,shown);more.hidden=shown>=data.length;scheduleHorizontal();
   }
   table.append(more);append(initial);
  }
  function scroller(){let node=content;while(node.parentElement){if(/auto|scroll/.test(root.getComputedStyle?.(node)?.overflowY||'')&&node.scrollHeight>node.clientHeight+1)return node;node=node.parentElement;}return root.document.scrollingElement||node;}
  function readingTop(scroll){const top=Math.max(scroll.getBoundingClientRect().top,0),bar=toolbar.getBoundingClientRect();return bar.bottom>top&&bar.top<top+scroll.clientHeight?Math.max(top,bar.bottom):top;}
  function readingPosition(){
   const scroll=scroller(),top=readingTop(scroll),row=[...content.querySelectorAll('[data-review-row]')].find(n=>{const r=n.getBoundingClientRect();return r.bottom>top&&r.top<top+scroll.clientHeight;});
   return {top:scroll.scrollTop,left:hasHorizontal()?horizontalOffset:content.scrollLeft,key:row?.dataset.reviewRow,offset:row?row.getBoundingClientRect().top-top:0};
  }
  function remember(){const width=content.getBoundingClientRect().width;if(readerShown&&!readerResumePending&&renderedMode&&content.isConnected&&width&&!pendingPosition)state.positions[renderedMode]=lastWidth&&Math.abs(width-lastWidth)>.1&&resizePosition?resizePosition:readingPosition();state.expandedGaps=[...expandedGaps];state.limits=[...limits];state.coverage=[...coverage].map(([key,values])=>[key,[...values]]);}
  function restorePosition(saved){
   const scroll=scroller();if(!saved){scroll.scrollTop=0;content.scrollLeft=0;if(hasHorizontal())setHorizontal(0);return;}
   const nodes=[...content.querySelectorAll('[data-review-row]')],parts=saved.key?.split(':'),row=saved.key&&(nodes.find(n=>n.dataset.reviewRow===saved.key)||nodes.find(n=>{const p=n.dataset.reviewRow.split(':');return parts[1]?p[1]===parts[1]:parts[0]&&p[0]===parts[0];}));
   scroll.scrollTop=saved.top||0;
   if(row)scroll.scrollTop+=row.getBoundingClientRect().top-readingTop(scroll)-(saved.offset||0);
   if(hasHorizontal()){content.scrollLeft=0;setHorizontal(saved.left||0);}else content.scrollLeft=saved.left||0;
  }
  function toggle(name){if(name==='split'&&narrow)return;remember();state[name]=name==='wrap'?state.wrap===false:!state[name];show(state.mode,{remember:false});}
  function fit(){
   const width=content.getBoundingClientRect().width;if(!readerShown||!width||!scroller().clientHeight)return;
   const changed=lastWidth&&Math.abs(width-lastWidth)>.1,position=readerResumePending?(pendingPosition||state.positions[state.mode]||resizePosition):pendingPosition||(changed?resizePosition:readingPosition()),next=width<640;
   const restore=readerResumePending||!!pendingPosition||changed;pendingPosition=undefined;readerResumePending=false;
   if(next!==narrow){narrow=next;if(state.mode==='diff'&&renderedSplit!==(!!state.split&&!narrow)){render('diff');restorePosition(position);}else updateSplit();}
   if(restore)restorePosition(position);
   lastWidth=width;resizePosition=readingPosition();state.positions[state.mode]=resizePosition;scheduleHorizontal();
  }
  function updateSplit(){
   if(useKit){mount(diffTools,'ReviewDiffTools',{mode:state.mode,narrow,split:!!state.split,full:!!state.full,wrap:state.wrap!==false,onSplit:()=>toggle('split'),onContext:()=>toggle('full'),onWrap:()=>toggle('wrap')});}
   const effective=!!state.split&&!narrow;split.disabled=narrow;split.setAttribute('aria-pressed',String(effective));
   split.textContent=narrow?t('统一视图','Unified'):t('并排','Split');
   split.title=narrow?(state.split?t('加宽审阅区域后恢复并排','Split view resumes when the review is wider'):t('加宽审阅区域可使用并排视图','Widen the review to compare side by side')):t('切换统一 / 并排差异','Switch unified / split diff');
  }
  function show(mode,optionsForShow={}){if(optionsForShow.remember!==false)remember();render(mode);const saved=state.positions[state.mode],width=content.getBoundingClientRect().width;if(readerShown&&width&&scroller().clientHeight){pendingPosition=undefined;readerResumePending=false;restorePosition(saved);lastWidth=width;resizePosition=readingPosition();}else{pendingPosition=saved;readerResumePending=true;}}
  function render(mode){
   cancelHorizontal();horizontalReady=false;horizontalMaximum=0;horizontal.hidden=true;
   state.mode=options.some(([key])=>key===mode)?mode:'diff';mode=state.mode;renderedMode=mode;renderedSplit=mode==='diff'&&!!state.split&&!narrow;content.replaceChildren();content.classList.toggle('review-split-nowrap',hasHorizontal());content.classList.toggle('review-nowrap',state.wrap===false&&mode!=='preview');content.setAttribute('aria-labelledby',id+'-'+mode);controls.forEach(b=>{const active=b.dataset.mode===mode;b.setAttribute('aria-selected',String(active));b.setAttribute('aria-pressed',String(active));b.tabIndex=active?0:-1;});diffTools.hidden=mode==='preview';split.hidden=context.hidden=mode!=='diff';updateSplit();context.setAttribute('aria-pressed',String(!!state.full));wrap.setAttribute('aria-pressed',String(state.wrap!==false));
   if(useKit)mount(tabs,'ReviewModeControl',{id,options,value:mode,onChange:show});
   if(mode==='preview'){const article=el('article','note-document-preview');article.innerHTML=markdown(after);content.append(article);return;}
   if(mode==='source'){const source=el('div','review-source');appendRows(source,String(after).split('\n').map((text,i)=>({type:'same',old:null,next:i+1,text})),false,'source');content.append(source);return;}
   if(!count.added&&!count.removed){const empty=el('div','review-empty');content.append(empty);if(useKit)mount(empty,'ReviewEmptyState',{title:t('正文没有变化','No text changes')});else empty.textContent=t('正文没有变化','No text changes');}
   renderedSplit=!!state.split&&!narrow;const table=el('div','file-review-diff'+(renderedSplit?' is-split':''));if(renderedSplit){const labels=el('div','diff-column-labels');labels.append(el('span','',t('修改前','Before')),el('span','',t('修改后','After')));table.append(labels);}
   if(hunks.length){
    let shownHunks=0;const moreHunks=button(t('继续审阅修改块','Show more changes'),()=>appendHunks(24),'review-more review-more-hunks');table.append(moreHunks);
    function appendHunks(amount){for(const [offset,hunk] of hunks.slice(shownHunks,shownHunks+amount).entries()){
     const index=shownHunks+offset;
     const section=el('section','review-hunk');section.dataset.hunkId=hunk.id;section.dataset.hunkStatus=hunk.status;section.tabIndex=-1;
     const header=el('div','review-hunk-heading'),label=el('strong','',`${t('修改块','Change')} ${index+1} / ${hunks.length}`),range=el('code','review-hunk-range',`−${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}`);
     header.append(label,range,el('span','review-hunk-status',({pending:t('待审阅','Pending'),accepted:t('已接受','Accepted'),rejected:t('已拒绝','Rejected'),undone:t('已撤销','Undone')})[hunk.status]||hunk.status));
     const actionHost=el('div','review-hunk-actions'),hunkActions=[];
     const addAction=(action,label)=>{const b=button(label,()=>onHunk(action,hunk.id));b.dataset.hunkAction=action;b.dataset.hunkId=hunk.id;hunkActions.push(b);};
     if(onHunk&&hunk.status==='pending'){addAction('accept-hunk',t('接受此块','Accept change'));addAction('reject-hunk',t('拒绝此块','Reject change'));}
     if(onHunk&&hunk.status==='accepted')addAction('undo-hunk',t('撤销此块','Undo change'));
     if(useKit&&hunkActions.length)mount(actionHost,'ReviewActions',{actions:hunkActions});else actionHost.append(...hunkActions);
     header.append(actionHost);section.append(header);
     const data=root.FileReview.hunkRows(hunk,before,0),body=el('div','review-hunk-body');
     appendRows(body,renderedSplit?pairedRows(data):data,renderedSplit,'hunk:'+hunk.id);section.append(body);
     if(!hunk.oldCount&&!hunk.newCount)section.append(el('p','review-hunk-boundary',t('创建空文件','Create an empty file')));
     else if(hunk.before.endsWith('\n')!==hunk.after.endsWith('\n')&&hunk.before&&hunk.after)section.append(el('p','review-hunk-boundary',hunk.after.endsWith('\n')?t('修改后以换行结束','After: ends with a newline'):t('修改后文件末尾没有换行','After: no newline at end of file')));
     table.insertBefore(section,moreHunks);
    }shownHunks=Math.min(hunks.length,shownHunks+amount);state.hunkLimit=shownHunks;moreHunks.hidden=shownHunks>=hunks.length;}
    appendHunks(state.hunkLimit||24);
    if(state.full){const details=el('details','review-hunk-full-context'),summary=el('summary','',t('查看完整变更上下文','View complete diff context'));details.append(summary);const body=el('div');appendRows(body,renderedSplit?pairedRows(rows):rows,renderedSplit,'full-hunk-context');details.append(body);table.append(details);}
   }else{const visible=state.full?rows:contextRows(rows);appendRows(table,renderedSplit?pairedRows(visible):visible,renderedSplit,'diff:'+!!state.full);}
   content.append(table);
  }
  show(state.mode);fit();let observed=host.isConnected;
  const observer=typeof root.ResizeObserver==='function'?new root.ResizeObserver(()=>{if(!host.isConnected&&observed){observer.disconnect();return;}observed=host.isConnected;fit();}):null;
  const readerVisibility=event=>{
   if(event.detail?.visible===false){
    remember();pendingPosition=state.positions[state.mode]||resizePosition;readerShown=false;readerResumePending=true;
    if(scrollFrame!==null){root.cancelAnimationFrame(scrollFrame);scrollFrame=null;}cancelHorizontal();
   }else if(event.detail?.visible===true){readerShown=true;fit();}
  };
  readerSurface?.addEventListener('aibro:reader-visibility',readerVisibility);
  const recordScroll=event=>{if(!readerShown||readerResumePending||event.target!==scroller()||scrollFrame!==null)return;scrollFrame=root.requestAnimationFrame(()=>{scrollFrame=null;if(readerShown&&!readerResumePending&&content.isConnected&&Math.abs(content.getBoundingClientRect().width-lastWidth)<=.1){resizePosition=readingPosition();state.positions[state.mode]=resizePosition;}});};
  root.document.addEventListener('scroll',recordScroll,true);
  observer?.observe(content);cleanups.set(host,()=>{remember();horizontalDisposed=true;cancelHorizontal();horizontal.removeEventListener('scroll',horizontalScroll);horizontal.removeEventListener('keydown',horizontalKey);content.removeEventListener('wheel',horizontalWheel);observer?.disconnect();readerSurface?.removeEventListener('aibro:reader-visibility',readerVisibility);root.document.removeEventListener('scroll',recordScroll,true);if(scrollFrame!==null)root.cancelAnimationFrame(scrollFrame);});handles.set(host,{capture:remember});
  return {show,content,footer,fit,capture:remember};
 }
 return {create,document:documentView,contextRows,pairedRows,stats,dispose,capture:host=>handles.get(host)?.capture()};
});
