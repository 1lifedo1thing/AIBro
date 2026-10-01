const test=require('node:test');const assert=require('node:assert/strict');const Sound=require('../app/alert-sound');

test('提示音设置只接受布尔值，其余回退默认',()=>{
 assert.deepEqual(Sound.preferences(undefined),Sound.DEFAULTS);
 assert.deepEqual(Sound.preferences(null),Sound.DEFAULTS);
 assert.deepEqual(Sound.preferences({done:'yes',attention:1,failed:true}),{enabled:true,done:true,attention:true,failed:true,task:true});
 assert.deepEqual(Sound.preferences({enabled:false,failed:false}),{enabled:false,done:true,attention:true,failed:false,task:true});
 const patched=Sound.preferences({...Sound.DEFAULTS,unknown:true});
 assert.equal(Object.hasOwn(patched,'unknown'),false,'未知键不得写入设置');
});

test('只在切到其他应用、且该事件类型未被关闭时播放',()=>{
 assert.equal(Sound.shouldPlay({},'done',true),true);
 assert.equal(Sound.shouldPlay({},'done',false),false,'窗口可见时不播放');
 assert.equal(Sound.shouldPlay({},'done',undefined),false);
 assert.equal(Sound.shouldPlay({enabled:false},'done',true),false,'总开关关闭时不播放');
 assert.equal(Sound.shouldPlay({done:false},'done',true),false,'单类关闭时不播放');
 assert.equal(Sound.shouldPlay({done:false},'attention',true),true,'关闭一类不影响其他类型');
 assert.equal(Sound.shouldPlay({},'missing',true),false,'未知事件类型不得播放');
 assert.equal(Sound.shouldPlay('malformed','failed',true),true,'设置损坏时回退默认而不是静默失效');
});

test('四类事件的音色各不相同，且都是可合成音符序列',()=>{
 const kinds=Object.keys(Sound.tones);
 assert.deepEqual(kinds.sort(),['attention','done','failed','task']);
 const seen=new Set();
 for(const kind of kinds){
  const tone=Sound.tones[kind];
  assert.ok(tone.label.length>0,kind+' 应有中文标签');
  assert.ok(tone.notes.length>=2,kind+' 应为多音组合');
  for(const [frequency,offset,duration] of tone.notes){assert.ok(frequency>200&&frequency<2000,kind+' 频率应在可听范围');assert.ok(offset>=0&&duration>0);}
  const signature=JSON.stringify(tone.notes);assert.equal(seen.has(signature),false,kind+' 音色不得与其他事件重复');seen.add(signature);
 }
});

test('未解锁音频上下文时播放返回 false，且不抛错',()=>{
 const Sound2=require('../app/alert-sound');
 const hooks={getPreferences:()=>Sound2.DEFAULTS,hidden:()=>true};
 Sound2.init(hooks);
 assert.equal(typeof Sound2.play('done'),'boolean','播放必须返回布尔值而不是抛错');
 assert.equal(Sound2.play('unknown-kind'),false);
});

test('切换单个开关只改动该项，未提及的保持原值',()=>{
 const current={enabled:true,done:false,attention:true,failed:true,task:false};
 const next=Sound.merge(current,{failed:false});
 assert.deepEqual(next,{enabled:true,done:false,attention:true,failed:false,task:false});
 assert.deepEqual(current,{enabled:true,done:false,attention:true,failed:true,task:false},'不得就地修改传入对象');
 assert.deepEqual(Sound.merge(undefined,{task:false}),{enabled:true,done:true,attention:true,failed:true,task:false});
 assert.deepEqual(Sound.merge(current,'malformed'),current,'非法补丁必须被忽略');
 assert.deepEqual(Sound.merge(current,{done:'yes'}),current,'非布尔值不得写入');
});
