'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Tab 一键两义的纯逻辑：什么时候填提示、什么时候不该拦截。
const Tips = require(path.join(__dirname, '../app/composer-tips.js'));

test('输入框为空时按 Tab 填入提示', () => {
  const decision = Tips._pure.plan({ value: '', tipIndex: -1 });
  assert.equal(decision.action, 'insert');
  assert.equal(decision.index, 0, '从第一条开始');
  assert.equal(Tips.tipAt(0), '整理附件并提取待办');
});

test('只填空白也算空——不把空格当成"用户写的内容"', () => {
  assert.equal(Tips._pure.plan({ value: '   \n ', tipIndex: 0 }).action, 'insert');
});

test('用户自己写了内容时不拦截 Tab——绝不覆盖', () => {
  assert.equal(Tips._pure.plan({ value: '帮我看一下这份材料', tipIndex: 1 }).action, 'ignore');
});

test('已经是提示原文时再按 Tab 换下一条（逐条轮换、循环）', () => {
  const first = Tips.tipAt(0);
  const second = Tips._pure.plan({ value: first, tipIndex: 0 });
  assert.equal(second.action, 'insert');
  assert.equal(second.index, 1, '换到下一条');
  assert.equal(Tips.tipAt(second.index), '分析资料并归入合适的项目');
  const wrapped = Tips._pure.plan({ value: Tips.tipAt(Tips.TIPS.length - 1), tipIndex: Tips.TIPS.length - 1 });
  assert.equal(wrapped.index, 0, '到最后一条后回到第一条');
});

test('用户在提示上继续打字后就不再拦截（提示已被改写）', () => {
  const edited = `${Tips.tipAt(0)}，另外加上时间范围`;
  assert.equal(Tips._pure.plan({ value: edited, tipIndex: 0 }).action, 'ignore');
});

test('提示只推荐真实存在的能力（与空状态建议同一批）', () => {
  assert.ok(Tips.TIPS.length >= 3);
  for (const tip of Tips.TIPS) assert.equal(typeof tip, 'string');
  assert.ok(Tips.TIPS.includes('整理附件并提取待办'), '应与对话空状态的建议保持一致');
});

test('模块暴露的接入口齐全', () => {
  for (const name of ['init', 'tipAt', 'plan']) assert.equal(typeof Tips[name], 'function', `缺少 ${name}`);
});
