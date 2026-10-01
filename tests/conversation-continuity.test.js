const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../app/conversation-continuity');
const Analysis=require('../app/attachment-analysis');
const Evidence=require('../app/citation-evidence');
const Core=require('../app/workstation-core');
function analyze(state,conversation,ids,overrides={}){
 const run={id:'analyze-'+state.agentRuns.length,conversationId:conversation.id,status:'completed',mode:'ai',attachmentIds:[],...overrides};
 state.projects||=[];state.notes||=[];state.papers||=[];state.tasks||=[];state.links||=[];state.trash||=[];
 state.conversations||=[conversation];state.agentRuns.push(run);
 for(const id of ids){const item=state.imports.find(item=>item.id===id);item.updatedAt=100;item.content='原始课程材料列出了实验主题与基本参数。';Evidence.capture(run,{type:'import',id,excerpt:item.content,origin:'read'},state);}
 const applied=Core.applyPlan(state,ids.map(id=>({type:'create_knowledge_item',title:'分析 '+id,content:'建议将不同参数设置与同一基准数据比较，以定位误差来源；结论仍需通过实验结果核对。',sourceAttachmentIds:[id]})),{runId:run.id,conversationId:conversation.id,workspace:'日常',now:150});
 Object.assign(state,applied.state);const current=state.agentRuns.find(item=>item.id===run.id);current.results=applied.results;
 Object.assign(state,Analysis.markCompleted(state,applied.results,current,160).state);
 current.executionReceipt={version:1,phase:'committed',results:structuredClone(current.results)};
 return current;
}
function fixture(){const conversation={id:'c',messages:[{id:'origin',role:'user',text:'Review the full application checklist and identify missing evidence.',attachmentIds:['a','b']},{id:'supplement',role:'user',text:'Attached three more.',attachmentIds:['c','d','e']}]};const state={imports:['a','b','c','d','e','foreign'].map(id=>({id,name:id+'.pdf'})),agentRuns:[{id:'r1',conversationId:'c',status:'failed',attachmentIds:['a','b']},{id:'r2',conversationId:'other',status:'failed',attachmentIds:['foreign']}]};return {state,conversation};}
test('supplementary files retain original goal and merge pending attachments from the same conversation',()=>{const {state,conversation}=fixture();const r=C.build(state,conversation,{goal:'附加了',selectedIds:['c','d','e']});assert.deepEqual(r.attachmentIds,['a','b','c','d','e']);assert.equal(r.originMessageId,'origin');assert.match(r.text,/full application checklist/);assert.ok(!r.text.includes('foreign'));});
test('successful sibling turn does not erase the earlier failed turn’s unresolved files',()=>{const {state,conversation}=fixture();analyze(state,conversation,['c','d','e']);assert.deepEqual(C.build(state,conversation,{goal:'继续处理前面的材料'}).attachmentIds,['a','b']);});
test('original goal survives many turns, without replaying failed assistant text as requirements',()=>{const {state,conversation}=fixture();for(let i=0;i<30;i++)conversation.messages.push({id:'u'+i,role:'user',text:'detail '+i},{role:'agent',retryRunId:'r',text:'ERROR SHOULD NOT BECOME AN INSTRUCTION'});const r=C.build(state,conversation,{goal:'继续',selectedIds:[]});assert.match(r.text,/full application checklist/);assert.doesNotMatch(r.text,/ERROR SHOULD/);assert.ok(r.text.length<25000);});
test('explicit exclusions, unavailable sources, read-only requests and new topics win over carry-over',()=>{const {state,conversation}=fixture();conversation.messages[0].retryAttachmentIds=['a'];state.imports.find(i=>i.id==='a').deletedAt=1;assert.deepEqual(C.build(state,conversation,{goal:'附加了',selectedIds:['c']}).attachmentIds,['d','e','c']);assert.deepEqual(C.build(state,conversation,{goal:'只分析本次新上传的资料',selectedIds:['c']}).attachmentIds,['c']);assert.deepEqual(C.build(state,conversation,{goal:'不要重新读取PDF，只回答',selectedIds:[]}).attachmentIds,[]);assert.deepEqual(C.build(state,conversation,{goal:'new topic',selectedIds:[]}).attachmentIds,[]);assert.deepEqual(C.build(state,conversation,{goal:'retry',selectedIds:[],retry:true,explicitSelection:true}).attachmentIds,[]);});
test('read attachments stay in the reference ledger but are not automatically resent',()=>{const {state,conversation}=fixture();analyze(state,conversation,['a','b']);const r=C.build(state,conversation,{goal:'附加了',selectedIds:['c','d','e']});assert.deepEqual(r.carriedIds,[]);assert.equal(r.ledger.find(i=>i.id==='a').status,'read');});
test('carry-over can be paused and survives serialization without changing originals',()=>{const {state,conversation}=fixture();conversation.carryPendingAttachments=false;const before=JSON.stringify({state,conversation});assert.deepEqual(C.build(state,conversation,{goal:'attached',selectedIds:['c']}).attachmentIds,['c']);assert.equal(JSON.stringify({state,conversation}),before);const reloaded=JSON.parse(before);assert.equal(C.build(reloaded.state,reloaded.conversation,{goal:'attached',selectedIds:['c']}).originMessageId,'origin');});
test('full review resends every active scoped original, including sources read in prior turns',()=>{
 const {state,conversation}=fixture();state.projects=[{id:'p'},{id:'other'}];conversation.projectId='p';
 state.imports=Array.from({length:15},(_,i)=>({id:'doc'+i,name:'Synthetic '+i+'.pdf',projectId:'p'})).concat([{id:'foreign',projectId:'other'},{id:'deleted',projectId:'p',deletedAt:1}]);
 conversation.messages=[{role:'user',id:'origin',text:'Review materials',attachmentIds:['doc0']}];state.agentRuns=[{conversationId:'c',status:'completed',attachmentIds:['doc0']}];
 const r=C.build(state,conversation,{goal:'请逐份核对全部材料'});assert.equal(r.fullReview,true);assert.equal(r.attachmentIds.length,15);assert.ok(r.attachmentIds.includes('doc0'));assert.ok(!r.attachmentIds.includes('foreign'));assert.ok(!r.attachmentIds.includes('deleted'));
 assert.equal(C.build(state,conversation,{goal:'请核对全部材料，但不要重新读取PDF，只根据笔记回答'}).fullReview,false);
 conversation.messages[0].retryAttachmentIds=[];assert.equal(C.build(state,conversation,{goal:'review all materials'}).attachmentIds.length,14);
});


