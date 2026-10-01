/* 页内查找（⌘F，对齐 NewMax §2.7）：在对话内查找文字。
   三条与体验直接相关的规则：
   · 命中高亮并显示「第 X / 共 Y 个匹配」，可上下跳转；
   · 命中落在收起的折叠块（深度思考 / 工具记录 / 执行过程）里时自动展开——
     否则用户会遇到“搜到了但看不到”；
   · 只读 DOM：不改消息内容、不改数据、不触发任何保存。
   高亮用 CSS Custom Highlight API（不改 DOM 结构，因此不与流式重绘冲突）；
   环境不支持时查找与跳转照常可用，只是没有底色。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FindInConversation = api;
})(globalThis, root => {
  'use strict';
  const MAX_HITS = 800;          // 上限保护：超长对话不做无界高亮
  const DEBOUNCE = 260;          // 流式重绘期间的重新计算间隔
  let hooks = {};
  let hits = [];
  let index = -1;
  let query = '';
  let observer = null;
  let timer = null;
  let contentListener = null, watchedHost = null;
  let generation = 0, searchAbort = null, searching = false, composing = false, capped = false, searchError = '', progress = null;
  let resultController = null, resultConversation = '', hasResult = false;
  const windowController = host => { const controller = root.ConversationWindow?.active?.(host); return controller?.isWindowed?.() || controller?.entries?.().some(message => root.SafePreview?.needsPreview?.(message.text)) ? controller : null; };
  const conversationId = host => String(host?.dataset?.conversationId || '');
  const hitKey = hit => hit?.messageId ? JSON.stringify([hit.messageId, hit.path, hit.start, hit.end, hit.text]) : null;
  function abortSearch() { generation++; searchAbort?.abort(); searchAbort = null; searching = false; progress = null; }


  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  const $ = selector => document.querySelector(selector);

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  // 不区分大小写、逐字面匹配；空查询返回空结果（不把“没输入”当成“匹配全部”）。
  function matchRanges(text, needle) {
    const source = String(text == null ? '' : text);
    const target = String(needle == null ? '' : needle);
    if (!target) return [];
    const haystack = source.toLowerCase();
    const wanted = target.toLowerCase();
    const out = [];
    let from = 0;
    while (out.length < MAX_HITS) {
      const at = haystack.indexOf(wanted, from);
      if (at < 0) break;
      out.push({ start: at, end: at + wanted.length });
      from = at + wanted.length;
    }
    return out;
  }

  function countIn(texts, needle) {
    let total = 0;
    for (const text of texts) total += matchRanges(text, needle).length;
    return total;
  }

  // 「第 2 / 共 7 个匹配」；无命中时如实说没有，不显示 0/0 这种空计数。
  function labelText(position, total) {
    if (!total) return T('无匹配', 'No matches');
    return T(`第 ${position} / 共 ${total} 个匹配`, `${position} of ${total} matches`);
  }

  // ── DOM 收集 ──────────────────────────────────────────────
  function searchableNodes(container) {
    const nodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,textarea,input,select')) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function collect(needle) {
    const host = hooks.getRoot && hooks.getRoot();
    if (!host || !needle) return [];
    const out = [];
    for (const node of searchableNodes(host)) {
      for (const range of matchRanges(node.nodeValue, needle)) {
        out.push({ node, start: range.start, end: range.end });
        if (out.length >= MAX_HITS) return out;
      }
    }
    return out;
  }

  // ── 高亮（Custom Highlight API；不支持时静默跳过，不影响查找） ──
  function clearPaint() {
    if (root.CSS && root.CSS.highlights) {
      root.CSS.highlights.delete('find-all');
      root.CSS.highlights.delete('find-current');
    }
  }

  // Resolve only already-mounted content. Highlighting every result must never
  // materialize all history or keep detached row/Text references in the index.
  function mountedHit(hit, rows) {
    if (!hit?.messageId) return hit?.node?.isConnected === false ? null : hit;
    const host = hooks.getRoot?.();
    if (conversationId(host) !== resultConversation) return null;
    const row = rows ? rows.get(hit.messageId) : [...(host?.children || [])].find(node => node.dataset?.messageId === hit.messageId);
    if (!row) return null;
    let node = row;
    for (const index of hit.path || []) { node = node?.childNodes?.[index]; if (!node) break; }
    const matches = candidate => candidate?.nodeType === 3 && candidate.nodeValue === hit.text && hit.start >= 0 && hit.end <= candidate.nodeValue.length;
    if (matches(node)) return { node, start: hit.start, end: hit.end };
    // A rendered island may move its text after its queued mount. Rebind only
    // a unique exact Text value; an ambiguous label is not a safe location.
    const candidates = searchableNodes(row).filter(matches);
    return candidates.length === 1 ? { node: candidates[0], start: hit.start, end: hit.end } : null;
  }
  function paint() {
    clearPaint();
    if (!hits.length) return;
    if (!(root.CSS && root.CSS.highlights && root.Highlight)) return;
    const all = new root.Highlight();
    const current = new root.Highlight();
    const rows = resultController ? new Map([...(hooks.getRoot?.()?.children || [])].map(node => [node.dataset?.messageId, node])) : null;
    hits.forEach((hit, at) => {
      const located = mountedHit(hit, rows); if (!located) return;
      const range = document.createRange();
      try { range.setStart(located.node, located.start); range.setEnd(located.node, located.end); }
      catch (error) { return; }
      if (at === index) current.add(range); else all.add(range);
    });
    if (all.size) root.CSS.highlights.set('find-all', all);
    if (current.size) root.CSS.highlights.set('find-current', current);
  }

  // 跳转到第 at 个命中；返回是否为此展开了被收起的折叠块。
  function revealAt(at) {
    const descriptor = hits[at];
    if (!descriptor) return false;
    const host = hooks.getRoot?.();
    if (descriptor.messageId && (conversationId(host) !== resultConversation || root.ConversationWindow?.active?.(host) !== resultController)) return false;
    const hit = descriptor.messageId ? resultController?.ensureHit?.(descriptor) : mountedHit(descriptor);
    if (!hit?.node?.isConnected) return false;
    let opened = false;
    let node = hit.node.parentElement;
    while (node) {
      if (node.tagName === 'DETAILS' && !node.open) { node.open = true; opened = true; }
      if (node.classList && node.classList.contains('message-wrap')) break;
      node = node.parentElement;
    }
    const target=hit.node.parentElement;
    if(target&&!root.ConversationReading?.reveal(target))target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    paint();
    return opened;
  }

  function renderBar() {
    const bar = $('#findBar');
    if (!bar) return;
    const field = $('#findInput');
    if (field && !composing && field.value !== query) field.value = query;
    const count = $('#findCount');
    const suffix = capped ? T(' · 已显示前 800 个匹配', ' · Showing the first 800 matches') : '';
    if (count) count.textContent = searching ? T('正在搜索全部对话…', 'Searching the whole conversation…') + (progress ? ` ${progress}` : '') : searchError || (query ? labelText(index + 1, hits.length) + suffix : T('输入以查找', 'Type to find'));
    bar.setAttribute('aria-busy', String(searching));
    bar.dataset.empty = query && !searching && !searchError && !hits.length ? 'true' : 'false';
    const prev = $('#findPrev'); const next = $('#findNext');
    if (prev) prev.disabled = searching || !hits.length;
    if (next) next.disabled = searching || !hits.length;
  }

  function acceptHits(nextHits, previous, previousIndex, keepIndex) {
    hits = nextHits;
    if (!hits.length) index = -1;
    else if (keepIndex && previous) {
      const identity = hitKey(previous);
      const found = hits.findIndex(hit => identity ? hitKey(hit) === identity : hit.node === previous.node && hit.start === previous.start);
      index = found >= 0 ? found : Math.max(0, Math.min(previousIndex, hits.length - 1));
    } else index = 0;
    hasResult = true; paint(); renderBar();
    // Background changes update counters/highlights, never reading position.
    if (index >= 0 && !keepIndex) revealAt(index);
  }
  function run(nextQuery, keepIndex) {
    if (composing) return;
    const host = hooks.getRoot?.(), controller = windowController(host), ownerId = conversationId(host);
    const value = String(nextQuery == null ? query : nextQuery);
    if (!keepIndex && value === query && controller === resultController && ownerId === resultConversation && (searching || hasResult)) return;
    const previous = hits[index], previousIndex = index;
    abortSearch(); query = value; capped = false; searchError = ''; hasResult = false;
    resultController = controller; resultConversation = ownerId;
    if (!query) { hits = []; index = -1; clearPaint(); renderBar(); return; }
    if (!controller) { acceptHits(collect(query), previous, previousIndex, keepIndex); return; }
    const version = generation, abort = new root.AbortController(); searchAbort = abort;
    searching = true; hits = []; index = -1; clearPaint(); renderBar();
    const current = () => version === generation && !abort.signal.aborted && isOpen() && !composing
      && hooks.getRoot?.() === host && conversationId(host) === ownerId && root.ConversationWindow?.active?.(host) === controller;
    Promise.resolve().then(() => current() ? controller.searchRows(value, { signal: abort.signal, onProgress: info => {
      if (!current()) return;
      const done = typeof info === 'number' ? info : info?.processed ?? info?.done ?? info?.scanned;
      const total = info?.total;
      if (Number.isFinite(done)) { progress = Number.isFinite(total) ? `${done} / ${total}` : String(done); renderBar(); }
    } }) : null).then(result => {
      if (!current()) return;
      searching = false; searchAbort = null; progress = null; capped = !!result?.capped;
      acceptHits((Array.isArray(result?.hits) ? result.hits : []).slice(0, MAX_HITS), previous, previousIndex, keepIndex);
    }).catch(error => {
      if (!current()) return;
      searching = false; searchAbort = null; progress = null; hits = []; index = -1;
      if (error?.name !== 'AbortError') searchError = T('查找未完成，请重新输入关键词。', 'Search did not finish. Enter the query again.');
      clearPaint(); renderBar();
    });
  }

  function step(delta) {
    if (searching || composing || !hits.length) return;
    index = (index + delta + hits.length) % hits.length;
    paint();
    renderBar();
    revealAt(index);
  }

  // ── 对外行为 ──────────────────────────────────────────────
  function open(initial) {
    const bar = $('#findBar');
    if (!bar) return false;
    bar.hidden = false;
    const field = $('#findInput');
    if (field) {
      if (typeof initial === 'string') field.value = initial;
      field.focus();
      field.select();
    }
    watch();
    run(field ? field.value : '', false);
    return true;
  }

  function close() {
    const bar = $('#findBar');
    if (bar) bar.hidden = true;
    unwatch(); abortSearch(); composing = false; hasResult = false; resultController = null; resultConversation = ''; capped = false; searchError = '';
    hits = []; index = -1; query = '';
    clearPaint();
  }

  // 查找栏打开期间，对话 DOM 可能因流式输出而重建——重新计算并尽量停在原命中。
  function watch() {
    unwatch();
    const host = hooks.getRoot?.();
    if (!host) return;
    watchedHost = host;
    const scheduleSearch = () => {
      clearTimeout(timer); abortSearch();
      if (!isOpen() || composing) return;
      // Content is already stale during the debounce; don't allow navigation
      // through old descriptors while the replacement scan is still queued.
      searching = !!query; renderBar();
      timer = setTimeout(() => { timer = null; if (isOpen() && !composing) run(query, true); }, DEBOUNCE);
    };
    // Streaming must not endlessly cancel a search through settled history.
    // Allow the current scan to finish, then refresh at most once per interval.
    // Explicit jumps still validate the current row's exact Text before use.
    const scheduleStream = () => {
      if (timer || !isOpen()) return;
      timer = setTimeout(() => { timer = null; if (!isOpen()) return; if (searching || composing) scheduleStream(); else run(query, true); }, 600);
    };
    contentListener = event => event?.detail?.kind === 'stream' ? scheduleStream() : scheduleSearch();
    host.addEventListener('conversation-window-content', contentListener);
    if (typeof root.MutationObserver !== 'function') return;
    observer = new root.MutationObserver(() => {
      if (!isOpen()) return;
      const controller = windowController(host);
      if (conversationId(host) !== resultConversation || controller !== resultController) { scheduleSearch(); return; }
      if (controller || resultController) { if (!searching) paint(); return; }
      clearTimeout(timer); timer = setTimeout(() => { if (isOpen() && !composing) run(query, true); }, DEBOUNCE);
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-conversation-id'] });
  }
  function unwatch() {
    clearTimeout(timer); timer = null;
    if (observer) { observer.disconnect(); observer = null; }
    if (watchedHost && contentListener) watchedHost.removeEventListener('conversation-window-content', contentListener);
    watchedHost = null; contentListener = null;
  }

  function isOpen() {
    const bar = $('#findBar');
    return !!(bar && !bar.hidden);
  }

  function init(options) {
    hooks = options || {};
    const bar = $('#findBar');
    if (!bar) return { ok: false, reason: 'missing-find-bar' };
    const field = $('#findInput');
    field?.addEventListener('input', event => { if (composing || event.isComposing) return; run(event.target.value, false); });
    field?.addEventListener('compositionstart', () => { composing = true; abortSearch(); clearTimeout(timer); });
    field?.addEventListener('compositionend', event => { composing = false; hasResult = false; run(event.target.value, false); });
    field?.addEventListener('keydown', event => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    $('#findNext')?.addEventListener('click', () => { step(1); });
    $('#findPrev')?.addEventListener('click', () => { step(-1); });
    $('#findClose')?.addEventListener('click', () => close());
    return { ok: true };
  }

  function stats() { return { query, hits: hits.length, index, open: isOpen(), searching, capped, error: searchError }; }

  root.FindInConversation = { init, open, close, next: () => step(1), prev: () => step(-1), stats, isOpen,
    _pure: { matchRanges, countIn, labelText } };
  return root.FindInConversation;
});
