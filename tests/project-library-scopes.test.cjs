'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Library=require('../app/project-library.js');
const content={id:'source',_type:'import',name:'项目记录',folderPath:'资料/课件'};
const note={id:'note',_type:'note',title:'每日记录',folderPath:'资料/课件'};
const daily={id:'daily',_type:'note',projectMemoryType:'daily',folderPath:'记录/每日'};
const plan={id:'plan',_type:'note',projectMemoryType:'plan',folderPath:'记录/计划'};
const long={id:'long',_type:'note',projectMemoryType:'long',folderPath:'记录/长期'};
const records=[content,note,daily,plan,long];
const ids=model=>model.records.map(item=>item.id);

test('default scope classifies only exact typed project-memory notes and never guesses from names or folders',()=>{
 const variants=[...records,{id:'unknown',_type:'note',projectMemoryType:'weekly',folderPath:'记录/每日'},
  {id:'case',_type:'note',projectMemoryType:'Daily'},{id:'space',_type:'note',projectMemoryType:'daily '},
  {id:'import-marker',_type:'import',projectMemoryType:'daily'},{id:'untyped',projectMemoryType:'daily'},
  Object.assign(Object.create({_type:'note',projectMemoryType:'daily'}),{id:'inherited'})];
 const before=JSON.stringify(variants),ui={},model=Library.scopeModel(variants,ui,'p');
 assert.equal(model.scope,'content');assert.deepEqual(model.counts,{content:8,records:3,all:11});
 assert.deepEqual(ids(model),['source','note','unknown','case','space','import-marker','untyped','inherited']);
 assert.deepEqual(ids(Library.selectScope(ui,'p','records',variants)),['daily','plan','long']);
 assert.deepEqual(ids(Library.selectScope(ui,'p','all',variants)),variants.map(item=>item.id));
 assert.equal(JSON.stringify(variants),before);assert.equal(model.records[0],content,'Filtering preserves the original record identity');
});

test('legacy record-only folder restores records once while shared, missing and root locations default to content',()=>{
 const ui={projectLibraryFolders:{p:'记录/每日'},projectLibraryExpansion:{p:{'记录':false}}},before=JSON.stringify(ui);
 const migrated=Library.scopeModel(records,ui,'p');assert.equal(migrated.scope,'records');assert.equal(migrated.selected,'记录/每日');assert.deepEqual(migrated.expansion,{'记录':false});assert.equal(JSON.stringify(ui),before,'Reading does not save a migration');
 for(const folder of [null,'已移除','资料/课件'])assert.equal(Library.scopeModel(records,{projectLibraryFolders:{p:folder}},'p').scope,'content');
 const shared=[...records,{id:'ordinary',_type:'note',folderPath:'记录/每日'}];assert.equal(Library.scopeModel(shared,ui,'p').scope,'content');
 const emptyFolder=[{id:'m',_type:'note',projectMemoryType:'daily'},{id:'s',_type:'import',folderPath:'资料'}];assert.equal(Library.scopeModel(emptyFolder,{projectLibraryFolders:{p:''}},'p').scope,'records');
 const explicit={...ui,projectLibraryScopes:{p:'content'}};assert.equal(Library.scopeModel(records,explicit,'p').scope,'content');assert.equal(Library.scopeModel(records,explicit,'p').selected,null);
});

test('all three scopes preserve independent selected directories and expansion for two projects',()=>{
 const ui={otherSetting:'unchanged'};
 Library.rememberLocation(ui,'a','content',{selected:'资料/课件',expansion:{'资料':false}});
 assert.equal(Library.selectScope(ui,'a','records',records).selected,null,'New scope starts at root rather than inheriting current mirror');
 Library.rememberLocation(ui,'a','records',{selected:'记录/每日',expansion:{'记录':false}});
 assert.equal(Library.selectScope(ui,'a','all',records).selected,null);
 Library.rememberLocation(ui,'a','all',{selected:'记录/计划',expansion:{'记录':true,'资料':false}});
 Library.rememberLocation(ui,'b','content',{selected:'资料',expansion:{'资料':true}});
 Library.selectScope(ui,'b','records',records);Library.rememberLocation(ui,'b','records',{selected:'记录/长期',expansion:{'记录':true}});
 for(const [scope,selected,expansion] of [['content','资料/课件',{'资料':false}],['records','记录/每日',{'记录':false}],['all','记录/计划',{'记录':true,'资料':false}]]){
  const result=Library.selectScope(ui,'a',scope,records);assert.equal(result.scope,scope);assert.equal(result.selected,selected);assert.deepEqual(result.expansion,expansion);
  assert.equal(ui.projectLibraryScopes.a,scope);assert.equal(ui.projectLibraryFolders.a,selected);assert.deepEqual(ui.projectLibraryExpansion.a,expansion);
 }
 assert.equal(Library.scopeModel(records,ui,'b').selected,'记录/长期');assert.equal(Library.selectScope(ui,'b','content',records).selected,'资料');assert.equal(ui.otherSetting,'unchanged');
});

