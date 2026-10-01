'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 快捷键清单的价值在于"说的和做的一致"——所以最重要的测试是核验：
// 清单里每一条带 verify 的快捷键，都必须在对应文件里找到那段真实代码。
const Shortcuts = require(path.join(__dirname, '../app/shortcuts.js'));
const ROOT = path.resolve(__dirname, '..');

test('清单按分组给出条目，且每个条目都有按键与说明', () => {
  const list = Shortcuts.entries();
  assert.ok(list.length >= 10, `条目过少（${list.length}），可能清单被误删`);
  for (const item of list) {
    assert.ok(Array.isArray(item.keys) && item.keys.length, `条目缺少按键：${JSON.stringify(item)}`);
    assert.ok(item.zh && item.en, `条目缺少双语文案：${JSON.stringify(item.keys)}`);
    assert.ok(item.groupLabel, '条目缺少分组名');
  }
});

test('清单不编造快捷键：每条带 verify 的都必须在代码里真实存在', () => {
  const checks = Shortcuts.verifiable();
  assert.ok(checks.length >= 6, `可核验条目过少（${checks.length}）`);
  const missing = [];
  const cache = new Map();
  for (const check of checks) {
    const file = path.join(ROOT, check.file);
    if (!cache.has(check.file)) cache.set(check.file, fs.readFileSync(file, 'utf8'));
    if (!cache.get(check.file).includes(check.token)) missing.push(`${check.keys}（${check.file} 里找不到 ${JSON.stringify(check.token)}）`);
  }
  assert.deepEqual(missing, [], '这些快捷键在代码里不存在，面板不得展示：' + missing.join('、'));
});

test('asText 覆盖全部分组与条目（供复制与屏幕阅读器使用）', () => {
  const text = Shortcuts.asText();
  for (const item of Shortcuts.entries()) {
    assert.ok(text.includes(item.keys.join(' + ')), `文本缺少按键：${item.keys.join('+')}`);
    assert.ok(text.includes(item.zh), `文本缺少说明：${item.zh}`);
  }
});

test('模块暴露的接入口齐全', () => {
  for (const name of ['init', 'open', 'close', 'entries', 'asText', 'verifiable']) {
    assert.equal(typeof Shortcuts[name], 'function', `缺少 ${name}`);
  }
});
