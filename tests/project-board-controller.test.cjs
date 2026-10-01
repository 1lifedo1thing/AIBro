'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Board=require('../app/project-board.js');
const fixture=()=>({currentProjectId:'p',projects:[{id:'p',name:'Public'},{id:'q',name:'Other'}],tasks:[{id:'t',title:'Public task',projectId:'p',status:'todo',updatedAt:1,description:'Keep description'}],notes:[],conversations:[],agentRuns:[],trash:[]});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function controller(initial=fixture(),extra={}){
  let state=initial,props,mounts=0,updates=0,unmounts=0,clears=0,legacyRemovals=0;
  const opened=[],messages=[],created=[],host={isConnected:true,hidden:true,classList:{remove(){}},replaceChildren(){clears++;},contains(node){return node?.owned===true;}};
  const elements={projectTasks:host,projectTaskBoard:{remove(){legacyRemovals++;delete elements.projectTaskBoard;}}};
  const hooks={getState:()=>state,getProjectId:()=>state.currentProjectId,document:{getElementById:id=>elements[id]},now:()=>10,
    mount:(target,name,value)=>{assert.equal(target,host);assert.equal(name,'ProjectBoard');mounts++;props=value;return {update:value=>{updates++;props=value;},unmount:()=>{unmounts++;}};},
    persist:async()=>true,renderAll(){},toast:value=>messages.push(value),open:(...args)=>opened.push(args),onCreate:(...args)=>created.push(args),...extra};
  Board.init(hooks);Board.render(state.currentProjectId);
  return {get props(){return props;},get state(){return state;},host,elements,opened,messages,created,get stats(){return {mounts,updates,unmounts,clears,legacyRemovals};},
    render:()=>Board.render(state.currentProjectId),setProject:id=>{state.currentProjectId=id;Board.render(id);},replace:next=>{state=next;Board.render(next.currentProjectId);}};
}

test('both list and board models exclude duplicate identities and all private ancestry before counts',()=>{
  const state=fixture();state.conversations.push({id:'secret',private:true});state.agentRuns.push({id:'secret-run',conversationId:'secret'});
  state.trash.push({data:{conversations:[{id:'retired',incognito:true}]}});
  const hidden=[{private:true},{ephemeral:true},{incognito:true},{provenance:{origin:{private:true}}},{sourceConversationId:'secret'},{agentRunId:'secret-run'},{conversationId:'retired'},{deleted:true},{archivedAt:1},{wikiFileError:'missing'}];
  hidden.forEach((patch,index)=>state.tasks.push({id:`hidden-${index}`,title:'HIDDEN',projectId:'p',...patch}));
  state.tasks.push({id:'duplicate',title:'HIDDEN A',projectId:'p'},{id:'duplicate',title:'HIDDEN B',projectId:'p'});
  const before=JSON.stringify(state),data=Board.model(state,'p');assert.deepEqual(data.tasks.map(task=>task.id),['t']);assert.equal(data.counts.todo,1);assert.doesNotMatch(JSON.stringify(data),/HIDDEN|Keep description/);assert.equal(JSON.stringify(state),before);
  state.projects.push({...state.projects[0]});assert.equal(Board.model(state,'p').available,false);assert.deepEqual(Board.model(state,'p').tasks,[]);
});

test('public move enforces actual TaskDeliverable rules with public nonambiguous target records',()=>{
  const state=fixture(),task=state.tasks[0];task.deliverable={kind:'note',ref:'result'};
  const attempt=()=>Board.move(state,'t','p','done',JSON.stringify(task),10);
  assert.throws(attempt,/产出校验/);assert.equal(task.status,'todo');
  state.notes.push({id:'result',projectId:'p',provenance:{origin:{private:true}}});assert.throws(attempt,/产出校验/);
  delete state.notes[0].provenance;state.notes.push({...state.notes[0]});assert.throws(attempt,/产出校验/);
  state.notes.pop();assert.equal(attempt().changed,true);assert.equal(task.completedAt,10);
  assert.equal(Board.move(state,'t','p','done',JSON.stringify(task),20).changed,false);assert.equal(task.completedAt,10);
});

test('private or reassigned task and project cannot be moved using a previously displayed version',()=>{
  for(const mutate of [state=>{state.tasks[0].private=true;},state=>{state.tasks[0].projectId='q';},state=>{state.projects[0].provenance={origin:{private:true}};},state=>{state.tasks.push({...state.tasks[0]});}]){
    const state=fixture(),version=JSON.stringify(state.tasks[0]);mutate(state);assert.throws(()=>Board.move(state,'t','p','done',version),/已变化/);
  }
});

test('same-scope render reuses the Kit island and leaves its internally owned board intact',()=>{
  const control=controller();assert.deepEqual(control.stats,{mounts:1,updates:0,unmounts:0,clears:1,legacyRemovals:1});
  control.elements.projectTaskBoard={owned:true,remove(){throw Error('Removed React-owned board');}};
  control.props.onMode('board');control.render();assert.equal(control.stats.mounts,1);assert.equal(control.stats.unmounts,0);assert.equal(control.props.mode,'board');assert.equal(control.state.ui,undefined);
  control.setProject('q');assert.equal(control.props.mode,'list');control.props.onMode('board');control.setProject('p');assert.equal(control.props.mode,'board');
});

test('retired project and workspace callbacks cannot mutate preferences, tasks, or navigation',async()=>{
  const control=controller(),old=control.props;control.setProject('q');
  assert.equal(old.onMode('board'),false);assert.equal(await old.onStatus('t','done'),false);assert.equal(old.onOpen('t'),false);assert.equal(old.onCreate(),false);
  control.setProject('p');assert.equal(await old.onStatus('t','done'),false);assert.equal(control.props.mode,'list');
  const latest=control.props;control.replace(fixture());assert.equal(await latest.onStatus('t','done'),false);assert.equal(control.state.tasks[0].status,'todo');assert.equal(control.opened.length,0);
});