test('stored scope location outranks compatibility mirrors and deleted locations safely return the current scope root',()=>{
 const ui={projectLibraryScopes:{p:'records'},projectLibraryFolders:{p:'资料/课件'},projectLibraryLocations:{p:{records:{folder:'记录/每日',expansion:{'记录':false}},content:{folder:'资料/课件',expansion:{'资料':true}}}}};
 assert.equal(Library.scopeModel(records,ui,'p').selected,'记录/每日');
 const remaining=records.filter(item=>item!==daily);assert.equal(Library.scopeModel(remaining,ui,'p').scope,'records');assert.equal(Library.scopeModel(remaining,ui,'p').selected,null);
 const repaired=Library.selectScope(ui,'p','records',remaining);assert.equal(repaired.selected,null);assert.equal(ui.projectLibraryLocations.p.records.folder,null);assert.equal(ui.projectLibraryFolders.p,null);
 assert.equal(Library.selectScope(ui,'p','content',remaining).selected,'资料/课件');
});

test('scope helpers preserve literal record paths and isolate mutable location copies',()=>{
 const item={id:'literal',_type:'note',folderPath:'//<img src=x>/__proto__/constructor//'},rows=[item],before=JSON.stringify(rows),expansion=JSON.parse('{"<img src=x>":false,"__proto__":true,"bad":"true"}'),ui={};
 Library.rememberLocation(ui,'p','content',{selected:'/<img src=x>/__proto__/constructor/',expansion});expansion['<img src=x>']=true;
 const model=Library.scopeModel(rows,ui,'p');assert.equal(model.selected,'<img src=x>/__proto__/constructor');assert.equal(model.expansion['<img src=x>'],false);assert.equal(Object.hasOwn(model.expansion,'__proto__'),true);assert.equal(Object.hasOwn(model.expansion,'bad'),false);
 model.expansion['<img src=x>']=true;assert.equal(ui.projectLibraryLocations.p.content.expansion['<img src=x>'],false);assert.equal(JSON.stringify(rows),before);assert.equal(item.folderPath,'//<img src=x>/__proto__/constructor//');
});

test('project keys and inherited UI containers cannot pollute prototypes or leak another project location',()=>{
 const ui=Object.create({projectLibraryScopes:{inherited:'records'},projectLibraryFolders:{inherited:'记录/每日'}});
 assert.equal(Library.scopeModel(records,ui,'inherited').scope,'content');
 for(const id of ['__proto__','constructor','prototype']){
  Library.rememberLocation(ui,id,'records',{selected:'记录/每日',expansion:JSON.parse('{"__proto__":false,"记录":true}')});
  assert.equal(Object.hasOwn(ui.projectLibraryScopes,id),true);assert.equal(Library.scopeModel(records,ui,id).scope,'records');assert.equal(Library.scopeModel(records,ui,id).selected,'记录/每日');
  assert.equal(Library.selectScope(ui,id,'content',records).selected,null);
 }
 assert.equal({}.records,undefined);assert.equal({}.folder,undefined);assert.equal(Object.getPrototypeOf(ui.projectLibraryLocations),Object.prototype);
 const before=JSON.stringify(ui);assert.equal(Library.selectScope(ui,'__proto__','invalid',records).scope,'content');assert.equal(JSON.stringify(ui),before);
});

test('mounted range controls report intent with project identity while the caller owns filtering and persistence',()=>{
 const mounts=new Map(),calls=[],ctx={HalaskaUI:{mount(host,component,props){mounts.set(host,{component,props});},unmount(host){mounts.delete(host);}}};vm.runInNewContext(fs.readFileSync(require.resolve('../app/project-library.js'),'utf8'),ctx);
 const host={},crumb={},model=Library.scopeModel(records,{},'p');
 const mounted=ctx.ProjectLibrary.mount(host,{projectId:'p',records:model.records,selected:model.selected,expansion:model.expansion,scope:model.scope,counts:model.counts,breadcrumbHost:crumb,onScope:(...args)=>calls.push(args)});
 const first=mounts.get(host).props;assert.equal(first.scope,'content');assert.equal(first.counts.records,3);assert.equal(first.model.count,2);first.onScope('records');
 assert.equal(calls.length,1);assert.equal(calls[0][0],'records');assert.equal(calls[0][1].projectId,'p');assert.equal(mounts.get(host).props,first,'Scope intent alone does not replace visible data');
 first.onScope('invalid');first.onScope('content');assert.equal(calls.length,1);
 mounted.update({scope:'records',records:[daily,plan,long]});assert.equal(mounts.get(crumb).props.scope,'records');assert.equal(mounts.get(host).props.model.count,3);
 mounted.update({projectId:'b'});assert.equal(mounts.get(host).props.scope,'content');assert.equal(mounts.get(host).props.model.selected,null);
 mounted.unmount();first.onScope('all');assert.equal(calls.length,1);
});
