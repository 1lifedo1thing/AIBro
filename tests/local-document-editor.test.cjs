const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../app/local-document-editor.js');
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for(let i=0;i<15;i++) await Promise.resolve(); };
const raw = '\uFEFF# 原样\r\n\r\n正文\n尾行\r';
function harness(options = {}) {
  const elements = [], handles = [], toolbars = [], calls = [], stores = [], markdownCalls = [];
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.hidden = false; this.scrollTop = 0; this.scrollLeft = 0; this.textContent = ''; this.style = { setProperty: (key,value) => { this.style[key] = value; } }; elements.push(this); }
    get ownerDocument() { return document; }
    get isConnected() { for(let n=this;n;n=n.parentElement) if(n===document.body) return true; return false; }
    append(...nodes) { for(const node of nodes) { node.remove(); node.parentElement=this;this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(n=>n.parentElement=null);this.children=[];this.append(...nodes); }
    remove() { if(this.parentElement) this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null; }
    setAttribute(k,v) {this.attrs[k]=String(v);}
    addEventListener(k,v) {(this.listeners[k] ||= []).push(v);}
    querySelectorAll(selector) { const result=[];const matches=c=>selector.split(',').some(s=>s.startsWith('.')?c.className?.split(' ').includes(s.slice(1)):c.tagName===s.toUpperCase());const walk=n=>n.children.forEach(c=>{if(matches(c))result.push(c);walk(c);});walk(this);return result; }
    querySelector(selector) {return this.querySelectorAll(selector)[0]||null;}
    focus() {document.activeElement=this;}
    scrollIntoView() {this.scrolled=true;}
    closest(selector) {for(let n=this;n;n=n.parentElement) if(selector.startsWith('#') && n.id===selector.slice(1)) return n;return null;}
    set innerHTML(value) {this.html=value;this.replaceChildren();for(const match of String(value).matchAll(/<(h[1-6])([^>]*)>([\s\S]*?)<\/h[1-6]>/g)){const h=new Element(match[1]);h.textContent=match[3].replace(/<[^>]+>/g,'');h.id=/\bid="([^"]*)"/.exec(match[2])?.[1]||'';const start=/data-document-source-start="(\d+)"/.exec(match[2]);if(start)h.dataset.documentSourceStart=start[1];this.append(h);}}
  }
  const document={createElement:tag=>new Element(tag)};document.body=new Element('body');const host=new Element('div');document.body.append(host);
  const env={document, ReadingPane:{resume(){}}};
  if(options.history)env.DocumentEditHistory=require('./editor-history-fixture.cjs');
  if(options.documentMarkdown)env.DocumentMarkdown=options.documentMarkdown;
  if(options.reader)env.DocumentReading=options.reader;
  const mount = kind => (target, config) => {
    let value=config.value, composing=false, range={start:0,end:0,direction:'none',exact:true};
    const imageJobs = new Set();
    const h={kind,config,target,ready:options.ready?.(kind)||Promise.resolve(true),destroyed:false,sets:[],
      getValue:()=>value,setValue(next){if(composing)return false;h.sets.push(next);value=next;return true;},setDisabled(v){h.disabled=v;if(v&&imageJobs.size)h.imagesCanceled=true;},
      selectionSource:()=>range,setSelectionRange(start,end,direction){range={start,end,direction,exact:true};},focus(){target.focus();},
      isComposing:()=>composing,flushPending:async()=>!composing&&(await Promise.all([...imageJobs])).every(Boolean),destroy(){h.destroyed=true;},find(){h.findCalled=true;},
      type(next){assert.equal(h.destroyed,false);assert.equal(h.disabled,false);value=next;config.onChange(next);},
      silent(next){value=next;},compose(v){composing=v;},isImageBusy:()=>imageJobs.size>0,
      insertImageFiles(files){
        if(h.disabled||h.destroyed||!config.onUploadImage)return Promise.resolve(false);
        let resolve;const task=new Promise(r=>resolve=r);imageJobs.add(task);config.onImageBusy?.(imageJobs.size);
        void(async()=>{let ok=true;try{for(const file of files){const result=await config.onUploadImage(file);if(h.imagesCanceled||h.destroyed){ok=false;break;}value+='\n!['+result.alt+']('+result.url+')';config.onChange(value);}}catch(error){ok=false;config.onError?.(error);}imageJobs.delete(task);resolve(ok);config.onImageBusy?.(imageJobs.size);})();return task;
      }
    };if(options.history)require('./editor-history-fixture.cjs').augment(h,config);handles.push(h);if(kind==='visual')config.onStatus?.({supported: options.unsupported!==true,reason:'特殊语法保留'});return h;
  };
  env.DocumentEditors={ensure:()=>options.ensure?.promise||Promise.resolve(true)};
  env.DocumentSourceEditor={mount:mount('source')};env.DocumentVisualEditor={mount:mount('visual')};
  env.DocumentImages={encodeFile:async file=>options.encodeWait?await options.encodeWait.promise:'encoded-image',pickFiles:()=>options.picker?.promise||Promise.resolve(options.files||[])};
  env.HalaskaUI={mount(target,name,props){assert.equal(name,'DocumentToolbar');const h={props,update(next){h.props={...h.props,...next};},unmount(){h.destroyed=true;}};toolbars.push(h);return h;}};
  env.LocalDocumentDrafts={create(config){const s={pending:false,session:null,
    load:()=>options.draftLoad?.promise||Promise.resolve(options.recovery||{session:null}),
    schedule(value){s.session=value;s.pending=true;calls.push(['draft',value]);},
    flush:async()=>{calls.push(['flush']);if(options.flushFail)return false;if(options.flushWait)await options.flushWait.promise;s.pending=false;return true;},
    clear:async()=>{calls.push(['clear']);if(options.clearFail)return false;s.pending=false;s.session=null;return true;},
    hasPending:()=>s.pending,dispose(){s.disposed=true;}
  };stores.push(s);return s;}};
  let disk={content:options.content??raw,version:'v1'}, invalid=false;
  const api=create({markdown:(value,config)=>{markdownCalls.push({value,config});return options.markdown?options.markdown(value,config):value;},valid(){if(invalid)throw Error('disconnected');},
    readFile:()=>options.read?.promise||Promise.resolve({...disk}),
    request:async(url,payload)=>{calls.push([url,payload]);if(url.endsWith('/document-images/upload'))return options.upload?.promise||{url:'a.assets/hash.png',alt:'图片'};if(url.endsWith('/propose')){if(payload.version!==disk.version)throw Error('version conflict');return {id:'p'};}if(url.endsWith('/apply')){if(options.apply)return options.apply.promise;disk={content:calls.findLast(c=>c[0].endsWith('/propose'))[1].content,version:'v2'};return{id:'p',afterVersion:'v2'};}return {};},
    onSaved:()=>calls.push(['saved']),isPrivate:()=>!!options.privateNow,draftRequest(){},toast(){},
    resolveDocumentLink:options.resolveDocumentLink,openDocumentLink:options.openDocumentLink
  },env);
  const ref={id:'["p","c","a.md"]',projectId:'p',candidateId:'c',path:'a.md',title:'a.md'};
  return {api,host,ref,handles,stores,calls,toolbars,markdownCalls,el:cls=>elements.findLast(e=>e.className?.split(' ').includes(cls)&&e.isConnected),status:()=>elements.findLast(e=>e.className==='local-document-status'&&e.isConnected)?.textContent,mount:(opts={})=>api.mount(host,ref,opts),current:kind=>handles.findLast(h=>h.kind===kind&&!h.destroyed),
    action:key=>elements.findLast(e=>e.dataset.localDocumentAction===key&&e.isConnected),disk:()=>disk,external:content=>disk={content,version:'external'},disconnect:()=>invalid=true};
}
test('actual local host uses Kit toolbar and modern engines preserving raw unchanged modes', async()=>{
  const h=harness();assert.equal(await h.mount(),true);assert.equal(h.toolbars.length,1);assert.equal(h.handles.length,0);
  await h.api.setMode('rich');assert.equal(h.current('visual').getValue(),raw);await h.api.setMode('edit');assert.equal(h.current('source').getValue(),raw);
  await h.api.setMode('rich');await h.api.setMode('read');assert.equal(h.api.current().dirty,false);assert.equal(h.api.currentContent().content,raw);assert.equal(h.calls.some(c=>c[0].includes('/edits')),false);
});
test('save samples synchronous live editor state, preserves version proposal and coalesces double submit',async()=>{
  const h=harness();await h.mount();await h.api.setMode('rich');h.current('visual').silent(raw+'变化');
  const first=h.api.save(), second=h.api.save();assert.equal(first,second);assert.equal(await first,true);
  const proposes=h.calls.filter(c=>c[0].endsWith('/propose'));assert.equal(proposes.length,1);assert.equal(proposes[0][1].content,raw+'变化');assert.equal(proposes[0][1].version,'v1');assert.equal(h.disk().content,raw+'变化');assert.equal(h.api.current().dirty,false);
});
test('mode switches synchronize only changed content without resetting histories',async()=>{
  const h=harness();await h.mount({mode:'edit'});const source=h.current('source');source.type(raw+'源码');await h.api.setMode('rich');const visual=h.current('visual');visual.type(raw+'可视');await h.api.setMode('edit');assert.equal(source.getValue(),raw+'可视');
  const count=source.sets.length;await h.api.setMode('rich');await h.api.setMode('edit');assert.equal(source.sets.length,count);assert.equal(h.disk().content,raw);
});
test('unsupported visual syntax falls back to source with exact original content',async()=>{
  const h=harness({unsupported:true});await h.mount({mode:'rich'});assert.equal(h.api.current().mode,'edit');assert.equal(h.current('source').getValue(),raw);assert.equal(h.api.current().dirty,false);assert.equal(h.toolbars.at(-1).props.canVisual,false);
});
test('IME stops disk save, mode switch, suspend, and unmount until committed',async()=>{
  const h=harness();await h.mount({mode:'edit'});const source=h.current('source');source.compose(true);source.silent(raw+'候选');
  assert.equal(await h.api.save(),false);assert.equal(await h.api.setMode('read'),false);assert.equal(await h.api.suspend({release:true}),false);assert.equal(h.api.unmount(),false);assert.equal(h.api.current().mode,'edit');
  source.compose(false);source.type(raw+'中文');assert.equal(await h.api.save(),true);assert.equal(h.disk().content,raw+'中文');
});
test('suspend durably keeps draft without writing file, then resumes content and selection',async()=>{
  const h=harness();await h.mount({mode:'edit'});const source=h.current('source');source.type(raw+'草稿');source.setSelectionRange(4,8,'backward');
  assert.equal(await h.api.suspend({release:true}),true);assert.equal(h.api.current(),null);assert.equal(h.disk().content,raw);assert.ok(h.calls.some(c=>c[0]==='flush'));
  // Simulate durable server response on remount with retained in-memory draft.
  await h.mount();assert.equal(h.api.currentContent().content,raw+'草稿');assert.deepEqual(h.api.capturePosition().selection,{start:4,end:8,direction:'backward'});
});
test('failed durable draft write prevents teardown and preserves user text',async()=>{
  const h=harness({flushFail:true});await h.mount({mode:'edit'});h.current('source').type(raw+'保留');assert.equal(await h.api.suspend({release:true}),false);assert.equal(h.api.currentContent().content,raw+'保留');assert.equal(h.api.unmount(),false);
});
test('new input after successful flush revokes teardown permission',async()=>{
  const h=harness();await h.mount({mode:'edit'});h.current('source').type(raw+'a');assert.equal(await h.api.suspend(),true);h.current('source').type(raw+'b');assert.equal(h.api.unmount(),false);
});
test('late file or draft loading cannot replace an already remounted document',async()=>{
  const read=defer(),h=harness({read});const first=h.mount();await settle();h.api.unmount({force:true});const other={...h.ref,id:'other',path:'b.md'};const second=h.api.mount(h.host,other);read.resolve({content:'后到内容',version:'v1'});assert.equal(await first,false);assert.equal(await second,true);assert.equal(h.api.current().id,'other');
});
test('late editor readiness cannot focus or write into the replacement session',async()=>{
  const ready=defer(),h=harness({ready:kind=>kind==='visual'?ready.promise:Promise.resolve(true)});await h.mount();const switching=h.api.setMode('rich');await settle();const old=h.current('visual');h.api.unmount({force:true});await h.api.mount(h.host,{...h.ref,id:'other',path:'b.txt'},{mode:'edit'});ready.resolve(true);assert.equal(await switching,false);assert.equal(old.destroyed,true);assert.equal(h.api.current().id,'other');assert.equal(h.api.current().mode,'edit');
});
test('private session never creates disk draft and requires explicit handling before suspend',async()=>{
  const h=harness();await h.mount({mode:'edit',private:true});h.current('source').type(raw+'私密');assert.equal(h.stores.length,0);assert.equal(await h.api.suspend({release:true}),false);assert.equal(h.api.currentContent().content,raw+'私密');assert.equal(await h.api.save(),true);
});
test('failed post-save draft cleanup remains unsaved until cleanup acknowledged without reapplying file',async()=>{
  const opts={clearFail:true},h=harness(opts);await h.mount({mode:'edit'});h.current('source').type(raw+'保存');assert.equal(await h.api.save(),false);assert.equal(h.disk().content,raw+'保存');assert.equal(h.api.current().dirty,true);opts.clearFail=false;assert.equal(await h.api.save(),true);assert.equal(h.calls.filter(c=>c[0].endsWith('/apply')).length,1);assert.equal(h.api.current().dirty,false);
});
test('conflict does not replace disk, then explicit compare and restore supports merge',async()=>{
  const h=harness();await h.mount({mode:'edit'});h.current('source').type(raw+'本地');h.external(raw+'外部');assert.equal(await h.api.save(),false);assert.equal(h.disk().content,raw+'外部');await h.action('compare').onclick();await h.action('use-latest').onclick();assert.equal(h.api.currentContent().content,raw+'外部');await h.action('restore-draft').onclick();assert.equal(h.api.currentContent().content,raw+'本地');h.current('source').type(raw+'合并');assert.equal(await h.api.save(),true);assert.equal(h.disk().content,raw+'合并');
});

