const {test}=require('node:test'),assert=require('node:assert/strict');
const F=require('../app/file-context.js'),E=require('../app/local-file-edits.js');
const draft=(runId,id)=>({content:`Draft ${id}`,provenance:{origin:{recorded:true,runId},output:{type:'note',id,variant:'draft'}}});
const proposed=(id,value)=>({type:'note',id,operation:'drafted',after:{aiDraft:structuredClone(value)}});
const decide=(note,action)=>{const value=structuredClone(note.aiDraft);note.aiDraftHistory=[...(note.aiDraftHistory||[]),{action,reviewedAt:10,draft:value}];if(action==='adopt'){note.content=value.content;note.provenance={origin:value.provenance.origin,output:{type:'note',id:note.id,variant:'body'}};}delete note.aiDraft;};
const ref={type:'local',candidateId:'c',projectId:'p',path:'notes/plan.md',version:'v'},state={projects:[{id:'p',localFolder:{id:'c'}}]},run={id:'r',projectId:'p'};
test('updates derive identity from actual references, not generated paths',()=>{const result=E.validate([{operation:'update',refKey:F.key(ref),path:'/evil',version:'invented',content:'# After'}],state,run,{snapshots:[ref],fullyRead:()=>true});assert.equal(result[0].path,ref.path);assert.equal(result[0].version,'v');});
test('incomplete reads, unreferenced edits, disconnected roots and duplicates fail closed',()=>{const e={operation:'update',refKey:F.key(ref),content:'next'};for(const context of [{snapshots:[ref],fullyRead:()=>false},{snapshots:[],fullyRead:()=>true}])assert.throws(()=>E.validate([e],state,run,context));assert.throws(()=>E.validate([e],{projects:[]},run,{snapshots:[ref],fullyRead:()=>true}));assert.throws(()=>E.validate([e,e],state,run,{snapshots:[ref],fullyRead:()=>true}));});
test('creation stays in the current project with a plain relative md/txt path',()=>{const e={operation:'create',projectId:'p',path:'new.md',content:'# New'};assert.equal(E.validate([e],state,run,{}).length,1);for(const path of ['../a.md','/a.md','.env.md','a.exe','a\\b.md'])assert.throws(()=>E.validate([{...e,path}],state,run,{}));assert.throws(()=>E.validate([{...e,projectId:'other'}],state,run,{}));assert.deepEqual(E.validate(undefined,state,run,{}),[]);});
test('full coverage requires reading the middle, not only first and last pages',async()=>{const text='a'.repeat(30000);const context=await F.prepare(state,[ref],{readLocal:async(_,{offset})=>({version:'v',offset,text:text.slice(offset,offset+12000),totalChars:text.length,nextOffset:offset+12000<text.length?offset+12000:null})});assert.equal(context.fullyRead(F.key(ref)),false);await context.read({refKey:F.key(ref),offset:24000});assert.equal(context.fullyRead(F.key(ref)),false);await context.read({refKey:F.key(ref),offset:12000});assert.equal(context.fullyRead(F.key(ref)),true);});
test('server character offsets, not JavaScript UTF-16 length, govern read coverage',async()=>{const context=await F.prepare(state,[ref],{readLocal:async(_,{offset})=>({version:'v',offset,text:'😀'.repeat(Math.min(12000,30000-offset)),totalChars:30000,nextOffset:offset+12000<30000?offset+12000:null})});await context.read({refKey:F.key(ref),offset:24000});assert.equal(context.fullyRead(F.key(ref)),false);await context.read({refKey:F.key(ref),offset:12000});assert.equal(context.fullyRead(F.key(ref)),true);});

