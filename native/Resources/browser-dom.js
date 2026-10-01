/* Fixed, host-owned DOM adapter. Installed only in a separate WKContentWorld. */
(() => {
  const refs = new Map();
  let sequence = 0, currentSnapshot = '';
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const role = e => e.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:e.type === 'checkbox'?'checkbox':'textbox',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button'}[e.tagName] || 'element');
  const name = e => text(e.getAttribute('aria-label') || e.getAttribute('title') || [...(e.labels || [])].map(l => l.textContent).join(' ') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('alt')).slice(0, 220);
  const identity = e => JSON.stringify([e.tagName, role(e), name(e), e.getAttribute('type'), e.getAttribute('href')]);
  function snapshot(token) {
    refs.clear(); currentSnapshot = token; sequence++;
    const elements = [], candidates = document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[contenteditable=true]');
    for (const e of candidates) {
      if (!visible(e)) continue;
      if (elements.length >= 160) break;
      const ref = 'e' + sequence + '-' + (elements.length + 1), rect = e.getBoundingClientRect();
      refs.set(ref, {element:e, identity:identity(e)});
      elements.push({ref, role:role(e), name:name(e), tag:e.tagName.toLowerCase(), disabled:!!e.disabled, editable:e.matches('input,textarea,[contenteditable=true]'), sensitive:e.matches('input[type=password]'), ...(e.type==='checkbox'?{checked:e.checked}:{}), bounds:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}});
    }
    const bodyText=text(document.body?.innerText);
    return {title:document.title,url:location.href,text:bodyText.slice(0,18000),elements,truncated:candidates.length > 160 || bodyText.length > 18000,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY}};
  }
  function target(request) {
    if (request.snapshotId !== currentSnapshot) throw Error('STALE_SNAPSHOT: 页面状态已变化，请重新查看页面');
    const entry = refs.get(request.ref), e = entry?.element;
    if (!e || !e.isConnected || !visible(e) || identity(e) !== entry.identity) throw Error('STALE_REF: 元素已变化，请重新查看页面');
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') throw Error('ELEMENT_DISABLED: 控件不可操作');
    return e;
  }
  function inspect(request) { const e=target(request);return {role:role(e),name:name(e),sensitive:e.matches('input[type=password]'),editable:e.matches('input,textarea,[contenteditable=true]')}; }
  function act(request) {
    const e=target(request);
    if(request.action==='click') e.click();
    else if(request.action==='type') {
      if(e.matches('input[type=password],input[type=file]'))throw Error('HUMAN_REQUIRED: 请人工填写密码或选择文件');
      if(!e.matches('input,textarea,[contenteditable=true]'))throw Error('NOT_EDITABLE: 目标不是可编辑文本控件');
      e.focus();
      if(e.matches('[contenteditable=true]')) { e.textContent=request.text; e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:request.text})); }
      else { const prototype=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,request.text);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true})); }
    }
    currentSnapshot='';refs.clear();return {acted:true,title:document.title,url:location.href};
  }
  globalThis.__aibroBrowserDOM = {snapshot,inspect,act,scroll(request){scrollBy({left:Number(request.x)||0,top:Number(request.y)||0,behavior:'instant'});currentSnapshot='';refs.clear();return {scroll:{x:scrollX,y:scrollY}};}};
})();
