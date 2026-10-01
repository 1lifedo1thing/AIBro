/* Independent pending-message context. Never stages into the composer, changes
 * the workspace, writes browser storage or retains source bodies in a draft. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QueueContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  const dependency = (name, file) => root[name] || (typeof require === 'function' ? require(file) : null);
  const list = value => Array.isArray(value) ? value : [];
  const clone = value => structuredClone(value);
  const active = value => !!value && !value.wikiFileError && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !['archived', 'deleted'].includes(value.status);
  const privateItem = value => !!(value?.private || value?.ephemeral || value?.incognito);
  const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const fault = (code, message) => Object.assign(new Error(message), { code });
  const cancelled = signal => { if (signal?.aborted) throw fault('CANCELLED', '已取消上下文检查。'); };
  const unique = (values, id) => { const found = list(values).filter(value => value?.id === id); return found.length === 1 ? found[0] : null; };
  const fields = ['id', 'name', 'command', 'description', 'instructions'];
  const skillSnapshot = skill => Object.fromEntries(fields.map(field => [field, String(skill?.[field] || '')]));
  function pathValid(path, directory = false) {
    return typeof path === 'string' && (directory || !!path) && !/^(?:\/|[a-z]:)/i.test(path)
      && !/[\0\\]/.test(path) && !path.split('/').some(part => part === '..' || part === '.');
  }
  function create({ getState, getConversation, selectLocal, request } = {}) {
    const F = dependency('FileContext', './file-context.js'), E = dependency('CitationEvidence', './citation-evidence.js');
    const Skills = dependency('WorkstationSkillsCore', './skills-core.js'), Queue = dependency('AgentQueue', './agent-queue.js');
    const snapshot = value => Queue.snapshot(value);
    const state = () => getState?.() || {};
    const conversation = id => getConversation ? getConversation(id) : unique(state().conversations, id);
    const versions = new Map(), identities = new Map(); let serial = 0;
    const identity = ref => F.key(ref);
    const key = ref => { const value = identity(ref); if (!identities.has(value)) identities.set(value, `material-${++serial}`); return identities.get(value); };
    const versionKey = (id, ref) => `${id}\0${identity(ref)}`;
    const call = (url, body, signal) => (request || F.request)(url, body, signal);
    function owner(id, adding = false) {
      const value = conversation(id);
      if (!value || value.id !== id || !active(value)) throw fault('QUEUE_GONE', '原对话已删除或归档，请重新打开队列。');
      if (adding && privateItem(value)) throw fault('QUEUE_PRIVATE', '私密对话不能新增资料引用。');
      return value;
    }
    function access(id, ref) {
      const current = conversation(id);
      if (!current || !active(current)) return { kind: 'missing', available: false };
      if (privateItem(current)) return { kind: 'private', available: false };
      if (!['import', 'note', 'local'].includes(ref?.type) || ref.type === 'local' && !pathValid(ref.path)) return { kind: 'invalid', available: false };
      return E.access(state(), ref);
    }
    function assertAccess(id, ref) {
      owner(id, true); const result = access(id, ref);
      if (!result.available) throw fault('QUEUE_SOURCE_UNAVAILABLE', '该来源已不可用或已设为私密，请移除后重新选择。');
      return result;
    }
    function inputFor(ref, record) {
      return ref.type === 'note' ? String(record.content || '') : JSON.stringify([record.id, record.createdAt, record.size, record.originalName]);
    }
    function safeRef(ref, hidden = false) {
      const result = {};
      for (const name of ['type', 'id', 'projectId', 'candidateId', 'path', 'title', 'version', 'selectedAt']) {
        if (Object.hasOwn(ref, name) && !(hidden && ['path', 'title', 'version'].includes(name))) result[name] = ref[name];
      }
      return result;
    }
    function groups(context) {
      const result = new Map();
      for (const id of context.attachmentIds) { const ref = { type: 'import', id }; result.set(identity(ref), { ref, attachment: true, reference: false }); }
      for (const ref of context.fileReferences) {
        const value = ref && typeof ref === 'object' ? ref : { type: 'invalid' }, previous = result.get(identity(value));
        result.set(identity(value), { ref: value, attachment: !!previous?.attachment, reference: true });
      }
      return [...result.values()];
    }
    function material(id, group) {
      const ref = group.ref, visibility = access(id, ref), cached = versions.get(versionKey(id, ref));
      let status = visibility.kind, reason = '', checked = false;
      if (visibility.available) {
        status = 'available';
        if (group.reference && !ref.version) { status = 'invalid'; reason = '此引用缺少版本，请更新后发送。'; }
        else if (group.reference && cached && (ref.type === 'local' || cached.input === inputFor(ref, visibility.record))) {
          checked = true;
          if (cached.error) { status = 'unavailable'; reason = cached.error; }
          else if (cached.version !== ref.version) { status = 'changed'; reason = '原文已修改，请更新为当前版本或移除引用。'; }
        } else if (group.reference && cached) {
          status = 'changed'; reason = '原文在核验后发生变化，请重新检查。';
        }
      }
      if (!visibility.available) reason = status === 'private' ? '来源已设为私密，不能用于此条消息。' : status === 'invalid' ? '引用格式或本机路径无效，请移除后重新选择。' : '来源或所属项目已删除、归档或断开。';
      const hidden = status === 'private', title = hidden ? '私密来源' : ref.type === 'local' ? ref.title || ref.path || '本机文件' : visibility.record?.title || visibility.record?.name || visibility.record?.originalName || ref.title || '不可用来源';
      return { key: key(ref), type: ref.type, id: ref.id, title, status, reason, checked, ref: safeRef(ref, hidden),
        attachment: group.attachment, reference: group.reference,
        remove: { action: 'remove-material', key: key(ref) },
        refresh: visibility.available ? { action: 'refresh-material', type: ref.type, id: ref.id, ref: safeRef(ref) } : null };
    }
    function currentSkill(id) {
      const raw = list(state().skills).filter(skill => skill?.id === id);
      if (raw.some(privateItem) || raw.length > 1) return null;
      return Skills.get(state(), id);
    }
    function skillRow(saved) {
      const current = currentSkill(saved.id), disabled = state().settings?.skillsEnabled === false || current?.enabled === false;
      const status = !current ? 'missing' : disabled ? 'disabled' : stable(skillSnapshot(current)) !== stable(skillSnapshot(saved)) ? 'changed' : 'frozen';
      return { key: `skill:${saved.id}`, id: saved.id, title: current?.name || '不可用技能', name: current?.name || '不可用技能', status,
        reason: status === 'missing' ? '技能已删除或不可用，请移除。' : status === 'disabled' ? '技能已停用，不能随此条消息发送。' : status === 'changed' ? '技能已有新版本；当前保留入队时的说明，可明确更新。' : '保留此条消息选择时的说明。',
        remove: { action: 'remove-skill', id: saved.id }, refresh: current && !disabled ? { action: 'refresh-skill', id: saved.id } : null };
    }
    function inspect(id, value) {
      const context = snapshot(value), materials = groups(context).map(group => material(id, group)), skills = context.skillSnapshot.map(skillRow);
      const issues = [...materials.filter(row => row.status !== 'available'), ...skills.filter(row => ['disabled', 'missing'].includes(row.status))]
        .map(row => ({ key: row.key, type: row.type || 'skill', status: row.status, reason: row.reason }));
      if (!active(conversation(id))) issues.unshift({ key: 'conversation', type: 'conversation', status: 'missing', reason: '原对话已删除或归档。' });
      if (!context.goal.trim()) issues.unshift({ key: 'goal', type: 'goal', status: 'empty', reason: '排队消息不能为空。' });
      return { materials, skills, issues, canSend: !issues.length };
    }
    function catalog(id, query = '') {
      owner(id); if (privateItem(conversation(id))) return { materials: [], skills: [], projects: [] };
      const current = state(), terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = value => terms.every(term => value.toLocaleLowerCase().includes(term));
      const materials = F.search(current, query, conversation(id)?.projectId).filter(ref => access(id, ref).available).map(ref => ({
        key: key(ref), type: ref.type, id: ref.id, title: ref.title, location: ref.location, projectId: ref.projectId,
        add: { action: 'add-material', type: ref.type, id: ref.id } }));
      const skills = state().settings?.skillsEnabled === false ? [] : Skills.list(current).filter(skill => currentSkill(skill.id) && skill.enabled !== false && matches(`${skill.name} ${skill.command} ${skill.description}`))
        .map(skill => ({ key: `skill:${skill.id}`, id: skill.id, title: skill.name, name: skill.name, description: skill.description, command: skill.command, add: { action: 'add-skill', id: skill.id } }));
      const projects = list(current.projects).filter(project => project.localFolder?.id && E.access(current, { type: 'local', projectId: project.id, candidateId: project.localFolder.id }).available && matches(project.name || ''))
        .map(project => ({ key: `project:${project.id}`, id: project.id, title: project.name || '本机项目', candidateId: project.localFolder.id }));
      return { materials, skills, projects };
    }
    async function readRef(id, ref, { signal } = {}) {
      cancelled(signal); const visibility = assertAccess(id, ref), before = ref.type === 'local' ? null : inputFor(ref, visibility.record);
      let result;
      if (ref.type === 'local') {
        const value = selectLocal ? await selectLocal(safeRef(ref), { conversationId: id, signal }) : await call('/__local/read', { candidateId: ref.candidateId, path: ref.path, offset: 0 }, signal);
        if (!value || typeof value.version !== 'string' || !value.version || value.path && value.path !== ref.path || value.candidateId && value.candidateId !== ref.candidateId) throw fault('QUEUE_SOURCE_CHANGED', '文件检查结果与原引用不匹配，请重新选择。');
        result = { ...safeRef(ref), version: value.version, selectedAt: Date.now() };
      } else result = { type: ref.type, id: ref.id, title: visibility.record.title || visibility.record.name || visibility.record.originalName || '未命名来源', projectId: visibility.record.projectId || null, version: await F.digest(before), selectedAt: Date.now() };
      cancelled(signal); const after = assertAccess(id, ref);
      if (before !== null && before !== inputFor(ref, after.record)) throw fault('QUEUE_SOURCE_CHANGED', '原文在检查期间发生修改，请重新检查。');
      versions.set(versionKey(id, ref), { input: before, version: result.version });
      return result;
    }
    async function check(id, value, options = {}) {
      const context = snapshot(value); owner(id);
      // Sequential reads prevent opening many local file buffers at once. Only
      // hashes/metadata survive; no returned local text enters a draft/cache.
      for (const group of groups(context)) {
        cancelled(options.signal); if (!group.reference || !access(id, group.ref).available) continue;
        try { await readRef(id, group.ref, options); }
        catch (error) {
          cancelled(options.signal); owner(id);
          const visibility = access(id, group.ref);
          if (visibility.available) versions.set(versionKey(id, group.ref), { input: group.ref.type === 'local' ? null : inputFor(group.ref, visibility.record), error: '无法确认当前原文版本，请重新检查或移除此引用。' });
        }
      }
      cancelled(options.signal); return inspect(id, context);
    }
    async function browse(id, { projectId, path = '', offset = 0, signal } = {}) {
      owner(id, true);
      if (!pathValid(path, true) || !Number.isSafeInteger(offset) || offset < 0) throw fault('QUEUE_PATH', '本机目录或分页位置无效。');
      const project = unique(state().projects, projectId), candidateId = project?.localFolder?.id, ref = { type: 'local', projectId, candidateId };
      if (!candidateId || !E.access(state(), ref).available) throw fault('QUEUE_SOURCE_UNAVAILABLE', '本机项目已断开、归档或设为私密。');
      cancelled(signal); const result = await call('/__local/files', { candidateId, path, offset }, signal);
      cancelled(signal); owner(id, true);
      if (!E.access(state(), ref).available) throw fault('QUEUE_SOURCE_UNAVAILABLE', '本机项目已断开、归档或设为私密。');
      const entries = list(result.entries).filter(entry => pathValid(entry.path)).map(entry => {
        const item = { type: 'local', projectId, candidateId, path: entry.path, title: String(entry.name || entry.path) };
        return { ...item, key: key(item), directory: entry.type === 'directory', disabled: entry.type !== 'directory' && !entry.supported, add: { action: 'add-material', type: 'local', ref: item } };
      });
      return { entries, nextOffset: Number.isSafeInteger(result.nextOffset) && result.nextOffset >= 0 ? result.nextOffset : null };
    }
    async function mutate(id, value, command, options = {}) {
      owner(id); const context = snapshot(value), action = command?.action;
      if (action === 'remove-skill') { context.skillSnapshot = context.skillSnapshot.filter(skill => skill.id !== command.id); return context; }
      if (action === 'add-skill' || action === 'refresh-skill') {
        const skill = currentSkill(command.id);
        if (!skill || skill.enabled === false || state().settings?.skillsEnabled === false) throw fault('QUEUE_SKILL_UNAVAILABLE', '该技能已删除或停用，请重新选择。');
        const index = context.skillSnapshot.findIndex(saved => saved.id === command.id);
        if (action === 'refresh-skill' && index < 0) throw fault('QUEUE_CONTEXT_CHANGED', '这条消息已不再包含该技能。');
        if (index < 0) context.skillSnapshot.push(skillSnapshot(skill));
        else if (action === 'refresh-skill') context.skillSnapshot[index] = skillSnapshot(skill);
        return context;
      }
      const selected = groups(context).find(group => command.key ? key(group.ref) === command.key : identity(group.ref) === identity(command.ref || { type: command.type, id: command.id }));
      const ref = selected?.ref || command.ref || { type: command.type, id: command.id };
      if (action === 'remove-material') {
        if (!selected) throw fault('QUEUE_CONTEXT_CHANGED', '这条消息已不再包含该资料。');
        context.fileReferences = context.fileReferences.filter(item => identity(item) !== identity(ref));
        if (ref.type === 'import') context.attachmentIds = context.attachmentIds.filter(item => item !== ref.id);
        return context;
      }
      if (!['add-material', 'refresh-material'].includes(action)) throw fault('QUEUE_COMMAND', '不支持的队列上下文操作。');
      if (action === 'refresh-material' && !selected) throw fault('QUEUE_CONTEXT_CHANGED', '这条消息已不再包含该资料。');
      assertAccess(id, ref);
      // Adding an already selected source is idempotent; only explicit refresh
      // updates a frozen version (and any selected range stays user-owned).
      if (action === 'add-material' && selected) return context;
      const updated = await readRef(id, ref, options);
      if (ref.selection && typeof ref.selection === 'object') updated.selection = clone(ref.selection);
      const index = context.fileReferences.findIndex(item => identity(item) === identity(ref));
      if (index < 0) context.fileReferences.push(updated);
      else context.fileReferences = context.fileReferences.flatMap((item, i) => identity(item) !== identity(ref) ? [item] : i === index ? [updated] : []);
      if (ref.type === 'import' && !context.attachmentIds.includes(ref.id)) context.attachmentIds.push(ref.id);
      return context;
    }
    async function validate(id, value, { changedFrom, signal } = {}) {
      owner(id); const context = snapshot(value), before = snapshot(changedFrom);
      if (!context.goal.trim()) throw fault('QUEUE_EMPTY', '排队消息不能为空。');
      const changed = [];
      for (const group of groups(context)) {
        const old = groups(before).find(item => identity(item.ref) === identity(group.ref));
        if (old && stable(old) === stable(group)) continue;
        changed.push(group);
        assertAccess(id, group.ref);
        if (group.reference) {
          const latest = await readRef(id, group.ref, { signal });
          if (latest.version !== group.ref.version) throw fault('QUEUE_SOURCE_CHANGED', '所选原文已变化，请先更新引用再保存。');
        }
      }
      for (const saved of context.skillSnapshot) {
        if (before.skillSnapshot.some(old => stable(old) === stable(saved))) continue;
        const skill = currentSkill(saved.id);
        if (!skill || skill.enabled === false || state().settings?.skillsEnabled === false || stable(skillSnapshot(skill)) !== stable(skillSnapshot(saved))) throw fault('QUEUE_SKILL_UNAVAILABLE', '所选技能已变化或停用，请重新选择或更新。');
      }
      // Later awaited file checks may have changed access or the earlier
      // in-memory note version. Recheck all newly selected identities together.
      for (const group of changed) {
        const visibility = assertAccess(id, group.ref);
        if (group.reference && group.ref.type !== 'local' && versions.get(versionKey(id, group.ref))?.input !== inputFor(group.ref, visibility.record)) throw fault('QUEUE_SOURCE_CHANGED', '所选原文已变化，请先更新引用再保存。');
      }
      cancelled(signal); owner(id); return context;
    }
    return { inspect, catalog, check, browse, mutate, validate, snapshot };
  }
  return { create };
});
