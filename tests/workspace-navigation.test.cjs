const test=require('node:test'),assert=require('node:assert/strict');
const Nav=require('../app/workspace-navigation.js');
const state=()=>({ui:{projectTab:'knowledge',workspaceNavigation:{projects:{p:{conversationId:'a'}}}},currentProjectId:'q',currentConversationId:'a',projects:[{id:'p',name:'Project P',workspace:'日常'},{id:'q',name:'Project Q',workspace:'科研'},{id:'old',archived:true}],conversations:[{id:'a',projectId:'p',title:'Original',updatedAt:1},{id:'b',projectId:'p',title:'Newer',updatedAt:100},{id:'c',projectId:'q'},{id:'free',projectId:null},{id:'gone',projectId:'old'}]});
test('conversation scope never inherits stale currentProjectId from a different project',()=>{const s=state();assert.equal(Nav.projectFor(s,'agent').id,'p');assert.equal(Nav.projectFor(s,'project').id,'q');s.currentConversationId='free';assert.equal(Nav.projectFor(s,'agent'),null);s.currentConversationId='gone';assert.equal(Nav.projectFor(s,'agent'),null)});
test('resume returns the exact project conversation even when another conversation has a newer timestamp',()=>{const s=state();s.currentConversationId='c';assert.equal(Nav.conversationFor(s,'p').id,'a');s.conversations[0].archived=true;assert.equal(Nav.conversationFor(s,'p').id,'b');s.conversations[1].deletedAt=1;assert.equal(Nav.conversationFor(s,'p'),null)});
test('a moved remembered conversation is never resumed in its former project',()=>{const s=state();s.conversations[0].projectId='q';assert.equal(Nav.conversationFor(s,'p').id,'b');s.ui.workspaceNavigation.projects.p.conversationId='missing';assert.equal(Nav.conversationFor(s,'p').id,'b')});
test('project resume respects private mode even for remembered or current ordinary chats',()=>{const s=state();const visible=c=>!!c.ephemeral;assert.equal(Nav.conversationFor(s,'p',visible),null);s.conversations.push({id:'private',projectId:'p',ephemeral:true,updatedAt:0});assert.equal(Nav.conversationFor(s,'p',visible).id,'private');s.ui.workspaceNavigation.projects.p.conversationId='private';assert.equal(Nav.conversationFor(s,'p',c=>!c.ephemeral).id,'a');});
test('route identity distinguishes project sections and exact chats',()=>{const s=state();assert.equal(Nav.routeFor(s,'agent').key,'chat:a');assert.equal(Nav.routeFor(s,'project').key,'project:q:knowledge');s.ui.projectTab='tasks';assert.equal(Nav.routeFor(s,'project').key,'project:q:tasks');assert.equal(Nav.routeFor(s,'settings').key,'settings')});
test('space labels prefer the real project and never expose auto as interface text',()=>{assert.deepEqual(Nav.spaceFor({workspace:'科研'},{workspace:'auto'}),{value:'科研',view:'research',label:'科研'});assert.equal(Nav.spaceFor(null,{workspace:'auto'}).label,'自动归属');assert.equal(Nav.spaceFor({workspace:'auto'},null).label,'自动归属');assert.equal(Nav.spaceFor({workspace:'courses'},{workspace:'auto'}).label,'课程');assert.equal(Nav.spaceFor(null,{workspace:'auto'},true).label,'Automatic assignment');});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
function harness({value=state(),view='project',navigateProject,navigateConversation,legacy=false,visibleConversation}={}) {
  const elements={project:{scrollTop:0},agentInput:{value:'unsent draft',selectionStart:2,selectionEnd:4,selectionDirection:'forward',scrollTop:3,setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}},messageList:{dataset:{conversationId:value.currentConversationId},scrollTop:60}};
  const document={body:{dataset:{view}},querySelector:()=>null,getElementById:id=>elements[id]||null};
  const saved=[],calls=[],frames=[];let controller;
  const commitProject=(id,{section,isCurrent=()=>true}={})=>{if(!isCurrent())return false;value.currentProjectId=id;if(section)value.ui.projectTab=section;document.body.dataset.view='project';controller.beforeRoute();controller.afterRoute();return true;};
  const commitConversation=(id,{isCurrent=()=>true}={})=>{if(!isCurrent())return false;value.currentConversationId=id;elements.messageList.dataset.conversationId=id;document.body.dataset.view='agent';controller.beforeRoute();controller.afterRoute();return true;};
  const hooks={getState:()=>value,save:()=>saved.push(JSON.parse(JSON.stringify(value.ui.workspaceNavigation))),visibleConversation,
    openProject:(id,options)=>{calls.push(['project',id,options.section]);return navigateProject?navigateProject(id,options,commitProject):commitProject(id,options);},
    openConversation:(id,options)=>{calls.push(['chat',id]);return navigateConversation?navigateConversation(id,options,commitConversation):commitConversation(id,options);},
    newConversation:()=>{throw Error('A section tab must never create a chat');},applySectionTabs:()=>calls.push(['apply']),onError:error=>calls.push(['error',error.message])};
  if(!legacy){hooks.navigateProject=hooks.openProject;hooks.navigateConversation=hooks.openConversation;}
  controller=Nav.createController(hooks,{document,requestAnimationFrame:fn=>frames.push(fn)});controller.afterRoute();
  return {controller,value,document,elements,saved,calls,frames};
}

