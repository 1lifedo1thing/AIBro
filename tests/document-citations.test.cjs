'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Evidence=require('../app/citation-evidence');
const Capture=require('../app/note-capture');
const Provenance=require('../app/artifact-provenance');
const Editor=require('../app/note-editor');
const href=source=>`#aibro-source-${encodeURIComponent(source.sourceId)}`;
const marker=source=>`[[cite:${source.sourceId}]]`;
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const message={id:'answer',role:'agent',runId:'run',text:''};
 const run={id:'run',conversationId:'chat',evidenceSources:[]};
 const state={projects:[{id:'project',localFolder:{id:'folder'}}],conversations:[{id:'chat',messages:[message]}],agentRuns:[run],notes:[],tasks:[],papers:[],trash:[],imports:[{id:'pdf',name:'教材.pdf',content:'original pages'}]};
 const a=Evidence.capture(run,{type:'import',id:'pdf',title:'教材.pdf',page:2,excerpt:'private excerpt not copied'},state);
 const b=Evidence.capture(run,{type:'import',id:'pdf',title:'教材.pdf',page:16,excerpt:'another immutable excerpt'},state);
 message.text=`# 复习笔记\n\n第一处 ${marker(a)}，第十六页 ${marker(b)}。`;
 const save=()=>{const result=Capture.plan(state,'answer',{id:'saved',now:42,citationEvidence:Evidence});assert.equal(result.kind,'create');state.notes.push(result.note);return result.note;};
 return {state,run,message,a,b,save};
}
function host(state){
 const raw=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
 const portion=(start,end)=>raw.slice(raw.indexOf(start),raw.indexOf(end,raw.indexOf(start)));
 const calls=[],context={state,storageHydrated:true,serverConflict:false,window:{CitationEvidence:Evidence},toast:()=>{},showView:Object.assign(()=>{},{navigationVersion:0}),console};
 context.openPreview=async(kind,id,page,source,valid)=>{if(!valid()||!context.previewSourceAvailable(source))return false;calls.push({kind,id,page,source});state.previewRecord={type:kind,id};return true;};
 context.openSearchResult=async(key,valid)=>{if(!valid())return false;calls.push({key});return true;};
 vm.createContext(context);
 vm.runInContext(portion('function previewSourceAvailable(source) {','function documentTabSource(')+'\n'+portion('async function openSavedDocumentSource(','document.addEventListener(\'click\', event => {'),context);
 return {context,calls,available:context.previewSourceAvailable,open:context.openSavedDocumentSource};
}

test('capture saves explicit page links and a compact receipt; code examples and original message remain exact',()=>{
 const h=fixture();h.message.text+=`\n\nInline \`${marker(h.a)}\`.\n\n\`\`\`md\n${marker(h.b)}\n\`\`\`\nUnknown [[cite:invented]].`;
 const before=clone(h.message),note=h.save();
 assert.match(note.content,new RegExp(`\\[1\\]\\(${href(h.a)}\\)`));assert.ok(note.content.includes(`[2](${href(h.b)})`));
 assert.ok(note.content.includes(`\`${marker(h.a)}\``));assert.ok(note.content.includes(`\n${marker(h.b)}\n`));assert.ok(note.content.includes('[引用不可用]'));
 assert.deepEqual(h.message,before);assert.equal(note.provenance.origin.runId,'run');assert.equal(note.provenance.operation,'captured');
 assert.deepEqual(note.provenance.inputs.map(s=>s.page),[2,16]);assert.ok(!JSON.stringify(note.provenance).includes('excerpt not copied'));assert.ok(note.provenance.inputs.every(s=>!Object.hasOwn(s,'excerpt')));
 const exported=Evidence.exportText(h.message,h.run,h.state);assert.ok(exported.includes('引用来源'));assert.ok(exported.includes('private excerpt not copied'));assert.ok(!exported.includes('#aibro-source-'),'portable text export keeps its own appendix contract');
});

