/* 大回复的安全预览（对齐 NewMax §2.5）：单条回复特别大时，先给**有界的纯文本预览**，
   避免 Markdown 渲染、代码高亮或巨型单行内容卡住界面；用户可主动「显示完整内容」，
   也可以「恢复安全预览」退回来。

   三条刻意的边界：
   · 预览是**纯文本**、不是渲染结果——绝不假装它等于完整内容（界面上写明还有多少字符未渲染）；
   · 只对**已结束的回复**启用：正在流式生成的消息照常渲染，否则等于打断了实时阅读；
   · 「已展开」只在内存里记（不写进对话数据）——重开应用时回到安全预览，
     这正是这道保护存在的意义：打开时不该被一条超大消息卡住。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SafePreview = api;
})(globalThis, root => {
  'use strict';
  const LIMIT = 12000;      // 超过这个长度先给安全预览
  const SHOWN = 4000;       // 预览里先展示多少字符
  const expanded = new Set();   // 用户主动展开过的消息 id（仅本次运行有效）

  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  function needsPreview(text) {
    return String(text == null ? '' : text).length > LIMIT;
  }

  // 如实描述：总量、展示量、还有多少没渲染。
  function describe(text) {
    const total = String(text == null ? '' : text).length;
    const shown = Math.min(total, SHOWN);
    return { total, shown, hidden: Math.max(0, total - shown), limit: LIMIT };
  }

  function plainPreview(text) {
    return String(text == null ? '' : text).slice(0, SHOWN);
  }

  function noticeText(info) {
    const head = T(`这条回复较长（共 ${info.total} 字符），已先以纯文本显示前 ${info.shown} 字符`,
      `This reply is long (${info.total} characters); showing the first ${info.shown} as plain text`);
    const tail = T(`还有 ${info.hidden} 字符未渲染——完整内容需要你主动展开`,
      `${info.hidden} more characters are not rendered — expand to see the full reply`);
    return `${head}。${tail}。`;
  }

  // ── DOM ──────────────────────────────────────────────────
  function button(label, action, primary) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = primary ? 'secondary safe-preview-action' : 'secondary safe-preview-action';
    node.dataset.previewAction = action;
    node.textContent = label;
    return node;
  }

  // 把一条消息挂到 host 上；返回实际采用的形态（供测试与诊断）。
  function mount(host, message, options) {
    const render = options?.render || (() => {});
    const text = String(message?.text || '');
    const id = message?.id || '';
    // 正在生成的消息照常渲染——安全预览只针对已经结束的大回复。
    if (message?.live || !needsPreview(text) || (id && expanded.has(id))) {
      render(host, text);
      return 'rendered';
    }
    const info = describe(text);
    const box = document.createElement('div');
    box.className = 'safe-preview';
    box.dataset.safePreview = id;
    const notice = document.createElement('p');
    notice.className = 'safe-preview-notice';
    notice.textContent = noticeText(info);
    const plain = document.createElement('pre');
    plain.className = 'safe-preview-text';
    plain.textContent = plainPreview(text);          // 纯文本：不解析 Markdown、不做高亮
    const actions = document.createElement('div');
    actions.className = 'safe-preview-actions';
    const expand = button(T('显示完整内容', 'Show full content'), 'expand', true);
    expand.onclick = () => {
      if (id) expanded.add(id);
      host.replaceChildren();
      render(host, text);
      const back = document.createElement('div');
      back.className = 'safe-preview-restore';
      back.append(button(T('恢复安全预览', 'Back to safe preview'), 'restore'));
      back.lastChild.onclick = () => {
        if (id) expanded.delete(id);
        host.replaceChildren();
        mount(host, { ...message, live: false }, options);
      };
      host.append(back);
    };
    actions.append(expand);
    box.append(notice, plain, actions);
    host.replaceChildren(box);
    return 'preview';
  }

  function init() {
    return { ok: true, limit: LIMIT, shown: SHOWN };
  }

  root.SafePreview = { init, mount, needsPreview, describe, plainPreview, noticeText,
    _pure: { needsPreview, describe, plainPreview, noticeText, LIMIT, SHOWN } };
  return root.SafePreview;
});
