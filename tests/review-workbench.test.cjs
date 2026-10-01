const {test}=require('node:test'),assert=require('node:assert/strict');
const R=require('../app/file-review.js'),W=require('../app/review-workbench.js');
test('folding context never loses source rows, line numbers or nearby unchanged lines',()=>{
 const before=Array.from({length:120},(_,i)=>`line ${i}`).join('\n'),after=before.replace('line 57\n','replacement\nsecond new line\n');
 const rows=R.diff(before,after),folded=W.contextRows(rows),restored=folded.flatMap(row=>row.type==='gap'?row.rows:[row]);
 assert.deepEqual(restored,rows);assert.equal(folded.filter(x=>x.type==='gap').length,2);
 const change=folded.findIndex(x=>x.type==='remove');assert.equal(folded[change-3].text,'line 54');assert.ok(folded.some(x=>x.type==='same'&&x.text==='line 60'));
});
test('split view preserves both files with unequal additions, deletion-only hunks and repeated lines',()=>{
 for(const [before,after] of [['a\nb\nc','a\nx\ny\nz\nc'],['a\nb\nc','a\nc'],['','new'],['a\na\nb','a\nb\nb']]){
  const paired=W.pairedRows(R.diff(before,after));
  assert.equal(paired.flatMap(r=>r.left?[r.left.text]:[]).join('\n'),before);
  assert.equal(paired.flatMap(r=>r.right?[r.right.text]:[]).join('\n'),after);
 }
});
test('unchanged and empty snapshots remain honest and reversible through context expansion',()=>{
 assert.deepEqual(W.stats(R.diff('same','same')),{added:0,removed:0});
 assert.deepEqual(W.contextRows([]),[]);assert.deepEqual(W.contextRows(R.diff('a\nb','a\nb')).flatMap(x=>x.rows),R.diff('a\nb','a\nb'));
});
