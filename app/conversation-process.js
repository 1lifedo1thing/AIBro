(function (root) {
  'use strict';
  const labels = {
    completed: ['已完成', 'Completed'], done: ['已完成', 'Completed'], 'completed-local': ['已完成', 'Completed'],
    failed: ['执行失败', 'Failed'], cancelled: ['已停止', 'Stopped'], interrupted: ['已中断', 'Interrupted'],
    'awaiting-approval': ['等待审批', 'Approval needed'], 'awaiting-save': ['等待保存结果', 'Save confirmation needed'],
    rejected: ['已拒绝', 'Declined'],
  };
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  const count = (message = {}, run = {}) => ({ progress: (message.steps?.length || 0) + (message.activities?.length || 0), tools: run.toolCalls?.length || 0 });
  const explicitToolInspection = (run = {}) => !!run.toolCalls?.length && (
    run.toolLedgerPins?.ledger === true || run.toolCalls.some(call =>
      run.toolLedgerPins?.[call.id] === true || run.toolLedgerPins?.['raw:' + call.id] === true)
  );

  // Read durable choices without writing defaults while rendering. A missing
  // source tab falls back to the available recorded content.
  function chooseView(message = {}, run = {}) {
    const counts = count(message, run);
    if (['progress', 'tools'].includes(message.processView) && counts[message.processView]) return message.processView;
    if (counts.tools && explicitToolInspection(run)) return 'tools';
    return counts.progress ? 'progress' : counts.tools ? 'tools' : null;
  }
  const direct = (node, selector) => node?.querySelector(':scope > ' + selector) || null;

  function select(wrapper, view) {
    const feed = direct(wrapper, '.agent-progress');
    const navigation = direct(feed, '.conversation-process-navigation');
    if (!navigation) return null;
    const counts = { progress: Number(navigation.dataset.progressCount) || 0, tools: Number(navigation.dataset.toolCount) || 0 };
    const selected = ['progress', 'tools'].includes(view) && counts[view] ? view : counts.progress ? 'progress' : counts.tools ? 'tools' : null;
    for (const name of ['progress', 'tools']) {
      const panel = direct(feed, `[data-live-key="process-${name}-panel"]`);
      if (panel) panel.hidden = name !== selected;
    }
    navigation.dataset.view = selected || '';
    return selected;
  }

  function compose(wrapper, message = {}, run = {}) {
    if (!wrapper || !root.document || message.role === 'user') return null;
    const counts = count(message, run);
    if (!counts.progress && !counts.tools) return null;
    let feed = direct(wrapper, '.agent-progress');
    if (!feed) {
      // Historical tool-only runs have no AgentProgress markup. Give them the
      // same truthful disclosure without inventing activity or completion.
      feed = root.document.createElement('details');
      feed.className = 'agent-progress'; feed.dataset.progressKey = 'feed';
      feed.dataset.progressPhase = message.live ? 'tool' : 'settled';
      const summary = root.document.createElement('summary');
      const title = root.document.createElement('span'); title.className = 'progress-heading-text';
      const status = run.status || message.runStatus || (message.retryRunId ? 'failed' : 'unknown');
      title.textContent = message.live ? t('正在执行', 'Working') : t(...(labels[status] || ['执行记录', 'Activity']));
      const total = root.document.createElement('span'); total.className = 'progress-count';
      total.textContent = t(`${counts.tools} 次工具调用`, `${counts.tools} tool calls`);
      summary.append(title, total); feed.append(summary);
      wrapper.insertBefore(feed, direct(wrapper, '.message-body'));
      feed.open = !!message.live;
    }
    // An explicit outer close always wins, including when an old tool or raw
    // record was pinned. Otherwise preserve the timeline's own opening rule.
    if (Object.prototype.hasOwnProperty.call(message.progressPins || {}, 'feed')) feed.open = message.progressPins.feed === true;
    else if (explicitToolInspection(run)) feed.open = true;

    const key = encodeURIComponent(String(message.id || wrapper.dataset.messageId || run.id || 'message'));
    let navigation = direct(feed, '.conversation-process-navigation');
    if (!navigation) {
      navigation = root.document.createElement('div'); navigation.className = 'conversation-process-navigation';
      navigation.dataset.liveKey = 'process-navigation'; feed.append(navigation);
    }
    Object.assign(navigation.dataset, { messageId: String(message.id || wrapper.dataset.messageId || ''), progressCount: String(counts.progress), toolCount: String(counts.tools) });
    navigation.hidden = !(counts.progress && counts.tools);
    // Both stable keyed containers exist from the first recorded activity, so
    // the first tool delta does not reparent the timeline or its focused row.
    for (const name of ['progress', 'tools']) {
      let panel = direct(feed, `[data-live-key="process-${name}-panel"]`);
      if (!panel) {
        panel = root.document.createElement('div'); panel.dataset.liveKey = `process-${name}-panel`; feed.append(panel);
      }
      panel.className = `conversation-process-panel conversation-process-${name}`;
      panel.id = `conversation-process-${key}-${name}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-label', name === 'progress' ? t('进展', 'Progress') : t('工具', 'Tools'));
      if (name === 'progress') {
        const timeline = direct(feed, '.progress-timeline');
        if (timeline) panel.append(timeline);
      } else {
        const ledger = root.ToolScheduler?.card(run, { embedded: true });
        panel.replaceChildren(...(ledger ? [ledger] : []));
      }
    }
    select(wrapper, chooseView(message, run));
    return feed;
  }
  root.ConversationProcess = { compose, chooseView, select };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ConversationProcess;
})(typeof globalThis !== 'undefined' ? globalThis : this);
