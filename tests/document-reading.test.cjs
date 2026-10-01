const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../app/document-reading.js');
const defer = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
function harness({lazy=false, write=async()=>{}}={}) {
  const controls=[], writes=[], observers=[];
  class Node {
    constructor(tag){this.tagName=tag.toUpperCase();this.attributes={};this.children=[];this.listeners={};this.textContent='';this.hidden=false;this.parentElement=null;}
    get ownerDocument(){return doc;} get id(){return this.getAttribute('id')||'';} set id(value){this.setAttribute('id',value);}
    get isConnected(){for(let node=this;node;node=node.parentElement)if(node===doc.body)return true;return false;}
    append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
    before(node){const parent=this.parentElement;node.remove();parent.children.splice(parent.children.indexOf(this),0,node);node.parentElement=parent;}
    after(node){const parent=this.parentElement;node.remove();parent.children.splice(parent.children.indexOf(this)+1,0,node);node.parentElement=parent;}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
    setAttribute(key,value){this.attributes[key]=String(value);}getAttribute(key){return this.attributes[key]??null;}removeAttribute(key){delete this.attributes[key];}hasAttribute(key){return Object.hasOwn(this.attributes,key);}
    matches(selector){if(selector.includes(','))return selector.split(',').some(part=>this.matches(part));if(selector==='button[data-document-local-path]')return this.tagName==='BUTTON'&&this.hasAttribute('data-document-local-path');if(selector==='a[href]')return this.tagName==='A'&&this.hasAttribute('href');if(selector==='[tabindex]')return this.hasAttribute('tabindex');if(selector==='[contenteditable=true]')return this.getAttribute('contenteditable')==='true';if(['button','input','select','textarea'].includes(selector))return this.tagName===selector.toUpperCase();if(selector==='[data-document-markdown]')return this.hasAttribute('data-document-markdown');if(selector==='[id]')return this.hasAttribute('id');if(selector==='a[href^="#"]')return this.tagName==='A'&&this.getAttribute('href')?.startsWith('#');if(selector==='code')return this.tagName==='CODE';if(selector.includes('pre[data-document-code]'))return this.tagName==='PRE'&&this.hasAttribute('data-document-code')&&!!this.closest('[data-document-markdown]');if(selector.includes('img.document-managed-image'))return this.tagName==='IMG'&&this.className==='document-managed-image'&&!!this.closest('[data-document-markdown]');return false;}
    closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
    querySelectorAll(selector){const result=[];const walk=node=>{for(const child of node.children){if(child.matches(selector))result.push(child);walk(child);}};walk(this);return result;}querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    contains(target){for(let node=target;node;node=node.parentElement)if(node===this)return true;return false;}
    addEventListener(type,fn,options={}){(this.listeners[type]||=[]).push({fn,once:!!options.once});}removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(listener=>listener.fn!==fn);}
    dispatch(type,event={}){for(const listener of [...this.listeners[type]||[]]){listener.fn(event);if(listener.once)this.removeEventListener(type,listener.fn);}}
    focus(options){doc.activeElement=this;this.focusOptions=options;}scrollIntoView(options){this.scrolled=options;}
  }
  const doc={createElement:tag=>new Node(tag)};doc.body=new Node('body');const host=new Node('section');doc.body.append(host);
  const env={document:doc,navigator:{clipboard:{writeText:async text=>{writes.push(text);return write(text);}}},HalaskaUI:{mount(target,name,props){assert.equal(name,'Button');const control={target,props,updates:[],unmounted:false,update(next){assert.equal(control.unmounted,false,'Late clipboard must not update disposed Kit root');control.updates.push(next);control.props={...control.props,...next};},unmount(){control.unmounted=true;}};controls.push(control);return control;}}};
  if(lazy)env.IntersectionObserver=class{constructor(callback,options){this.callback=callback;this.options=options;this.observed=new Set();this.disconnected=false;observers.push(this);}observe(node){this.observed.add(node);}unobserve(node){this.observed.delete(node);}disconnect(){this.disconnected=true;this.observed.clear();}show(node){this.callback([{isIntersecting:true,target:node}]);}};
  const article=()=>{const node=new Node('article');node.setAttribute('data-document-markdown','');host.append(node);return node;};
  const code=(parent,raw)=>{const pre=new Node('pre'),code=new Node('code');pre.setAttribute('data-document-code','');code.setAttribute('data-language','js');code.textContent=raw;pre.append(code);parent.append(pre);return {pre,code};};
  const link=(parent,id)=>{const node=new Node('a');node.setAttribute('href','#'+id);node.setAttribute('data-document-anchor',id);parent.append(node);return node;};
  const click=target=>{const event={target,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};host.dispatch('click',event);return event;};
  const status=()=>host.children.find(node=>node.className==='document-reader-status')?.textContent;
  return {api:create(env),host,doc,Node,article,code,link,click,status,controls,writes,observers};
}
test('heading anchors stay in their owning article even when another document uses the same ID',()=>{
 const h=harness(),one=h.article(),two=h.article(),a=new h.Node('h2'),b=new h.Node('h2');a.id=b.id='chapter';one.append(a);two.append(b);const link=h.link(two,'chapter');const handle=h.api.mount(h.host);const event=h.click(link);
 assert.equal(h.doc.activeElement,b);assert.equal(a.scrolled,undefined);assert.deepEqual(b.scrolled,{block:'start',behavior:'auto'});assert.deepEqual(b.focusOptions,{preventScroll:true});assert.equal(event.prevented,true);assert.equal(event.stopped,true);handle.destroy();
});
test('missing and malformed chapter links are announced without escaping to another article',()=>{
 const h=harness(),article=h.article(),link=h.link(article,'missing');const other=h.article(),heading=new h.Node('h2');heading.id='missing';other.append(heading);h.api.mount(h.host);h.click(link);assert.equal(h.doc.activeElement,undefined);assert.match(h.status(),/没有找到/);
 link.removeAttribute('data-document-anchor');link.setAttribute('href','#%zz');h.click(link);assert.match(h.status(),/链接无效/);
});
test('footnote backlink focus preserves native keyboard tab order and destroys temporary heading focus attributes',()=>{
 const h=harness(),article=h.article(),reference=h.link(article,'note');reference.id='reference';const note=new h.Node('li');note.id='note';article.append(note);const back=h.link(note,'reference');const handle=h.api.mount(h.host);
 h.click(reference);assert.equal(h.doc.activeElement,note);h.click(back);assert.equal(h.doc.activeElement,reference);assert.equal(reference.getAttribute('tabindex'),null,'A normal reference anchor must remain reachable with Tab');handle.destroy();assert.equal(note.getAttribute('tabindex'),null,'Temporary focus attributes must not outlive the reader');
});
test('lazy code actions mount only after visibility and remount destroys old controls and observers',()=>{
 const h=harness({lazy:true}),article=h.article(),{pre}=h.code(article,'const x = 1;');const first=h.api.mount(h.host);assert.equal(h.controls.length,0);const observer=h.observers[0];assert.equal(observer.observed.has(pre),true);observer.show(pre);assert.equal(h.controls.length,1);assert.equal(observer.observed.has(pre),false);
 const second=h.api.mount(h.host);assert.equal(h.controls[0].unmounted,true);assert.equal(observer.disconnected,true);observer.show(pre);assert.equal(h.controls.length,1);h.observers[1].show(pre);assert.equal(h.controls.length,2);first.destroy();assert.equal(h.controls[1].unmounted,false);second.destroy();assert.equal(h.controls[1].unmounted,true);assert.equal(h.host.listeners.click.length,0);
});
test('copy retains exact code bytes and coalesces repeated clicks while clipboard is pending',async()=>{
 const gate=defer(),h=harness({write:()=>gate.promise}),article=h.article(),raw='\tconst 中国 = "<&>";\r\n\n';h.code(article,raw);h.api.mount(h.host);const control=h.controls[0],copy=control.props.onClick();assert.equal(control.props.loading,true);await control.props.onClick();assert.deepEqual(h.writes,[raw]);gate.resolve();await copy;assert.equal(control.props.loading,false);assert.equal(control.props.children,'已复制');assert.match(h.status(),/代码已复制/);
});
test('clipboard rejection retains code and offers a real retry',async()=>{
 let attempt=0;const h=harness({write:async()=>{if(++attempt===1)throw Error('denied');}}),article=h.article(),{code}=h.code(article,'retry me');h.api.mount(h.host);const control=h.controls[0];await control.props.onClick();assert.equal(control.props.loading,false);assert.equal(control.props.children,'重试复制');assert.equal(code.textContent,'retry me');assert.match(h.status(),/无法访问剪贴板/);await control.props.onClick();assert.equal(control.props.children,'已复制');assert.equal(h.writes.length,2);
});
test('copy finishing after code changes clears loading without claiming the new code was copied',async()=>{
 const gate=defer(),h=harness({write:()=>gate.promise}),article=h.article(),{code}=h.code(article,'old code');h.api.mount(h.host);const control=h.controls[0],copy=control.props.onClick();code.textContent='new code';gate.resolve();await copy;assert.equal(control.props.loading,false);assert.notEqual(control.props.children,'已复制');assert.doesNotMatch(h.status()||'',/代码已复制/);assert.deepEqual(h.writes,['old code']);
});
test('clipboard settlement after destroy never updates a released Kit root or detached live region',async()=>{
 for(const success of [true,false]){const gate=defer(),h=harness({write:()=>gate.promise}),article=h.article();h.code(article,'snapshot');const handle=h.api.mount(h.host),control=h.controls[0],copy=control.props.onClick();handle.destroy();const count=control.updates.length;success?gate.resolve():gate.reject(Error('denied'));await copy;assert.equal(control.updates.length,count);assert.equal(h.status(),undefined);}
});
test('managed image failure installs one text-only fallback and destroy restores the original element',()=>{
 const h=harness(),article=h.article(),image=new h.Node('img');image.className='document-managed-image';image.alt='<img src=x onerror=run()>';article.append(image);const handle=h.api.mount(h.host);image.dispatch('error');image.dispatch('error');assert.equal(image.hidden,true);const fallback=article.children.filter(node=>node.className==='document-image-unavailable');assert.equal(fallback.length,1);assert.match(fallback[0].textContent,/<img src=x onerror=run\(\)>/);assert.equal(fallback[0].children.length,0);handle.destroy();assert.equal(image.hidden,false);assert.equal(article.children.length,1);
});
test('already-failed cached managed image is detected when attaching reader interactions',()=>{
 const h=harness(),article=h.article(),image=new h.Node('img');image.className='document-managed-image';image.alt='Cached figure';image.complete=true;image.naturalWidth=0;image.setAttribute('src','/__files/figure');article.append(image);h.api.mount(h.host);assert.equal(image.hidden,true);assert.equal(article.children.some(node=>node.className==='document-image-unavailable'),true);
});
test('queued intersection entries never install duplicate controls on the same code block',()=>{
 const h=harness({lazy:true}),article=h.article(),{pre}=h.code(article,'one control');h.api.mount(h.host);h.observers[0].callback([{isIntersecting:true,target:pre},{isIntersecting:false,target:pre},{isIntersecting:true,target:pre}]);assert.equal(h.controls.length,1);
});

