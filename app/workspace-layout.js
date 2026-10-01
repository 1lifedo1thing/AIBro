(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkspaceLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clamp = (value, min, max) => Math.min(Math.max(Number.isFinite(value) ? value : min, min), Math.max(min, max));
  const defaults = width => ({ sidebar: width <= 980 ? 174 : width <= 1250 ? 190 : 210, navigator: width <= 760 ? 180 : width <= 980 ? 190 : width <= 1250 ? 215 : 248, reader: clamp(width * .43, 390, 780) });
  function fitLayout(context, preferred = {}) {
    const width = Math.max(320, Number(context.width) || 1024), margin = context.readingOpen ? 24 : 16;
    if (context.nativeShell) {
      const pdf = !!context.readingPdf;
      const fullReader = !!context.readingOpen && (context.readingExpanded || width < (pdf ? (context.view === 'project' ? 1160 : 1000) : context.view === 'project' ? 980 : 840));
      const readerVisible = !!context.readingOpen && !fullReader;
      // A project has its own file navigator; reserve room for both it and content.
      const mainMinimum = context.view === 'project' ? 560 : 400;
      const minimum = pdf ? 520 : 400;
      const maximum = Math.max(minimum, width - mainMinimum - 8);
      const reader = fullReader ? width : readerVisible ? clamp((pdf ? preferred.readerPdf : preferred.reader) ?? width * (pdf ? .62 : .48), minimum, maximum) : 0;
      return { width, fullReader, sidebar:0, navigator:0, reader, main:fullReader ? 0 : width-reader-(readerVisible ? 8:0),
        handles:{sidebar:false,navigator:false,reader:readerVisible}, bounds:{sidebar:[0,0],navigator:[0,0],reader:[minimum,maximum]}, defaults:defaults(width) };
    }
    const base = defaults(width), pdf = !!context.readingPdf, fullReader = !!context.readingOpen && (context.readingExpanded || width <= (pdf ? (context.view === 'project' ? 1320 : 1120) : 1000));
    const sidebarFixed = context.sidebarCollapsed || width <= 760;
    const navigatorVisible = context.view === 'agent' && !context.readingOpen && width > 880 && !(context.inspectorOpen && width <= 1250);
    const readerVisible = !!context.readingOpen && !fullReader;
    const inspectorReserve = context.inspectorOpen && context.view === 'agent' && !context.readingOpen && width > 760 ? (width <= 980 ? 240 : 260) : 0;
    const mainMin = (pdf && context.view === 'project' ? 560 : width > 1000 ? 360 : 280) + inspectorReserve;
    const readerMinimum = pdf ? 520 : 320;
    const companionMin = readerVisible ? readerMinimum : navigatorVisible ? 170 : 0;
    const sidebarMin = sidebarFixed ? 62 : 154;
    const sidebarMax = sidebarFixed ? 62 : Math.max(sidebarMin, Math.min(330, width - margin - mainMin - companionMin));
    const sidebar = clamp(preferred.sidebar ?? base.sidebar, sidebarMin, sidebarMax);
    const companionMax = Math.max(companionMin, width - margin - mainMin - sidebar);
    const navigatorMax = Math.min(380, companionMax), readerMax = pdf ? companionMax : Math.min(960, companionMax);
    const navigator = navigatorVisible ? clamp(preferred.navigator ?? base.navigator, 170, navigatorMax) : 0;
    const available = width - margin - sidebar;
    const reader = fullReader ? width - 16 : readerVisible ? clamp((pdf ? preferred.readerPdf : preferred.reader) ?? (pdf ? available * .62 : base.reader), readerMinimum, readerMax) : 0;
    return { width, fullReader, sidebar: fullReader ? 0 : sidebar, navigator, reader,
      main: fullReader ? 0 : Math.max(0, width - margin - sidebar - navigator - reader),
      handles: { sidebar: !sidebarFixed && !fullReader, navigator: navigatorVisible && !fullReader, reader: readerVisible },
      bounds: { sidebar: [sidebarMin, sidebarMax], navigator: [170, navigatorMax], reader: [readerMinimum, readerMax] }, defaults: base };
  }
  const filesDrag = transfer => !!transfer && (Array.from(transfer.types || []).includes('Files') || Array.from(transfer.items || []).some(item => item.kind === 'file') || (transfer.files?.length || 0) > 0);
  async function droppedFiles(transfer) {
    const items = Array.from(transfer?.items || []).filter(item => item.kind === 'file');
    // DataTransfer becomes protected after the drop handler returns. Capture
    // files and start every filesystem-handle request before the first await.
    const files = Array.from(transfer?.files || []);
    if (!files.length) for (const item of items) { const file = item.getAsFile?.(); if (file) files.push(file); }
    const entries = items.map(item => item.webkitGetAsEntry?.());
    if (entries.some(entry => entry?.isDirectory)) throw new Error('暂不支持拖入文件夹，请展开文件夹后选择其中的文件。');
    const probes = items.map((item, index) => {
      try { return !entries[index] && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null; }
      catch (error) { return Promise.reject(error); }
    });
    for (const handle of await Promise.all(probes)) if (handle?.kind === 'directory') throw new Error('暂不支持拖入文件夹，请展开文件夹后选择其中的文件。');
    return Array.from(new Set(files));
  }
  function createController(hooks, env = {}) {
    const document = env.document || globalThis.document, win = env.window || globalThis;
    const q = selector => document.querySelector(selector), body = document.body;
    const names = { sidebar: '导航侧栏', navigator: '对话列表', reader: '阅读区' };
    const selectors = { sidebar: '.sidebar', navigator: '.conversation-navigator', reader: '.reading-pane' };
    const handles = {}, listeners = []; let disposed = false, drag = null, previewWidths = null, layout = null, scheduled = null, dropBusy = false;
    const on = (target, event, handler, options) => { target?.addEventListener(event, handler, options); listeners.push(() => target?.removeEventListener?.(event, handler, options)); };
    const el = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const context = () => ({ width: win.innerWidth || document.documentElement?.clientWidth || 1024, view: body.dataset.view,
      nativeShell: body.classList.contains('aibro-native'), sidebarCollapsed: body.classList.contains('sidebar-collapsed'), readingOpen: body.classList.contains('reading-open'), readingPdf: body.classList.contains('reading-pdf'), readingExpanded: body.classList.contains('reading-expanded'), inspectorOpen: body.classList.contains('inspector-open') });
    const preferences = () => ({ ...(hooks.getState()?.ui?.panelWidths || {}), ...(previewWidths || {}) });
    const preferenceKey = name => name === 'reader' && context().readingPdf ? 'readerPdf' : name;
    const dragContext = () => JSON.stringify(context());
    function persist(name, value, key = preferenceKey(name)) {
      const state = hooks.getState(); state.ui ||= {}; const widths = { ...(state.ui.panelWidths || {}) };
      if (value === null) delete widths[key]; else widths[key] = Math.round(value);
      state.ui.panelWidths = widths;
      try { Promise.resolve(hooks.save?.()).catch(() => hooks.toast?.('布局已应用，但暂时无法保存。')); }
      catch (_) { hooks.toast?.('布局已应用，但暂时无法保存。'); }
    }
    function applyThemeButtons() {
      const light = hooks.getState()?.ui?.theme === 'light';
      const label = light ? '切换深色' : '切换浅色';
      for (const button of [q('#themeBtn'), q('#sidebarThemeBtn'), q('#readerThemeBtn')].filter(Boolean)) {
        button.classList.add('layout-theme-button');
        let text = button.querySelector('.layout-theme-label');
        if (!text) { text = el('span', 'layout-theme-label'); button.append(text); }
        text.textContent = label; button.title = `${label}模式`; button.setAttribute('aria-label', `${label}模式`);
        button.setAttribute('aria-pressed', String(!light));
        button.onclick = () => { hooks.onTheme?.(); refresh(); };
      }
    }
    function addThemeButtons() {
      const sidebar = q('.sidebar-bottom');
      if (sidebar && !q('#sidebarThemeBtn')) { const button = el('button', 'sidebar-theme-control'); button.type = 'button'; button.id = 'sidebarThemeBtn'; const icon = el('span', 'layout-theme-symbol', '◐'); icon.setAttribute('aria-hidden', 'true'); button.append(icon); sidebar.append(button); }
      const toolbar = q('.reading-toolbar');
      if (toolbar && !q('#readerThemeBtn')) { const button = el('button', 'reader-theme-control'); button.type = 'button'; button.id = 'readerThemeBtn'; toolbar.insertBefore(button, q('#readingExpand')); }
      applyThemeButtons();
    }
    function refresh() {
      if (disposed) return;
      cancelSchedule();
      // A pending gesture belongs to the surface it started on, including PDF
      // width preferences. Navigation or a mode change must not reparent it.
      if (drag && drag.context !== dragContext()) { finishDrag(false); return; }
      layout = fitLayout(context(), preferences());
      body.classList.toggle('workspace-reader-focus',layout.fullReader);
      body.style.setProperty('--workspace-sidebar-width', `${layout.sidebar}px`);
      body.style.setProperty('--workspace-navigator-width', `${layout.navigator}px`);
      body.style.setProperty('--workspace-reader-width', `${layout.reader}px`);
      addThemeButtons();
      for (const name of Object.keys(handles)) {
        const handle = handles[name], target = q(selectors[name]), rect = target?.getBoundingClientRect();
        handle.hidden = !layout.handles[name] || !rect || rect.width < 1 || rect.height < 1;
        const bounds = layout.bounds[name];
        handle.setAttribute('aria-valuemin', String(Math.round(bounds[0]))); handle.setAttribute('aria-valuemax', String(Math.round(bounds[1]))); handle.setAttribute('aria-valuenow', String(Math.round(layout[name])));
        handle.setAttribute('aria-valuetext', `${names[name]}宽度 ${Math.round(layout[name])} 像素`);
        if (!handle.hidden) { const inset = name === 'reader' && body.classList.contains('aibro-native') ? 8 : 4; handle.style.left = `${(name === 'reader' ? rect.left : rect.right) - inset}px`; handle.style.top = `${Math.max(8, rect.top)}px`; handle.style.height = `${Math.max(0, rect.height - (rect.top < 8 ? 8 - rect.top : 0))}px`; }
      }
      const tabs = q('#readingTabs'), activeTab = tabs?.querySelector('[aria-selected="true"]')?.parentElement;
      if (activeTab && tabs.clientWidth > 0) {
        const left = activeTab.offsetLeft, right = left + activeTab.offsetWidth;
        if (left < tabs.scrollLeft) tabs.scrollLeft = left;
        else if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
      }
      hooks.onLayout?.();
    }
    function cancelSchedule() {
      const pending = scheduled; scheduled = null;
      if (pending?.id != null) (env.cancelAnimationFrame || win.cancelAnimationFrame)?.call(win, pending.id);
    }
    function schedule() {
      if (scheduled || disposed) return;
      const pending = {}; scheduled = pending;
      pending.id = (env.requestAnimationFrame || win.requestAnimationFrame || (fn => fn())).call(win, () => {
        // Token identity also protects environments where cancellation is not
        // available, and a callback already queued when its owner is disposed.
        if (scheduled !== pending || disposed) return;
        scheduled = null; refresh();
      });
    }
    function previewDrag(clientX) {
      if (!drag || !Number.isFinite(clientX)) return;
      const { name, startX, startWidth } = drag, [min, max] = layout.bounds[name];
      previewWidths = { [drag.preferenceKey]: clamp(startWidth + (clientX - startX) * (name === 'reader' ? -1 : 1), min, max) };
    }
    function finishDrag(commit, clientX) {
      if (!drag) return;
      const active = drag;
      commit = commit && active.context === dragContext();
      if (commit) previewDrag(clientX);
      // Read the latest preview, not the last painted layout: release can arrive
      // before the next frame, and can carry a newer position than pointermove.
      const value = commit ? fitLayout(context(), preferences())[active.name] : null;
      cancelSchedule(); drag = null; previewWidths = null;
      try { handles[active.name].releasePointerCapture?.(active.pointerId); } catch (_) {}
      body.classList.remove('workspace-resizing');
      if (commit && Number.isFinite(value) && value !== active.startWidth) persist(active.name, value, active.preferenceKey);
      refresh();
    }
    for (const name of Object.keys(names)) {
      const handle = el('div', 'workspace-separator'); handle.id = `resize-${name}`; handle.dataset.resizePane = name;
      handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', `${names[name]}宽度`); handle.tabIndex = 0;
      handle.title = `拖动调整${names[name]}宽度；方向键微调，双击恢复默认`;
      handles[name] = handle; body.append(handle);
      on(handle, 'pointerdown', event => {
        if (event.button !== 0 || handle.hidden || drag) return; event.preventDefault();
        drag = { name, startX: event.clientX, startWidth: layout[name], preferenceKey: preferenceKey(name), pointerId: event.pointerId, context: dragContext() };
        previewWidths = {}; handle.setPointerCapture?.(event.pointerId); body.classList.add('workspace-resizing'); handle.focus({ preventScroll: true });
      });
      on(handle, 'dblclick', event => { event.preventDefault(); finishDrag(false); persist(name, null); refresh(); });
      on(handle, 'lostpointercapture', event => { if (drag?.pointerId === event.pointerId) finishDrag(false); });
      on(handle, 'keydown', event => {
        if (handle.hidden || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); finishDrag(false); const [min, max] = layout.bounds[name];
        const direction = name === 'reader' ? -1 : 1;
        const step = event.shiftKey ? 40 : 16;
        const next = event.key === 'Home' ? min : event.key === 'End' ? max : layout[name] + (event.key === 'ArrowRight' ? 1 : -1) * direction * step;
        persist(name, clamp(next, min, max)); refresh();
      });
    }
    on(win, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.context !== dragContext()) { finishDrag(false); return; }
      previewDrag(event.clientX); schedule();
    });
    on(win, 'pointerup', event => { if (drag && event.pointerId === drag.pointerId) finishDrag(true, event.clientX); });
    on(win, 'pointercancel', event => { if (drag && event.pointerId === drag.pointerId) finishDrag(false); });
    on(win, 'blur', () => { finishDrag(false); hideDrop(); });
    on(document, 'keydown', event => { if (event.key === 'Escape') { if (drag) { event.preventDefault(); finishDrag(false); } hideDrop(); } });
    on(win, 'resize', () => { finishDrag(false); schedule(); hideDrop(); });
    // CSS transforms do not trigger ResizeObserver; align the handle again when pane entry ends.
    on(document, 'animationend', event => { if (event.target?.matches?.('.reading-pane,.sidebar,.conversation-navigator')) schedule(); }, true);

    const overlay = el('div', 'workspace-drop-overlay'); overlay.id = 'conversationDropOverlay'; overlay.hidden = true;
    const dropCard = el('div', 'workspace-drop-card'); const dropMark = el('span', 'workspace-drop-mark', '↓'); dropMark.setAttribute('aria-hidden', 'true');
    const dropTitle = el('strong', '', '添加到待发送材料');
    const dropDescription = el('span', '', '随下一条指令交给 AI，发送前可移除');
    dropCard.append(dropMark, dropTitle, dropDescription);
    overlay.append(dropCard); overlay.setAttribute('role', 'status'); overlay.setAttribute('aria-live', 'polite'); body.append(overlay);
    function hideDrop() { overlay.hidden = true; }
    function localDropOwner(event) {
      const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
      const owner = target?.closest?.('[data-aibro-file-drop-owner]');
      if (!owner || !['document-image', 'capture-attachment'].includes(owner.getAttribute('data-aibro-file-drop-owner'))) return null;
      // Only an explicit live editor/capture contract can take ownership. A
      // contenteditable attribute or imported HTML is never enough to bypass
      // the global protection against navigating to a dropped local file.
      let enabled = false;
      try {
        const rect = owner.getBoundingClientRect();
        enabled = document.contains(owner) && rect.width > 0 && rect.height > 0 && owner.aibroCanReceiveFileDrop?.() === true;
      } catch (_) { /* unavailable owners remain blocked */ }
      return { owner, enabled };
    }
    function dropSurface() {
      const view = body.dataset.view;
      if (view !== 'agent' && view !== 'project') return null;
      const element = q(view === 'agent' ? '#agent' : '#project');
      if (!element) return null;
      const rect = element.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return null;
      const state = hooks.getState(); const project = view === 'project';
      const id = project ? state?.currentProjectId : state?.currentConversationId;
      const records = project ? state?.projects : state?.conversations;
      const record = Array.isArray(records) && records.find(item => item && item.id === id && !item.archived && !item.archivedAt && !item.deleted && !item.deletedAt && !['archived', 'deleted'].includes(item.status));
      if (!record || (project && typeof hooks.stageProjectFiles !== 'function')) return null;
      return { kind: project ? 'project' : 'conversation', id, element, rect };
    }
    function showDrop(event) {
      const target = dropSurface();
      if (!target?.element.contains(event.target) || dropBusy || hooks.isImportBusy?.()) { hideDrop(); return false; }
      const project = target.kind === 'project';
      overlay.dataset.dropTarget = target.kind;
      dropTitle.textContent = project ? '保存到当前项目' : '添加到待发送材料';
      dropDescription.textContent = project ? '原件先保存，待 AI 分析' : '随下一条指令交给 AI，发送前可移除';
      const { rect } = target;
      overlay.style.left = `${rect.left}px`; overlay.style.top = `${rect.top}px`; overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`; overlay.hidden = false; return true;
    }
    for (const type of ['dragenter', 'dragover']) on(document, type, event => {
      if (!filesDrag(event.dataTransfer)) return;
      const local = localDropOwner(event);
      if (local) {
        hideDrop();
        if (!local.enabled) { event.preventDefault(); event.stopImmediatePropagation(); }
        if (event.dataTransfer) event.dataTransfer.dropEffect = local.enabled ? 'copy' : 'none';
        return; // The live owner handles the actual editor/capture dragover.
      }
      event.preventDefault(); const accepted = showDrop(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
    }, true);
    on(document, 'dragleave', event => { if (!event.relatedTarget || !dropSurface()?.element.contains(event.relatedTarget)) hideDrop(); }, true);
    on(document, 'dragend', hideDrop, true);
    const handledDrops = new WeakSet();
    on(document, 'drop', async event => {
      if (!filesDrag(event.dataTransfer)) return;
      const local = localDropOwner(event);
      if (local) {
        hideDrop();
        // During dragover the file list is protected and may be empty. At drop
        // our live owners require real Files; otherwise neither editor consumes
        // the event, so keep the default file-navigation protection here.
        if (!local.enabled || !event.dataTransfer?.files?.length) {
          event.preventDefault(); event.stopImmediatePropagation();
          hooks.toast?.(local.enabled ? '没有读取到可用文件，请重新拖入或使用文件选择按钮。' : '当前编辑区域暂时不能接收文件，请完成当前输入或保存后重试。');
        }
        return; // Preserve capture/bubble delivery to the specific owner.
      }
      event.preventDefault(); event.stopImmediatePropagation(); hideDrop();
      if (handledDrops.has(event)) return; handledDrops.add(event);
      const target = dropSurface();
      if (!target?.element.contains(event.target)) { hooks.toast?.('请将文件拖入对话区域或具体项目，或使用附件按钮。'); return; }
      if (dropBusy || hooks.isImportBusy?.()) { hooks.toast?.('正在添加资料，请稍候再拖入文件。'); return; }
      dropBusy = true;
      try {
        const files = await droppedFiles(event.dataTransfer);
        if (disposed) return;
        const current = dropSurface();
        if (!current || current.kind !== target.kind || current.id !== target.id) { hooks.toast?.(target.kind === 'project' ? '项目已切换、删除或归档，请在目标项目重新拖放文件。' : '对话已切换或不可用，请在目标对话重新拖放文件。'); return; }
        if (!files.length) { hooks.toast?.('没有读取到可添加的文件，请使用附件按钮重试。'); return; }
        if (target.kind === 'project') await hooks.stageProjectFiles(files, target.id);
        else await hooks.stageDroppedFiles(files);
      } catch (error) { hooks.toast?.(error?.message || '文件暂时无法读取，请使用附件按钮重试。'); }
      finally { dropBusy = false; }
    }, true);
    body.classList.add('workspace-layout-ready');
    const Observer = env.MutationObserver || win.MutationObserver;
    const observer = Observer ? new Observer(schedule) : null;
    observer?.observe(body, { attributes: true, attributeFilter: ['class', 'data-view'] });
    refresh();
    return { refresh, snapshot: () => ({ layout, dragging: !!drag, dropBusy }), reset: name => { if (Object.hasOwn(names, name)) { finishDrag(false); persist(name, null); refresh(); } },
      destroy() { disposed = true; cancelSchedule(); finishDrag(false); observer?.disconnect(); listeners.forEach(fn => fn()); for (const node of [...Object.values(handles), overlay, q('#sidebarThemeBtn'), q('#readerThemeBtn')]) node?.remove(); body.classList.remove('workspace-layout-ready'); } };
  }
  let controller;
  return { fitLayout, defaults, filesDrag, droppedFiles, createController,
    init(hooks, env) { controller?.destroy(); controller = createController(hooks, env); return controller; }, refresh: () => controller?.refresh() };
});
