/* Reusable CMS collection backed by the current persistent workspace. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(() => require('./citation-evidence'));
  else root.CollectionUI = factory(() => root.CitationEvidence);
}(typeof self !== 'undefined' ? self : this, function (getEvidence) {
  'use strict';
  let hooks = {};
  const stateByContainer = new WeakMap();
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ws = value => value === '课程' || value === '科研' ? value : '日常';
  const typeLabels = { task: '任务', note: '笔记', import: '资料', paper: '论文' };
  const statusLabels = { todo: '待开始', in_progress: '进行中', done: '已完成', blocked: '受阻' };
  function noteLabel(item) {
    if (item.aiDraft) return '待审阅';
    const memories = { daily: '项目日记', plan: '项目计划', long: '长期记忆' };
    if (Object.hasOwn(memories, item.projectMemoryType)) return memories[item.projectMemoryType];
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    return !kind || kind === 'note' ? '笔记' : kind;
  }
  const getState = () => hooks.getState?.() || {};
  const list = value => Array.isArray(value) ? value.filter(Boolean) : [];
  const ownerIds = new WeakMap(); let nextOwnerId = 0;
  const ownerId = value => { if (!ownerIds.has(value)) ownerIds.set(value, ++nextOwnerId); return ownerIds.get(value); };
  const pendingPreferences = new Map(); let preferenceTimer = null;
  function preferences(value, options = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const types = ['all', ...Object.keys(typeLabels).filter(type => !options.types || options.types.includes(type)), ...(!options.types || options.types.includes('import') ? ['pending-analysis'] : [])];
    const views = ['list', 'tree', 'cards'];
    return { query: typeof input.query === 'string' ? input.query : '', type: types.includes(input.type) ? input.type : 'all',
      sort: ['updated', 'name', 'type'].includes(input.sort) ? input.sort : 'updated', dir: ['asc', 'desc'].includes(input.dir) ? input.dir : 'desc',
      view: views.includes(input.view) ? input.view : views.includes(options.defaultView) ? options.defaultView : 'list' };
  }
  function preferenceOwner(options, state = getState()) {
    if (typeof options.projectId !== 'string' || !options.projectId || globalThis.PrivateMode?.isOn?.()) return null;
    const projects = list(state.projects).filter(project => project.id === options.projectId), project = projects[0];
    if (projects.length !== 1 || !visible(project) || options.workspace && ws(project.workspace) !== ws(options.workspace)) return null;
    // Project-level ancestry includes private runs/conversations and retired
    // owners. A missing privacy dependency must not authorize persistence.
    const access = getEvidence()?.access?.(state, { type: 'local', projectId: project.id });
    if (!access || access.kind === 'private') return null;
    return { workspace: ownerId(state), project: ownerId(project), projectId: project.id };
  }
  const sameOwner = (left, right) => !!left && !!right && left.workspace === right.workspace && left.project === right.project && left.projectId === right.projectId;
  function savedPreferences(state, projectId) {
    const saved = state.ui?.projectCollectionPreferences;
    return saved && typeof saved === 'object' && !Array.isArray(saved) && Object.hasOwn(saved, projectId) ? saved[projectId] : undefined;
  }
  function flushPreferences() {
    if (preferenceTimer !== null) clearTimeout(preferenceTimer);
    preferenceTimer = null;
    const state = getState(); let save = false;
    for (const { owner, snapshot } of pendingPreferences.values()) {
      if (owner.workspace !== ownerId(state)) continue;
      const current = preferenceOwner({ projectId: owner.projectId }, state);
      if (sameOwner(owner, current)) save = true;
      else if (!current && JSON.stringify(savedPreferences(state, owner.projectId)) === JSON.stringify(snapshot)) {
        // Do not leave an unsaved revoked query for an unrelated later save.
        delete state.ui.projectCollectionPreferences[owner.projectId];
      }
    }
    pendingPreferences.clear();
    if (save) {
      const failed = () => hooks.toast?.('资料浏览偏好未能保存，请稍后重试。');
      try { Promise.resolve(hooks.save?.()).then(result => { if (result === false) failed(); }, failed); }
      catch { failed(); }
    }
  }
  function canChangePreferences(ui) {
    return !ui.busy && (!ui.options.projectId || sameOwner(ui.preferenceOwner, preferenceOwner(ui.options)));
  }
  function rememberPreferences(ui) {
    if (ui.composing) return;
    const snapshot = preferences(ui, ui.options); Object.assign(ui, snapshot); ui.confirmedQuery = snapshot.query;
    const state = getState(), owner = preferenceOwner(ui.options, state);
    if (!sameOwner(owner, ui.preferenceOwner) || JSON.stringify(savedPreferences(state, owner.projectId)) === JSON.stringify(snapshot)) return;
    if (!state.ui || typeof state.ui !== 'object' || Array.isArray(state.ui)) state.ui = {};
    if (!state.ui.projectCollectionPreferences || typeof state.ui.projectCollectionPreferences !== 'object' || Array.isArray(state.ui.projectCollectionPreferences)) state.ui.projectCollectionPreferences = {};
    Object.defineProperty(state.ui.projectCollectionPreferences, owner.projectId, { value: snapshot, enumerable: true, configurable: true, writable: true });
    // Only numeric owner tokens and five primitive values reach the timer;
    // it neither retains a host/IME node nor writes a delayed value into B.
    pendingPreferences.set(`${owner.workspace}:${owner.projectId}`, { owner, snapshot });
    if (preferenceTimer !== null) clearTimeout(preferenceTimer);
    preferenceTimer = setTimeout(flushPreferences, 500); preferenceTimer?.unref?.();
  }
  const itemKey = item => `${item._type}:${item.id}`;
  const timestamp = value => {
    if (value === null || value === undefined || value === '') return 0;
    const number = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
    return Number.isFinite(number) && Number.isFinite(new Date(number).getTime()) ? number : 0;
  };
  const svg = kind => {
    const paths = { task: '<path d="M5 6h14M5 12h14M5 18h9"/>', note: '<path d="M6 3h9l3 3v15H6zM9 11h6M9 15h6"/>', paper: '<path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4"/>', import: '<path d="M6 3h9l3 3v15H6zM15 3v4h3"/>' };
    return `<svg class="collection-icon ${kind}" viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.import}</svg>`;
  };
  function stateFor(container) {
    if (!stateByContainer.has(container)) stateByContainer.set(container, { query: '', type: 'all', sort: 'updated', dir: 'desc', view: 'list', selected: new Set(), options: {}, scope: '', composing: false, busy: false, filterKey: '', collapsed: new Set() });
    return stateByContainer.get(container);
  }
  function visible(record, options = {}, projects = new Map(list(getState().projects).map(project => [project.id, project]))) {
    const active = item => item && !item.archived && !item.archivedAt && !item.deleted && !item.deletedAt && !['archived', 'deleted'].includes(item.status) && !item.private && !item.ephemeral && !item.incognito;
    if (!active(record) || !record.id) return false;
    if (options.projectId && record.projectId !== options.projectId) return false;
    const project = record.projectId && projects.get(record.projectId);
    if (project && !active(project)) return false;
    return !options.workspace || ws(project?.workspace || record.workspace) === ws(options.workspace);
  }
  function records(options = {}) {
    const state = getState(); const projects = new Map(list(state.projects).map(project => [project.id, project]));
    // Resolve lazily: the shared evidence module loads after this controller.
    // Fail closed if the required privacy dependency is unavailable.
    const access = getEvidence()?.createAccessContext?.(state);
    if (!access) return [];
    const output = [];
    for (const [collection, type] of [['tasks', 'task'], ['notes', 'note'], ['imports', 'import'], ['papers', 'paper']]) {
      if (Array.isArray(options.types) && !options.types.includes(type)) continue;
      for (const item of list(state[collection])) {
        const source = {type, id: item.id};
        if (access.access(source).kind === 'private' || access.isAmbiguous(source)) continue;
        if (!visible(item, options, projects)) continue;
        const projectRecord = type === 'note' && ['daily', 'plan', 'long'].includes(item.projectMemoryType);
        if (options.projectId && (options.libraryScope === 'content' && projectRecord || options.libraryScope === 'records' && !projectRecord)) continue;
        const folder=String(item.folderPath||'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
        if(typeof options.folderPath==='string' && !(options.folderPath==='' ? folder==='' : folder===options.folderPath || folder.startsWith(options.folderPath+'/')))continue;
        const project = projects.get(item.projectId);
        const analysis = type === 'import' ? hooks.getAnalysis?.(item) || { status: 'pending', label: '待 AI 分析', detail: '原件已保存，尚未生成分析成果。' } : null;
        const meta = type === 'task' ? (statusLabels[item.status] || '待开始') : type === 'paper' ? (item.reviewed ? '已审阅' : '待审阅') : type === 'note' ? noteLabel(item) : (analysis.label || (analysis.status === 'analyzed' ? '已分析' : '待 AI 分析'));
        output.push({ ...item, _type: type, _title: item.title || item.name || item.originalName || `未命名${typeLabels[type]}`, _updated: timestamp(item.updatedAt) || timestamp(item.createdAt), _meta: meta, _analysis: analysis, _projectName: project?.name || item.project || (item.workspace === '科研' ? '独立科研资料' : '未归属项目') });
      }
    }
    return output;
  }
  function filteredItems(items, ui) {
    const query = String(ui.query || '').trim().toLocaleLowerCase();
    return items.filter(item => (ui.type === 'all' || item._type === ui.type || (ui.type === 'pending-analysis' && item._type === 'import' && item._analysis?.status === 'pending')) && (!query || `${item._title} ${item._meta} ${item._projectName} ${item.folderPath || ''} ${list(item.tags).join(' ')}`.toLocaleLowerCase().includes(query))).sort((a, b) => {
      const comparison = ui.sort === 'name' ? collator.compare(a._title, b._title) : ui.sort === 'type' ? collator.compare(typeLabels[a._type], typeLabels[b._type]) : a._updated - b._updated;
      return comparison * (ui.dir === 'asc' ? 1 : -1) || collator.compare(a._title, b._title) || itemKey(a).localeCompare(itemKey(b));
    });
  }
  function displayItems(items, ui) {
    if (ui.view !== 'tree' || ui.type === 'paper') return items;
    const notes = new Set(items.filter(item => item._type === 'note').map(item => item.id));
    return items.filter(item => item._type !== 'paper' || !notes.has(item.noteId));
  }
  function treeGroups(items, options = {}) {
    const root = { children: new Map(), items: [], count: 0 };
    for (const item of items) {
      const folders = String(item.folderPath || '').split(/[\\/]/).map(part => part.trim()).filter(part => part && part !== '.' && part !== '..').slice(0, 12);
      const owner = options.projectId ? [] : [item._projectName];
      const parts = [...owner, ...(folders.length ? folders : [item._type === 'task' ? '任务' : item._type === 'import' ? '原始资料' : '笔记'])];
      let node = root; node.count++;
      for (const part of parts) {
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), items: [], count: 0 });
        node = node.children.get(part); node.count++;
      }
      node.items.push(item);
    }
    return root;
  }
  async function mergeSelected(container) {
    const ui = stateFor(container); if (ui.busy || typeof hooks.mergeNotes !== 'function') return false;
    const chosen = selectedRecords(ui); if (chosen.length < 2 || chosen.some(item => item._type !== 'note')) return false;
    const filterKey = ui.filterKey; ui.busy = true; rerender(container);
    try {
      const merged = await hooks.mergeNotes(chosen.map(item => item.id));
      if (merged && ui.filterKey === filterKey) ui.selected.clear();
      return !!merged;
    } catch (error) { hooks.toast?.(error.message || '合并未完成'); return false; }
    finally { ui.busy = false; rerender(container); }
  }
  function setSelectedCompletion(selected, options, done, now = Date.now()) {
    const allowed = new Set(records(options).filter(item => item._type === 'task').map(itemKey));
    let count = 0;
    for (const task of list(getState().tasks)) {
      const key = itemKey({ ...task, _type: 'task' });
      if (!selected.has(key) || !allowed.has(key) || (task.status === 'done') === done) continue;
      task.status = done ? 'done' : 'todo'; task.updatedAt = now;
      if (done) task.completedAt = now; else delete task.completedAt;
      count += 1;
    }
    return count;
  }
  function completeSelected(selected, options, now = Date.now()) { return setSelectedCompletion(selected, options, true, now); }
  function selectedRecords(ui, keys = ui.selected) { return displayItems(filteredItems(records(ui.options), ui), ui).filter(item => keys.has(itemKey(item))); }
  async function deleteRecords(container, singleKey) {
    const ui = stateFor(container); if (ui.busy) return false;
    const chosen = selectedRecords(ui, singleKey ? new Set([singleKey]) : ui.selected);
    if (!chosen.length) { hooks.toast?.('所选内容已变化，请重新选择。'); rerender(container); return false; }
    if (typeof hooks.deleteItems !== 'function') { hooks.toast?.('删除操作暂不可用，请重新打开应用。'); return false; }
    const options = { workspace: ui.options.workspace, projectId: ui.options.projectId }, filterKey = ui.filterKey;
    const selections = chosen.map(item => ({ type: item._type, id: item.id }));
    ui.busy = true; rerender(container);
    try {
      const deleted = (await hooks.deleteItems(selections, options)) === true;
      if (deleted && ui.filterKey === filterKey) ui.selected.clear();
      return deleted;
    } catch (error) { hooks.toast?.(`未能移入回收站：${error?.message || '请重试'}`); return false; }
    finally {
      ui.busy = false; rerender(container);
      if (ui.filterKey === filterKey && (!container.getClientRects || container.getClientRects().length)) {
        const row = singleKey ? [...(container.querySelectorAll?.('[data-cui-key]') || [])].find(node => node.dataset.cuiKey === singleKey) : null;
        const target = row?.querySelector('[data-cui-delete]') || container.querySelector('[data-cui-delete-selected]') || container.querySelector('[data-cui-search]');
        target?.focus?.({ preventScroll: true });
      }
    }
  }
  async function changeCompletion(container, done) {
    const ui = stateFor(container); if (ui.busy) return false;
    const chosen = selectedRecords(ui).filter(item => item._type === 'task' && (item.status === 'done') !== done);
    if (!chosen.length) return false;
    const keys = new Set(chosen.map(itemKey)), filterKey = ui.filterKey;
    const changes = list(getState().tasks).filter(task => keys.has(itemKey({ ...task, _type: 'task' }))).map(task => ({ task, previous: { status: task.status, updatedAt: task.updatedAt, completedAt: task.completedAt } }));
    const count = setSelectedCompletion(keys, ui.options, done);
    changes.forEach(change => { change.after = { status: change.task.status, updatedAt: change.task.updatedAt, completedAt: change.task.completedAt }; });
    ui.busy = true; rerender(container);
    try {
      if ((await hooks.save?.()) === false) throw new Error('保存没有成功');
      if (ui.filterKey === filterKey) ui.selected.clear();
      hooks.renderAll?.(); hooks.toast?.(done ? `已完成 ${count} 个任务` : `已将 ${count} 个任务标为未完成`); return true;
    } catch (error) {
      for (const change of changes) {
        const matches = list(getState().tasks).filter(task => task.id === change.task.id), latest = matches[0];
        if (matches.length !== 1 || latest !== change.task || !Object.keys(change.after).every(key => latest[key] === change.after[key])) continue;
        for (const [key, value] of Object.entries(change.previous)) { if (value === undefined) delete latest[key]; else latest[key] = value; }
      }
      hooks.toast?.(`任务状态未保存：${error?.message || '请重试'}`); return false;
    } finally { ui.busy = false; rerender(container); }
  }
  async function analyzeSelected(container) {
    const ui = stateFor(container); if (ui.busy) return false;
    const chosen = selectedRecords(ui).filter(item => item._type === 'import');
    if (!chosen.length) { hooks.toast?.('所选资料已变化，请重新选择。'); rerender(container); return false; }
    if (typeof hooks.analyzeImports !== 'function') { hooks.toast?.('分析入口暂不可用，请重新打开应用。'); return false; }
    const filterKey = ui.filterKey, keys = chosen.map(itemKey);
    const ids = chosen.map(item => item.id), options = { workspace: ui.options.workspace, projectId: ui.options.projectId };
    ui.busy = true; rerender(container);
    try {
      // The host only stages this exact set of originals in a conversation.
      // Selecting this action never calls the model or claims analysis exists.
      const prepared = (await hooks.analyzeImports(ids, options)) === true;
      if (prepared && ui.filterKey === filterKey) keys.forEach(key => ui.selected.delete(key));
      return prepared;
    } catch (error) { hooks.toast?.(`未能准备分析对话：${error?.message || '请重试'}`); return false; }
    finally { ui.busy = false; rerender(container); }
  }
  async function compareSelected(container) {
    const ui = stateFor(container); if (ui.busy || typeof hooks.compareSources !== 'function') return false;
    const chosen = selectedRecords(ui);
    if (chosen.length < 2 || chosen.length > 4 || chosen.some(item => !['note', 'import', 'paper'].includes(item._type))) return false;
    const refs = chosen.map(item => ({ kind: item._type, id: item.id }));
    ui.busy = true; rerender(container);
    try { return (await hooks.compareSources(refs, { projectId: ui.options.projectId })) === true; }
    catch (error) { hooks.toast?.(error.message || '比较未能打开。'); return false; }
    finally { ui.busy = false; rerender(container); }
  }
  function openRecord(record, options) {
    const opener = { task: hooks.openTask, note: hooks.openNote, import: hooks.openImport, paper: hooks.openPaper }[record._type];
    return opener?.(record.id, options);
  }
  function rerender(container, preserveSearch = false) {
    const input = preserveSearch ? container.querySelector('[data-cui-search]') : null;
    const start = input?.selectionStart; const end = input?.selectionEnd;
    render(container, stateFor(container).options);
    if (input) {
      const replacement = container.querySelector('[data-cui-search]');
      replacement?.focus({ preventScroll: true });
      if (Number.isInteger(start)) replacement?.setSelectionRange(start, end);
    }
  }
  function bind(container) {
    if (container.dataset.cuiBound) return;
    container.dataset.cuiBound = '1';
    container.addEventListener('toggle', event => {
      const folder = event.target;
      if (!folder.matches?.('[data-cui-folder]') || !container.contains?.(folder)) return;
      const ui = stateFor(container); if (ui.query.trim()) return;
      folder.open ? ui.collapsed.delete(folder.dataset.cuiFolder) : ui.collapsed.add(folder.dataset.cuiFolder);
    }, true);
    container.addEventListener('compositionstart', event => { if (event.target.closest?.('[data-halaska-root]')?.dataset?.halaskaRoot) return; if (event.target === container.querySelector('[data-cui-search]') && canChangePreferences(stateFor(container))) stateFor(container).composing = true; });
    container.addEventListener('compositionend', event => {
      if (event.target.closest?.('[data-halaska-root]')?.dataset?.halaskaRoot) return;
      if (event.target !== container.querySelector('[data-cui-search]')) return;
      const ui = stateFor(container); if (!canChangePreferences(ui)) return;
      ui.composing = false; ui.query = event.target.value; rememberPreferences(ui); rerender(container, true);
    });
    container.addEventListener('input', event => {
      if (event.target.closest?.('[data-halaska-root]')?.dataset?.halaskaRoot) return;
      if (event.target !== container.querySelector('[data-cui-search]')) return;
      const ui = stateFor(container); if (!canChangePreferences(ui)) return; ui.query = event.target.value;
      if (event.isComposing) ui.composing = true;
      if (!ui.composing && !event.isComposing) { rememberPreferences(ui); rerender(container, true); }
    });
    container.addEventListener('change', event => {
      if (event.target.closest?.('[data-halaska-root]')?.dataset?.halaskaRoot) return;
      const ui = stateFor(container);
      if (ui.busy) return;
      if (event.target.matches('[data-cui-type]')) { if (!canChangePreferences(ui)) return; ui.type = event.target.value; rememberPreferences(ui); }
      else if (event.target.matches('[data-cui-check]')) {
        const row = event.target.closest('[data-cui-key]'); if (!row) return;
        event.target.checked ? ui.selected.add(row.dataset.cuiKey) : ui.selected.delete(row.dataset.cuiKey);
      } else if (event.target.matches('[data-cui-all]')) {
        displayItems(filteredItems(records(ui.options), ui), ui).forEach(item => event.target.checked ? ui.selected.add(itemKey(item)) : ui.selected.delete(itemKey(item)));
      } else return;
      rerender(container);
    });
    container.addEventListener('click', async event => {
      if (event.target.closest?.('[data-halaska-root]')?.dataset?.halaskaRoot) return;
      const ui = stateFor(container); const button = event.target.closest('[data-cui-open]');
      if (event.target.closest('[data-cui-delete]')) {
        const row = event.target.closest('[data-cui-key]');
        if (row) return deleteRecords(container, row.dataset.cuiKey); return;
      }
      if (event.target.closest('[data-cui-delete-selected]')) return deleteRecords(container);
      if (ui.busy) return;
      if (button && !event.target.closest('[data-cui-check]')) {
        const row = button.closest('[data-cui-key]'); const item = records(ui.options).find(record => itemKey(record) === row?.dataset.cuiKey);
        if (item) return openRecord(item, { anchor: button }); return;
      }
      const projectButton = event.target.closest('[data-cui-project]');
      if (projectButton) {
        const row = projectButton.closest('[data-cui-key]');
        const item = records(ui.options).find(record => itemKey(record) === row?.dataset.cuiKey);
        const projects = list(getState().projects).filter(project => project.id === item?.projectId);
        if (item && projects.length === 1 && item.projectId === projectButton.dataset.cuiProject) hooks.openProject?.(item.projectId);
        return;
      }
      if (event.target.closest('[data-cui-sort]')) {
        if (!canChangePreferences(ui)) return;
        const sequence = [['updated', 'desc'], ['updated', 'asc'], ['name', 'asc'], ['name', 'desc'], ['type', 'asc']];
        const index = sequence.findIndex(([key, direction]) => key === ui.sort && direction === ui.dir);
        [ui.sort, ui.dir] = sequence[(index + 1) % sequence.length]; rememberPreferences(ui);
      } else if (event.target.closest('[data-cui-view]')) { if (!canChangePreferences(ui)) return; ui.view = event.target.closest('[data-cui-view]').dataset.cuiView; rememberPreferences(ui); }
      else if (event.target.closest('[data-cui-clear]')) ui.selected.clear();
      else if (event.target.closest('[data-cui-complete]')) return changeCompletion(container, true);
      else if (event.target.closest('[data-cui-reopen]')) return changeCompletion(container, false);
      else if (event.target.closest('[data-cui-merge]')) return mergeSelected(container);
      else if (event.target.closest('[data-cui-analyze-selected]')) return analyzeSelected(container);
      else if (event.target.closest('[data-cui-compare]')) return compareSelected(container);
      else return;
      rerender(container);
    });
  }
  function render(container, options = {}) {
    if (!container) return;
    const focused=container.ownerDocument?.activeElement;
    const focusSelection=focused?.matches?.('[data-cui-all]')?{all:true}:focused?.matches?.('[data-cui-check]')?{key:focused.closest('[data-cui-key]')?.dataset.cuiKey}:null;
    const ui = stateFor(container); const scope = `${options.workspace || ''}:${options.projectId || ''}:${(options.types||[]).join(',')}:${options.libraryScope||'all'}`;
    const state = getState(), owner = preferenceOwner(options, state);
    let resetToolbar = ui.scope !== scope || options.projectId && !sameOwner(ui.preferenceOwner, owner) && (ui.preferenceOwner || owner);
    if (resetToolbar) {
      flushPreferences();
      ui.query = ''; ui.confirmedQuery = ''; ui.type = 'all'; ui.selected.clear(); ui.composing = false; ui.collapsed.clear(); ui.view = options.defaultView || 'list';
      if (options.projectId) Object.assign(ui, preferences(owner ? savedPreferences(state, options.projectId) : undefined, options));
    }
    ui.preferenceOwner = owner;
    ui.scope = scope; ui.options = { ...options };
    container.dataset.cuiScope=options.projectId?'project':'workspace';
    const allItems = records(ui.options), allowedKeys = new Set(allItems.map(itemKey));
    // Preserve composition on routine saves; access revocation must remove
    // stale rows immediately, even while the search input is composing.
    if (ui.composing && [...(ui.renderedKeys || [])].every(key => allowedKeys.has(key))) return;
    if (ui.composing) { ui.query = ui.confirmedQuery || ''; resetToolbar = true; }
    ui.composing = false;
    ui.confirmedQuery = ui.query;
    ui.renderEpoch = (ui.renderEpoch || 0) + 1;
    ui.filterKey = `${scope}\u0000${ui.type}\u0000${ui.query.trim()}\u0000${JSON.stringify(options.folderPath??null)}`;
    const items = displayItems(filteredItems(allItems, ui), ui);
    ui.renderedKeys = new Set(items.map(itemKey));
    const keys = new Set(items.map(itemKey)); ui.selected = new Set([...ui.selected].filter(key => keys.has(key)));
    const selected = ui.selected; const allChecked = items.length > 0 && items.every(item => selected.has(itemKey(item)));
    const disabled = ui.busy ? 'disabled' : '';
    const doneCount = items.filter(item => item._type === 'task' && item.status === 'done' && selected.has(itemKey(item))).length;
    const pendingCount = items.filter(item => item._type === 'task' && item.status !== 'done' && selected.has(itemKey(item))).length;
    const noteCount = items.filter(item => item._type === 'note' && selected.has(itemKey(item))).length;
    const importCount = items.filter(item => item._type === 'import' && selected.has(itemKey(item))).length;
    const compareCount = items.filter(item => ['note', 'import', 'paper'].includes(item._type) && selected.has(itemKey(item))).length;
    const toolbar = `<div class="collection-toolbar"><label class="collection-search"><span aria-hidden="true">⌕</span><input data-cui-search ${disabled} value="${esc(ui.query)}" aria-label="搜索工作区内容" placeholder="搜索名称、标签和状态"/></label><select data-cui-type ${disabled} aria-label="类型筛选">${[['all', '全部类型'], ...Object.entries(typeLabels).filter(([kind])=>!options.types||options.types.includes(kind)), ...(!options.types||options.types.includes('import')?[['pending-analysis', '待 AI 分析']]:[])].map(([type, label]) => `<option value="${type}" ${ui.type === type ? 'selected' : ''}>${label}</option>`).join('')}</select><button type="button" class="collection-sort" data-cui-sort ${disabled} aria-label="切换排序">${ui.sort === 'updated' ? '更新时间' : ui.sort === 'name' ? '名称' : '类型'} ${ui.dir === 'asc' ? '↑' : '↓'}</button><div class="collection-view-switch" role="group" aria-label="资料显示方式"><button type="button" class="collection-view-btn ${ui.view === 'tree' ? 'active' : ''}" data-cui-view="tree" ${disabled} aria-label="文件树视图" aria-pressed="${ui.view === 'tree'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3v12h3M4 7h3M9 5h7v4H9zM9 13h7v4H9z"/></svg></button><button type="button" class="collection-view-btn ${ui.view === 'list' ? 'active' : ''}" data-cui-view="list" ${disabled} aria-label="列表视图" aria-pressed="${ui.view === 'list'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h10M3 5h1M3 10h1M3 15h1"/></svg></button><button type="button" class="collection-view-btn ${ui.view === 'cards' ? 'active' : ''}" data-cui-view="cards" ${disabled} aria-label="卡片视图" aria-pressed="${ui.view === 'cards'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z"/></svg></button></div><span class="collection-count" role="status">${items.length} 项</span></div>`;
    const checkbox = item => `<label class="collection-check"><input type="checkbox" data-cui-check ${disabled} ${selected.has(itemKey(item)) ? 'checked' : ''} aria-label="选择 ${esc(item._title)}"/><span></span></label>`;
    const project = item => item.projectId ? `<button type="button" class="collection-project" data-cui-project="${esc(item.projectId)}">${esc(item._projectName)}</button>` : `<span class="collection-project">${esc(item._projectName)}</span>`;
    const deleteButton = item => `<button type="button" class="collection-delete" data-cui-delete ${ui.busy || typeof hooks.deleteItems !== 'function' ? 'disabled' : ''} title="移入回收站：${esc(item._title)}" aria-label="移入回收站：${esc(item._title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>`;
    const statusClass = item => item._type === 'note' && item.aiDraft || item._analysis?.status === 'pending' ? 'analysis-pending' : item._analysis?.status === 'analyzed' || item.status === 'done' || item.reviewed ? 'done' : '';
    const row = item => `<div class="collection-row ${selected.has(itemKey(item)) ? 'selected' : ''}" data-cui-key="${esc(itemKey(item))}" data-cui-id="${esc(item.id)}" data-cui-kind="${item._type}">${checkbox(item)}<button type="button" class="collection-main" data-cui-open>${svg(item._type)}<span class="collection-title"><b>${esc(item._title)}</b><small>${esc(item.folderPath || typeLabels[item._type])}</small></span></button>${project(item)}<span class="collection-status ${statusClass(item)}" title="${esc(item._analysis?.detail || '')}">${esc(item._meta)}</span><time ${item._updated ? `datetime="${new Date(item._updated).toISOString()}"` : ''}>${item._updated ? new Date(item._updated).toLocaleDateString('zh-CN') : '—'}</time>${deleteButton(item)}</div>`;
    const card = item => `<article class="collection-card ${selected.has(itemKey(item)) ? 'selected' : ''}" data-cui-key="${esc(itemKey(item))}" data-cui-id="${esc(item.id)}" data-cui-kind="${item._type}">${checkbox(item)}<button type="button" class="collection-main" data-cui-open>${svg(item._type)}<span class="collection-title"><b>${esc(item._title)}</b><small class="collection-status ${statusClass(item)}" title="${esc(item._analysis?.detail || '')}">${esc(item._meta)}</small></span></button>${project(item)}${deleteButton(item)}</article>`;
    const empty = `<div class="collection-empty"><div class="collection-empty-icon">${svg('import')}</div><b>${ui.query.trim() || ui.type !== 'all' ? '没有匹配内容' : '暂无内容'}</b><p>${ui.query.trim() || ui.type !== 'all' ? '调整搜索或筛选条件后再试。' : '添加文件或用 AI 整理后，资料与成果会显示在这里。'}</p></div>`;
    const treeLeaf = item => `<div class="collection-tree-leaf ${selected.has(itemKey(item)) ? 'selected' : ''}" data-cui-key="${esc(itemKey(item))}" data-cui-id="${esc(item.id)}" data-cui-kind="${item._type}">${checkbox(item)}<button type="button" class="collection-main" data-cui-open>${svg(item._type)}<span class="collection-title"><b>${esc(item._title)}${item._type === 'note' && !/\.md$/i.test(item._title) ? '.md' : ''}</b></span></button><small class="collection-status ${statusClass(item)}">${esc(item._meta + (item._type === 'note' && item.userEdited && !item.aiDraft ? ' · 已修订' : ''))}</small>${deleteButton(item)}</div>`;
    function treeHTML(node, path = []) {
      return [...node.children.entries()].sort(([a], [b]) => collator.compare(a,b)).map(([name, child]) => {
        const key = JSON.stringify([...path, name]);
        return `<details class="collection-folder" data-cui-folder="${esc(key)}" ${ui.query.trim() || !ui.collapsed.has(key) ? 'open' : ''}><summary><span class="collection-folder-icon" aria-hidden="true">▱</span><b>${esc(name)}</b><small>${child.count}</small></summary><div class="collection-branch">${treeHTML(child, [...path, name])}</div></details>`;
      }).join('') + node.items.map(treeLeaf).join('');
    }
    const body = items.length ? ui.view === 'tree' ? `<div class="collection-tree"><label class="collection-tree-select"><input type="checkbox" data-cui-all ${disabled} ${allChecked ? 'checked' : ''} aria-label="选择全部可见项"/>选择全部文件 · ${items.length} 项</label>${treeHTML(treeGroups(items, options))}</div>` : ui.view === 'cards' ? `<div class="collection-cards">${items.map(card).join('')}</div>` : `<div class="collection-table"><div class="collection-head"><label><input type="checkbox" data-cui-all ${disabled} ${allChecked ? 'checked' : ''} aria-label="选择全部可见项"/></label><span>名称</span><span>归属项目</span><span>状态</span><span>更新时间</span><span class="collection-actions-label">操作</span></div>${items.map(row).join('')}</div>` : empty;
    const batch = selected.size ? `<div class="collection-batch"><span>已选择 ${selected.size} 项</span>${compareCount === selected.size && compareCount >= 2 && compareCount <= 4 ? `<button type="button" data-cui-compare ${ui.busy || typeof hooks.compareSources !== 'function' ? 'disabled' : ''}>并排比较</button>` : ''}${noteCount > 1 && noteCount === selected.size ? `<button type="button" data-cui-merge ${ui.busy || !hooks.mergeNotes ? 'disabled' : ''}>合并为一篇笔记</button>` : ''}${pendingCount ? `<button type="button" data-cui-complete ${disabled}>标为完成 · ${pendingCount}</button>` : ''}${doneCount ? `<button type="button" data-cui-reopen ${disabled}>标为未完成 · ${doneCount}</button>` : ''}${importCount ? `<button type="button" class="collection-batch-analyze" data-cui-analyze-selected ${ui.busy || typeof hooks.analyzeImports !== 'function' ? 'disabled' : ''}>交给 AI 分析 · ${importCount} 份</button>` : ''}<button type="button" class="collection-batch-delete" data-cui-delete-selected ${ui.busy || typeof hooks.deleteItems !== 'function' ? 'disabled' : ''}>移入回收站</button><button type="button" data-cui-clear ${disabled}>清除选择</button>${importCount ? '<small class="collection-analysis-hint">准备对话与附件，发送指令后才开始分析。</small>' : ''}${ui.busy ? '<small role="status">正在处理，请稍候…</small>' : ''}</div>` : '';
    const kit = globalThis.HalaskaUI;
    if (kit && container.ownerDocument) {
      // KitSearchInput owns its IME draft and native listeners. Reusing that
      // input across owners would let a late A composition commit through B's
      // new listener. Routine renders keep the root; scope changes dispose it.
      if (resetToolbar && ui.kitHosts?.toolbar) { kit.unmount(ui.kitHosts.toolbar); kit.unmount(ui.kitHosts.body); }
      if (!ui.kitHosts?.toolbar.isConnected) {
        const create = name => {const node=container.ownerDocument.createElement('div');node.className=name;return node;};
        ui.kitHosts={toolbar:create('kit-library-toolbar-host'),batch:create('kit-library-batch-host'),body:create('kit-library-body')};
        container.replaceChildren(ui.kitHosts.toolbar,ui.kitHosts.batch,ui.kitHosts.body);
      }
      const hosts=ui.kitHosts;
      const focusSearch=()=>container.querySelector('[data-cui-search]')?.focus();
      const epoch=ui.renderEpoch, canChange=()=>epoch===ui.renderEpoch && canChangePreferences(ui);
      const reset=()=>{if(!canChange())return;ui.query='';ui.type='all';rememberPreferences(ui);rerender(container);focusSearch();};
      kit.mount(hosts.toolbar,'LibraryToolbar',{
        query:ui.query,type:ui.type,view:ui.view,count:items.length,busy:ui.busy,
        pendingCount:allItems.filter(item=>item._type==='import'&&item._analysis?.status==='pending').length,
        onPending:()=>{if(!canChange())return;ui.query='';ui.type='pending-analysis';rememberPreferences(ui);rerender(container);focusSearch();},
        types:[{value:'all',label:'全部类型'},...Object.entries(typeLabels).filter(([kind])=>!options.types||options.types.includes(kind)).map(([value,label])=>({value,label})),...(!options.types||options.types.includes('import')?[{value:'pending-analysis',label:'待 AI 分析'}]:[])],
        sortLabel:`${ui.sort==='updated'?'更新时间':ui.sort==='name'?'名称':'类型'} ${ui.dir==='asc'?'↑':'↓'}`,
        onQuery:value=>{if(!canChange())return;ui.query=typeof value==='string'?value:'';if(!ui.composing){rememberPreferences(ui);rerender(container);}},
        onCompositionStart:()=>{if(canChange())ui.composing=true;},onCompositionEnd:event=>{if(!canChange())return;ui.composing=false;ui.query=event.target.value;rememberPreferences(ui);rerender(container);},
        onType:value=>{if(!canChange())return;ui.type=value;rememberPreferences(ui);rerender(container);},
        onSort:()=>{if(!canChange())return;const sequence=[['updated','desc'],['updated','asc'],['name','asc'],['name','desc'],['type','asc']];const index=sequence.findIndex(([key,direction])=>key===ui.sort&&direction===ui.dir);[ui.sort,ui.dir]=sequence[(index+1)%sequence.length];rememberPreferences(ui);rerender(container);},
        onView:value=>{if(!canChange())return;ui.view=value;rememberPreferences(ui);rerender(container);},
      });
      kit.mount(hosts.batch,'LibrarySelection',{
        count:selected.size,pending:pendingCount,done:doneCount,notes:noteCount,imports:importCount,comparable:compareCount,busy:ui.busy,
        canMerge:!!hooks.mergeNotes,canDelete:typeof hooks.deleteItems==='function',canAnalyze:typeof hooks.analyzeImports==='function',canCompare:typeof hooks.compareSources==='function',onCompare:()=>compareSelected(container),
        onMerge:()=>mergeSelected(container),onComplete:()=>changeCompletion(container,true),onReopen:()=>changeCompletion(container,false),onAnalyze:()=>analyzeSelected(container),
        onDelete:()=>deleteRecords(container),onClear:()=>{ui.selected.clear();rerender(container);focusSearch();},
      });
      if (items.length && ui.view === 'list') {
        if (!hosts.body.dataset.halaskaRoot) hosts.body.replaceChildren();
        hosts.body.classList.remove('kit-library-empty');
        const currentItems = () => canChange() ? displayItems(filteredItems(records(ui.options), ui), ui) : [];
        const currentItem = key => currentItems().find(item => itemKey(item) === key);
        kit.mount(hosts.body, 'LibraryDataTable', {
          rows: items.map(item => ({ key: itemKey(item), id: item.id, kind: item._type, title: item._title,
            folder: item.folderPath || typeLabels[item._type], status: item._meta, statusTone: statusClass(item),
            statusDetail: item._analysis?.detail || '', updated: item._updated, projectId: item.projectId || '', projectName: item._projectName })),
          selectedKeys: [...selected], sort: { key: ui.sort, dir: ui.dir }, projectScoped: !!options.projectId,
          busy: ui.busy, canDelete: typeof hooks.deleteItems === 'function',
          onToggle: (key, checked) => { if (!currentItem(key)) return; checked ? ui.selected.add(key) : ui.selected.delete(key); rerender(container); },
          onToggleAll: checked => { if (!canChange()) return; for (const item of currentItems()) { const key = itemKey(item); checked ? ui.selected.add(key) : ui.selected.delete(key); } rerender(container); },
          onSort: key => { if (!canChange() || !['name', 'updated'].includes(key)) return; ui.dir = ui.sort === key ? ui.dir === 'asc' ? 'desc' : 'asc' : key === 'updated' ? 'desc' : 'asc'; ui.sort = key; rememberPreferences(ui); rerender(container); },
          onOpen: (key, anchor) => { const item = currentItem(key); if (item && anchor?.isConnected && anchor.closest?.('[data-cui-key]')?.dataset.cuiKey === key) return openRecord(item, { anchor }); },
          onDelete: key => { if (currentItem(key)) return deleteRecords(container, key); },
          onProject: key => { const item = currentItem(key), projects = list(getState().projects).filter(project => project.id === item?.projectId); if (item && projects.length === 1 && visible(projects[0])) hooks.openProject?.(item.projectId); },
        });
      } else if (items.length) {kit.unmount(hosts.body);hosts.body.classList.remove('kit-library-empty');hosts.body.innerHTML=body;}
      else {if(!hosts.body.dataset.halaskaRoot)hosts.body.replaceChildren();hosts.body.classList.add('kit-library-empty');kit.mount(hosts.body,'LibraryEmpty',{recordScope:options.libraryScope==='records',onOverview:typeof options.onOverview==='function'?()=>{if(canChange())options.onOverview();}:undefined,filtered:!!ui.query.trim()||ui.type!=='all',onReset:reset,onAdd:typeof options.onAdd==='function'?()=>{if(canChange())options.onAdd();}:undefined});}
    } else container.innerHTML = toolbar + batch + body;
    const selectAll = container.querySelector('[data-cui-all]'); if (selectAll) selectAll.indeterminate = selected.size > 0 && !allChecked;
    bind(container);
    if(focusSelection && !focused.isConnected){
      const replacement=focusSelection.all?container.querySelector('[data-cui-all]'):[...container.querySelectorAll('[data-cui-key]')].find(row=>row.dataset.cuiKey===focusSelection.key)?.querySelector('[data-cui-check]');
      replacement?.focus({preventScroll:true});
    }
  }
  function init(input = {}) { if (pendingPreferences.size) flushPreferences(); hooks = { ...hooks, ...input }; return { render }; }
  return { init, render, _private: { records, visible, filteredItems, completeSelected, setSelectedCompletion, deleteRecords, analyzeSelected, compareSelected, mergeSelected, displayItems, treeGroups, itemKey, timestamp } };
}));
