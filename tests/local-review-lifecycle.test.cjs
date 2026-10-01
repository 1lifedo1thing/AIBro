const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const FileContext=require('../app/file-context.js');
const source=fs.readFileSync(require.resolve('../app/local-file-edits.js'),'utf8');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function harness({reuseViewer=false,kit=false}={}){
 class Node{
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.textContent='';this.isConnected=true;this.disabled=false;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(name,value){this[name]=value;}
  querySelectorAll(){return this.children.flatMap(function walk(node){return[node,...node.children.flatMap(walk)];}).filter(node=>node.tagName==='button');}
  querySelector(){return this.querySelectorAll()[0];}
  scrollIntoView(){}
  focus(){this.focused=true;}
 }
 const summaries=['first','second'].map(id=>({id,runId:'run',projectId:'project',candidateId:'folder',path:`${id}.md`,status:'pending'}));
 const run={id:'run',conversationId:'chat',projectId:'project',status:'completed',localFileEdits:summaries};
 let state={agentRuns:[run],projects:[{id:'project',localFolder:{id:'folder'}}],conversations:[{id:'chat'}]};
 const calls=[],requests=[],docs=[],workbenches=[],container=new Node('main');
 const context={document:{createElement:tag=>new Node(tag)},FileReview:require('../app/file-review.js'),FileContext:{...FileContext,request(path,payload){const pending=defer();requests.push({path,payload,...pending});return pending.promise;}},
  ProjectFiles:{localId:ref=>JSON.stringify([ref.projectId,ref.candidateId,ref.path]),parseLocal(id,current){const [projectId,candidateId]=JSON.parse(id);return current.projects.some(p=>FileContext.active(p)&&p.id===projectId&&p.localFolder?.id===candidateId);}},
  ReviewWorkbench:{dispose(viewer){calls.push(['dispose',viewer]);},create(_container,config){
   const previous=workbenches.at(-1),viewer=reuseViewer&&previous?previous.viewer:new Node('section');
   if(previous&&!reuseViewer)previous.viewer.isConnected=false;
   const state={};const workbench={config,viewer,state,refresh(file){calls.push(['refresh',file.id,file.status]);},select(file){state.selectedId=file.id;return config.onSelect(file,viewer,state);}};
   workbenches.push(workbench);workbench.pending=workbench.select(config.files.find(file=>file.id===config.selectedId)||config.files[0]);return workbench;
  },document(viewer,config){const footer=new Node('footer');footer.append(...config.actions);viewer.replaceChildren(footer);docs.push(config);return{footer};}},
  FileActions:{reveal:async ref=>calls.push(['reveal',ref])}};
 if(kit)context.HalaskaUI={componentNames:['Button'],mount(host,name,props){const button=new Node('button');button.textContent=props.children;button.onclick=props.onClick;host.append(button);calls.push(['kit',name]);}};
 vm.createContext(context);vm.runInContext(source,context);const api=context.LocalFileEdits;
 api.init({getState:()=>state,isBusy:()=>false,save:()=>calls.push(['save']),fileChanged:(...args)=>calls.push(['changed',...args]),openFile:(...args)=>calls.push(['open',...args]),toast:value=>calls.push(['toast',value]),markdown:value=>value});
 const snapshot=(index=0,patch={})=>({...summaries[index],before:'Original',after:'Proposed',creating:false,hunks:[],...patch});
 return{api,run,summaries,calls,requests,docs,container,context,snapshot,get state(){return state;},set state(value){state=value;},get workbench(){return workbenches.at(-1);},render:(id='first')=>api.render(container,run,id),action:key=>docs.at(-1).actions.find(node=>node.dataset.localEditAction===key)};
}
test('snapshot errors keep selected file and offer a real Kit retry for that exact identity',async()=>{
 const h=harness({kit:true});h.render('second');h.requests[0].reject(Error('temporary read failure'));await h.workbench.pending;
 assert.equal(h.workbench.state.selectedId,'second');assert.equal(h.docs.length,0);assert.deepEqual(h.calls.find(call=>call[0]==='kit'),['kit','Button']);
 const retry=h.workbench.viewer.children[1].children[0].onclick();assert.equal(h.requests[1].payload.id,'second');h.requests[1].resolve(h.snapshot(1));await retry;
 assert.equal(h.docs.at(-1).path,'second.md');assert.equal(h.calls.filter(call=>call[0]==='dispose').length,2);
});
test('a late snapshot cannot render or mutate status in a newer render even if the viewer is reused',async()=>{
 const h=harness({reuseViewer:true});const first=h.render();h.render('second');h.requests[1].resolve(h.snapshot(1));await h.workbench.pending;const visible=h.docs.at(-1);
 h.requests[0].resolve(h.snapshot(0,{status:'applied'}));await first.pending;
 assert.equal(h.docs.at(-1),visible);assert.equal(h.summaries[0].status,'pending');assert.equal(h.calls.some(call=>call[0]==='save'),false);
});
test('selection races ignore older reads and retain the newer selection',async()=>{
 const h=harness();h.render();const older=h.workbench.pending,newer=h.workbench.select(h.workbench.config.files[1]);h.requests[1].resolve(h.snapshot(1));await newer;h.requests[0].resolve(h.snapshot());await older;
 assert.equal(h.docs.length,1);assert.equal(h.docs[0].path,'second.md');assert.equal(h.workbench.state.selectedId,'second');
});
test('hydrated replacement, retired run, private conversation and folder rebind discard pending read effects',async()=>{
 for(const mutate of [h=>{h.state=structuredClone(h.state);},h=>{h.state.agentRuns=[structuredClone(h.run)];},h=>{h.state.conversations[0].private=true;},h=>{h.state.projects[0].localFolder.id='other';},h=>{h.run.localFileEdits[0]={...h.summaries[0]};},h=>{delete h.run.conversationId;},h=>{h.run.projectId='other';}]){
  const h=harness();h.render();mutate(h);h.requests[0].resolve(h.snapshot(0,{status:'applied'}));await h.workbench.pending;
  assert.equal(h.docs.length,0);assert.equal(h.calls.some(call=>call[0]==='save'),false);
 }
});
test('mismatched server identity is an error with retry and never becomes a saved status',async()=>{
 const h=harness();h.render();h.requests[0].resolve(h.snapshot(0,{candidateId:'wrong',status:'applied'}));await h.workbench.pending;
 assert.equal(h.docs.length,0);assert.equal(h.summaries[0].status,'pending');assert.match(h.workbench.viewer.children[0].textContent,/不一致/);assert.equal(h.workbench.viewer.children[1].children[0].textContent,'重新读取');
});
test('late action completion cannot mutate a replacement workspace or trigger old follow-up',async()=>{
 const h=harness();h.render();h.requests[0].resolve(h.snapshot());await h.workbench.pending;const action=h.action('apply').onclick();h.state=structuredClone(h.state);h.requests[1].resolve(h.snapshot(0,{status:'applied'}));assert.equal(await action,false);
 assert.equal(h.state.agentRuns[0].localFileEdits[0].status,'pending');assert.equal(h.calls.some(call=>['save','changed'].includes(call[0])),false);
});
test('an accepted change finishes its owning record while another selected file retains its surface',async()=>{
 const h=harness();h.render();h.requests[0].resolve(h.snapshot());await h.workbench.pending;const pending=h.action('apply').onclick();const second=h.workbench.select(h.workbench.config.files[1]);h.requests[2].resolve(h.snapshot(1));await second;const visible=h.docs.at(-1);h.requests[1].resolve(h.snapshot(0,{status:'applied'}));assert.equal(await pending,true);
 assert.equal(h.docs.at(-1),visible);assert.equal(h.workbench.state.selectedId,'second');assert.equal(h.summaries[0].status,'applied');assert.equal(h.calls.filter(call=>call[0]==='changed').length,1);
});
test('retired controls never dispatch another mutation',async()=>{
 const h=harness({reuseViewer:true});h.render();h.requests[0].resolve(h.snapshot());await h.workbench.pending;const stale=h.action('apply');h.render();assert.equal(await stale.onclick(),false);assert.equal(h.requests.length,2);
 h.requests[1].resolve(h.snapshot());await h.workbench.pending;
});
test('current file navigation carries exact local identity, provenance, anchor and revalidation',async()=>{
 const h=harness();h.render('second');h.requests[0].resolve(h.snapshot(1));await h.workbench.pending;const button=h.docs.at(-1).actions.find(node=>node.textContent==='打开当前文件');assert(button);
 button.onclick({currentTarget:button});const [,kind,id,page,source,guard,navigation]=h.calls.at(-1);
 assert.equal(kind,'local-file');assert.deepEqual(JSON.parse(id),['project','folder','second.md']);assert.equal(page,undefined);assert.equal(source.runId,'run');assert.equal(source.conversationId,'chat');assert.equal(navigation.anchor,button);assert.equal(guard(),true);h.state.projects[0].localFolder.id='other';assert.equal(guard(),false);
});
test('uncreated files, directories and Office snapshots do not pretend to open a supported current document',async()=>{
 for(const patch of [{creating:true},{directory:true},{office:true}]){const h=harness();h.render();h.requests[0].resolve(h.snapshot(0,patch));await h.workbench.pending;assert.equal(h.docs.at(-1).actions.some(node=>node.textContent==='打开当前文件'),false);}
 const h=harness();h.render();h.requests[0].resolve(h.snapshot(0,{creating:true,status:'partial',hunks:[{status:'accepted'}]}));await h.workbench.pending;assert.equal(h.docs.at(-1).actions.some(node=>node.textContent==='打开当前文件'),true);
});
