/* Tab 一键两义（对齐 NewMax §16.4）：输入框**为空**时按 Tab 把一条轮换的
   「可以做什么」填进输入框；**已经有自己的内容**时不拦截 Tab（保持默认的焦点行为）。

   两条纪律：
   · 提示只推荐**真实存在**的能力（与空状态建议同一批，不编造功能）；
   · 填入后再按 Tab 换下一条——但只在这条确实是提示原文时才换，
     用户一旦改过内容就不再拦截（不覆盖用户自己写的东西）。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComposerTips = api;
})(globalThis, root => {
  'use strict';

  // 与对话空状态的建议同一批：只说真实能力。
  const TIPS = [
    '整理附件并提取待办',
    '分析资料并归入合适的项目',
    '创建项目计划和时间节点',
    '把这段对话整理成一份笔记'
  ];

  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  const EN = {
    '整理附件并提取待办': 'Organize attachments and extract to-dos',
    '分析资料并归入合适的项目': 'Analyze sources and file them into a project',
    '创建项目计划和时间节点': 'Create a project plan and milestones',
    '把这段对话整理成一份笔记': 'Turn this conversation into a note'
  };
  const text = tip => T(tip, EN[tip] || tip);

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  // 决定这一次 Tab 该做什么：'insert'（填下一条）/ 'ignore'（不拦截）。
  function plan({ value = '', tipIndex = -1 } = {}) {
    const current = String(value);
    const trimmed = current.trim();
    if (!trimmed) return { action: 'insert', index: (tipIndex + 1) % TIPS.length };
    const at = TIPS.findIndex(tip => text(tip) === trimmed || tip === trimmed);
    if (at >= 0) return { action: 'insert', index: (at + 1) % TIPS.length };
    return { action: 'ignore', index: tipIndex };
  }

  function tipAt(index) {
    const slot = ((index % TIPS.length) + TIPS.length) % TIPS.length;
    return text(TIPS[slot]);
  }

  // ── 接线 ─────────────────────────────────────────────────
  let tipIndex = -1;

  function init(options = {}) {
    const doc = root.document;
    const input = doc?.querySelector(options.inputSelector || '#agentInput');
    if (!input) return { ok: false, reason: 'missing-input' };
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'Tab' || event.shiftKey) return;   // Shift+Tab 归模式提示
      const decision = plan({ value: input.value, tipIndex });
      if (decision.action !== 'insert') return;             // 有内容就不拦截
      event.preventDefault();
      tipIndex = decision.index;
      input.value = tipAt(tipIndex);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (error) { /* 非文本输入框时忽略 */ }
    });
    return { ok: true, tips: TIPS.length };
  }

  root.ComposerTips = { init, tipAt, plan, TIPS, _pure: { plan, tipAt, TIPS } };
  return root.ComposerTips;
});
