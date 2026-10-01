'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Deliverable = require('../app/task-deliverable.js');

const task = (extra = {}) => ({ id: 't1', title: '整理实验记录', status: 'todo', ...extra });

test('a task without a declared deliverable is never blocked', () => {
  for (const value of [undefined, null, {}, { kind: 'unknown' }, { kind: 'note' }, { kind: 'text', mustInclude: '   ' }]) {
    assert.deepEqual(Deliverable.validate(task({ deliverable: value }), {}), { ok: true, reason: '' }, JSON.stringify(value));
  }
  assert.equal(Deliverable.describe({ kind: 'note' }), '', '不完整的声明不产生描述');
  assert.equal(Deliverable.message(task(), { ok: true }), '');
});

test('a declared note must exist, be alive, and belong to the same project', () => {
  const declared = task({ deliverable: { kind: 'note', ref: 'n1' }, projectId: 'p1' });
  assert.equal(Deliverable.validate(declared, { notes: [{ id: 'n1', projectId: 'p1' }], projectId: 'p1' }).ok, true);
  assert.equal(Deliverable.validate(declared, { notes: [], projectId: 'p1' }).ok, false, '笔记不存在时不得完成');
  assert.equal(Deliverable.validate(declared, { notes: [{ id: 'n1', projectId: 'p1', deletedAt: 1 }], projectId: 'p1' }).ok, false, '已删除的不算产出');
  assert.equal(Deliverable.validate(declared, { notes: [{ id: 'n1', projectId: 'p2' }], projectId: 'p1' }).ok, false, '跨项目的产出会让人找不到，必须拦下');
  assert.equal(Deliverable.validate(declared, { notes: [{ id: 'n1', projectId: 'p2' }] }).ok, true, '任务本身没有项目时不强求归属');
});

test('a declared task must exist and already be done', () => {
  const declared = task({ deliverable: { kind: 'task', ref: 't9' } });
  assert.equal(Deliverable.validate(declared, { tasks: [{ id: 't9', title: '前置', status: 'done' }] }).ok, true);
  const pending = Deliverable.validate(declared, { tasks: [{ id: 't9', title: '前置', status: 'todo' }] });
  assert.equal(pending.ok, false);
  assert.match(pending.reason, /还没有完成/);
  assert.match(pending.reason, /前置/, '理由里要指明是哪个任务');
});

test('the keyword form checks the task content and never invents a conclusion', () => {
  const declared = task({ deliverable: { kind: 'text', mustInclude: '第 3 组数据' }, description: '已整理第 3 组数据并归档' });
  assert.equal(Deliverable.validate(declared, {}).ok, true);
  const missing = Deliverable.validate(task({ deliverable: { kind: 'text', mustInclude: '第 3 组数据' }, description: '整理了前两组' }), {});
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /第 3 组数据/);
  // 关键词只做字面包含：不因为"意义接近"就放过。
  assert.equal(Deliverable.validate(task({ deliverable: { kind: 'text', mustInclude: '归档' }, description: '已整理' }), {}).ok, false);
});

test('the failure message says what is missing and that the task stays unfinished', () => {
  const text = Deliverable.message(task(), { ok: false, reason: '找不到一条笔记（n1）' });
  assert.match(text, /产出校验未通过/);
  assert.match(text, /找不到一条笔记/);
  assert.match(text, /保持未完成/);
  assert.match(text, /清空产出要求后再标记完成/, '必须给出人工出口，不能把用户卡死');
  assert.equal(Deliverable.describe({ kind: 'note', ref: 'n1' }), '需存在一条笔记（n1）');
  assert.equal(Deliverable.describe({ kind: 'text', mustInclude: '关键词' }), '内容需包含「关键词」');
});