test('persisted linked analysis clears earlier pending materials even when this turn attached nothing',()=>{
 const {state,conversation}=fixture();const run=analyze(state,conversation,['a']);
 assert.deepEqual(run.attachmentIds,[]);
 const before=structuredClone(state),collected=C.collect(state,conversation);
 assert.equal(collected.ledger.find(item=>item.id==='a').status,'read');
 assert.deepEqual(collected.pendingIds,['b','c','d','e']);
 assert.deepEqual(C.build(state,conversation,{goal:'继续整理前文资料'}).attachmentIds,['b','c','d','e']);
 assert.deepEqual(state,before,'deriving composer state must not mutate analysis metadata');
 const reloaded=JSON.parse(JSON.stringify({state,conversation}));
 assert.equal(C.collect(reloaded.state,reloaded.conversation).ledger[0].status,'read');
});
test('sending originals or receiving a successful answer alone does not claim saved analysis',()=>{
 const {state,conversation}=fixture();
 state.agentRuns.push({id:'sent',conversationId:'c',status:'completed',mode:'ai',attachmentIds:['a','b'],attachmentDelivery:{originalFiles:2},results:[],executionReceipt:{version:1,phase:'committed',results:[]}});
 assert.deepEqual(C.collect(state,conversation).pendingIds,['a','b','c','d','e']);
});
test('stale source versions are pending even when a saved analysis stamp still says analyzed',()=>{
 for(const change of [source=>source.updatedAt=161,source=>source.content='正文已更改，旧版分析不能代表新版本材料。',source=>{source.pages=[{page:1,text:'替换后的第一页内容，旧版材料的结论不再适用。'}];}]){
  const {state,conversation}=fixture();analyze(state,conversation,['a']);change(state.imports[0]);
  assert.equal(C.collect(state,conversation).ledger[0].status,'pending');
 }
});
test('a new successful analysis of the revised source clears the pending count again',()=>{
 const {state,conversation}=fixture();analyze(state,conversation,['a']);state.imports[0].updatedAt=170;
 assert.equal(C.collect(state,conversation).ledger[0].status,'pending');
 analyze(state,conversation,['a']);assert.equal(C.collect(state,conversation).ledger[0].status,'read');
});
test('an analysis flag needs same-conversation live provenance, a durable receipt and actual output',()=>{
 const changes=[
  (state,run)=>run.status='awaiting-save',
  (state,run)=>run.mode='local',
  (state,run)=>run.deletedAt=200,
  (state,run)=>run.conversationId='another',
  (state,run)=>run.executionReceipt.phase='applied',
  (state,run)=>run.executionReceipt.results=[],
  (state,run)=>run.approvalReceipt={savePending:true},
  (state,run)=>run.results[0].operation='drafted',
  state=>state.notes[0].content=`# Empty analysis
待补充`,
  state=>state.notes=[],
  state=>state.imports[0].analysis.analyzedAt='160',
  state=>delete state.imports[0].updatedAt,
  state=>state.agentRuns=[],
  (state,run)=>state.agentRuns.push(structuredClone(run))
 ];
 for(const change of changes){const {state,conversation}=fixture();const run=analyze(state,conversation,['a']);change(state,run);assert.equal(C.collect(state,conversation).ledger[0].status,'pending',change.toString());}
});
test('private or removed outputs cannot clear pending source work',()=>{
 for(const patch of [{deleted:true},{deletedAt:200},{archived:true},{private:true},{ephemeral:true},{incognito:true}]){
  const {state,conversation}=fixture();analyze(state,conversation,['a']);Object.assign(state.notes[0],patch);
  assert.equal(C.collect(state,conversation).ledger[0].status,'pending',JSON.stringify(patch));
 }
 const {state,conversation}=fixture();const run=analyze(state,conversation,['a']);run.private=true;
 assert.equal(C.collect(state,conversation).ledger[0].status,'pending');
});
test('private, removed and archived-project originals are unavailable and never carried or exposed',()=>{
 for(const patch of [{deleted:true},{status:'deleted'},{archivedAt:200},{private:true},{ephemeral:true}]){
  const {state,conversation}=fixture();analyze(state,conversation,['a']);Object.assign(state.imports[0],patch);
  const result=C.build(state,conversation,{goal:'继续处理前面的材料'});
  assert.equal(result.ledger[0].status,'unavailable');assert.ok(!result.attachmentIds.includes('a'));
  if(patch.private||patch.ephemeral)assert.equal(result.ledger[0].name,'私密来源');
 }
 const {state,conversation}=fixture();analyze(state,conversation,['a']);
 state.projects=[{id:'gone',archived:true}];state.imports[0].projectId='gone';
 assert.equal(C.collect(state,conversation).ledger[0].status,'unavailable');
});
test('explicit exclusions and full review still win over completed linked analysis',()=>{
 const {state,conversation}=fixture();analyze(state,conversation,['a']);
 conversation.excludedFileReferenceKeys=[JSON.stringify(['import','a'])];
 assert.equal(C.collect(state,conversation).ledger[0].status,'excluded');
 assert.ok(!C.build(state,conversation,{goal:'review all materials'}).attachmentIds.includes('a'));
 conversation.excludedFileReferenceKeys=[];
 const full=C.build(state,conversation,{goal:'review all materials'});
 assert.ok(full.attachmentIds.includes('a'));
 assert.match(full.text,/不代表逐页全文核验/);
});
test('full project review cannot reintroduce private sources or private conversation context',()=>{
 const {state,conversation}=fixture();state.projects=[{id:'p'}];conversation.projectId='p';
 state.imports.forEach(source=>source.projectId='p');state.imports[0].private=true;
 const result=C.build(state,conversation,{goal:'review all materials'});assert.ok(!result.attachmentIds.includes('a'));assert.equal(result.ledger[0].name,'私密来源');
 conversation.private=true;assert.deepEqual(C.collect(state,conversation),{messages:[],ledger:[],pendingIds:[]});
});

