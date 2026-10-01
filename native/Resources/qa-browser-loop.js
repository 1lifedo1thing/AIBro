// Deterministic planner fixture; real BrowserTools, scheduler, bridge and WKWebView.
const checks=[];
const ensure=(value,message)=>{if(!value)throw Error(message);checks.push(message);};
const run={id:'browser-loop-run',conversationId:'browser-loop-conversation',projectId:null,status:'running'};
const fixture={agentRuns:[run],conversations:[{id:run.conversationId,projectId:null}],projects:[]};
BrowserTools.init({getState:()=>fixture});
let latest,turn=0;const plan=request=>JSON.stringify({knowledgeRequests:[request],actions:[]});
const scheduler=ToolScheduler.create({run,execute:async request=>latest=await BrowserTools.execute(request,fixture,run)});
await KnowledgeAccess.continuePlan(plan({type:'browser_open',url:fixtureURL}),{batch:scheduler.batch,ask:async(text,images)=>{
 turn++;
 if(turn===1)return plan({type:'browser_snapshot'});
 if(turn===2){const element=latest.elements.find(e=>e.name==='研究名称');ensure(!!element,'tool loop receives real input DOM ref');return plan({type:'browser_type',snapshotId:latest.snapshotId,ref:element.ref,text:'工具循环验证'});}
 if(turn===3)return plan({type:'browser_snapshot'});
 if(turn===4){ensure(latest.text.includes('已填写：工具循环验证'),'tool loop observes live input result');const element=latest.elements.find(e=>e.name==='增加计数');return plan({type:'browser_click',snapshotId:latest.snapshotId,ref:element.ref});}
 if(turn===5)return plan({type:'browser_screenshot'});
 ensure(latest.text.includes('计数：1'),'tool loop observes exactly one real click');
 const screenshot=images.find(block=>block.type==='input_image');
 ensure(!!screenshot&&screenshot.image_url.startsWith('data:image/jpeg;base64,')&&images.some(block=>block.type==='input_text'&&block.text.includes('owned-browser-screenshot')),'tool loop passes actual native screenshot and ownership metadata into image input');
 return '{"message":"fixture completed","actions":[]}';
}});
ensure(run.toolCalls.length===6&&run.toolCalls.every(call=>call.status==='completed'),'all six real browser operations complete through scheduler');
ensure(!JSON.stringify(run.browserSession).includes('工具循环验证')&&!JSON.stringify(run.browserSession).includes('base64'),'browser card stores metadata without page/input/image payload');
ensure(run.toolCalls.every(call=>!call.result?.blocks),'durable tool results omit binary screenshot blocks');
const controller=new AbortController(),cancelRun={id:'browser-unscoped-cancel',conversationId:run.conversationId,projectId:null,status:'running',permissionMode:'request'};fixture.agentRuns.push(cancelRun);
const pending=BrowserTools.execute({type:'browser_open',url:fixtureURL},fixture,cancelRun,{signal:controller.signal});
// Native QA waits until this run has a pending navigation approval before abort.
globalThis.__browserLoopCancel=()=>controller.abort();
try{await pending;throw Error('Cancelled browser open unexpectedly completed');}catch(error){ensure(error.code==='CANCELLED','unscoped first-open abort resolves full frontend/native loop');}
delete globalThis.__browserLoopCancel;
return {checks,turns:turn,session:run.browserSession};
