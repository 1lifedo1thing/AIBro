const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Evidence = require('../app/citation-evidence');
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const state={projects:[{id:'a'},{id:'b'}],ui:{},notes:[{id:'same',projectId:'a',title:'Zulu',content:'BODY_MUST_NOT_REACH_TABLE',updatedAt:30},{id:'a2',projectId:'a',title:'Alpha',updatedAt:10},{id:'b1',projectId:'b',title:'Beta'}],imports:[{id:'same',projectId:'a',name:'Bravo',content:'IMPORT_BODY_NOT_FOR_TABLE',updatedAt:20}],tasks:[],papers:[]};
  const models=new Map(),calls=[],module={exports:{}};
  const node=()=>({dataset:{},isConnected:true,classList:{add(){},remove(){}},replaceChildren(){},querySelector(){return null;}});
  const host={...node(),ownerDocument:{createElement:node,activeElement:null},querySelectorAll(){return[];},addEventListener(){}};
  const sandbox={module,require:()=>Evidence,setTimeout:()=>1,clearTimeout(){},HalaskaUI:{mount(element,name,props){element.dataset.halaskaRoot=name;models.set(name,props);},unmount(element){delete element.dataset.halaskaRoot;}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/collection-ui'),'utf8'),sandbox);
  const api=module.exports;
  api.init({getState:()=>state,save(){},openNote:(id,nav)=>calls.push({kind:'note',id,nav}),openImport:(id,nav)=>calls.push({kind:'import',id,nav}),openProject:id=>calls.push({kind:'project',id}),deleteItems:async refs=>{calls.push({kind:'delete',refs});return false;}});
  const render=(projectId='a',extra={})=>api.render(host,{projectId,types:['note','import','paper'],...extra});
  const table=()=>models.get('LibraryDataTable');
  const anchor=key=>({isConnected:true,closest:()=>({dataset:{cuiKey:key}})});
  return {state,api,render,table,calls,models,anchor};
}
test('controlled table receives public metadata only and typed keys distinguish same ids',()=>{
 const h=harness();h.render();const table=h.table();
 assert.deepEqual(plain(table.rows.map(row=>row.key)),['note:same','import:same','note:a2']);
 assert.doesNotMatch(JSON.stringify(table.rows),/BODY_MUST_NOT_REACH_TABLE|IMPORT_BODY_NOT_FOR_TABLE/);
 table.onToggle('note:same',true);h.table().onSort('name');
 assert.deepEqual(plain(h.table().rows.map(row=>row.key)),['note:a2','import:same','note:same']);
 assert.deepEqual(plain(h.table().selectedKeys),['note:same']);
 h.state.notes.push({id:'inserted',projectId:'a',title:'Aardvark'});h.render();
 assert.deepEqual(plain(h.table().selectedKeys),['note:same']);
 assert.deepEqual(plain(h.state.ui.projectCollectionPreferences.a),{query:'',type:'all',sort:'name',dir:'asc',view:'list'});
 h.table().onToggleAll(true);assert.equal(h.table().selectedKeys.length,4);
 h.table().onToggle('import:same',false);assert.equal(h.table().selectedKeys.includes('note:same'),true);
});
test('scope changes and live privacy revocation deny stale selection, delete and open callbacks',()=>{
 const h=harness();h.render();const stale=h.table();h.render('b');
 stale.onToggle('note:same',true);stale.onSort('name');stale.onOpen('note:same',h.anchor('note:same'));stale.onDelete('note:same');
 assert.deepEqual(h.calls,[]);assert.deepEqual(plain(h.table().selectedKeys),[]);
 h.render('a');const revoked=h.table();h.state.notes[0].private=true;
 revoked.onToggle('note:same',true);revoked.onOpen('note:same',h.anchor('note:same'));revoked.onDelete('note:same');
 assert.deepEqual(h.calls,[]);assert.deepEqual(plain(h.table().selectedKeys),[]);
});
test('opening uses the actual connected typed-row button and filtering clears invisible selection',()=>{
 const h=harness();h.render();const anchor=h.anchor('import:same');h.table().onOpen('import:same',anchor);
 assert.equal(h.calls[0].nav.anchor,anchor);assert.equal(h.calls[0].kind,'import');
 h.table().onOpen('note:same',anchor);assert.equal(h.calls.length,1);
 h.table().onToggle('note:same',true);h.models.get('LibraryToolbar').onQuery('Bravo');
 assert.deepEqual(plain(h.table().selectedKeys),[]);assert.deepEqual(plain(h.table().rows.map(row=>row.key)),['import:same']);
});
test('row deletion reuses controller cancellation and busy guards without losing typed selection',async()=>{
 const h=harness();h.render();h.table().onToggle('note:same',true);
 const pending=h.table().onDelete('import:same');assert.equal(h.table().busy,true);
 h.table().onToggle('note:a2',true);h.table().onOpen('note:same',h.anchor('note:same'));
 await pending;assert.deepEqual(plain(h.table().selectedKeys),['note:same']);
 assert.deepEqual(plain(h.calls),[{kind:'delete',refs:[{type:'import',id:'same'}]}]);
});
test('record scope classifies exact note metadata and excludes private records before counts',()=>{
 const h=harness();h.state.notes.push({id:'memory',title:'Plan',projectId:'a',projectMemoryType:'plan'},{id:'custom',title:'Custom',projectId:'a',projectMemoryType:'other'},{id:'private-memory',title:'Hidden',projectId:'a',projectMemoryType:'daily',private:true});
 h.state.imports[0].projectMemoryType='long';h.render('a',{libraryScope:'records',types:['note']});
 assert.deepEqual(plain(h.table().rows.map(row=>row.key)),['note:memory']);
 h.render('a',{libraryScope:'content'});assert.equal(h.table().rows.some(row=>row.key==='note:memory'),false);
 assert.equal(h.table().rows.some(row=>row.key==='note:custom'),true);assert.equal(h.table().rows.some(row=>row.key==='import:same'),true);
});