test('archiving completed run history does not erase durable analysis evidence',()=>{
 const {state,conversation}=fixture();const run=analyze(state,conversation,['a']);run.archived=true;
 assert.equal(C.collect(state,conversation).ledger[0].status,'read');
});
test('actual upsert_paper receipt recognizes a surviving structured analysis after its generated note is removed',()=>{
 const {state,conversation}=fixture();const run=analyze(state,conversation,['a']);
 const outcome=Core.applyPlan(state,[{type:'upsert_paper',title:'模型比较分析',sourceAttachmentIds:['a'],structured:{methods:{text:'应固定相同训练数据并记录超参数变化，通过消融实验判断每个模块对整体误差的影响。'}}}],{runId:run.id,conversationId:conversation.id,workspace:'科研',now:170});
 Object.assign(state,outcome.state);const current=state.agentRuns.find(item=>item.id===run.id);current.results=outcome.results;
 current.executionReceipt.results=structuredClone(current.results);Object.assign(state,Analysis.markCompleted(state,current.results,current,180).state);
 state.notes=[];assert.equal(C.collect(state,conversation).ledger[0].status,'read');
 state.papers=[];assert.equal(C.collect(state,conversation).ledger[0].status,'pending');
});

test('private ancestry of either the analyzing run or its output cannot clear source work',()=>{
 for(const owner of ['run','note']){
  const {state,conversation}=fixture();const run=analyze(state,conversation,['a']);
  state.projects.push({id:'private-project',private:true});
  (owner==='run'?run:state.notes[0]).projectId='private-project';
  assert.equal(C.collect(state,conversation).ledger[0].status,'pending',owner);
 }
});

