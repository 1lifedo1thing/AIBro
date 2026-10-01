/* 无痕模式（对齐 NewMax §1.10）：开启后新建的对话标记为无痕。
   三条约定（照说明书的原始描述来，并且**明确告知**，不让它看起来像故障）：
   · 无痕对话**不出现在普通列表与全文搜索**里——隐私模式下侧栏只显示本次会话的无痕对话，
     退出隐私模式后原本的普通对话原样恢复；
   · **退出隐私模式或重启应用后，无痕对话连同消息一起永久删除，不可恢复**（这不是 bug）；
   · 删除是**真删除**：从状态里移除对话与它关联的执行记录，不做"打个标记假装删了"。

   除此之外本模块不改变任何既有行为：权限、审批、附件与项目归属都不受影响。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrivateMode = api;
})(globalThis, root => {
  'use strict';
  // 隐私模式本身**只存在内存里**：重启后自动关闭——这正是"重启即清空"的语义基础。
  let enabled = false;
  let hooks = {};

  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  const $ = selector => root.document?.querySelector(selector);

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  function isEphemeral(conversation) {
    return !!(conversation && conversation.ephemeral);
  }

  // 隐私模式下侧栏/搜索只认本次会话的无痕对话；普通模式下一律隐藏无痕对话。
  function visibleInList(conversation, { enabled: on = enabled, currentId = null } = {}) {
    if (!isEphemeral(conversation)) return !on;      // 隐私模式下隐藏普通对话（退出后恢复）
    if (conversation.id === currentId) return true;  // 正在看的那条始终可见，否则用户会"凭空丢失"
    return !!on;
  }

  // 全文搜索与列表的规则不同：无痕对话**永远不进搜索索引**（说明书原文如此），
  // 所以这里不看模式，只看标记。
  function searchable(conversation) {
    return !isEphemeral(conversation);
  }

  // 要删除的内容：无痕对话本身 + 它们的执行记录（不留残渣）。
  function purgePlan(state) {
    const conversations = (state?.conversations || []).filter(isEphemeral);
    const ids = new Set(conversations.map(item => item.id));
    const runs = (state?.agentRuns || []).filter(run => ids.has(run.conversationId));
    return { conversations, runs, ids };
  }

  function noticeText() {
    return T('无痕模式：这里的对话不会出现在列表与搜索里，退出无痕模式或重启应用后会连同消息一起永久删除（不可恢复）。',
      'Private mode: these conversations stay out of the list and search, and are permanently deleted (with their messages) when you leave private mode or restart.');
  }

  // ── 行为 ─────────────────────────────────────────────────
  function purge() {
    const state = hooks.getState?.();
    if (!state) return { removedConversations: 0, removedRuns: 0 };
    const plan = purgePlan(state);
    if (!plan.conversations.length && !plan.runs.length) return { removedConversations: 0, removedRuns: 0 };
    state.conversations = (state.conversations || []).filter(item => !plan.ids.has(item.id));
    state.agentRuns = (state.agentRuns || []).filter(run => !plan.ids.has(run.conversationId));
    if (plan.ids.has(state.currentConversationId)) {
      state.currentConversationId = state.conversations.find(item => !item.archived)?.id || null;
    }
    hooks.save?.();
    return { removedConversations: plan.conversations.length, removedRuns: plan.runs.length };
  }

  function setEnabled(next) {
    const target = !!next;
    if (target === enabled) return enabled;
    enabled = target;
    if (!enabled) {
      // 退出隐私模式：立刻、真正删除本次会话的无痕对话。
      const result = purge();
      hooks.toast?.(result.removedConversations
        ? T(`已退出无痕模式：${result.removedConversations} 条无痕对话已永久删除。`, `Left private mode: ${result.removedConversations} private conversation(s) permanently deleted.`)
        : T('已退出无痕模式。', 'Left private mode.'));
    } else {
      // Enter a conversation with the promised lifetime before showing the
      // private-mode notice. Never relabel or delete the existing public chat.
      hooks.onEnter?.();
      hooks.toast?.(T('已开启无痕模式：新建对话不会出现在列表与搜索里，退出或重启后永久删除。', 'Private mode is on: new conversations stay out of lists and search, and are deleted when you leave or restart.'));
    }
    render();
    hooks.renderAll?.();
    return enabled;
  }

  // 新对话在隐私模式下带无痕标记（由 app.js 在创建时调用）。
  function mark(conversation) {
    if (!enabled || !conversation) return conversation;
    conversation.ephemeral = true;
    return conversation;
  }

  // ── 状态条 ───────────────────────────────────────────────
  function render() {
    const strip = $('#privateModeStrip');
    if (!strip) return { ok: false };
    strip.hidden = !enabled;
    if (enabled) strip.textContent = noticeText();
    const toggle = $('#privateModeToggle');
    if (toggle) toggle.checked = enabled;
    return { ok: true, enabled };
  }

  function init(options = {}) {
    hooks = options || {};
    // 启动时清理上次遗留的无痕对话——"重启后永久删除"就落在这一步。
    const leftover = purgePlan(hooks.getState?.() || {});
    if (leftover.conversations.length) {
      purge();
      hooks.toast?.(T(`${leftover.conversations.length} 条无痕对话已按约定永久删除。`, `${leftover.conversations.length} private conversation(s) were permanently deleted as promised.`));
    }
    render();
    return { ok: true, enabled, purgedOnLoad: leftover.conversations.length };
  }

  // 给宿主用的一步判定：按当前模式与当前对话决定是否出现在列表/搜索里。
  function shows(conversation) {
    const state = hooks.getState?.();
    return visibleInList(conversation, { enabled, currentId: state?.currentConversationId || null });
  }

  root.PrivateMode = { init, setEnabled, mark, purge, render, shows, searchable, isOn: () => enabled,
    _pure: { isEphemeral, visibleInList, searchable, purgePlan, noticeText } };
  return root.PrivateMode;
});
