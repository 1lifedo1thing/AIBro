const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Navigation=require('../app/workspace-navigation.js');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const code=source.slice(source.indexOf('let workspaceRouteIntent ='),source.indexOf('\nlet pdfPreviewVersion ='));
function deferred(){let resolve;return{promise:new Promise(r=>resolve=r),resolve};}
function harness(flush=async()=>true){
 const state={projects:[{id:'a',workspace:'科研',name:'A'},{id:'b',workspace:'课程',name:'B'}],conversations:[{id:'chat-a',projectId:'a'},{id:'chat-b',projectId:'b'}],currentProjectId:'a',currentConversationId:'chat-a',ui:{projectTab:'knowledge',workspaceNavigation:{projects:{a:{section:'knowledge'},b:{section:'tasks'}}}}};
 const calls=[],document={body:{dataset:{view:'project'}}};
 function showView(view,label){showView.navigationVersion=(showView.navigationVersion||0)+1;document.body.dataset.view=view;calls.push(['view',view,label]);state.ui.workspaceNavigation.projects[state.currentProjectId]={section:state.ui.projectTab};}
 const context=vm.createContext({state,document,showView,previewOpenIntent:0,visibleProject:p=>!p.archived,workspaceName:x=>x,toast:x=>calls.push(['toast',x]),beforePreviewSwitch:flush,openConversation:id=>{state.currentConversationId=id;showView('agent');},window:{WorkspaceNavigation:{resolveProjectSection:Navigation.resolveProjectSection,beforeRoute:()=>calls.push(['capture'])},ReadingPane:{revealWorkspace:o=>calls.push(['park',o.force])}}});
 vm.runInContext(code,context);return{state,calls,context,open:context.openProject,chat:context.navigateWorkspaceConversation,showView};
}
test('project entries restore per-project section and explicit list entry overrides only destination',async()=>{
 const h=harness();assert.equal(await h.open('b'),true);assert.equal(h.state.ui.projectTab,'tasks');assert.equal(await h.open('a'),true);assert.equal(h.state.ui.projectTab,'knowledge');assert.equal(await h.open('a',{section:'conversations'}),true);assert.equal(h.state.ui.projectTab,'conversations');assert.equal(h.state.ui.workspaceNavigation.projects.b.section,'tasks');assert.equal(h.calls.filter(x=>x[0]==='park').length,3);
});
test('draft flush failure changes no project, section, conversation or document surface',async()=>{
 const h=harness(async()=>false),before=JSON.stringify(h.state);assert.equal(await h.open('b',{section:'outputs'}),false);assert.equal(JSON.stringify(h.state),before);assert.equal(h.calls.length,0);
});
test('late project flush cannot overtake another project request',async()=>{
 const waits=[deferred(),deferred()];let i=0;const h=harness(()=>waits[i++].promise);const first=h.open('b'),second=h.open('a',{section:'outputs'});waits[1].resolve(true);assert.equal(await second,true);waits[0].resolve(true);assert.equal(await first,false);assert.equal(h.state.currentProjectId,'a');assert.equal(h.state.ui.projectTab,'outputs');
});
test('native cancellation, different global route and new reader intent each invalidate pending project',async()=>{
 for(const reason of ['native','route','reader']){const wait=deferred(),h=harness(()=>wait.promise);let allowed=true;const pending=h.open('b',{isCurrent:()=>allowed});if(reason==='native')allowed=false;if(reason==='route')h.showView('daily');if(reason==='reader')h.context.previewOpenIntent++;wait.resolve(true);assert.equal(await pending,false,reason);assert.equal(h.state.currentProjectId,'a',reason);}
});
test('project deletion or privacy changes during flush revoke the destination',async()=>{
 for(const flag of ['archived','archivedAt','deleted','deletedAt','private','ephemeral','incognito']){const wait=deferred(),h=harness(()=>wait.promise);const pending=h.open('b');h.state.projects[1][flag]=true;wait.resolve(true);assert.equal(await pending,false);assert.equal(h.state.currentProjectId,'a');}
});
test('explicit resumed thread is guarded and never creates or reassigns conversations',async()=>{
 const h=harness(),before=h.state.conversations.map(x=>({...x}));assert.equal(await h.chat('chat-b'),true);assert.equal(h.state.currentConversationId,'chat-b');assert.deepEqual(h.state.conversations,before);assert.equal(await h.chat('missing'),false);
});

test('project status and duplicate identities cannot bypass real production availability', async()=>{
 for(const status of ['archived','deleted']){const h=harness();h.state.projects[1].status=status;assert.equal(await h.open('b'),false);}
 const h=harness();h.state.projects.push({...h.state.projects[1]});assert.equal(await h.open('b'),false);
});