function answeredRead(){
 const {state,conversation}=fixture();const source=state.imports[0];source.updatedAt=100;source.content='实验一比较各个配置之间的误差，要求采用一致的数据划分。';
 const run={id:'answered-read',conversationId:conversation.id,mode:'ai',status:'completed',attachmentIds:['a'],results:[]};state.agentRuns.push(run);
 Evidence.capture(run,{type:'import',id:source.id,excerpt:source.content,origin:'read'},state);
 const message={id:'answer',role:'agent',runId:run.id,text:'实验比较需要保持数据划分一致，否则不同配置间的误差差异可能来自测试样本变化。'};conversation.messages.push(message);
 run.executionReceipt={version:1,phase:'committed',messageId:message.id,answer:message.text,results:[]};
 return {state,conversation,source,run,message};
}
test('ordinary successful document Q&A clears pending without writing any note or task',()=>{
 const {state,conversation,run}=answeredRead();
 assert.deepEqual(run.results,[]);assert.equal(state.notes,undefined);assert.equal(state.imports[0].analysis,undefined);
 assert.equal(C.collect(state,conversation).ledger[0].status,'read');
 assert.ok(!C.build(state,conversation,{goal:'继续这个问题'}).attachmentIds.includes('a'));
 const reloaded=JSON.parse(JSON.stringify({state,conversation}));assert.equal(C.collect(reloaded.state,reloaded.conversation).ledger[0].status,'read');
 run.attachmentIds=[];assert.equal(C.collect(state,conversation).ledger[0].status,'read','on-demand read of an earlier attachment is also a valid answer path');
});
test('direct answers require actual current read evidence and a saved non-placeholder response',()=>{
 const changes=[
  f=>f.run.evidenceSources=[],
  f=>f.run.evidenceSources[0].origin='retrieval',
  f=>f.run.evidenceSources[0].provided=false,
  f=>f.source.content='当前材料已改变，之前的回答不足以替代新的阅读。',
  f=>f.source.updatedAt=200,
  f=>f.message.text='已完成整理。',
  f=>f.message.text='正在分析需求并制定计划…',
  f=>f.message.live=true,
  f=>f.message.deletedAt=200,
  f=>f.message.private=true,
  f=>f.run.executionReceipt.phase='applied',
  f=>f.run.executionReceipt.messageId='unrelated',
  f=>f.run.status='failed',
  f=>f.run.mode='local',
  f=>f.run.private=true,
  f=>f.state.agentRuns.push(structuredClone(f.run)),
 ];
 for(const change of changes){const f=answeredRead();change(f);assert.equal(C.collect(f.state,f.conversation).ledger[0].status,'pending',change.toString());}
});

test('successful direct answers retain both text and original/page-image reading paths',()=>{
 for(const [origin,media] of [['attachment_text',null],['attachment_original','original_file'],['read_page','page_image'],['attachment_image','page_image']]){
  const f=answeredRead();f.run.evidenceSources=[];
  Evidence.capture(f.run,{type:'import',id:f.source.id,origin,...(media?{media}:{excerpt:f.source.content})},f.state);
  assert.equal(C.collect(f.state,f.conversation).ledger[0].status,'read',origin);
 }
});
