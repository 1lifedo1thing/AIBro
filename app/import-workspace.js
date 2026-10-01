/* The dialog owns presentation; app.js owns file transport and durable writes. */
(function (root) {
  'use strict';
  let hooks = {}, record = null, session = null, activeDirect = false;
  const t = (zh, en) => /^en(?:-|$)/i.test(root.document.documentElement.lang) ? en : zh;
  const live = item => item && !item.archived && !item.deletedAt;
  const keyFor = target => ['conversation', 'project', 'capture'].includes(target?.kind) ? `${target.kind}:${target.id}` : `workspace:${target?.workspace || '日常'}`;
  const size = bytes => bytes ? bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB` : '';
  function destinations() {
    const state = hooks.getState?.() || {};
    return [
      ...(state.conversations || []).filter(live).map(item => ({ value: `conversation:${item.id}`, label: `${t('对话', 'Chat')} · ${item.title || t('未命名对话', 'Untitled conversation')}` })),
      ...(state.projects || []).filter(live).map(item => ({ value: `project:${item.id}`, label: `${t('项目', 'Project')} · ${item.name}` })),
      ...['日常', '课程', '科研'].map(workspace => ({ value: `workspace:${workspace}`, label: `${t('资料库', 'Library')} · ${{ 日常: t('日常', 'Daily'), 课程: t('课程', 'Courses'), 科研: t('科研', 'Research') }[workspace]}` })),
    ];
  }
  function selectedFiles() {
    if (!record) return [];
    const files = [...(record.nodes.fileInput.files || [])];
    if (record.nodes.urlInput.value.trim()) files.push({ name: record.nodes.urlInput.value.trim(), isUrl: true });
    return files;
  }
  function refresh() {
    if (!record) return false;
    const pending = !!session?.result?.pendingSave, busy = !!session?.busy;
    record.nodes.urlInput.disabled = busy || pending;
    record.nodes.fileInput.disabled = busy || pending;
    record.nodes.nativePickFiles.disabled = busy || pending;
    record.island.update({ options: record.options, target: record.target, rows: session?.rows || selectedFiles().map(file => ({ name: file.name, size: size(file.size), status: 'ready' })), busy, pending, result: session?.result || null, hasSelection: !!selectedFiles().length });
    return true;
  }
  function init(options) {
    if (options) hooks = options;
    if (record) return true;
    const doc = root.document, dialog = doc.getElementById('importDialog'), form = doc.getElementById('importForm');
    if (!dialog || !form || !root.HalaskaUI) return false;
    const ids = ['fileInput', 'urlInput', 'startImport', 'nativePickFiles', 'importProgress', 'selectedFileSummary'];
    const nodes = Object.fromEntries(ids.map(id => [id, doc.getElementById(id)]));
    if (ids.some(id => !nodes[id])) return false;
    const host = doc.createElement('div'), retained = doc.createElement('div'); retained.hidden = true;
    const original = doc.createDocumentFragment(); while (form.firstChild) original.append(form.firstChild);
    const origins = ids.map(id => ({ node: nodes[id], parent: nodes[id].parentNode, next: nodes[id].nextSibling }));
    for (const node of Object.values(nodes)) retained.append(node);
    form.append(host, retained);
    const attach = (id, slot) => { slot.append(nodes[id]); return () => retained.append(nodes[id]); };
    const close = () => dialog.close();
    try {
      const island = root.HalaskaUI.mount(host, 'ImportSurface', { attach,
        onTarget: value => { if (session?.busy || session?.result?.pendingSave) return; record.target = value; session = null; refresh(); },
        onPick: () => nodes.nativePickFiles.click(),
        onSubmit: () => form.requestSubmit(nodes.startImport),
        onRetrySave: async () => {
          if (session?.busy) return;
          session.busy = true; refresh();
          try { await hooks.retrySave?.(); }
          catch (error) { hooks.toast?.(error.message); }
          finally { session.busy = false; refresh(); }
        },
        onClose: close,
        onOpen: id => { close(); hooks.openSource?.(id); },
      });
      record = { dialog, form, nodes, host, retained, island, options: [], target: '' };
      dialog.classList.add('import-workspace-dialog');
      dialog.setAttribute('aria-label', t('添加资料', 'Add sources'));
      nodes.urlInput.placeholder = 'https://…';
      nodes.urlInput.setAttribute('aria-label', t('网页链接', 'Webpage link'));
      nodes.urlInput.addEventListener('input', selectionChanged);
      doc.addEventListener('workstation-language-change', () => { record.options = destinations(); nodes.urlInput.setAttribute('aria-label', t('网页链接', 'Webpage link')); refresh(); });
      return true;
    } catch (error) {
      root.HalaskaUI.unmount?.(host);
      for (const { node, parent, next } of origins.reverse()) parent.insertBefore(node, next?.parentNode === parent ? next : null);
      form.replaceChildren(original); return false;
    }
  }
  function open() {
    if (!init()) return false;
    if (activeDirect && hooks.isBusy?.()) { hooks.toast?.(t('正在添加资料，请等待当前批次保存完成。', 'Adding sources. Wait for this batch to finish saving.')); return true; }
    record.options = destinations();
    const pending = hooks.pending?.();
    if (pending?.pendingSave && !session?.result?.pendingSave) {
      activeDirect = false;
      session = { busy: false, direct: false, target: pending.target, rows: (pending.files || []).map(file => ({ name: file.name, size: size(file.size), status: pending.failedFiles?.includes(file) ? 'failed' : 'pending-save' })), result: pending };
      record.target = keyFor(pending.target);
    }
    if (session?.target && (session.busy || session.result)) record.target = keyFor(session.target);
    else if (!session?.busy && !session?.result?.pendingSave) {
      const state = hooks.getState?.() || {}, view = docView();
      record.target = view === 'agent' ? `conversation:${state.currentConversationId}` : view === 'project' ? `project:${state.currentProjectId}` : `workspace:${({ daily: '日常', courses: '课程', research: '科研', wiki: '科研' })[view] || '日常'}`;
      if (!record.options.some(option => option.value === record.target)) record.target = 'workspace:日常';
    }
    if (!record.options.some(option => option.value === record.target)) record.options.unshift({ value: record.target, label: session?.target?.kind === 'capture' ? `${t('随记', 'Capture')} · ${session.target.title}` : t('原保存位置（已移除）', 'Original destination (removed)'), disabled: true });
    refresh();
    if (!record.dialog.open) {
      // WKWebView can omit a modal placed after a large inactive workbench from
      // its AX tree. Move the retained dialog ahead of it, without remounting.
      if (record.dialog.parentElement === root.document.body && root.document.body.firstElementChild !== record.dialog) root.document.body.prepend(record.dialog);
      record.dialog.showModal();
    }
    record.host.querySelector('#importTarget')?.focus();
    return true;
  }
  const docView = () => root.document.body.dataset.view || 'dashboard';
  function selectionChanged() { if (!record || session?.busy || session?.result?.pendingSave) return; session = null; refresh(); }
  function targetOptions() {
    if (!record?.target) return {};
    const [kind, ...rest] = record.target.split(':'), id = rest.join(':');
    return kind === 'conversation' ? { conversationId: id } : kind === 'project' ? { projectId: id } : { workspaceOnly: true, workspace: id };
  }
  function begin({ files = [], target, direct } = {}) {
    // Direct drops and capture/project imports retain their existing inline UI.
    activeDirect = !!direct;
    if (direct) return;
    if (!init()) return;
    session = { busy: true, result: null, target, rows: files.map(file => ({ name: file.name, size: size(file.size), status: 'ready' })) };
    refresh();
  }
  function fileStatus(index, status) {
    if (activeDirect || !session?.busy || !session.rows[index]) return;
    Object.assign(session.rows[index], status); refresh();
  }
  function finish(result) {
    if (activeDirect || !session) return;
    session.busy = false; session.result = result;
    if (!result.pendingSave) {
      const failed = result.failedFiles || [], transfer = new root.DataTransfer();
      for (const file of failed) if (!file.isUrl) transfer.items.add(file);
      record.nodes.fileInput.files = transfer.files;
      record.nodes.urlInput.value = failed.find(file => file.isUrl)?.name || '';
    }
    for (const row of session.rows) {
      const item = result.imported?.find(item => item.id === row.id || item.name === row.name || item.filename === row.name || item.title === row.name || item.url === row.name);
      if (item) Object.assign(row, { status: 'saved', id: item.id, error: '' });
    }
    refresh();
  }
  root.ImportWorkspace = Object.freeze({ init, open, refresh, selectionChanged, targetOptions, begin, fileStatus, finish });
})(typeof window !== 'undefined' ? window : globalThis);
