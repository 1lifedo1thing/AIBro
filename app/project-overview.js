/* A metadata-only project overview. Output receipts remain owned by ProjectOutputs. */
(function (root, factory) {
  const common = typeof module === 'object' && module.exports;
  const api = factory(root, common ? require('./citation-evidence.js') : null, common ? require('./project-outputs.js') : null);
  if (common) module.exports = api; else root.ProjectOverview = api;
})(globalThis, function (root, evidence, outputIndex) {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const active = value => !!text(value?.id) && !value.deleted && !value.deletedAt && !value.archived && !value.archivedAt && !value.hidden && !value.hiddenAt && !value.tombstone && !value.wikiFileError && !['deleted', 'archived', 'hidden'].includes(value.status);
  const memoryTypes = new Set(['daily', 'plan', 'long']);
  const sections = new Set(['knowledge', 'tasks', 'outputs', 'conversations', 'overview', 'schedule']);
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en';
  const t = (zh, en) => english() ? en : zh;

  function timestamp(value) {
    if (value === null || value === undefined || value === '' || !['number', 'string'].includes(typeof value)) return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number), date = new Date(0);
      date.setFullYear(year, month - 1, day); date.setHours(0, 0, 0, 0);
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
    }
    const result = new Date(value).getTime(); return Number.isFinite(result) ? result : null;
  }
  const latest = record => timestamp(record.updatedAt) ?? timestamp(record.createdAt) ?? 0;
  function dateLabel(value, format) {
    const at = timestamp(value); if (at === null) return '';
    if (typeof format === 'function') return text(format(value));
    return new Date(at).toLocaleDateString(english() ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function taskStatus(status) {
    const labels = { todo: t('待开始', 'To do'), in_progress: t('进行中', 'In progress'), done: t('已完成', 'Done'), blocked: t('受阻', 'Blocked') };
    return Object.hasOwn(labels, status) ? labels[status] : t('待开始', 'To do');
  }
  function outputStatus(item) {
    const labels = { partial: t('部分应用', 'Partially applied'), interrupted: t('已中断', 'Interrupted'), applying: t('应用中', 'Applying'), undoing: t('撤销中', 'Undoing') };
    const status = Object.hasOwn(labels, item.status) ? labels[item.status] : '';
    return status || (item.group === 'review' ? t('待审阅', 'Review needed') : t('已保存', 'Saved'));
  }
  function inspect({ state = {}, projectId, formatDate, formatRelative } = {}) {
    const model = { available: false, projectId, description: '', taskCount: 0, doneCount: 0, sourceCount: 0, recordCount: 0, outputCount: 0, reviewCount: 0, tasks: [], outputs: [] };
    const result = { model, taskIds: new Set(), outputKeys: new Set() };
    const access = (evidence || root.CitationEvidence)?.createAccessContext?.(state), Outputs = outputIndex || root.ProjectOutputs;
    if (!text(projectId) || !access || typeof Outputs?.build !== 'function') return result;
    const readable = (type, item) => {
      if (!active(item)) return false;
      const ref = type === 'project' ? { type: 'local', projectId: item.id, candidateId: item.localFolder?.id } : { type, id: item.id };
      return access.access(ref).kind === 'available' && !access.isAmbiguous(ref);
    };
    const project = list(state.projects).find(item => item?.id === projectId);
    if (!readable('project', project)) return result;
    const owned = (type, items) => list(items).filter(item => item?.projectId === projectId && readable(type, item));
    const tasks = owned('task', state.tasks), notes = owned('note', state.notes);
    const records = notes.filter(item => Object.hasOwn(item, 'projectMemoryType') && memoryTypes.has(item.projectMemoryType));
    const outputs = Outputs.build({ state, projectId });
    // Both surfaces must agree that the project itself is still available.
    if (!outputs.available) return result;
    model.available = true; model.description = text(project.description);
    model.taskCount = tasks.length; model.doneCount = tasks.filter(item => item.status === 'done').length;
    model.recordCount = records.length;
    model.sourceCount = notes.length - records.length + owned('import', state.imports).length + owned('paper', state.papers).length;
    model.outputCount = outputs.counts.all; model.reviewCount = outputs.counts.review;
    const due = item => timestamp(item.dueAt) ?? Infinity;
    model.tasks = tasks.filter(item => item.status !== 'done').sort((a, b) => due(a) - due(b) || latest(b) - latest(a) || a.id.localeCompare(b.id)).slice(0, 3)
      .map(item => ({ id: item.id, title: text(item.title) || t('未命名任务', 'Untitled task'), dueLabel: dateLabel(item.dueAt, formatDate), statusLabel: taskStatus(item.status) }));
    model.outputs = outputs.items.slice(0, 4).map(item => ({ key: item.key, title: item.title,
      typeLabel: item.directory ? t('目录', 'Folder') : ({ note: t('文档', 'Document'), import: t('资料', 'Source'), paper: t('论文', 'Paper'), task: t('任务', 'Task'), local: t('文件', 'File') })[item.type] || t('成果', 'Output'),
      statusLabel: outputStatus(item), review: item.group === 'review', updatedLabel: item.at || item.updatedAt ? dateLabel(item.at || item.updatedAt, formatRelative) : '' }));
    result.taskIds = new Set(tasks.map(item => item.id)); result.outputKeys = new Set(outputs.items.map(item => item.key));
    return result;
  }
  function build(options) { return inspect(options).model; }

  function mount(container, settings = {}) {
    let options = settings, scope = null, island = null, disposed = false, lastKey = '';
    const state = () => typeof options.state === 'function' ? options.state() : options.state || {};
    const projectId = () => typeof options.projectId === 'function' ? options.projectId() : options.projectId;
    const current = context => !disposed && scope === context && container?.isConnected !== false && state() === context.state && projectId() === context.projectId;
    const data = context => inspect({ state: context.state, projectId: context.projectId, formatDate: options.formatDate, formatRelative: options.formatRelative });
    function sync(force = false) {
      if (disposed) return;
      const owner = state(), id = projectId();
      if (!scope || scope.state !== owner || scope.projectId !== id) {
        island?.unmount(); island = null; lastKey = ''; scope = { state: owner, projectId: id };
      }
      const context = scope, model = data(context).model;
      const available = () => current(context) && data(context).model.available;
      const taskIds = new Set(model.tasks.map(item => item.id)), outputKeys = new Set(model.outputs.map(item => item.key));
      async function invoke(hook, args, guard) {
        if (typeof hook !== 'function' || !guard()) return false;
        try { return await hook(...args, guard); }
        catch (error) { if (current(context)) options.toast?.(error.message || String(error)); return false; }
      }
      const props = { ...model,
        onTask: (id, anchor) => {
          const guard = () => taskIds.has(id) && current(context) && data(context).taskIds.has(id);
          return invoke(typeof options.onTask === 'function' ? (value, guard) => options.onTask(value, guard, anchor) : null, [id], guard);
        },
        onOutput: (key, anchor) => {
          const guard = () => outputKeys.has(key) && current(context) && data(context).outputKeys.has(key);
          return invoke(typeof options.onOutput === 'function' ? (value, guard) => options.onOutput(value, guard, anchor) : null, [key], guard);
        },
        onNavigate: section => sections.has(section) ? invoke(options.onNavigate, [section], available) : false,
        onAddSources: typeof options.onAddSources === 'function' ? () => invoke(options.onAddSources, [], available) : undefined,
        onAddTask: typeof options.onAddTask === 'function' ? () => invoke(options.onAddTask, [], available) : undefined,
        onStart: typeof options.onStart === 'function' ? () => invoke(options.onStart, [], available) : undefined
      };
      const key = JSON.stringify([model, english()]);
      if (!force && key === lastKey && island) return;
      lastKey = key;
      if (island) island.update(props);
      else island = (options.mount || ((host, name, value) => root.HalaskaUI.mount(host, name, value)))(container, 'ProjectOverview', props);
    }
    sync();
    return { sync, update: next => { if (disposed) return; options = { ...options, ...next }; sync(true); },
      dispose: () => { if (disposed) return; disposed = true; island?.unmount(); island = null; scope = null; } };
  }
  return { build, mount };
});
