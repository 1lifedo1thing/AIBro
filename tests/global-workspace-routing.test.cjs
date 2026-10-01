const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const cut=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function harness(flush=async()=>true){
 const state={projects:[{id:'p',workspace:'科研'}],conversations:[],currentProjectId:'p',ui:{spaceTabs:{daily:'tasks',courses:'content'}}};
 const calls=[],document={body:{dataset:{view:'project'}}};
 const context=vm.createContext({state,document,previewOpenIntent:0,beforePreviewSwitch:flush,toast:()=>{},
 workspaceName:x=>x==='课程'||x==='科研'?x:'日常',
 showView(view){context.showView.navigationVersion=(context.showView.navigationVersion||0)+1;document.body.dataset.view=view;calls.push(['view',view]);},
 newConversation(workspace,projectId){state.conversations.push({workspace,projectId});context.showView('agent');},
 window:{ReadingPane:{revealWorkspace:o=>calls.push(['park',o.force])}}});
 vm.runInContext(cut('function recordMatchesSpace(','\nfunction taskMatchesSpace'),context);
 vm.runInContext(cut('let workspaceRouteIntent =','\nlet pdfPreviewVersion ='),context);
 return {state,calls,context,view:context.navigateWorkspaceView,location:context.navigateWorkspaceLocation,newChat:context.navigateWorkspaceNewConversation};
}
function deferred(){let resolve;return{promise:new Promise(r=>resolve=r),resolve};}
test('space destinations preserve independent sections, migrate content and default to projects',async()=>{
 const h=harness();assert.equal(await h.view('daily'),true);assert.equal(h.state.ui.spaceTabs.daily,'tasks');
 await h.view('courses');assert.equal(h.state.ui.spaceTabs.courses,'knowledge');await h.view('research');assert.equal(h.state.ui.spaceTabs.research,'projects');
 await h.view('research',{section:'papers'});await h.view('daily',{section:'papers'});assert.equal(h.state.ui.spaceTabs.daily,'projects');assert.equal(h.state.ui.spaceTabs.research,'papers');
});
test('failed or superseded draft persistence never commits space destination or section',async()=>{
 const h=harness(async()=>false),before=JSON.stringify(h.state);assert.equal(await h.view('courses',{section:'tasks'}),false);assert.equal(JSON.stringify(h.state),before);assert.equal(h.calls.length,0);
 const wait=deferred(),s=harness(()=>wait.promise);const pending=s.view('research',{section:'papers'});s.context.showView('captures');wait.resolve(true);assert.equal(await pending,false);assert.equal(s.state.ui.spaceTabs.research,undefined);
});
test('last navigation intent wins across new chat and global view',async()=>{
 const waits=[deferred(),deferred()];let n=0;const h=harness(()=>waits[n++].promise);
 const chat=h.newChat('科研','p'),view=h.view('daily',{section:'knowledge'});waits[1].resolve(true);assert.equal(await view,true);waits[0].resolve(true);assert.equal(await chat,false);assert.equal(h.state.conversations.length,0);assert.equal(h.context.document.body.dataset.view,'daily');
});
test('new conversation has explicit global, space and current project scope',async()=>{
 const h=harness();await h.newChat();await h.newChat('courses');await h.newChat('日常','p');
 assert.deepEqual(h.state.conversations.map(x=>[x.workspace,x.projectId]),[['auto',null],['课程',null],['科研','p']]);
 assert.equal(await h.newChat('invalid'),false);assert.equal(await h.newChat('auto','missing'),false);
});
test('project revocation during new-chat guard cannot create or redirect a conversation',async()=>{
 for(const flag of [{archivedAt:1},{deleted:true},{private:true},{status:'deleted'}]){const wait=deferred(),h=harness(()=>wait.promise);const pending=h.newChat('auto','p');Object.assign(h.state.projects[0],flag);wait.resolve(true);assert.equal(await pending,false);assert.equal(h.state.conversations.length,0);}
});
test('native location calls host canonical route and renderer fallback uses guarded existing view',async()=>{
 const h=harness(),requests=[];h.context.window.workstationDesktop={navigateWorkspace:async route=>{requests.push(route);return true;}};
 assert.equal(await h.location('overview'),true);assert.equal(await h.location('research',{section:'tasks'}),true);
 assert.equal(JSON.stringify(requests),JSON.stringify([{view:'overview'},{view:'research',section:'tasks'}]));assert.equal(h.calls.length,0);
 delete h.context.window.workstationDesktop;assert.equal(await h.location('overview'),true);assert.equal(h.context.document.body.dataset.view,'dashboard');
});
test('unavailable parents and own records are filtered consistently while genuine orphans remain visible',()=>{
 const h=harness(),match=h.context.recordMatchesSpace;
 for(const flag of [{archived:true},{archivedAt:1},{deleted:true},{deletedAt:1},{status:'archived'},{private:true},{ephemeral:true},{incognito:true}]){
  assert.equal(match({workspace:'科研',...flag},'科研'),false);
  assert.equal(match({projectId:'p',workspace:'课程'},'科研',[{id:'p',workspace:'科研',...flag}]),false);
 }
 assert.equal(match({projectId:'missing',workspace:'课程'},'课程'),true);
 assert.equal(match({projectId:'p',workspace:'课程'},'科研'),true);
});
test('inactive space panels do not render collections, planning or research network',()=>{
 const h=harness(),calls=[];Object.assign(h.context,{$:()=>({}),setEntityBox:()=>{},entityProject:()=>'',renderSpaceOverview:()=>calls.push('overview'),renderResearchLibrary:()=>calls.push('papers'),renderWorkspaceWidgets:(_v,_s,tab)=>calls.push(tab),applySectionTabs:()=>{}});
 vm.runInContext(cut('function renderSpace(viewId)','\n// Shared CMS collection'),h.context);
 h.context.renderSpace('research');assert.deepEqual(calls,['projects']);calls.length=0;
 h.state.ui.spaceTabs.research='papers';h.context.renderSpace('research');assert.deepEqual(calls,['papers','papers']);
});
