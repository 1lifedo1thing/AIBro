const test=require('node:test');const assert=require('node:assert/strict');const Capture=require('../app/note-capture');
const Evidence=require('../app/citation-evidence');

const msg=(id,text,extra={})=>({id,role:'agent',text,at:1,...extra});
const conv=(id,extra={})=>({id,title:'验收对话',messages:[],workspace:'科研',projectId:null,...extra});

test('标题只从原文取材：剥掉 Markdown 标记并在字符边界截断',()=>{
 assert.equal(Capture.titleFromMessage('# 验收清单\n\n正文'),'验收清单');
 assert.equal(Capture.titleFromMessage('- 第一项\n- 第二项'),'第一项');
 assert.equal(Capture.titleFromMessage('1. 有序项\n2. 第二项'),'有序项');
 assert.equal(Capture.titleFromMessage('> 引用里的结论'),'引用里的结论');
 assert.equal(Capture.titleFromMessage('**加粗**与 `代码` 混排'),'加粗与 代码 混排');
 assert.equal(Capture.titleFromMessage('[链接文字](https://example.com) 后续'),'链接文字 后续');
 assert.equal(Capture.titleFromMessage('### \n\n'),'','只有标记的行不算标题');
 assert.equal(Capture.titleFromMessage(''),'');
 assert.equal(Capture.titleFromMessage(null),'');
});

test('长标题按字符（不是字节）截断，中文不被切碎',()=>{
 const long='验'.repeat(80);
 const title=Capture.titleFromMessage(long);
 assert.equal(Array.from(title).length,61,'60 个字符 + 省略号');
 assert.ok(title.endsWith('…'));
 assert.equal(title,'验'.repeat(60)+'…');
});

test('plan 四态：create / exists / empty / missing，且 plan 本身不产生副作用',()=>{
 const state={conversations:[conv('c1',{messages:[msg('m1','# 标题\n正文内容')]})],notes:[]};
 const created=Capture.plan(state,'m1',{now:1000,id:'note_1'});
 assert.equal(created.kind,'create');
 assert.equal(created.note.id,'note_1');
 assert.equal(created.note.kind,'对话产出');
 assert.equal(created.note.title,'标题');
 assert.equal(created.note.content,'# 标题\n正文内容','正文必须是原文，逐字不改写');
 assert.equal(created.note.workspace,'科研');
 assert.equal(created.note.projectId,null);
 assert.equal(created.note.sourceConversationId,'c1');
 assert.equal(created.note.sourceMessageId,'m1');
 assert.equal(created.note.createdAt,1000);
 assert.equal(state.notes.length,0,'plan 不得写入任何内容');

 assert.equal(Capture.plan({...state,notes:[{id:'n1',sourceMessageId:'m1'}]},'m1',{}).kind,'exists','同一条消息已存过');
 assert.equal(Capture.plan({...state,notes:[{id:'n1',sourceMessageId:'m1',deletedAt:1}]},'m1',{}).kind,'create','已删除的不算重复');
 assert.equal(Capture.plan({...state,notes:[{id:'n1',sourceMessageId:'m1',archived:true}]},'m1',{}).kind,'create','已归档的不算重复');
 assert.equal(Capture.plan({conversations:[conv('c',{messages:[msg('m2','   ')]})]},'m2',{}).kind,'empty');
 assert.equal(Capture.plan(state,'不存在',{}).kind,'missing');
});

test('无标题可用时如实标注来源对话，不编造名称',()=>{
 // 全部行都是空行或纯标记：正文非空（能存），但标题无法从原文取材
 const state={conversations:[conv('c9',{title:'深夜梳理',messages:[msg('m9','### \n\n   ')]})]};
 const result=Capture.plan(state,'m9',{now:2,id:'note_9'});
 assert.equal(result.kind,'create');
 assert.equal(result.note.title,'来自对话：深夜梳理');
 assert.equal(result.note.content,'### \n\n   ','原文照存，不因标题缺失而改动内容');
});

test('空间与项目沿用对话本身，未知空间落到日常而不是留空',()=>{
 const auto=Capture.plan({conversations:[conv('c2',{workspace:'auto',messages:[msg('m3','内容')]})]},'m3',{id:'n'});
 assert.equal(auto.note.workspace,'日常');
 const course=Capture.plan({conversations:[conv('c3',{workspace:'课程',projectId:'p1',messages:[msg('m4','内容')]})]},'m4',{id:'n'});
 assert.equal(course.note.workspace,'课程');
 assert.equal(course.note.projectId,'p1');
});

test('查找按消息 id 跨对话进行，找不到时如实返回 missing',()=>{
 const state={conversations:[conv('c1'),conv('c2',{messages:[msg('m5','命中')]})]};
 assert.equal(Capture.findMessage(state,'m5').conversation.id,'c2');
 assert.equal(Capture.findMessage(state,'nope'),null);
 assert.equal(Capture.existingNote({notes:[{id:'x',sourceMessageId:'m6'}]},'m6').id,'x');
 assert.equal(Capture.existingNote({notes:[]},'m6'),null);
});

