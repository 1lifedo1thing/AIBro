'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const F=require('../app/file-context');
const C=require('../app/conversation-continuity');
const E=require('../app/citation-evidence');
const Selection=require('../app/context-selection');
function fixture(){
 const c={id:'c',messages:[{id:'m',role:'user',text:'分析这两份资料',attachmentIds:['a','b'],fileReferences:[]}],draftAttachmentIds:[]};
 return {c,s:{projects:[],conversations:[c],imports:[{id:'a',name:'课程.pdf'},{id:'b',name:'补充.pdf'}],notes:[{id:'n',title:'笔记',content:'合成资料'}],agentRuns:[]}};
}
// Match app.js normal-send composition, including its explicit-reference IDs.
async function nextTurn(s,c){
 const selectedReferences=F.references(c);
 const selectedIds=[...new Set([...(c.draftAttachmentIds||[]),...selectedReferences.filter(r=>r.type==='import').map(r=>r.id)])];
 const continuation=C.build(s,c,{goal:'继续分析之前的文件',selectedIds});
 for(const id of continuation.attachmentIds)assert.ok(s.imports.some(item=>item.id===id&&!item.archived&&!item.deletedAt),'send must not be blocked by an unavailable original');
 await F.prepare(s,selectedReferences);
 return {selectedReferences,selectedIds,...continuation};
}

test('legacy pending files stay in continuation, without becoming explicit repeated references, after note addition and reload',async()=>{
 const {s,c}=fixture(),before=structuredClone(c.messages);
 F.stage(c,await F.libraryRef(s,'note','n'));
 assert.equal(c.mobileContext,undefined);
 const restored=JSON.parse(JSON.stringify(c)),next=await nextTurn(s,restored);
 assert.deepEqual(next.selectedIds,[]);
 assert.deepEqual(next.attachmentIds,['a','b']);
 assert.deepEqual(next.selectedReferences.map(r=>r.id),['n']);
 assert.deepEqual(restored.messages,before);
});

test('adding a reference does not resend a successfully read legacy original',async()=>{
 const {s,c}=fixture(),source=s.imports[0];source.updatedAt=100;source.content='实验比较必须采用一致的数据划分。';
 const run={id:'read',conversationId:c.id,mode:'ai',status:'completed',attachmentIds:['a'],results:[]};s.agentRuns.push(run);
 E.capture(run,{type:'import',id:source.id,excerpt:source.content,origin:'read'},s);
 const answer={id:'answer',role:'agent',runId:run.id,text:'比较不同配置时应保持测试数据划分一致，避免结果差异来自样本变化。'};c.messages.push(answer);
 run.executionReceipt={version:1,phase:'committed',messageId:answer.id,answer:answer.text,results:[]};
 assert.equal(C.collect(s,c).ledger[0].status,'read');
 F.stage(c,await F.libraryRef(s,'note','n'));
 const next=await nextTurn(s,c);
 assert.deepEqual(next.selectedIds,[]);
 assert.deepEqual(next.attachmentIds,['b']);
 assert.equal(next.ledger[0].status,'read');
});

test('deleted legacy originals do not block a new reference or continuing the remaining material',async()=>{
 const {s,c}=fixture();s.imports[0].deletedAt=1;
 F.stage(c,await F.libraryRef(s,'note','n'));
 const next=await nextTurn(s,c);
 assert.deepEqual(next.selectedIds,[]);
 assert.deepEqual(next.attachmentIds,['b']);
 assert.equal(next.ledger[0].status,'unavailable');
});

test('removing only one legacy file retains snapshot-only siblings and respects earlier retry exclusions',async()=>{
 const {s,c}=fixture();s.imports.push({id:'retry-removed',name:'取消的附件'});
 c.messages[0]={role:'user',attachmentIds:['a','retry-removed'],attachments:[{id:'a'},{id:'b'}],retryAttachmentIds:['a','b']};
 const before=structuredClone(c.messages);
 F.remove(c,{type:'import',id:'a'});
 assert.equal(c.mobileContext,undefined);
 const next=await nextTurn(s,c);
 assert.deepEqual(next.attachmentIds,['b']);
 assert.deepEqual(next.selectedIds,[]);
 assert.deepEqual(c.messages,before);
});

test('reference refresh and failed durable selection keep legacy carry-over and restore only the attempted change',async()=>{
 const {s,c}=fixture(),original=await F.libraryRef(s,'note','n');
 c.messages[0].fileReferences=[original];s.notes[0].content='已修订的笔记';
 const updated=await F.libraryRef(s,'note','n');F.refresh(c,updated);
 assert.equal(c.mobileContext,undefined);
 assert.equal(c.messages[0].fileReferences[0].version,original.version);
 assert.equal(c.messages[0].retryFileReferences[0].version,updated.version);
 const snapshot=structuredClone(c);
 s.notes.push({id:'n2',title:'第二份笔记',content:'仅用于失败保存'});
 const selection=Selection.create({getState:()=>s,getConversation:()=>c,access:(state,ref)=>({available:!!F.available(state,ref.type,ref.id)}),save:async()=>false});
 await assert.rejects(selection.mutate({action:'add-reference',conversationId:c.id,ref:await F.libraryRef(s,'note','n2')}),/未保存/);
 assert.deepEqual(c,snapshot);
 assert.deepEqual((await nextTurn(s,c)).attachmentIds,['a','b']);
});

test('existing portable selection remains authoritative, including an explicit empty selection from another device',()=>{
 for(const keys of [[],['imports:b']]){
  const {c}=fixture();c.mobileContext={version:1,keys,source:{kind:'notes',id:'origin'}};
  F.stage(c,{type:'note',id:'n'});
  assert.deepEqual(new Set(c.mobileContext.keys),new Set([...keys,'notes:n']));
  assert.deepEqual(c.mobileContext.source,{kind:'notes',id:'origin'});
  assert.equal(F.references(c).some(r=>r.id==='a'),false);
 }
});

test('ordinary new reference conversations still publish portable context; excluded or inactive old histories are never resurrected',()=>{
 const c={messages:[
  {role:'user',attachmentIds:['excluded','retry-removed','bad/id'],retryAttachmentIds:['excluded']},
  {role:'user',attachmentIds:['deleted'],deletedAt:1},
  {role:'user',attachmentIds:['archived'],archived:true},
  {role:'user',attachmentIds:['private'],private:true},
  {role:'assistant',attachmentIds:['assistant-file']}
 ],excludedFileReferenceKeys:[F.key({type:'import',id:'excluded'})]};
 F.stage(c,{type:'note',id:'n'});
 assert.deepEqual(c.mobileContext,{version:1,keys:['notes:n'],source:null});
 assert.deepEqual(F.references(c),[{type:'note',id:'n'}]);
});