test('cold recovery restores complete draft, raw bytes and selection without disk write',async()=>{
  const recovery={session:{content:raw+'恢复',baseContent:raw,version:'old-restarted-version',mode:'edit',selection:{start:3,end:7,direction:'backward'}}};
  const h=harness({recovery});await h.mount();assert.equal(h.api.currentContent().content,raw+'恢复');assert.deepEqual(h.api.capturePosition().selection,{start:3,end:7,direction:'backward'});assert.equal(h.disk().content,raw);
  assert.equal(await h.api.save(),true);assert.equal(h.calls.find(c=>c[0].endsWith('/propose'))[1].version,'v1','same raw disk contents safely rebase volatile version after restart');
});
test('conflict comparison retains recoverable original draft across cold restart',async()=>{
  const h=harness();await h.mount({mode:'edit'});h.current('source').type(raw+'我的草稿');h.external(raw+'磁盘');await h.action('compare').onclick();await h.action('use-latest').onclick();
  assert.equal(await h.api.suspend(),true);const stored=h.stores[0].session;assert.equal(stored.recoveryContent,raw+'我的草稿');assert.equal(stored.retainedDraft,true);
  const next=harness({recovery:{session:stored}});await next.mount();assert.equal(next.api.currentContent().content,raw+'磁盘');assert.equal(next.api.current().dirty,true);await next.action('restore-draft').onclick();assert.equal(next.api.currentContent().content,raw+'我的草稿');
});
test('missing file recovers draft read-only and refuses write while retaining raw export',async()=>{
  const read=defer();read.reject(Error('missing file'));const h=harness({read,recovery:{session:{content:raw+'未丢失',baseContent:raw,version:'v1',mode:'edit'},recoveryOnly:true}});
  assert.equal(await h.mount(),true);assert.equal(h.api.currentContent().content,raw+'未丢失');assert.equal(h.current('source').disabled,true);assert.equal(await h.api.save(),false);assert.equal(h.calls.some(c=>c[0].endsWith('/propose')),false);
});
test('save failure remains in explicit leave guard and discard needs acknowledged durable clear',async()=>{
  const options={clearFail:true},h=harness(options);await h.mount({mode:'edit'});h.current('source').type(raw+'草稿');const leaving=h.api.beforeLeave();await settle();await h.action('discard').onclick();assert.equal(h.api.currentContent().content,raw+'草稿');options.clearFail=false;await h.action('discard').onclick();assert.equal(await leaving,true);assert.equal(h.api.currentContent().content,raw);assert.equal(h.api.current().dirty,false);
});

