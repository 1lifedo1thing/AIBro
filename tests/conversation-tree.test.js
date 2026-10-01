const test=require('node:test');const assert=require('node:assert/strict');const Tree=require('../app/conversation-tree');

const conv=(id,extra={})=>({id,title:id,messages:[],...extra});
const base=()=>({conversations:[
 conv('parent',{messages:[{id:'m1'},{id:'m2'},{id:'m3'}]}),
 conv('branchA',{branchedFrom:{conversationId:'parent',conversationTitle:'父对话',messageId:'m2',at:1}}),
 conv('branchB',{branchedFrom:{conversationId:'parent',conversationTitle:'父对话',messageId:'m3',at:2,edited:true}}),
 conv('lonely',{branchedFrom:{conversationId:'missing',conversationTitle:'已删除的对话',messageId:'x',at:3}})
]});

test('分叉来源可解析，父对话不可用时如实返回 null',()=>{
 const state=base();
 assert.equal(Tree.parentOf(state,state.conversations[1]).conversation.id,'parent');
 assert.equal(Tree.parentOf(state,state.conversations[0]),null,'普通对话没有父对话');
 assert.equal(Tree.parentOf(state,state.conversations[3]),null,'父对话已不可用时不假装有关系');
 assert.equal(Tree.parentOf(state,null),null);
 const removed=base();removed.conversations[0].deletedAt=1;
 assert.equal(Tree.parentOf(removed,removed.conversations[1]),null,'父对话已删除时不假装有关系');
});

test('子分支列表忽略已删除项，且不误认其他对话',()=>{
 const state=base();
 assert.deepEqual(Tree.childrenOf(state,'parent').map(item=>item.id),['branchA','branchB']);
 const withDeleted=base();withDeleted.conversations[1].deletedAt=1;
 assert.deepEqual(Tree.childrenOf(withDeleted,'parent').map(item=>item.id),['branchB']);
 assert.deepEqual(Tree.childrenOf(state,'branchA'),[],'分支自身还没有分支');
 assert.deepEqual(Tree.childrenOf(state,''),[]);
 assert.equal(Tree.branchCount(state,'parent'),2);
});

test('父对话在分叉点之后的新增消息被准确计数',()=>{
 const parent={messages:[{id:'m1'},{id:'m2'},{id:'m3'},{id:'m4'}]};
 assert.deepEqual(Tree.parentProgress(parent,{messageId:'m2'}),{located:true,index:1,newer:2,total:4});
 assert.deepEqual(Tree.parentProgress(parent,{messageId:'m4'}),{located:true,index:3,newer:0,total:4});
 assert.deepEqual(Tree.parentProgress(parent,{messageId:'gone'}),{located:false,newer:0,total:4},'找不到分叉点时必须如实说明，而不是谎报 0');
 assert.deepEqual(Tree.parentProgress({messages:[{id:'a'},{id:'b',deletedAt:1}]},{messageId:'a'}),{located:true,index:0,newer:0,total:1},'已删除的消息不参与计数');
 assert.deepEqual(Tree.parentProgress(null,{messageId:'a'}),{located:false,newer:0,total:0});
});

test('标签区分分支与修改重发，缺标题时使用兜底名称',()=>{
 assert.equal(Tree.label({branchedFrom:{conversationTitle:'梳理需求'}}),'分支自「梳理需求」');
 assert.equal(Tree.label({branchedFrom:{conversationTitle:'梳理需求',edited:true}}),'修改重发自「梳理需求」');
 assert.equal(Tree.label({branchedFrom:{}}),'分支自「原对话」');
 assert.equal(Tree.label({}),'');
});

test('综述如实区分“有新增”与“没有新增”',()=>{
 const state=base();
 assert.equal(Tree.summaryText(state,state.conversations[1]),'分支自「父对话」 · 原对话此后新增 1 条');
 assert.equal(Tree.summaryText(state,state.conversations[2]),'修改重发自「父对话」 · 原对话此后没有新消息');
 const unknown=base();unknown.conversations[1].branchedFrom.messageId='missing';
 assert.match(Tree.summaryText(unknown,unknown.conversations[1]),/无法定位/,'定位不到分叉点时必须说无法定位，而不是声称没有新消息');
 assert.doesNotMatch(Tree.summaryText(unknown,unknown.conversations[1]),/没有新消息/,'不得把未知说成没有');
 assert.equal(Tree.summaryText(state,state.conversations[0]),'','普通对话不产生分支说明');
});

test('describe 汇总关系与进度，可直接驱动界面',()=>{
 const state=base();
 const info=Tree.describe(state,state.conversations[1]);
 assert.equal(info.parent.id,'parent');
 assert.equal(info.progress.newer,1);
 assert.equal(info.hasNewer,true);
 assert.equal(info.label,'分支自「父对话」');
 assert.equal(Tree.describe(state,state.conversations[0]),null);
});
