'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ReviewerDelegate = require('../app/reviewer-delegate.js');

test('only an explicit approval is delegated; doubt hands back to the human', () => {
  assert.deepEqual(ReviewerDelegate.decide({ verdict: 'approve' }), { action: 'approve', denials: 0, reason: 'approve' });
  for (const verdict of ['caution', 'reject', 'something-else', undefined, null, '']) {
    const decision = ReviewerDelegate.decide({ verdict, denials: 0 });
    assert.notEqual(decision.action, 'approve', String(verdict));
    // caution 与“没结论”都不增加计数；只有明确拒绝才累计。
    assert.equal(decision.denials, verdict === 'reject' ? 1 : 0, String(verdict));
  }
});

test('consecutive rejections halt automatic progress at the limit, and an approval resets the counter', () => {
  let denials = 0;
  const first = ReviewerDelegate.decide({ verdict: 'reject', denials });
  assert.equal(first.action, 'handback'); denials = first.denials;
  const second = ReviewerDelegate.decide({ verdict: 'reject', denials });
  assert.equal(second.action, 'handback'); denials = second.denials;
  const third = ReviewerDelegate.decide({ verdict: 'reject', denials });
  assert.equal(third.action, 'halt'); assert.equal(third.denials, ReviewerDelegate.DENIAL_LIMIT);
  // 达到上限后仍是停止（不会因为再拒一次就“重新开始”）。
  assert.equal(ReviewerDelegate.decide({ verdict: 'reject', denials: third.denials }).action, 'halt');
  // 一次明确批准即清零：熔断是“连续”拒绝，不是累计拒绝。
  assert.equal(ReviewerDelegate.decide({ verdict: 'approve', denials: third.denials }).denials, 0);
  // 非法计数不制造负值。
  assert.equal(ReviewerDelegate.decide({ verdict: 'reject', denials: -5 }).denials, 1);
});

test('notes state the destination honestly and never claim the boundary changed', () => {
  const approve = ReviewerDelegate.noteFor(ReviewerDelegate.decide({ verdict: 'approve' }));
  assert.match(approve, /代为批准/);
  assert.match(approve, /边界未变/);
  const caution = ReviewerDelegate.noteFor(ReviewerDelegate.decide({ verdict: 'caution' }));
  assert.match(caution, /谨慎/); assert.match(caution, /交回你决定/);
  const rejected = ReviewerDelegate.noteFor(ReviewerDelegate.decide({ verdict: 'reject', denials: 0 }));
  assert.match(rejected, /建议不要执行/); assert.match(rejected, /连续被拒 1 次/);
  const halted = ReviewerDelegate.noteFor(ReviewerDelegate.decide({ verdict: 'reject', denials: ReviewerDelegate.DENIAL_LIMIT - 1 }));
  assert.match(halted, /自动推进已停止/); assert.match(halted, /人工检查/);
  const inconclusive = ReviewerDelegate.noteFor(ReviewerDelegate.decide({ verdict: 'other' }));
  assert.match(inconclusive, /未给出明确结论/);
  // 审查者不可用时不谎称已审查，也不改变任何边界。
  assert.match(ReviewerDelegate.fallbackNote('网络超时'), /审查者代批未生效（网络超时）/);
  assert.match(ReviewerDelegate.fallbackNote(''), /未生效/);
  for (const note of [approve, caution, rejected, halted, inconclusive]) assert.doesNotMatch(note, /已放宽|扩大权限|自动放行/);
});
