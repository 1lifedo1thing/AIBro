(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TerminalPane = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  // 终端区域：把这条对话执行过的命令集中到一处，而不是散落在对话历史里。
  // 只读展示——执行仍然走既有的提案与审批路径，这里不提供任何执行入口。
  const HEIGHT_KEY = 'ai-bro-terminal-height';
  const DEFAULT_HEIGHT = 220, MIN_HEIGHT = 120, MAX_HEIGHT = Math.round((root.innerHeight || 900) * 0.6);

  const STATUS = {
    running: { label: '执行中', tone: 'running' },
    pending: { label: '待批准', tone: 'muted' },
    completed: { label: '已完成', tone: 'done' },
    failed: { label: '失败', tone: 'failed' },
    cancelled: { label: '已停止', tone: 'muted' },
    rejected: { label: '已拒绝', tone: 'muted' }
  };

  function commandsFor(state, conversationId) {
    if (!conversationId) return [];
    const runs = Array.isArray(state?.agentRuns) ? state.agentRuns : [];
    const list = [];
    for (const run of runs) {
      if (!run || run.conversationId !== conversationId) continue;
      for (const command of Array.isArray(run.commands) ? run.commands : []) {
        if (!command || !command.id) continue;
        list.push({ ...command, runId: run.id, runGoal: run.goal || '' });
      }
    }
    return list.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
  }

  function commandText(command) {
    const argv = Array.isArray(command?.argv) ? command.argv : [];
    // 只拼接真实字符串参数：把 undefined 之类渲染成参数会误导读者。
    const joined = argv.filter(part => typeof part === 'string' && part.length).join(' ').trim();
    return joined || '（未记录命令内容）';
  }

  function statusOf(command) {
    return STATUS[command?.status] || { label: '状态未知', tone: 'muted' };
  }

  function counts(list) {
    const result = { total: 0, running: 0, failed: 0 };
    for (const command of Array.isArray(list) ? list : []) {
      result.total += 1;
      if (command?.status === 'running') result.running += 1;
      if (command?.status === 'failed') result.failed += 1;
    }
    return result;
  }

  function elapsedText(command, now) {
    const started = Number(command?.startedAt);
    if (!Number.isFinite(started) || started <= 0) return '';
    const finished = Number(command?.finishedAt);
    const end = Number.isFinite(finished) && finished >= started ? finished : (command?.status === 'running' ? Number.isFinite(now) ? now : Date.now() : NaN);
    if (!Number.isFinite(end) || end < started) return '';
    const seconds = Math.max(0, Math.round((end - started) / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  }

  function clockText(value) {
    const date = new Date(Number(value));
    if (!Number.isFinite(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function describe(command, now) {
    const parts = [];
    if (Number.isFinite(Number(command?.exitCode))) parts.push(`退出码 ${Number(command.exitCode)}`);
    const elapsed = elapsedText(command, now);
    if (elapsed) parts.push(elapsed);
    const clock = clockText(command?.startedAt);
    if (clock) parts.push(clock);
    return parts.join(' · ');
  }

  let hooks = {}, observer = null, saveTimer = null;

  const $ = id => root.document?.getElementById?.(id);

  function storedHeight() {
    try {
      const value = Number(root.localStorage?.getItem?.(HEIGHT_KEY));
      return Number.isFinite(value) && value >= MIN_HEIGHT ? Math.min(value, MAX_HEIGHT) : DEFAULT_HEIGHT;
    } catch (_) { return DEFAULT_HEIGHT; }
  }

  function rememberHeight(value) {
    if (!Number.isFinite(value) || value < MIN_HEIGHT) return;
    try { root.localStorage?.setItem?.(HEIGHT_KEY, String(Math.round(Math.min(value, MAX_HEIGHT)))); } catch (_) {}
  }

  function item(command, now) {
    const doc = root.document;
    const wrap = doc.createElement('div');
    wrap.className = 'terminal-entry';
    wrap.dataset.commandId = command.id;
    const status = statusOf(command);
    const head = doc.createElement('div');
    head.className = 'terminal-entry-head';
    const dot = doc.createElement('span');
    dot.className = `terminal-dot terminal-${status.tone}`;
    dot.setAttribute('aria-hidden', 'true');
    const cmd = doc.createElement('code');
    cmd.className = 'terminal-command';
    cmd.textContent = commandText(command);
    const meta = doc.createElement('span');
    meta.className = 'terminal-meta';
    meta.textContent = `${status.label}${describe(command, now) ? ' · ' + describe(command, now) : ''}`;
    head.append(dot, cmd, meta);
    wrap.append(head);
    if (command.cwd) {
      const cwd = doc.createElement('p');
      cwd.className = 'terminal-cwd';
      cwd.textContent = `目录：${command.cwd}`;
      wrap.append(cwd);
    }
    if (command.startedAt) {
      const notice = doc.createElement('p');
      notice.className = 'terminal-notice';
      notice.textContent = '此命令已在本机执行：其效果不会随本轮的文件撤销回滚。';
      wrap.append(notice);
    }
    const output = command.output || command.error;
    if (output) {
      const details = doc.createElement('details');
      details.className = 'terminal-output';
      details.open = command.status === 'running' || command.status === 'failed';
      const summary = doc.createElement('summary');
      summary.textContent = (command.error && !command.output ? '错误输出' : '命令输出') + (command.truncated ? ' · 已截断' : '');
      const pre = doc.createElement('pre');
      pre.textContent = String(output);
      details.append(summary, pre);
      wrap.append(details);
    }
    return wrap;
  }

  function render() {
    const pane = $('terminalPane');
    if (!pane) return;
    const body = $('terminalPaneBody');
    const count = $('terminalPaneCount');
    const conversation = hooks.getConversation?.();
    const list = commandsFor(hooks.getState?.(), conversation?.id);
    const totals = counts(list);
    if (count) count.textContent = totals.total ? `${totals.total} 条命令${totals.running ? ` · ${totals.running} 条执行中` : ''}${totals.failed ? ` · ${totals.failed} 条失败` : ''}` : '';
    if (!body) return;
    body.replaceChildren();
    if (!list.length) {
      const empty = root.document.createElement('p');
      empty.className = 'terminal-empty';
      empty.textContent = '这条对话还没有执行过终端命令。Agent 需要运行命令时会先请求你的批准。';
      body.append(empty);
      return;
    }
    const now = Date.now();
    for (const command of list) body.append(item(command, now));
  }

  function toggle(force) {
    const pane = $('terminalPane');
    if (!pane) return false;
    const visible = force === undefined ? pane.hidden : !!force;
    pane.hidden = !visible;
    $('terminalPaneToggle')?.setAttribute('aria-expanded', String(visible));
    if (visible) {
      pane.style.height = `${storedHeight()}px`;
      render();
    }
    return visible;
  }

  function close() { toggle(false); }

  function init(options) {
    hooks = options || {};
    const pane = $('terminalPane');
    if (!pane || observer) return;
    pane.style.height = `${storedHeight()}px`;
    $('terminalPaneToggle')?.addEventListener('click', () => toggle());
    $('terminalPaneClose')?.addEventListener('click', close);
    if (root.ResizeObserver) {
      // 用户拖拽调整高度后记住；程序性赋值与拖拽都经由此处，值未变化时不写入。
      let last = storedHeight();
      observer = new root.ResizeObserver(entries => {
        const height = Math.round(entries[0]?.contentRect?.height || 0);
        if (height < MIN_HEIGHT || Math.abs(height - last) < 4) return;
        last = height;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => rememberHeight(height), 300);
      });
      observer.observe(pane);
    }
    render();
  }

  return { init, render, toggle, close, commandsFor, commandText, statusOf, describe, elapsedText, counts, HEIGHT_KEY, MIN_HEIGHT, DEFAULT_HEIGHT };
});