test('saved creation follows its original conversation and undo removes the reference',()=>{
 const s={conversations:[{id:'origin',messages:[]},{id:'other',messages:[]}]},r={conversationId:'origin'},e={candidateId:'c',projectId:'p',path:'new.md',beforeVersion:null,afterVersion:'new'};
 E.followUp(s,r,e,'apply');assert.equal(F.references(s.conversations[0])[0].version,'new');assert.equal(F.references(s.conversations[1]).length,0);
 E.followUp(s,r,e,'undo');assert.equal(F.references(s.conversations[0]).length,0);
 E.followUp(s,r,e,'apply');assert.equal(F.references(s.conversations[0]).length,0,'respects explicit exclusion');
});
test('acceptance never rewinds a newer reference or changes historical message snapshots',()=>{
 const c={id:'origin',messages:[{role:'user',fileReferences:[ref]}]},s={conversations:[c]},r={conversationId:c.id},e={...ref,beforeVersion:'v',afterVersion:'v2'};
 E.followUp(s,r,e,'apply');assert.equal(F.references(c)[0].version,'v2');assert.equal(c.messages[0].fileReferences[0].version,'v');
 F.refresh(c,{...ref,version:'v3'});E.followUp(s,r,e,'undo');assert.equal(F.references(c)[0].version,'v3');
});
test('shelf retains pending proposals from failed turns, isolates chats and deduplicates library files',()=>{
 const value=draft('new','n');
 const s={conversations:[{id:'a'},{id:'b'}],projects:[{id:'p'},{id:'local-p',localFolder:{id:'local-c'}}],notes:[{id:'n',title:'Current title',projectId:'p',aiDraft:value}],agentRuns:[
 {id:'old',conversationId:'a',startedAt:1,fileChanges:[{type:'note',id:'n',operation:'updated'}],localFileEdits:[{id:'pending',runId:'old',projectId:'local-p',candidateId:'local-c',path:'a.md',status:'pending'}],status:'failed'},
 {id:'new',conversationId:'a',startedAt:2,fileChanges:[proposed('n',value)]},
 {id:'private',conversationId:'b',localFileEdits:[{id:'secret',path:'secret.md'}]}]};
 const rows=E.outputs(s,'a');assert.equal(rows.length,2);assert(rows.every(r=>r.pending));assert.equal(rows.find(r=>r.kind==='note').title,'Current title');
 decide(s.notes[0],'adopt');const saved=E.outputs(s,'a').find(r=>r.kind==='note');assert.equal(saved.pending,false);assert.equal(saved.status,'adopted');assert.equal(saved.runId,'new');
 s.projects[0].archived=true;assert.equal(E.outputs(s,'a').length,1);
});

test('adopting the second proposal and discarding the first leaves exactly one real conversation output',()=>{
 const notes=['first','second'].map(id=>({id,title:id,projectId:'p',content:'Original',aiDraft:draft('r',id)}));
 const s={conversations:[{id:'a'},{id:'b'}],projects:[{id:'p'}],notes,agentRuns:[{id:'r',conversationId:'a',fileChanges:notes.map(note=>proposed(note.id,note.aiDraft))}]};
 assert.equal(E.outputs(s,'a').filter(row=>row.pending).length,2);
 decide(notes[1],'adopt');decide(notes[0],'discard');
 assert.deepEqual(E.outputs(s,'a'),[{kind:'note',runId:'r',id:'second',title:'second',pending:false,status:'adopted'}]);
 assert.equal(s.agentRuns[0].fileChanges.length,2,'historical proposal snapshots remain available for message review');
});

test('drafted results require exact pending or adopted evidence, never just a current aiDraft',()=>{
 for(const unavailable of ['discarded','superseded','missing','wrong-run','changed-proposal']){
  const value=draft('r','n'),note={id:'n',title:'Note',projectId:'p',aiDraft:structuredClone(value)},change=proposed('n',value);
  const s={conversations:[{id:'a'},{id:'b'}],projects:[{id:'p'}],notes:[note],agentRuns:[{id:'r',conversationId:'a',fileChanges:[change]}]};
  if(unavailable==='discarded')decide(note,'discard');
  if(unavailable==='superseded')note.aiDraft=draft('new','n');
  if(unavailable==='missing')delete change.after.aiDraft;
  if(unavailable==='wrong-run')change.after.aiDraft.provenance.origin.runId='other';
  if(unavailable==='changed-proposal')note.aiDraft.content='Different pending proposal';
  assert.deepEqual(E.outputs(s,'a'),[],unavailable);
 }
});

test('an unrelated current draft cannot relabel an older saved change as pending',()=>{
 const note={id:'n',title:'Note',projectId:'p',aiDraft:draft('new','n')};
 const s={conversations:[{id:'a'},{id:'b'}],projects:[{id:'p'}],notes:[note],agentRuns:[{id:'old',conversationId:'a',fileChanges:[{type:'note',id:'n',operation:'updated'}]},
  {id:'new',conversationId:'b',fileChanges:[proposed('n',note.aiDraft)]}]};
 assert.deepEqual(E.outputs(s,'a'),[{kind:'note',runId:'old',id:'n',title:'Note',pending:false}]);
 assert.equal(E.outputs(s,'b')[0].pending,true);assert.equal(E.outputs(s,'b')[0].runId,'new');
});

