const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('app/app.js','utf8');
const functionSource=source.slice(source.indexOf('function renderComposerContext() {'),source.indexOf('// 执行前的独立审查者'));
function render(conversation,busy=false){
  const box={hidden:false,innerHTML:'old status'};
  const context={window:{},$:()=>box,currentConversation:()=>conversation,compactCurrentConversation:{busy},esc:s=>String(s).replace(/</g,'&lt;'),state:{agentRuns:[{conversationId:conversation.id,contextMetrics:{estimatedTokens:20200}}]}};
  vm.runInNewContext(functionSource+';renderComposerContext();',context);return box;
}
test('short conversations hide context strip even when a token estimate exists',()=>{
  const box=render({id:'chat',messages:[{text:'hello'}]});assert.equal(box.hidden,true);assert.equal(box.innerHTML,'');
});
test('long conversations retain compaction action without local token estimates',()=>{
  const box=render({id:'chat',messages:Array.from({length:12},(_,i)=>({text:`message ${i}`}))});
  assert.equal(box.hidden,false);assert.match(box.innerHTML,/整理较早对话/);assert.doesNotMatch(box.innerHTML,/tokens|20\.2k|本地估算/);
});
test('saved summary evidence and continuation remain available',()=>{
  const box=render({id:'chat',messages:[],contextSummary:{coveredParts:3,items:[{kind:'decision',quote:'Keep originals'}]}});
  assert.match(box.innerHTML,/已整理 3 段/);assert.match(box.innerHTML,/Keep originals/);assert.match(box.innerHTML,/继续整理/);
});
test('in-progress compaction keeps status and its real cancellation action',()=>{
  const box=render({id:'chat',messages:[]},true);assert.match(box.innerHTML,/data-cancel-compact/);assert.equal(box.hidden,false);
});
