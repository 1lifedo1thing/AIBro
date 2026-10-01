const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../app/document-images.js'), 'utf8');
const gate = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function fixture(options={}) {
  const state={notes:[{id:'n',title:'Note',content:'original',projectId:'p'}],projects:[{id:'p'}],imports:[]};
  let saves=0,requests=0;
  const result={id:'docimg_abc',url:'/__files/docimg_abc',name:'photo.png',mimeType:'image/png',size:3,projectId:'p',importOrigin:{kind:'document-image',noteId:'n'}};
  const env={Uint8Array,console,btoa:value=>Buffer.from(value,'binary').toString('base64'),fetch:async()=>{requests++; if(options.fetch) return options.fetch(result); return {ok:true,json:async()=>result};}};
  vm.createContext(env);vm.runInContext(source,env);
  const api=env.DocumentImages;
  api.init({getState:()=>state,save:async()=>{saves++;return options.save?.(state)??true;},canUploadNote:()=>!options.private,canAccessImage:options.canAccessImage});
  const file={name:'photo.png',size:3,type:'image/png',arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};
  return {api,state,result,file,get saves(){return saves;},get requests(){return requests;}};
}
test('image reference is withheld until durable import acknowledgement, note body remains untouched',async()=>{
  const held=gate(),h=fixture({save:()=>held.promise});let settled=false;
  const task=h.api.uploadNote('n',h.file).then(value=>{settled=true;return value;});
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(h.state.imports.length,1);assert.equal(settled,false);assert.equal(h.state.notes[0].content,'original');
  held.resolve(true);assert.equal((await task).url,'/__files/docimg_abc');assert.equal(h.saves,1);
});
test('failed image metadata save removes only this provisional entry and keeps later independent imports',async()=>{
  const h=fixture({save:state=>{state.imports.push({id:'independent'});throw Error('disk full');}});
  await assert.rejects(h.api.uploadNote('n',h.file),/disk full/);
  assert.deepEqual(h.state.imports.map(x=>x.id),['independent']);assert.equal(h.state.notes[0].content,'original');
});
test('late upload after project deletion is never inserted or registered in another owner',async()=>{
  const held=gate(),h=fixture({fetch:async result=>{await held.promise;return {ok:true,json:async()=>result};}});
  const task=h.api.uploadNote('n',h.file);for(let i=0;i<8;i++)await Promise.resolve();
  h.state.projects[0].archived=true;held.resolve();await assert.rejects(task,/不可用/);
  assert.equal(h.state.imports.length,0);assert.equal(h.saves,0);
});
test('late acknowledgement cannot grant a new project ownership of an old image',async()=>{
  const held=gate(),h=fixture({save:()=>held.promise});const task=h.api.uploadNote('n',h.file);
  for(let i=0;i<10;i++)await Promise.resolve();h.state.projects.push({id:'other'});h.state.notes[0].projectId='other';held.resolve(true);
  await assert.rejects(task,/已不可用|归属已变化/);assert.equal(h.state.notes[0].content,'original');
});
test('private context rejects before reading or uploading; oversized and unsupported files are explicit',async()=>{
  const h=fixture({private:true});await assert.rejects(h.api.uploadNote('n',h.file),/私密/);assert.equal(h.requests,0);
  await assert.rejects(h.api.encodeFile({...h.file,size:17*1024*1024}),/16 MiB/);
  await assert.rejects(h.api.encodeFile({...h.file,type:'image/svg+xml'}),/PNG/);
});
test('valid repeated image reuses the existing import but never revives a retired record',async()=>{
  const h=fixture();await h.api.uploadNote('n',h.file);await h.api.uploadNote('n',h.file);assert.equal(h.state.imports.length,1);
  h.state.imports[0].archived=true;await assert.rejects(h.api.uploadNote('n',h.file),/记录已变化/);
});
test('read resolver validates image ownership, scope, duplicate identity and active lifecycle',async()=>{
  const h=fixture();await h.api.uploadNote('n',h.file);assert.equal(h.api.resolveNote('n','/__files/docimg_abc'),'/__files/docimg_abc');
  assert.equal(h.api.resolveNote('n','https://example.com/photo.png'),'');
  h.state.imports[0].importOrigin.noteId='other';assert.equal(h.api.resolveNote('n','/__files/docimg_abc'),'');
  h.state.notes[0].sourceAttachmentIds=['docimg_abc'];assert.equal(h.api.resolveNote('n','/__files/docimg_abc'),'/__files/docimg_abc');
  h.state.imports.push({...h.state.imports[0]});assert.equal(h.api.resolveNote('n','/__files/docimg_abc'),'');
});
test('inline parser preserves escaped alt, angled spaces, nested path parentheses and title syntax',()=>{
 const h=fixture();
 for(const [markdown,url,alt] of [
  ['![a\\]b](/__files/docimg_abc)','/__files/docimg_abc','a]b'],
  ['![photo](<assets/a b.png> "caption")','assets/a b.png','photo'],
  ['![p](assets/a(1).png)','assets/a(1).png','p']]) {
   const parsed=h.api.inlineImage(markdown+' tail');assert.equal(parsed.url,url);assert.equal(parsed.alt,alt);assert.equal(parsed.length,markdown.length);
 }
 for(const text of ['![x](bad(thing.png)','![x](x.png "unclosed)','![x](<bad\nname>)'])assert.equal(h.api.inlineImage(text),null);
});
test('portable export detects inline and reference images but excludes fenced/inline code and escaped examples',()=>{
 const h=fixture();
 for(const content of ['![a](/__files/x)','![a][p]\n[p]: /__files/x','![p]\n[p]: /__files/x'])assert.equal(h.api.hasImages(content),true);
 for(const content of ['```md\n![a](/__files/x)\n```','`![a](/__files/x)`','\\![a](/__files/x)'])assert.equal(h.api.hasImages(content),false);
 assert.equal(h.api.inlineImage('![1.00](/__files/x "图示.png")').alt,'图示.png');
});
test('moving an image away from its note prevents displaying a stale canonical reference',async()=>{
 const h=fixture();await h.api.uploadNote('n',h.file);h.state.imports[0].projectId='elsewhere';
 assert.equal(h.api.resolveNote('n','/__files/docimg_abc'),'');
});

test('literal unmatched backticks never hide inline or reference images from portable export',()=>{
 const h=fixture();
 for(const content of [
  'Literal ` unmatched\n![figure](/__files/img)',
  'Literal ` unmatched ![figure](/__files/img)',
  'Literal ` unmatched\n![figure][asset]\n\n[asset]: /__files/img',
 ])assert.equal(h.api.hasImages(content),true,content);
 // Paired runs still mask code, including a multi-line span, while an unmatched
 // run of a different length cannot borrow that span's closing delimiter.
 for(const content of ['`code\n![figure](/__files/img)`','``code ` ![figure](/__files/img)``'])assert.equal(h.api.hasImages(content),false,content);
 assert.equal(h.api.hasImages('`` unmatched `code` ![figure](/__files/img)'),true);
});
