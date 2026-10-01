/* Project schedule owns one stable Kit island per host. Calendar navigation is
   read-only; the legacy project.plan draft is separate from project memory. */
(function (root, factory) {
  const common = typeof module === 'object' && module.exports;
  const api = factory(root, common ? require('./citation-evidence.js') : null);
  if (common) module.exports = api; else root.ProjectSchedule = api;
})(globalThis, (root, evidence) => {
  'use strict';
  const text = value => typeof value === 'string' ? value : '';
  const list = value => Array.isArray(value) ? value : [];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const T = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  const active = value => !!text(value?.id) && !value.deleted && !value.deletedAt && !value.archived && !value.archivedAt && !value.hidden && !value.hiddenAt && !value.tombstone && !value.wikiFileError && !['deleted', 'archived', 'hidden'].includes(value.status);
  const missingDate = value => value === null || value === undefined || value === '';

  function timestamp(value) {
    if (missingDate(value) || !['number', 'string'].includes(typeof value)) return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number), date = new Date(0);
      date.setFullYear(year, month - 1, day); date.setHours(0, 0, 0, 0);
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
    }
    if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T/.test(value) && !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && timestamp(value.slice(0, 10)) === null) return null;
    const at = new Date(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value).getTime();
    return Number.isFinite(at) ? at : null;
  }
  function startOfDay(value) { const at = timestamp(value); if (at === null) return null; const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); }
  function addLocalDays(value, amount) { const at = startOfDay(value); if (at === null) return null; const date = new Date(at); date.setDate(date.getDate() + amount); return date.getTime(); }
  function startOfWeek(value) { const day = startOfDay(value); return day === null ? null : addLocalDays(day, -(new Date(day).getDay() + 6) % 7); }
  function daysOfWeek(value, today = Date.now()) {
    const start = startOfWeek(value); if (start === null) return [];
    return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, index) => {
      const ts = addLocalDays(start, index), date = new Date(ts);
      return { ts, label: T(label, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index]), day: date.getDate(), month: date.getMonth() + 1, isToday: ts === startOfDay(today) };
    });
  }
  function formatRange(value) {
    const days = daysOfWeek(value); if (!days.length) return '';
    const first = days[0], last = days[6];
    return T(first.month === last.month ? `${first.month} 月 ${first.day} 日 – ${last.day} 日` : `${first.month} 月 ${first.day} 日 – ${last.month} 月 ${last.day} 日`,
      `${new Date(first.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(last.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
  }
  function bucketTasks(tasks, days) {
    const byDay = days.map(() => []), unscheduled = [], invalid = [];
    for (const task of list(tasks)) {
      if (!task) continue;
      if (missingDate(task.dueAt)) { unscheduled.push(task); continue; }
      const day = startOfDay(task.dueAt); if (day === null) { invalid.push(task); continue; }
      const index = days.findIndex(value => value.ts === day); if (index !== -1) byDay[index].push(task);
    }
    for (const items of byDay) items.sort((a, b) => timestamp(a.dueAt) - timestamp(b.dueAt) || text(a.title).localeCompare(text(b.title)));
    for (const items of [unscheduled, invalid]) items.sort((a, b) => text(a.title).localeCompare(text(b.title)));
    return { byDay, unscheduled, invalid };
  }
  function tasksInWeek(tasks, days) {
    if (days.length !== 7) return [];
    const end = addLocalDays(days[6].ts, 1);
    return list(tasks).filter(task => { const at = timestamp(task?.dueAt); return at !== null && at >= days[0].ts && at < end; });
  }
  function taskTone(task) { return ({ todo: 'todo', in_progress: 'progress', done: 'done', blocked: 'blocked' })[Object.hasOwn({ todo: 1, in_progress: 1, done: 1, blocked: 1 }, task?.status) ? task.status : 'todo']; }
  function statusLabel(task) { return ({ todo: T('待开始', 'To do'), progress: T('进行中', 'In progress'), done: T('已完成', 'Done'), blocked: T('受阻', 'Blocked') })[taskTone(task)]; }
  function dueLabel(task) {
    const at = timestamp(task?.dueAt); if (at === null) return '';
    const date = new Date(at), hours = date.getHours(), minutes = date.getMinutes();
    return !hours && !minutes ? '' : `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  function inspect(state, projectId) {
    const result = { project: null, tasks: [] }, access = (evidence || root.CitationEvidence)?.createAccessContext?.(state);
    if (!access || !text(projectId)) return result;
    const readable = (type, item) => {
      if (!active(item)) return false;
      const ref = type === 'project' ? { type: 'local', projectId: item.id, candidateId: item.localFolder?.id } : { type, id: item.id };
      return access.access(ref).kind === 'available' && !access.isAmbiguous(ref);
    };
    const project = list(state.projects).find(value => value?.id === projectId);
    if (!readable('project', project)) return result;
    result.project = project;
    result.tasks = list(state.tasks).filter(task => task?.projectId === projectId && readable('task', task));
    return result;
  }
  function preview(textValue, id) {
    // Only the established escaped document renderer is trusted here. The old
    // arbitrary hooks.markdown HTML callback is deliberately not used.
    try { if (typeof root.DocumentMarkdown?.render === 'function') return root.DocumentMarkdown.render(textValue, { idPrefix: `schedule-${id}` }); } catch (_) {}
    return `<pre>${esc(textValue)}</pre>`;
  }
  function planMarkup(project) { return `<details class="project-plan-panel"><summary>${esc(T('项目计划', 'Project plan'))} · ${esc(project?.plan ? 'Markdown' : T('尚未填写', 'Empty'))}</summary><textarea>${esc(project?.plan)}</textarea></details>`; }

  let hooks = {};
  const controllers = new WeakMap(), drafts = new WeakMap(), dirtySessions = new Set(), pending = new Set();
  function recordsFor(state) { let records = drafts.get(state); if (!records) drafts.set(state, records = new WeakMap()); return records; }
  function reconcileDrafts(state) {
    for (const session of new Set([...dirtySessions, ...pending])) {
      const project = inspect(state, session.project.id).project;
      // Inaccessible owners never expose a recovery body or permanently block
      // quit. A same-object draft can still be recovered if access is restored.
      if (!project || session.project.createdAt && project.createdAt && String(session.project.createdAt) !== String(project.createdAt)) { dirtySessions.delete(session); continue; }
      if (session.state === state && session.project === project) continue;
      const records = recordsFor(state), existing = records.get(project);
      if (existing && existing !== session && existing.value !== existing.base) { dirtySessions.delete(session); continue; }
      // Snapshot adoption keeps the local base, so changed remote text becomes
      // an explicit conflict. Pending saves retain their original CAS owner.
      records.set(project, session); session.state = state; session.project = project;
      session.composing = false; session.saved = false;
    }
  }
  function sessionFor(state, project) {
    const records = recordsFor(state);
    let session = records.get(project);
    if (!session) { session = { state, project, value: text(project.plan), base: text(project.plan), open: false, preview: false, composing: false, saving: false, error: '', saved: false, cursor: Date.now() }; records.set(project, session); }
    return session;
  }
  function markDirty(session) { if (session.value !== session.base) dirtySessions.add(session); else dirtySessions.delete(session); }
  function isDirty() { reconcileDrafts(hooks.getState?.() || {}); return dirtySessions.size > 0; }
  function isBusy() { return pending.size > 0; }
  function getDraftSummary() { isDirty(); return { count: dirtySessions.size, saving: pending.size }; }

  function mount(container, projectId) {
    if (!container) return null;
    let controller = controllers.get(container);
    if (!controller) {
      let island = null, owner = null, epoch = 0, disposed = false;
      controller = { sync, dispose, projectId };
      controllers.set(container, controller);
      function current(captured, generation) {
        if (disposed || container.isConnected === false || epoch !== generation || owner !== captured || hooks.getState?.() !== captured.state) return null;
        const found = inspect(captured.state, controller.projectId);
        return found.project === captured.project ? found : null;
      }
      function sync() {
        if (disposed) return;
        if (container.isConnected === false) { dispose(); return; }
        const state = hooks.getState?.() || {};
        reconcileDrafts(state);
        const found = inspect(state, controller.projectId), project = found.project;
        if (!owner || owner.state !== state || owner.project !== project || owner.projectId !== controller.projectId) {
          if (owner?.session) owner.session.composing = false;
          island?.unmount(); island = null; epoch += 1;
          owner = { state, project, projectId: controller.projectId, session: project ? sessionFor(state, project) : null };
        }
        const captured = owner, generation = epoch, session = owner.session;
        const valid = () => current(captured, generation);
        let props = { available: false };
        if (project && session) {
          if (!session.saving && session.value === session.base && text(project.plan) !== session.base) { session.base = text(project.plan); session.value = session.base; session.saved = false; }
          markDirty(session);
          const days = daysOfWeek(session.cursor), buckets = bucketTasks(found.tasks, days), week = tasksInWeek(found.tasks, days);
          const modelTask = task => ({ id: task.id, title: text(task.title) || T('未命名任务', 'Untitled task'), status: taskTone(task), statusLabel: statusLabel(task), time: dueLabel(task), invalidDate: timestamp(task.dueAt) === null && !missingDate(task.dueAt) ? String(task.dueAt) : '' });
          const savedPlan = text(project.plan), conflict = !session.saving && session.value !== session.base && savedPlan !== session.base;
          const change = value => { if (!valid() || session.saving || typeof value !== 'string') return; session.value = value; session.saved = false; session.error = ''; markDirty(session); sync(); };
          props = {
            available: true, range: formatRange(session.cursor), currentWeek: startOfWeek(session.cursor) === startOfWeek(Date.now()),
            weekCount: week.length, openCount: week.filter(task => task.status !== 'done').length,
            days: days.map((day, index) => ({ ...day, tasks: buckets.byDay[index].map(modelTask) })),
            unscheduled: buckets.unscheduled.map(modelTask), invalid: buckets.invalid.map(modelTask),
            onWeek: delta => { if (!valid() || ![-1, 0, 1].includes(delta)) return; session.cursor = delta ? addLocalDays(startOfWeek(session.cursor), delta * 7) : Date.now(); sync(); },
            onTask: (id, anchor) => {
              const initial = valid()?.tasks.find(task => task.id === id); if (!initial) return false;
              const canOpen = () => valid()?.tasks.find(task => task.id === id) === initial;
              return hooks.openTask?.(id, { anchor, canOpen });
            },
            plan: { value: session.value, open: session.open, preview: session.preview, dirty: session.value !== session.base, busy: session.saving,
              composing: session.composing, error: session.error, saved: session.saved, conflict, savedVersion: conflict ? savedPlan : '',
              previewHTML: session.preview ? preview(session.value, project.id) : '' },
            onPlanChange: change,
            onPlanComposition: composing => { if (!valid() || session.saving) return; session.composing = !!composing; sync(); },
            onPlanToggle: open => { if (!valid()) return; session.open = !!open; sync(); },
            onPlanPreview: () => { if (!valid() || session.composing) return; session.preview = !session.preview; sync(); },
            onPlanResolve: choice => {
              if (!valid() || session.saving || session.composing || text(project.plan) !== savedPlan || session.value === session.base || !['saved', 'draft'].includes(choice) || choice === 'draft' && !conflict) return false;
              session.base = savedPlan; if (choice === 'saved') session.value = savedPlan;
              session.error = ''; session.saved = false; markDirty(session); sync(); return true;
            },
            onPlanSave: async () => {
              if (!valid() || session.saving || session.composing || session.value === session.base) return false;
              if (text(project.plan) !== session.base) { session.error = T('已保存版本发生变化。请比较后选择要继续编辑的版本。', 'The saved version changed. Compare versions before continuing.'); sync(); return false; }
              if (typeof hooks.persist !== 'function') { session.error = T('保存服务尚未就绪，草稿已保留。', 'Saving is unavailable. Your draft is retained.'); sync(); return false; }
              const submitted = session.value, before = { plan: project.plan, updatedAt: project.updatedAt, hadPlan: Object.hasOwn(project, 'plan'), hadUpdated: Object.hasOwn(project, 'updatedAt') }, writtenAt = Date.now();
              session.saving = true; session.saved = false; session.error = ''; pending.add(session);
              project.plan = submitted; project.updatedAt = writtenAt; sync();
              const stillOwned = () => hooks.getState?.() === state && inspect(state, project.id).project === project;
              const stillWritten = () => project.plan === submitted && project.updatedAt === writtenAt;
              try {
                if (await hooks.persist() === false) throw Error(T('数据库未确认保存，草稿已保留。', 'The database did not confirm this save. Your draft is retained.'));
                if (!stillOwned() || !stillWritten()) throw Error(T('保存期间项目或计划发生变化，草稿已保留。', 'The project or plan changed while saving. Your draft is retained.'));
                session.base = submitted; session.saved = true; markDirty(session); return true;
              } catch (error) {
                if (stillOwned() && stillWritten()) {
                  if (before.hadPlan) project.plan = before.plan; else delete project.plan;
                  if (before.hadUpdated) project.updatedAt = before.updatedAt; else delete project.updatedAt;
                }
                session.error = error?.message || T('保存失败，草稿已保留。', 'Save failed. Your draft is retained.'); markDirty(session); return false;
              } finally { session.saving = false; pending.delete(session); sync(); }
            }
          };
        }
        if (island) island.update(props);
        else { const mountKit = hooks.mount || root.HalaskaUI?.mount; if (mountKit) island = mountKit(container, 'ProjectScheduleSurface', props); }
      }
      function dispose() { if (disposed) return; disposed = true; epoch += 1; if (owner?.session) owner.session.composing = false; island?.unmount(); island = null; controllers.delete(container); }
    }
    controller.projectId = projectId; controller.sync(); return controller;
  }
  function unmount(container) { controllers.get(container)?.dispose(); }
  function init(options = {}) { hooks = options; return { mount, render: mount, unmount, isDirty, isBusy, getDraftSummary }; }
  return { init, mount, render: mount, unmount, isDirty, isBusy, getDraftSummary,
    _pure: { timestamp, startOfDay, addLocalDays, startOfWeek, daysOfWeek, formatRange, bucketTasks, tasksInWeek, taskTone, statusLabel, dueLabel, planMarkup, inspect, preview } };
});
