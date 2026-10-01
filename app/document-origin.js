/* A document's entry route is distinct from its evidence/provenance. Keep only
 * route identities in preferences and resolve names/access from live records. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DocumentOrigin = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const identity = value => typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  const projectSections = ['conversations', 'knowledge', 'outputs', 'tasks', 'schedule', 'overview'];
  const spaces = ['daily', 'courses', 'research'];
  const globals = [...spaces, 'wiki', 'captures', 'dashboard', 'history', 'overview', 'conversations', 'agenda'];
  const documentKinds = ['note', 'import', 'local-file', 'review', 'local-review'];
  const sectionLabels = { conversations: '对话', knowledge: '资料', outputs: '成果', tasks: '任务', schedule: '排期', overview: '概览', projects: '项目', papers: '文献' };
  const globalLabels = { daily: '日常空间', courses: '课程空间', research: '科研空间', wiki: '科研 Wiki', captures: '随记', dashboard: '总览', history: '执行历史', overview: '总览', conversations: '全部对话', agenda: '日程' };
  const active = value => !!value && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !value.hidden && !value.hiddenAt && !value.tombstone && !value.wikiFileError && !['archived', 'deleted', 'hidden'].includes(value.status);
  const privateItem = value => !!(value?.private || value?.ephemeral || value?.incognito);
  const spaceSection = (view, value) => {
    const section = value === 'content' ? 'knowledge' : value;
    return ['projects', 'knowledge', 'tasks', 'overview', ...(view === 'research' ? ['papers'] : [])].includes(section) ? section : 'projects';
  };
  const workspaceLabel = value => ({ daily: '日常空间', '日常': '日常空间', courses: '课程空间', '课程': '课程空间', research: '科研空间', '科研': '科研空间', auto: '自动归属' })[value] || '';
  const caption = (...parts) => parts.filter(value => typeof value === 'string' && value).join(' / ');

  function clean(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const view = value.view;
    if (view === 'project') {
      const projectId = identity(value.projectId);
      return projectId ? { view, projectId, section: projectSections.includes(value.section) ? value.section : 'conversations' } : null;
    }
    if (view === 'agent') {
      const conversationId = identity(value.conversationId), messageId = identity(value.messageId);
      return conversationId ? { view, conversationId, ...(messageId ? { messageId } : {}) } : null;
    }
    if (globals.includes(view)) return { view, ...(spaces.includes(view) ? { section: spaceSection(view, value.section) } : {}) };
    if (view === 'document') {
      const id = identity(value.id);
      return id && documentKinds.includes(value.kind) ? { view, kind: value.kind, id } : null;
    }
    if (view === 'task') {
      const id = identity(value.id);
      // A task may be opened above a native surface which differs from the
      // renderer's retained route. One workspace entry is enough; never retain
      // recursive task/document trails or arbitrary display data here.
      const entry = value.entry && ['project', 'agent', ...globals].includes(value.entry.view) ? clean(value.entry) : null;
      return id ? { view, id, ...(entry ? { entry } : {}) } : null;
    }
    return null;
  }

  function resolve(state = {}, value, { getDocument, privateMode = false } = {}) {
    state ||= {};
    const origin = clean(value);
    const unavailable = () => ({ origin, label: '原入口不可用', caption: '', available: false });
    if (!origin || privateMode) return unavailable();
    const matches = (name, id) => identity(id) ? list(state[name]).filter(item => item?.id === id) : [];
    const retired = (name, id) => list(state.trash).some(bundle => list(bundle?.data?.[name]).some(item => item?.id === id));
    const unique = (name, id) => { const found = matches(name, id); return found.length === 1 && !retired(name, id) ? found[0] : null; };
    // Captured provenance can point at a private owner even after a document is
    // moved. Inspect identities/flags only; never read document or message text.
    function privateAncestry(...values) {
      const queue = values.filter(Boolean), seen = new Set();
      for (let index = 0; index < queue.length; index++) {
        const item = queue[index]; if (seen.has(item)) continue; seen.add(item);
        if (privateItem(item)) return true;
        for (const [name, ids] of [['projects', [item.projectId]], ['conversations', [item.conversationId, item.sourceConversationId]], ['agentRuns', [item.runId, item.agentRunId]]]) {
          for (const id of ids) if (identity(id)) {
            queue.push(...matches(name, id));
            for (const bundle of list(state.trash)) queue.push(...list(bundle?.data?.[name]).filter(record => record?.id === id));
          }
        }
        if (item.provenance?.origin) queue.push(item.provenance.origin);
      }
      return false;
    }
    const availableProject = id => {
      const project = unique('projects', id);
      return active(project) && !privateAncestry(project) ? project : null;
    };
    const availableRecord = (name, id) => {
      const record = unique(name, id);
      return active(record) && !privateAncestry(record) && (!record.projectId || availableProject(record.projectId)) ? record : null;
    };
    const ownerCaption = record => {
      const project = record.projectId && availableProject(record.projectId);
      return caption(workspaceLabel(project?.workspace || record.workspace), project ? text(project.name) || '未命名项目' : '');
    };
    const result = (label, detail, target = origin) => ({ origin: target, label, caption: detail, available: true });
    if (origin.view === 'project') {
      const project = availableProject(origin.projectId); if (!project) return unavailable();
      const section = sectionLabels[origin.section];
      return result('返回' + section, caption(workspaceLabel(project.workspace), text(project.name) || '未命名项目', section));
    }
    if (origin.view === 'agent') {
      const conversation = availableRecord('conversations', origin.conversationId); if (!conversation) return unavailable();
      const target = { ...origin };
      if (target.messageId) {
        const found = list(conversation.messages).filter(message => message?.id === target.messageId);
        if (found.length !== 1 || !active(found[0]) || privateAncestry(found[0])) delete target.messageId;
      }
      return result('返回对话', caption(ownerCaption(conversation), text(conversation.title) || '未命名对话'), target);
    }
    if (globals.includes(origin.view)) {
      const section = origin.section && sectionLabels[origin.section];
      return result('返回' + (section || globalLabels[origin.view]), caption(globalLabels[origin.view], section));
    }
    if (origin.view === 'task') {
      const task = availableRecord('tasks', origin.id); if (!task) return unavailable();
      if (origin.entry && !resolve(state, origin.entry, { getDocument, privateMode }).available) return unavailable();
      return result('返回任务', caption(ownerCaption(task), text(task.title) || '未命名任务'));
    }
    if (origin.view === 'document') {
      let authorized;
      if (typeof getDocument === 'function') {
        try { authorized = getDocument(origin.kind, origin.id); } catch (_) { return unavailable(); }
        // Resolution is synchronous. A pending promise is not an access grant.
        if (!authorized || typeof authorized !== 'object' || typeof authorized.then === 'function' || !active(authorized) || privateAncestry(authorized)) return unavailable();
      }
      if (origin.kind === 'note' || origin.kind === 'import') {
        const record = availableRecord(origin.kind === 'note' ? 'notes' : 'imports', origin.id);
        if (!record || authorized?.id && authorized.id !== origin.id) return unavailable();
        return result('返回文档', caption(ownerCaption(record), text(record.title) || text(record.name) || text(record.originalName) || '未命名文档'));
      }
      if (origin.kind === 'review' || origin.kind === 'local-review') {
        const run = availableRecord('agentRuns', origin.id);
        const conversation = run && availableRecord('conversations', run.conversationId);
        const changes = origin.kind === 'review' ? run?.fileChanges : run?.localFileEdits;
        if (!run || !conversation || !list(changes).length || authorized?.id && authorized.id !== origin.id) return unavailable();
        return result('返回文档', caption(ownerCaption(run), text(conversation.title) || '未命名对话', origin.kind === 'review' ? '修改审阅' : '本机文件审阅'));
      }
      // The host alone knows local-directory grants and recovery-only sessions.
      // Validate the canonical identity/owner too; a callback must not silently
      // redirect a retained tab to another project or another local file.
      let parts;
      try { parts = JSON.parse(origin.id); } catch (_) { return unavailable(); }
      if (!authorized || !Array.isArray(parts) || parts.length !== 3 || parts.some(part => !identity(part))) return unavailable();
      const [projectId, candidateId, path] = parts;
      if (JSON.stringify(parts) !== origin.id || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return unavailable();
      const project = availableProject(projectId);
      if (!project || authorized.id !== origin.id || authorized.projectId !== projectId || authorized.candidateId !== candidateId || authorized.path !== path) return unavailable();
      return result('返回文档', caption(workspaceLabel(project.workspace), text(project.name) || '未命名项目', path));
    }
    return unavailable();
  }

  function capture(state = {}, options = {}) {
    if (options.privateMode) return null;
    state ||= {};
    let origin;
    if (options.view === 'project') origin = clean({ view: 'project', projectId: state.currentProjectId, section: options.projectSection ?? state.ui?.projectTab });
    else if (options.view === 'agent') origin = clean({ view: 'agent', conversationId: state.currentConversationId, messageId: options.messageId });
    else if (globals.includes(options.view)) origin = clean({ view: options.view, section: options.spaceSection ?? state.ui?.spaceTabs?.[options.view] });
    else return null;
    const resolved = resolve(state, origin);
    return resolved.available ? resolved.origin : null;
  }
  return { clean, capture, resolve };
});