test('each project resolves its own remembered section and never inherits another project global tab',()=>{
  const s=state();s.ui.projectTab='schedule';s.ui.workspaceNavigation.projects={p:{section:'outputs'},q:{section:'knowledge'}};
  assert.equal(Nav.resolveProjectSection(s,'p'),'outputs');assert.equal(Nav.resolveProjectSection(s,'q'),'knowledge');
  assert.equal(Nav.resolveProjectSection(s,'p',{section:'tasks'}),'tasks');assert.equal(Nav.resolveProjectSection(s,'p',{resume:false}),'conversations');
  assert.equal(Nav.resolveProjectSection(s,'p',{section:'bad'}),'outputs');assert.equal(Nav.resolveProjectSection(s,'old'),null);assert.equal(Nav.resolveProjectSection(s,'missing'),null);
  s.ui.workspaceNavigation.projects.p.section='conversation';assert.equal(Nav.resolveProjectSection(s,'p'),'conversations');
  assert.equal(s.ui.projectTab,'schedule','pure resolution does not mutate the live route');
});
test('primary conversations tab opens the list and explicit resume returns the exact prior thread',()=>{
  const h=harness({view:'agent'});assert.equal(h.controller.route.section,'conversations');
  assert.equal(h.controller.go('knowledge','p'),true);assert.equal(h.controller.go('conversations','p'),true);
  assert.equal(h.document.body.dataset.view,'project');assert.equal(h.value.ui.projectTab,'conversations');assert.equal(h.value.currentConversationId,'a');
  assert.equal(h.calls.filter(call=>call[0]==='chat').length,0);
  assert.equal(h.controller.resumeProject('p'),true);assert.equal(h.document.body.dataset.view,'agent');assert.equal(h.value.currentConversationId,'a');
  assert.equal(h.value.ui.workspaceNavigation.projects.p.section,'conversations');assert.equal(h.value.ui.workspaceNavigation.projects.p.conversationId,'a');
});
test('empty project conversations list stays empty and resume never creates a blank chat',()=>{
  const h=harness();h.value.projects.push({id:'empty'});
  assert.equal(h.controller.enterProject('empty'),true);assert.equal(h.value.ui.projectTab,'conversations');
  const count=h.value.conversations.length;assert.equal(h.controller.resumeProject('empty'),false);assert.equal(h.value.conversations.length,count);
});
test('project A/B entry restores each last accepted section and agent entry records conversations',()=>{
  const h=harness();assert.equal(h.controller.go('outputs','p'),true);assert.equal(h.controller.go('tasks','q'),true);
  assert.equal(h.controller.enterProject('p'),true);assert.equal(h.value.ui.projectTab,'outputs');
  assert.equal(h.controller.enterProject('q'),true);assert.equal(h.value.ui.projectTab,'tasks');
  assert.equal(h.controller.resumeProject('p'),true);assert.equal(h.controller.go('schedule','q'),true);
  assert.equal(h.controller.projectHome('p'),true);assert.equal(h.document.body.dataset.view,'project');assert.equal(h.value.ui.projectTab,'conversations');
});
test('delayed navigation leaves source memory intact until its guarded commit resolves',async()=>{
  const gate=deferred();const h=harness({navigateProject:async(id,options,commit)=>{await gate.promise;return commit(id,options);}});
  const before=JSON.stringify(h.value.ui.workspaceNavigation);const pending=h.controller.go('outputs','p');
  h.controller.afterRoute();assert.equal(JSON.stringify(h.value.ui.workspaceNavigation),before);assert.equal(h.value.ui.projectTab,'knowledge');assert.equal(h.saved.length,0);
  gate.resolve();assert.equal(await pending,true);assert.equal(h.value.ui.workspaceNavigation.projects.p.section,'outputs');assert.equal(h.saved.length,1);
});
test('rejected protected navigation neither records destination nor changes project selection',async()=>{
  const gate=deferred();const h=harness({navigateProject:()=>gate.promise});const previous=JSON.stringify(h.value.ui.workspaceNavigation);
  const pending=h.controller.go('outputs','p');gate.resolve(false);assert.equal(await pending,false);
  assert.equal(h.value.currentProjectId,'q');assert.equal(h.value.ui.projectTab,'knowledge');assert.equal(JSON.stringify(h.value.ui.workspaceNavigation),previous);assert.equal(h.saved.length,0);
  h.controller.afterRoute();assert.equal(h.controller.route.key,'project:q:knowledge');
});
test('a stale guarded project transition cannot overwrite a newer accepted destination',async()=>{
  const gate=deferred();const h=harness({navigateProject:async(id,options,commit)=>{if(id==='p')await gate.promise;return commit(id,options);}});
  const stale=h.controller.go('outputs','p');assert.equal(await h.controller.go('tasks','q'),true);gate.resolve();assert.equal(await stale,false);
  assert.equal(h.value.currentProjectId,'q');assert.equal(h.value.ui.projectTab,'tasks');assert.equal(h.value.ui.workspaceNavigation.projects.p.section,undefined);
  assert.equal(h.value.ui.workspaceNavigation.projects.q.section,'tasks');assert.equal(h.saved.length,1);
});
test('a removed project while draft flush is pending is not opened or remembered',async()=>{
  const gate=deferred();const h=harness({navigateProject:async(id,options,commit)=>{await gate.promise;return commit(id,options);}});
  const pending=h.controller.go('outputs','p');h.value.projects.find(p=>p.id==='p').deletedAt=1;gate.resolve();assert.equal(await pending,false);assert.equal(h.value.currentProjectId,'q');
});
test('a chat that becomes unavailable or hidden while awaiting a guard is never resumed',async()=>{
  for(const mutation of [chat=>{chat.deleted=true;},chat=>{chat.ephemeral=true;}]){
    const gate=deferred();const h=harness({navigateConversation:async(id,options,commit)=>{await gate.promise;return commit(id,options);}});
    const pending=h.controller.resumeProject('p');mutation(h.value.conversations.find(c=>c.id==='a'));gate.resolve();assert.equal(await pending,false);assert.equal(h.document.body.dataset.view,'project');
  }
});
test('failed navigation unlocks capture for a later accepted route without an unhandled rejection',async()=>{
  let failing=true;const h=harness({navigateProject:async(id,options,commit)=>{if(failing)throw Error('draft store unavailable');return commit(id,options);}});
  assert.equal(await h.controller.go('outputs','p'),false);failing=false;assert.equal(await h.controller.go('tasks','q'),true);assert.deepEqual(h.calls.find(c=>c[0]==='error'),['error','draft store unavailable']);
});
test('legacy hosts only receive the new section after successful asynchronous project entry',async()=>{
  const gate=deferred();const h=harness({legacy:true,navigateProject:async(id,options,commit)=>{await gate.promise;return commit(id,{...options,section:undefined});}});
  const pending=h.controller.go('outputs','p');assert.equal(h.value.ui.projectTab,'knowledge');gate.resolve();assert.equal(await pending,true);assert.equal(h.value.ui.projectTab,'outputs');
  assert.deepEqual(h.calls.at(-1),['apply']);
});
test('default route resolution never exposes a private or deleted chat or archived project',()=>{
  const s=state();s.conversations.push({id:'secret',projectId:'q',ephemeral:true,updatedAt:999});s.currentConversationId='secret';
  assert.equal(Nav.routeFor(s,'agent').conversation,null);assert.equal(Nav.projectFor(s,'agent'),null);assert.equal(Nav.conversationFor(s,'q').id,'c');
  s.currentConversationId='a';s.conversations[0].deleted=true;assert.equal(Nav.routeFor(s,'agent').conversation,null);assert.equal(Nav.projectFor(s,'agent'),null);assert.equal(Nav.conversationFor(s,'old'),null);
});
test('private navigation does not write ephemeral conversation identity over ordinary project memory',()=>{
  const value=state();value.conversations.push({id:'secret',projectId:'p',ephemeral:true,updatedAt:999});value.currentConversationId='secret';
  value.ui.workspaceNavigation.projects.p={section:'outputs',conversationId:'a'};
  const h=harness({value,view:'agent',visibleConversation:conversation=>!!conversation.ephemeral});
  assert.equal(h.controller.route.conversation.id,'secret');assert.deepEqual(value.ui.workspaceNavigation.projects.p,{section:'outputs',conversationId:'a'});
  h.controller.beforeRoute();assert.deepEqual(value.ui.workspaceNavigation.projects.p,{section:'outputs',conversationId:'a'});
});
test('resume uses ISO timestamps when no current or remembered project thread exists',()=>{
  const s=state();s.currentConversationId='c';delete s.ui.workspaceNavigation.projects.p.conversationId;
  s.conversations[0].updatedAt='2026-09-30T08:00:00Z';s.conversations[1].updatedAt='2026-09-29T08:00:00Z';assert.equal(Nav.conversationFor(s,'p').id,'a');
});