test('changing active context to private stops the existing public draft store before new input',async()=>{
  const options={},h=harness(options);await h.mount({mode:'edit'});h.current('source').type(raw+'public');const draftWrites=h.calls.filter(c=>c[0]==='draft').length;options.privateNow=true;h.current('source').type(raw+'private');assert.equal(h.stores[0].disposed,true);assert.equal(h.calls.filter(c=>c[0]==='draft').length,draftWrites);assert.equal(await h.api.suspend(),false);
});

test('inactive dirty tab metadata remains available without redundant disk reads',async()=>{
  const h=harness();await h.mount({mode:'edit'});h.current('source').type(raw+'标签草稿');assert.equal(h.api.getDraft(h.ref.id).content,raw+'标签草稿');await h.api.suspend({release:true});assert.equal(h.api.getDraft(h.ref.id).content,raw+'标签草稿');assert.equal(h.api.getDraft('missing'),null);await h.mount();await h.api.save();assert.equal(h.api.getDraft(h.ref.id),null);
});

test('new input during asynchronous suspend acknowledgement cannot gain release permission',async()=>{
  const flushWait=defer(),h=harness({flushWait});await h.mount({mode:'edit'});h.current('source').type(raw+'first');const suspending=h.api.suspend({release:true});await settle();h.current('source').type(raw+'newer');flushWait.resolve(true);assert.equal(await suspending,false);assert.equal(h.api.currentContent().content,raw+'newer');assert.equal(h.api.unmount(),false);
});

