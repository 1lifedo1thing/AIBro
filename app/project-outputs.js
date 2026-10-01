/* Project output index. Only durable references enter this surface: no body
 * copies, inference from an answer, provider calls or filesystem reads. */
(function (root, factory) {
  const api = factory(root, typeof module === 'object' && module.exports ? require('./document-files.js') : root.DocumentFiles);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectOutputs = api;
})(globalThis, (root, Catalog) => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const active = value => !!value && !value.deleted && !value.deletedAt && !value.archived && !value.archivedAt && !value.hidden && !value.hiddenAt && !value.tombstone && !value.wikiFileError && !['deleted', 'archived', 'hidden'].includes(value.status);
  const privateItem = value => !!(value?.private || value?.ephemeral || value?.incognito);
  const collections = { note: 'notes', import: 'imports', task: 'tasks', paper: 'papers', local: 'projects' };
  const pending = new Set(['pending', 'partial', 'interrupted', 'applying', 'undoing']);
  const ignored = new Set(['matched', 'deleted', 'removed', 'dismissed', 'undone']);
  const stamp = value => Number(value?.finishedAt || value?.updatedAt || value?.startedAt || value?.at || value?.createdAt) || 0;
  const keyOf = (type, id) => JSON.stringify([type, id]);
  const originIdentity = origin => JSON.stringify([origin.recordedConversationId || origin.conversationId || null,
    origin.recordedRunId || origin.runId || null, origin.recordedRunId || origin.runId ? null : origin.messageId || null]);
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;

  function build({ state = {}, projectId, query = '', filter = 'all' } = {}) {
    const indices = {}, retired = {};
    for (const name of [...new Set([...Object.values(collections), 'agentRuns', 'conversations'])]) {
      indices[name] = new Map(); retired[name] = new Map();
      for (const item of list(state[name])) if (item?.id) { const entries = indices[name].get(item.id) || []; entries.push(item); indices[name].set(item.id, entries); }
      for (const bundle of list(state.trash)) {
        // Conversation/project deletion stores runs under the legacy `runs`
        // key. They remain authoritative for privacy and identity checks.
        const values = [...list(bundle?.data?.[name]), ...(name === 'agentRuns' ? list(bundle?.data?.runs) : [])];
        for (const item of values) if (item?.id) { const entries = retired[name].get(item.id) || []; entries.push(item); retired[name].set(item.id, entries); }
      }
    }
    const current = (name, id) => indices[name]?.get(id)?.length === 1 ? indices[name].get(id)[0] : null;
    const matches = (name, id) => id ? [...(indices[name]?.get(id) || []), ...(retired[name]?.get(id) || [])] : [];
    const alive = (name, id) => active(current(name, id)) && !retired[name]?.has(id);
    function secret(...values) {
      const queue = values.filter(Boolean), seen = new Set();
      for (let i = 0; i < queue.length; i++) {
        const value = queue[i]; if (seen.has(value)) continue; seen.add(value);
        if (privateItem(value)) return true;
        for (const [name, ids] of [['projects', [value.projectId]], ['agentRuns', [value.agentRunId, value.runId]], ['conversations', [value.conversationId, value.sourceConversationId]]])
          for (const id of ids) queue.push(...matches(name, id));
        // Captured provenance survives rename/move; privacy must follow it too.
        if (value.provenance?.origin) queue.push(value.provenance.origin);
      }
      return false;
    }
    function ambiguousAncestry(...values) {
      const queue = values.filter(Boolean), seen = new Set();
      for (let i = 0; i < queue.length; i++) {
        const value = queue[i]; if (seen.has(value)) continue; seen.add(value);
        for (const [name, ids] of [['projects', [value.projectId]], ['agentRuns', [value.agentRunId, value.runId]], ['conversations', [value.conversationId, value.sourceConversationId]]]) {
          for (const id of ids) {
            const found = matches(name, id); if (found.length > 1) return true;
            queue.push(...found);
          }
        }
        if (value.provenance?.origin) queue.push(value.provenance.origin);
      }
      return false;
    }
    const validOwner = value => !value?.projectId || alive('projects', value.projectId) && !secret(...matches('projects', value.projectId));
    const visibleConversation = id => alive('conversations', id) && validOwner(current('conversations', id)) && !secret(...matches('conversations', id));
    const visibleRun = id => {
      const run = current('agentRuns', id);
      return alive('agentRuns', id) && visibleConversation(run?.conversationId) && validOwner(run) && !secret(...matches('agentRuns', id));
    };
    const project = current('projects', projectId);
    const empty = { available: false, projectId, projectName: '', items: [], counts: { all: 0, saved: 0, review: 0 }, noOutputRuns: [], completedWithoutOutput: 0, query: text(query), filter };
    if (!projectId || !alive('projects', projectId) || secret(...matches('projects', projectId))) return empty;
    const rows = new Map(), blocked = new Set(), relevantRuns = new Map();
    function identity(ref) {
      let type = ref?.type || (ref?.kind === 'local-file' ? 'local' : ref?.kind), id = text(ref?.id);
      if (!Object.hasOwn(collections, type)) return null;
      if (type === 'local') {
        if (!text(ref.projectId) || !text(ref.candidateId) || !Catalog.pathValid(ref.path)) return null;
        id = Catalog.localId(ref);
      } else if (type === 'note' && root.NoteConsolidation?.resolveId) id = root.NoteConsolidation.resolveId(state, id) || id;
      return id ? { type, id, identity: keyOf(type, id) } : null;
    }
    function recordFor(ref, target) {
      const id = target.type === 'local' ? ref.projectId : target.id, name = collections[target.type];
      if (!alive(name, id)) return null;
      const record = current(name, id);
      if (secret(ref, ...matches(name, id), record?.aiDraft)) { blocked.add(target.identity); return null; }
      if (!validOwner(record) || (target.type === 'local' ? record.id : record.projectId) !== projectId) return null;
      if (target.type === 'local' && record.localFolder?.id !== ref.candidateId) return null;
      return record;
    }
    function source(conversation, run, message, at) {
      return { conversationId: conversation.id, conversationTitle: text(conversation.title) || t('未命名对话', 'Untitled conversation'), runId: run?.id || null,
        recordedConversationId: conversation.id, recordedRunId: run?.id || null, conversationAvailable: true, runAvailable: !!run?.id,
        messageId: message?.id || null, at: Number(at) || stamp(run) || stamp(message) || 0 };
    }
    function retainedSource(origin) {
      const conversation = current('conversations', origin.conversationId), run = current('agentRuns', origin.runId);
      const conversationAvailable = visibleConversation(origin.conversationId);
      const runAvailable = visibleRun(origin.runId) && run.conversationId === origin.conversationId;
      return { recordedConversationId: origin.conversationId, recordedRunId: origin.runId,
        conversationId: conversationAvailable ? conversation.id : null, runId: runAvailable ? run.id : null,
        conversationTitle: conversationAvailable ? text(conversation.title) || t('未命名对话', 'Untitled conversation') : t('原对话不可用', 'Original conversation unavailable'),
        conversationAvailable, runAvailable, messageId: null, at: Number(origin.at) || 0 };
    }
    function insert(target, record, group, origin, { review = null, directory = false, operation = '', version = null, status = '' } = {}) {
      const kind = target.type === 'local' ? 'local-file' : target.type;
      const key = group === 'review' ? JSON.stringify(['review', kind, target.id, review?.runId || origin.runId, review?.editId || null]) : JSON.stringify(['saved', kind, target.id]);
      const previous = rows.get(key), origins = [...(previous?.origins || []), origin];
      const uniqueOrigins = [...new Map(origins.map(item => [originIdentity(item), item])).values()].sort((a, b) => b.at - a.at);
      const path = target.type === 'local' ? JSON.parse(target.id)[2] : '';
      const name = target.type === 'local' ? path.split('/').at(-1) : text(record.title) || text(record.name) || text(record.originalName) || t('未命名成果', 'Untitled output');
      rows.set(key, { key, identity: target.identity, type: target.type, kind, id: target.id, projectId, name, title: name, path,
        group, status: status || group, operation, directory, version, origins: uniqueOrigins,
        at: Math.max(previous?.at || 0, origin.at), updatedAt: stamp(record),
        open: !directory && (group === 'saved' || !review) ? { kind, id: target.id } : null,
        review, source: uniqueOrigins[0], available: true });
    }
    function result(ref, conversation, run, message) {
      const target = identity(ref); if (!target) return;
      if (secret(ref, run, message, conversation)) { blocked.add(target.identity); return; }
      if (ignored.has(ref.operation) || ref.undoneAt) return;
      const change = list(run?.fileChanges).find(value => value.type === target.type && value.id === target.id);
      if (change?.undoneAt || ignored.has(change?.operation)) return;
      const record = recordFor(ref, target); if (!record) return;
      // ProjectMemory.settle writes diaries/indexes even when no user artifact
      // was produced. A results chip or provenance does not convert that
      // bookkeeping (including its proposed memory draft) into a deliverable.
      // Those records remain available through project memory and the chat.
      if (target.type === 'note' && record.projectMemoryType) return;
      const origin = source(conversation, run, message);
      const draftOrigin = record.aiDraft?.provenance?.origin;
      const adoptedDraft = record.provenance?.output?.variant === 'body' && record.provenance?.output?.id === target.id && record.provenance?.origin?.recorded === true && record.provenance.origin.runId === run?.id;
      const isDraft = !!record.aiDraft && (ref.operation === 'drafted' || change?.operation === 'drafted' || draftOrigin?.runId === run?.id && !!run?.id);
      if (isDraft) {
        // A newer draft supersedes older proposals for the same note.
        if (draftOrigin?.runId && draftOrigin.runId !== run?.id) return;
        if (!run || !visibleRun(run.id)) return;
        insert(target, record, 'review', origin, { review: change ? { kind: 'review', runId: run.id, editId: target.id } : null, operation: 'drafted' });
      } else {
        // A dismissed draft alone is not evidence that a file was saved.
        if ((ref.operation === 'drafted' || change?.operation === 'drafted') && !adoptedDraft) return;
        insert(target, record, 'saved', origin, { operation: ref.operation || change?.operation || 'recorded' });
      }
    }
    function localEdit(edit, conversation, run) {
      const target = identity({ type: 'local', projectId: edit?.projectId, candidateId: edit?.candidateId, path: edit?.path }); if (!target) return;
      if (secret(edit, run, conversation)) { blocked.add(target.identity); return; }
      if (!text(edit.id) || edit.projectId !== projectId || run.projectId !== projectId || edit.undoneAt || !pending.has(edit.status) && edit.status !== 'applied') return;
      const record = recordFor(edit, target); if (!record) return;
      // Duplicate proposal ids are ambiguous and cannot be opened safely.
      if (list(run.localFileEdits).filter(value => value?.id === edit.id).length !== 1) return;
      insert(target, record, pending.has(edit.status) ? 'review' : 'saved', source(conversation, run, null, edit.appliedAt || edit.updatedAt), {
        review: { kind: 'local-review', runId: run.id, editId: edit.id }, directory: !!edit.directory || edit.operation === 'mkdir', operation: text(edit.operation),
        version: text(edit.afterVersion || edit.beforeVersion || edit.version) || null, status: edit.status
      });
    }
    for (const run of list(state.agentRuns)) {
      const conversation = current('conversations', run?.conversationId);
      if (!conversation) continue;
      const refs = [...list(run.results), ...list(run.fileChanges)];
      if (!visibleRun(run.id)) {
        if (secret(run, conversation)) for (const ref of [...refs, ...list(run.localFileEdits).map(edit => ({ type: 'local', projectId: edit?.projectId, candidateId: edit?.candidateId, path: edit?.path }))]) { const target = identity(ref); if (target) blocked.add(target.identity); }
        continue;
      }
      if ((run.projectId || conversation.projectId) === projectId) relevantRuns.set(run.id, run);
      for (const ref of refs) result(ref, conversation, run, null);
      for (const edit of list(run.localFileEdits)) localEdit(edit, conversation, run);
    }
    for (const conversation of list(state.conversations)) {
      if (!conversation?.id) continue;
      for (const message of list(conversation.messages)) {
        if (!active(message) || !['assistant', 'agent'].includes(message.role)) continue;
        const run = message.runId ? current('agentRuns', message.runId) : null;
        if (secret(conversation, message, run)) { for (const ref of list(message.results)) { const target = identity(ref); if (target) blocked.add(target.identity); } continue; }
        if (!visibleConversation(conversation.id) || message.runId && (!visibleRun(message.runId) || run.conversationId !== conversation.id)) continue;
        for (const ref of list(message.results)) result(ref, conversation, run, message);
      }
    }
    // A saved artifact owns its exact body receipt. Source lifecycle controls
    // historical navigation, not the lifetime of that durable project output.
    for (const type of ['note', 'paper', 'task']) for (const record of list(state[collections[type]])) {
      if (record?.projectId !== projectId || type === 'note' && record.projectMemoryType) continue;
      for (const [variant, owner] of [['body', record], ['draft', record.aiDraft]]) {
        const p = owner?.provenance, origin = p?.origin;
        if (p?.version !== 1 || p.output?.type !== type || p.output.id !== record.id || p.output.variant !== variant || origin?.recorded !== true || ignored.has(p.operation)) continue;
        const target = identity({ type, id: record.id }); if (!target || target.id !== record.id) continue;
        if (secret(origin, owner)) { blocked.add(target.identity); continue; }
        if (ambiguousAncestry(origin, owner)) { blocked.add(target.identity); continue; }
        const conversation = current('conversations', origin.conversationId), run = current('agentRuns', origin.runId);
        const historicalRun = matches('agentRuns', origin.runId)[0];
        if (historicalRun && historicalRun.conversationId !== origin.conversationId) { blocked.add(target.identity); continue; }
        if (variant === 'body' && text(origin.runId) && text(origin.conversationId) && ['created', 'updated', 'drafted', 'captured'].includes(p.operation)
            && (!visibleConversation(origin.conversationId) || !visibleRun(origin.runId))) {
          const change = list(historicalRun?.fileChanges).find(value => value?.type === type && value.id === record.id);
          if (change?.undoneAt || ignored.has(change?.operation)) continue;
          const savedRecord = recordFor({ type, id: record.id }, target); if (!savedRecord) continue;
          insert(target, savedRecord, 'saved', retainedSource(origin), { operation: p.operation });
          continue;
        }
        if (!visibleRun(origin.runId) || run.conversationId !== conversation.id) continue;
        result({ type, id: record.id, operation: variant === 'draft' ? 'drafted' : p.operation }, conversation, run, null);
      }
    }
    const all = [...rows.values()].filter(row => !blocked.has(row.identity)).sort((a, b) => b.at - a.at || a.title.localeCompare(b.title, 'zh-CN', { numeric: true }) || a.key.localeCompare(b.key));
    // Recompute after privacy filtering. Hidden outputs must not affect counts.
    const deliveredRuns = new Set(all.flatMap(item => item.origins.map(origin => origin.runId).filter(Boolean)));
    const noOutputRuns = [...relevantRuns.values()].filter(run => ['completed', 'done'].includes(run.status) && !deliveredRuns.has(run.id))
      .map(run => ({ runId: run.id, conversationId: run.conversationId, conversationTitle: text(current('conversations', run.conversationId)?.title) || t('未命名对话', 'Untitled conversation'), at: stamp(run) }))
      .sort((a, b) => b.at - a.at);
    const counts = { all: all.length, saved: all.filter(item => item.group === 'saved').length, review: all.filter(item => item.group === 'review').length };
    const terms = text(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    filter = ['saved', 'review'].includes(filter) ? filter : 'all';
    const items = all.filter(item => (filter === 'all' || item.group === filter) && terms.every(term => `${item.title} ${item.path} ${item.origins.map(origin => origin.conversationTitle).join(' ')}`.toLocaleLowerCase().includes(term)));
    return { available: true, projectId, projectName: text(project.name), items, counts, noOutputRuns, completedWithoutOutput: noOutputRuns.length, query: text(query), filter };
  }

  function mount(container, settings = {}) {
    let options = settings, island = null, disposed = false, lastKey = '', currentProject = null, scope = null;
    const emptyState = {};
    const preferenceByProject = new Map();
    const state = () => (typeof options.state === 'function' ? options.state() : options.state) || emptyState;
    const projectId = () => typeof options.projectId === 'function' ? options.projectId() : options.projectId;
    const pref = () => { const id = projectId(); if (!preferenceByProject.has(id)) preferenceByProject.set(id, { query: '', filter: 'all', page: 0, showEmptyRuns: false, emptyRunLimit: 20 }); return preferenceByProject.get(id); };
    const current = (context, owner = context?.projectId) => !!context && !disposed && container.isConnected !== false && scope === context && projectId() === owner && state() === context.state;
    const lookup = (key, owner, context) => current(context, owner) ? build({ state: context.state, projectId: owner }).items.find(item => item.key === key) : null;
    // A source is an origin identity, never a position in a changing array.
    // Run-backed refs coalesce their message chips, while message-only refs
    // retain the message identity so a different answer cannot replace them.
    async function open(key, mode = 'open', requestedOrigin = null, owner = projectId(), anchor, section = 'outputs', context = scope) {
      const item = lookup(key, owner, context); if (!item) { if (current(context, owner)) sync(true); return false; }
      const origin = requestedOrigin === null ? item.source : item.origins.find(value => originIdentity(value) === requestedOrigin);
      if (!origin || mode === 'run' && !origin.runId || mode === 'conversation' && !origin.conversationId) return false;
      const guard = () => {
        const latest = lookup(key, owner, context); if (!latest) return false;
        if (mode === 'conversation' || mode === 'run') return latest.origins.some(value => originIdentity(value) === originIdentity(origin)
          && (mode === 'run' ? value.runId === origin.runId && !!value.runId : value.conversationId === origin.conversationId && !!value.conversationId));
        return (mode === 'review' || !item.open) && item.review ? latest.review?.kind === item.review?.kind && latest.review?.runId === item.review?.runId && latest.review?.editId === item.review?.editId : latest.open?.kind === item.open?.kind && latest.open?.id === item.open?.id;
      };
      const navigation = { anchor, origin: { view: 'project', projectId: owner, section: section === 'overview' ? 'overview' : 'outputs' } };
      try {
        let result;
        if (mode === 'conversation') result = await options.onOpenConversation?.(origin.conversationId, guard);
        else if (mode === 'run') result = await options.onOpenRun?.(origin.runId, guard);
        else if ((mode === 'review' || !item.open) && item.review) {
          if (!item.review) return false;
          result = options.onReview ? await options.onReview(item.review.kind, item.review.runId, item.review.editId, guard, navigation) : await options.onOpen?.(item.review.kind, item.review.runId, item.review.editId, undefined, guard, navigation);
        } else {
          if (!item.open) return false;
          const sourceGuard = { type: item.type, provided: false };
          if (origin.conversationId) sourceGuard.conversationId = origin.conversationId;
          // Historical identities are permission ancestry, never destinations.
          // documentTabSource already preserves these two fields on restart.
          if (origin.recordedConversationId) sourceGuard.sourceConversationId = origin.recordedConversationId;
          if (origin.recordedRunId) sourceGuard.agentRunId = origin.recordedRunId;
          if (item.type === 'local') { const [projectId, candidateId, path] = JSON.parse(item.id); Object.assign(sourceGuard, { projectId, candidateId, path }); }
          else sourceGuard.id = item.id;
          if (origin.runId) sourceGuard.runId = origin.runId;
          // Reader persistence can reconstruct the full aggregate permission.
          sourceGuard.projectOutput = { projectId: owner, key: item.key };
          result = await options.onOpen?.(item.open.kind, item.open.id, undefined, sourceGuard, guard, navigation);
        }
        if (current(context, owner)) sync(true); return result !== false;
      } catch (error) { if (current(context, owner)) options.toast?.(error.message || String(error)); return false; }
    }
    function sync(force = false) {
      if (disposed) return;
      const ownerState = state(), ownerId = projectId();
      if (!scope || scope.state !== ownerState || scope.projectId !== ownerId) {
        if (scope && scope.state !== ownerState) preferenceByProject.clear();
        // A composing KitSearchInput belongs to one scope. Retire its DOM and
        // listeners on owner change; ordinary rerenders retain the same input.
        island?.unmount(); island = null; lastKey = '';
        scope = { state: ownerState, projectId: ownerId };
      }
      const context = scope, preferences = pref(), data = build({ state: ownerState, projectId: ownerId, ...preferences });
      currentProject = data.projectId;
      const pageSize = 40, pages = Math.max(1, Math.ceil(data.items.length / pageSize));
      preferences.page = Math.max(0, Math.min(preferences.page, pages - 1));
      const owner = data.projectId, shownItems = data.items.slice(preferences.page * pageSize, (preferences.page + 1) * pageSize);
      const shownOrigins = new Map(shownItems.map(item => [item.key, item.origins.map(originIdentity)]));
      const shownEmptyRuns = data.noOutputRuns.slice(0, preferences.emptyRunLimit);
      const emptyRunOwners = new Map(shownEmptyRuns.map(run => [run.runId, run.conversationId]));
      const available = () => current(context, owner) && build({ state: context.state, projectId: owner }).available;
      const change = update => { if (!available()) return false; update(); sync(); return true; };
      const openOrigin = (key, mode, index = 0) => {
        const identity = Number.isInteger(index) && index >= 0 ? shownOrigins.get(key)?.[index] : null;
        return identity ? open(key, mode, identity, owner, undefined, 'outputs', context) : false;
      };
      const props = { ...data, items: shownItems, total: data.items.length,
        page: preferences.page, pages, showEmptyRuns: preferences.showEmptyRuns, noOutputRuns: shownEmptyRuns, moreEmptyRuns: Math.max(0, data.noOutputRuns.length - preferences.emptyRunLimit), onMoreEmptyRuns: () => change(() => { preferences.emptyRunLimit += 20; }),
        onQuery: value => typeof value === 'string' && change(() => { preferences.query = value; preferences.page = 0; }),
        onFilter: value => ['all', 'saved', 'review'].includes(value) && change(() => { preferences.filter = value; preferences.page = 0; }),
        onReset: () => change(() => { preferences.query = ''; preferences.filter = 'all'; preferences.page = 0; }),
        onPage: value => Number.isInteger(value) && value >= 0 && change(() => { preferences.page = value; }), onToggleEmptyRuns: () => change(() => { preferences.showEmptyRuns = !preferences.showEmptyRuns; }),
        onOpen: (key, anchor) => open(key, 'open', null, owner, anchor, 'outputs', context), onReview: (key, anchor) => open(key, 'review', null, owner, anchor, 'outputs', context), onSource: (key, index) => openOrigin(key, 'conversation', index), onRun: (key, index) => openOrigin(key, 'run', index),
        onStartConversation: typeof options.onStartConversation === 'function' ? async () => {
          if (!available()) return false;
          try { return await options.onStartConversation(owner, available); }
          catch (error) { if (current(context, owner)) options.toast?.(error.message || String(error)); return false; }
        } : undefined,
        onEmptyRun: async runId => {
          const conversationId = emptyRunOwners.get(runId);
          const guard = () => !!conversationId && current(context, owner) && build({ state: context.state, projectId: owner }).noOutputRuns.some(run => run.runId === runId && run.conversationId === conversationId);
          if (!guard()) return false;
          try { return await options.onOpenRun?.(runId, guard); } catch (error) { if (current(context, owner)) options.toast?.(error.message || String(error)); return false; }
        }
      };
      const key = JSON.stringify([data, preferences, root.WorkstationI18n?.getLanguage?.()]);
      if (!force && key === lastKey && island) return;
      lastKey = key;
      if (island) island.update(props); else island = (options.mount || ((host, name, props) => root.HalaskaUI.mount(host, name, props)))(container, 'ProjectOutputs', props);
    }
    sync();
    return { sync, update: next => { options = { ...options, ...next }; sync(true); },
      open: (key, request = {}) => open(key, request.mode === 'review' ? 'review' : 'open', null, request.projectId ?? projectId(), request.anchor, request.section, scope),
      dispose: () => { disposed = true; island?.unmount(); island = null; }, snapshot: () => ({ projectId: currentProject, ...pref() }) };
  }
  return { build, mount };
});
