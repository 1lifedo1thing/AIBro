const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanBookmark } = require('../app/reading-pane.js');

test('review reading metadata round-trips file identity, modes and semantic anchors without snapshot bodies', () => {
  const input = { review: { selectedId: 'second', documents: [
    {id:'first',mode:'diff',split:true,wrap:false,full:true,snapshot:'10:20:123',positions:{diff:{top:510,left:320,key:'40:42',offset:-4}},limits:[['diff:true',800]],expandedGaps:['gap:1:1'],hunkLimit:48,before:'PRIVATE BODY',after:'NEW BODY'},
    {id:'second',mode:'source',split:false,wrap:true,positions:{source:{top:88,left:0,key:':9',offset:3}}}
  ] } };
  const saved=cleanBookmark(input), copy=cleanBookmark(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(copy,saved);
  assert.equal(saved.review.selectedId,'second');
  assert.equal(saved.review.documents[0].positions.diff.key,'40:42');
  assert.equal(saved.review.documents[1].mode,'source');
  assert(!JSON.stringify(saved).includes('BODY'));
  input.review.documents[0].positions.diff.top=1000;
  assert.equal(saved.review.documents[0].positions.diff.top,510);
});

test('malformed review metadata is normalized while ordinary editor bookmarks retain their contract', () => {
  const saved=cleanBookmark({mode:'source',scrollTop:12,review:{selectedId:'file',documents:[null,{id:'file',mode:'execute',split:'yes',wrap:false,full:1,positions:{diff:{top:-1,left:Infinity,key:'<script>',offset:NaN},source:{top:3,key:':1',offset:-2}},limits:[['diff:true',400],['bad',-1],['fraction',.3]],expandedGaps:['gap:1:1','not a row'],hunkLimit:-1}]}});
  assert.equal(saved.mode,'source');assert.equal(saved.scrollTop,12);
  const file=saved.review.documents[0];
  assert.equal(file.mode,'diff');assert.equal(file.split,false);assert.equal(file.full,false);
  assert.deepEqual(file.positions.diff,{});
  assert.deepEqual(file.limits,[['diff:true',400]]);
  assert.deepEqual(file.expandedGaps,['gap:1:1']);
  assert.equal(file.hunkLimit,undefined);
  assert.equal(cleanBookmark({review:{selectedId:null,documents:[]}}),undefined);
});
