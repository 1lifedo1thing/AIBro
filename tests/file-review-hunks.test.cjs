const {test}=require('node:test'),assert=require('node:assert/strict');
const R=require('../app/file-review.js'),E=require('../app/local-file-edits.js'),F=require('../app/file-context.js');
test('authoritative hunk ranges have no phantom EOF rows and preserve CRLF display',()=>{
 const rows=R.hunkRows({oldStart:12,newStart:14,oldCount:2,newCount:1,before:'old\r\nlast\r\n',after:'new\r\n'},'',0);
 assert.deepEqual(rows,[{type:'remove',text:'old',old:12,next:null},{type:'remove',text:'last',old:13,next:null},{type:'add',text:'new',old:null,next:14}]);
 assert.deepEqual(R.hunkRows({oldStart:1,newStart:1,oldCount:0,newCount:0,before:'',after:''},'',0),[]);
 assert.equal(R.hunkRows({oldStart:1,newStart:1,oldCount:0,newCount:1,before:'',after:'\n'},'',0)[0].text,'');
});
test('partial apply and undo refresh only the matching conversation reference',()=>{
 const ref={type:'local',candidateId:'c',projectId:'p',path:'plan.md',version:'base'};
 const conversation={id:'c',fileReferences:[ref],messages:[{role:'user',fileReferences:[{...ref}]}]},state={conversations:[conversation]},run={conversationId:'c'};
 E.followUp(state,run,{...ref,beforeVersion:'base',afterVersion:'full',transition:{beforeVersion:'base',afterVersion:'partial'}},'accept-hunk');
 assert.equal(F.references(conversation)[0].version,'partial');assert.equal(conversation.messages[0].fileReferences[0].version,'base');
 E.followUp(state,run,{...ref,transition:{beforeVersion:'partial',afterVersion:'base'}},'undo-hunk');assert.equal(F.references(conversation)[0].version,'base');
 F.refresh(conversation,{...ref,version:'manual'});E.followUp(state,run,{...ref,transition:{beforeVersion:'base',afterVersion:'partial'}},'accept-hunk');assert.equal(F.references(conversation)[0].version,'manual');
});
test('partially reviewed proposals remain in the pending output shelf',()=>{
 const rows=E.outputs({projects:[{id:'p',localFolder:{id:'folder'}}],conversations:[{id:'c',projectId:'p'}],agentRuns:[{id:'r',conversationId:'c',projectId:'p',localFileEdits:[{id:'e',runId:'r',projectId:'p',candidateId:'folder',path:'plan.md',status:'partial'}]}]},'c');assert.equal(rows[0].pending,true);
});
