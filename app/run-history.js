(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkstationRunHistory = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const array = value => Array.isArray(value) ? value : [];
  const text = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const statuses = { running: '执行中', 'awaiting-save': '等待保存结果', 'awaiting-approval': '等待审批', completed: '已完成', 'completed-local': '已完成 · 本地', 'completed-local-fallback': '已完成 · 本地', failed: '执行失败', cancelled: '已停止', rejected: '已拒绝', interrupted: '已中断' };
  const statusLabel = value => Object.hasOwn(statuses, value) ? statuses[value] : (value ? `状态：${text(value)}` : '未记录状态');
  const stamp = value => { const number = typeof value === 'number' || /^\d+$/.test(text(value)) ? Number(value) : Date.parse(value); return Number.isFinite(number) && Number.isFinite(new Date(number).getTime()) ? number : 0; };
  const date = value => { const number = stamp(value); return number ? new Date(number).toLocaleString('zh-CN') : '未记录'; };
  function trashIds(state) {
    const runs = new Set(), conversations = new Set();
    array(state.trash).forEach(entry => {
      [...array(entry?.data?.runs), ...array(entry?.data?.agentRuns)].forEach(run => { if (run?.id) runs.add(run.id); });
      array(entry?.data?.conversations).forEach(conversation => { if (conversation?.id) conversations.add(conversation.id); });
    });
    return { runs, conversations };
  }
  function presentation(state, run, environment = root) {
    if (!run) return { status: '', label: '未记录状态', tone: 'default', error: '' };
    const receipt = run.executionReceipt;
    // An unconfirmed receipt wins over legacy terminal status. It is a saved
    // continuation boundary, not a failed request that should call the model
    // again. Approval retains its existing, separately acknowledged contract.
    if (!run.approvalReceipt && receipt?.version === 1 && ['prepared', 'applied'].includes(receipt.phase) && run.status !== 'rejected') {
      const prepared = receipt.phase === 'prepared', reviewing = prepared && run.status === 'awaiting-approval', running = prepared && run.status === 'running';
      return { status: reviewing ? 'awaiting-approval' : running ? 'running' : prepared ? 'interrupted' : 'awaiting-save',
        label: reviewing ? '计划已保留 · 等待审批' : running ? '计划已保留 · 执行中' : prepared ? '计划已保留 · 可继续整理' : '操作已应用 · 等待保存确认', tone: running ? 'accent' : 'pending',
        error: text(receipt.error), historicalIssue: false, recoveryPhase: receipt.phase,
        hint: reviewing ? '请打开原对话审阅并批准保留的计划。' : running ? '本轮仍在执行中，请在原对话查看进展。' : prepared
          ? '请打开原对话继续整理；继续前会重新校验计划与当前权限。'
          : '请打开原对话继续保存现有结果；不会重新调用模型或再次执行这些操作。', diagnosticDetails: [] };
    }
    const conversation = array(state.conversations).find(item => item?.id === run.conversationId);
    let message = array(conversation?.messages).find(item => item && item.role !== 'user' && (item.runId || item.pendingRunId || item.retryRunId) === run.id);
    const protocol = message && environment.AgentTransport?.inspectProtocolOutput?.(message.text || '', { final: true });
    const issue = environment.WorkstationCore?.responseIssue?.(message, run, protocol);
    let shown = issue ? { ...run, status: 'failed', error: issue.text, errorCode: issue.code } : run;
    if (issue) message = { ...message, text: issue.text, runStatus: 'failed', retryRunId: run.id, historicalResponseIssue: true };
    if (run.approvalReceipt?.savePending) { shown = { ...shown, status: 'awaiting-save' }; message = { ...message, text: run.approvalReceipt.baseText ?? message?.text, pendingRunId: run.id, runStatus: 'awaiting-save' }; }
    const outcome = environment.RunOutcomePresentation?.present?.(message || {}, shown, { responseIssue: issue });
    const status = text(shown.status);
    return { status, label: issue && status === 'failed' ? '未完成 · 旧记录已核正' : (outcome?.statusLabel || statusLabel(status)),
      tone: ['failed', 'rejected'].includes(status) ? 'error' : ['running'].includes(status) ? 'accent' : status?.startsWith('completed') ? 'online' : ['awaiting-save', 'awaiting-approval', 'interrupted'].includes(status) ? 'pending' : 'default',
      error: issue?.text || outcome?.noticeDescription || text(run.error), historicalIssue: !!issue,
      hint: outcome?.hint || '', diagnosticDetails: array(outcome?.diagnosticDetails) };
  }
  const resultCollections = { project: 'projects', task: 'tasks', note: 'notes', import: 'imports', paper: 'papers' };
  const resultTypes = { project: '项目', task: '任务', note: '知识', import: '资料', paper: '论文' };
  const activeRecord = item => !!item && !item.archived && !item.archivedAt && !item.deleted && !item.deletedAt && !item.tombstone && !item.wikiFileError && !['archived', 'deleted'].includes(item.status);
  function privateRecord(state, ...initial) {
    const queue = initial, seen = new Set();
    while (queue.length) { const value = queue.shift(); if (!value || seen.has(value)) continue; seen.add(value);
      if (value.private || value.ephemeral || value.incognito) return true;
      for (const [key, ids] of [['projects', [value.projectId]], ['agentRuns', [value.runId, value.agentRunId]], ['conversations', [value.sourceConversationId, value.conversationId]]])
        ids.filter(Boolean).forEach(id => queue.push(...array(state[key]).filter(item => item?.id === id)));
    } return false;
  }
  function resultFor(state, result, environment = root, run = null) {
    const type = typeof result?.type === 'string' ? result.type : '';
    const originalId = typeof result?.id === 'string' ? result.id : '';
    const id = type === 'note' && originalId ? environment.NoteConsolidation?.resolveId?.(state, originalId) || originalId : originalId;
    const collection = Object.hasOwn(resultCollections, type) ? resultCollections[type] : null;
    const base = { type, id, label: Object.hasOwn(resultTypes, type) ? resultTypes[type] : '结果', title: typeof result === 'string' ? result : text(result?.text || result?.title || result?.name || id) || '已记录', available: false };
    if (!collection || !id) return { ...base, reason: '旧记录未保存可打开的成果位置' };
    const matches = array(state[collection]).filter(item => item?.id === id), entity = matches.length === 1 ? matches[0] : null;
    const trashed = (key, value) => array(state.trash).some(entry => array(entry?.data?.[key]).some(item => item?.id === value));
    if (privateRecord(state, result, run, ...matches)) return { ...base, title: '私密成果', reason: '私密成果不可从执行历史打开' };
    if (!entity || entity.deletedAt || entity.deleted || entity.tombstone || trashed(collection, id)) return { ...base, reason: '成果已移入回收站或不再可用' };
    if (!activeRecord(entity)) return { ...base, reason: '成果已归档，暂不可直接打开' };
    if (entity.projectId) {
      const parents = array(state.projects).filter(item => item?.id === entity.projectId), project = parents.length === 1 ? parents[0] : null;
      if (!activeRecord(project) || trashed('projects', project.id)) return { ...base, reason: '成果所属项目已归档或不再可用' };
    }
    const access = type !== 'project' && environment.CitationEvidence?.access?.(state, { type, id, runId: run?.id });
    if (access && !access.available) return { ...base, title: access.kind === 'private' ? '私密成果' : base.title, reason: '成果不再可用' };
    return { ...base, available: true, title: text(entity.title || entity.name) || base.title, reason: '', entity };
  }
  function queryRuns(state, options = {}, environment = root) {
    const trash = trashIds(state);
    const conversations = new Map(array(state.conversations).filter(Boolean).map(item => [item.id, item]));
    const query = text(options.query).trim().toLocaleLowerCase();
    return array(state.agentRuns).filter(run => {
      const conversation = conversations.get(run?.conversationId);
      if (!run?.id || run.deletedAt || trash.runs.has(run.id) || trash.conversations.has(run.conversationId) || conversation?.deletedAt) return false;
      if (query && !text(run.goal).toLocaleLowerCase().includes(query)) return false;
      if (options.status && options.status !== 'all') {
        const status = presentation(state, run, environment).status;
        if (options.status === 'completed') return ['completed', 'completed-local', 'completed-local-fallback'].includes(status);
        if (status !== options.status) return false;
      }
      return true;
    }).slice().sort((a, b) => stamp(b.startedAt) - stamp(a.startedAt) || text(a.id).localeCompare(text(b.id)));
  }
  function conversationFor(state, run) {
    const conversation = array(state.conversations).find(item => item?.id === run?.conversationId);
    const trash = trashIds(state);
    if (!conversation || conversation.deletedAt || trash.conversations.has(conversation.id)) return { active: false, label: '原对话已不可用', conversation: null };
    if (conversation.archived) return { active: false, label: '原对话已归档 · 仅查看历史', conversation };
    const project = array(state.projects).find(item => item?.id === conversation.projectId);
    if (conversation.projectId && (!project || project.archived || project.deletedAt)) return { active: false, label: '原对话所属项目已归档或不可用 · 仅查看历史', conversation };
    return { active: true, label: text(conversation.title) || '未命名对话', conversation };
  }
  const terminalStatuses = new Set(['completed', 'completed-local', 'completed-local-fallback', 'failed', 'cancelled', 'rejected', 'interrupted']);
  const canDeleteRun = run => !!run?.id && !run.deletedAt && !run.approvalReceipt?.savePending
    && !['prepared', 'applied'].includes(run.executionReceipt?.phase) && terminalStatuses.has(run.status);
  function deletionPlan(state, ids, expected) {
    const selected = [...new Set(array(ids))];
    if (!selected.length || selected.some(id => typeof id !== 'string' || !id)) throw new Error('请先选择要删除的执行日志。');
    const visible = new Set(queryRuns(state).map(run => run.id));
    return selected.map(id => {
      const matches = array(state.agentRuns).filter(run => run?.id === id);
      if (matches.length !== 1 || !visible.has(id)) throw new Error('记录已变化或不再可用，请刷新后重新选择。');
      const run = matches[0];
      if (!canDeleteRun(run)) throw new Error('执行中、待审批或尚未确认结束的记录不能删除。');
      if (expected && expected.get(id) !== JSON.stringify(run)) throw new Error('待删除记录已有更新，请重新查看并确认。');
      return run;
    });
  }
  function createController(hooks, environment = root) {
    if (typeof hooks?.getState !== 'function' || typeof hooks?.openConversation !== 'function') throw new Error('执行历史需要 getState 和 openConversation 接口。');
    const doc = environment.document;
    let dialog, search, filter, list, detail, count, openButton, previousFocus, bulk, allCheckbox, selectionCount, deleteSelected, clearSelected;
    let confirmDialog, confirmList, confirmHeading, confirmStatus, confirmButton, cancelDelete, confirmFocus;
    let selectedId = null, shown = 80, composing = false, saving = false, pendingDelete = null;
    let detailTimer = null, kit = false, toolbarIsland, listIsland, detailIsland;
    let query = '', statusFilter = 'all', toolbarHost, detailSignature = '', resultOpening = false, resultError = '';
    const intervals = environment.setInterval || setInterval, stopInterval = environment.clearInterval || clearInterval;
    const checked = new Set();
    const writable = typeof hooks.save === 'function';
    const element = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
    const button = (value, className, action) => { const node = element('button', className, value); node.type = 'button'; node.addEventListener('click', action); return node; };
    const close = () => { if (saving) return; if (detailTimer) { stopInterval(detailTimer); detailTimer = null; } if (confirmDialog?.open) confirmDialog.close(); if (dialog?.open) dialog.close(); };
    const currentRun = () => queryRuns(hooks.getState()).find(run => run.id === selectedId);
    function renderDetail() {
      const state = hooks.getState(), run = currentRun();
      if (kit) { renderKitDetail(state, run); return; }
      const signature = JSON.stringify([run, run && conversationFor(state, run), saving, resultOpening, resultError]);
      if (signature === detailSignature) return;
      detailSignature = signature; detail.replaceChildren();
      dialog.dataset.detail = run ? 'true' : 'false';
      if (!run) { detail.append(element('p', 'run-history-empty', selectedId ? '该记录已移入回收站或不再可用。' : '选择一条记录，查看本次执行的目标、步骤与结果。')); selectedId = null; return; }
      const heading = element('div', 'run-history-detail-heading');
      heading.append(button('← 返回列表', 'run-history-back', () => { selectedId = null; renderDetail(); list.focus(); }), element('h3', '', text(run.goal) || '未记录执行目标'));
      detail.append(heading);
      const grid = element('dl', 'run-history-meta');
      const field = (label, value) => { const pair = element('div'); pair.append(element('dt', '', label), element('dd', '', text(value) || '未记录')); grid.append(pair); };
      const model = run.modelConfig || {};
      const presented = presentation(state, run, environment);
      field('状态', presented.label); if (presented.recoveryPhase) field('恢复方式', presented.hint); field('模型', model.model || run.model);
      field('连接', model.provider === 'openai-auth' ? 'OpenAI 账号' : model.provider === 'api' ? '自定义 API' : model.provider || '未记录');
      field('推理强度', model.effort || run.effort || '模型默认'); field('开始时间', date(run.startedAt)); field('结束时间', date(run.finishedAt || run.completedAt));
      const projects = [...new Set([...array(run.projectIds), ...(run.projectId ? [run.projectId] : [])])].map(id => array(state.projects).find(item => item?.id === id)?.name || `项目 ${text(id)}（已不可用）`);
      field('空间 / 项目', [run.workspace || run.contextWorkspace, ...projects].filter(Boolean).join(' / ') || '未记录');
      const original = conversationFor(state, run); field('原对话', original.active ? original.label : `${original.conversation?.title || ''}${original.conversation?.title ? ' · ' : ''}${original.label}`);
      detail.append(grid);
      const section = (title, values, empty, className = '') => {
        const region = element('section', `run-history-section ${className}`); region.append(element('h4', '', title));
        if (!values.length) region.append(element('p', 'run-history-muted', empty));
        else { const rows = element('ol'); values.forEach(value => rows.append(element('li', '', value))); region.append(rows); }
        detail.append(region);
      };
      section('执行步骤', array(run.steps).filter(Boolean).map(step => typeof step === 'string' ? step : `${({ done: '已完成', running: '进行中', error: '失败', failed: '失败', pending: '等待' }[step.status] || text(step.status) || '已记录')} · ${text(step.text || step.label || step.title)}`), '这次执行没有记录步骤。');
      const toolCard=root.ToolScheduler?.card(run);if(toolCard)detail.append(toolCard);
      if (run.error) section('错误信息', [text(run.error)], '', 'run-history-error');
      const types = { project: '项目', task: '任务', note: '知识', import: '资料', paper: '论文' };
      section(`执行结果 · ${array(run.results).filter(Boolean).length} 项`, array(run.results).filter(Boolean).map(result => typeof result === 'string' ? result : `${types[result.type] || '结果'} · ${text(result.text || result.title || result.name || result.id) || '已记录'}`), run.status === 'awaiting-approval' ? '尚未执行。请回到原对话查看待审批计划。' : '没有写入结果记录。');
      const actions = element('div', 'run-history-detail-actions');
      openButton = button(original.active ? '打开原对话' : '原对话不可直接打开', 'run-history-button run-history-primary', openOriginal); openButton.disabled = !original.active;
      if (!original.active) actions.append(element('p', 'run-history-muted', original.label));
      const remove = button('删除这条日志', 'run-history-button run-history-danger', () => requestDelete([run.id]));
      remove.id = 'runHistoryDeleteOne'; remove.disabled = !writable || !canDeleteRun(run) || saving;
      remove.title = canDeleteRun(run) ? '仅删除本机执行日志，保留对话与成果' : '执行中、待审批或尚未确认结束的记录不能删除';
      actions.append(remove, openButton); detail.append(actions);
      scheduleDetailRefresh(run);
    }
    // One watcher owns the dialog lifetime. React preserves keyed controls and
    // disclosure state; unchanged ticks do not discard a focused detail node.
    function scheduleDetailRefresh() {
      if (detailTimer || !dialog?.open) return;
      detailTimer = intervals(() => {
        if (!dialog?.open || doc.hidden || composing || confirmDialog?.open || saving || resultOpening) return;
        renderList(); renderDetail();
      }, 2500);
      detailTimer?.unref?.();
    }
    function renderList() {
      if (kit) { renderKitList(); return; }
      const state = hooks.getState(); const runs = queryRuns(state, { query: search.value, status: filter.value });
      const total = queryRuns(state).length;
      count.textContent = search.value.trim() || filter.value !== 'all' ? `${runs.length} / ${total} 条记录` : `${total} 条记录 · 包含已归档对话`;
      const selectable = runs.filter(canDeleteRun), available = new Set(selectable.map(run => run.id));
      for (const id of checked) if (!available.has(id)) checked.delete(id);
      allCheckbox.disabled = !writable || !selectable.length || saving;
      allCheckbox.checked = !!selectable.length && selectable.every(run => checked.has(run.id));
      allCheckbox.indeterminate = checked.size > 0 && !allCheckbox.checked;
      selectionCount.textContent = checked.size ? `已选 ${checked.size} 条` : '仅已结束的本机日志可删除';
      deleteSelected.textContent = checked.size ? `删除所选 (${checked.size})` : '删除所选';
      deleteSelected.disabled = !writable || !checked.size || saving; clearSelected.disabled = !checked.size || saving;
      list.replaceChildren();
      if (!runs.length) list.append(element('p', 'run-history-empty', total ? '没有匹配记录。试试其他关键词或状态。' : '还没有执行记录。发起一次工作流后，会在这里留下历史。'));
      runs.slice(0, shown).forEach(run => {
        const original = conversationFor(state, run);
        const row = button('', 'run-history-row', () => { selectedId = run.id; renderList(); renderDetail(); detail.focus(); });
        row.setAttribute('aria-pressed', String(selectedId === run.id)); row.dataset.runId = text(run.id);
        row.append(element('strong', '', text(run.goal) || '未记录执行目标'), element('span', '', `${presentation(state, run, environment).label} · ${date(run.startedAt)}`));
        row.append(element('small', '', original.label));
        const item = element('div', 'run-history-item'); item.dataset.selected = String(checked.has(run.id));
        const label = element('label', 'run-history-select'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.selectRun = run.id;
        checkbox.setAttribute('aria-label', `选择执行日志：${text(run.goal) || '未记录执行目标'}`); checkbox.checked = checked.has(run.id); checkbox.disabled = !writable || !canDeleteRun(run) || saving;
        label.title = canDeleteRun(run) ? '选择这条执行日志' : '执行中、待审批或尚未确认结束的记录不能删除';
        checkbox.addEventListener('change', () => { if (saving) return; if (checkbox.checked) checked.add(run.id); else checked.delete(run.id); renderList(); });
        label.append(checkbox); item.append(label, row); list.append(item);
      });
      if (runs.length > shown) list.append(button(`再显示 ${Math.min(80, runs.length - shown)} 条`, 'run-history-button run-history-more', () => { shown += 80; renderList(); }));
    }
    function refresh() { shown = 80; renderList(); renderDetail(); }
    function requestDelete(ids) {
      if (!writable || saving) return false;
      let runs;
      try { runs = deletionPlan(hooks.getState(), ids); }
      catch (error) { hooks.toast?.(error.message); refresh(); return false; }
      pendingDelete = new Map(runs.map(run => [run.id, JSON.stringify(run)]));
      confirmHeading.textContent = `永久删除 ${runs.length} 条执行日志？`;
      confirmList.replaceChildren();
      runs.slice(0, 6).forEach(run => confirmList.append(element('li', '', text(run.goal) || '未记录执行目标')));
      if (runs.length > 6) confirmList.append(element('li', 'run-history-muted', `以及另外 ${runs.length - 6} 条已选日志`));
      confirmStatus.textContent = ''; confirmButton.textContent = `永久删除 ${runs.length} 条日志`;
      confirmFocus = doc.activeElement; if (!confirmDialog.open) confirmDialog.showModal(); cancelDelete.focus(); return true;
    }
    function busy(value) {
      saving = value; if (kit) { renderList(); renderDetail(); } confirmButton.disabled = value; cancelDelete.disabled = value;
      confirmDialog.setAttribute('aria-busy', String(value));
      if (value) confirmButton.textContent = '正在删除…';
    }
    async function confirmDeletion(event) {
      event?.preventDefault(); if (saving || !pendingDelete) return false;
      const state = hooks.getState(); let targets;
      try { targets = deletionPlan(state, [...pendingDelete.keys()], pendingDelete); }
      catch (error) { confirmStatus.textContent = error.message; confirmButton.disabled = true; refresh(); return false; }
      const targetIds = new Set(targets.map(run => run.id));
      const before = array(state.agentRuns), removed = before.map((run, index) => ({ run, index })).filter(item => targetIds.has(item.run?.id));
      const after = before.filter(run => !targetIds.has(run?.id)); state.agentRuns = after; busy(true);
      try {
        const result = await hooks.save();
        if (result === false) throw new Error('本机保存未成功。');
      } catch (error) {
        // A new run may be appended while saving. Preserve it, and never undo a
        // separate transaction (such as deleting a conversation) replacing the array.
        const current = hooks.getState(); let restored = false;
        if (current === state && current.agentRuns === after) {
          removed.forEach(({ run, index }) => { if (!after.some(item => item?.id === run.id)) after.splice(Math.min(index, after.length), 0, run); });
          restored = true;
        }
        busy(false); confirmButton.textContent = `重试删除 ${targets.length} 条日志`;
        confirmStatus.textContent = restored ? `删除未保存，日志已保留。${error.message || '请稍后重试。'}` : '删除未保存，期间工作区已有其他变更。请关闭确认框并刷新检查；未覆盖其他操作。';
        if (!restored) confirmButton.disabled = true;
        refresh(); return false;
      }
      targets.forEach(run => checked.delete(run.id)); if (targetIds.has(selectedId)) selectedId = null;
      busy(false); pendingDelete = null; confirmDialog.close(); refresh();
      hooks.renderAll?.(); hooks.toast?.(`已删除 ${targets.length} 条本机执行日志，对话与成果均保留。`); return true;
    }
    function mountConfirmation() {
      confirmDialog = element('dialog', 'run-history-confirm'); confirmDialog.id = 'runHistoryDeleteDialog'; confirmDialog.setAttribute('aria-labelledby', 'runHistoryDeleteTitle'); confirmDialog.setAttribute('aria-describedby', 'runHistoryDeleteDescription');
      const form = element('form'); form.addEventListener('submit', confirmDeletion);
      const mark = element('div', 'run-history-delete-mark', '×'); mark.setAttribute('aria-hidden', 'true');
      confirmHeading = element('h2'); confirmHeading.id = 'runHistoryDeleteTitle';
      const description = element('p', '', '仅清除这台设备上的执行日志，无法恢复。对应聊天消息、任务、笔记、项目与资料全部保留，不会删除云端内容。'); description.id = 'runHistoryDeleteDescription';
      confirmList = element('ul', 'run-history-delete-list');
      const hint = element('p', 'run-history-delete-hint', '执行中、等待审批的记录不可删除。删除日志后，仍可在原对话与各空间查看成果。');
      confirmStatus = element('p', 'run-history-delete-status'); confirmStatus.id = 'runHistoryDeleteStatus'; confirmStatus.setAttribute('role', 'status'); confirmStatus.setAttribute('aria-live', 'polite');
      const footer = element('div', 'run-history-delete-footer'); cancelDelete = button('保留日志', 'run-history-button', () => { if (!saving) confirmDialog.close(); }); cancelDelete.id = 'runHistoryDeleteCancel';
      confirmButton = element('button', 'run-history-button run-history-destructive', '永久删除日志'); confirmButton.id = 'runHistoryDeleteConfirm'; confirmButton.type = 'submit'; footer.append(cancelDelete, confirmButton);
      form.append(mark, confirmHeading, description, confirmList, hint, confirmStatus, footer); confirmDialog.append(form); doc.body.append(confirmDialog);
      confirmDialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
      confirmDialog.addEventListener('close', () => { pendingDelete = null; if (dialog.open) (confirmFocus?.isConnected ? confirmFocus : search).focus?.({ preventScroll: true }); });
    }
    function openOriginal() {
      if (saving || resultOpening) return false;
      const state = hooks.getState(), run = currentRun(), original = run && conversationFor(state, run);
      if (!original?.active) { hooks.toast?.(original?.label || '该记录或原对话已不可用。'); renderList(); renderDetail(); return false; }
      const id = original.conversation.id; close(); hooks.openConversation(id); return true;
    }
    async function openResultAt(index) {
      if (saving || resultOpening || typeof hooks.openResult !== 'function') return false;
      const run = currentRun(), item = run && resultFor(hooks.getState(), array(run.results).filter(Boolean)[index], environment, run);
      if (!item?.available) { hooks.toast?.(item?.reason || '这条执行记录已不可用。'); renderDetail(); return false; }
      // Close the modal before a document's save/discard guard needs focus.
      // A cancelled guard leaves history available from its original entry.
      resultOpening = true; resultError = ''; close();
      try { return (await hooks.openResult(item.type, item.id)) !== false; }
      catch (error) { resultError = error?.message || '无法打开成果，请稍后重试。'; hooks.toast?.(resultError); return false; }
      finally { resultOpening = false; if (dialog.open) renderDetail(); }
    }
    function selectRun(id) { if (saving) return; selectedId = id; resultError = ''; renderList(); renderDetail(); detail.scrollTop = 0; detail.focus(); }
    function backToList() { const id = selectedId; selectedId = null; renderList(); renderDetail(); ([...(list.querySelectorAll?.('[data-run-id]') || [])].find(node => node.dataset.runId === id) || list).focus?.(); }
    function renderKitList() {
      const state = hooks.getState(), runs = queryRuns(state, { query, status: statusFilter }, environment), total = queryRuns(state).length;
      const selectable = runs.filter(canDeleteRun), available = new Set(selectable.map(run => run.id));
      for (const id of checked) if (!available.has(id)) checked.delete(id);
      toolbarIsland.update({ query, status: statusFilter, total, count: runs.length, checkedCount: checked.size,
        allChecked: !!selectable.length && selectable.every(run => checked.has(run.id)),
        partlyChecked: checked.size > 0 && !selectable.every(run => checked.has(run.id)), canSelect: writable && !!selectable.length, busy: saving || resultOpening });
      search = toolbarHost.querySelector('#runHistorySearch');
      const rows = runs.slice(0, shown).map(run => ({ id: run.id, title: text(run.goal) || '未记录执行目标',
        ...presentation(state, run, environment), started: date(run.startedAt), original: conversationFor(state, run).label,
        checked: checked.has(run.id), selected: run.id === selectedId, canDelete: writable && canDeleteRun(run), resultCount: array(run.results).filter(Boolean).length }));
      listIsland.update({ rows, total, remaining: Math.min(80, runs.length - shown), busy: saving || resultOpening });
    }
    function renderKitDetail(state, run) {
      dialog.dataset.detail = run ? 'true' : 'false';
      if (!run) { detailIsland.update({ record: null, missing: !!selectedId, busy: saving || resultOpening }); if (!saving) selectedId = null; return; }
      const original = conversationFor(state, run), model = run.modelConfig || {}, presented = presentation(state, run, environment);
      const projects = [...new Set([...array(run.projectIds), ...(run.projectId ? [run.projectId] : [])])].map(id => array(state.projects).find(item => item?.id === id)?.name || `项目 ${text(id)}（已不可用）`);
      const record = { id: run.id, title: text(run.goal) || '未记录执行目标', ...presented,
        canOpenOriginal: original.active, canDelete: writable && canDeleteRun(run),
        metadata: [ ['模型', model.model || run.model || '未记录'], ['连接', model.provider === 'openai-auth' ? 'OpenAI 账号' : model.provider === 'api' ? '自定义 API' : model.provider || '未记录'],
          ['推理强度', model.effort || run.effort || '模型默认'], ['开始时间', date(run.startedAt)], ['结束时间', date(run.finishedAt || run.completedAt)],
          ['空间 / 项目', [run.workspace || run.contextWorkspace, ...projects].filter(Boolean).join(' / ') || '未记录'],
          ['原对话', original.active ? original.label : `${original.conversation?.title || ''}${original.conversation?.title ? ' · ' : ''}${original.label}`],
          ...(presented.recoveryPhase ? [['恢复方式', presented.hint]] : []) ],
        steps: array(run.steps).filter(Boolean).map((step, index) => ({ id: step?.id || String(index), title: typeof step === 'string' ? step : text(step.text || step.label || step.title), status: text(step.status) })),
        tools: array(run.toolCalls).filter(Boolean).map((call, index) => ({ id: call.id || String(index), type: text(call.type), status: text(call.status), request: text(call.request), result: text(call.result), error: text(call.error), summary: text(call.summary) })),
        results: array(run.results).filter(Boolean).map((result, index) => { const item = resultFor(state, result, environment, run); return { index, type: item.type, id: item.id, title: item.title, label: item.label, available: item.available && typeof hooks.openResult === 'function', reason: item.available && typeof hooks.openResult !== 'function' ? '当前环境不支持直接打开成果' : item.reason }; }),
      };
      detailIsland.update({ record, busy: saving || resultOpening, error: resultError });
    }
    function mountKit() {
      kit = true;
      dialog = element('dialog', 'run-history run-history-kit'); dialog.id = 'runHistoryDialog'; dialog.setAttribute('aria-labelledby', 'runHistoryTitle'); dialog.dataset.detail = 'false';
      toolbarHost = element('div', 'history-kit-toolbar-host');
      const body = element('div', 'run-history-body'); list = element('div', 'run-history-list'); list.setAttribute('aria-label', '执行记录列表'); list.tabIndex = -1;
      detail = element('article', 'run-history-detail'); detail.setAttribute('aria-label', '执行记录详情'); detail.tabIndex = -1; body.append(list, detail); dialog.append(toolbarHost, body); doc.body.append(dialog);
      toolbarIsland = environment.HalaskaUI.mount(toolbarHost, 'RunHistoryToolbar', { query, status: statusFilter, total: 0, count: 0, checkedCount: 0,
        onClose: close, onRefresh: refresh, onQuery: value => { query = value; shown = 80; renderList(); },
        onCompositionStart: () => { composing = true; }, onCompositionEnd: () => { composing = false; },
        onStatus: value => { statusFilter = value; shown = 80; renderList(); },
        onSelectAll: value => { if (!writable || saving) return; if (value) queryRuns(hooks.getState(), { query, status: statusFilter }, environment).filter(canDeleteRun).forEach(run => checked.add(run.id)); else checked.clear(); renderList(); },
        onClear: () => { if (!saving) { checked.clear(); renderList(); } }, onDelete: () => requestDelete([...checked]),
      });
      listIsland = environment.HalaskaUI.mount(list, 'RunHistoryList', { rows: [], total: 0, onSelect: selectRun,
        onCheck: (id, value) => { if (!saving) { if (value) checked.add(id); else checked.delete(id); renderList(); } },
        onMore: () => { shown += 80; renderList(); },
      });
      detailIsland = environment.HalaskaUI.mount(detail, 'RunHistoryDetail', { record: null, onBack: backToList, onOriginal: openOriginal,
        onDelete: () => requestDelete([selectedId]), onResult: openResultAt,
      });
      search = toolbarHost.querySelector('#runHistorySearch'); mountConfirmation();
      dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
      dialog.addEventListener('close', () => { if (detailTimer) { stopInterval(detailTimer); detailTimer = null; } previousFocus?.focus?.({ preventScroll: true }); });
    }
    function mount() {
      if (dialog) return;
      if (environment.HalaskaUI?.mount) { mountKit(); return; }
      dialog = element('dialog', 'run-history'); dialog.id = 'runHistoryDialog'; dialog.setAttribute('aria-labelledby', 'runHistoryTitle'); dialog.dataset.detail = 'false';
      const header = element('header', 'run-history-header'), copy = element('div'), title = element('h2', '', '执行历史'); title.id = 'runHistoryTitle';
      copy.append(title, element('p', '', '追溯每次工作的目标、过程与结果。历史记录不会触发新的执行。'));
      const headerActions = element('div', 'run-history-header-actions'); const reload = button('刷新', 'run-history-button', refresh), dismiss = button('×', 'run-history-close', close); dismiss.setAttribute('aria-label', '关闭执行历史'); headerActions.append(reload, dismiss); header.append(copy, headerActions);
      const controls = element('div', 'run-history-controls'); search = element('input'); search.id = 'runHistorySearch'; search.type = 'search'; search.placeholder = '搜索执行目标…'; search.setAttribute('aria-label', '搜索执行目标'); search.autocomplete = 'off';
      filter = element('select'); filter.id = 'runHistoryStatus'; filter.setAttribute('aria-label', '按执行状态筛选');
      [['all', '全部状态'], ['running', '执行中'], ['awaiting-approval', '等待审批'], ['awaiting-save', '等待保存结果'], ['completed', '已完成（含本地）'], ['failed', '执行失败'], ['cancelled', '已停止'], ['rejected', '已拒绝'], ['interrupted', '已中断']].forEach(([value, label]) => { const option = element('option', '', label); option.value = value; filter.append(option); });
      controls.append(search, filter); count = element('p', 'run-history-count'); count.setAttribute('aria-live', 'polite');
      const body = element('div', 'run-history-body'); list = element('div', 'run-history-list'); list.setAttribute('aria-label', '执行记录列表'); list.tabIndex = -1; detail = element('article', 'run-history-detail'); detail.setAttribute('aria-label', '执行记录详情'); detail.tabIndex = -1; body.append(list, detail);
      bulk = element('div', 'run-history-bulk');
      const allLabel = element('label', 'run-history-select-all'); allCheckbox = element('input'); allCheckbox.type = 'checkbox'; allCheckbox.id = 'runHistorySelectAll'; allLabel.append(allCheckbox, element('span', '', '全选筛选结果')); allLabel.title = '选择当前筛选中的所有已结束记录，包括尚未展开的记录';
      allCheckbox.addEventListener('change', () => {
        if (!writable || saving) return;
        const runs = queryRuns(hooks.getState(), { query: search.value, status: filter.value }).filter(canDeleteRun);
        if (allCheckbox.checked) runs.forEach(run => checked.add(run.id)); else checked.clear(); renderList();
      });
      selectionCount = element('span', 'run-history-selection-count'); selectionCount.setAttribute('aria-live', 'polite');
      clearSelected = button('取消选择', 'run-history-button run-history-clear', () => { if (!saving) { checked.clear(); renderList(); } }); clearSelected.id = 'runHistoryClearSelection';
      deleteSelected = button('删除所选', 'run-history-button run-history-danger', () => requestDelete([...checked])); deleteSelected.id = 'runHistoryDeleteSelected';
      bulk.append(allLabel, selectionCount, clearSelected, deleteSelected);
      dialog.append(header, controls, count, bulk, body); doc.body.append(dialog); mountConfirmation();
      search.addEventListener('compositionstart', () => { composing = true; });
      search.addEventListener('compositionend', () => { composing = false; shown = 80; renderList(); });
      search.addEventListener('input', event => { if (!composing && !event.isComposing) { shown = 80; renderList(); } });
      filter.addEventListener('change', () => { shown = 80; renderList(); });
      dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
      dialog.addEventListener('close', () => { if (detailTimer) { stopInterval(detailTimer); detailTimer = null; } previousFocus?.focus?.({ preventScroll: true }); });
    }
    function open(runId) {
      if (saving || resultOpening) return false; mount(); if (!dialog.open) previousFocus = doc.activeElement;
      selectedId = runId && hooks.getState().agentRuns?.some(run => run?.id === runId && !run.deletedAt) ? runId : null; checked.clear(); query = ''; statusFilter = 'all'; resultError = ''; detailSignature = '';
      if (!kit) { search.value = ''; filter.value = 'all'; } refresh();
      if (!dialog.open) dialog.showModal(); search.focus(); scheduleDetailRefresh();
    }
    return { open, close, refresh, openOriginal, openResult: openResultAt };
  }
  let controller;
  return { queryRuns, conversationFor, statusLabel, presentation, resultFor, canDeleteRun, deletionPlan, createController,
    init(hooks) { controller ||= createController(hooks); return this; },
    open(runId) { if (!controller) throw new Error('请先初始化执行历史。'); controller.open(runId); },
    close() { controller?.close(); }
  };
}));
