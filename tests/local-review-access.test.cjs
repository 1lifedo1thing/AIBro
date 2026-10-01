const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const FileReview=require('../app/file-review.js'),FileContext=require('../app/file-context.js'),LocalFileEdits=require('../app/local-file-edits.js');
function fixture(){
 const project={id:'p',localFolder:{id:'folder'}},conversation={id:'chat'},note={id:'note',title:'Library output',content:'Body'};
 const edit={id:'edit',runId:'run',projectId:'p',candidateId:'folder',path:'folder/local-output.md',status:'pending'};
 const run={id:'run',conversationId:'chat',status:'completed',localFileEdits:[edit],fileChanges:[{id:'note',type:'note',title:'Library output',operation:'updated',after:{content:'Body'}}]};
 return{project,conversation,note,edit,run,state:{projects:[project],conversations:[conversation],notes:[note],agentRuns:[run],trash:[]}};
}
function browser(h,{late=false}={}){
 const roots=[],calls=[];class Node{constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this._text='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;this._text='';}before(node){roots.push(node);}set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}}
 const all=()=>roots.flatMap(function walk(node){return[node,...node.children.flatMap(walk)];}),composer=new Node('div');composer.id='composer';roots.push(composer);
 const context={FileContext,document:{createElement:tag=>new Node(tag),getElementById:id=>all().find(node=>node.id===id)},PrivateMode:{isOn:()=>context.privateMode===true}};
 if(!late)context.FileReview=FileReview;
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../app/local-file-edits.js'),'utf8'),context);const api=context.LocalFileEdits;
 api.init({getState:()=>h.state,open:(...args)=>calls.push(['review',...args]),openReview:(...args)=>calls.push(['library-review',...args]),openFile:(...args)=>calls.push(['open-file',...args])});
 return{api,context,roots,calls,all,card:()=>api.card(h.run),tray:()=>api.tray(h.conversation)};
}
test('valid running and failed local proposals remain visible beside unbound library outputs',()=>{
 for(const status of ['running','failed','cancelled','completed']){const h=fixture();h.run.status=status;const rows=LocalFileEdits.outputs(h.state,'chat');assert.equal(rows.length,2);assert.equal(rows.find(row=>row.kind==='local').pending,true);assert.equal(rows.find(row=>row.kind==='note').title,'Library output');}
 const h=fixture();h.run.localFileEdits=[];h.state.projects=[];assert.equal(LocalFileEdits.outputs(h.state,'chat')[0].title,'Library output');
});
test('unsafe local metadata cannot hide an independently valid unbound library output',()=>{
 for(const mutate of [h=>{h.edit.private=true;},h=>{h.project.private=true;},h=>{h.project.archived=true;},h=>{h.state.projects.push({...h.project});}]){const h=fixture();mutate(h);const rows=LocalFileEdits.outputs(h.state,'chat');assert.deepEqual(rows.map(row=>row.kind),['note']);assert.doesNotMatch(JSON.stringify(rows),/local-output/);}
});
test('private conversation, provenance and duplicate owners expose no card or tray titles',()=>{
 for(const mutate of [h=>{h.conversation.private=true;},h=>{h.state.conversations=[];},h=>{h.state.agentRuns.push({...h.run});},h=>{h.state.conversations.push({...h.conversation});},h=>{h.run.provenance={origin:{runId:'private-run'}};h.state.trash.push({data:{runs:[{id:'private-run',private:true}]}});}]){
  const h=fixture(),b=browser(h);mutate(h);assert.deepEqual(LocalFileEdits.outputs(h.state,'chat'),[]);assert.equal(b.card(),null);b.tray();const host=b.all().find(node=>node.id==='conversationOutputs');assert.equal(host.hidden,true);assert.equal(host.textContent,'');
 }
});
test('browser resolves the later-loaded real policy and applies its own global private mode',()=>{
 const h=fixture(),b=browser(h,{late:true});assert.equal(b.card(),null);assert.equal(b.api.outputs(h.state,'chat').length,0);
 b.context.FileReview=FileReview;assert(b.card());b.tray();assert.match(b.all().find(node=>node.id==='conversationOutputs').textContent,/local-output/);
 b.context.privateMode=true;assert.equal(b.card(),null);b.tray();assert.equal(b.all().find(node=>node.id==='conversationOutputs').textContent,'');assert.equal(b.api.outputs(h.state,'chat').length,0);
});
test('retained card and tray callbacks revalidate access before navigation',()=>{
 const h=fixture(),b=browser(h),card=b.card(),row=card.children.find(node=>node.className==='file-change-row');row.onclick({currentTarget:row});assert.equal(b.calls[0][1],'run');assert.equal(b.calls[0][3].anchor,row);
 b.tray();const localOpen=b.all().find(node=>node.className==='output-file'&&node.textContent.includes('local-output')),libraryOpen=b.all().find(node=>node.className==='output-file'&&node.textContent==='Library output'),review=b.all().find(node=>node.className==='output-review');
 h.conversation.private=true;assert.equal(row.onclick({currentTarget:row}),false);assert.equal(localOpen.onclick({currentTarget:localOpen}),false);assert.equal(libraryOpen.onclick({currentTarget:libraryOpen}),false);assert.equal(review.onclick({currentTarget:review}),false);assert.equal(b.calls.length,1);
});
test('library tray navigation retains anchor and canOpen while local review retains its own route',()=>{
 const h=fixture(),b=browser(h);b.tray();const localOpen=b.all().find(node=>node.className==='output-file'&&node.textContent.includes('local-output')),libraryOpen=b.all().find(node=>node.className==='output-file'&&node.textContent==='Library output');
 localOpen.onclick({currentTarget:localOpen});assert.equal(b.calls[0][0],'review');assert.equal(b.calls[0][3].anchor,localOpen);
 libraryOpen.onclick({currentTarget:libraryOpen});const [,kind,id,page,guard,canOpen,navigation]=b.calls[1];assert.equal(kind,'note');assert.equal(id,'note');assert.equal(page,undefined);assert.equal(guard,undefined);assert.equal(navigation.anchor,libraryOpen);assert.equal(canOpen(),true);h.note.private=true;assert.equal(canOpen(),false);
});
