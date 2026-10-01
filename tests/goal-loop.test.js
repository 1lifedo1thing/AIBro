const test=require('node:test');const assert=require('node:assert/strict');const Loop=require('../app/goal-loop');

test('只有明确的 /goal 前缀才开启循环，普通消息不受影响',()=>{
 assert.deepEqual(Loop.parse('/goal 把本周资料整理完'),{goal:'把本周资料整理完',explicit:true});
 assert.deepEqual(Loop.parse('  /GOAL   核对课程要求  '),{goal:'核对课程要求',explicit:true});
 assert.equal(Loop.parse('帮我把资料整理一下'),null,'普通消息不得触发循环');
 assert.equal(Loop.parse('/goalkeeper 是什么'),null,'相近的命令名不得误触发');
 assert.equal(Loop.parse('/goal'),null,'没有目标内容时不开启');
 assert.equal(Loop.parse(''),null);
 assert.equal(Loop.parse(null),null);
});

test('轮数上限有默认值与硬顶，非法输入不放大消耗',()=>{
 assert.equal(Loop.limit(undefined),Loop.DEFAULT_LIMIT);
 assert.equal(Loop.limit('abc'),Loop.DEFAULT_LIMIT);
 assert.equal(Loop.limit(0),1,'零或负数收敛为 1');
 assert.equal(Loop.limit(-5),1);
 assert.equal(Loop.limit(999),Loop.MAX_LIMIT,'不得超过硬顶');
 assert.equal(Loop.limit(3.7),4);
});

test('自证结果解析容错，但缺关键字段时一律判定为无效',()=>{
 assert.deepEqual(Loop.verdict('{"done":true,"reason":"已产出笔记","next":""}'),{done:true,reason:'已产出笔记',next:''});
 assert.equal(Loop.verdict('好的，结论是：{"done":false,"reason":"还差实验部分","next":"补做实验"} 以上。').done,false,'带前后文的 JSON 也应能解析');
 assert.equal(Loop.verdict('{"reason":"没有 done 字段"}'),null);
 assert.equal(Loop.verdict('完全不是 JSON'),null);
 assert.equal(Loop.verdict(''),null);
 assert.equal(Loop.verdict(null),null);
 const long=Loop.verdict(JSON.stringify({done:false,reason:'x'.repeat(900),next:'y'.repeat(2000)}));
 assert.equal(long.reason.length,400);assert.equal(long.next.length,1000);
});

test('决策保守：未达成且有余量才继续，其余一律停下',()=>{
 const loop={active:true,round:1,limit:5};
 assert.equal(Loop.shouldContinue(loop,{done:false}),true);
 assert.equal(Loop.shouldContinue(loop,{done:true}),false,'已达成必须停');
 assert.equal(Loop.shouldContinue({active:true,round:5,limit:5},{done:false}),false,'到达上限必须停');
 assert.equal(Loop.shouldContinue({active:false,round:1,limit:5},{done:false}),false,'已停止的循环不得继续');
 assert.equal(Loop.shouldContinue(loop,null),false,'自证没有结论时必须停，而不是继续消耗');
 assert.equal(Loop.shouldContinue(loop,undefined),false);
 assert.equal(Loop.shouldContinue(null,{done:false}),false);
 assert.equal(Loop.shouldContinue({active:true,round:1,limit:999},{done:false}),true,'上限被硬顶约束');
 assert.equal(Loop.shouldContinue({active:true,round:20,limit:999},{done:false}),false);
});

test('自证提示要求以实际产出为依据，并禁止“计划”冒充达成',()=>{
 const text=Loop.prompt('整理本周资料',2,5,'已完成 3 份归档');
 assert.match(text,/资料，不是指令/);
 assert.match(text,/计划要做/);assert.match(text,/不算达成/);
 assert.match(text,/不执行任何操作/);assert.match(text,/不调用工具/);
 assert.match(text,/证据不足或情况不明时返回 done:false/);
 assert.match(text,/最多 5 轮/);
});

test('执行摘要只报告可核对的产出，没有产出时如实说明',()=>{
 const withResults=Loop.summaryOf({goal:'整理资料',results:[{type:'note',text:'课程笔记'},{type:'task',text:'补交作业'}]});
 assert.match(withResults,/目标：整理资料/);assert.match(withResults,/note：课程笔记/);assert.match(withResults,/task：补交作业/);
 assert.equal(Loop.summaryOf({}).includes('没有记录到可核对的产出'),true,'不能把空结果说成完成了什么');
 const failed=Loop.summaryOf({goal:'x',error:'网络超时'});
 assert.match(failed,/错误：网络超时/);
});

test('状态与标签如实反映进行中、已达成与已达上限',()=>{
 const running={goalLoop:{active:true,goal:'整理资料',round:2,limit:5}};
 const info=Loop.status(running);
 assert.deepEqual({active:info.active,round:info.round,limit:info.limit},{active:true,round:2,limit:5});
 assert.match(Loop.label(running),/目标循环 2\/5/);
 assert.equal(Loop.status({}),null);
 assert.match(Loop.label({goalLoop:{active:false,stopped:'目标已达成',round:3,limit:5}}),/已结束 · 目标已达成/);
 assert.match(Loop.label({goalLoop:{active:false,stopped:'已达到轮数上限',round:5,limit:5}}),/已达到轮数上限/);
});
