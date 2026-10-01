/* A stable, scope-aware file navigator. The reader and its editors keep ownership
   of their DOM; this controller only updates the inspector's React island. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DocumentFileTree = api;
})(globalThis, function (root) {
  'use strict';
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  const active = item => item && !item.deletedAt && !item.deleted && !item.archivedAt && !item.archived;
  const visible = item => active(item) && !item.private && !item.ephemeral && !item.incognito;
  const keyFor = (kind, id) => JSON.stringify([kind, id]);
  const folderKey = (group, path) => keyFor('folder', [group, path]);
  function hierarchy(groups) {
    return (groups || []).filter(group => group.items?.length).map(group => {
      const groupNode = { key: folderKey(group.id, ''), name: group.label, folder: true, group: true, count: group.items.length, children: [] };
      const folders = new Map([['', groupNode]]);
      for (const item of group.items) {
        // An unavailable item may have a deliberately redacted name/path.
        const parts = String(item.path || item.name || item.title || '').split('/').filter(Boolean);
        let parent = groupNode, path = '';
        for (const part of parts.slice(0, -1)) {
          path = path ? path + '/' + part : part;
          if (!folders.has(path)) {
            const node = { key: folderKey(group.id, path), name: part, path, folder: true, children: [] };
            folders.set(path, node); parent.children.push(node);
          }
          parent = folders.get(path);
        }
        parent.children.push({ ...item, name: item.name || item.title || parts.at(-1), key: item.key || keyFor(item.kind, item.id) });
      }
      const sort = node => { node.children.sort((a, b) => Number(!!b.folder) - Number(!!a.folder) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })); node.children.filter(child => child.folder).forEach(sort); };
      sort(groupNode); return groupNode;
    });
  }
  function resolveScope(state, conversation, view = 'agent', reading = false) {
    if (view === 'agent' && active(conversation)) {
      if (!visible(conversation)) return null;
      const project = (state.projects || []).find(item => item.id === conversation.projectId && visible(item));
      return { conversationId: conversation.id, projectId: project?.id || null, name: project?.name || conversation.title || t('独立对话', 'Independent conversation'), key: 'conversation:' + conversation.id };
    }
    const selected = reading && state.previewRecord;
    let record = selected?.type === 'note' ? state.notes?.find(item => item.id === selected.id) : selected?.type === 'import' ? state.imports?.find(item => item.id === selected.id) : null;
    if (selected?.type === 'local-file') {
      try { const [projectId, candidateId] = JSON.parse(selected.id); record = state.projects?.find(item => active(item) && item.id === projectId && item.localFolder?.id === candidateId); if (record) record = { projectId: record.id }; } catch (_) { /* stale local target */ }
    }
    if (selected && ['review', 'local-review'].includes(selected.type)) record = state.agentRuns?.find(item => item.id === selected.id && active(item));
    const projectId = selected ? record?.projectId : view === 'project' ? state.currentProjectId : null;
    const project = state.projects?.find(item => item.id === projectId && visible(item));
    if (project) return { conversationId: null, projectId: project.id, name: project.name, key: 'project:' + project.id };
    if (record && visible(record) && (!record.projectId || project)) return { conversationId: null, projectId: null, name: t('资料库', 'Library'), key: 'library' };
    return null;
  }
  function create(options) {
    const getState = options.state, getScope = options.scope;
    const prefs = new Map();
    let current = null, island = null, lastPropsKey = '', disposed = false;
    const preference = scope => {
      let value = prefs.get(scope.key);
      if (!value) { value = { mode: scope.conversationId ? 'conversation' : 'all', query: '', open: new Map(), local: new Map(), scrollTop: 0, focusedKey: null, generation: 0 }; prefs.set(scope.key, value); }
      return value;
    };
    const catalog = (scope, pref) => (options.catalog || root.DocumentFiles || root.DocumentFileCatalog)?.build({ state: getState(), conversationId: scope.conversationId, projectId: scope.projectId, scope: pref.mode, query: pref.query }) || { groups: [], items: [], localRoots: [] };
    const isValidRoot = local => {
      if (!(getState().projects || []).some(project => active(project) && project.id === local.projectId && project.localFolder?.id === local.candidateId)) return false;
      const api = options.catalog || root.DocumentFiles || root.DocumentFileCatalog;
      return !!api?.build({ state: getState(), projectId: local.projectId, scope: 'all' }).localRoots?.some(entry => entry.projectId === local.projectId && entry.candidateId === local.candidateId);
    };
    const localKey = (local, path) => keyFor('local-directory', [local.projectId, local.candidateId, path]);
    function localNodes(local, path, pref) {
      const key = localKey(local, path), cache = pref.local.get(key), children = [];
      for (const entry of cache?.entries || []) {
        if (entry.type === 'directory') children.push(localNode(local, entry.path, entry.name, pref));
        else if (!pref.query || String(entry.path).toLocaleLowerCase().includes(pref.query.trim().toLocaleLowerCase())) {
          const id = JSON.stringify([local.projectId, local.candidateId, entry.path]);
          children.push({ key: keyFor('local-file', id), kind: 'local-file', id, name: entry.name, path: entry.path, available: entry.supported !== false,
            disabled: entry.supported === false, reason: entry.supported === false ? t('此格式请通过附件导入后查看', 'Import this format as an attachment to view it') : '', open: { kind: 'local-file', id }, status: 'available', localDirectory: true });
        }
      }
      return children;
    }
    function localNode(local, path, name, pref) {
      const key = localKey(local, path), cache = pref.local.get(key);
      return { key, name, path, folder: true, local: { ...local, path }, children: localNodes(local, path, pref), loading: cache?.loading, error: cache?.error,
        loaded: !!cache?.loaded, nextOffset: cache?.nextOffset, defaultOpen: false };
    }
    const expanded = (node, pref) => pref.query && !node.local ? true : pref.open.get(node.key) ?? node.defaultOpen !== false;
    function nodesFor(scope, pref, data) {
      let groups = data.groups;
      if (pref.mode === 'all' && !scope.projectId) {
        const owners = new Map();
        for (const item of data.items || []) {
          const key = item.projectId || 'unassigned';
          if (!owners.has(key)) owners.set(key, { id: 'project:' + key, label: item.projectName || t('独立资料', 'Independent files'), items: [] });
          owners.get(key).items.push(item);
        }
        groups = [...owners.values()];
      }
      const nodes = hierarchy(groups);
      for (const local of data.localRoots || []) {
        if (!isValidRoot(local)) continue;
        const name = local.name || local.label || t('本机目录', 'Local folder');
        const node = localNode(local, '', !scope.projectId && local.projectName ? local.projectName + ' / ' + name : name, pref);
        nodes.push(node);
      }
      const decorate = node => { if (node.folder) { node.expanded = expanded(node, pref); node.children.forEach(decorate); } };
      nodes.forEach(decorate); return nodes;
    }
    function render(force = false) {
      if (disposed) return;
      const scope = getScope(); current = scope;
      if (!scope) {
        lastPropsKey = '';
        island?.update({ scopeKey: 'unavailable', scopeName: t('没有可用文件范围', 'No available file scope'), mode: 'all', query: '', nodes: [], selectedKey: '', openedKeys: [], focusedKey: null,
          conversationAvailable: false, localSearch: false, canAdd: false, onOpen: undefined, onReview: undefined, onToggle: undefined, onMode: undefined, onQuery: undefined, onRefresh: undefined, onAdd: undefined, onLoadMore: undefined, onRetry: undefined });
        return;
      }
      const pref = preference(scope); if (!scope.conversationId) pref.mode = 'all';
      const data = catalog(scope, pref), nodes = nodesFor(scope, pref, data), state = getState();
      const opened = (root.ReadingPane?.snapshot?.()?.tabs || []).map(tab => keyFor(tab.kind, tab.id));
      const selected = state.previewRecord ? keyFor(state.previewRecord.type, state.previewRecord.id) : '';
      const props = { scopeKey: scope.key + ':' + pref.mode, scopeName: pref.mode === 'all' && !scope.projectId ? t('所有项目与独立资料', 'All projects and independent files') : scope.name, conversationAvailable: !!scope.conversationId,
        mode: pref.mode, query: pref.query, nodes, selectedKey: selected, openedKeys: opened, focusedKey: pref.focusedKey, scrollTop: pref.scrollTop,
        localSearch: !!pref.query && !!data.localRoots?.length, canAdd: typeof options.add === 'function',
        onMode: mode => { if (mode === 'conversation' && !scope.conversationId) return; pref.mode = mode; pref.scrollTop = 0; pref.focusedKey = null; render(); },
        onQuery: value => { pref.query = value; pref.scrollTop = 0; render(); },
        onToggle: node => { pref.open.set(node.key, !expanded(node, pref)); render(); if (node.local && pref.open.get(node.key)) void loadLocal(scope, pref, node.local); },
        onOpen: item => open(item), onReview: (item, review) => open(item, review), onLoadMore: node => loadLocal(scope, pref, node.local, node.nextOffset),
        onRetry: node => loadLocal(scope, pref, node.local),
        onRefresh: () => refreshLocal(scope, pref), onAdd: () => options.add?.({ ...scope, mode: pref.mode }),
        onFocus: key => { pref.focusedKey = key; }, onScroll: top => { pref.scrollTop = top; }
      };
      // Only metadata reaches React. Streaming response text is intentionally
      // absent, so a token does not rerender or reset file focus/scroll.
      const key = JSON.stringify([scope.key, scope.name, pref.mode, pref.query, nodes, selected, opened, root.WorkstationI18n?.getLanguage?.()]);
      if (!force && lastPropsKey === key && island) return;
      lastPropsKey = key;
      if (island) island.update(props);
      else island = (options.mount || ((host, name, props) => root.HalaskaUI.mount(host, name, props)))(options.host, 'DocumentFiles', props);
      const resumeExpanded = node => {
        if (node.folder && node.expanded) {
          if (node.local && !node.loaded && !node.loading && !node.error) Promise.resolve().then(() => { if (current?.key === scope.key) void loadLocal(scope, pref, node.local); });
          node.children.forEach(resumeExpanded);
        }
      };
      nodes.forEach(resumeExpanded);
    }
    async function loadLocal(scope, pref, local, offset = 0) {
      const path = local.path || '', key = localKey(local, path), previous = pref.local.get(key);
      if (disposed || !isValidRoot(local) || previous?.loading || (!offset && previous?.loaded)) return;
      const generation = pref.generation, token = {};
      pref.local.set(key, { ...previous, loading: true, error: '', token }); render();
      try {
        const data = await (options.request || root.FileContext.request)('/__local/files', { candidateId: local.candidateId, path, offset });
        if (disposed || generation !== pref.generation || pref.local.get(key)?.token !== token || !isValidRoot(local)) return;
        const entries = [...(offset ? previous?.entries || [] : []), ...(data.entries || [])];
        const unique = [...new Map(entries.map(entry => [entry.path, entry])).values()];
        pref.local.set(key, { entries: unique, loaded: true, loading: false, nextOffset: data.nextOffset ?? null });
      } catch (error) {
        if (disposed || generation !== pref.generation || pref.local.get(key)?.token !== token) return;
        pref.local.set(key, { ...previous, loading: false, error: error.message || String(error) });
      }
      if (current?.key === scope.key) render();
    }
    function refreshLocal(scope, pref) {
      pref.generation++; pref.local.clear(); render(true);
      const data = catalog(scope, pref);
      for (const local of data.localRoots || []) {
        if (pref.open.get(localKey(local, ''))) void loadLocal(scope, pref, { ...local, path: '' });
      }
    }
    async function open(item, requestedReview) {
      const scope = getScope(); if (!scope || !current || scope.key !== current.key) return false;
      const pref = preference(scope), mode = pref.mode;
      const lookup = () => {
        const latestScope = getScope();
        if (disposed || !latestScope || latestScope.key !== scope.key || latestScope.projectId !== scope.projectId
            || latestScope.conversationId !== scope.conversationId || preference(latestScope).mode !== mode) return null;
        // Filtering changes presentation, not permission. Rebuild the complete
        // captured scope so all originating runs/messages are checked again.
        let found = catalog(latestScope, { ...pref, mode, query: '' }).items?.find(entry => entry.key === item.key);
        if (!found && mode === 'all' && item.kind === 'local-file' && item.localDirectory) {
          try { const [projectId, candidateId, path] = JSON.parse(item.id); if (isValidRoot({ projectId, candidateId }) && path) found = item; } catch (_) { /* invalid target */ }
        }
        return found && !found.disabled && found.available !== false && (found.open || found.review) ? found : null;
      };
      // Revalidate immediately; deleted/private records and changed proposals
      // must never be opened from a captured row callback.
      const live = lookup();
      if (!live) { options.toast?.(t('此文件当前不可用，请刷新文件列表。', 'This file is unavailable. Refresh the file list.')); render(true); return false; }
      const review = requestedReview ? (live.reviews || []).find(entry => entry.runId === requestedReview.runId && entry.editId === requestedReview.editId) : !live.open ? live.review : null;
      if (requestedReview && !review) { render(true); return false; }
      const target = review ? { kind: review.kind || (live.kind === 'local-file' ? 'local-review' : 'review'), id: review.runId, page: review.editId } : live.open;
      if (!target) return false;
      const canOpen = () => {
        const latest = lookup();
        if (!latest) return false;
        if (review) return (latest.reviews || []).some(entry => entry.runId === review.runId && entry.editId === review.editId
          && (entry.kind || (latest.kind === 'local-file' ? 'local-review' : 'review')) === target.kind);
        return latest.open?.kind === target.kind && latest.open.id === target.id;
      };
      // A proposal may create a record which does not exist yet. Its run and
      // precise proposal are validated by canOpen and the review renderer.
      const sourceGuard = review ? undefined : { type: live.kind === 'local-file' ? 'local' : live.type || live.kind, provided: false };
      if (sourceGuard) {
        sourceGuard.documentScope = { scope: mode, conversationId: scope.conversationId || null, projectId: scope.projectId || null, localDirectory: !!live.localDirectory };
        if (live.kind === 'local-file') {
          const [projectId, candidateId, path] = JSON.parse(live.id);
          Object.assign(sourceGuard, { projectId, candidateId, path });
        } else sourceGuard.id = live.id;
        if (mode === 'conversation' && scope.conversationId) sourceGuard.conversationId = scope.conversationId;
        const originRuns = [...new Set((live.origins || []).map(origin => origin.runId).filter(Boolean))];
        if (originRuns.length === 1) sourceGuard.runId = originRuns[0];
      }
      try {
        const result = await options.open(target.kind, target.id, target.page, sourceGuard, canOpen);
        render(true);
        if (result === false) return false;
        const selected = getState().previewRecord;
        if (selected?.type === target.kind && selected.id === target.id) options.opened?.(live);
        return true;
      } catch (error) { options.toast?.(error.message || String(error)); return false; }
    }
    return { sync: render, refresh: () => { const scope = getScope(); if (scope) refreshLocal(scope, preference(scope)); },
      dispose: () => { disposed = true; prefs.forEach(pref => pref.generation++); island?.unmount(); island = null; },
      snapshot: () => ({ scope: current, preferences: prefs }) };
  }
  return { create, hierarchy, resolveScope, keyFor };
});
