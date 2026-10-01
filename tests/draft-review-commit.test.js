const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../app/draft-review.js');
const fixture = () => ({ projects:[{id:'p'}], notes:[{id:'n',projectId:'p',title:'Human',content:'Original',updatedAt:1,revisionHistory:[{content:'Earlier'}],aiDraft:{title:'Proposed',content:'New body',createdAt:2}}] });
const defer = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const snapshot = state => ({type:'note',id:'n',operation:'drafted',after:{aiDraft:structuredClone(state.notes[0].aiDraft)}});
for(const action of ['adopt','discard'])test(`${action} waits for persistence and rolls its own mutation back on false or rejection`,async()=>{
 for(const failure of [false,Error('disk full')]){
  const state=fixture(),before=structuredClone(state),gate=defer(),review=R.begin(state,'n');let settled=false;
  const operation=R.commit(state,review,action,()=>gate.promise);operation.then(()=>{settled=true;},()=>{});
  assert.equal(state.notes[0].aiDraft,undefined);await Promise.resolve();assert.equal(settled,false);
  failure===false?gate.resolve(false):gate.reject(failure);await assert.rejects(operation);assert.deepEqual(state,before);
  await R.commit(state,review,action,async()=>true);assert.equal(state.notes[0].aiDraft,undefined);assert.equal(state.notes[0].content,action==='adopt'?'New body':'Original');
 }
});
test('same decision coalesces by state and note; conflicting decision is busy and never persisted twice',async()=>{
 const state=fixture(),gate=defer(),review=R.begin(state,'n');let saves=0;const persist=()=>{saves++;return gate.promise;};
 const first=R.commit(state,review,'adopt',persist),second=R.commit(state,structuredClone(review),'adopt',persist);assert.equal(first,second);
 await assert.rejects(R.commit(state,review,'discard',persist),/正在保存/);await Promise.resolve();assert.equal(saves,1);gate.resolve(true);await first;
 await assert.rejects(R.commit(state,review,'adopt',persist),/修改/);assert.equal(saves,1);
});
test('failed review preserves a concurrent body, new draft and unrelated records, removes only its own appended histories',async()=>{
 const state=fixture(),gate=defer(),operation=R.commit(state,R.begin(state,'n'),'adopt',()=>gate.promise),note=state.notes[0];
 note.content='Concurrent human edit';note.aiDraft={content:'A newer proposal'};note.updatedAt=99;
 const laterRevision={content:'Concurrent revision'},laterDecision={action:'discard',draft:{content:'Different'},reviewedAt:88};note.revisionHistory.push(laterRevision);note.aiDraftHistory.push(laterDecision);state.notes.push({id:'other',content:'Keep'});
 gate.reject(Error('failed'));await assert.rejects(operation);
 assert.equal(note.content,'Concurrent human edit');assert.deepEqual(note.aiDraft,{content:'A newer proposal'});assert.equal(note.updatedAt,99);
 assert.deepEqual(note.revisionHistory,[{content:'Earlier'},laterRevision]);assert.deepEqual(note.aiDraftHistory,[laterDecision]);assert.equal(state.notes[1].content,'Keep');
});
test('bounded revision history recovers its dropped prefix while preserving later appends',async()=>{
 const state=fixture();state.notes[0].revisionHistory=Array.from({length:20},(_,i)=>({content:'old'+i}));const before=structuredClone(state.notes[0].revisionHistory),gate=defer();
 const operation=R.commit(state,R.begin(state,'n'),'adopt',()=>gate.promise);state.notes[0].revisionHistory.push({content:'later'});gate.reject(Error('failed'));await assert.rejects(operation);
 assert.deepEqual(state.notes[0].revisionHistory,[...before,{content:'later'}]);
});
test('failure never resurrects deletion or overwrites replacement identity',async()=>{
 for(const replacement of [null,{id:'n',title:'Restored',content:'Replacement'}]){
  const state=fixture(),gate=defer(),operation=R.commit(state,R.begin(state,'n'),'adopt',()=>gate.promise);state.notes=replacement?[replacement]:[];
  gate.reject(Error('failed'));await assert.rejects(operation);assert.deepEqual(state.notes,replacement?[replacement]:[]);
 }
});
test('workspace replacement wins on failure; later deletion prevents a success result',async()=>{
 const state=fixture(),gate=defer();let live=state;
 const operation=R.commit(state,R.begin(state,'n'),'adopt',()=>gate.promise,{getState:()=>live});live=fixture();live.notes[0].content='Replacement workspace';gate.reject(Error('failed'));await assert.rejects(operation);assert.equal(live.notes[0].content,'Replacement workspace');
 const second=fixture(),wait=defer(),saving=R.commit(second,R.begin(second,'n'),'adopt',()=>wait.promise);second.notes=[];wait.resolve(true);await assert.rejects(saving,/变化/);
});
test('stale proposal and archived owner are rejected before persistence',async()=>{
 for(const mutate of [s=>s.notes[0].aiDraft.content='Later',s=>s.projects[0].archivedAt=123]){
  const state=fixture(),review=R.begin(state,'n');mutate(state);let saves=0;await assert.rejects(R.commit(state,review,'adopt',()=>{saves++;return true;}));assert.equal(saves,0);
 }
});
test('proposal statuses track exact evidence and never infer acceptance from matching text',async()=>{
 const state=fixture(),change=snapshot(state);assert.equal(R.proposalStatus(state,change).status,'pending');
 const before=JSON.stringify(change);await R.commit(state,R.begin(state,'n'),'adopt',async()=>true);assert.equal(R.proposalStatus(state,change).status,'adopted');assert.equal(JSON.stringify(change),before);
 state.notes[0].aiDraft={content:'Newer draft'};assert.equal(R.proposalStatus(state,change).status,'adopted');
 const second=snapshot(state);await R.commit(state,R.begin(state,'n'),'discard',async()=>true);assert.equal(R.proposalStatus(state,second).status,'discarded');
 const untracked=fixture(),old=snapshot(untracked);untracked.notes[0].aiDraft={content:'New'};assert.equal(R.proposalStatus(untracked,old).status,'superseded');delete untracked.notes[0].aiDraft;untracked.notes[0].content=old.after.aiDraft.content;assert.equal(R.proposalStatus(untracked,old).status,'unavailable');
});
test('status resolves canonical snapshots but rejects wrong run, ambiguous identities, retired notes and archived projects',()=>{
 const state=fixture();state.notes[0].aiDraft.provenance={origin:{recorded:true,runId:'r'},output:{type:'note',id:'n',variant:'draft'}};
 const change=snapshot(state);const original=state.notes[0].aiDraft;state.notes[0].aiDraft=Object.fromEntries(Object.entries(original).reverse());assert.equal(R.proposalStatus(state,change,{runId:'r'}).status,'pending');assert.equal(R.proposalStatus(state,change,{runId:'other'}).status,'unavailable');
 const withBody=structuredClone(state);withBody.notes[0].provenance=structuredClone(original.provenance);withBody.notes[0].provenance.output.variant='body';delete withBody.notes[0].aiDraft;assert.equal(R.proposalStatus(withBody,change,{runId:'r'}).status,'adopted');
 for(const mutate of [s=>s.notes.push({...s.notes[0]}),s=>s.projects.push({...s.projects[0]}),s=>s.projects[0].archivedAt=4,s=>s.trash=[{data:{notes:[{id:'n'}]}}]]){const next=structuredClone(state);mutate(next);assert.equal(R.proposalStatus(next,change,{runId:'r'}).status,'unavailable');}
});
test('proposal redraw while saving does not advertise optimistic mutation as an accepted decision',async()=>{
 const state=fixture(),change=snapshot(state),gate=defer(),review=R.begin(state,'n');const saving=R.commit(state,review,'adopt',()=>gate.promise);
 const status=R.proposalStatus(state,change);assert.equal(status.status,'pending');assert.equal(status.saving,true);assert.match(status.label,/正在保存/);assert.deepEqual(status.review,review);
 gate.resolve(true);await saving;assert.equal(R.proposalStatus(state,change).status,'adopted');assert.equal(R.proposalStatus(state,change).saving,undefined);
});
test('replacing a history array while appending preserves its later entry but removes our exact failed decision',async()=>{
 const state=fixture(),gate=defer(),saving=R.commit(state,R.begin(state,'n'),'adopt',()=>gate.promise),note=state.notes[0];
 const later={action:'discard',draft:{content:'Other'},reviewedAt:500};note.aiDraftHistory=[...note.aiDraftHistory,later];note.revisionHistory=[...note.revisionHistory,{content:'Later'}];gate.reject(Error('failed'));await assert.rejects(saving);
 assert.deepEqual(note.aiDraftHistory,[later]);assert.deepEqual(note.revisionHistory,[{content:'Earlier'},{content:'Later'}]);
});
