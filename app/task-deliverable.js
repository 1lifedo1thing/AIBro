(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskDeliverable = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 任务产出校验：任务可以声明"完成之前应当存在什么"，在它被标记为完成时**机械地**核对。
  //
  // 三条不变量：
  //   1) 没声明产出的任务**完全不受影响**（默认行为与改动前一致）——不能因为加了校验就让既有任务完不成；
  //   2) 校验只做存在性与关键词包含，不做语义判断（不猜"这算不算完成"）；
  //   3) 不通过时**不假装完成**：任务保留未完成并说明缺什么，是否强行完成由人决定。
  const KINDS = ['note', 'task', 'text'];

  function normalize(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = KINDS.includes(value.kind) ? value.kind : null;
    if (!kind) return null;
    if (kind === 'text') {
      const mustInclude = String(value.mustInclude || '').trim();
      return mustInclude ? { kind, mustInclude } : null;
    }
    const ref = String(value.ref || '').trim();
    return ref ? { kind, ref } : null;
  }

  const KIND_LABELS = { note: '一条笔记', task: '另一个任务', text: '内容中的关键词' };

  function describe(value) {
    const item = normalize(value);
    if (!item) return '';
    if (item.kind === 'text') return `内容需包含「${item.mustInclude}」`;
    return `需存在${KIND_LABELS[item.kind]}（${item.ref}）`;
  }

  function visible(entry) {
    return entry && !entry.archived && !entry.deletedAt;
  }

  // 返回 { ok, reason }；未声明产出时恒为 ok（不改变既有任务的行为）。
  function validate(task, { notes = [], tasks = [], projectId = null } = {}) {
    const item = normalize(task && task.deliverable);
    if (!item) return { ok: true, reason: '' };
    if (item.kind === 'text') {
      const haystack = [task.title, task.description, task.result, task.summary].filter(Boolean).join('\n');
      return haystack.includes(item.mustInclude)
        ? { ok: true, reason: '' }
        : { ok: false, reason: `内容里还没有「${item.mustInclude}」` };
    }
    const pool = item.kind === 'note' ? notes : tasks;
    const target = pool.find(entry => entry && entry.id === item.ref && visible(entry));
    if (!target) return { ok: false, reason: `找不到${KIND_LABELS[item.kind]}（可能已删除或尚未创建）` };
    if (item.kind === 'task' && target.status !== 'done') return { ok: false, reason: `关联的任务「${target.title || ''}」还没有完成` };
    // 归属：任务在项目里时，产出也应在同一个项目——跨项目引用会让人找不到东西。
    const owner = projectId || null;
    if (owner && (target.projectId || null) !== owner) return { ok: false, reason: `${KIND_LABELS[item.kind]}不属于本项目` };
    return { ok: true, reason: '' };
  }

  function message(task, result) {
    if (!result || result.ok) return '';
    return `产出校验未通过：${result.reason}。任务保持未完成——如确认产出已在别处完成，可在任务详情中清空产出要求后再标记完成。`;
  }

  return Object.freeze({ KINDS, KIND_LABELS, normalize, describe, validate, message });
}));
