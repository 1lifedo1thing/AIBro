const test=require('node:test'),assert=require('node:assert/strict'),Canvas=require('../app/canvas-edit');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function harness(content='first repeated\n\nsecond repeated',generate){
 const document={id:'note',title:'Fixture',content,baseVersion:'v1',version:'v1',available:true,saving:false};
 const writes=[],events=[],requests=[];const controller=Canvas.createSession({read:()=>document,writeDraft:(content,range)=>{writes.push({content,range});document.content=content;return true;},onChange:value=>events.push(value),generate:request=>{requests.push(request);return generate?generate(request):Promise.resolve({text:'rewritten'});}});
 return {document,writes,events,requests,controller};
}
test('source offsets target the selected duplicate including CRLF, BOM frontmatter and Unicode',async()=>{
 const initial='\uFEFF---\r\ntitle: Keep  exact\r\n---\r\n\r\n重复 👩‍💻\r\n\r\n重复 👩‍💻\r\n';
 const h=harness(initial),start=initial.lastIndexOf('重复');h.controller.open({start,end:initial.length-2});h.controller.instruction('只改第二次出现');
 await h.controller.generate();assert.equal(h.controller.apply(),true);
 assert.equal(h.document.content,initial.slice(0,start)+'rewritten\r\n');assert.equal(h.requests[0].selection.text,'重复 👩‍💻');
 assert.equal(h.controller.undo(),true);assert.equal(h.document.content,initial);
});
test('textarea mapping retains exact unchanged bytes and replaces only its normalized edit range',()=>{
 const original='\uFEFF---\r\ntitle: A\r\n---\n\n重复😀\r\n重复😀\n';
 const normalized=Canvas.display(original);assert.equal(Canvas.textareaEdit(original,normalized),original);
 const start=normalized.lastIndexOf('重复'),range=Canvas.displayRange(original,start,start+4);
 assert.equal(original.slice(range.start,range.end),'重复😀');
 assert.equal(Canvas.toDisplayOffset(original,range.start),start);
 assert.equal(Canvas.textareaEdit(original,normalized.slice(0,start)+'新段落'+normalized.slice(start+4)),original.slice(0,range.start)+'新段落'+original.slice(range.end));
});
test('selection validates bounds, surrogate boundaries, size and external note changes',()=>{
 const doc={id:'n',content:'a😀b',baseVersion:'v',version:'v'};
 for(const [start,end] of [[-1,2],[1,1],[0,99],[2,3],[1,2]])assert.throws(()=>Canvas.selection(doc,start,end),/选择/);
 assert.equal(Canvas.selection(doc,1,3).text,'😀');
 assert.throws(()=>Canvas.selection({...doc,content:'x'.repeat(24001)},0,24001),/24,000/);
 assert.throws(()=>Canvas.selection({...doc,version:'v2'},0,1),/外部更新/);
});
test('streaming is a proposal and cannot apply until a complete final result is returned',async()=>{
 const pending=deferred(),h=harness('Selected',request=>{request.onDelta('Par');request.onDelta('tial');return pending.promise;});
 h.controller.open({start:0,end:8});h.controller.instruction('shorten');const running=h.controller.generate();
 assert.equal(h.controller.snapshot().output,'Partial');assert.equal(h.controller.apply(),false);assert.equal(h.document.content,'Selected');
 pending.resolve({text:'Complete'});assert.equal(await running,true);assert.equal(h.controller.apply(),true);assert.equal(h.document.content,'Complete');
});
test('stop aborts the transport and invalidates even a late successful response or delta',async()=>{
 const pending=deferred(),h=harness('Selected',()=>pending.promise);h.controller.open({start:0,end:8});h.controller.instruction('rewrite');const running=h.controller.generate();
 h.requests[0].onDelta('half');h.controller.stop();assert.equal(h.requests[0].signal.aborted,true);h.requests[0].onDelta('late');pending.resolve('late complete');
 assert.equal(await running,false);assert.equal(h.controller.snapshot().status,'stopped');assert.equal(h.controller.snapshot().output,'half');assert.equal(h.controller.apply(),false);assert.equal(h.writes.length,0);
});
test('a failed final response retains its partial proposal but never marks it applicable',async()=>{
 const h=harness('Selected',async request=>{request.onDelta('Partial');throw Error('connection lost');});h.controller.open({start:0,end:8});h.controller.instruction('rewrite');
 assert.equal(await h.controller.generate(),false);assert.equal(h.controller.snapshot().output,'Partial');assert.equal(h.controller.snapshot().status,'error');assert.match(h.controller.snapshot().error,/connection lost/);assert.equal(h.controller.apply(),false);
});
test('missing final output cannot silently use the streamed prefix as a complete replacement',async()=>{
 const h=harness('Selected',async request=>{request.onDelta('Half');return {};});h.controller.open({start:0,end:8});h.controller.instruction('rewrite');assert.equal(await h.controller.generate(),false);assert.match(h.controller.snapshot().error,/完整/);assert.equal(h.controller.apply(),false);
});
test('editing any part of the draft while generating preserves the result but refuses to overwrite newer text',async()=>{
 const pending=deferred(),h=harness('Selected\nUntouched',()=>pending.promise);h.controller.open({start:0,end:8});h.controller.instruction('rewrite');const running=h.controller.generate();
 h.document.content+='\nNew human text';pending.resolve('Rewrite');await running;
 assert.equal(h.controller.snapshot().status,'ready');assert.match(h.controller.snapshot().error,/已有更新/);assert.equal(h.controller.apply(),false);assert.equal(h.writes.length,0);assert.equal(h.controller.snapshot().output,'Rewrite');
});
test('external note updates, saving and deleted documents cannot receive a ready replacement',async()=>{
 for(const change of [doc=>doc.version='remote',doc=>doc.saving=true,doc=>doc.available=false]){
  const h=harness('Selected');h.controller.open({start:0,end:8});h.controller.instruction('rewrite');await h.controller.generate();change(h.document);assert.equal(h.controller.apply(),false);assert.equal(h.writes.length,0);assert.equal(h.controller.snapshot().output,'rewritten');
 }
});
test('undo is guarded against newer manual edits and succeeds after the exact applied result is saved',async()=>{
 const h=harness('Selected');h.controller.open({start:0,end:8});h.controller.instruction('rewrite');await h.controller.generate();h.controller.apply();
 h.document.content+=' user edit';assert.equal(h.controller.undo(),false);assert.equal(h.document.content,'rewritten user edit');
 h.document.content='rewritten';h.document.baseVersion=h.document.version='v2';h.controller.saved();assert.equal(h.controller.snapshot().saved,true);assert.equal(h.controller.undo(),true);assert.equal(h.document.content,'Selected');assert.equal(h.controller.snapshot().status,'undone');
});
test('a new selection, close and disposal each prevent an older request from mutating the editor',async()=>{
 for(const action of ['selection','close','dispose']){
  const pending=deferred(),h=harness('first second',()=>pending.promise);h.controller.open({start:0,end:5});h.controller.instruction('rewrite');const running=h.controller.generate();
  if(action==='selection')h.controller.open({start:6,end:12});else h.controller[action]();h.requests[0].onDelta('late');pending.resolve('late');await running;
  assert.equal(h.writes.length,0);assert.equal(h.requests[0].signal.aborted,true);assert.equal(h.controller.snapshot()?.output||'','');
 }
});
test('selection diff preserves whole surrogate characters and distinguishes replacement from unchanged context',()=>{
 for(const [before,after] of [['😀 old suffix','😁 new suffix'],['','added'],['removed',''],['same','same']]){
  const diff=Canvas.changedParts(before,after);assert.equal(diff.prefix+diff.removed+diff.suffix,before);assert.equal(diff.prefix+diff.added+diff.suffix,after);assert.ok(Canvas.boundary(before,diff.prefix.length));assert.ok(Canvas.boundary(after,diff.prefix.length));
 }
});
test('empty instruction and excessive streamed output fail without writing the document',async()=>{
 const h=harness('Selected',async request=>{request.onDelta('x'.repeat(Canvas.MAX_OUTPUT+1));return 'final';});h.controller.open({start:0,end:8});assert.equal(await h.controller.generate(),false);assert.equal(h.requests.length,0);h.controller.instruction('rewrite');assert.equal(await h.controller.generate(),false);assert.equal(h.controller.snapshot().status,'error');assert.equal(h.requests[0].signal.aborted,true);assert.equal(h.controller.apply(),false);assert.equal(h.writes.length,0);
});
test('renderer coalesces streaming updates, publishes completion immediately and cancels pending work on disposal',async()=>{
 let latest,request,resolve,updates=0,timerId=0;
 const timers=new Map(),document={id:'n',title:'Fixture',content:'Selected',baseVersion:'v',version:'v'};
 const container={ownerDocument:{activeElement:null},hidden:true,classList:{add(){}},addEventListener(){},removeEventListener(){},querySelector(){return null;},scrollIntoView(){}};
 const environment={HalaskaUI:{componentNames:['CanvasEditSurface'],mount(_container,_name,props){latest=props;updates++;return {update(props){latest=props;updates++;},unmount(){}};}},setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},requestAnimationFrame(){return -1;},cancelAnimationFrame(){}};
 const controller=Canvas.mount(container,{read:()=>document,writeDraft:()=>true,generate:options=>{request=options;return new Promise(done=>resolve=done);}},environment);
 controller.open({start:0,end:8});latest.onInstruction('rewrite');const running=latest.onGenerate();assert.equal(latest.status,'generating');const before=updates;
 for(let i=0;i<100;i++)request.onDelta('chunk');assert.equal(updates,before);assert.equal(timers.size,1);assert.equal([...timers.values()][0].delay,60);
 const queued=[...timers.entries()][0];timers.delete(queued[0]);queued[1].fn();assert.equal(updates,before+1);assert.equal(latest.output,'chunk'.repeat(100));
 request.onDelta('trailing');assert.equal(timers.size,1);resolve('Complete replacement');await running;
 assert.equal(timers.size,0);assert.equal(latest.status,'ready');assert.equal(latest.output,'Complete replacement');
 latest.onGenerate();request.onDelta('late');assert.equal(timers.size,1);controller.dispose();assert.equal(timers.size,0);assert.equal(request.signal.aborted,true);assert.equal(container.hidden,true);
});
test('English UI exposes the selection and conflict recovery guidance in English',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),context=vm.createContext({document:{documentElement:{lang:'en'}},module:{exports:{}},AbortController});
 vm.runInContext(fs.readFileSync(require.resolve('../app/canvas-edit'),'utf8'),context);
 const canvas=context.module.exports,document={id:'n',content:'Selected',baseVersion:'v',version:'v'};
 const controller=canvas.createSession({read:()=>document,writeDraft:()=>true,generate:async()=>({text:'Replacement'})});
 controller.open({start:0,end:8});await controller.generate();assert.match(controller.snapshot().error,/Enter your rewrite instructions/);
 controller.instruction('rewrite');await controller.generate();document.content+=' newer';controller.apply();assert.match(controller.snapshot().error,/Nothing was overwritten/);
 assert.match(canvas.message('请先在正文中选择要改写的文字。'),/Select the text/);
});
