'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const Recovery=require('../app/note-editor-recovery.js');
const Store=require('../app/note-draft-store.js');
const Editor=require('../app/note-editor.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(t){
 const state={notes:['a','b'].map(id=>({id,title:id,content:`${id} original`,workspace:'日常',updatedAt:1}))};
 const disk=new Map(),stores=[],holds=[],posts=[],cleared=[];
 let session=null,props,writeFailure=false;
 const record=id=>clone(disk.get(id)||{revision:0,session:null});
 const fetch=async(route,options)=>{
  const id=new URL(route,'http://fixture.invalid').searchParams.get('id'),write=options.method==='POST';
  const index=holds.findIndex(hold=>hold.id===id&&hold.write===write);
  if(index>=0){const [hold]=holds.splice(index,1);hold.started.resolve();await hold.release.promise;}
  if(!write)return {ok:true,json:async()=>record(id)};
  const body=JSON.parse(options.body),current=record(id);posts.push({id,...body});
  if(writeFailure)return {ok:false,json:async()=>({code:'draft_write_failed',message:'disk full'})};
  if(body.revision!==current.revision)return {ok:false,json:async()=>({code:'draft_conflict',message:'another window'})};
  const result={revision:current.revision+1,session:body.session};disk.set(id,result);
  return {ok:true,json:async()=>clone(result)};
 };
 const recovery=Recovery.create({getState:()=>state,getSession:()=>session,begin:Editor.begin,dirty:Editor.dirty,onRestore:value=>{session=value||Editor.begin(state,session.id)},onCleared:id=>cleared.push(id)},{
  fetch,crypto:webcrypto,
  NoteDraftStore:{create:options=>{const store=Store.create({...options,delay:2147483647});stores.push(store);return store;}},
  HalaskaUI:{mount(_host,_name,value){props=value;return {update:value=>props=value,unmount(){}};}}
 });
 t.after(()=>{recovery.unmount();stores.forEach(store=>store.dispose());});
 return {state,disk,record,posts,cleared,recovery,props:()=>props,session:()=>session,failWrites:value=>writeFailure=value,
  mount(id,existing){session=existing||Editor.begin(state,id);return recovery.mount({},id);},
  change(content){session.content=content;recovery.remember(session);},
  commit(){const change=Editor.prepare(state,session);Object.assign(change.note,change.after);session=Editor.begin(state,session.id);},
  hold(id,write=false){const hold={id,write,started:deferred(),release:deferred()};holds.push(hold);return hold;},
  async winner(id,content,revision){const other=Editor.begin(state,id);other.content=content;other.base='sha256:'+Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(other.base))).toString('hex');disk.set(id,{revision,session:other});}
 };
}
test('navigation during explicit conflict reload cannot falsely acknowledge the old visible draft',async t=>{
 const f=fixture(t);await f.mount('a');f.change('my first edit');assert.equal(await f.recovery.flushAll(),true);
 await f.winner('a','other window wins',10);
 f.change('my later edit');assert.equal(await f.recovery.flushAll(),false);
 const retained=clone(f.session()),hold=f.hold('a');
 f.props().onReload();const pending=f.props().onConfirmReload();await hold.started.promise;
 await f.mount('b');hold.release.resolve();await pending;
 await f.mount('a',retained);
 const flushed=await f.recovery.flushAll();
 // Returning may apply the explicitly loaded winner or preserve local input
 // behind a conflict decision. It cannot call a different visible body saved.
 assert.ok(f.session().content===f.record('a').session.content || !flushed,
  `visible=${f.session().content}; disk=${f.record('a').session.content}; status=${f.props().state}; flush=${flushed}`);
});
test('an existing dirty session that leaves during its initial read cannot be skipped by exit flush',async t=>{
 const f=fixture(t),draft={...Editor.begin(f.state,'a'),content:'A only exists in the window'},hold=f.hold('a');
 const pending=f.mount('a',draft);await hold.started.promise;
 await f.mount('b');hold.release.resolve();await pending;
 const flushed=await f.recovery.flushAll();
 assert.ok(f.record('a').session?.content===draft.content || !flushed,'Exit acknowledged an unpersisted background draft');
});
test('late clear acknowledgement cannot forget a newer draft and resurrect it after undo',async t=>{
 const f=fixture(t);await f.mount('a');f.change('First draft');await f.recovery.flushAll();
 const hold=f.hold('a',true),clearing=f.recovery.discard('a');await hold.started.promise;
 // A forced remount/new editor can produce input while an older clear waits.
 await f.mount('a',{...Editor.begin(f.state,'a'),content:'Newer draft'});
 hold.release.resolve();await clearing;
 f.change('a original');assert.equal(await f.recovery.flushAll(),true);
 assert.equal(f.record('a').session,null,'Old clear completion hid the newer slot, so undo left a recoverable ghost draft');
});
test('formal-save cleanup notifies the editor only after a confirmed successful retry',async t=>{
 const f=fixture(t);await f.mount('a');f.change('Committed note');await f.recovery.flushAll();f.commit();
 f.failWrites(true);assert.equal(await f.recovery.saved('a'),false);assert.deepEqual(f.cleared,[]);
 assert.equal(f.record('a').session.content,'Committed note');
 f.failWrites(false);assert.equal(await f.props().onRetry(),true);
 assert.equal(f.record('a').session,null);assert.deepEqual(f.cleared,['a']);
 assert.equal(f.state.notes[0].content,'Committed note');
});
test('an older formal-save cleanup cannot notify the editor to drop a newer session',async t=>{
 const f=fixture(t);await f.mount('a');f.change('Committed note');await f.recovery.flushAll();f.commit();
 const hold=f.hold('a',true),clearing=f.recovery.saved('a');await hold.started.promise;
 await f.mount('a',{...Editor.begin(f.state,'a'),content:'New edits after save'});
 hold.release.resolve();assert.equal(await clearing,false);
 assert.deepEqual(f.cleared,[]);assert.equal(f.record('a').session.content,'New edits after save');
 assert.equal(await f.recovery.flushAll(),true);
});