test('failed adapter readiness destroys the failed instance and retry creates a fresh editor',async()=>{
 for(const rejected of [false,true]) {
  let mounts=0;const h=harness({ready:()=>{mounts++;return mounts===1?(rejected?Promise.reject(Error('engine failure')):Promise.resolve(false)):Promise.resolve(true);}});
  await h.mount();assert.equal(await h.api.setMode('edit'),false);assert.equal(h.handles[0].destroyed,true);assert.equal(h.api.current().mode,'read');assert.equal(await h.api.setMode('edit'),true);assert.equal(mounts,2);assert.equal(h.current('source').getValue(),raw);assert.equal(h.api.current().dirty,false);
 }
});
test('export samples only ready committed content and keeps readonly recovery exportable',async()=>{
 const read=defer(),h=harness({read});const loading=h.mount();assert.equal(h.api.currentContent(),null);read.resolve({content:raw,version:'v1'});await loading;await h.api.setMode('edit');h.current('source').compose(true);assert.equal(h.api.currentContent(),null);h.current('source').compose(false);assert.equal(h.api.currentContent().content,raw);
});
test('outer bookmark captures and restores the actual reading dialog instead of preview wrapper',async()=>{
 const h=harness();h.host.parentElement.id='previewDialog';h.host.parentElement.scrollTop=472;h.host.scrollTop=0;await h.mount();assert.equal(h.api.capturePosition().scrollTop,472);h.host.parentElement.scrollTop=0;await h.api.restorePosition({mode:'read',scrollTop:472});assert.equal(h.host.parentElement.scrollTop,472);assert.equal(h.host.scrollTop,0);
});
test('both local engines persist an image before inserting relative Markdown and retain original disk body',async()=>{
 for(const mode of ['rich','edit']) {
  const h=harness();await h.mount({mode,sourceConversationId:'origin'});const engine=h.current(mode==='rich'?'visual':'source');
  assert.equal(await engine.insertImageFiles([{name:'sample.png'}]),true);
  const call=h.calls.find(c=>c[0]==='/__local/document-images/upload');
  assert.deepEqual(call[1],{candidateId:'c',projectId:'p',path:'a.md',name:'sample.png',data:'encoded-image',sourceConversationId:'origin'});
  assert.match(h.api.currentContent().content,/a\.assets\/hash\.png/);assert.equal(h.disk().content,raw);
  assert.equal(h.api.current().dirty,true);assert.equal(h.api.current().imageBusy,false);
 }
});
test('save during image upload waits for insertion without disabling and canceling the engine',async()=>{
 const upload=defer(),h=harness({upload});await h.mount({mode:'rich'});const visual=h.current('visual');
 const insertion=visual.insertImageFiles([{name:'held.png'}]);await settle();
 assert.equal(h.api.current().imageBusy,true);assert.equal(h.api.currentContent(),null);assert.equal(h.api.unmount(),false);
 const saving=h.api.save();await settle();assert.equal(visual.disabled,false);assert.equal(h.calls.some(c=>c[0].endsWith('/propose')),false);
 upload.resolve({url:'a.assets/held.png',alt:'held'});assert.equal(await insertion,true);assert.equal(await saving,true);
 assert.equal(visual.imagesCanceled,undefined);assert.match(h.disk().content,/a\.assets\/held\.png/);
});
test('failed image insertion preserves exact text and visible failure instead of a false saved status',async()=>{
 const upload=defer(),h=harness({upload});await h.mount({mode:'edit'});
 const insertion=h.current('source').insertImageFiles([{name:'broken.png'}]);await settle();const saving=h.api.save();await settle();
 upload.reject(Error('image disk full'));assert.equal(await insertion,false);assert.equal(await saving,false);
 assert.equal(h.disk().content,raw);assert.equal(h.api.currentContent().content,raw);assert.match(h.status(),/image disk full/);
 assert.equal(h.calls.some(c=>c[0].endsWith('/propose')),false);
});
test('export waits pending image and returns current draft plus precise scoped identity',async()=>{
 const upload=defer(),h=harness({upload});await h.mount({mode:'edit',sourceConversationId:'origin'});
 const insertion=h.current('source').insertImageFiles([{name:'held.png'}]);await settle();
 let completed=false;const exporting=h.api.prepareExport().then(value=>{completed=true;return value;});await settle();assert.equal(completed,false);
 upload.resolve({url:'a.assets/draft.png',alt:'draft'});assert.equal(await insertion,true);
 const result=await exporting;assert.deepEqual(result.ref,h.ref);assert.equal(result.sourceConversationId,'origin');assert.match(result.content,/draft\.png/);assert.equal(h.disk().content,raw);
});
test('private local image insertion reports restriction before encoding or file writes',async()=>{
 const h=harness();await h.mount({mode:'edit',private:true});
 assert.equal(await h.current('source').insertImageFiles([{name:'private.png'}]),false);
 assert.equal(h.calls.some(c=>c[0].endsWith('/upload')),false);assert.match(h.status(),/私密/);assert.equal(h.api.currentContent().content,raw);
});
test('late upload response after forced teardown cannot insert into either old or replacement file',async()=>{
 const upload=defer(),h=harness({upload});await h.mount({mode:'edit'});const old=h.current('source');
 const inserting=old.insertImageFiles([{name:'late.png'}]);await settle();h.api.unmount({force:true});
 await h.api.mount(h.host,{...h.ref,id:'other',path:'b.md'},{mode:'edit'});upload.resolve({url:'a.assets/late.png',alt:'late'});
 assert.equal(await inserting,false);assert.equal(h.api.currentContent().content,raw);assert.equal(h.api.current().id,'other');
});
test('grant revoked during asynchronous encoding stops upload before a disk request',async()=>{
 const encodeWait=defer(),h=harness({encodeWait});await h.mount({mode:'edit'});
 const inserting=h.current('source').insertImageFiles([{name:'late.png'}]);await settle();h.disconnect();encodeWait.resolve('encoded');
 assert.equal(await inserting,false);assert.equal(h.calls.some(c=>c[0].endsWith('/upload')),false);assert.match(h.status(),/disconnected/);
});
test('local preview and visual images resolve against document identity without external requests',async()=>{
 const h=harness();await h.mount({sourceConversationId:'origin'});
 const resolve=h.markdownCalls[0].config.resolveImageUrl;
 const expected='/__local/document-images/read?candidateId=c&projectId=p&path=a.md&image=..%2Fassets%2Fimage%20one.png&sourceConversationId=origin';
 assert.equal(resolve('../assets/image one.png'),expected);
 for(const invalid of ['https://example.com/image.png','file:///tmp/a.png','//example.com/a.png','/etc/passwd'])assert.equal(resolve(invalid),'');
 await h.api.setMode('rich');assert.equal(h.current('visual').config.resolveImageUrl('../assets/image one.png'),expected);
});
test('toolbar image picker retains active editor selection and canceled picker never writes',async()=>{
 const picker=defer(),h=harness({picker});await h.mount({mode:'edit'});const source=h.current('source');source.setSelectionRange(3,7,'forward');
 const choosing=h.toolbars[0].props.onInsertImage();await settle();assert.equal(h.api.current().imageBusy,true);assert.equal(h.api.unmount(),false);
 picker.resolve([]);assert.equal(await choosing,true);assert.deepEqual(h.api.capturePosition().selection,{start:3,end:7,direction:'forward'});
 assert.equal(h.api.current().imageBusy,false);assert.equal(h.calls.some(c=>c[0].endsWith('/upload')),false);
});
test('non-Markdown local source does not offer image insertion',async()=>{
 const h=harness();await h.api.mount(h.host,{...h.ref,path:'script.py'},{mode:'edit'});
 assert.equal(h.toolbars[0].props.onInsertImage,undefined);assert.equal(h.current('source').config.onUploadImage,undefined);
});
test('local AST outline uses frontmatter raw offsets and navigates reading and source without writes',async()=>{
 const markdown=await import('../app/editor/document-markdown.js');
 const content='\ufeff+++\r\ntitle="Exact"\r\n+++\r\n> # Quoted\n\n> ```md\n> # Not a heading\n> ```\n\n# Last';
 const h=harness({content,documentMarkdown:markdown,markdown:(raw,opts)=>markdown.render(raw,{...opts,idPrefix:'local-file'})});await h.mount();
 const outline=h.el('local-document-outline'),headings=markdown.headings(content);assert.equal(outline.querySelectorAll('button').length,2);
  await outline.querySelectorAll('button')[1].onclick();assert.equal(h.el('local-document-preview').querySelectorAll('h1')[1].scrolled,true);assert.equal(h.api.current().mode,'read');
  assert.equal(h.el('local-document-preview').querySelectorAll('h1')[1].attrs.tabindex,'-1');
 await h.api.setMode('edit');h.toolbars[0].props.onOutline();await outline.querySelectorAll('button')[0].onclick();
 assert.deepEqual(h.api.capturePosition().selection,{start:headings[0].start,end:headings[0].end,direction:'forward'});
 assert.equal(h.api.capturePosition().outlineOpen,true);assert.equal(h.disk().content,content);assert.equal(h.api.current().dirty,false);
});
test('local hidden editing outline does not parse per key and reader interaction handles follow DOM lifetime',async()=>{
 const markdown=await import('../app/editor/document-markdown.js');let parses=0,mounts=0,destroys=0;
 const h=harness({documentMarkdown:{headings(raw){parses++;return markdown.headings(raw);}},markdown:raw=>markdown.render(raw),reader:{mount(){mounts++;return{destroy(){destroys++;}};}}});await h.mount();
 const initialParses=parses;await h.api.setMode('edit');h.current('source').type(raw+'\n# One');h.current('source').type(raw+'\n# Two');
 assert.equal(parses,initialParses);assert.equal(mounts,1);h.toolbars[0].props.onOutline();assert.equal(parses,initialParses+1);
 await h.api.setMode('read');assert.equal(mounts,2);assert.equal(destroys,1);await h.api.setMode('edit');await h.api.setMode('read');assert.equal(mounts,2);
 h.api.unmount({force:true});assert.equal(destroys,2);
});
test('local outline bookmark restores open state and IME blocks source navigation',async()=>{
 const markdown=await import('../app/editor/document-markdown.js');const h=harness({content:'# One\n\n# Two',documentMarkdown:markdown,markdown:markdown.render});await h.mount({mode:'edit'});
 await h.api.restorePosition({mode:'edit',outlineOpen:true,selection:{start:0,end:0,direction:'none'}});
 assert.equal(h.toolbars[0].props.outlineOpen,true);const source=h.current('source');source.compose(true);
 assert.equal(await h.el('local-document-outline').querySelectorAll('button')[1].onclick(),false);assert.equal(h.api.capturePosition().selection.start,0);
 source.compose(false);await h.el('local-document-outline').querySelectorAll('button')[1].onclick();assert.equal(h.api.capturePosition().selection.start,7);
});

