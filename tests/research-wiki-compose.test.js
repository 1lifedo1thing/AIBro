const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const W=require('../app/research-wiki.js');
const context={ResearchWiki:W};vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../app/research-wiki-ui.js'),'utf8'),context);
const commit=context.ResearchWikiUI.createEntryDurably;
function fixture(){
 const draft={title:'新的研究问题',type:'idea',projectId:'p',sections:{question:'已确认观察',hypothesis:'暂未验证',versions:'其他类型保留字段'}};
 const state={ui:{wikiDraft:structuredClone(draft)},notes:[],projects:[{id:'p',name:'研究',workspace:'科研'}]};
 let sequence=0,saveCalls=0,createCalls=0;
 const hooks={getState:()=>state,save:()=>saveCalls++,create:action=>{createCalls++;return W.apply(state,action,{projectId:action.projectId,protectNoteUpdates:false,uid:()=>`new-${++sequence}`,now:1000}).note;},persist:async()=>true};
 return {draft,state,hooks,counts:()=>({saveCalls,createCalls})};
}
test('new note and draft removal share the same acknowledgement while only current type fields are applied',async()=>{
 const f=fixture();let finish;
 f.hooks.persist=()=>{assert.equal(f.state.notes.length,1);assert.equal(f.state.ui.wikiDraft,undefined);return new Promise(resolve=>finish=resolve)};
 const pending=commit(f.hooks,f.draft);assert.equal(f.state.notes.length,1);finish(true);const note=await pending;
 assert.equal(note.id,'new-1');assert.match(note.content,/已确认观察/);assert.ok(!note.content.includes('其他类型保留字段'));assert.equal(note.aiDraft,undefined);assert.equal(f.state.ui.wikiDraft,undefined);assert.equal(f.counts().saveCalls,0);
});
test('rejected or false acknowledgement rolls back only the new note and restores the complete draft',async()=>{
 for(const result of ['reject','false']){
  const f=fixture();f.hooks.persist=async()=>{if(result==='reject')throw Error('Storage unavailable');return false};
  await assert.rejects(commit(f.hooks,f.draft),result==='reject'?/Storage unavailable/:/未得到确认/);
  assert.equal(f.state.notes.length,0);assert.deepEqual(JSON.parse(JSON.stringify(f.state.ui.wikiDraft)),f.draft);assert.equal(f.counts().saveCalls,1);
 }
});
test('failure, edited draft and reopened retry create one approved record without an AI draft',async()=>{
 const f=fixture();f.hooks.persist=async()=>{throw Error('offline')};await assert.rejects(commit(f.hooks,f.draft));
 const reopened={...f.state.ui.wikiDraft,title:'重试后的标题',sections:{...f.state.ui.wikiDraft.sections,question:'修改后的观察'}};f.state.ui.wikiDraft=reopened;f.hooks.persist=async()=>true;
 const note=await commit(f.hooks,reopened);assert.equal(f.state.notes.length,1);assert.match(note.content,/修改后的观察/);assert.equal(note.title,'重试后的标题');assert.equal(note.aiDraft,undefined);assert.equal(f.state.ui.wikiDraft,undefined);
});
test('same-title existing approved content and review drafts cannot be overwritten by the new-entry flow',async()=>{
 for(const workspace of ['科研','日常']){
  const f=fixture();f.state.notes.push({id:'existing',title:f.draft.title,workspace,projectId:'p',kind:'科研 Wiki/idea',content:'approved body',aiDraft:{content:'review draft'},updatedAt:5});const before=JSON.stringify(f.state.notes);
  await assert.rejects(commit(f.hooks,f.draft),/已有同名/);assert.equal(f.counts().createCalls,0);assert.equal(JSON.stringify(f.state.notes),before);assert.ok(f.state.ui.wikiDraft);
 }
});
test('invalid or archived project keeps draft ownership and refuses before creating a note',async()=>{
 const f=fixture();f.state.projects[0].archivedAt=1;await assert.rejects(commit(f.hooks,f.draft),/有效的科研项目/);assert.equal(f.state.notes.length,0);assert.equal(f.state.ui.wikiDraft.projectId,'p');
});
test('failure never rolls back another operation and retains an identity that blocks duplicate retries',async()=>{
 const f=fixture();f.hooks.persist=async()=>{f.state.notes[0].content='Concurrent approved edit';f.state.notes[0].updatedAt=1001;throw Error('Save failed')};
 await assert.rejects(commit(f.hooks,f.draft),error=>error.retainedNoteId==='new-1');assert.equal(f.state.notes[0].content,'Concurrent approved edit');assert.equal(f.state.ui.wikiDraft.pendingNoteId,'new-1');
 await assert.rejects(commit(f.hooks,f.state.ui.wikiDraft),error=>error.retainedNoteId==='new-1');assert.equal(f.counts().createCalls,1);
});
test('rollback uses the current workspace state and never deletes unrelated records or overwrites a newer draft',async()=>{
 const f=fixture();let current=f.state;f.hooks.getState=()=>current;
 f.hooks.persist=async()=>{current=structuredClone(f.state);current.notes.push({id:'other',content:'Keep me'});current.ui.wikiDraft={title:'Newer draft',sections:{}};throw Error('Failure after adoption')};
 await assert.rejects(commit(f.hooks,f.draft));assert.deepEqual(current.notes,[{id:'other',content:'Keep me'}]);assert.equal(current.ui.wikiDraft.title,'Newer draft');
});
