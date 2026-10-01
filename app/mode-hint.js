/* 模式关键词提示（对齐 NewMax §4.2）：用户不需要先知道有 /plan 与 /goal。
   在输入里出现「计划 / 方案 / 规划」或「目标 / 自主执行」时，输入区上方给出
   一条可点击的提示，点它或按 Shift+Tab 把当前输入转成对应模式。

   三条边界：
   · 只提示、不改写输入——转换必须由用户触发（点提示或 Shift+Tab）；
   · 已经有 /plan 或 /goal 前缀时不再提示（不重复打扰）；
   · 两种词同时出现时，取先出现的那个——不猜"用户其实想要哪个"。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModeHint = api;
})(globalThis, root => {
  'use strict';
  const PLAN_WORDS = ['规划', '计划', '方案', 'plan'];
  const GOAL_WORDS = ['目标', '自主执行', 'goal'];
  let hooks = {};

  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  const $ = selector => document.querySelector(selector);

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  function detect(text) {
    const value = String(text == null ? '' : text);
    if (!value.trim()) return null;
    // 已有模式前缀：不再提示（用户已经显式选了模式）。
    if (/^\s*\/(?:plan|goal)\b/i.test(value)) return null;
    const lower = value.toLowerCase();
    let best = null;
    const consider = (words, mode) => {
      for (const word of words) {
        const at = lower.indexOf(word);
        if (at >= 0 && (!best || at < best.at)) best = { mode, word, at };
      }
    };
    consider(PLAN_WORDS, 'plan');
    consider(GOAL_WORDS, 'goal');
    return best;
  }

  // 把输入转成对应模式：保留原有内容，只补前缀；已有另一个前缀时替换它。
  function apply(mode, text) {
    const value = String(text == null ? '' : text);
    const prefix = mode === 'goal' ? '/goal ' : '/plan ';
    if (new RegExp('^\\s*\\/' + mode + '\\b', 'i').test(value)) return value;
    return prefix + value.replace(/^\s*\/\s*(?:plan|goal)\b[ \t]*/i, '');
  }

  // /plan 前缀解析：前缀本身不进入对话内容（与 /goal 同一约定）。
  // 空规划不开启——只发一个前缀等于让模型猜要规划什么。
  function parsePlan(text) {
    const value = String(text == null ? '' : text);
    const match = value.match(/^\s*\/plan\b[ \t]*([\s\S]*)$/i);
    if (!match) return null;
    const plan = match[1].trim();
    if (!plan) return null;
    return { plan, explicit: true };
  }

  function hintText(mode) {
    return mode === 'goal'
      ? T('检测到目标相关表述 · 按 Shift+Tab 创建目标', 'Goal wording detected · Shift+Tab to create a goal')
      : T('检测到计划相关表述 · 按 Shift+Tab 创建规划', 'Planning wording detected · Shift+Tab to create a plan');
  }

  // ── 提示条 ────────────────────────────────────────────────
  let current = null;   // 当前检测结果（null = 不显示）

  function render() {
    const strip = $('#modeHintStrip');
    const field = $('#agentInput');
    if (!strip || !field) return;
    const found = detect(field.value);
    if (!found) { strip.hidden = true; strip.textContent = ''; current = null; return; }
    current = found;
    strip.hidden = false;
    strip.textContent = hintText(found.mode);
    strip.dataset.mode = found.mode;
  }

  // 由用户触发转换：更新输入框、收起提示、回到输入焦点。
  function convert() {
    const field = $('#agentInput');
    if (!field || !current) return false;
    field.value = apply(current.mode, field.value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    render();
    field.focus();
    const end = field.value.length;
    try { field.setSelectionRange(end, end); } catch (error) { /* 非文本输入框时忽略 */ }
    return true;
  }

  function init(options) {
    hooks = options || {};
    const strip = $('#modeHintStrip');
    if (!strip) return { ok: false, reason: 'missing-mode-hint' };
    strip.addEventListener('click', () => convert());
    render();
    return { ok: true };
  }

  root.ModeHint = { init, render, convert, parsePlan, _pure: { detect, apply, hintText, parsePlan } };
  return root.ModeHint;
});