test('local reader and rich link opening share the exact bound source identity and reject retired sessions',async()=>{
 let reader;const calls=[];
 const h=harness({reader:{mount(_host,options){reader=options;return{destroy(){}};}},resolveDocumentLink:(ref,url)=>{calls.push(['resolve',ref,url]);return{path:'second.md',fragment:'章节'};},openDocumentLink:(ref,target,navigation)=>{calls.push(['open',ref,target,navigation]);return true;}});
 await h.mount();const firstReader=reader,config=h.markdownCalls[0].config;
 assert.deepEqual(config.resolveDocumentLink('second.md'),{path:'second.md',fragment:'章节'});assert.equal(calls[0][1].id,h.ref.id);
 await reader.onOpenDocumentLink({path:'second.md',fragment:'章节'},{isCurrent:()=>true});assert.equal(calls.at(-1)[1].id,h.ref.id);assert.equal(calls.at(-1)[3].isCurrent(),true);
 await h.api.setMode('rich');const visual=h.current('visual');await visual.config.onOpenDocumentLink('#%E7%BB%93%E8%AE%BA',{isCurrent:()=>true});assert.deepEqual(calls.at(-1)[2],{path:'a.md',fragment:'结论'});
 await visual.config.onOpenDocumentLink('second.md',{isCurrent:()=>true});assert.equal(calls.at(-1)[2].path,'second.md');const saved=calls.length;
 h.api.unmount({force:true});assert.equal(await firstReader.onOpenDocumentLink({path:'second.md'}),false);assert.equal(calls.length,saved);assert.equal(config.resolveDocumentLink('second.md'),null);
});
test('link-origin navigation waits for the real local dirty draft decision and Continue editing retains content',async()=>{
 let reader,h;const calls=[];
 h=harness({reader:{mount(_host,options){reader=options;return{destroy(){}};}},openDocumentLink:async(_ref,target,navigation)=>{calls.push('before-leave');if(!(await h.api.beforeLeave())||!navigation.isCurrent())return false;calls.push('open');return true;}});
 await h.mount({mode:'edit'});h.current('source').type(raw+'draft');await h.api.setMode('read');
 const pending=reader.onOpenDocumentLink({path:'second.md',fragment:null},{isCurrent:()=>true});await settle();assert.equal(h.el('note-document-leave').hidden,false);h.action('stay').onclick();assert.equal(await pending,false);assert.deepEqual(calls,['before-leave']);assert.equal(h.api.currentContent().content,raw+'draft');assert.equal(h.disk().content,raw);
});
test('target fragment uses rendered duplicate heading IDs without a second URL decode or disk save',async()=>{
 const markdown=await import('../app/editor/document-markdown.js'),revealed=[];
 const h=harness({content:'# 结论\n\n# 结论',documentMarkdown:markdown,markdown:(text,opts)=>markdown.render(text,{...opts,idPrefix:'local-document'}),reader:{mount(){return{destroy(){},reveal:id=>{revealed.push(id);return true;}};}}});
 await h.mount({mode:'rich'});assert.equal(await h.api.revealFragment('结论-1'),true);assert.equal(h.api.current().mode,'read');assert.deepEqual(revealed,[markdown.headings('# 结论\n\n# 结论',{idPrefix:'local-document'})[1].id]);assert.equal(h.calls.some(c=>c[0].includes('/edits')),false);
 assert.equal(await h.api.revealFragment('%E7%BB%93%E8%AE%BA'),false);assert.match(h.status(),/没有找到链接指定的章节/);assert.equal(h.api.currentContent().content,'# 结论\n\n# 结论');
});