test('document link buttons route keyboard-generated clicks only through the owning reader callback',async()=>{
 const h=harness(),article=h.article(),button=new h.Node('button'),calls=[];button.setAttribute('data-document-local-path','docs/second.md');button.setAttribute('data-document-fragment','章节');article.append(button);
 h.api.mount(h.host,{onOpenDocumentLink:(target,options)=>calls.push({target,options})});const event=h.click(button);await Promise.resolve();await Promise.resolve();
 assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.deepEqual(calls[0].target,{path:'docs/second.md',fragment:'章节'});assert.equal(calls[0].options.anchor,button);assert.equal(calls[0].options.isCurrent(),true);
 assert.equal(button.getAttribute('href'),null);
});
test('fast A/B document link clicks invalidate the first intent, including already-started preflight',async()=>{
 const h=harness(),article=h.article(),buttons=['a.md','b.md'].map(path=>{const b=new h.Node('button');b.setAttribute('data-document-local-path',path);article.append(b);return b;}),calls=[];
 h.api.mount(h.host,{onOpenDocumentLink:(target,options)=>calls.push({target,options})});h.click(buttons[0]);await Promise.resolve();h.click(buttons[1]);await Promise.resolve();
 assert.equal(calls.length,2);assert.equal(calls[0].options.isCurrent(),false);assert.equal(calls[1].options.isCurrent(),true);
 h.click(buttons[0]);h.click(buttons[1]);await Promise.resolve();assert.equal(calls.length,3,'Only the last queued activation may begin');assert.equal(calls[2].target.path,'b.md');
});
test('failed document navigation reports without altering the article and disposed readers ignore late failures',async()=>{
 const gate=defer(),h=harness(),article=h.article(),b=new h.Node('button');b.setAttribute('data-document-local-path','missing.md');article.append(b);
 const handle=h.api.mount(h.host,{onOpenDocumentLink:()=>gate.promise});h.click(b);await Promise.resolve();gate.reject(Error('文件不存在，当前文档仍保留。'));for(let i=0;i<5;i++)await Promise.resolve();assert.match(h.status(),/文件不存在/);assert.equal(article.children[0],b);
 const late=defer();h.api.mount(h.host,{onOpenDocumentLink:()=>late.promise});h.click(b);await Promise.resolve();h.api.mount(h.host);late.reject(Error('late'));for(let i=0;i<5;i++)await Promise.resolve();assert.notEqual(h.status(),'late');handle.destroy();
});
test('no owner callback never falls back to browser-relative navigation',()=>{
 const h=harness(),article=h.article(),b=new h.Node('button');b.setAttribute('data-document-local-path','second.md');article.append(b);h.api.mount(h.host);const event=h.click(b);assert.equal(event.prevented,true);assert.match(h.status(),/没有可用的本机文件上下文/);
});
