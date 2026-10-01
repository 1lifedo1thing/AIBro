/* Reproducible renderer measurements. Synthetic workspace, isolated profile/server, no model calls. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-workbench-perf-'));
const label = process.argv[2] || 'current';
app.setPath('userData', path.join(TEMP, 'profile'));
let server, win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 300; n++) { if (await fn()) return; await pause(50); } throw Error('Timed out'); }
const watchdog = setTimeout(() => { server?.kill(); app.exit(1); }, 120000);
async function run() {
 const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const p = socket.address().port; socket.close(() => resolve(p)); }); });
 const origin = `http://127.0.0.1:${port}`, log = fs.openSync(path.join(TEMP, 'server.log'), 'a');
 server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: path.join(TEMP, 'store') }, stdio: ['ignore', log, log] });
 await until(() => new Promise(resolve => http.get(origin + '/__health', r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false))));
 await app.whenReady();
 win = new BrowserWindow({ show: false, width: 1440, height: 980, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => cb({ cancel: !details.url.startsWith(origin + '/') }));
 const evaluate = code => win.webContents.executeJavaScript(code, true);
 await win.loadURL(origin); await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'));
 await evaluate(`WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};` + fs.readFileSync(path.join(ROOT, 'tests/fixtures/agent-workbench.js'), 'utf8'));
 const result = await evaluate(`(async()=>{
  const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const measure=async(fn,n=5)=>{const samples=[];for(let i=0;i<n;i++){await frames();const begin=performance.now();fn();document.body.getBoundingClientRect();samples.push(performance.now()-begin);}return {medianMs:+samples.slice().sort((a,b)=>a-b)[Math.floor(n/2)].toFixed(2),samplesMs:samples.map(x=>+x.toFixed(2))};};
  const before=Array.from({length:12000},(_,i)=>'export const value'+i+' = '+i+';').join('\\n');
  const after=before.split('\\n').map((line,i)=>i%1000===100?line.replace(' = ',' = updated + '):line).join('\\n');
  let rows;const diff=await measure(()=>{rows=FileReview.diff(before,after)});
  const stats=ReviewWorkbench.stats(rows);const host=document.createElement('div');host.style.cssText='position:fixed;inset:20px;width:1000px;height:700px;overflow:auto;background:var(--bg)';document.body.append(host);
  const diffView=await measure(()=>ReviewWorkbench.document(host,{path:'src/large.js',before,after},{mode:'diff',split:false}));
  const visibleRows=host.querySelectorAll('.diff-line').length,renderedNodes=host.querySelectorAll('*').length;
  const splitView=await measure(()=>ReviewWorkbench.document(host,{path:'src/large.js',before,after},{mode:'diff',split:true}));
  const sourceView=await measure(()=>ReviewWorkbench.document(host,{path:'src/large.js',before,after},{mode:'source',split:false}));
  host.querySelector('.review-source>.review-more').click();
  const pageLines=[...host.querySelectorAll('.review-source>.diff-line code')].map(node=>node.textContent);
  const sourcePagination={shown:pageLines.length,keepsSourceOrder:pageLines.join('\\n')===after.split('\\n').slice(0,800).join('\\n'),firstLine:pageLines[0],lastLine:pageLines.at(-1)};
  const files=Array.from({length:2000},(_,i)=>({id:'f'+i,path:'packages/pkg'+(i%50)+'/src/group'+(i%9)+'/file'+i+'.js',added:1,removed:1}));
  let treeController;const tree=await measure(()=>{treeController=ReviewWorkbench.create(host,{key:'perf-tree',files,onSelect(){}})},3);
  const selectionObserver=new MutationObserver(()=>{});selectionObserver.observe(host,{attributes:true,subtree:true,attributeFilter:['aria-pressed']});treeController.select(files[1000]);const selectionAttributeWrites=selectionObserver.takeRecords().length;selectionObserver.disconnect();
  const input=host.querySelector('input');let count=0;const treeFilter=await measure(()=>{input.value=++count%2?'group8/file':'pkg4';input.dispatchEvent(new Event('input'));});
  host.remove();
  const now=Date.now(),active=currentConversation();
  state.conversations=[active,...Array.from({length:199},(_,c)=>({id:'perf-c'+c,title:'性能基准对话 '+c,workspace:'日常',messages:Array.from({length:80},(_,m)=>({id:'perf-m'+c+'-'+m,role:m%2?'agent':'user',text:'项目记录 '+c+' '+m+' '+('可追溯执行与资料整理。'.repeat(15)),at:now-m*1000})),createdAt:now-c*1000}))];
  state.notes.push(...Array.from({length:1000},(_,i)=>({id:'perf-note'+i,title:'性能基准文档 '+i,workspace:'日常',content:('资料内容 '+i+' 可回看执行过程。\\n').repeat(100),tags:['perf'],updatedAt:now})));
  const search=await measure(()=>searchEntities('不存在的基准关键字'));
  const renderer=await measure(()=>renderAll(),3);
  const timelineMessage={id:'perf-long',role:'agent',text:'所有过程可回看。',at:now,runStatus:'completed',activities:Array.from({length:2000},(_,i)=>({id:'perf-a'+i,kind:'tool',name:'read_file',text:'docs/note'+i+'.md',status:'completed',at:now-4000+i,updatedAt:now-3999+i}))};
  const timeline=await measure(()=>{const host=document.createElement('div');document.body.append(host);renderMessage(timelineMessage,host);host.getBoundingClientRect();host.remove();},3);
  const saveBlocking=await measure(()=>save(),3);let begin=performance.now();await saveDocumentDurably();const durableSaveMs=+(performance.now()-begin).toFixed(2);
  begin=performance.now();const persisted=await (await fetch('/__state',{cache:'no-store'})).json();const loadMs=+(performance.now()-begin).toFixed(2);
  if(persisted.conversations.length!==200||persisted.notes.length!==1002)throw Error('Synthetic workspace failed storage roundtrip');
  return {fixture:{lines:12000,actualChangedLines:12,files:2000,conversations:200,messagesPerConversation:80,notes:1000,toolActivities:2000,stateBytes:new Blob([JSON.stringify(state)]).size},diff:{...diff,...stats,totalRows:rows.length},diffView,splitView,sourceView,sourcePagination,visibleRows,renderedNodes,tree,treeFilter,selectionAttributeWrites,search,renderer,timeline,storage:{saveBlocking,durableSaveMs,loadMs,conversations:persisted.conversations.length,notes:persisted.notes.length}};
 })()`);
 result.label = label; result.runtime = process.versions; result.modelCalls = 0; result.isolatedDataDirectory = TEMP;
 const output = path.join(ROOT, 'test-results', 'performance-20260923');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,label+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
run().then(()=>{clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(0);}).catch(error=>{console.error(error);clearTimeout(watchdog);win?.destroy();server?.kill();app.exit(1);});
