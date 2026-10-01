const {test}=require('node:test'),assert=require('node:assert/strict');const R=require('../app/file-review.js');
test('diff reconstructs original and modified text including empty and repeated lines',()=>{for(const [a,b] of [['',''],['','new'],['a\nb\nc','a\nx\nc'],['a\na\nb','a\nb\nb'],['hello\n','hello']]){const rows=R.diff(a,b);assert.equal(rows.filter(x=>x.type!=='add').map(x=>x.text).join('\n'),a);assert.equal(rows.filter(x=>x.type!=='remove').map(x=>x.text).join('\n'),b);}});
test('capture is immutable and groups each modified file once',()=>{const before={notes:[{id:'n',title:'Note',content:'old',updatedAt:1}]},after={notes:[{id:'n',title:'Note',content:'new',updatedAt:2}]};const c=R.capture(before,after,[{type:'note',id:'n'},{type:'note',id:'n'}]);assert.equal(c.length,1);assert.equal(c[0].added,1);after.notes[0].content='later';assert.equal(c[0].after.content,'new');assert.equal(c[0].before.content,'old');});
test('undo refuses later edits, restores exact earlier body and retains revision',()=>{const before={notes:[{id:'n',title:'Note',content:'old',updatedAt:1}]},after={notes:[{id:'n',title:'Note',content:'new',updatedAt:2}]};const c=R.capture(before,after,[{type:'note',id:'n'}])[0];after.notes[0].content='manual';assert.throws(()=>R.undo(after,c));assert.equal(after.notes[0].content,'manual');after.notes[0].content='new';R.undo(after,c,10);assert.equal(after.notes[0].content,'old');assert.equal(after.notes[0].revisionHistory[0].content,'new');assert.ok(c.undoneAt);});
test('new note undo moves note into recoverable trash and leaves originals intact',()=>{const before={notes:[]},after={notes:[{id:'n',title:'Note',content:'new'}],imports:[{id:'pdf'}],links:[{id:'l',sourceId:'n',targetId:'pdf'}]};const c=R.capture(before,after,[{type:'note',id:'n',operation:'created'}])[0];R.undo(after,c);assert.equal(after.notes.length,0);assert.equal(after.trash[0].data.notes[0].content,'new');assert.equal(after.imports.length,1);assert.equal(after.trash[0].data.links.length,1);});
test('pending AI draft is captured separately from the protected main body',()=>{const before={notes:[{id:'n',title:'Note',content:'human'}]},after={notes:[{id:'n',title:'Note',content:'human',aiDraft:{content:'suggestion'}}]};const c=R.capture(before,after,[{type:'note',id:'n',operation:'drafted'}])[0];assert.equal(c.before.content,'human');assert.equal(c.after.content,'human');assert.equal(c.after.aiDraft.content,'suggestion');R.undo(after,c);assert.equal(after.notes[0].content,'human');assert.equal(after.notes[0].aiDraft,undefined);});
test('large documents retain sparse edits instead of presenting unchanged thousands of lines as replaced',()=>{
 for(const repeated of [false,true]){
  const before=Array.from({length:12000},(_,i)=>repeated?'same repeated line':`line ${i}`),after=before.map((line,i)=>i%1000===100?line+' changed':line);
  const rows=R.diff(before.join('\n'),after.join('\n'));
  assert.equal(rows.filter(x=>x.type==='remove').length,12);assert.equal(rows.filter(x=>x.type==='add').length,12);
  assert.deepEqual(rows.filter(x=>x.type!=='add').map(x=>x.text),before);assert.deepEqual(rows.filter(x=>x.type!=='remove').map(x=>x.text),after);
  assert.deepEqual(rows.filter(x=>x.old!==null).map(x=>x.old),before.map((_,i)=>i+1));assert.deepEqual(rows.filter(x=>x.next!==null).map(x=>x.next),after.map((_,i)=>i+1));
 }
});
test('large sparse insertions and deletions survive both ends and empty repeated lines',()=>{
 let seed=7;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let sample=0;sample<24;sample++){
  const before=Array.from({length:1600},(_,i)=>sample%2?String(i):['','alpha','beta'][i%3]),after=[...before];
  for(let edit=0;edit<20;edit++){const at=Math.floor(random()*after.length);after.splice(at,Math.floor(random()*3),...Array.from({length:Math.floor(random()*3)},(_,i)=>`new ${edit} ${i}`));}
  after.unshift('new beginning');after.push('new ending');const rows=R.diff(before.join('\n'),after.join('\n'));
  assert.deepEqual(rows.filter(x=>x.type!=='add').map(x=>x.text),before);assert.deepEqual(rows.filter(x=>x.type!=='remove').map(x=>x.text),after);
 }
});
test('bounded fallback for large unrelated files is lossless',()=>{
 const before=Array.from({length:2500},(_,i)=>`old ${i}`),after=Array.from({length:2700},(_,i)=>`new ${i}`),rows=R.diff(before.join('\n'),after.join('\n'));
 assert.deepEqual(rows.filter(x=>x.type!=='add').map(x=>x.text),before);assert.deepEqual(rows.filter(x=>x.type!=='remove').map(x=>x.text),after);
});
