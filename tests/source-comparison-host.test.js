const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const CitationEvidence=require('../app/citation-evidence');
const code=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const start=code.indexOf('async function openSourceComparison('),end=code.indexOf('\nfunction refreshComparisonReaderEntry(',start);
assert.ok(start>=0&&end>start);
function fixture(){
 const opened=[],errors=[];let privateMode=false,leave=()=>true;
 const module={open:(refs,options)=>{opened.push({refs,options});return true;},reopen:id=>{opened.push({noteId:id});return true;}};
 const context=vm.createContext({state:{},storageHydrated:true,serverConflict:false,SourceComparison:module,
  window:{CitationEvidence,SourceComparison:module,PrivateMode:{isOn:()=>privateMode}},toast:message=>errors.push(message),beforePreviewLeave:()=>leave()});
 const guardStart=code.indexOf('function collectionReferencesAllowed('),guardEnd=code.indexOf('\nasync function requestNoteMerge(',guardStart);
 assert.ok(guardStart>=0&&guardEnd>guardStart);
 vm.runInContext(code.slice(guardStart,guardEnd),context);
 vm.runInContext(code.slice(start,end),context);
 return {context,opened,errors,setPrivate:value=>{privateMode=value;},setLeave:fn=>{leave=fn;}};
}
test('source comparison uses the existing editor leave guard before opening or reopening',async()=>{
 const f=fixture();f.setLeave(()=>false);
 assert.equal(await f.context.openSourceComparison([{kind:'note',id:'n'}]),false);assert.equal(f.opened.length,0);
 f.setLeave(()=>true);assert.equal(await f.context.openSourceComparison(undefined,{noteId:'comparison-note'}),true);
 assert.deepEqual(f.opened,[{noteId:'comparison-note'}]);
});
test('comparison rechecks private mode and conflict after an asynchronous editor decision',async()=>{
 for(const change of [f=>f.setPrivate(true),f=>{f.context.serverConflict=true;},f=>{f.context.storageHydrated=false;}]){
  const f=fixture();let release;f.setLeave(()=>new Promise(resolve=>{release=resolve;}));
  const opened=f.context.openSourceComparison([{kind:'note',id:'n'}]);change(f);release(true);
  assert.equal(await opened,false);assert.equal(f.opened.length,0);assert.equal(f.errors.length,1);
 }
});
test('comparison availability errors stay recoverable and do not open a partial dialog',async()=>{
 const f=fixture();f.context.window.SourceComparison=null;
 assert.equal(await f.context.openSourceComparison(),false);assert.match(f.errors[0],/尚未就绪/);assert.equal(f.opened.length,0);
 f.context.window.SourceComparison=f.context.SourceComparison;f.context.SourceComparison.open=()=>{throw Error('Source was deleted');};
 assert.equal(await f.context.openSourceComparison([{kind:'note',id:'gone'}]),false);assert.equal(f.errors.at(-1),'Source was deleted');
});
