const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../app/citation-evidence');
const state=()=>({notes:[{id:'n',title:'笔记',content:'body'}],imports:[{id:'i',title:'附件'}],tasks:[{id:'t',title:'任务'}],projects:[],conversations:[]});
test('mobile sources remain navigable identities on desktop without inventing immutable excerpts',()=>{
 const sources=E.sourcesFor({retrievedSources:[{kind:'notes',id:'n',citation:2,offset:10,end:20},{kind:'imports',id:'i'},{kind:'tasks',id:'t'}]},null,state());
 assert.deepEqual(sources.map(s=>[s.type,s.id]),[['note','n'],['import','i'],['task','t']]);
 assert.equal(sources[0].offset,10);assert.equal(sources[0].end,20);
 for(const source of sources){assert.equal(source.provided,false);assert.equal(source.excerpt,null);assert.equal(E.status(source,state()).canOpen,true);}
});
test('mobile aliases retain existing privacy checks and reject contradictory types',()=>{
 const s=state();s.notes[0].projectId='private';s.projects=[{id:'private',private:true}];
 const rows=E.sourcesFor({retrievedSources:[{kind:'notes',id:'n',title:'private title'},{type:'task',kind:'notes',id:'n'},null]},null,s);
 assert.equal(rows.length,1);assert.equal(rows[0].private,true);assert.equal(rows[0].title,'私密来源');
 assert.equal(E.status(rows[0],s).canOpen,false);
});
