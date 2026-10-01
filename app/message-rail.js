/* 消息目录刻度导航（对齐 NewMax §2.2）：对话左侧一条竖向刻度，
   **用刻度颜色的深浅表达"当前屏幕正在显示哪一段"**，而不是只做一个滚动位置指示。

   四条设计（照着说明书的原始描述来）：
   · 深色刻度 = 当前在视口里的消息范围（用 IntersectionObserver 判定，不靠滚动位置估算）；
   · 悬停刻度 → 预览该条消息的角色、时间与内容摘要；
   · 消息很多时**先聚合刻度**（每格代表若干条），悬停聚合格才给出该区间的精确目录项；
   · 点击刻度 → 平滑滚动到该条消息。

   只读：不改消息、不改数据、不触发保存。消息数量不变时**不重建**（流式重绘期间刻度保持稳定）。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MessageRail = api;
})(globalThis, root => {
  'use strict';
  const MAX_TICKS = 30;       // 超过就聚合
  const PREVIEW_IN_GROUP = 6; // 聚合格悬停时最多列出几条精确项

  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  const $ = selector => root.document?.querySelector(selector);

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  function plan(count) {
    const total = Math.max(0, Math.floor(Number(count) || 0));
    if (!total) return { ticks: 0, span: 1, aggregated: false };
    if (total <= MAX_TICKS) return { ticks: total, span: 1, aggregated: false };
    const span = Math.ceil(total / MAX_TICKS);
    return { ticks: Math.ceil(total / span), span, aggregated: true };
  }

  function summarize(text, limit = 42) {
    const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}…`;
  }

  function labelFor(message) {
    const who = message?.role === 'user' ? T('你', 'You') : 'AI';
    const when = message?.at ? new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    return [who, when].filter(Boolean).join(' · ');
  }

  // 一个刻度的下标 → 它覆盖的消息下标区间 [start, end)
  function rangeOf(index, span) {
    const size = Math.max(1, Math.floor(Number(span) || 1));
    return { start: index * size, end: index * size + size };
  }

  // ── DOM ──────────────────────────────────────────────────
  let observer = null;
  let watched = new Set();
  let domObserver = null;
  let lastSignature = '';
  let visible = new Map();     // 稳定消息 ID → 是否在视口
  let nodes = [];              // 当前消息元素
  let ticks = [];              // 刻度元素
  let hooks = {};
  let syncTimer = null;
  const messageNodes = list => [...(list?.children || [])].filter(node => node.matches?.('.message-wrap[data-message-id]'));
  const nodeSignature = values => JSON.stringify([listHost()?.dataset?.conversationId || '', values.map(node => node.dataset.messageId)]);
  function revealMessage(id) {
    const list = listHost(), controller = root.ConversationWindow?.active?.(list);
    const target = controller?.ensure ? controller.ensure(id) : messageNodes(list).find(node => node.dataset.messageId === id);
    if (!target?.isConnected) return false;
    if (!root.ConversationReading?.reveal(target, { block: 'start' })) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return true;
  }

  function railHost() {
    const pane = $('.conversation-pane');
    if (!pane) return null;
    let rail = pane.querySelector('#messageRail');
    if (!rail) {
      rail = root.document.createElement('div');
      rail.className = 'message-rail';
      rail.id = 'messageRail';
      rail.setAttribute('role', 'navigation');
      rail.setAttribute('aria-label', T('消息目录', 'Message index'));
      pane.append(rail);
    }
    return rail;
  }

  function listHost() {
    return $('#messageList');
  }

  function build() {
    const host = railHost();
    const list = listHost();
    if (!host || !list) return { ok: false };
    nodes = messageNodes(list);
    lastSignature = nodeSignature(nodes);
    visible.clear();
    const counts = plan(nodes.length);
    if (!counts.ticks) { host.hidden = true; host.replaceChildren(); ticks = []; observeAll(); return { ok: true, ticks: 0 }; }
    host.hidden = false;
    host.replaceChildren();
    ticks = [];
    for (let index = 0; index < counts.ticks; index += 1) {
      const { start, end } = rangeOf(index, counts.span);
      const slice = nodes.slice(start, end);
      if (!slice.length) break;
      const tick = root.document.createElement('button');
      tick.type = 'button';
      tick.className = 'message-rail-tick';
      tick.dataset.railIndex = String(index);
      tick.dataset.railStart = String(start);
      const messages = slice.map(node => node.dataset.messageId || '');
      tick.dataset.railIds = JSON.stringify(messages);
      tick.setAttribute('aria-label', counts.aggregated
        ? T(`第 ${start + 1}–${Math.min(end, nodes.length)} 条消息`, `Messages ${start + 1}–${Math.min(end, nodes.length)}`)
        : T(`第 ${start + 1} 条消息`, `Message ${start + 1}`));
      tick.onclick = () => revealMessage(messages[0]);
      tick.onmouseenter = () => showPreview(tick, messages, start, counts);
      tick.onmouseleave = hidePreview;
      tick.onfocus = () => showPreview(tick, messages, start, counts);
      tick.onblur = hidePreview;
      host.append(tick);
      ticks.push(tick);
    }
    observeAll();
    paint();
    return { ok: true, ticks: counts.ticks, aggregated: counts.aggregated, messages: nodes.length };
  }

  function showPreview(tick, ids, start, counts) {
    hidePreview();
    const rail = railHost();
    if (!rail) return;
    const box = root.document.createElement('div');
    box.className = 'message-rail-preview';
    box.dataset.railPreview = '';
    const rows = counts.aggregated ? ids.slice(0, PREVIEW_IN_GROUP) : ids;
    const model = root.ConversationWindow?.active?.(listHost())?.entries?.() || hooks.getMessages?.() || [];
    const messages = new Map(model.filter(message => message?.id && !message.deletedAt).map(message => [message.id, message]));
    const currentNodes = new Map(messageNodes(listHost()).map(node => [node.dataset.messageId, node]));
    for (const [offset, id] of rows.entries()) {
      // Deleted rows and window slots make transcript indices differ from DOM
      // positions. Resolve every preview from its stable message identity.
      const message = messages.get(id) || null, node = currentNodes.get(id);
      const line = root.document.createElement('div');
      line.className = 'message-rail-line';
      const head = root.document.createElement('span');
      head.className = 'message-rail-head';
      head.textContent = `${start + offset + 1}. ${labelFor(message)}`;
      const body = root.document.createElement('span');
      body.className = 'message-rail-text';
      body.textContent = summarize(message?.text || node?.textContent || '');
      line.append(head, body);
      box.append(line);
    }
    if (counts.aggregated && ids.length > PREVIEW_IN_GROUP) {
      const more = root.document.createElement('div');
      more.className = 'message-rail-more';
      more.textContent = T(`这一格还有 ${ids.length - PREVIEW_IN_GROUP} 条`, `+${ids.length - PREVIEW_IN_GROUP} more in this tick`);
      box.append(more);
    }
    rail.append(box);
    const railBox = rail.getBoundingClientRect();
    const tickBox = tick.getBoundingClientRect();
    box.style.top = `${Math.min(Math.max(0, tickBox.top - railBox.top - 8), Math.max(0, railBox.height - box.offsetHeight))}px`;
  }

  function hidePreview() {
    railHost()?.querySelector('[data-rail-preview]')?.remove();
  }

  function observeAll() {
    if (typeof root.IntersectionObserver !== 'function') return;
    const list = listHost(); if (!list) return;
    const current = new Set(nodes), ids = new Set(nodes.map(node => node.dataset.messageId));
    for (const id of visible.keys()) if (!ids.has(id)) visible.delete(id);
    if (!observer) observer = new root.IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!watched.has(entry.target)) continue;
        visible.set(entry.target.dataset.messageId, entry.isIntersecting);
      }
      paint();
    }, { root: list, threshold: 0.01 });
    for (const node of watched) if (!current.has(node)) { observer.unobserve(node); watched.delete(node); visible.delete(node.dataset.messageId); }
    for (const node of nodes) if (!watched.has(node)) { observer.observe(node); watched.add(node); }
  }

  // 把"哪些消息在视口里"映射到刻度：任何覆盖到可见消息的刻度都加深。
  function paint() {
    if (!ticks.length) return;
    const planInfo = plan(nodes.length);
    for (const tick of ticks) {
      const index = Number(tick.dataset.railIndex);
      const { start, end } = rangeOf(index, planInfo.span);
      let hit = false;
      for (let at = start; at < Math.min(end, nodes.length); at += 1) {
        if (visible.get(nodes[at]?.dataset.messageId)) { hit = true; break; }
      }
      tick.dataset.railActive = hit ? 'true' : 'false';
    }
  }

  // 消息内容变了（如流式重绘）→ 重新抓取消息元素做摘要；数量变了才重建刻度。
  function sync() {
    const list = listHost();
    if (!list) return { ok: false };
    const current = messageNodes(list);
    const signature = nodeSignature(current);
    nodes = current;
    if (signature !== lastSignature) {
      lastSignature = signature;
      return build();
    }
    observeAll();
    paint();
    return { ok: true, ticks: ticks.length };
  }

  function init(options = {}) {
    hooks = options || {};
    observer?.disconnect(); observer = null; watched.clear(); visible.clear(); clearTimeout(syncTimer);
    domObserver?.disconnect(); domObserver = null;
    const list = listHost();
    if (!list) return { ok: false, reason: 'missing-message-list' };
    const result = build();
    lastSignature = nodeSignature(nodes);
    // 重绘时重建（节流），但只在消息集合真的变化时才动 DOM。
    if (typeof root.MutationObserver === 'function') {
      domObserver = new root.MutationObserver(() => {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => { syncTimer = null; sync(); }, 300);
      });
      domObserver.observe(list, { childList: true, attributes: true, attributeFilter: ['data-conversation-id'] });
    }
    return result;
  }

  function stats() {
    return { ticks: ticks.length, messages: nodes.length, active: ticks.filter(tick => tick.dataset.railActive === 'true').length };
  }

  root.MessageRail = { init, sync, build, stats, _pure: { plan, summarize, labelFor, rangeOf, MAX_TICKS } };
  return root.MessageRail;
});
