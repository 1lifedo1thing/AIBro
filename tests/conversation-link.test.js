const test=require('node:test');const assert=require('node:assert/strict');const Link=require('../app/conversation-link');

test('链接生成与解析往返一致，非法标识不生成链接',()=>{
 assert.equal(Link.build('conv_1789_abc'),'aibro://conversation/conv_1789_abc');
 assert.equal(Link.resolve('aibro://conversation/conv_1789_abc'),'conv_1789_abc');
 assert.equal(Link.resolve(Link.build('x-1.2:3')),'x-1.2:3');
 assert.equal(Link.build(''),'');
 assert.equal(Link.build('has space'),'');
 assert.equal(Link.build('a'.repeat(201)),'');
 assert.equal(Link.build(null),'');
 assert.equal(Link.resolve('aibro://project/abc'),'','只有对话链接可解析');
 assert.equal(Link.resolve('https://conversation/abc'),'');
 assert.equal(Link.resolve('aibro://conversation/'),'');
 assert.equal(Link.resolve('aibro://conversation/has space'),'');
 assert.equal(Link.resolve(undefined),'');
});

test('快照保留消息原文并标注来源与时间',()=>{
 const conversation={id:'conv_snap',title:'梳理 AI 工作站需求',workspace:'日常',createdAt:Date.UTC(2026,8,18,0,0),messages:[
  {id:'m1',role:'user',text:'帮我整理需求。'},
  {id:'m2',role:'agent',text:'第一行\n第二行'},
  {id:'m3',role:'agent',text:'这条被删除了',deletedAt:1}
 ]};
 const markdown=Link.snapshot(conversation,{workspace:'日常 · 项目A',now:Date.UTC(2026,8,18,6,30)});
 assert.match(markdown,/^# 梳理 AI 工作站需求/);
 assert.match(markdown,/- 链接：aibro:\/\/conversation\/conv_snap/);
 assert.match(markdown,/- 空间：日常 · 项目A/);
 assert.match(markdown,/## 你\n\n帮我整理需求。/);
 assert.match(markdown,/## AI\n\n第一行\n第二行/,'多行原文必须原样保留');
 assert.doesNotMatch(markdown,/这条被删除了/,'已删除消息不得进入快照');
 assert.match(markdown,/- 创建时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

test('快照在没有对话时返回空，且超长对话截断并如实标注',()=>{
 assert.equal(Link.snapshot(null,{}),'');
 const many={id:'conv_many',title:'长对话',messages:Array.from({length:Link.MAX_SNAPSHOT_MESSAGES+5},(index,position)=>({id:'m'+position,role:'user',text:'第 '+position+' 条'}))};
 const markdown=Link.snapshot(many,{});
 assert.match(markdown,/快照仅包含前 \d+ 条。|已达导出上限/,'超出上限时必须如实标注截断');
 assert.doesNotMatch(markdown,/第 3000 条/);
 assert.equal(Link.snapshot({title:'空对话',messages:[]},{}).includes('## '),false);
});

test('导出文件名安全且保留可读标题',()=>{
 const name=Link.fileName('需求 / 梳理: 2026?"<>|');
 assert.match(name,/\.md$/);
 assert.doesNotMatch(name,/[\\/:*?"<>|]/,'文件名不得含路径分隔或非法字符');
 assert.match(name,/需求/);assert.match(name,/梳理/);assert.match(name,/2026/);
 assert.doesNotMatch(name,/--/,'连续分隔符应被压缩');
 assert.equal(Link.fileName(''),'对话.md');
 assert.equal(Link.fileName(null),'对话.md');
 assert.equal(Link.fileName('   '),'对话.md','纯空白标题回退默认名');
 assert.match(Link.fileName('a'.repeat(200)),/\.md$/);
 assert.ok(Link.fileName('a'.repeat(200)).length<=83,'过长的标题应被截断');
});
