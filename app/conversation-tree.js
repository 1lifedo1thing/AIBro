(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationTree = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  // 会话之间的分叉关系：此前只写不读（branchedFrom 记录了却从不使用）。
  // 这里把它变成可导航、可发现的结构——但不改动消息模型，也不合并任何对话。
  function live(item) {
    return !!item && !item.deletedAt;
  }

  function parentOf(state, conversation) {
    const ref = conversation?.branchedFrom;
    if (!ref || !ref.conversationId) return null;
    const parent = (state?.conversations || []).find(item => live(item) && item.id === ref.conversationId);
    return parent ? { conversation: parent, ref } : null;
  }

  function childrenOf(state, conversationId) {
    if (!conversationId) return [];
    return (state?.conversations || []).filter(item => live(item) && item.branchedFrom?.conversationId === conversationId);
  }

  // 分叉点在父对话里的位置，以及其后新增的消息数——也就是"另一条分支后来的发展"。
  function parentProgress(parent, ref) {
    const messages = (parent?.messages || []).filter(item => item && !item.deletedAt);
    const index = messages.findIndex(item => item.id === ref?.messageId);
    if (index < 0) return { located: false, newer: 0, total: messages.length };
    return { located: true, index, newer: Math.max(0, messages.length - index - 1), total: messages.length };
  }

  function label(conversation) {
    const ref = conversation?.branchedFrom;
    if (!ref) return '';
    const name = String(ref.conversationTitle || '').trim() || '原对话';
    return ref.edited ? `修改重发自「${name}」` : `分支自「${name}」`;
  }

  function describe(state, conversation) {
    const parent = parentOf(state, conversation);
    if (!parent) return null;
    const progress = parentProgress(parent.conversation, parent.ref);
    return {
      parent: parent.conversation,
      ref: parent.ref,
      progress,
      label: label(conversation),
      hasNewer: progress.located && progress.newer > 0
    };
  }

  function summaryText(state, conversation) {
    const info = describe(state, conversation);
    if (!info) return '';
    // 定位不到分叉点时不能声称“没有新消息”——那是在替未知的情况打包票。
    if (!info.progress.located) return `${info.label} · 原对话此后的变化无法定位`;
    return info.hasNewer ? `${info.label} · 原对话此后新增 ${info.progress.newer} 条` : `${info.label} · 原对话此后没有新消息`;
  }

  // 父对话侧：它自己分出了多少条分支。
  function branchCount(state, conversationId) {
    return childrenOf(state, conversationId).length;
  }

  // 对话头部的关系徽标：让"这条对话从哪来""另一条分支后来怎样了"可见可点。
  function syncChip(options) {
    const settings = options && typeof options === 'object' ? options : {};
    const doc = settings.doc, host = settings.host;
    if (!doc || !host) return null;
    const info = describe(settings.state, settings.conversation);
    let chip = doc.getElementById('conversationBranchChip');
    if (!info) { chip?.remove(); return null; }
    if (!chip) {
      chip = doc.createElement('button');
      chip.type = 'button';
      chip.id = 'conversationBranchChip';
      chip.className = 'branch-chip';
      host.append(chip);
    }
    const newer = info.progress.located && info.hasNewer ? ` · 原对话 +${info.progress.newer}` : '';
    chip.dataset.openConversation = info.parent.id;
    chip.textContent = info.label + newer;
    chip.title = `打开原对话「${info.parent.title || '未命名'}」；这条分支的内容保持独立，不会被合并。`;
    return info;
  }

  return { parentOf, childrenOf, parentProgress, label, describe, summaryText, branchCount, live, syncChip };
});
