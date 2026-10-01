const test=require('node:test');const assert=require('node:assert/strict');const Cost=require('../app/usage-cost');

test('价格设置只接受有效币种与非负单价',()=>{
 assert.deepEqual(Cost.preferences(undefined),{currency:'',input:0,output:0});
 assert.deepEqual(Cost.preferences({currency:'  ¥  ',input:'2',output:'8'}),{currency:'¥',input:2,output:8});
 assert.deepEqual(Cost.preferences({currency:'$',input:-3,output:'abc'}),{currency:'$',input:0,output:0});
 assert.deepEqual(Cost.preferences({currency:123,input:2}),{currency:'',input:2,output:0});
 assert.equal(Cost.preferences({currency:'x'.repeat(20)}).currency.length,8,'币种符号应截断');
});

test('没有币种或没有单价时一律不估算',()=>{
 const usage={input:1000,output:500,total:1500};
 assert.equal(Cost.estimate(usage,{input:2,output:8}),null,'缺币种不估算');
 assert.equal(Cost.estimate(usage,{currency:'¥'}),null,'缺单价不估算');
 assert.equal(Cost.estimate(usage,{currency:'¥',input:0,output:0}),null);
 assert.equal(Cost.estimate(null,{currency:'¥',input:2,output:8}),null,'没有用量不估算');
 assert.equal(Cost.describe(usage,{currency:'¥'}),'','未配置时不应产生任何显示文本');
 assert.equal(Cost.configured({currency:'¥',input:0,output:0}),false);
 assert.equal(Cost.configured({currency:'¥',input:2}),true);
});

test('有输入输出拆分时按分量计价',()=>{
 const usage={input:1000000,output:500000,total:1500000};
 const result=Cost.estimate(usage,{currency:'¥',input:2,output:8});
 assert.equal(result.amount,2+4);
 assert.equal(result.rough,false);
 assert.equal(Cost.describe(usage,{currency:'¥',input:2,output:8}),'≈¥6.00（估算）');
});

test('缺少拆分时按总用量与平均单价粗算，并如实标注',()=>{
 const result=Cost.estimate({total:2000000},{currency:'$',input:2,output:6});
 assert.equal(result.amount,8);
 assert.equal(result.rough,true,'必须标记为粗略估算');
 assert.equal(Cost.describe({total:2000000},{currency:'$',input:2,output:6}),'≈$8.00（粗略估算）');
 assert.doesNotMatch(Cost.hint({total:2000000},{currency:'$',input:2,output:6}),/^$/);
});

test('小额金额保留精度，不显示为零',()=>{
 assert.equal(Cost.formatAmount(0.00042),'0.0004');
 assert.equal(Cost.formatAmount(0.5),'0.500');
 assert.equal(Cost.formatAmount(12.345),'12.35');
 assert.equal(Cost.formatAmount(0),'');
 assert.equal(Cost.formatAmount(-1),'');
 const tiny=Cost.describe({input:1,output:1,total:2},{currency:'¥',input:0.001,output:0.001});
 assert.doesNotMatch(tiny,/¥0(?!\.)/,'极小金额不得显示为 0');
});

test('金额说明始终声明不是服务商账单',()=>{
 const hint=Cost.hint({input:1000,output:1000,total:2000},{currency:'¥',input:2,output:8});
 assert.match(hint,/不是服务商账单/);
 assert.equal(Cost.hint({total:2000},{currency:'$',input:2,output:6}).includes('平均值'),true);
});
