// Host contract fixture: real CodeMirror transactions/history, not DOM input.
// Full production PM/CM DOM gestures are exercised by document-editors-smoke.
const path = require('node:path'), Module = require('node:module');
const {buildSync}=require('esbuild');
const {undo,redo,undoDepth,redoDepth}=require('@codemirror/commands');
function load(name){const filename=path.resolve(__dirname,'../app/editor',name),mod=new Module(filename,module);mod.filename=filename;mod.paths=module.paths;mod._compile(buildSync({entryPoints:[filename],write:false,bundle:true,format:'cjs',platform:'node',external:['@codemirror/*'],loader:{'.css':'text'},logLevel:'silent'}).outputFiles[0].text,filename);return mod.exports}
const {create}=load('edit-history.js'),{createSourceState,replaceSourceValue,rawDocument}=load('source-editor.js');
function augment(handle,config){let state=createSourceState(config.value),disabled=false;const token={},originalSet=handle.setValue.bind(handle),originalDisabled=handle.setDisabled.bind(handle);
 const notify=()=>{config.onHistoryChange?.();config.onChange?.(state.field(rawDocument).raw)};
 const target={get state(){return state},dispatch(tr){state=tr.state;notify()}};
 Object.assign(handle,{
  getValue:()=>state.field(rawDocument).raw,
  setValue(value,options={}){if(handle.isComposing())return false;originalSet(value,options);state=options.addToHistory?replaceSourceValue(state,value).state:createSourceState(value);return true},
  setDisabled(value){disabled=!!value;originalDisabled(value)},
  captureHistory:()=>({owner:token,state,value:state.field(rawDocument).raw,undo:undoDepth(state),redo:redoDepth(state)}),
  restoreHistory(saved){if(saved.owner!==token||handle.isComposing())return false;state=saved.state;return true},
  historyDepth:()=>({undo:undoDepth(state),redo:redoDepth(state)}),
  undo:()=>!disabled&&undo(target),redo:()=>!disabled&&redo(target),
  type(value){if(disabled)throw Error('disabled');state=replaceSourceValue(state,value).state;notify()},
 });return handle;
}
module.exports={create,augment};
