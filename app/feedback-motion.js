/* Confirmed results only: callers invoke success after their promise resolves.
   Inline document observers read the editor's persistence result, never clicks. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.FeedbackMotion=api;})(globalThis,function(root){
 'use strict';
 const active=new WeakMap();let dispose;
 const saveStatus='.note-document-status,.local-document-status';
 const confirmedSave=text=>/^(?:已保存 · 修改前的版本已保留。|已保存到本机 · 原版本已保留，可撤销此次保存。|所有修改已保存。)$/.test(String(text||'').trim());
 function clear(target){
  const item=active.get(target);if(!item)return;
  root.clearTimeout(item.timer);target.classList.remove('feedback-confirmed');target.removeAttribute('data-feedback-label');
  target.style.removeProperty('--feedback-ink');
  if(target.getAttribute('aria-label')===item.label){if(item.previousLabel===null)target.removeAttribute('aria-label');else target.setAttribute('aria-label',item.previousLabel);}
  active.delete(target);
 }
 function success(target,options={}){
  if(!target?.isConnected||!target.getClientRects().length)return false;
  const ink=active.get(target)?.ink||root.getComputedStyle(target).color;
  clear(target);const label=String(options.label||'已完成'),previousLabel=target.getAttribute('aria-label');
  target.style.setProperty('--feedback-ink',ink);
  target.setAttribute('data-feedback-label',label);target.setAttribute('aria-label',label);target.classList.add('feedback-confirmed');
  const timer=root.setTimeout(()=>clear(target),Number(options.duration)||1600);active.set(target,{timer,label,previousLabel,ink});
  const announce=root.document?.getElementById('confirmedFeedbackStatus');
  if(announce)announce.textContent=label;
  return true;
 }
 function saved(surface){
  const button=surface?.querySelector?.('[data-note-action="save"],[data-local-document-action="save"]');
  return success(button,{label:root.WorkstationI18n?.getLanguage?.()==='en'?'Saved':'已保存'});
 }
 function init(){
  dispose?.();const doc=root.document;if(!doc?.body)return;
  const statuses=new WeakMap();doc.querySelectorAll(saveStatus).forEach(n=>statuses.set(n,n.textContent));
  const live=doc.createElement('span');live.id='confirmedFeedbackStatus';live.className='confirmed-feedback-status';live.setAttribute('role','status');live.setAttribute('aria-live','polite');live.setAttribute('aria-atomic','true');doc.body.append(live);
  const observer=new root.MutationObserver(records=>{
   const changed=new Set();
   for(const record of records){
    const element=record.target.nodeType===1?record.target:record.target.parentElement;
    const status=element?.closest?.(saveStatus);if(status)changed.add(status);
    for(const node of record.addedNodes||[])if(node.nodeType===1){if(node.matches(saveStatus))changed.add(node);node.querySelectorAll(saveStatus).forEach(n=>changed.add(n));}
   }
   for(const status of changed){
    const previous=statuses.get(status),text=status.textContent;statuses.set(status,text);
    if(previous!==undefined&&previous!==text&&confirmedSave(text))saved(status.closest('.note-document'));
   }
  });
  observer.observe(doc.body,{childList:true,characterData:true,subtree:true});
  const editing=event=>{const surface=event.target.closest?.('.note-document');const button=surface?.querySelector('[data-note-action="save"],[data-local-document-action="save"]');if(button)clear(button);};
  doc.addEventListener('input',editing);
  dispose=()=>{observer.disconnect();doc.removeEventListener('input',editing);live.remove();doc.querySelectorAll('.feedback-confirmed').forEach(clear);};
  return {destroy:dispose};
 }
 if(root.document){if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',()=>init(),{once:true});else init();}
 return {success,saved,clear,init,confirmedSave};
});
