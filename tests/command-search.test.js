const test=require('node:test'),assert=require('node:assert/strict'),Command=require('../app/command-search');
test('type groups preserve existing result order and all entity IDs, including colons',()=>{
 const rows=[{type:'conversation',id:'c:1'},{type:'conversation',id:'c2'},{type:'project',id:'p'},{type:'note',id:'n1'},{type:'note',id:'n2'}],snapshot=JSON.stringify(rows),buckets=Command.groups(rows);assert.deepEqual(buckets.map(b=>[b.type,b.items.length]),[['conversation',2],['project',1],['note',2]]);assert.deepEqual(buckets.flatMap(b=>b.items),rows);assert.equal(JSON.stringify(rows),snapshot);
});
test('arrow selection moves to the next real item while Home and End reach boundaries',()=>{assert.equal(Command.nextIndex(0,3,'ArrowDown'),1);assert.equal(Command.nextIndex(1,3,'ArrowDown'),2);assert.equal(Command.nextIndex(2,3,'ArrowDown'),2);assert.equal(Command.nextIndex(1,3,'ArrowUp'),0);assert.equal(Command.nextIndex(2,3,'Home'),0);assert.equal(Command.nextIndex(0,3,'End'),2);});
test('empty results cannot create an active index or accidentally open a stale row',()=>{for(const key of ['ArrowDown','ArrowUp','Home','End'])assert.equal(Command.nextIndex(9,0,key),-1);assert.deepEqual(Command.groups([]),[]);});
const memoryStorage=()=>{const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key),data};};
test('registry searches labels and multilingual aliases, supports > and gives recent actions their own group',async()=>{
 const storage=memoryStorage(),opened=[],commands=[{id:'new:chat',title:'新建对话',description:'独立对话',keywords:['new conversation','chat'],execute:()=>opened.push('chat')},{id:'project',title:'当前项目',keywords:['current project'],execute:()=>opened.push('project')}],registry=Command.createRegistry({commands,storage,now:()=>100});
 assert.deepEqual(registry.rows('new chat').map(row=>row.id),['new:chat']);assert.equal(registry.rows('> 新建')[0].id,'new:chat');assert.equal(registry.rows('>')[0].groupKey,'command');await registry.execute('new:chat');assert.deepEqual(opened,['chat']);assert.equal(registry.rows()[0].groupKey,'recent-command');
 assert.deepEqual(JSON.parse(storage.getItem(Command.RECENT_KEY)),[{id:'new:chat',at:100}]);const reloaded=Command.createRegistry({commands,storage});assert.equal(reloaded.rows()[0].groupKey,'recent-command');reloaded.clearRecent();assert.equal(reloaded.rows()[0].groupKey,'command');assert.equal(storage.getItem(Command.RECENT_KEY),null);
});
test('dynamic availability is checked again at execution and includes the actual disabled reason',async()=>{
 let ready=true,count=0;const registry=Command.createRegistry({getContext:()=>({ready}),commands:[{id:'save',title:'保存',isEnabled:context=>context.ready||'请先等待工作区载入',execute:()=>count++}]});
 assert.equal(registry.rows()[0].disabled,false);ready=false;assert.equal(registry.rows()[0].disabledReason,'请先等待工作区载入');await assert.rejects(registry.execute('save'),/等待工作区载入/);assert.equal(count,0);assert.equal(registry.recent().length,0);
});
test('failures and false completion never create a recent success; pending work executes once',async()=>{
 let finish,executed=0;const registry=Command.createRegistry({commands:[{id:'pending',title:'运行',execute:()=>{executed++;return new Promise(resolve=>finish=resolve);}},{id:'bad',title:'失败',execute:()=>{throw new Error('磁盘暂不可用');}},{id:'no',title:'取消',execute:()=>false}]});
 const pending=registry.execute('pending');assert.equal(registry.isRunning(),true);await assert.rejects(registry.execute('pending'),/仍在处理/);assert.equal(executed,1);finish(true);await pending;assert.equal(registry.isRunning(),false);await assert.rejects(registry.execute('bad'),/磁盘/);await assert.rejects(registry.execute('no'),/未完成/);assert.deepEqual(registry.recent().map(item=>item.id),['pending']);
});
test('private execution and mode changes during pending commands do not expose or persist recent actions',async()=>{
 let privateMode=false,finish;const storage=memoryStorage(),registry=Command.createRegistry({storage,getContext:()=>({privateMode}),commands:[{id:'nav',title:'导航',execute:()=>true},{id:'pending',title:'导航',execute:()=>new Promise(resolve=>finish=resolve)}]});
 await registry.execute('nav');const before=storage.getItem(Command.RECENT_KEY);privateMode=true;assert.equal(registry.rows()[0].groupKey,'command');await registry.execute('nav');assert.equal(storage.getItem(Command.RECENT_KEY),before);privateMode=false;const run=registry.execute('pending');privateMode=true;finish(true);await run;assert.equal(storage.getItem(Command.RECENT_KEY),before);
});
test('removed, hidden and unavailable commands cannot be invoked or resurrected from saved IDs',async()=>{
 const storage=memoryStorage();storage.setItem(Command.RECENT_KEY,JSON.stringify([{id:'deleted',at:20},{id:'hidden',at:15}]));const registry=Command.createRegistry({storage,commands:[{id:'hidden',title:'隐藏',visible:()=>false,execute:()=>true}]});assert.deepEqual(registry.rows(),[]);await assert.rejects(registry.execute('deleted'),/不可用/);await assert.rejects(registry.execute('hidden'),/不可用/);const remove=registry.register({id:'dynamic',title:'动态',execute:()=>true});assert.equal(registry.rows()[0].id,'dynamic');remove();assert.deepEqual(registry.rows(),[]);
});
test('corrupt and inaccessible storage leave commands usable; saving has no transcript or query text',async()=>{
 const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('quota')},removeItem(){throw Error('blocked')}};const registry=Command.createRegistry({storage:blocked,commands:[{id:'navigate',title:'Sensitive project title',description:'Sensitive body',execute:()=>true}]});await registry.execute('navigate');assert.deepEqual(Object.keys(registry.recent()[0]).sort(),['at','id']);registry.clearRecent();assert.equal(registry.recent().length,0);
 const storage=memoryStorage();storage.setItem(Command.RECENT_KEY,'bad json');assert.doesNotThrow(()=>Command.createRegistry({storage}));
});
