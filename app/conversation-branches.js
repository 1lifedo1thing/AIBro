(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationBranches = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 会话内分支（消息级会话树）：在同一条对话里保留多个平行走向，并可随时切回。
  //
  // 结构上刻意保持 conversation.messages 是**当前活动路径**的线性数组——渲染、上下文组装、
  // 压缩、审阅全部照旧；被换下去或分出去的路径存放在 conversation.branches 里。
  // 这样"树"是可见、可切换的，但不会把整条链路改成图遍历。
  const MAIN = 'main';

  function branchList(conversation) {
    const list = conversation && Array.isArray(conversation.branches) ? conversation.branches : [];
    return list.filter(item => item && typeof item.id === 'string' && Array.isArray(item.messages));
  }

  // 当前所在路径。注意：被激活的分支不在 branches 里是**正常**的（它的消息就是 conversation.messages），
  // 所以不能用"是否在存档里"来校验——那样会把正在使用的分支误判成失效并跳回主线。
  // 活跃路径的元数据单独存在 activeBranch 上，切换时随路径一起搬运，避免激活一次就丢掉来源信息。
  function currentId(conversation) {
    const meta = conversation && conversation.activeBranch;
    if (meta && typeof meta.id === 'string' && meta.id.trim()) return meta.id;
    const id = conversation && conversation.activeBranchId;
    return typeof id === 'string' && id.trim() ? id : MAIN;
  }

  function activeMeta(conversation) {
    const meta = conversation && conversation.activeBranch;
    if (meta && typeof meta.id === 'string' && meta.id.trim()) {
      return { id: meta.id, fromMessageId: meta.fromMessageId ?? null, createdAt: meta.createdAt || (conversation.createdAt || 0) };
    }
    return { id: currentId(conversation), fromMessageId: null, createdAt: (conversation && conversation.createdAt) || 0 };
  }

  // 从某条消息处另起分支：该消息之后的内容整体存为分支，当前路径在此截断。
  // 返回新值供调用方写回（本函数不改动入参）。
  function fork(conversation, messageId, id, now) {
    const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
    const index = messages.findIndex(item => item && item.id === messageId);
    if (index < 0) return { error: 'not-found' };
    const tail = messages.slice(index + 1);
    if (!tail.length) return { error: 'empty' };
    const branch = { id, fromMessageId: messageId, messages: tail, createdAt: now, at: now };
    return { keep: messages.slice(0, index + 1), branch, activeBranch: activeMeta(conversation) };
  }

  // 切换路径：当前路径（连同它的来源元数据）存回 branches，目标分支的元数据被搬到 activeBranch。
  // 元数据必须跟着路径走一圈——否则"激活过一次"就会让分支丢掉它是从哪条消息分出来的。
  function switchTo(conversation, targetId, now) {
    const list = branchList(conversation);
    const active = activeMeta(conversation);
    if (!targetId || targetId === active.id) return { error: 'same' };
    const target = list.find(item => item.id === targetId);
    if (!target) return { error: 'not-found' };
    const parked = { id: active.id, fromMessageId: active.fromMessageId, createdAt: active.createdAt, messages: (conversation && conversation.messages) || [], at: now };
    return {
      activeBranchId: target.id,
      activeBranch: { id: target.id, fromMessageId: target.fromMessageId ?? null, createdAt: target.createdAt || now },
      messages: target.messages,
      branches: [...list.filter(item => item.id !== target.id), parked]
    };
  }

  function count(conversation) {
    const parked = branchList(conversation).filter(item => item.id !== currentId(conversation));
    return parked.length;
  }

  function snapshot(message) {
    const text = String((message && message.text) || '').replace(/\s+/g, ' ').trim();
    return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }

  // 分支标题：优先用该分支的首条用户消息（人写的，最能说明这条分支在做什么），
  // 没有就用首条消息；都没有就如实说"空分支"，不编造内容。
  function label(branch) {
    const messages = Array.isArray(branch && branch.messages) ? branch.messages : [];
    const first = messages.find(item => item && item.role === 'user') || messages[0];
    const text = snapshot(first);
    return text || '空分支';
  }

  // 面向用户的描述：绝不把不同分支说成同一份内容。
  function describe(branch) {
    const messages = Array.isArray(branch && branch.messages) ? branch.messages : [];
    return `${label(branch)} · ${messages.length} 条`;
  }

  return Object.freeze({ MAIN, branchList, currentId, activeMeta, fork, switchTo, count, label, describe, snapshot });
}));
