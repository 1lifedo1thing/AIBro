/* Real composer actions in the adapted Bencho Create menu. No business state is
 * simulated here; the caller supplies each existing action and receives errors. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ComposerAddMenu=api;})(globalThis,function(root){
 'use strict';
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'||/^en(?:-|$)/i.test(root.document?.documentElement?.lang||'')?en:zh;
 const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
 function itemsFor(items){const seen=new Set();return (Array.isArray(items)?items:[]).filter(item=>item&&typeof item.id==='string'&&item.id&&!seen.has(item.id)&&typeof item.label==='string'&&item.label&&typeof item.onSelect==='function'&&(seen.add(item.id),true)).map(item=>({id:item.id,label:item.label,description:typeof item.description==='string'?item.description:'',disabled:!!item.disabled,onSelect:item.onSelect}));}
 function layout(anchor,width,height,viewport){
  const pad=8,gap=8,w=Math.min(width,Math.max(1,viewport.width-pad*2)),h=Math.min(height,Math.max(1,viewport.height-pad*2));
  const above=anchor.top-gap-pad,below=viewport.height-anchor.bottom-gap-pad,up=above>=h||above>below;
  const left=clamp(anchor.left,pad,Math.max(pad,viewport.width-w-pad)),top=clamp(up?anchor.top-gap-h:anchor.bottom+gap,pad,Math.max(pad,viewport.height-h-pad));
  return {left,top,width:w,maxHeight:h,placement:up?'above':'below',from:{left:anchor.left-left,top:anchor.top-top,width:Math.max(1,anchor.width),height:Math.max(1,anchor.height)}};
 }
 function nextIndex(items,current,key){const indices=items.map((item,i)=>!item.disabled?i:-1).filter(i=>i>=0);if(!indices.length)return -1;if(key==='Home')return indices[0];if(key==='End')return indices.at(-1);const at=indices.indexOf(current);if(key==='ArrowDown')return indices[(at+1+indices.length)%indices.length];if(key==='ArrowUp')return indices[(at<0?indices.length-1:at-1+indices.length)%indices.length];return current;}
 let current=null,sequence=0;
 const active=()=>!!current;
 function close(options={}){
  const session=current;if(!session)return false;current=null;sequence++;
  session.off.forEach(fn=>fn());session.observer?.disconnect();session.resize?.disconnect();if(session.frame)root.cancelAnimationFrame(session.frame);
  session.island?.unmount();session.host.remove();session.anchor.setAttribute('aria-expanded','false');
  if(session.previousControls===null)session.anchor.removeAttribute('aria-controls');else session.anchor.setAttribute('aria-controls',session.previousControls);
  if(options.restoreFocus!==false&&session.anchor.isConnected&&session.anchor.getClientRects().length)session.anchor.focus({preventScroll:true});
  session.onClose?.();return true;
 }
 function open({anchor,items,label,onClose}={}){
  if(!root.document||!anchor?.isConnected||anchor.disabled||!anchor.getClientRects().length)return false;
  if(current?.anchor===anchor){close();return false;}close({restoreFocus:false});
  const rows=itemsFor(items);if(!rows.length||!root.HalaskaUI?.componentNames?.includes('BenchoAddMenu'))return false;
  const doc=root.document,host=doc.createElement('div');host.id='composerAddMenu';host.className='composer-add-menu-host';host.style.visibility='hidden';doc.body.append(host);
  const ticket=++sequence,session={anchor,host,items:rows,onClose,previousControls:anchor.getAttribute('aria-controls'),off:[],island:null,frame:0,observer:null,resize:null,busy:'',error:'',reduced:false,geometry:null};current=session;
  const isCurrent=()=>current===session&&ticket===sequence;
  const listen=(element,event,fn,options)=>{element.addEventListener(event,fn,options);session.off.push(()=>element.removeEventListener(event,fn,options));};
  const enabledButtons=()=>[...host.querySelectorAll('[role="menuitem"]:not([disabled])')];
  function focusItem(key){const index=rows.findIndex(item=>item.id===doc.activeElement?.dataset.addAction),next=nextIndex(rows,index,key),button=next>=0?host.querySelectorAll('[role="menuitem"]')[next]:null;if(button){button.focus({preventScroll:true});button.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});}}
  const reduce=()=>!!(doc.body.classList.contains('reduce-motion')||doc.documentElement.classList.contains('reduce-motion')||root.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  function reposition(){
   session.frame=0;if(!isCurrent())return;
   const a=anchor.getBoundingClientRect();if(!anchor.isConnected||!anchor.getClientRects().length||a.bottom<=0||a.top>=root.innerHeight||a.right<=0||a.left>=root.innerWidth){close({restoreFocus:false});return;}
   const previous=session.geometry,panel=host.querySelector('.crt-panel');
   // Measure layout ink, not scrollHeight: the entrance transform briefly adds
   // overflow and a fractional row height otherwise leaves a spurious scrollbar.
   const preferredHeight=panel?Math.ceil([...panel.children].reduce((sum,child)=>{const style=root.getComputedStyle(child);return sum+child.getBoundingClientRect().height+parseFloat(style.marginTop||0)+parseFloat(style.marginBottom||0);},16)):rows.reduce((sum,item)=>sum+(item.description?54:38),16)+(session.error?54:0);
   session.geometry=layout(a,286,preferredHeight,{width:root.innerWidth,height:root.innerHeight});session.reduced=reduce();
   host.style.left=session.geometry.left+'px';host.style.top=session.geometry.top+'px';host.style.width=session.geometry.width+'px';host.style.maxHeight=session.geometry.maxHeight+'px';host.style.visibility='';
   if(!previous||JSON.stringify(previous)!==JSON.stringify(session.geometry))paint();
  }
  function schedule(){if(!session.frame&&isCurrent())session.frame=root.requestAnimationFrame(reposition);}
  async function select(id){
   if(!isCurrent()||session.busy)return;const item=rows.find(row=>row.id===id);if(!item||item.disabled)return;
   session.busy=id;session.error='';paint();
   try{const result=await item.onSelect();if(!isCurrent())return;if(result===false)throw Error(t('未能打开此操作，请重试。','This action could not be opened. Try again.'));
    const focus=doc.activeElement;close({restoreFocus:focus===doc.body||host.contains(focus)});
   }catch(error){if(!isCurrent())return;session.busy='';session.error=error?.message||String(error);paint();schedule();[...host.querySelectorAll('[data-add-action]')].find(button=>button.dataset.addAction===id)?.focus({preventScroll:true});}
  }
  function paint(){
   if(!isCurrent())return;const props={items:rows.map(({onSelect,...item})=>item),label:label||t('添加到对话','Add to conversation'),busy:session.busy,error:session.error,reducedMotion:session.reduced,geometry:session.geometry,onSelect:select};
   const focused=host.contains(doc.activeElement)?doc.activeElement?.dataset.addAction:null;
   if(session.island)session.island.update(props);else session.island=root.HalaskaUI.mount(host,'BenchoAddMenu',props);
   if(focused&&!session.busy&&doc.activeElement?.dataset.addAction!==focused)[...host.querySelectorAll('[data-add-action]')].find(button=>button.dataset.addAction===focused)?.focus({preventScroll:true});
  }
  anchor.setAttribute('aria-expanded','true');anchor.setAttribute('aria-controls',host.id);
  reposition();
  // Measure real, wrapped translated labels after the React commit.
  reposition();(enabledButtons()[0]||host.querySelector('[role="menu"]'))?.focus({preventScroll:true});schedule();
  listen(doc,'keydown',event=>{
   if(!isCurrent()||event.isComposing||event.keyCode===229)return;
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
   if(!host.contains(event.target))return;
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(!session.busy)focusItem(event.key);}
   if(event.key==='Tab'){event.preventDefault();const backwards=event.shiftKey;close();if(!backwards){const nodes=[...doc.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')].filter(el=>el.getClientRects().length&&el.tabIndex>=0);const at=nodes.indexOf(anchor);nodes[at+1]?.focus({preventScroll:true});}}
  },true);
  listen(doc,'pointerdown',event=>{if(!host.contains(event.target)&&!anchor.contains(event.target))close({restoreFocus:false});},true);
  listen(doc,'focusin',event=>{if(!host.contains(event.target)&&!anchor.contains(event.target))close({restoreFocus:false});});
  listen(doc,'scroll',event=>{if(!host.contains(event.target))schedule();},true);listen(root,'resize',schedule);
  session.observer=new root.MutationObserver(()=>{if(!isCurrent())return;if(!anchor.isConnected){close({restoreFocus:false});return;}const next=reduce();if(next!==session.reduced){session.reduced=next;paint();}schedule();});
  session.observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden']});
  const media=root.matchMedia?.('(prefers-reduced-motion: reduce)');if(media?.addEventListener){const changed=()=>{session.reduced=reduce();paint();};media.addEventListener('change',changed);session.off.push(()=>media.removeEventListener('change',changed));}
  if(root.ResizeObserver){session.resize=new root.ResizeObserver(schedule);session.resize.observe(host);}
  return true;
 }
 return {open,close,isOpen:active,layout,itemsFor,nextIndex};
});
