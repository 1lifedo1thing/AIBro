'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 模式关键词提示的纯逻辑：检测、转换、前缀解析。
const Mode = require(path.join(__dirname, '../app/mode-hint.js'));

test('detect 识别计划类表述', () => {
  for (const text of ['帮我做个计划', '写个方案', '这一个月的规划', 'plan the migration']) {
    const found = Mode._pure.detect(text);
    assert.equal(found?.mode, 'plan', `${text} 应识别为规划`);
  }
});

test('detect 识别目标类表述', () => {
  for (const text of ['帮我达成这个目标', '自主执行这个任务', 'set a goal for the release']) {
    const found = Mode._pure.detect(text);
    assert.equal(found?.mode, 'goal', `${text} 应识别为目标`);
  }
});

test('detect 空输入与无关表述不提示', () => {
  assert.equal(Mode._pure.detect(''), null);
  assert.equal(Mode._pure.detect('   '), null);
  assert.equal(Mode._pure.detect('今天天气不错'), null);
});

test('detect 已有模式前缀时不再提示——不重复打扰', () => {
  assert.equal(Mode._pure.detect('/plan 做个计划'), null);
  assert.equal(Mode._pure.detect('/goal 完成目标'), null);
  assert.equal(Mode._pure.detect('  /PLAN 方案'), null);
});

test('detect 两种词同时出现时取先出现的那个——不猜用户想要哪个', () => {
  assert.equal(Mode._pure.detect('先给计划，再看目标')?.mode, 'plan');
  assert.equal(Mode._pure.detect('目标明确之后再谈方案')?.mode, 'goal');
});

test('apply 只补前缀、不改写原有内容', () => {
  assert.equal(Mode._pure.apply('plan', '做个计划'), '/plan 做个计划');
  assert.equal(Mode._pure.apply('goal', '完成目标'), '/goal 完成目标');
});

test('apply 遇到另一个前缀时替换它，而不是叠成两个前缀', () => {
  assert.equal(Mode._pure.apply('plan', '/goal 完成目标'), '/plan 完成目标');
  assert.equal(Mode._pure.apply('goal', '  /plan 做个计划'), '/goal 做个计划');
});

test('apply 对已有同名前缀保持幂等', () => {
  assert.equal(Mode._pure.apply('plan', '/plan 做个计划'), '/plan 做个计划');
});

test('parsePlan 解析前缀且要求有内容', () => {
  assert.deepEqual(Mode._pure.parsePlan('/plan 重构检索层'), { plan: '重构检索层', explicit: true });
  assert.deepEqual(Mode._pure.parsePlan('/PLAN 重构检索层').plan, '重构检索层');
  assert.equal(Mode._pure.parsePlan('/plan'), null, '空规划不开启——只给前缀等于让模型猜要规划什么');
  assert.equal(Mode._pure.parsePlan('/plan   '), null);
  assert.equal(Mode._pure.parsePlan('给我一份计划'), null);
  assert.equal(Mode._pure.parsePlan(''), null);
});

test('模块暴露的接入口齐全', () => {
  for (const name of ['init', 'render', 'convert', 'parsePlan']) {
    assert.equal(typeof Mode[name], 'function', `缺少 ${name}`);
  }
});
