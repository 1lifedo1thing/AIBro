/* 视觉验收（隔离实例）：对话产出 → 「存为文档」→ 阅读区就地编辑器。
   只读取合成数据，不触碰真实用户数据目录；产物写到工作区供人工核对。
   运行：node_modules/.bin/electron tests/shot-note-capture.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18901,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-shot-note-')),STORE=path.join(TEMP,'store');
fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));
app.setPath('userData',path.join(TEMP,'profile'));
const OUT=process.env.SHOT_OUT||ROOT;
const THEME=process.env.SHOT_THEME==='dark'?'dark':'light';
const NAME=process.env.SHOT_NAME||'aibro-note-capture.png';
let server,win;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode}));}).on('error',reject));
async function until(fn,label,timeout=40000){const s=Date.now();while(Date.now()-s<timeout){if(await fn())return;await wait(80);}throw Error('timeout: '+label);}
const watchdog=setTimeout(()=>{console.error('shot timeout');win?.destroy();server?.kill('SIGTERM');app.exit(1);},150000);

async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(PORT+' occupied')));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');
 server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'service');
 await app.whenReady();
 win=new BrowserWindow({show:true,width:1280,height:820,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const ev=code=>win.webContents.executeJavaScript(code,true);
 await win.loadURL(ORIGIN);
 await until(()=>ev('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await wait(900);
 await ev(`(()=>{const now=Date.now();
  state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];
  state.conversations=[{id:'shot-conv',title:'梳理 AI 工作站需求',workspace:'科研',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now,messages:[
   {id:'shot-agent',role:'agent',at:now,runId:'shot-run',text:'# 验收清单\\n\\n- 核心链路：对话 → 文档 → 编辑 → 保存\\n- 边界：同一条回复只存一次，原文不改写\\n\\n详见 docs/harness-parity.md。'}
  ]}];
  state.currentConversationId='shot-conv';
  state.agentRuns=[{id:'shot-run',status:'completed',startedAt:now-96000,finishedAt:now,goal:'整理验收清单',conversationId:'shot-conv',steps:[],activities:[]}];
  state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  normalizeStateShape(state);state.ui.inspectorOpen=false;state.ui.theme=THEME;save();applyUiPreferences();showView('agent','持续对话');renderAll();})()`);
 await wait(900);
 // 首次运行引导浮层会遮挡正文区（改 state 关不掉，它在页面加载时启动）——移除节点后再拍。
 await ev(`(()=>{const layer=document.querySelector('#onboardingLayer');if(layer)layer.remove();})()`);
 const hasButton=await ev(`!!document.querySelector('[data-save-note="shot-agent"]')`);
 if(!hasButton) throw Error('未渲染出「存为文档」入口');
 await ev(`document.querySelector('[data-save-note="shot-agent"]').click()`);
 await until(()=>ev(`document.querySelector('#previewContent .note-document')?.dataset.mode==='edit'`),'editor edit mode');
 await wait(900);
 const shot=await win.webContents.capturePage();
 fs.writeFileSync(path.join(OUT,NAME),shot.toPNG());
 const info=await ev(`(()=>{const n=state.notes.find(x=>x.sourceMessageId==='shot-agent');const m=document.querySelector('#previewContent .note-document');return JSON.stringify({notes:state.notes.length,kind:n?n.kind:null,title:n?n.title:null,mode:m?m.dataset.mode:null,toolbar:m?m.querySelector('.note-document-toolbar')?.textContent:null});})()`);
 console.log('SHOT OK', info);
 console.log('TEMP', TEMP);
}
run().then(()=>{clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');app.exit(0);})
 .catch(error=>{console.error('SHOT FAILED',error.message);console.error('QA store retained:',TEMP);clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');app.exit(1);});