test('false durable acknowledgement rolls back only the owned status and never reports success',async()=>{
  const save=deferred(),control=controller(fixture(),{persist:()=>save.promise}),task=control.state.tasks[0];
  const promise=control.props.onStatus('t','done');assert.equal(task.status,'done');assert.deepEqual(control.props.busyIds,['t']);
  task.title='Edited while saving';task.description='Concurrent details';task.updatedAt=12;
  save.resolve(false);assert.equal(await promise,false);assert.equal(task.status,'todo');assert.equal(task.completedAt,undefined);assert.equal(task.title,'Edited while saving');assert.equal(task.description,'Concurrent details');assert.equal(task.updatedAt,12);
  assert.deepEqual(control.props.busyIds,[]);assert.equal(control.messages.length,1);assert.match(control.messages[0],/尚未保存/);
});

test('only explicit true acknowledges durability and isBusy protects the whole pending operation',async()=>{
  for(const acknowledgement of [undefined,null,0,'saved']){
    const save=deferred(),control=controller(fixture(),{persist:()=>save.promise});
    assert.equal(Board.isBusy(),false);const promise=control.props.onStatus('t','done');assert.equal(Board.isBusy(),true);
    control.setProject('q');assert.equal(Board.isBusy(),true);save.resolve(acknowledgement);assert.equal(await promise,false);
    assert.equal(Board.isBusy(),false);assert.equal(control.state.tasks[0].status,'todo');assert.deepEqual(control.messages,[]);
  }
});

test('failed save cannot overwrite a newer status transition or a replacement task object',async()=>{
  for(const replace of [false,true]){
    const save=deferred(),control=controller(fixture(),{persist:()=>save.promise});const promise=control.props.onStatus('t','done');
    const newer={...control.state.tasks[0],title:'Newer',status:'blocked',completedAt:null,updatedAt:20};
    if(replace)control.state.tasks[0]=newer;else Object.assign(control.state.tasks[0],newer);
    save.reject(Error('Not saved'));assert.equal(await promise,false);assert.deepEqual(control.state.tasks[0],newer);
  }
});

test('pending transitions reject double submission and await real persistence before success',async()=>{
  const save=deferred();let saves=0,renders=0;const control=controller(fixture(),{persist:()=>{saves++;return save.promise;},renderAll:()=>renders++});
  const promise=control.props.onStatus('t','done');assert.equal(await control.props.onStatus('t','blocked'),false);assert.equal(saves,1);assert.deepEqual(control.messages,[]);
  save.resolve(true);assert.equal(await promise,true);assert.equal(renders,1);assert.deepEqual(control.messages,['任务状态已保存']);
});

test('late save completion neither refreshes nor toasts a new project or workspace owner',async()=>{
  for(const outcome of [true,false]){
    const save=deferred();let renders=0;const initial=fixture(),control=controller(initial,{persist:()=>save.promise,renderAll:()=>renders++}),promise=control.props.onStatus('t','done');
    const other=fixture();control.replace(other);const baseline=control.stats.updates;save.resolve(outcome);assert.equal(await promise,outcome);
    assert.equal(control.stats.updates,baseline);assert.equal(renders,0);assert.deepEqual(control.messages,[]);assert.equal(other.tasks[0].status,'todo');
    assert.equal(initial.tasks[0].status,outcome?'done':'todo');
  }
});

test('drag and keyboard status changes share stale-version, privacy and persistence checks',async()=>{
  let saves=0;const control=controller(fixture(),{persist:async()=>{saves++;return true;}}),old=control.props;
  assert.equal(old.onDragStart('t'),true);assert.equal(old.canDrop(),true);assert.equal(await old.onDrop('in_progress'),true);assert.equal(saves,1);assert.equal(control.state.tasks[0].status,'in_progress');assert.equal(control.props.canDrop(),false);
  const stale=control.props;assert.equal(stale.onDragStart('t'),true);control.state.tasks[0].title='Changed';assert.equal(await stale.onDrop('done'),false);assert.equal(saves,1);
  control.render();const source=control.props;assert.equal(source.onDragStart('t'),true);control.setProject('q');assert.equal(source.canDrop(),false);assert.equal(await source.onDrop('done'),false);
});

test('opening preserves exact task origin and its guard rejects a newly private source',()=>{
  const control=controller(),anchor={};control.props.onOpen('t',anchor);const [id,options]=control.opened[0];assert.equal(id,'t');assert.equal(options.anchor,anchor);assert.deepEqual(options.origin,{view:'project',projectId:'p',section:'tasks'});assert.equal(options.guard(),true);
  control.state.tasks[0].provenance={origin:{private:true}};assert.equal(options.guard(),false);assert.equal(control.props.onOpen('t'),false);
});

test('browser privacy and completion validation dependencies resolve lazily and fail closed',()=>{
  const context=vm.createContext({Date,console});vm.runInContext(fs.readFileSync(require.resolve('../app/project-board.js'),'utf8'),context);
  const state=fixture();assert.equal(context.ProjectBoard.model(state,'p').available,false);
  context.CitationEvidence=require('../app/citation-evidence.js');assert.equal(context.ProjectBoard.model(state,'p').tasks.length,1);
  assert.throws(()=>context.ProjectBoard.move(state,'t','p','done',JSON.stringify(state.tasks[0])),/校验当前不可用/);assert.equal(state.tasks[0].status,'todo');
  context.TaskDeliverable=require('../app/task-deliverable.js');context.ProjectBoard.move(state,'t','p','done',JSON.stringify(state.tasks[0]),10);assert.equal(state.tasks[0].status,'done');
});
