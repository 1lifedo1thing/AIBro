(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ToolLoopGuard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 工具空转预警：同一个工具、同一组关键参数被反复调用时，往往不是"再做一次就有结果"，
  // 而是模型在原地打转——每一轮都要重新发一次完整上下文，代价由用户支付。
  // 这里只做**机械判定**（参数逐字相同、计数达阈值），不做任何语义猜测：
  // 参数不同（例如分页 offset 变化）不会被计入，因此正常的分批读取不会误伤。
  const LIMIT = 4;

  // 与 ToolScheduler.safeRequest 同一组关键字段：判定的是"是不是同一个调用"。
  const KEY_FIELDS = ['type', 'id', 'recordType', 'query', 'offset', 'page', 'refKey', 'variant', 'chunkId', 'version', 'radius', 'argv', 'cwd', 'timeout', 'task', 'title', 'url', 'name', 'messageId', 'maxTokens', 'runId','tabId','sessionId','snapshotId','ref','text','x','y'];

  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

  function signature(request) {
    if (!request || typeof request.type !== 'string') return '';
    const normalized = { ...request };
    if (['read', 'read_file', 'list', 'search', 'task_list', 'wiki_list', 'memory_read', 'history_read', 'history_search', 'library_overview', 'evidence_log'].includes(normalized.type)) normalized.offset ??= 0;
    if (['read', 'read_page'].includes(normalized.type)) normalized.recordType ||= 'note';
    if (normalized.type === 'read') normalized.variant ||= 'current';
    if (normalized.type === 'read_page') normalized.page ??= 1;
    if (normalized.type === 'neighbors') normalized.radius ??= 1;
    const parts = {};
    for (const key of KEY_FIELDS) {
      if (normalized[key] !== undefined) parts[key] = canonical(normalized[key]);
    }
    return JSON.stringify(parts);
  }

  function tally(toolCalls) {
    const counts = new Map();
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
      if (!call || !call.request) continue;
      // A fresh page observation after a real browser action is progress.
      // Repeated observations with no intervening action still trip the guard.
      if(call.status==='completed'&&/^browser_(open|click|type|scroll|handoff)$/.test(call.request.type))for(const [key,value] of counts)if(['browser_snapshot','browser_screenshot'].includes(value.type))counts.delete(key);
      // 只统计真正走到执行的调用：排队中/被取消的不算"反复尝试"。
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(call.status)) continue;
      if (['cancelled', 'interrupted'].includes(call.status) && !call.startedAt) continue;
      const key = signature(call.request);
      if (!key) continue;
      const current = counts.get(key) || { key, type: call.request.type, count: 0, ids: [] };
      current.count += 1;
      if (current.ids.length < 3) current.ids.push(call.id);
      counts.set(key, current);
    }
    return counts;
  }

  // 返回超过阈值的调用（通常只有一个；按次数从多到少排列，便于如实说明）。
  function inspect(toolCalls, limit = LIMIT, requests) {
    const threshold = Number.isFinite(limit) && limit > 0 ? limit : LIMIT;
    const requested = Array.isArray(requests) ? new Set(requests.map(signature)) : null;
    const repeated = [...tally(toolCalls).values()].filter(item => item.count >= threshold && (!requested || requested.has(item.key))).sort((a, b) => b.count - a.count);
    return { limit: threshold, repeated };
  }

  function describe(item, limit = LIMIT) {
    if (!item) return '';
    return `检测到重复调用：${item.type} 已用相同参数调用 ${item.count} 次（上限 ${limit}）。已停止本轮以免继续空转——每一步都会重新发送完整上下文，继续下去只会消耗额度。请调整指令或参数后重发；若确实需要多次读取同一对象，请在指令中说明原因。`;
  }

  return Object.freeze({ LIMIT, KEY_FIELDS, signature, tally, inspect, describe });
}));
