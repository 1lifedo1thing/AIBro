/* Current-page PDF canvas. PDF bytes stay in the existing local preview service. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.PDFReader=api;})(globalThis,function(root){
 'use strict';
 const instances=new WeakMap(),RASTER_DELAY=180;
 // Match the local preview service's hard 0.5–2 scale bounds. Retaining a
 // sharper current-page raster avoids redraws when the reader later shrinks.
 function rasterScale({width,height,pageWidth,pageHeight,dpr=1}){
  const density=Number.isFinite(Number(dpr))&&Number(dpr)>0?Number(dpr):1;
  const need=Math.max(Number(width)/Number(pageWidth),Number(height)/Number(pageHeight))*density;
  return Math.min(2,Math.max(.5,Math.ceil((Number.isFinite(need)?need:1)*4-1e-6)/4));
 }
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'||/^en(?:-|$)/i.test(root.document?.documentElement?.lang||'')?en:zh;
 const clampZoom=value=>Math.min(2.5,Math.max(.5,Number.isFinite(Number(value))?Number(value):1));
 const validPage=(value,count)=>{const number=Number(value);return Number.isSafeInteger(number)&&number>=1&&number<=count?number:null;};
 function fitSize({width,height,pageWidth,pageHeight,mode='width',zoom=1,padding=24}){
  const availableWidth=Math.max(1,Number(width)-padding),availableHeight=Math.max(1,Number(height)-padding);
  const naturalWidth=Number(pageWidth)>0?Number(pageWidth):612,naturalHeight=Number(pageHeight)>0?Number(pageHeight):792,ratio=naturalWidth/naturalHeight;
  const baseWidth=naturalWidth*4/3;
  const outputWidth=mode==='page'?Math.min(availableWidth,availableHeight*ratio):mode==='zoom'?baseWidth*clampZoom(zoom):availableWidth;
  return {width:Math.max(1,outputWidth),height:Math.max(1,outputWidth/ratio),zoom:outputWidth/baseWidth};
 }
 function mount(container,options={}){
  instances.get(container)?.destroy();
  const doc=root.document,item=options.item||{},base=`/__files/${encodeURIComponent(item.id||'')}`;
  const node=(tag,className)=>{const value=doc.createElement(tag);if(className)value.className=className;return value;};
  const frame=node('section','pdf-reader'),toolbar=node('div','pdf-reader-toolbar-host'),viewport=node('div','pdf-viewport'),sheet=node('div','pdf-sheet'),status=node('div','pdf-page-status');
  frame.setAttribute('aria-label',t('PDF 阅读器','PDF reader'));viewport.tabIndex=0;viewport.setAttribute('role','region');status.setAttribute('role','status');status.setAttribute('aria-live','polite');viewport.append(status,sheet);frame.append(toolbar,viewport);container.replaceChildren(frame);
  let destroyed=false,epoch=0,request=null,image=null,island=null,resizeObserver=null,resizeFrame=null,count=0,page=1,mode='width',zoom=1,effectiveZoom=1,dimensions={width:612,height:792},phase='metadata',error='',retryKind='metadata',raster=0,attemptedRaster=0,pendingRaster=null,rasterTimer=null,rasterKey='',firstPageSize=null;
  let textRequest=null,textLayer=null,textData=null,textPhase='loading',pageText='',copying=false;
  let searchLayer=null,pendingMatch=null,find=null,findState=null,findFocus=0;
  let measuredSize=null,deferredPosition=null,lastVisiblePosition={top:0,left:0};
  const positions=new Map(),measure=doc.createElement('canvas').getContext?.('2d');
  const valid=()=>!destroyed&&options.onValid?.()!==false;
  function destroy(){if(destroyed)return;destroyed=true;epoch++;find?.destroy();request?.abort();textRequest?.abort();textData=null;textLayer=null;pageText='';positions.clear();cancelRaster();if(image){image.onload=null;image.onerror=null;image.removeAttribute('src');}resizeObserver?.disconnect();if(resizeFrame!==null)root.cancelAnimationFrame?.(resizeFrame);doc.removeEventListener?.('workstation-language-change',refresh);root.removeEventListener?.('resize',scheduleSize);island?.unmount();frame.replaceChildren();frame.remove();if(instances.get(container)===handle)instances.delete(container);}
  function guard(){if(valid())return true;destroy();return false;}
  function toolbarProps(){return {find:findState,findFocus,onFind:openFind,onFindClose:closeFind,onFindQuery:value=>find?.query(value),onFindNext:delta=>find?.move(delta),onFindRun:()=>find?.run(),onFindStop:()=>find?.stop(),title:item.name||item.originalName||t('未命名 PDF','Untitled PDF'),count,page,mode,zoom:effectiveZoom,loading:phase==='metadata',error,textPhase:phase==='error'?'page-error':phase==='ready'?textPhase:'loading',canCopy:!!pageText&&phase==='ready',copying,onCopy:copyPage,onTextRetry:loadText,expanded:!!options.isExpanded?.(),canExpand:typeof options.onExpand==='function',onPage:setPage,onTurn:delta=>setPage(page+delta),onFit:value=>{if(!guard())return;const position=capturePosition();mode=value;applySize();restorePosition(value==='page'?{top:0,left:0}:position);},onZoom:delta=>{if(!guard())return;const position=capturePosition();zoom=clampZoom(Math.round((effectiveZoom+delta)*100)/100);mode='zoom';applySize();restorePosition(position);},onExpand:()=>{if(guard()){options.onExpand?.(!options.isExpanded?.());scheduleSize();renderToolbar();}},onRetry:()=>retryKind==='metadata'?loadInfo():retryKind==='refinement'?refine(true):renderPage()};}
  function renderToolbar(){if(!guard())return;const props=toolbarProps();if(island)island.update(props);else island=root.HalaskaUI.mount(toolbar,'PDFReaderToolbar',props);}
  function setStatus(value,isError=false){status.textContent=value;status.hidden=!value;status.setAttribute('role',isError?'alert':'status');viewport.setAttribute('aria-busy',String(phase==='metadata'||phase==='page'));}
  function pageSize(){
   const computed=root.getComputedStyle?.(viewport),padding=(parseFloat(computed?.paddingLeft)||12)+(parseFloat(computed?.paddingRight)||12),vertical=(parseFloat(computed?.paddingTop)||12)+(parseFloat(computed?.paddingBottom)||12);
   if(hasVisibleSize())measuredSize={width:viewport.clientWidth,height:viewport.clientHeight};
   const size=measuredSize||{width:dimensions.width,height:dimensions.height};
   return fitSize({width:size.width,height:Math.max(1,size.height+padding-vertical),pageWidth:dimensions.width,pageHeight:dimensions.height,mode,zoom,padding});
  }
  function requestedRaster(){return rasterScale({...pageSize(),pageWidth:dimensions.width,pageHeight:dimensions.height,dpr:root.devicePixelRatio||1});}
  function hasVisibleSize(){return viewport.clientWidth>0&&viewport.clientHeight>0;}
  function capturePosition(){return deferredPosition||(!hasVisibleSize()?lastVisiblePosition:{top:(viewport.scrollTop||0)/(parseFloat(image?.style.height)||1),left:(viewport.scrollLeft||0)/(parseFloat(image?.style.width)||1)});}
  function restorePosition(value){if(!value||!image)return;lastVisiblePosition=value;if(!hasVisibleSize()){deferredPosition=value;return;}deferredPosition=null;viewport.scrollTop=value.top*(parseFloat(image.style.height)||1);viewport.scrollLeft=value.left*(parseFloat(image.style.width)||1);}
  function rememberPosition(){if(phase!=='ready')return;positions.delete(page);positions.set(page,capturePosition());if(positions.size>32)positions.delete(positions.keys().next().value);}
  function styleText(){if(!textLayer)return;textLayer.hidden=phase!=='ready';if(!image||!textData)return;const scale=parseFloat(image.style.width)/textData.width;textLayer.style.transform=`scale(${scale})`;textLayer.style.left=`calc(50% - ${parseFloat(image.style.width)/2}px)`;}
  function styleImage(target){const size=pageSize();target.style.width=`${size.width}px`;target.style.height=`${size.height}px`;sheet.style.width=`${size.width}px`;effectiveZoom=size.zoom;styleText();styleSearch();}
  function applySize(schedule=true){
   if(!guard())return;
   // Hidden retained readers have no measurable viewport. A zero-size layout
   // would shrink the sheet and clamp its scroll to the top. Keep the last
   // geometry, then restore the position when the real viewport returns.
   if(!hasVisibleSize()){if(image&&phase==='ready')deferredPosition ||= lastVisiblePosition;return;}
   const position=image&&phase==='ready'?capturePosition():null;
   if(image)styleImage(image);else effectiveZoom=zoom;
   restorePosition(position);
   revealMatch();renderToolbar();if(schedule)scheduleRaster();
  }
  function cancelRaster(){
   if(rasterTimer!==null){root.clearTimeout(rasterTimer);rasterTimer=null;}
   const pending=pendingRaster;pendingRaster=null;if(pending){pending.image.onload=null;pending.image.onerror=null;pending.image.removeAttribute('src');pending.image.remove();}
  }
  function scheduleRaster(){
   const size=pageSize(),need=requestedRaster(),key=[Math.round(size.width),Math.round(size.height),need,root.devicePixelRatio||1].join(':');
   if(destroyed||!hasVisibleSize()||phase!=='ready'||!image||pendingRaster||need<=Math.max(raster,attemptedRaster)){if(rasterTimer!==null)root.clearTimeout(rasterTimer);rasterTimer=null;rasterKey='';return;}
   // Repaints at the same dimensions do not postpone refinement forever. A
   // changing canvas restarts the wait; only its stable size gets a new raster.
   if(rasterTimer!==null&&rasterKey===key)return;
   if(rasterTimer!==null)root.clearTimeout(rasterTimer);rasterKey=key;
   rasterTimer=root.setTimeout(()=>{rasterTimer=null;rasterKey='';refine();},RASTER_DELAY);
  }
  function refine(force=false){
   if(!guard()||!hasVisibleSize()||phase!=='ready'||!image||pendingRaster)return;
   const next=requestedRaster();if(next<=raster||!force&&next<=attemptedRaster)return;
   if(rasterTimer!==null){root.clearTimeout(rasterTimer);rasterTimer=null;}
   error='';retryKind='page';renderToolbar();loadRaster(next,true);
  }
  function scheduleSize(){if(resizeFrame!==null)return;resizeFrame=root.requestAnimationFrame(()=>{resizeFrame=null;applySize();});}
  function refresh(){if(!guard())return;if(image)image.alt=t(`${item.name||'PDF'}，第 ${page} 页，共 ${count} 页`,`${item.name||'PDF'}, page ${page} of ${count}`);textLayer?.setAttribute('aria-label',t(`第 ${page} 页原文`,`Original text, page ${page}`));frame.setAttribute('aria-label',t('PDF 阅读器','PDF reader'));viewport.setAttribute('aria-label',t('PDF 页面；聚焦后使用左右方向键翻页','PDF page; focus here and use left or right arrow keys to turn pages'));if(phase==='metadata')setStatus(t('正在准备 PDF 预览…','Preparing PDF preview…'));else if(phase==='page')setStatus(t(`正在渲染第 ${page} 页…`,`Rendering page ${page}…`));applySize();}
  function setPage(value){
   if(!guard()||!count)return false;const next=validPage(value,count);
   if(next===null){options.toast?.(t(`请输入 1 到 ${count} 之间的页码。`,`Enter a page between 1 and ${count}.`));renderToolbar();return false;}
   if(pendingMatch&&pendingMatch.page!==next)pendingMatch=null;if(next===page&&phase==='ready')return true;rememberPosition();page=next;renderPage();return true;
  }
  function renderPage(){
   if(!guard()||!count)return;
   ++epoch;request?.abort();textRequest?.abort();textLayer=null;searchLayer=null;textData=null;pageText='';textPhase='loading';copying=false;cancelRaster();if(image){image.onload=null;image.onerror=null;image.removeAttribute('src');}image=null;raster=0;attemptedRaster=0;
   phase='page';retryKind='page';error='';deferredPosition=null;lastVisiblePosition={top:0,left:0};sheet.replaceChildren();viewport.scrollTop=0;viewport.scrollLeft=0;setStatus(t(`正在渲染第 ${page} 页…`,`Rendering page ${page}…`));
   if(page===1&&firstPageSize)dimensions={...firstPageSize};
   options.onPage?.(page);loadRaster(requestedRaster(),false);loadText();
  }
  function loadRaster(scale,refinement){
   if(!guard())return;const current=epoch,requestedPage=page,rendered=node('img'),pending={image:rendered,scale,epoch:current,page:requestedPage,refinement};pendingRaster=pending;attemptedRaster=Math.max(attemptedRaster,scale);
   rendered.alt=t(`${item.name||'PDF'}，第 ${requestedPage} 页，共 ${count} 页`,`${item.name||'PDF'}, page ${requestedPage} of ${count}`);rendered.draggable=false;rendered.decoding='async';
   rendered.onload=()=>{
    if(!guard()||current!==epoch||pendingRaster!==pending)return;
    if(!(rendered.naturalWidth>0&&rendered.naturalHeight>0)){rendered.onerror();return;}
    pendingRaster=null;const scroll=capturePosition(),previous=image;
    // Establish geometry once per page. Repeated decoding at higher scales
    // must never feed back into CSS zoom or make the reader's scroll jump.
    if(!refinement)dimensions=textData?{width:textData.width,height:textData.height}:requestedPage===1&&firstPageSize?{...firstPageSize}:{width:rendered.naturalWidth/scale,height:rendered.naturalHeight/scale};
    image=rendered;raster=scale;phase='ready';error='';retryKind='page';styleImage(rendered);
    if(refinement){sheet.insertBefore(rendered,previous);if(previous&&previous!==rendered){previous.onload=null;previous.onerror=null;previous.removeAttribute('src');previous.remove();}}
    setStatus('');applySize(false);
    if(refinement)restorePosition(scroll);else restorePosition(positions.get(page));
    renderSearch();revealMatch();scheduleRaster();
   };
   rendered.onerror=()=>{
    if(!guard()||current!==epoch||pendingRaster!==pending)return;pendingRaster=null;rendered.onload=null;rendered.onerror=null;rendered.removeAttribute('src');rendered.remove();
    if(refinement&&image){phase='ready';retryKind='refinement';error=t('更清晰的页面暂时无法加载，已保留当前页面。','The sharper preview could not be loaded. The current page is preserved.');setStatus('');renderToolbar();options.toast?.(error);}
    else{phase='error';retryKind='page';error=t('这一页暂时无法显示。请重试，或下载原文件查看。','This page could not be displayed. Retry, or download the original.');image=null;setStatus(error,true);renderToolbar();}
   };
   // Keep the good current image visible until its sharper replacement loads.
   // Only this page is requested, never neighbors or a whole-document raster.
   if(!refinement){image=rendered;sheet.append(rendered);applySize(false);}
   rendered.src=`${base}/preview?page=${requestedPage}&scale=${scale}&fit=1`;
  }
  async function loadText(){
   if(!guard()||!count)return;const current=epoch,requestedPage=page;textRequest?.abort();textRequest=new AbortController();const signal=textRequest.signal;textPhase='loading';renderToolbar();
   try{
    const response=await root.fetch(`${base}/preview-text?page=${requestedPage}`,{signal});const data=await response.json();
    if(signal.aborted||!guard()||current!==epoch)return;
    if(!response.ok){textPhase=data.code==='PDF_COPY_RESTRICTED'?'restricted':'error';renderToolbar();return;}
    if(data.page!==requestedPage||!Number.isFinite(data.width)||!Number.isFinite(data.height)||data.width<=0||data.height<=0||!Array.isArray(data.words)||data.words.length>20000)throw Error('Invalid PDF text geometry');
    const words=data.words.filter(word=>typeof word.text==='string'&&word.text.length<=20000&&['x','y','width','height','angle'].every(key=>Number.isFinite(word[key]))&&word.width>0&&word.height>0&&[0,90,180,270].includes(word.angle));
    textData=data;const incomplete=data.partial||data.truncated||words.length!==data.words.length;textPhase=words.length?(incomplete?'partial':'ready'):(incomplete?'unsupported':'empty');
    textLayer?.remove();textLayer=null;pageText=words.map((word,index)=>word.text+(index===words.length-1?'':word.line===words[index+1].line?' ':'\n')).join('');
    if(words.length){
     textLayer=node('div','pdf-text-layer');textLayer.setAttribute('role','document');textLayer.setAttribute('aria-label',t(`第 ${page} 页原文`,`Original text, page ${page}`));textLayer.style.width=`${data.width}px`;textLayer.style.height=`${data.height}px`;
     words.forEach((word,index)=>{const span=node('span','pdf-text-word'),fontSize=word.height*.8;span.textContent=word.text+(index===words.length-1?'':word.line===words[index+1].line?' ':'\n');span.style.left=`${word.x}px`;span.style.top=`${word.y}px`;span.style.fontSize=`${fontSize}px`;span.style.lineHeight=`${word.height}px`;span.style.height=`${word.height}px`;if(measure)measure.font=`${fontSize}px sans-serif`;const measured=measure?.measureText(word.text).width||word.width;span.style.transform=`rotate(${word.angle}deg) scaleX(${word.width/Math.max(.01,measured)})`;textLayer.append(span);});sheet.append(textLayer);
    }
    if(phase==='ready'){const position=capturePosition();dimensions={width:data.width,height:data.height};applySize();restorePosition(position);}else styleText();
    renderToolbar();
   }catch(failure){if(signal.aborted||!guard()||current!==epoch)return;textPhase='error';renderToolbar();}
  }
  function openFind(){if(!guard()||!count||!find)return false;findFocus++;find.open();return true;}
  function closeFind(){find?.close();pendingMatch=null;toolbar.querySelector?.('[data-pdf-find]')?.focus({preventScroll:true});}
  function styleSearch(){if(!searchLayer)return;searchLayer.hidden=phase!=='ready';if(!image)return;const width=Number(searchLayer.dataset.pageWidth);searchLayer.style.transform=`scale(${parseFloat(image.style.width)/width})`;searchLayer.style.left=`calc(50% - ${parseFloat(image.style.width)/2}px)`;}
  function renderSearch(){
   searchLayer?.remove();searchLayer=null;if(!image||!findState?.open)return;
   const matches=findState.matches.filter(hit=>hit.page===page);if(!matches.length)return;
   searchLayer=node('div','pdf-search-layer');searchLayer.setAttribute('aria-hidden','true');searchLayer.dataset.pageWidth=String(matches[0].width);searchLayer.style.width=`${matches[0].width}px`;searchLayer.style.height=`${matches[0].height}px`;
   const active=findState.matches[findState.active]?.key;
   matches.forEach(hit=>hit.rects.forEach(rect=>{const mark=node('span',`pdf-search-mark${hit.key===active?' active':''}`);mark.style.left=`${rect.x}px`;mark.style.top=`${rect.y}px`;mark.style.width=`${rect.width}px`;mark.style.height=`${rect.height}px`;mark.style.transform=`rotate(${rect.angle}deg)`;searchLayer.append(mark);}));sheet.append(searchLayer);styleSearch();
  }
  function revealMatch(){
   if(!pendingMatch||pendingMatch.page!==page||phase!=='ready'||!image||!hasVisibleSize())return;
   const hit=pendingMatch,rect=hit.rects[0],scale=parseFloat(image.style.width)/hit.width;
   const radians=rect.angle*Math.PI/180,dx=rect.width*Math.cos(radians)-rect.height*Math.sin(radians),dy=rect.width*Math.sin(radians)+rect.height*Math.cos(radians);
   viewport.scrollTop=Math.max(0,(rect.y+dy/2)*scale-viewport.clientHeight*.35);
   viewport.scrollLeft=Math.max(0,(rect.x+dx/2)*scale-viewport.clientWidth*.5);pendingMatch=null;
  }
  if(root.PDFSearch)find=root.PDFSearch.create({base,getPageCount:()=>count,getPage:()=>page,onValid:valid,onUpdate:value=>{findState=value;if(pendingMatch&&value.matches[value.active]?.key!==pendingMatch.key)pendingMatch=null;renderToolbar();renderSearch();},onMatch:hit=>{pendingMatch=hit;setPage(hit.page);renderSearch();revealMatch();}});
  async function copyPage(){
   if(!guard()||!pageText||copying||phase!=='ready')return;const current=epoch;copying=true;renderToolbar();
   try{if(!root.navigator?.clipboard?.writeText)throw Error('Clipboard unavailable');await root.navigator.clipboard.writeText(pageText);if(guard()&&current===epoch)options.toast?.(t(textPhase==='partial'?'已复制本页可提取的部分文字。':'已复制本页原文。',textPhase==='partial'?'Copied the extractable text on this page.':'Copied this page’s text.'));}
   catch(failure){if(guard()&&current===epoch)options.toast?.(t('复制失败，请选择原文后按 ⌘C 复制。','Copy failed. Select text and press Command-C to copy.'));}
   finally{if(guard()&&current===epoch){copying=false;renderToolbar();}}
  }
  async function loadInfo(){
   if(!guard())return;const current=++epoch;request?.abort();request=new AbortController();const signal=request.signal;phase='metadata';error='';retryKind='metadata';setStatus(t('正在准备 PDF 预览…','Preparing PDF preview…'));renderToolbar();
   let originalAvailable=null;
   const active=()=>!signal.aborted&&guard()&&current===epoch;
   const availability=(value,localOriginal)=>{originalAvailable=value;if(active())options.onOriginalAvailability?.(value,localOriginal);};
   try{
    let response=await root.fetch(`${base}/preview-info`,{signal});if(!active())return;
    // Restore only a user-opened legacy original, never a different item's bytes.
    if(response.status===404){
     availability(false);
     const original=options.originalBlob||await options.getOriginalBlob?.({signal});if(!active())return;
     if(original){
      // A failed restore must not remove the user's remaining local download.
      // The host releases this temporary URL once the server copy is restored.
      availability(true,original);if(!active())return;
      const restored=await root.fetch(base,{method:'POST',body:original,signal,headers:{'Content-Type':'application/pdf','X-Filename':encodeURIComponent(item.name||item.originalName||'document.pdf')}});if(!active())return;
      if(!restored.ok){const failure=await restored.json();if(!active())return;throw Error(failure.error||t('原件恢复失败，请重试。','Original restoration failed. Retry.'));}
      availability(true);response=await root.fetch(`${base}/preview-info`,{signal});if(!active())return;
     }
    }
    if(response.ok)availability(true);else if(response.status===404)availability(false);
    const info=await response.json();if(!active())return;if(!response.ok)throw Error(info.error||t('PDF 预览暂不可用','PDF preview is unavailable'));
    count=Number(info.pageCount);if(!Number.isSafeInteger(count)||count<1)throw Error(t('PDF 没有可显示的页面','This PDF has no displayable pages'));
    firstPageSize={width:Number(info.width)>0?Number(info.width):612,height:Number(info.height)>0?Number(info.height):792};dimensions={...firstPageSize};page=validPage(options.requestedPage??1,count)||1;if(Number(options.requestedPage??1)!==page)options.toast?.(t('引用页码超出原件范围，已打开首页。','The cited page is outside this document. Opened page 1.'));renderPage();
   }catch(failure){if(!active())return;phase='error';count=0;error=String(failure.message||t('PDF 预览暂不可用','PDF preview is unavailable'));setStatus(`${error} · ${originalAvailable===true?t('原文件仍可下载查看。','You can still download the original file.'):t('可阅读已保存的文字，或重试预览。','Read the saved text, or retry the preview.')}`,true);renderToolbar();}
  }
  viewport.onscroll=()=>{if(!destroyed&&phase==='ready'&&hasVisibleSize()&&!deferredPosition)lastVisiblePosition=capturePosition();};
  viewport.onkeydown=event=>{if(event.target!==viewport||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();setPage(page+(event.key==='ArrowRight'?1:-1));}};
  const handle={destroy,refresh,setPage,openFind,getSnapshot:()=>({page,count,mode,zoom:effectiveZoom,phase,rasterScale:raster,pendingScale:pendingRaster?.scale||null}),ready:null};instances.set(container,handle);
  if(root.ResizeObserver){resizeObserver=new root.ResizeObserver(scheduleSize);resizeObserver.observe(viewport);}
  doc.addEventListener?.('workstation-language-change',refresh);root.addEventListener?.('resize',scheduleSize);refresh();handle.ready=loadInfo();return handle;
 }
 return {mount,fitSize,clampZoom,validPage,rasterScale};
});
