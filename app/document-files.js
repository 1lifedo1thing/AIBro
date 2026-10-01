/* Metadata-only document navigation. Never reads bodies, the filesystem or a
 * provider. Open targets use the existing preview identity contract; local
 * availability means a connected owner, not a fresh disk existence check. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DocumentFiles = api; root.DocumentFileCatalog = api; }
})(globalThis, root => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const active = value => !!value && !value.wikiFileError && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !['archived', 'deleted'].includes(value.status);
  const privateItem = value => !!(value?.private || value?.ephemeral || value?.incognito);
  const collections = { note: 'notes', import: 'imports', local: 'projects' };
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  const localId = ref => JSON.stringify([ref.projectId, ref.candidateId, ref.path]);
  const pathValid = path => !!text(path) && !/^(?:\/|[a-z]:)/i.test(path) && !/[\0\\]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..');
  const rank = { library: 0, inputs: 0, history: 1, outputs: 2, review: 3 };
  const opaque = value => { let a = 2166136261, b = 5381; for (const ch of value) { a = Math.imul(a ^ ch.codePointAt(0), 16777619); b = Math.imul(b, 33) ^ ch.codePointAt(0); } return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`; };
  const pending = new Set(['pending', 'partial', 'interrupted', 'applying', 'undoing']);
  const index = values => { const result = new Map(); for (const value of list(values)) if (value?.id) { const matches = result.get(value.id) || []; matches.push(value); result.set(value.id, matches); } return result; };
  const single = values => values?.length === 1 ? values[0] : null;
  const stamp = value => Number(value?.finishedAt || value?.updatedAt || value?.startedAt || value?.at || value?.createdAt) || 0;
  function build({ state = {}, conversationId = null, projectId, scope = 'conversation', query = '' } = {}) {
    scope = scope === 'all' ? 'all' : 'conversation';
    const names = ['projects', 'notes', 'imports', 'conversations', 'agentRuns'];
    const current = Object.fromEntries(names.map(name => [name, index(state[name])]));
    // Trash is consulted only for privacy inheritance, never to revive records.
    const retired = Object.fromEntries(names.map(name => [name, new Map()]));
    for (const bundle of list(state.trash)) for (const name of names) for (const value of [...list(bundle?.data?.[name]), ...(name === 'agentRuns' ? list(bundle?.data?.runs) : [])]) {
      if (!value?.id) continue;
      const matches = retired[name].get(value.id) || []; matches.push(value); retired[name].set(value.id, matches);
    }
    const matches = (name, id) => id ? [...(current[name]?.get(id) || []), ...(retired[name]?.get(id) || [])] : [];
    function isPrivate(values) {
      const queue = values.filter(Boolean), seen = new Set();
      for (let at = 0; at < queue.length; at++) {
        const value = queue[at]; if (seen.has(value)) continue; seen.add(value);
        if (privateItem(value)) return true;
        if (value.provenance?.origin) queue.push(value.provenance.origin);
        for (const owner of matches('projects', value.projectId)) queue.push(owner);
        for (const id of [value.agentRunId, value.runId]) for (const owner of matches('agentRuns', id)) queue.push(owner);
        for (const id of [value.sourceConversationId, value.conversationId]) for (const owner of matches('conversations', id)) queue.push(owner);
      }
      return false;
    }
    const conversation = single(current.conversations.get(conversationId));
    const ownerPrivate = isPrivate(matches('conversations', conversationId));
    const ownerAvailable = active(conversation) && !ownerPrivate;
    const selectedProject = projectId === undefined ? conversation?.projectId || null : projectId || null;
    const project = single(current.projects.get(selectedProject));
    const projectAvailable = !selectedProject || active(project) && !isPrivate(matches('projects', selectedProject));
    const rows = new Map();
    const localRoots = [];
    function access(ref, provenance = {}) {
      const values = matches(collections[ref.type], ref.type === 'local' ? ref.projectId : ref.id);
      if (isPrivate([ref, provenance, ...values])) return { status: 'private', record: null };
      const record = single(current[collections[ref.type]]?.get(ref.type === 'local' ? ref.projectId : ref.id));
      const owner = ref.type === 'local' ? record : single(current.projects.get(record?.projectId));
      if (!active(record) || record.projectId && !active(owner)) return { status: 'missing', record: null };
      if (ref.type === 'local' && (!pathValid(ref.path) || !ref.candidateId)) return { status: 'invalid', record: null };
      if (ref.type === 'local' && record.localFolder?.id !== ref.candidateId) return { status: 'disconnected', record: null };
      return { status: 'available', record };
    }
    function canonical(value) {
      const type = value?.type || (value?.kind === 'local-file' ? 'local' : value?.kind);
      const provenance = Object.fromEntries(['runId', 'agentRunId', 'conversationId', 'sourceConversationId'].filter(name => text(value?.[name])).map(name => [name, value[name]]));
      if (!Object.hasOwn(collections, type)) return null;
      if (type === 'local') {
        if (!text(value.projectId) || !text(value.candidateId) || !text(value.path)) return null;
        return { ...provenance, type, projectId: value.projectId, candidateId: value.candidateId, path: value.path, title: text(value.title) || text(value.name), version: text(value.version), private: privateItem(value) };
      }
      if (!text(value.id)) return null;
      let id = value.id;
      if (type === 'note' && root.NoteConsolidation?.resolveId) id = root.NoteConsolidation.resolveId(state, id) || id;
      return { ...provenance, type, id, title: text(value.title) || text(value.name), projectId: text(value.projectId) || null, version: text(value.version), private: privateItem(value) };
    }
    function add(value, group, origin, options = {}) {
      const ref = canonical(value); if (!ref) return;
      const visibility = access(ref, options.provenance || {}), hidden = visibility.status === 'private';
      const record = visibility.record, local = ref.type === 'local';
      const id = local ? localId(ref) : ref.id, kind = local ? 'local-file' : ref.type;
      const key = JSON.stringify([kind, id]);
      const available = visibility.status === 'available';
      const actualProjectId = local ? ref.projectId : record?.projectId || ref.projectId || null;
      const actualProject = single(current.projects.get(actualProjectId));
      const title = hidden ? t('私密文件', 'Private file') : text(record?.title) || text(record?.name) || text(record?.originalName) || ref.title || (local ? ref.path.split('/').at(-1) : t('不可用文件', 'Unavailable file'));
      const path = hidden ? '' : local ? ref.path : [text(record?.folderPath), title].filter(Boolean).join('/');
      const status = !available ? visibility.status : options.status || (group === 'outputs' ? 'saved' : group === 'review' ? 'pending' : 'reference');
      const reason = hidden ? t('已设为私密，名称与路径已隐藏。', 'Private: name and path are hidden.')
        : !available ? t('文件或所属项目已删除、归档、断开或不可用。', 'The file or its project is deleted, archived, disconnected or unavailable.')
        : options.reason || (local ? t('打开时读取磁盘当前版本；这里保留对话中的版本记录。', 'Opening reads the current disk file; this list retains the recorded version.') : '');
      const review = available && options.review ? { ...options.review } : null;
      const open = available && !options.proposalOnly ? { kind, id } : null;
      const version = hidden ? null : text(options.version || ref.version) || null;
      const entry = { key, kind, type: ref.type, id, name: title, title, path, projectId: hidden ? null : actualProjectId,
        projectName: hidden ? '' : text(actualProject?.name), candidateId: hidden ? null : local ? ref.candidateId : null,
        group, status, available, disabled: !available || !open && !review, reason, open, review,
        reviews: review ? [review] : [], origins: [origin], version, recordedVersions: version ? [version] : [],
        versionStatus: local ? 'not-checked' : 'current-record', updatedAt: Number(record?.updatedAt) || 0,
        directory: !!options.directory };
      const previous = rows.get(key);
      if (!previous) { rows.set(key, entry); return; }
      const origins = [...previous.origins, origin].filter((item, i, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === i);
      // Any private provenance redacts the whole deduplicated row, including
      // paths/versions from a previously encountered public reference.
      if (previous.status === 'private' || hidden) {
        const redacted = hidden ? entry : previous;
        rows.set(key, { ...redacted, origins, open: null, review: null, reviews: [], recordedVersions: [], version: null }); return;
      }
      const reviews = [...previous.reviews, ...entry.reviews].filter((item, i, all) => all.findIndex(other => other.runId === item.runId && other.editId === item.editId) === i);
      const winner = rank[group] > rank[previous.group] ? entry : previous;
      rows.set(key, { ...winner, origins, reviews, review: winner.review || reviews[0] || null,
        recordedVersions: [...new Set([...previous.recordedVersions, ...entry.recordedVersions])],
        // A real input/output can still be opened alongside a pending proposal.
        open: winner.open || previous.open || entry.open,
        disabled: !(winner.open || previous.open || entry.open || reviews.length) });
    }
    function addResult(result, origin, run) {
      if (!['note', 'import'].includes(result?.type)) return;
      const change = list(run?.fileChanges).find(item => item.type === result.type && item.id === result.id);
      if (result.undoneAt || change?.undoneAt) return;
      const ref = canonical(result); if (!ref) return;
      const record = single(current[collections[ref.type]].get(ref.id));
      const proposal = ref.type === 'note' && (result.operation === 'drafted' || change?.operation === 'drafted');
      // Tree projections stay metadata-only. The full review compares the exact
      // proposal snapshot before offering an action; this list must not borrow
      // a newer run's aiDraft or hash/clone document bodies on every refresh.
      const draftOrigin = ref.type === 'note' && record?.aiDraft?.provenance?.origin;
      const drafted = !!run?.id && draftOrigin?.runId === run.id;
      const adopted = proposal && !!run?.id && record?.provenance?.origin?.recorded === true
        && record.provenance.origin.runId === run.id && record.provenance.output?.type === 'note'
        && record.provenance.output.id === ref.id && record.provenance.output.variant === 'body';
      const historical = proposal && !drafted && !adopted;
      const review = (drafted || historical) && change && run?.id
        ? { kind: 'review', runId: run.id, editId: ref.id, ...(historical ? { label: t('查看历史修改', 'View recorded changes') } : {}) } : null;
      add(result, drafted ? 'review' : historical ? 'history' : result.operation === 'matched' ? 'inputs' : 'outputs', origin, {
        provenance: run || {}, status: drafted ? 'draft' : historical ? 'recorded-proposal' : undefined,
        reason: historical ? t('历史提案；尚未确认它是当前待处理草稿或已采纳成果。打开修改记录查看实际状态。', 'Recorded proposal. It is not confirmed as the current draft or an adopted output; open its changes to check the actual status.') : '',
        review
      });
    }
    if (scope === 'conversation' && ownerAvailable) {
      const runs = list(state.agentRuns).filter(run => active(run) && run.conversationId === conversationId).slice().sort((a, b) => stamp(b) - stamp(a));
      for (const message of list(conversation.messages)) {
        if (!active(message)) continue;
        const origin = { kind: 'attachment', messageId: message.id || null };
        const snapshots = new Map(list(message.attachments).filter(value => value?.id).map(value => [value.id, value]));
        for (const id of new Set([...list(message.attachmentIds).filter(value => typeof value === 'string'), ...snapshots.keys()])) {
          const snapshot = snapshots.get(id); add({ type: 'import', id, title: snapshot?.name, private: privateItem(snapshot) }, 'inputs', origin, { provenance: message });
        }
        if (message.role === 'user') for (const ref of list(message.fileReferences)) add(ref, 'inputs', { kind: 'reference', messageId: message.id || null }, { provenance: message });
        const linkedRun = single(current.agentRuns.get(message.runId));
        const run = linkedRun?.conversationId === conversationId ? linkedRun : null;
        for (const result of linkedRun && !run ? [] : list(message.results)) addResult(result, { kind: 'result', messageId: message.id || null, runId: run?.id || null }, run);
      }
      for (const run of runs) {
        for (const id of list(run.attachmentIds)) if (typeof id === 'string') add({ type: 'import', id }, 'inputs', { kind: 'attachment', runId: run.id }, { provenance: run });
        for (const ref of list(run.fileReferences)) add(ref, 'inputs', { kind: 'reference', runId: run.id }, { provenance: run });
        for (const result of [...list(run.results), ...list(run.fileChanges), ...list(run.memoryNoteIds).map(id => ({ type: 'note', id }))]) addResult(result, { kind: 'result', runId: run.id }, run);
        for (const edit of list(run.localFileEdits)) {
          if (!edit?.id || !pending.has(edit.status) && edit.status !== 'applied') continue;
          // A proposal in a different project is not evidence of an output of
          // this run. Never silently open a root selected by mismatched data.
          if (!run.projectId || edit.projectId !== run.projectId) continue;
          const reviewing = pending.has(edit.status);
          add({ ...edit, type: 'local' }, reviewing ? 'review' : 'outputs', { kind: 'local-edit', runId: run.id, editId: edit.id }, {
            provenance: run, status: edit.status, proposalOnly: true, directory: edit.directory || edit.operation === 'mkdir',
            version: edit.status === 'applied' ? edit.afterVersion : edit.beforeVersion || edit.version,
            review: { kind: 'local-review', runId: run.id, editId: edit.id, status: edit.status }
          });
          const row = rows.get(JSON.stringify(['local-file', localId(edit)]));
          if (row?.available && edit.status === 'applied' && !row.directory) { row.open = { kind: 'local-file', id: row.id }; row.disabled = false; }
        }
      }
      // Saving a reply creates a durable note, not a new agent tool result.
      // Use its explicit capture relation; never infer an output from text,
      // an unrelated origin, or a pending aiDraft. The compact receipt also
      // survives sync projections that omit legacy sourceMessageId metadata.
      for (const note of list(state.notes)) {
        if (note?.sourceConversationId !== conversationId) continue;
        const messageId = text(note.sourceMessageId), saved = note.provenance;
        const captured = saved?.version === 1 && saved.operation === 'captured'
          && saved.output?.type === 'note' && saved.output.id === note.id && saved.output.variant === 'body'
          && saved.origin?.recorded === true && saved.origin.conversationId === conversationId;
        if (!messageId && !captured) continue;
        const messages = messageId ? list(conversation.messages).filter(message => message?.id === messageId) : [];
        add({ type: 'note', id: note.id, private: isPrivate(messages) }, 'outputs', { kind: 'capture', messageId: messageId || null });
      }
    } else if (scope === 'all' && projectAvailable) {
      for (const type of ['note', 'import']) for (const record of list(state[collections[type]])) {
        if (selectedProject && record?.projectId !== selectedProject) continue;
        const ref = { type, id: record?.id };
        if (access(ref).status === 'available') add(ref, 'library', { kind: 'library' });
      }
      for (const p of list(state.projects)) {
        if (!p?.localFolder?.id || selectedProject && p.id !== selectedProject || !active(p) || isPrivate(matches('projects', p.id)) || !single(current.projects.get(p.id))) continue;
        localRoots.push({ key: JSON.stringify(['local-root', p.id, p.localFolder.id]), projectId: p.id, candidateId: p.localFolder.id,
          name: text(p.localFolder.name) || text(p.name) || t('本机目录', 'Local folder'), projectName: text(p.name), path: '', available: true, versionStatus: 'not-checked' });
      }
    }
    const terms = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const items = [...rows.values()].map(item => {
      if (item.status === 'private') return { ...item, key: `private:${opaque(item.key)}`, id: item.kind === 'local-file' ? null : item.id };
      if (['review', 'history'].includes(item.group) && item.reviews.length) return { ...item, currentOpen: item.open, open: null };
      return item;
    }).filter(item => terms.every(term => `${item.title} ${item.path} ${item.projectName}`.toLocaleLowerCase().includes(term)));
    const labels = scope === 'all' ? [['library', t('项目资料', 'Library files')]]
      : [['review', t('待审阅', 'To review')], ['outputs', t('已保存产出', 'Saved outputs')], ['inputs', t('对话资料', 'Conversation sources')], ['history', t('历史修改', 'Recorded changes')]];
    const groups = labels.map(([id, label]) => ({ id, label, items: items.filter(item => item.group === id) })).filter(group => group.items.length);
    return { scope, scopeLabel: scope === 'all' ? t('所有文件', 'All files') : t('对话文件', 'Conversation files'),
      conversationId, projectId: selectedProject, available: scope === 'all' ? projectAvailable : ownerAvailable,
      reason: scope === 'conversation' && !ownerAvailable ? ownerPrivate ? 'private' : 'missing' : scope === 'all' && !projectAvailable ? 'missing-project' : '',
      groups, items, localRoots };
  }
  return { build, localId, pathValid };
});