test('a target disappearing after link preflight keeps its actual read failure instead of a missing-section message',async()=>{
 const read=defer(),h=harness({read}),opening=h.mount();read.reject(Error('文件不存在或连接已撤销'));
 assert.equal(await opening,false);const status=h.status();assert.match(status,/文件不存在或连接已撤销/);assert.equal(await h.api.revealFragment('章节'),false);assert.equal(h.status(),status);
});


test('real local host retains mode history across save and reload resets only old editor history',async()=>{
 const h=harness({history:true});await h.mount({mode:'rich'});h.current('visual').type(raw+'可视');await h.api.setMode('edit');h.current('source').type(raw+'源码');await h.api.setMode('rich');
 h.current('visual').config.onHistory('undo');await settle();assert.equal(h.api.current().mode,'edit');assert.equal(h.api.currentContent().content,raw+'可视');assert.match(h.status(),/已撤销源码/);
 assert.equal(await h.api.save(),true);h.current('source').config.onHistory('undo');await settle();assert.equal(h.api.current().mode,'rich');assert.equal(h.api.currentContent().content,raw);assert.equal(h.disk().content,raw+'可视');
 h.current('visual').config.onHistory('redo');await settle();assert.equal(h.api.currentContent().content,raw+'可视');h.external(raw+'外部');await h.action('reload').onclick();h.current('visual').type(raw+'外部新改');h.current('visual').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,raw+'外部');h.current('visual').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,raw+'外部');
});
