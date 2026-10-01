const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const NoteEditor=require('../app/note-editor.js'),ResearchWiki=require('../app/research-wiki.js');
const context={NoteEditor,ResearchWiki};vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../app/research-wiki-ui.js'),'utf8'),context);
const excerpt=context.ResearchWikiUI.cardExcerpt;

test('Wiki card excerpt shares the editor frontmatter boundary and leaves the stored content untouched',()=>{
 const note={content:'---\ntitle: Private metadata title\nid: note-example\n---\n# Visible heading\n\n正文依据与观察。\n第二条原文。'};
 const before=JSON.stringify(note);assert.equal(excerpt(note.content),'正文依据与观察。\n第二条原文。');assert.equal(JSON.stringify(note),before);
});
test('BOM, CRLF and YAML closing dots are removed only at the beginning',()=>{
 const value='\uFEFF---\r\ntitle: Metadata\r\n...\r\n正文内容\r\n';assert.equal(excerpt(value).trim(),'正文内容');
 assert.equal(excerpt('正文在前\n---\ntitle: Visible example\n---'), '正文在前\n---\ntitle: Visible example');
});
test('ordinary Markdown rules and unclosed examples remain visible',()=>{
 assert.equal(excerpt('---\n普通段落\n---\n更多内容'),'---\n普通段落\n---');
 assert.equal(excerpt('---\ntitle: Unclosed\nActual prose'),'---\ntitle: Unclosed\nActual prose');
});
test('empty fields and headings do not displace meaningful excerpt lines',()=>{
 assert.equal(excerpt('# 标题\n\n> 描述\n未记录。\n第一行\n第二行\n第三行\n第四行'),'第一行\n第二行\n第三行');
 assert.equal(excerpt(undefined),'');
});
test('card view projects approved excerpts and counts without exposing private source or draft bodies',()=>{
 const note={id:'entry',title:'已批准条目',kind:'科研 Wiki/method',workspace:'科研',content:'已批准正文',projectId:'p',sourceAttachmentIds:['attachment'],sourceNoteIds:['hidden'],aiDraft:{content:'DRAFT_ONLY',sourceNoteIds:['draft-only']},updatedAt:1710000000000};
 const state={projects:[{id:'p',name:'项目名称',workspace:'科研'}],notes:[note,{id:'hidden',title:'HIDDEN_TITLE',content:'HIDDEN_BODY',archived:true}]};
 const before=JSON.stringify(state),view=context.ResearchWikiUI.cardView(note,state);
 assert.equal(view.excerpt,'已批准正文');assert.equal(view.pendingDraft,true);assert.equal(view.sourceCount,2);assert.equal(view.owner,'项目名称');assert.equal(view.date,new Date(note.updatedAt).toISOString());
 for(const secret of ['DRAFT_ONLY','HIDDEN_TITLE','HIDDEN_BODY','draft-only','attachment'])assert.ok(!JSON.stringify(view).includes(secret));
 assert.equal(JSON.stringify(state),before);
});
test('card time uses an available real timestamp and omits an invalid or missing date',()=>{
 const state={projects:[],notes:[]},note={id:'n',kind:'科研 Wiki/idea',content:'Question'};
 assert.equal(context.ResearchWikiUI.cardView(note,state).date,'');
 assert.equal(context.ResearchWikiUI.cardView({...note,updatedAt:'not a date'},state).date,'');
 assert.equal(context.ResearchWikiUI.cardView({...note,createdAt:'2026-09-29T00:00:00Z'},state).date,'2026-09-29T00:00:00.000Z');
});