test('rejected, unavailable or undone recent candidates do not consume a saved file deduplication identity',()=>{
 for(const unavailable of ['discarded','superseded','missing','undone']){
  const note={id:'n',title:'Note',projectId:'p',aiDraft:draft('new','n')},change=proposed('n',note.aiDraft);
  const s={conversations:[{id:'a'},{id:'b'}],projects:[{id:'p'}],notes:[note],agentRuns:[{id:'old',conversationId:'a',startedAt:1,fileChanges:[{type:'note',id:'n',operation:'updated'}]},
   {id:'new',conversationId:'a',startedAt:2,fileChanges:[change]}]};
  if(unavailable==='discarded')decide(note,'discard');
  if(unavailable==='superseded')note.aiDraft=draft('newest','n');
  if(unavailable==='missing')delete change.after.aiDraft;
  if(unavailable==='undone')change.undoneAt=10;
  assert.deepEqual(E.outputs(s,'a'),[{kind:'note',runId:'old',id:'n',title:'Note',pending:false}],unavailable);
 }
});

test('an adopted historical proposal remains saved when a different run supplies a newer draft',()=>{
 const note={id:'n',title:'Note',projectId:'p',aiDraft:draft('r','n')},change=proposed('n',note.aiDraft);
 const s={conversations:[{id:'a'},{id:'b'}],projects:[{id:'p'}],notes:[note],agentRuns:[{id:'r',conversationId:'a',fileChanges:[change]}]};
 decide(note,'adopt');note.aiDraft=draft('new','n');
 assert.equal(E.outputs(s,'a')[0].pending,false);assert.equal(E.outputs(s,'a')[0].status,'adopted');
});

test('tray resolves the late-loaded shared review API and opens the exact second file',()=>{
 const vm=require('node:vm'),fs=require('node:fs'),roots=[];
 class Node{constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this._text='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;this._text='';}before(node){roots.push(node);}set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}}
 const all=()=>roots.flatMap(function walk(node){return[node,...node.children.flatMap(walk)];});
 const composer=new Node('div');composer.id='composer';roots.push(composer);
 const context=vm.createContext({FileContext:F,document:{createElement:tag=>new Node(tag),getElementById:id=>all().find(node=>node.id===id)}});
 vm.runInContext(fs.readFileSync(require.resolve('../app/local-file-edits.js'),'utf8'),context);
 // Browser order loads DraftReview after LocalFileEdits, before this render.
 context.DraftReview=require('../app/draft-review.js');context.FileReview=require('../app/file-review.js');
 const notes=['first','second'].map(id=>({id,title:id,projectId:'p',aiDraft:draft('r',id)}));
 const s={conversations:[{id:'a'},{id:'b'}],projects:[{id:'p'}],notes,agentRuns:[{id:'r',conversationId:'a',fileChanges:notes.map(note=>proposed(note.id,note.aiDraft))}]},opened=[];
 context.LocalFileEdits.init({getState:()=>s,openReview:(...args)=>opened.push(args)});context.LocalFileEdits.tray({id:'a'});
 const reviewButtons=all().filter(node=>node.className==='output-review');assert.equal(reviewButtons.length,2);
 reviewButtons[1].onclick();assert.equal(opened.length,1);assert.deepEqual(opened[0].slice(0,2),['r','second']);assert.equal(opened[0][2].anchor,undefined);
 decide(notes[0],'discard');decide(notes[1],'adopt');context.LocalFileEdits.tray({id:'a'});
 const host=all().find(node=>node.id==='conversationOutputs');assert.match(host.textContent,/对话产出 · 1/);assert.match(host.textContent,/second已入库/);assert.doesNotMatch(host.textContent,/first|待采纳草稿/);
});

test('code and configuration proposals preserve the same full-read and project checks',()=>{
 for(const path of ['main.py','app.tsx','package.json','config.yaml','Cargo.toml'])assert.equal(E.validate([{operation:'create',projectId:'p',path,content:'plain text'}],state,run,{}).length,1);
 for(const path of ['data.sqlite','paper.pdf','document.docx','.env'])assert.throws(()=>E.validate([{operation:'create',projectId:'p',path,content:'x'}],state,run,{}));
});
test('directory proposals retain project scope and do not become text references',()=>{
 const edit={operation:'mkdir',projectId:'p',path:'outputs'};
 assert.equal(E.validate([edit],state,run,{}).length,1);
 for(const path of ['../outside','/outside','a\\b','.hidden','a//b'])assert.throws(()=>E.validate([{...edit,path}],state,run,{}));
 assert.throws(()=>E.validate([{...edit,projectId:'other'}],state,run,{}));
 const s={conversations:[{id:'origin',messages:[]}]};E.followUp(s,{conversationId:'origin'},{directory:true,...edit},'apply');assert.equal(F.references(s.conversations[0]).length,0);
});
