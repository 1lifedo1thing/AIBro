/* Local activity ledger. Only recorded public run transitions become events. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ActivityCenter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  const MAX_EVENTS = 300, MAX_OBSERVED = 5000, PAGE_SIZE = 20;
  const STATUSES = new Set(['awaiting-approval', 'completed', 'completed-local', 'completed-local-fallback', 'failed', 'rejected', 'cancelled', 'interrupted']);
  const COLLECTIONS = { task: 'tasks', note: 'notes', import: 'imports', paper: 'papers', project: 'projects' };
  const CHANGES = new Set(['created', 'updated', 'appended', 'drafted', 'assigned', 'deleted', 'completed', 'reviewed']);
  const t = (zh, en) => /^en(?:-|$)/i.test(root.document?.documentElement.lang || '') ? en : zh;
  const privateItem = item => !!(item?.ephemeral || item?.incognito || item?.private);
  const available = item => !!item && !item.deleted && !item.deletedAt && !item.archived && !item.archivedAt && !['deleted', 'archived'].includes(item.status);
  const trim = (value, limit = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const list = value => Array.isArray(value) ? value : [];
  const stamp = run => `${run.status || ''}|${Number(run.finishedAt) || 0}`;
  const typeOf = status => status === 'awaiting-approval' ? 'approval' : status.startsWith('completed') ? 'completed' : status === 'failed' || status === 'interrupted' ? 'failed' : 'stopped';
  const ledger = state => state?.ui?.activityCenter?.version === 1 ? state.ui.activityCenter : null;
  const fault = (zh, en) => new Error(t(zh, en));
  function resultSummary(state, run) {
    const references = [], counts = {}, seen = new Set();
    for (const result of list(run.results)) {
      if (!COLLECTIONS[result?.type] || typeof result.id !== 'string') continue;
      const key = `${result.type}:${result.id}:${result.operation || ''}`;
      if (seen.has(key)) continue;
      const item = list(state[COLLECTIONS[result.type]]).find(item => item.id === result.id);
      if (privateItem(item)) continue;
      seen.add(key);
      if (CHANGES.has(result.operation)) counts[result.type] = (counts[result.type] || 0) + 1;
      if (references.length >= 6) continue;
      references.push({ kind: result.type, id: result.id, operation: CHANGES.has(result.operation) ? result.operation : '', title: trim(item?.title || item?.name || result.type, 160) });
    }
    return { references, counts, resultCount: seen.size };
  }
  function capture(state, options = {}) {
    if (!state || typeof state !== 'object') return { changed: false, added: 0 };
    state.ui ||= {};
    if (state.ui.activityCenter && state.ui.activityCenter.version !== 1) return { changed: false, added: 0, unsupported: true };
    const now = Number(options.now) || Date.now(), baseline = !ledger(state);
    if (baseline) state.ui.activityCenter = { version: 1, initializedAt: now, events: [], observed: [], nextSeq: 1, lastViewedSeq: 0, lastViewedAt: 0, droppedCount: 0, lastDroppedSeq: 0, ignoredBefore: 0 };
    const data = ledger(state), conversations = new Map(list(state.conversations).map(item => [item.id, item]));
    const runs = list(state.agentRuns), byRun = new Map(runs.map(item => [item.id, item]));
    const observed = new Map(list(data.observed).map(item => [item.id, item]));
    let changed = baseline, added = 0;
    // A later privacy conversion removes previous public snapshots too. Missing
    // sources remain as history, but private source identities never survive.
    const kept = list(data.events).filter(event => !privateItem(conversations.get(event.conversationId)) && !privateItem(byRun.get(event.runId)));
    if (kept.length !== list(data.events).length) { data.events = kept; changed = true; }
    for (const [id] of observed) {
      const run = byRun.get(id);
      if (run && (privateItem(run) || privateItem(conversations.get(run.conversationId)))) { observed.delete(id); changed = true; }
    }
    for (const run of runs) {
      const conversation = conversations.get(run?.conversationId);
      if (!run?.id || !conversation || privateItem(run) || privateItem(conversation)) continue;
      // An approval execution becomes visible only after its atomic workspace
      // write is acknowledged. Failed writes remain awaiting-save in the host.
      if (run.approvalReceipt?.savePending === true && String(run.status).startsWith('completed')) continue;
      const previous = observed.get(run.id), key = stamp(run), startedAt = Number(run.startedAt) || 0;
      if (previous?.stamp === key) continue;
      // A capped-out old run must not become new again on the next scan.
      if (!previous && !baseline && startedAt <= data.ignoredBefore && data.ignoredBefore) continue;
      const revision = (previous?.revision || 0) + 1;
      observed.set(run.id, { id: run.id, stamp: key, startedAt, revision, active: !STATUSES.has(run.status) || run.status === 'awaiting-approval' }); changed = true;
      if (baseline || !STATUSES.has(run.status) || run.deletedAt) continue;
      const summary = resultSummary(state, run), seq = data.nextSeq++;
      data.events.push({ id: `activity:${run.id}:${revision}`, seq, runId: run.id, conversationId: conversation.id,
        projectId: run.projectId || conversation.projectId || null, title: trim(run.goal || conversation.title) || t('Agent 执行', 'Agent run'),
        status: run.status, kind: typeOf(run.status), occurredAt: Number(run.finishedAt) || (run.status === 'awaiting-approval' ? Number(run.updatedAt) : 0) || now,
        observedAt: now, timeEstimated: !Number(run.finishedAt) && !Number(run.updatedAt), ...summary, readAt: null, archivedAt: null }); added += 1;
    }
    if (observed.size > MAX_OBSERVED) {
      const sorted = [...observed.values()].sort((a, b) => Number(a.active) - Number(b.active) || a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      for (const item of sorted.slice(0, observed.size - MAX_OBSERVED)) { observed.delete(item.id); data.ignoredBefore = Math.max(data.ignoredBefore, item.startedAt); }
      data.observationLimited = true; changed = true;
    }
    if (changed) data.observed = [...observed.values()];
    if (data.events.length > MAX_EVENTS) {
      const removed = data.events.splice(0, data.events.length - MAX_EVENTS);
      data.droppedCount += removed.length; data.lastDroppedSeq = Math.max(data.lastDroppedSeq, ...removed.map(event => event.seq)); changed = true;
    }
    return { changed, added, baseline };
  }
  function unreadCount(state) { return list(ledger(state)?.events).filter(event => !event.readAt && !event.archivedAt).length; }
  function sourceState(state, event, reference) {
    const conversation = list(state?.conversations).find(item => item.id === event.conversationId);
    const run = list(state?.agentRuns).find(item => item.id === event.runId);
    if (privateItem(conversation) || privateItem(run)) return { available: false, reason: t('来源处于无痕会话，无法打开。', 'This source belongs to a private conversation.') };
    if (reference) {
      const item = list(state?.[COLLECTIONS[reference.kind]]).find(item => item.id === reference.id);
      if (!available(item) || privateItem(item)) return { available: false, reason: t('这项结果已删除或归档，通知保留的是当时的记录。', 'This result was deleted or archived. The activity retains its historical record.') };
      return { available: true, target: { kind: reference.kind, id: reference.id, conversationId: event.conversationId, runId: event.runId } };
    }
    if (!available(conversation)) return { available: false, reason: t('来源对话已删除或归档，通知保留的是当时的记录。', 'The source conversation was deleted or archived. This is a historical record.') };
    if (!available(run)) return { available: false, reason: t('执行记录已删除或归档。', 'The run was deleted or archived.') };
    return { available: true, outdated: event.status === 'awaiting-approval' && run.status !== 'awaiting-approval', target: { kind: 'conversation', id: conversation.id, conversationId: conversation.id, runId: run.id } };
  }
  function digest(state, sinceSeq = ledger(state)?.lastViewedSeq || 0) {
    const data = ledger(state), events = list(data?.events).filter(event => event.seq > sinceSeq), counts = { approval: 0, completed: 0, failed: 0, stopped: 0 }, changes = {}, projects = new Map(), latestRuns = new Map();
    for (const event of events) {
      counts[event.kind] = (counts[event.kind] || 0) + 1;
      if (!latestRuns.has(event.runId) || latestRuns.get(event.runId).seq < event.seq) latestRuns.set(event.runId, event);
      const id = event.projectId || ''; projects.set(id, (projects.get(id) || 0) + 1);
    }
    // Approval and completion may carry the same result list. The digest uses
    // each run's latest captured results instead of counting them twice.
    for (const event of latestRuns.values()) for (const [kind, count] of Object.entries(event.counts || {})) changes[kind] = (changes[kind] || 0) + count;
    return { total: events.length, counts, changes, projects: [...projects].map(([id, count]) => ({ id, count })), truncated: sinceSeq < (data?.lastDroppedSeq || 0), latestSeq: (data?.nextSeq || 1) - 1 };
  }
  function query(state, filters = {}) {
    const all = list(ledger(state)?.events).filter(event => filters.archived ? !!event.archivedAt : !event.archivedAt)
      .filter(event => !filters.unread || !event.readAt).filter(event => !filters.kind || event.kind === filters.kind)
      .filter(event => !filters.projectId || (filters.projectId === '__none__' ? !event.projectId : event.projectId === filters.projectId)).sort((a, b) => b.seq - a.seq);
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE)), page = Math.min(pages - 1, Math.max(0, Number(filters.page) || 0));
    return { events: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), total: all.length, page, pages, ids: all.map(event => event.id) };
  }
  function createController(host = {}) {
    let busy = false;
    const get = () => { const state = host.getState?.(); if (!ledger(state)) throw fault('活动记录尚未准备好，请稍后重试。', 'Activity is not ready yet. Please retry shortly.'); return state; };
    async function commit(patches) {
      if (busy) throw fault('正在保存活动状态。', 'Activity changes are being saved.');
      if (typeof host.save !== 'function') throw fault('活动状态保存尚未连接。', 'Activity saving is not connected.');
      const state = get(), data = ledger(state), changes = [];
      for (const patch of patches) {
        const object = patch.id ? data.events.find(event => event.id === patch.id) : data;
        if (!object || !['readAt', 'archivedAt', 'lastViewedSeq', 'lastViewedAt'].includes(patch.field)) continue;
        const before = object[patch.field], after = patch.value;
        if (before === after) continue;
        changes.push({ ...patch, before, after }); object[patch.field] = after;
      }
      if (!changes.length) return true;
      busy = true; host.onChanged?.();
      try { if (await host.save() === false) throw fault('活动状态未能保存，请重试。', 'Activity could not be saved. Please retry.'); return true; }
      catch (error) {
        const current = ledger(host.getState?.());
        if (current) for (const change of changes) { const object = change.id ? current.events.find(event => event.id === change.id) : current; if (object && object[change.field] === change.after) object[change.field] = change.before; }
        throw error;
      } finally { busy = false; host.onChanged?.(); }
    }
    const mark = (ids, field, value) => commit([...new Set(ids)].map(id => ({ id, field, value })));
    async function view() { const data = ledger(get()), since = data.lastViewedSeq || 0, latest = data.nextSeq - 1; await commit([{ field: 'lastViewedSeq', value: latest }, { field: 'lastViewedAt', value: Date.now() }]); return since; }
    async function openSource(id, referenceIndex) {
      const state = get(), event = ledger(state).events.find(event => event.id === id);
      if (!event) throw fault('这条活动已不在保留范围内。', 'This activity is no longer retained.');
      const reference = referenceIndex == null ? null : event.references?.[referenceIndex];
      if (referenceIndex != null && !reference) throw fault('这项来源不存在。', 'This source is unavailable.');
      const source = sourceState(state, event, reference);
      if (!source.available) throw new Error(source.reason);
      if (typeof host.openTarget !== 'function' || await host.openTarget(source.target) === false) throw fault('没有打开来源；请先处理当前编辑，再重试。', 'The source did not open. Finish the current edit and retry.');
      return true;
    }
    return { view, markRead: (ids, read = true) => mark(ids, 'readAt', read ? Date.now() : null), archive: (ids, archived = true) => mark(ids, 'archivedAt', archived ? Date.now() : null), openSource, isBusy: () => busy };
  }

  let hooks = {}, controller = null, dialog = null, mount = null, opener = null, composing = false, navigationBusy = false, suspendedCloseEvents = 0, error = '', notice = '', epoch = 0, since = 0, filters = {};
  const badges = new Set();
  const inPrivate = () => !!(hooks.isPrivate?.() || root.PrivateMode?.isOn?.());
  function refresh() {
    const state = hooks.getState?.();
    for (const element of badges) { if (!element.isConnected) { badges.delete(element); continue; } root.HalaskaUI?.mount(element, 'ActivityCenterBadge', { count: inPrivate() ? 0 : unreadCount(state) }); }
    if (dialog?.open && inPrivate()) { dialog.close(); return; }
    if (!dialog?.open) return;
    const data = ledger(state), result = query(state, filters); filters.page = result.page;
    const projects = new Map();
    for (const event of list(data?.events)) if (event.projectId) projects.set(event.projectId, list(state.projects).find(item => item.id === event.projectId)?.name || t('已删除的项目', 'Deleted project'));
    root.HalaskaUI?.mount(mount, 'ActivityCenterSurface', { ...result, filters, projects: [...projects].map(([id, name]) => ({ id, name })), digest: digest(state, since), unread: unreadCount(state), busy: controller?.isBusy() || navigationBusy, error, notice: typeof notice === 'function' ? notice() : notice,
      initializedAt: data?.initializedAt, limited: data?.droppedCount > 0, observationLimited: data?.observationLimited, source: event => sourceState(state, event),
      onFilter: (field, value) => { filters = { ...filters, [field]: value, page: 0 }; error = ''; notice = ''; refresh(); },
      onPage: page => { filters.page = page; refresh(); dialog.querySelector('.activity-center-list')?.scrollTo?.({ top: 0 }); },
      onRead: (id, read) => action(() => controller.markRead([id], read), () => t('已更新已读状态。', 'Read state updated.')),
      onArchive: (id, archived) => action(() => controller.archive([id], archived), () => archived ? t('已归档，可在归档中恢复。', 'Archived. You can restore it from the archive.') : t('已恢复到收件箱。', 'Restored to the inbox.')),
      onMarkFiltered: () => action(() => controller.markRead(result.ids), () => t('已将当前筛选结果标为已读。', 'The filtered activities are marked as read.')),
      onSource: (id, index) => navigate(id, index), onClose: close,
    });
  }
  async function action(fn, message) {
    const token = epoch; error = ''; notice = '';
    try { const pending = fn(); refresh(); await pending; if (epoch === token) notice = message; return true; }
    catch (failure) { if (epoch === token) error = failure.message; return false; }
    finally { refresh(); }
  }
  async function navigate(id, index) {
    if (controller?.isBusy() || navigationBusy || inPrivate()) return;
    // The editor's leave decision is inline, outside this modal. Temporarily
    // release modal inertness, retaining the logical open state for the native
    // shell. Cancelled navigation restores this exact filtered list.
    const token = epoch; error = ''; navigationBusy = true; refresh();
    suspendedCloseEvents += 1; dialog.close();
    try { await controller.openSource(id, index); if (token === epoch) finishClose(false); }
    catch (failure) { if (token === epoch && !inPrivate()) { error = failure.message; dialog.showModal(); } }
    finally { navigationBusy = false; refresh(); hooks.onChanged?.(); }
  }
  function finishClose(restoreFocus = true) {
    epoch += 1; root.HalaskaUI?.unmount(mount);
    if (restoreFocus) {
      const visible = element => element?.isConnected && element.getClientRects().length && !element.closest('[inert], [hidden]') && root.getComputedStyle(element).visibility !== 'hidden';
      const target = visible(opener) ? opener : [...root.document.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)')].find(element => !element.closest('dialog:not([open])') && visible(element));
      target?.focus({ preventScroll: true });
    }
    opener = null; hooks.onChanged?.();
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = root.document.createElement('dialog'); dialog.id = 'activityCenterDialog'; dialog.className = 'activity-center-dialog'; dialog.setAttribute('aria-labelledby', 'activityCenterTitle');
    mount = root.document.createElement('div'); dialog.append(mount); root.document.body.append(dialog);
    dialog.addEventListener('compositionstart', () => { composing = true; }); dialog.addEventListener('compositionend', () => { composing = false; });
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!composing && !event.isComposing) close(); });
    dialog.addEventListener('close', () => { if (suspendedCloseEvents) { suspendedCloseEvents -= 1; return; } finishClose(); });
  }
  function open(element) {
    if (inPrivate()) { hooks.toast?.(t('请先退出无痕模式，再查看普通工作区动态。', 'Leave private mode before viewing workspace activity.')); return false; }
    if (!controller || !ledger(hooks.getState?.())) { hooks.toast?.(t('活动记录正在准备，请稍后重试。', 'Activity is being prepared. Please retry shortly.')); return false; }
    ensureDialog(); if (dialog.open || navigationBusy) return true;
    opener = element || root.document.activeElement; filters = { archived: false, unread: false, kind: '', projectId: '', page: 0 }; error = ''; notice = ''; since = ledger(hooks.getState()).lastViewedSeq || 0; epoch += 1;
    dialog.showModal(); refresh(); dialog.querySelector('button')?.focus({ preventScroll: true });
    void action(() => controller.view(), ''); return true;
  }
  function close() { if (!dialog?.open || controller?.isBusy() || navigationBusy) return false; dialog.close(); return true; }
  function init(host) { hooks = host || {}; controller = createController({ ...hooks, onChanged: () => { refresh(); hooks.onChanged?.(); } }); refresh(); return controller; }
  function mountBadge(element) { if (element) { badges.add(element); refresh(); } }
  root.document?.addEventListener('workstation-language-change', refresh);
  return { capture, unreadCount, digest, query, sourceState, resultSummary, createController, init, refresh, open, close, mountBadge, isOpen: () => !!dialog?.open || navigationBusy, isBusy: () => !!controller?.isBusy() || navigationBusy, MAX_EVENTS, MAX_OBSERVED, PAGE_SIZE };
});