test('durable source survives JSON persistence and cleared public run/conversation, then production host opens exact page',async()=>{
 const h=fixture();h.save();const state=clone(h.state);state.agentRuns=[];state.conversations=[];
 const source=Evidence.documentSource(state,'saved',href(h.b));assert.equal(source.page,16);assert.equal(source.runId,'run');assert.equal(source.excerpt,null);
 const app=host(state);assert.equal(app.available(source),true);assert.equal(await app.open('saved',href(h.b)),true);
 assert.equal(app.calls.length,1);assert.deepEqual([app.calls[0].kind,app.calls[0].id,app.calls[0].page],['import','pdf',16]);
 assert.equal(app.calls[0].source.runId,'run','retain historical ownership for future private ancestry checks without requiring the run to exist');
});

test('production host rejects a changed mapping or route after its leave decision',async()=>{
 for(const change of [h=>{h.state.notes[0].provenance.inputs[1].page=17;},h=>{h.app.context.showView.navigationVersion++;},h=>{h.state.imports[0].private=true;}]){
  const h=fixture();h.save();h.app=host(h.state);let opened=false;
  h.app.context.openPreview=async(kind,id,_page,_source,valid)=>{await Promise.resolve();change(h);if(valid()){opened=true;h.state.previewRecord={type:kind,id};}};
  assert.equal(await h.app.open('saved',href(h.b)),false);assert.equal(opened,false);
 }
});

test('private durable origins and retired private ancestors deny document navigation',async()=>{
 for(const change of [
  h=>{h.state.notes[0].provenance.origin.private=true;},
  h=>{h.state.imports[0].private=true;},
  h=>{h.state.trash=[{data:{runs:[{id:'run',private:true}]}}];},
  h=>{h.state.trash=[{data:{conversations:[{id:'chat',ephemeral:true}]}}];},
  h=>{h.state.imports[0].provenance={origin:{private:true}};}
 ]){
  const h=fixture();h.save();const source=Evidence.documentSource(h.state,'saved',href(h.a));h.state.agentRuns=[];h.state.conversations=[];change(h);
  assert.equal(Evidence.documentSource(h.state,'saved',href(h.a)),null);
  const app=host(h.state);assert.equal(await app.open('saved',href(h.a)),false);assert.equal(app.calls.length,0);
  if(!h.state.notes[0].provenance.origin.private)assert.equal(app.available(source),false,'direct source ownership also remains guarded');
 }
});

test('private-at-capture stays private after ephemeral source owners are purged',()=>{
 const h=fixture();h.state.conversations[0].ephemeral=true;const note=h.save();
 assert.equal(note.provenance.origin.private,true);assert.ok(!note.content.includes('#aibro-source-'));
 h.state.agentRuns=[];h.state.conversations=[];assert.equal(Evidence.documentSource(h.state,'saved',href(h.a)),null);
});

test('missing, deleted, ambiguous, other-note and malformed mappings never acquire a destination',()=>{
 for(const change of [
  h=>{h.state.imports=[];},h=>{h.state.imports[0].deletedAt=1;},h=>{h.state.imports[0].archived=true;},h=>{h.state.imports.push(clone(h.state.imports[0]));},
  h=>{h.state.notes[0].deletedAt=1;},h=>{h.state.notes.push(clone(h.state.notes[0]));},
  h=>{delete h.state.notes[0].provenance;},h=>{h.state.notes[0].provenance.output.id='another-note';},
  h=>{h.state.notes[0].provenance.output.variant='draft';},h=>{h.state.notes[0].provenance.origin.recorded=false;},
  h=>{h.state.notes[0].provenance.inputs.push({...h.state.notes[0].provenance.inputs[0],provided:false});},
  h=>{h.state.notes[0].provenance.inputs[0].provided=false;},h=>{h.state.notes[0].provenance.inputs=[];}
 ]){const h=fixture();h.save();change(h);assert.equal(Evidence.documentSource(h.state,'saved',href(h.a)),null);}
 const h=fixture();h.save();for(const url of ['#aibro-source-%','javascript:bad','#aibro-source-unknown','#aibro-source-%0a','#heading','file:/a.pdf'])assert.equal(Evidence.documentSource(h.state,'saved',url),null,url);
 h.state.notes.push({id:'ordinary',content:`第16页 [1](${href(h.a)})`});assert.equal(Evidence.documentSource(h.state,'ordinary',href(h.a)),null);
});

