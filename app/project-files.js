/* A connected project's navigation and user-directed editor. Disk writes use the
   same versioned, journalled proposal APIs as Agent review, never a new bypass. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectFiles = api;
})(globalThis, root => {
  'use strict';
  const active = value => value && !value.archived && !value.archivedAt && !value.deletedAt && !value.deleted;
  const localId = ref => JSON.stringify([ref.projectId, ref.candidateId, ref.path]);
  function parseLocal(id, state, { allowDisconnected = false } = {}) {
    try {
      const identity = JSON.parse(id);
      if (!Array.isArray(identity) || identity.length !== 3 || identity.some(value => typeof value !== 'string' || !value)) return null;
      const [projectId, candidateId, path] = identity;
      if (/[\x00-\x1f\x7f]/.test(projectId + candidateId) || /[\x00\\%]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return null;
      const project = state.projects.find(p => active(p) && p.id === projectId);
      if (!project) return null;
      const disconnected = project.localFolder?.id !== candidateId;
      // Recovery may identify an old binding, but all actual reads and writes
      // still call valid() below using the strict default path.
      if (disconnected && !allowDisconnected) return null;
      return { id, projectId, candidateId, path, title: path.split('/').at(-1), type: 'local', ...(disconnected ? { disconnected: true } : {}) };
    } catch (_) { return null; }
  }
  function resolveDocumentLink(ref, url, state = hooks?.getState?.()) {
    if (!ref || !state || !parseLocal(localId(ref), state) || typeof url !== 'string' || !url
      || /^[#\/\\]/.test(url) || /^[a-z][a-z\d+.-]*:/i.test(url) || /[\x00-\x1f\x7f\\?]/.test(url)) return null;
    const hash = url.indexOf('#'), rawPath = hash < 0 ? url : url.slice(0, hash);
    // Decode exactly once. Encoded separators and double encodings never gain
    // another interpretation in the renderer, host or filesystem endpoint.
    if (/%(?:2f|5c)/i.test(rawPath)) return null;
    let path, fragment;
    try { path = decodeURIComponent(rawPath); fragment = hash < 0 ? null : decodeURIComponent(url.slice(hash + 1)); } catch (_) { return null; }
    if (!path || /^[\/\\]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path) || /[\x00-\x1f\x7f\\%?#]/.test(path)
      || fragment !== null && /[\x00-\x1f\x7f]/.test(fragment)) return null;
    const parts = ref.path.split('/').slice(0, -1);
    for (const part of path.split('/')) {
      if (!part) return null;
      if (part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); }
      else parts.push(part);
    }
    const target = { ...ref, path: parts.join('/') };
    return parseLocal(localId(target), state) ? { path: target.path, fragment } : null;
  }
  function libraryEntries(notes, imports) {
    return [...notes.map(item => ({ type: 'note', item, name: item.title || '未命名笔记', folder: item.folderPath || '知识库' })),
      ...imports.map(item => ({ type: 'import', item, name: item.name || item.originalName || '未命名资料', folder: item.folderPath || '原始资料' }))]
      .map(entry => ({ ...entry, path: [...String(entry.folder).split('/').filter(Boolean), entry.name].join('/') }))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  }
  function hierarchy(entries) {
    const tree = { folders: new Map(), files: [], path: '' };
    for (const entry of entries) {
      let node = tree;
      for (const part of entry.path.split('/').slice(0, -1)) {
        if (!node.folders.has(part)) node.folders.set(part, { name: part, path: [node.path, part].filter(Boolean).join('/'), folders: new Map(), files: [] });
        node = node.folders.get(part);
      }
      node.files.push(entry);
    }
    return tree;
  }
  function formatMarkdown(text, start, end, kind) {
    let selected = text.slice(start, end), prefix = '', suffix = '';
    if (kind === 'bold') { prefix = '**'; suffix = '**'; selected ||= '文字'; }
    if (kind === 'link') { prefix = '['; suffix = '](https://)'; selected ||= '链接文字'; }
    if (kind === 'code') { prefix = '`'; suffix = '`'; selected ||= 'code'; }
    if (kind === 'heading' || kind === 'list') {
      start = text.lastIndexOf('\n', start - 1) + 1;
      selected = text.slice(start, end) || (kind === 'heading' ? '标题' : '事项');
      prefix = kind === 'heading' ? '## ' : '- ';
      selected = selected.split('\n').join('\n' + prefix);
    }
    const replacement = prefix + selected + suffix;
    return { text: text.slice(0, start) + replacement + text.slice(end), start: start + prefix.length, end: start + prefix.length + selected.length };
  }
  let hooks, editorController = null;
  // Project routing can replace a tree host (for example when the next project
  // has no local folder). Ownership must not keep that detached DOM alive.
  const treeContexts = new WeakMap();
  const treeStates = new Map();
  const doc = () => root.document;
  const el = (tag, cls = '', value) => { const n = doc().createElement(tag); n.className = cls; if (value !== undefined) n.textContent = value; return n; };
  const button = (label, action, cls = 'project-file-button') => { const n = el('button', cls, label); n.type = 'button'; n.onclick = action; return n; };
  const request = (url, payload) => root.FileContext.request(url, payload);
  const valid = ref => { if (!parseLocal(localId(ref), hooks.getState())) throw Error('项目目录已断开或归档，修改仍保留在编辑器中。'); };
  function markSelected() {
    const selected = hooks.getState().previewRecord;
    doc().querySelectorAll('[data-project-file-key]').forEach(row => row.setAttribute('aria-current', String(row.dataset.projectFileKey === JSON.stringify([selected?.type, selected?.id]))));
  }
  function render(host, project, options) {
    let prefs = treeStates.get(project.id);
    if (!prefs) { prefs = { query: '', closed: new Set(), localCache: new Map() }; treeStates.set(project.id, prefs); }
    if (prefs.candidateId !== project.localFolder?.id) { prefs.candidateId = project.localFolder?.id; prefs.localCache.clear(); }
    const context = { host, project, options };
    treeContexts.set(host, context);
    host.replaceChildren(); host.classList.add('project-files');
    const header = el('div', 'project-files-tools');
    const search = el('input', 'project-files-search'); search.type = 'search'; search.value = prefs.query;
    search.placeholder = '筛选文件或路径'; search.setAttribute('aria-label', '筛选项目文件或路径');
    const refresh = button('↻', () => { prefs.localCache.clear(); paint(); }, 'project-files-refresh'); refresh.title = '刷新本机目录'; refresh.setAttribute('aria-label', refresh.title); refresh.hidden = !project.localFolder;
    header.append(search, refresh); host.append(header);
    const tree = el('nav', 'project-files-tree'); tree.setAttribute('aria-label', '项目文件目录'); host.append(tree);
    const extras = el('div', 'project-files-records'); extras.innerHTML = options.recordsHtml || ''; host.append(extras);
    search.oninput = () => { prefs.query = search.value; paint(); };
    function leaf(entry, parent) {
      const ref = entry.type === 'local' ? { type: 'local', projectId: project.id, candidateId: project.localFolder.id, path: entry.path, title: entry.name } : { type: entry.type, id: entry.item.id };
      const id = ref.type === 'local' ? localId(ref) : ref.id, kind = ref.type === 'local' ? 'local-file' : ref.type;
      const row = button('', () => { void hooks.open(kind, id, undefined, undefined, undefined, { anchor: row }); }, 'project-file-row');
      row.dataset.projectFileKey = JSON.stringify([kind, id]); row.dataset.fileRef = JSON.stringify(ref); row.title = entry.path;
      const icon = el('span', 'project-file-icon', entry.type === 'note' ? '≡' : /\.(md|mdx)$/i.test(entry.name) ? 'M↓' : /\.(js|ts|py|swift|css|json)$/i.test(entry.name) ? '‹›' : '▤'); icon.setAttribute('aria-hidden', 'true');
      const name = el('span', 'project-file-name', entry.name); name.dataset.userContent = '';
      row.append(icon, name);
      if (entry.type !== 'local') row.append(el('small', 'project-file-kind', entry.type === 'note' ? '笔记' : '原件'));
      if (entry.supported === false) { row.disabled = true; row.title += ' · 此格式请通过附件导入'; }
      parent.append(row);
    }
    function folder(name, path, parent, draw, defaultOpen = true) {
      const details = el('details', 'project-files-folder'); details.dataset.projectFolder = path;
      details.open = prefs.query ? true : defaultOpen && !prefs.closed.has(path);
      const summary = el('summary'); const label = el('span', '', name); label.dataset.userContent = ''; summary.append(el('span', 'project-folder-icon', '▱'), label);
      const children = el('div', 'project-files-children'); details.append(summary, children); parent.append(details);
      let drawn=false;const ensureChildren=()=>{if(!drawn){drawn=true;draw(children);}};
      details.addEventListener('toggle', () => { if(!details.isConnected || treeContexts.get(host)!==context)return; if (details.open) { prefs.closed.delete(path); ensureChildren(); } else prefs.closed.add(path); });
      if (details.open) ensureChildren();
      return details;
    }
    function library(node, parent) {
      [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach(child => folder(child.name, 'library/' + child.path, parent, target => { target.replaceChildren(); library(child, target); }));
      node.files.forEach(entry => leaf(entry, parent));
    }
    async function local(path, parent, offset = 0) {
      if (parent.dataset.loaded === 'true' && !offset) return;
      parent.dataset.loaded = 'true';
      if (!offset) parent.replaceChildren();
      const status = el('p', 'project-files-status', '正在读取目录…'); parent.append(status);
      try {
        valid({ projectId: project.id, candidateId: project.localFolder.id, path: path || 'README.md' });
        const key = path + ':' + offset;
        let data = prefs.localCache.get(key);
        if (!data) data = await request('/__local/files', { candidateId: project.localFolder.id, path, offset });
        if (treeContexts.get(host) !== context || !parent.isConnected) return;
        prefs.localCache.set(key, data);
        status.remove();
        const query = prefs.query.trim().toLocaleLowerCase();
        data.entries.forEach(entry => {
          // Directories stay visible while filtering because descendants are loaded on demand.
          if (entry.type === 'directory') folder(entry.name, 'local/' + entry.path, parent, target => local(entry.path, target), prefs.localCache.has(entry.path + ':0'));
          else if (!query || entry.path.toLocaleLowerCase().includes(query)) leaf({ ...entry, type: 'local' }, parent);
        });
        if (!parent.children.length) parent.append(el('p', 'project-files-status', query ? '此目录没有匹配文件' : '空目录'));
        if (data.nextOffset !== null) parent.append(button('加载更多', event => { event.currentTarget.remove(); void local(path, parent, data.nextOffset); }, 'project-files-more'));
        markSelected();
      } catch (error) { parent.dataset.loaded = ''; status.textContent = error.message; status.append(button('重试', () => local(path, parent), 'project-files-more')); }
    }
    function paint() {
      tree.replaceChildren();
      const query = prefs.query.trim().toLocaleLowerCase();
      const entries = libraryEntries(options.notes, options.imports).filter(entry => !query || entry.path.toLocaleLowerCase().includes(query));
      if (entries.length) library(hierarchy(entries), tree);
      else if (!project.localFolder) tree.append(el('p', 'project-files-status', query ? '没有匹配的文件' : '还没有项目文件'));
      if (project.localFolder) folder(project.localFolder.name || '本机目录', 'local-root', tree, target => local('', target));
      const hint = el('p', 'project-files-hint', project.localFolder ? '笔记与原件按目录组织 · 本机目录展开后按需读取' : '笔记与原件按保存目录组织'); tree.append(hint); markSelected();
    }
    tree.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      const current = event.target.closest('summary,.project-file-row'); if (!current) return;
      const rows = [...tree.querySelectorAll('summary,.project-file-row')].filter(row => !row.disabled && row.getClientRects().length);
      const index = rows.indexOf(current); let next;
      if (event.key === 'Home') next = rows[0];
      if (event.key === 'End') next = rows.at(-1);
      if (event.key === 'ArrowDown') next = rows[index + 1];
      if (event.key === 'ArrowUp') next = rows[index - 1];
      if (event.key === 'ArrowRight' && current.tagName === 'SUMMARY') { if(current.parentElement.open)next=rows[index+1];else current.parentElement.open=true; }
      if (event.key === 'ArrowLeft') { const details = current.closest('details'); if (current.tagName !== 'SUMMARY')next=details?.querySelector(':scope > summary');else if(details.open)details.open=false;else next=details?.parentElement.closest('details')?.querySelector(':scope > summary'); }
      event.preventDefault(); (next || current).focus();
    });
    paint();
  }
  async function readFile(ref) {
    valid(ref); let text = '', offset = 0, version;
    do {
      const part = await request('/__local/read', { candidateId: ref.candidateId, path: ref.path, offset, ...(version ? { version } : {}) });
      version = part.version; text += part.text; offset = part.nextOffset;
    } while (offset !== null);
    valid(ref); return { content: text, version };
  }
  async function openDocumentLink(ref, target, options = {}) {
    if (!target || typeof target.path !== 'string' || (target.fragment != null && (typeof target.fragment !== 'string' || /[\x00-\x1f\x7f]/.test(target.fragment)))) return false;
    const id = localId({ ...ref, path: target.path });
    const available = () => (!options.isCurrent || options.isCurrent()) && editorController?.current()?.id === ref.id
      && !!parseLocal(localId(ref), hooks.getState()) && !!parseLocal(id, hooks.getState());
    if (!available()) return false;
    if (id === ref.id) return target.fragment == null ? true : editorController.revealFragment(target.fragment);
    const navigationCurrent = hooks.captureNavigation?.() || (() => true);
    // Check existence/type/grant with the same read endpoint before replacing
    // the source document. The real mount still reads and verifies its version.
    await request('/__local/read', { candidateId: ref.candidateId, path: target.path, offset: 0 });
    if (!navigationCurrent() || !available()) return false;
    const opened = await hooks.open('local-file', id, undefined, undefined, available, { anchor: options.anchor, isCurrent: available });
    if (opened === false || editorController?.current()?.id !== id) return false;
    return target.fragment == null ? true : editorController.revealFragment(target.fragment);
  }
  function controller() {
    if (!editorController) editorController = root.LocalDocumentEditor.create({
      ...hooks, valid, request, readFile, resolveDocumentLink, openDocumentLink,
      draftRequest: async (url, options = {}) => {
        const response = await root.fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
        const result = await response.json();
        if (!response.ok) { const error = new Error(result.error || result.message || '本机草稿请求失败'); error.code = result.code; throw error; }
        return result;
      }
    });
    return editorController;
  }
  const mount = (container, ref, options) => controller().mount(container, ref, options);
  const beforeLeave = () => editorController?.beforeLeave() ?? true;
  const unmount = options => editorController?.unmount(options) ?? true;
  function formattingBar(input, changed) {
    const bar = el('div', 'document-formatting'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Markdown 格式');
    for (const [kind, title, label] of [['heading', '插入二级标题', 'H₂'], ['bold', '加粗', 'B'], ['list', '列表', '☷'], ['link', '插入链接', '↗'], ['code', '行内代码', '‹›']]) {
      const control = button(label, () => { const result = formatMarkdown(input.value, input.selectionStart, input.selectionEnd, kind); input.value = result.text; input.focus(); input.setSelectionRange(result.start, result.end); changed(); }, 'document-format-button');
      control.title = title; control.setAttribute('aria-label', title); control.dataset.markdownFormat = kind; bar.append(control);
    }
    return bar;
  }
  return { localId, parseLocal, resolveDocumentLink, openDocumentLink, libraryEntries, hierarchy, formatMarkdown, formattingBar, render, mount, beforeLeave, unmount, markSelected,
    init(value) { hooks = value; root.addEventListener?.('beforeunload', event => { if (editorController?.current()?.dirty || editorController?.current()?.saving) { event.preventDefault(); event.returnValue = ''; } }); },
    current: () => editorController?.current() || null,
    prepareExport: () => editorController?.prepareExport() ?? Promise.resolve(null),
    save: () => editorController?.save() || Promise.resolve(false),
    close: () => beforeLeave(),
    suspend: options => editorController?.suspend(options) ?? Promise.resolve(true),
    flushDrafts: () => editorController?.flushDrafts() ?? Promise.resolve(true),
    capturePosition: () => editorController?.capturePosition() || null,
    restorePosition: bookmark => editorController?.restorePosition(bookmark) ?? Promise.resolve(false),
    currentContent: () => editorController?.currentContent() || null,
    getDraft: id => editorController?.getDraft(id) || null,
    renderForProject(host, id) { const state=hooks.getState(),project=state.projects.find(p=>p.id===id&&active(p));if(!project){host.replaceChildren();return false;}render(host,project,{notes:state.notes.filter(n=>active(n)&&n.projectId===id),imports:state.imports.filter(n=>active(n)&&n.projectId===id)});return true; },
    // Discover live hosts from the document instead of keeping an enumerable
    // registry of every tree ever mounted. Unowned matching nodes are ignored.
    refresh() { for(const host of doc().querySelectorAll('.project-files')){const context=treeContexts.get(host);if(context)render(host,context.project,context.options);} }
  };
});
