const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../app/project-files.js');
const fs=require('node:fs'),vm=require('node:vm');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function linkHarness(options={}) {
 const state={projects:[{id:'p',localFolder:{id:'c'}}]},ref={projectId:'p',candidateId:'c',path:'chapter/first.md'};ref.id=P.localId(ref);
 const calls=[];let current=ref,configuration,navigation=0;
 const editor={mount:async(_host,value)=>{current=value;return true;},current:()=>current,revealFragment:async fragment=>{calls.push(['fragment',fragment]);return true;}};
 const context={FileContext:{request:async(url,payload)=>{calls.push(['read',url,payload]);if(options.read)return options.read.promise;return{text:'# Target'};}},LocalDocumentEditor:{create:hooks=>{configuration=hooks;return editor;}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../app/project-files.js'),'utf8'),context);const api=context.ProjectFiles;
 api.init({getState:()=>state,captureNavigation:()=>{const revision=navigation;return()=>revision===navigation;},open:async(...args)=>{calls.push(['open',...args]);if(options.open)return options.open(args);if(!args[4]())return false;current={...ref,id:args[1],path:JSON.parse(args[1])[2]};return true;}});api.mount({},ref);
 return {api,state,ref,calls,editor,configuration:()=>configuration,switch:()=>{current={...ref,id:'other'};},navigate:()=>{navigation++;},current:()=>current};
}
test('project file hierarchy unifies notes and originals by the entire durable folder path',()=>{
 const rows=P.libraryEntries([{id:'n',title:'Analysis',folderPath:'Research/Paper A'}],[{id:'p',name:'Paper.pdf',folderPath:'Research/Paper A'},{id:'q',name:'Other.pdf',folderPath:'Research/Paper B'}]);
 const tree=P.hierarchy(rows),research=tree.folders.get('Research');
 assert.equal(research.folders.get('Paper A').files.length,2);assert.deepEqual(new Set(research.folders.get('Paper A').files.map(x=>x.type)),new Set(['note','import']));assert.equal(research.folders.get('Paper B').files.length,1);
});
test('local preview identity rejects a disconnected or archived project and preserves unicode relative paths',()=>{
 const ref={projectId:'p',candidateId:'c',path:'研究/计划.md'},id=P.localId(ref);const state={projects:[{id:'p',localFolder:{id:'c'}}]};
 assert.equal(P.parseLocal(id,state).path,ref.path);state.projects[0].localFolder.id='different';assert.equal(P.parseLocal(id,state),null);state.projects[0].localFolder.id='c';state.projects[0].archived=true;assert.equal(P.parseLocal(id,state),null);assert.equal(P.parseLocal('broken',state),null);
});
test('Markdown toolbar edits only selected text or current lines, preserving adjacent source',()=>{
 assert.equal(P.formatMarkdown('before target after',7,13,'bold').text,'before **target** after');
 assert.equal(P.formatMarkdown('keep\none\ntwo\nafter',7,12,'list').text,'keep\n- one\n- two\nafter');
 assert.equal(P.formatMarkdown('one\nselected\nthree',4,12,'heading').text,'one\n## selected\nthree');
 assert.equal(P.formatMarkdown('prefix ',7,7,'link').text,'prefix [链接文字](https://)');
});

test('historical disconnected local identity permits recovery only via explicit opt in',()=>{
 const ref={projectId:'p',candidateId:'old',path:'研究/计划.md'},id=P.localId(ref),state={projects:[{id:'p',localFolder:{id:'new'}}]};
 assert.equal(P.parseLocal(id,state),null);
 const recovery=P.parseLocal(id,state,{allowDisconnected:true});assert.equal(recovery.candidateId,'old');assert.equal(recovery.disconnected,true);assert.equal(recovery.path,ref.path);
 delete state.projects[0].localFolder;assert.equal(P.parseLocal(id,state,{allowDisconnected:true}).disconnected,true);assert.equal(P.parseLocal(id,state),null);
 state.projects[0].archived=true;assert.equal(P.parseLocal(id,state,{allowDisconnected:true}),null);
});
test('recovery opt in never accepts malformed document identities or traversal paths',()=>{
 const state={projects:[{id:'p'}]};
 for(const values of [['p','old','../a.md'],['p','old','/a.md'],['p','old','a//b.md'],['p','old','a/./b.md'],['p','','a.md'],['p',null,'a.md'],['p','old','a.md','extra'],['missing','old','a.md']]) {
  assert.equal(P.parseLocal(JSON.stringify(values),state,{allowDisconnected:true}),null,JSON.stringify(values));
 }
 assert.equal(P.parseLocal(JSON.stringify({0:'p',1:'old',2:'a.md'}),state,{allowDisconnected:true}),null);
});
test('relative document targets resolve against the source directory and preserve one decoded fragment',()=>{
 const h=linkHarness();
 for(const [url,path,fragment] of [['second.md','chapter/second.md',null],['./second.md#结论','chapter/second.md','结论'],['../shared/总结%20一.md#%E7%BB%93%E8%AE%BA','shared/总结 一.md','结论'],['second.md#','chapter/second.md',''],['second.md#100%25','chapter/second.md','100%']]) {
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.resolveDocumentLink(h.ref,url,h.state))),{path,fragment},url);
 }
 for(const url of ['../../outside.md','/etc/passwd','//host/x','file:///tmp/a.md','javascript:alert(1)','data:text/html,x','C:/a.md','x\\a.md','a//b.md','second.md?download','%2fetc/passwd','a%2fb.md','%252e%252e/a.md','%zz.md','a%00.md','#结论','']) assert.equal(h.api.resolveDocumentLink(h.ref,url,h.state),null,url);
 assert.equal(h.api.resolveDocumentLink(null,'second.md',h.state),null,'No filesystem ownership means no name guessing');
 h.state.projects[0].localFolder.id='new';assert.equal(h.api.resolveDocumentLink(h.ref,'second.md',h.state),null);
});
test('local link preflight uses the existing authorized reader then opens through the guarded host',async()=>{
 const h=linkHarness(),anchor={},target=h.api.resolveDocumentLink(h.ref,'../second.md#结论');
 assert.equal(await h.api.openDocumentLink(h.ref,target,{anchor,isCurrent:()=>true}),true);
 assert.equal(h.calls[0][0],'read');assert.equal(h.calls[0][1],'/__local/read');assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0][2])),{candidateId:'c',path:'second.md',offset:0});
 const open=h.calls.find(c=>c[0]==='open');assert.deepEqual(open.slice(1,3),['local-file',P.localId({...h.ref,path:'second.md'})]);assert.equal(open[6].anchor,anchor);assert.equal(typeof open[5],'function');assert.equal(typeof open[6].isCurrent,'function');assert.deepEqual(h.calls.at(-1),['fragment','结论']);
});
test('same-document link uses existing content and anchor without reading or remounting',async()=>{
 const h=linkHarness();assert.equal(await h.api.openDocumentLink(h.ref,{path:h.ref.path,fragment:'章节'}),true);assert.deepEqual(h.calls,[['fragment','章节']]);
 assert.equal(await h.api.openDocumentLink(h.ref,{path:h.ref.path,fragment:null}),true);assert.equal(h.calls.length,1);
});
test('a failed file preflight retains source and never invokes document or draft navigation',async()=>{
 const read=defer(),h=linkHarness({read}),pending=h.api.openDocumentLink(h.ref,{path:'missing.md',fragment:null});read.reject(Error('文件不存在'));
 await assert.rejects(pending,/文件不存在/);assert.equal(h.current().id,h.ref.id);assert.equal(h.calls.some(c=>c[0]==='open'),false);
});
test('preflight cannot reclaim a newer document, navigation, binding or link intent',async()=>{
 for(const change of ['document','navigation','binding','archived','intent']) {
  const read=defer(),h=linkHarness({read});let current=true;const pending=h.api.openDocumentLink(h.ref,{path:'second.md',fragment:null},{isCurrent:()=>current});
  if(change==='document')h.switch();if(change==='navigation')h.navigate();if(change==='binding')h.state.projects[0].localFolder.id='new';if(change==='archived')h.state.projects[0].archived=true;if(change==='intent')current=false;
  read.resolve({text:'target'});assert.equal(await pending,false,change);assert.equal(h.calls.some(c=>c[0]==='open'),false,change);
 }
});
test('a refused draft gate does not reveal target fragments or change the source document',async()=>{
 const h=linkHarness({open:async args=>{assert.equal(args[4](),true);return false;}});
 assert.equal(await h.api.openDocumentLink(h.ref,{path:'second.md',fragment:'target'}),false);assert.equal(h.current().id,h.ref.id);assert.equal(h.calls.some(c=>c[0]==='fragment'),false);
});
test('tampered local button data never passes an invalid path into the filesystem reader',async()=>{
 const h=linkHarness();for(const path of ['../outside.md','/absolute.md','a/../b.md','%2e%2e/a.md','a\\b.md'])assert.equal(await h.api.openDocumentLink(h.ref,{path,fragment:null}),false,path);assert.equal(h.calls.length,0);
});