test('ambiguous or foreign conversation runs do not create false citation receipts',()=>{
 for(const change of [h=>{h.state.agentRuns.push(clone(h.run));},h=>{h.run.conversationId='other';},h=>{h.state.agentRuns=[];}]){
  const h=fixture();change(h);const note=h.save();assert.equal(note.provenance,undefined);assert.deepEqual(note.sourceAttachmentIds,[]);assert.ok(!note.content.includes('#aibro-source-'));assert.ok(note.content.includes('[引用不可用]'));
 }
 const h=fixture();h.run.evidenceSources.push({...h.a,page:99});const note=h.save();assert.ok(!note.content.includes(href(h.a)));assert.equal(Evidence.documentSource(h.state,'saved',href(h.a)),null);
});

test('AI draft and saved-body provenance remain separate through review and adoption',()=>{
 const h=fixture(),note=h.save();const draftRun={id:'draft-run',conversationId:'chat',evidenceSources:[{...h.b,sourceId:'draft-source'}]};
 note.aiDraft={content:'草稿 [1](#aibro-source-draft-source)'};
 note.aiDraft.provenance=Provenance.capture(h.state,draftRun,{type:'note',id:note.id,record:note,variant:'draft',operation:'drafted'});
 assert.equal(Evidence.documentSource(h.state,'saved','#aibro-source-draft-source'),null);
 assert.equal(Evidence.documentSource(h.state,'saved',href(h.a),{variant:'draft'}),null);
 assert.equal(Evidence.documentSource(h.state,'saved','#aibro-source-draft-source',{variant:'draft'}).page,16);
 const session=Editor.begin(h.state,'saved');session.content=note.aiDraft.content;session.appliedAiDraft=JSON.stringify(note.aiDraft);
 const after=Editor.prepare(h.state,session,88).after;h.state.notes=[after];assert.equal(after.provenance.output.variant,'body');
 assert.equal(Evidence.documentSource(h.state,'saved','#aibro-source-draft-source').page,16);assert.equal(Evidence.documentSource(h.state,'saved',href(h.a)),null);
 assert.equal(Evidence.documentSource(h.state,'saved','#aibro-source-draft-source',{variant:'draft'}),null);
});

test('ordinary note editing preserves link bytes and durable identities without claiming verified conclusions',()=>{
 const h=fixture(),note=h.save(),session=Editor.begin(h.state,'saved');session.content+='\n\n我补充的解释。';
 const result=Editor.prepare(h.state,session,99);assert.deepEqual(result.after.provenance,note.provenance);assert.ok(result.after.content.includes(href(h.b)));
 h.state.notes=[clone(result.after)];assert.equal(Evidence.documentSource(h.state,'saved',href(h.b)).page,16);
});

test('local file mapping carries exact relative path and current folder grant, never a disconnected fallback',()=>{
 const h=fixture(),local=Evidence.capture(h.run,{type:'local',id:'reference',projectId:'project',candidateId:'folder',refKey:'reference',path:'chapter/second.md',excerpt:'local text'},h.state);
 h.message.text=`本机来源 ${marker(local)}`;h.save();const source=Evidence.documentSource(h.state,'saved',href(local));
 assert.equal(source.path,'chapter/second.md');assert.equal(source.candidateId,'folder');assert.equal(source.refKey,'reference');assert.equal(host(h.state).available(source),true);
 h.state.projects[0].localFolder.id='another-folder';assert.equal(Evidence.documentSource(h.state,'saved',href(local)),null);
});

test('safe supplied web citations become standard links, while ordinary page prose is never inferred',()=>{
 const h=fixture(),web=Evidence.capture(h.run,{type:'web',url:'https://example.org/paper',title:'External',excerpt:'source'},h.state);
 h.message.text=`外部 ${marker(web)}。第16页 [1]只是原文。`;const note=h.save();
 assert.ok(note.content.includes('](<https://example.org/paper>)'));assert.ok(note.content.endsWith('第16页 [1]只是原文。'));assert.ok(!note.content.includes('#aibro-source-'));
});
