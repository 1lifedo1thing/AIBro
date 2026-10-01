'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), Module = require('node:module');
const { buildSync } = require('esbuild');
const { undo, redo, undoDepth, redoDepth, isolateHistory } = require('@codemirror/commands');
const { Transaction, EditorSelection } = require('@codemirror/state');
function load(file) {
  const filename=path.resolve(__dirname,'../app/editor',file), loaded=new Module(filename,module); loaded.filename=filename; loaded.paths=module.paths;
  loaded._compile(buildSync({entryPoints:[filename],write:false,bundle:true,format:'cjs',platform:'node',external:['@codemirror/*'],loader:{'.css':'text'},logLevel:'silent'}).outputFiles[0].text,filename); return loaded.exports;
}
const {create}=load('edit-history.js'),{createSourceState,rawDocument}=load('source-editor.js');
function fixture(raw='A\r\nB\n') {
  const history=create(),views={};let mode='edit';
  function engine(kind) {
    let state=createSourceState(raw),composing=false,busy=false,disabled=false;const token={};
    const target={get state(){return state},dispatch(tr){state=tr.state;history.changed(kind)}};
    const handle={
      getValue:()=>state.field(rawDocument).raw,
      setValue(value){state=createSourceState(value);return true},
      captureHistory:()=>({owner:token,state,value:handle.getValue(),undo:undoDepth(state),redo:redoDepth(state)}),
      restoreHistory(saved){if(saved.owner!==token||composing||busy)return false;state=saved.state;return true},
      historyDepth:()=>({undo:undoDepth(state),redo:redoDepth(state)}),
      undo:()=>!disabled&&undo(target),redo:()=>!disabled&&redo(target),isComposing:()=>composing,isImageBusy:()=>busy,
      type(changes,{group=false}={}) {state=state.update({changes,annotations:[Transaction.userEvent.of('input.type'),...(group?[]:[isolateHistory.of('full')])]}).state;history.changed(kind)},
      select(pos){state=state.update({selection:EditorSelection.single(pos)}).state},
      selection:()=>state.selection.main.head,compose:value=>composing=value,busy:value=>busy=value,disable:value=>disabled=value,
    };history.attach(kind,handle);views[kind]=handle;return handle;
  }
  engine('edit');engine('rich');history.activate('edit',raw);
  return {history,views,get mode(){return mode},get value(){return views[mode].getValue()},
    switch(kind){const value=views[mode].getValue();assert.equal(history.activate(kind,value),true);mode=kind},
    move(direction){return history.move(direction,next=>{mode=next.mode;assert.equal(next.value,views[mode].getValue())})}
  };
}
test('native fine-grained undo/redo traverses alternating modes without adding mode-switch steps',()=>{
 const f=fixture(),a=f.views.edit,b=f.views.rich;
 a.type({from:0,to:1,insert:'A1'});const first=f.value;a.type({from:3,to:4,insert:'B1'});const second=f.value;
 f.switch('rich');b.type({from:0,to:2,insert:'A2'});const third=f.value;b.type({from:3,to:5,insert:'B2'});const fourth=f.value;
 f.switch('edit');assert.equal(f.value,fourth);
 for(const [mode,value]of[['rich',third],['rich',second],['edit',first],['edit','A\r\nB\n']]){assert.equal(f.move('undo'),true);assert.equal(f.mode,mode);assert.equal(f.value,value)}
 assert.equal(f.move('undo'),false);
 for(const value of[first,second,third,fourth]){assert.equal(f.move('redo'),true);assert.equal(f.value,value)}assert.equal(f.move('redo'),false);
});
test('merely viewing modes preserves selected native history and exact BOM mixed endings',()=>{
 const raw='\ufeffA\r\nB\rC\n',f=fixture(raw);f.views.edit.type({from:0,to:1,insert:'Aa'});f.views.edit.select(2);
 for(let i=0;i<3;i++){f.switch('rich');f.switch('edit')}
 assert.equal(f.views.edit.selection(),2);assert.equal(f.history.snapshot().segments,1);assert.equal(f.move('undo'),true);assert.equal(f.value,raw);
});
test('native typing grouping remains native rather than one giant snapshot per mode',()=>{
 const f=fixture('A');f.views.edit.type({from:1,insert:'b'},{group:true});f.views.edit.type({from:2,insert:'c'},{group:true});
 assert.equal(f.views.edit.historyDepth().undo,1);f.switch('rich');assert.equal(f.move('undo'),true);assert.equal(f.value,'A');
});
test('editing another mode after undo discards the abandoned redo path including older native redo',()=>{
 const f=fixture('A');f.views.edit.type({from:1,insert:'1'});f.views.edit.type({from:2,insert:'2'});f.switch('rich');f.views.rich.type({from:3,insert:'3'});
 f.move('undo');f.move('undo');assert.equal(f.value,'A1');f.switch('rich');f.views.rich.type({from:2,insert:'new'});
 assert.equal(f.move('redo'),false);assert.equal(f.move('undo'),true);assert.equal(f.value,'A1');assert.equal(f.move('undo'),true);assert.equal(f.value,'A');
 assert.equal(f.move('redo'),true);assert.equal(f.value,'A1');assert.equal(f.move('redo'),true);assert.equal(f.value,'A1new');assert.equal(f.move('redo'),false);
});
test('composition and pending uploads block history without losing the committed transaction',()=>{
 const f=fixture('A');f.views.edit.compose(true);f.views.edit.type({from:1,insert:'中文'});assert.equal(f.move('undo'),false);f.views.edit.compose(false);f.views.edit.busy(true);assert.equal(f.history.activate('rich',f.value),false);assert.equal(f.move('undo'),false);f.views.edit.busy(false);assert.equal(f.move('undo'),true);assert.equal(f.value,'A');
});
test('explicit external reset drops old histories while fresh edits remain undoable and disposal releases handles',()=>{
 const f=fixture('A');f.views.edit.type({from:1,insert:'old'});f.history.clear();f.views.edit.setValue('external');f.views.edit.type({from:8,insert:'new'});
 assert.equal(f.move('undo'),true);assert.equal(f.value,'external');assert.equal(f.move('undo'),false);f.history.dispose();assert.equal(f.move('redo'),false);assert.equal(f.history.snapshot().segments,0);
});
test('a disabled native command cannot move timeline cursor or mutate document',()=>{
 const f=fixture('A');f.views.edit.type({from:1,insert:'1'});const snapshot=f.history.snapshot();f.views.edit.disable(true);assert.equal(f.move('undo'),false);assert.deepEqual(f.history.snapshot(),snapshot);assert.equal(f.value,'A1');
});

