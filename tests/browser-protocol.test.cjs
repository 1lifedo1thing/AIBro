const test=require('node:test'),assert=require('node:assert/strict');
const K=require('../app/knowledge-access'),S=require('../app/tool-scheduler'),G=require('../app/tool-loop-guard');
const plan=requests=>JSON.stringify({knowledgeRequests:requests,actions:[]});
test('browser observations refresh after each tool round and screenshot reaches image attachment path',async()=>{
 let observations=0,turns=0;
 await K.continuePlan(plan([{type:'browser_snapshot'}]),{
  execute:async r=>r.type==='browser_snapshot'?{snapshotId:'s'+(++observations),text:'version '+observations}:{snapshotId:'image',blocks:[{type:'input_image',image_url:'data:image/png;base64,fixture'}]},
  ask:async(text,images)=>{turns++;if(turns===1){assert.match(text,/version 1/);return plan([{type:'browser_snapshot'}]);}if(turns===2){assert.match(text,/version 2/);return plan([{type:'browser_screenshot'}]);}assert.equal(images.length,1);return '{"actions":[]}';}
 });assert.equal(observations,2);assert.equal(turns,3);
});
test('browser tools are sequential barriers and retain exact observed reference/action fields',async()=>{
 const calls=[],run={};let active=0,peak=0;
 const request={type:'browser_type',tabId:'tab',sessionId:'session',snapshotId:'snap',ref:'e1-2',text:'literal text'};
 const scheduler=S.create({run,execute:async r=>{peak=Math.max(peak,++active);calls.push(r);await new Promise(resolve=>setTimeout(resolve,3));active--;return {ok:true};}});
 await scheduler.batch([{type:'browser_snapshot'},request,{type:'browser_scroll',snapshotId:'fresh',x:0,y:700}]);
 assert.equal(peak,1);assert.deepEqual(calls[1],request);assert.equal(calls[2].y,700);
});
test('progress resets browser observation guard while failed or repeated observations remain bounded',()=>{
 const observe={type:'browser_snapshot'},entry=(request,status='completed')=>({request,status});
 const repeated=Array.from({length:G.LIMIT},()=>entry(observe));
 assert.equal(G.inspect(repeated).repeated.length,1);
 assert.equal(G.inspect([...repeated,entry({type:'browser_click',snapshotId:'s',ref:'e'})]).repeated.length,0);
 assert.equal(G.inspect([...repeated,entry({type:'browser_click',snapshotId:'s',ref:'e'},'failed')]).repeated.length,1);
 assert.notEqual(G.signature({type:'browser_type',snapshotId:'a',ref:'e',text:'one'}),G.signature({type:'browser_type',snapshotId:'a',ref:'e',text:'two'}));
});
