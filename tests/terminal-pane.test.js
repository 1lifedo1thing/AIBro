const test=require('node:test');const assert=require('node:assert/strict');const Pane=require('../app/terminal-pane');

const run=(id,conversationId,commands)=>({id,conversationId,goal:'目标 '+id,commands});

test('只收集当前对话的命令，跨执行记录并按时间倒序',()=>{
 const state={agentRuns:[
  run('r1','c1',[{id:'a',argv:['ls','-la'],startedAt:100},{id:'b',argv:['pwd'],startedAt:300}]),
  run('r2','c2',[{id:'x',argv:['rm','-rf','/tmp/y'],startedAt:200}]),
  run('r3','c1',[{id:'c',argv:['git','status'],startedAt:200}])
 ]};
 const list=Pane.commandsFor(state,'c1');
 assert.deepEqual(list.map(item=>item.id),['b','c','a'],'应跨多次执行合并并按开始时间倒序');
 assert.ok(list.every(item=>item.runId),'应保留来源执行记录');
 assert.deepEqual(Pane.commandsFor(state,'c2').map(item=>item.id),['x']);
 assert.deepEqual(Pane.commandsFor(state,'missing'),[]);
 assert.deepEqual(Pane.commandsFor(null,'c1'),[]);
 assert.deepEqual(Pane.commandsFor({agentRuns:[run('r4','c1',[null,{argv:['no-id']},{id:'ok',argv:['echo']}])]},'c1').map(item=>item.id),['ok'],'无效条目应被忽略');
});

test('命令文本来自 argv，缺记录时如实说明',()=>{
 assert.equal(Pane.commandText({argv:['npm','run','test']}),'npm run test');
 assert.equal(Pane.commandText({argv:['echo','多 空格 参数']}),'echo 多 空格 参数');
 assert.equal(Pane.commandText({argv:[]}),'（未记录命令内容）');
 assert.equal(Pane.commandText({}),'（未记录命令内容）');
 assert.equal(Pane.commandText({argv:['a',undefined,'b']}),'a b','非字符串参数不应被渲染成命令的一部分');
});

test('状态未知时不假装成功，计数分别统计',()=>{
 assert.equal(Pane.statusOf({status:'completed'}).label,'已完成');
 assert.equal(Pane.statusOf({status:'failed'}).tone,'failed');
 assert.equal(Pane.statusOf({status:'running'}).label,'执行中');
 assert.equal(Pane.statusOf({status:'weird'}).label,'状态未知');
 assert.equal(Pane.statusOf({}).label,'状态未知');
 const totals=Pane.counts([{status:'running'},{status:'completed'},{status:'failed'},{status:'failed'}]);
 assert.deepEqual(totals,{total:4,running:1,failed:2});
 assert.deepEqual(Pane.counts([]),{total:0,running:0,failed:0});
 assert.deepEqual(Pane.counts(null),{total:0,running:0,failed:0});
});

test('耗时：运行中按当前时间计算，缺时间戳不编造',()=>{
 assert.equal(Pane.elapsedText({status:'completed',startedAt:1000,finishedAt:4500}),'4 秒');
 assert.equal(Pane.elapsedText({status:'running',startedAt:1000},60000),'59 秒');
 assert.equal(Pane.elapsedText({status:'completed',startedAt:1000,finishedAt:181000}),'3 分 0 秒');
 assert.equal(Pane.elapsedText({status:'completed'}),'','没有开始时间就不显示耗时');
 assert.equal(Pane.elapsedText({status:'completed',startedAt:5000,finishedAt:4000}),'','结束早于开始视为未记录');
 assert.equal(Pane.elapsedText({status:'pending',startedAt:1000}),'','待批准的命令不应显示耗时');
});

test('摘要包含退出码、耗时与时刻，缺失项不占位',()=>{
 const full=Pane.describe({status:'completed',startedAt:new Date(2026,8,18,14,32,5).getTime(),finishedAt:new Date(2026,8,18,14,32,7).getTime(),exitCode:0});
 assert.match(full,/退出码 0/);assert.match(full,/2 秒/);assert.match(full,/14:32:05/);
 assert.equal(Pane.describe({status:'running'}),'');
 assert.equal(Pane.describe({status:'failed',exitCode:1}),'退出码 1');
});