test('a rejected pending transition refreshes the external global route that committed meanwhile',async()=>{
  const gate=deferred();const h=harness({navigateProject:()=>gate.promise});
  const previous=JSON.parse(JSON.stringify(h.value.ui.workspaceNavigation));const pending=h.controller.go('outputs','p');
  h.document.body.dataset.view='daily';h.controller.afterRoute();assert.equal(h.controller.route.key,'project:q:knowledge','incomplete guard defers restoration');
  gate.resolve(false);assert.equal(await pending,false);assert.equal(h.controller.route.key,'daily');
  assert.deepEqual(h.value.ui.workspaceNavigation,previous,'an external global page must not record the rejected outputs target');
});
test('a failed pending transition records the external actual chat without remembering the rejected section',async()=>{
  const gate=deferred();const h=harness({navigateProject:()=>gate.promise});const pending=h.controller.go('outputs','p');
  h.value.currentConversationId='b';h.elements.messageList.dataset.conversationId='b';h.document.body.dataset.view='agent';h.controller.afterRoute();
  gate.reject(Error('draft save cancelled'));assert.equal(await pending,false);assert.equal(h.controller.route.key,'chat:b');
  assert.deepEqual(h.value.ui.workspaceNavigation.projects.p,{section:'conversations',conversationId:'b'});
  assert.equal(h.value.ui.workspaceNavigation.projects.q.section,'knowledge');
});
test('reconciliation after a rejected guard does not persist an externally opened private chat',async()=>{
  const gate=deferred(),value=state();value.conversations.push({id:'secret',projectId:'p',ephemeral:true});
  const h=harness({value,visibleConversation:conversation=>!!conversation.ephemeral,navigateProject:()=>gate.promise});
  const before=JSON.parse(JSON.stringify(value.ui.workspaceNavigation));const pending=h.controller.go('outputs','p');
  value.currentConversationId='secret';h.elements.messageList.dataset.conversationId='secret';h.document.body.dataset.view='agent';h.controller.afterRoute();
  gate.resolve(false);assert.equal(await pending,false);assert.equal(h.controller.route.key,'chat:secret');assert.deepEqual(value.ui.workspaceNavigation,before);
  h.controller.beforeRoute();assert.deepEqual(value.ui.workspaceNavigation,before,'outgoing private composer capture stays in memory only');
});
