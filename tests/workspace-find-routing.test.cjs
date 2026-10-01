'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const listener=source.split('\n').find(line=>line.startsWith("window.addEventListener('keydown', event =>")&&line.includes('openSearchDialog'));
const start=source.indexOf('function openWorkspaceFind()'),end=source.indexOf("window.addEventListener('keydown', event =>",start);
const helper=start<0?'':source.slice(start,end);
function route({visible=false,expanded=false,focus='chat',view='agent',pdf=true,modal=false,consumed=false}={}){
 const calls=[],node={closest:selector=>focus==='composer'&&selector.includes('#agentInput')?{}:null};
 const env={document:{body:{dataset:{view}},activeElement:node,querySelector:selector=>selector==='dialog[open]'?(modal?{}:null):selector==='#messageList'?{contains:()=>focus==='chat'}:selector==='#readingPane'?{hidden:!visible}:null},
  pdfReaderHandle:{openFind:()=>{calls.push('pdf');return pdf;}},ReadingPane:{snapshot:()=>({visible,expanded})},FindInConversation:{open:()=>{calls.push('chat');return true;}},openSearchDialog(){},navigateWorkspaceNewConversation(){},
  addEventListener:(name,fn)=>{env.listener=fn;}};
 env.window=env;env.$=selector=>env.document.querySelector(selector);vm.createContext(env);vm.runInContext(helper+listener,env);
 let prevented=false;env.listener({defaultPrevented:consumed,isComposing:false,key:'f',metaKey:true,preventDefault(){prevented=true;}});return {calls,prevented};
}
test('parked or hidden PDF cannot consume conversation Find',()=>{assert.deepEqual(route().calls,['chat']);});
test('visible PDF owns Find in reader focus or expanded mode',()=>{assert.deepEqual(route({visible:true,focus:'reader'}).calls,['pdf']);assert.deepEqual(route({visible:true,expanded:true}).calls,['pdf']);});
test('split view conversation and composer focus search the conversation',()=>{assert.deepEqual(route({visible:true}).calls,['chat']);assert.deepEqual(route({visible:true,focus:'composer'}).calls,['chat']);});
test('modals and an editor-consumed shortcut remain untouched',()=>{assert.deepEqual(route({modal:true}),{calls:[],prevented:false});assert.deepEqual(route({consumed:true}),{calls:[],prevented:false});});
test('hidden non-conversation pages cannot focus an invisible chat search field',()=>{assert.deepEqual(route({view:'project'}).calls,[]);});