function evidenceFixture(){
 const run={id:'run',conversationId:'chat'},message=msg('answer','',{runId:'run'});
 const state={notes:[{id:'source-note',title:'参考笔记',content:'笔记证据'}],projects:[],tasks:[],papers:[],imports:[{id:'pdf',name:'原件.pdf',content:'原件正文'},{id:'unused',name:'未引用.pdf',content:'只检索过'}],agentRuns:[run],conversations:[conv('chat',{messages:[message]})]};
 const first=Evidence.capture(run,{type:'import',id:'pdf',title:'原件.pdf',page:2,excerpt:'第二页证据'},state);
 const second=Evidence.capture(run,{type:'import',id:'pdf',title:'原件.pdf',page:5,excerpt:'第五页证据'},state);
 const unused=Evidence.capture(run,{type:'import',id:'unused',title:'未引用.pdf',page:1,excerpt:'只检索过'},state);
 const note=Evidence.capture(run,{type:'note',id:'source-note',title:'参考笔记',excerpt:'笔记证据'},state);
 const cite=source=>`[[cite:${source.sourceId}]]`;
 return {state,run,message,first,second,unused,note,cite};
}

test('only explicitly cited available records become durable source relations; pages remain available to callers',()=>{
 const h=evidenceFixture();h.message.text=`结论${h.cite(h.first)}\n另一处${h.cite(h.second)}\n笔记${h.cite(h.note)}\n重复${h.cite(h.first)}`;
 const before=JSON.stringify(h.state),sources=Capture.citedSources(h.state,'answer',Evidence),created=Capture.plan(h.state,'answer',{id:'output',citationEvidence:Evidence});
 assert.deepEqual(sources.map(source=>[source.type,source.id,source.page]),[['import','pdf',2],['import','pdf',5],['note','source-note',null]]);
 assert.deepEqual(created.note.sourceAttachmentIds,['pdf']);assert.deepEqual(created.note.sourceNoteIds,['source-note']);
 assert.equal(created.note.content,Evidence.documentText(h.message,h.run,h.state));assert.ok(created.note.provenance.inputs.some(input=>input.sourceId===h.first.sourceId&&input.page===2));assert.equal(JSON.stringify(h.state),before);
});

test('code examples, unclosed fences and unknown citation IDs do not establish source relationships',()=>{
 const h=evidenceFixture(),a=h.cite(h.first),n=h.cite(h.note),unused=h.cite(h.unused);
 h.message.text=`Inline \`${a}\` and \`\`${n}\`\`.\n\`\`\`md\n${a}\n\`\`\`\n~~~text\n${n}\n~~~\nUnknown [[cite:invented]].\n\`\`\`\n${unused}`;
 assert.deepEqual(Capture.citedSources(h.state,'answer',Evidence),[]);
 assert.deepEqual(Capture.plan(h.state,'answer',{id:'output',citationEvidence:Evidence}).note.sourceAttachmentIds,[]);
 h.message.text=`\`${unused}\` prose ${a}\n\`\`\`\n${n}\n\`\`\``;
 assert.deepEqual(Capture.citedSources(h.state,'answer',Evidence).map(source=>source.id),['pdf']);
});

test('private, missing, ambiguous and unavailable sources are checked when the message is saved',()=>{
 const cases=[
  h=>{h.state.imports[0].private=true;},
  h=>{h.run.private=true;},
  h=>{h.state.conversations[0].ephemeral=true;},
  h=>{h.state.imports[0].projectId='private-project';h.state.projects.push({id:'private-project',private:true});},
  h=>{h.state.imports[0].deletedAt=1;},
  h=>{h.state.imports[0].archivedAt=1;},
  h=>{h.state.imports[0].projectId='missing-project';},
  h=>{h.state.imports=h.state.imports.filter(item=>item.id!=='pdf');},
  h=>{h.state.imports.push({...h.state.imports[0]});}
 ];
 for(const change of cases){const h=evidenceFixture();h.message.text=h.cite(h.first);change(h);assert.deepEqual(Capture.citedSources(h.state,'answer',Evidence),[]);}
});

test('delivered but uncited attachments, legacy retrieval, code-free text and absent evidence APIs do not invent support',()=>{
 const h=evidenceFixture();h.run.attachmentIds=['pdf'];h.message.retrievedSources=[{type:'import',id:'unused',page:1}];h.message.text='普通回答 [1]';
 assert.deepEqual(Capture.citedSources(h.state,'answer',Evidence),[]);
 h.message.text=h.cite(h.first);assert.deepEqual(Capture.citedSources(h.state,'answer',undefined),[]);
 h.message.role='user';assert.deepEqual(Capture.citedSources(h.state,'answer',Evidence),[]);
 h.message.role='agent';h.run.id='unrelated-run';assert.deepEqual(Capture.citedSources(h.state,'answer',Evidence),[]);
});

test('existing captured notes keep their human-edited body and relations when the original answer later changes',()=>{
 const h=evidenceFixture();h.message.text=h.cite(h.first);
 const note={id:'existing',sourceMessageId:'answer',sourceAttachmentIds:['manual-source'],content:'用户修改后的正文'};h.state.notes.push(note);
 const before=JSON.stringify(note),result=Capture.plan(h.state,'answer',{id:'unused-id',citationEvidence:Evidence});
 assert.equal(result.kind,'exists');assert.equal(result.note,note);assert.equal(JSON.stringify(note),before);
});
