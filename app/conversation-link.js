(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  // 对话成为可寻址单元：链接可复制、可被回复引用、可导出为自包含快照。
  const SCHEME = 'aibro';
  const PREFIX = SCHEME + '://conversation/';
  const MAX_SNAPSHOT_MESSAGES = 2000;
  const MAX_SNAPSHOT_CHARS = 4000000;

  function valid(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(id);
  }

  function build(id) {
    return valid(id) ? PREFIX + id : '';
  }

  function resolve(target) {
    const value = String(target == null ? '' : target).trim();
    if (!value.toLowerCase().startsWith(PREFIX)) return '';
    const id = value.slice(PREFIX.length);
    return valid(id) ? id : '';
  }

  function stamp(value) {
    const date = new Date(Number.isFinite(value) ? value : NaN);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // 快照保留消息原文，不改写、不总结；超出上限时截断并如实标注。
  function snapshot(conversation, options) {
    if (!conversation) return '';
    const settings = options && typeof options === 'object' ? options : {};
    const label = message => message.role === 'user' ? '你' : message.role === 'agent' ? 'AI' : '记录';
    const lines = [];
    lines.push('# ' + String(conversation.title || '新对话').trim());
    lines.push('');
    lines.push('- 空间：' + (settings.workspace || conversation.workspace || '未标注'));
    if (valid(conversation.id)) lines.push('- 链接：' + build(conversation.id));
    lines.push('- 创建时间：' + (stamp(conversation.createdAt) || '未记录'));
    lines.push('- 导出时间：' + (stamp(settings.now) || '未记录'));
    lines.push('');
    lines.push('---');
    lines.push('');
    const messages = Array.isArray(conversation.messages) ? conversation.messages.filter(message => message && !message.deletedAt) : [];
    const shown = messages.slice(0, MAX_SNAPSHOT_MESSAGES);
    let budget = MAX_SNAPSHOT_CHARS;
    const body = [];
    for (const message of shown) {
      const text = String(message.text == null ? '' : message.text).trim();
      if (!text) continue;
      if (budget - text.length < 0) { body.push('## …（已达导出上限，后续消息未包含在本次快照中）'); break; }
      budget -= text.length;
      body.push('## ' + label(message) + (message.live ? '（生成中）' : ''));
      body.push('');
      body.push(text);
      body.push('');
    }
    lines.push(...body);
    if (messages.length > shown.length) lines.push('（共 ' + messages.length + ' 条消息，快照仅包含前 ' + shown.length + ' 条。）');
    return lines.join('\n');
  }

  function fileName(title) {
    const cleaned = String(title || '对话').replace(/[\\/:*?"<>|\s·]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return (cleaned || '对话').slice(0, 80) + '.md';
  }

  return { SCHEME, PREFIX, build, resolve, snapshot, fileName, valid, MAX_SNAPSHOT_MESSAGES };
});
