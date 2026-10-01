const test=require('node:test');const assert=require('node:assert/strict');const Anchors=require('../app/context-anchors');

const msg=(id,text,extra={})=>({id,role:'user',text,at:Number(id.replace(/\D/g,''))||1,...extra});

test('机械提取覆盖路径、网址、错误串、编号与本应用 ID',()=>{
 const items=Anchors.extract([msg('m1','先看 /Users/czx/workspace/docs/plan.md，再访问 https://example.com/spec 复核。')]);
 const kinds=items.map(item=>item.kind);
 assert.ok(kinds.includes('path'),'绝对路径应被提取');
 assert.ok(kinds.includes('url'),'网址应被提取');
 assert.ok(items.some(item=>item.value==='/Users/czx/workspace/docs/plan.md'),'锚点必须是原文片段');
 assert.ok(items.some(item=>item.value==='https://example.com/spec'));
 const mixed=Anchors.extract([msg('m2','docs/readme.md 里有 TypeError: cannot read property x，见 #1234 与 skill_ab12cd 的记录。')]);
 assert.ok(mixed.some(item=>item.kind==='path'&&item.value==='docs/readme.md'),'带扩展名的相对路径应被提取');
 assert.ok(mixed.some(item=>item.kind==='error'&&/TypeError/.test(item.value)),'错误串应被提取');
 assert.ok(mixed.some(item=>item.kind==='ref'&&item.value==='#1234'),'编号应被提取');
 assert.ok(mixed.some(item=>item.kind==='id'&&/^skill_/.test(item.value)),'本应用 ID 应被提取');
});

test('普通叙述不被误当成锚点',()=>{
 const items=Anchors.extract([msg('m1','我看了 3/4 的进度，感觉还行。今天先到这里。')]);
 assert.deepEqual(items,[],'不能把普通文字当成路径或编号');
 const chinese=Anchors.extract([msg('m2','这个方法在论文里出现过，但没有具体文件。')]);
 assert.deepEqual(chinese,[]);
});

test('同一锚点只保留最近一次出现的位置，并按最近优先排序',()=>{
 const items=Anchors.extract([
  msg('m1','早期提到 app/server.py 这个文件。'),
  msg('m2','后来又看了 docs/other.md。'),
  msg('m3','再次确认 app/server.py 的改动。')
 ]);
 const server=items.filter(item=>item.value==='app/server.py');
 assert.equal(server.length,1,'重复锚点只保留一条');
 assert.equal(server[0].messageId,'m3','保留最近一次出现的位置');
 const order=items.map(item=>item.messageId);
 assert.deepEqual(order,['m3','m2'],'重复的锚点合并到最近位置，其余按最近优先');
});

test('已删除、生成中与待重试的消息不参与提取',()=>{
 const items=Anchors.extract([
  msg('m1','被删除的提到 docs/gone.md',{deletedAt:1}),
  msg('m2','生成中的提到 docs/live.md',{live:true}),
  msg('m3','待重试的提到 docs/retry.md',{retryRunId:'r1'}),
  msg('m4','有效的提到 docs/keep.md')
 ]);
 assert.deepEqual(items.map(item=>item.value),['docs/keep.md']);
});

test('上限同时约束条数与字符数，且不截断单条锚点',()=>{
 const many=Array.from({length:200},(_,index)=>msg('m'+index,`文件 docs/file-${index}.md 已更新。`));
 const limited=Anchors.extract(many,{limit:10});
 assert.equal(limited.length,10,'条数上限生效');
 assert.ok(limited.every(item=>/^docs\/file-\d+\.md$/.test(item.value)),'不得截断锚点内容');
 const wide=Anchors.extract([msg('m1','路径 /Users/czx/'+'a'.repeat(180)+'/deep/path/file.md 很长。')],{maxChars:60});
 assert.deepEqual(wide,[],'超预算时宁可少给，不给出残缺锚点');
});

test('对照实验：消息被截断丢失的路径，仍由锚点在上下文中保住',()=>{
 const AgentContext=require('../app/agent-context');
 const messages=[{id:'m0',role:'user',text:'x'.repeat(3000)+' 参考 docs/rare-file.md 里的约定。',at:1}];
 for(let i=1;i<=40;i+=1)messages.push({id:'m'+i,role:i%2?'agent':'user',text:'普通内容 '+'y'.repeat(600),at:i+1});
 const conversation={id:'c',messages};
 const result=AgentContext.history({conversations:[conversation],agentRuns:[]},conversation,{goal:'完全不同的目标',currentMessageId:'',maxTokens:1200});
 const envelope=JSON.parse(result.text);
 const inMessages=envelope.messages.some(message=>String(message.text||'').includes('docs/rare-file.md'));
 const anchors=JSON.stringify(envelope.sourceLinkedAnchors||{});
 assert.equal(anchors.includes('docs/rare-file.md'),true,'锚点必须保住这条路径');
 assert.equal(inMessages,false,'构造前提：这条消息在预算内被截断，路径不在正文里');
 assert.match(anchors,/不是结论/,'锚点进入上下文时必须带说明');
});

test('分组统计与使用说明可直接驱动界面',()=>{
 const items=Anchors.extract([msg('m1','docs/a.md 与 https://x.test/b 以及 #42。')]);
 const groups=Anchors.byKind(items);
 assert.ok(Array.isArray(groups.path)&&groups.path.includes('docs/a.md'));
 assert.equal(Anchors.totals(items).total,items.length);
 assert.match(Anchors.NOTICE,/不是结论/);
 assert.match(Anchors.NOTICE,/history_read/,'必须指出如何回查原文');
});
