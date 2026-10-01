'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Evidence=require('../app/citation-evidence.js');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`Missing production section ${start}`);return source.slice(a,b);}
const kinds=[['notes','note'],['imports','import'],['tasks','task'],['papers','paper']];
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){return {projects:[{id:'p',name:'Needle public project',workspace:'日常'}],notes:[],imports:[],tasks:[],papers:[],conversations:[],agentRuns:[],trash:[],ui:{}};}
function add(state,type,id,extra={}){const collection=kinds.find(([,kind])=>kind===type)[0],record={id,title:`Needle ${id}`,name:`Needle ${id}`,content:`Needle BODY_${id}`,description:`Needle DESC_${id}`,projectId:'p',workspace:'日常',status:'todo',...extra};state[collection].push(record);return record;}
function harness(state,{evidence=Evidence}={}){
 const context=vm.createContext({state,window:{CitationEvidence:evidence},CitationEvidence:evidence,normalize:value=>String(value??'').trim().toLowerCase().replace(/[\s·_-]+/g,''),workspaceName:value=>value||'日常',statusLabel:value=>value||'待开始',projectForTask:item=>state.projects.find(project=>project.id===item.projectId)||null,PrivateMode:{searchable:conversation=>!conversation.private&&!conversation.ephemeral&&!conversation.incognito}});
 vm.runInContext(section('const projectIsActive =','\nconst visibleRun ='),context);
 vm.runInContext(section('function searchEntities(','\nfunction renderSearchResults('),context);
 return {search:(query='Needle')=>plain(context.searchEntities(query))};
}
const docs=rows=>rows.filter(row=>['note','import','task','paper'].includes(row.type)).map(row=>`${row.type}:${row.id}`).sort();
test('actual global search keeps public approved record bodies searchable, including project records, without mutation',()=>{
 const state=fixture();for(const[,type]of kinds)add(state,type,type+'-public');add(state,'note','daily',{projectMemoryType:'daily',content:'A unique diary body token: PUBLIC_DIARY_BODY'});const before=JSON.stringify(state),h=harness(state);assert.deepEqual(docs(h.search()),['import:import-public','note:daily','note:note-public','paper:paper-public','task:task-public']);assert.deepEqual(h.search('PUBLIC_DIARY_BODY').map(row=>row.id),['daily']);assert.equal(JSON.stringify(state),before);
});
test('note/import/task/paper direct private, ephemeral and incognito entries never expose title, metadata or body',()=>{
 for(const flag of ['private','ephemeral','incognito']){const state=fixture();for(const[,type]of kinds){add(state,type,type+'-safe');add(state,type,'SECRET_'+type,{[flag]:true});}const rows=harness(state).search();assert.deepEqual(docs(rows),kinds.map(([,type])=>type+':'+type+'-safe').sort(),flag);assert.doesNotMatch(JSON.stringify(rows),/SECRET_/);}
});
test('privacy follows live and retired origin conversations/runs instead of trusting a public-looking output',()=>{
 for(const ancestry of ['conversation','run','retired-run','retired-conversation','captured-origin']){
  const state=fixture();if(ancestry==='conversation')state.conversations.push({id:'secret',ephemeral:true});if(ancestry==='run')state.agentRuns.push({id:'secret',private:true});if(ancestry==='retired-run')state.trash.push({data:{runs:[{id:'secret',private:true}]}});if(ancestry==='retired-conversation')state.trash.push({data:{conversations:[{id:'secret',incognito:true}]}});
  const extra=ancestry==='captured-origin'?{provenance:{origin:{private:true}}}:ancestry.includes('conversation')?{sourceConversationId:'secret'}:{provenance:{origin:{runId:'secret'}}};for(const[,type]of kinds){add(state,type,type+'-safe');add(state,type,'SECRET_'+type,extra);}const rows=harness(state).search();assert.deepEqual(docs(rows),kinds.map(([,type])=>type+':'+type+'-safe').sort(),ancestry);assert.doesNotMatch(JSON.stringify(rows),/SECRET_/);
 }
});
test('private or duplicate projects and their records do not enter global results or location metadata',()=>{
 for(const mode of ['private','duplicate','retired-private']){const state=fixture();const privateProject={id:'secret-project',name:'Needle SECRET_PROJECT',workspace:'日常'};state.projects.push(privateProject);if(mode==='private')privateProject.private=true;if(mode==='duplicate')state.projects.push({...privateProject});if(mode==='retired-private')state.trash.push({data:{projects:[{...privateProject,private:true}]}});for(const[,type]of kinds){add(state,type,type+'-safe');add(state,type,'SECRET_'+type,{projectId:'secret-project'});}const rows=harness(state).search();assert.deepEqual(docs(rows),kinds.map(([,type])=>type+':'+type+'-safe').sort(),mode);assert.doesNotMatch(JSON.stringify(rows),/SECRET_/);assert.equal(rows.some(row=>row.type==='project'&&row.id==='secret-project'),false);}
});
test('ambiguous typed record ids are rejected but a same-id record of another type remains independently searchable',()=>{
 const state=fixture();for(const[,type]of kinds){add(state,type,'duplicate-'+type);add(state,type,'duplicate-'+type);}add(state,'note','shared',{title:'Needle PUBLIC_SHARED_NOTE'});add(state,'import','shared',{private:true,name:'Needle SECRET_SHARED_IMPORT'});const rows=harness(state).search();assert.deepEqual(docs(rows),['note:shared']);assert.doesNotMatch(JSON.stringify(rows),/SECRET_SHARED_IMPORT|duplicate-/);
});
test('deleted, archived and unavailable records are not searchable even while retained in the arrays',()=>{
 const state=fixture();for(const[,type]of kinds)for(const [index,extra]of [{deleted:true},{deletedAt:5},{archived:true},{archivedAt:5},{status:'deleted'},{status:'archived'},{wikiFileError:'missing'}].entries())add(state,type,`${type}-gone-${index}`,extra);assert.deepEqual(docs(harness(state).search()),[]);
});
test('project task metadata counts only public unambiguous active tasks',()=>{
 const state=fixture();add(state,'task','public');add(state,'task','secret',{private:true});add(state,'task','duplicate');add(state,'task','duplicate');add(state,'task','gone',{deletedAt:5});const project=harness(state).search().find(row=>row.type==='project');assert.match(project.meta,/1 个任务/);assert.doesNotMatch(project.meta,/5 个任务/);
});
test('missing privacy dependency fails closed for workspace documents and project results',()=>{
 const state=fixture();for(const[,type]of kinds)add(state,type,type+'-public');assert.deepEqual(harness(state,{evidence:null}).search(),[]);
});