test('failed cross-segment native undo leaves target projection and history identity unchanged',()=>{
 const f=fixture('A');f.views.edit.type({from:1,insert:'1'});f.switch('rich');f.views.rich.type({from:2,insert:'2'});
 f.switch('edit');f.views.edit.type({from:3,insert:'3'});f.move('undo');f.move('undo');
 // edit now holds the third segment's base A12; the first segment A1 is archived.
 f.views.edit.disable(true);const before=f.views.edit.captureHistory(), timeline=f.history.snapshot();
 assert.equal(f.move('undo'),false);assert.equal(f.views.edit.captureHistory().state,before.state);assert.deepEqual(f.history.snapshot(),timeline);
});
test('retention bounds release only completed earlier segments with one readable notice',()=>{
 const source=fixture('A'),f=source; let notices=0;
 const limited=create({maxSegments:2,maxRetainedCharacters:10,onTrim:()=>notices++});
 for(const mode of ['edit','rich']) limited.attach(mode,f.views[mode]);
 // Use native transactions directly but notify the bounded coordinator.
 let mode='edit',value='A';limited.activate(mode,value);
 for(let n=0;n<7;n++){mode=n%2?'rich':'edit';limited.activate(mode,value);f.views[mode].type({from:value.length,insert:String(n)});value=f.views[mode].getValue();limited.changed(mode)}
 assert.ok(limited.snapshot().segments<=2);assert.equal(notices,1);let undos=0;while(limited.move('undo'))undos++;assert.ok(undos<=2);assert.equal(limited.move('undo'),false);
});
