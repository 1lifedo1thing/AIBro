/* Portable origin metadata with bounded scalar fields for durable artifacts. No requests, file
 * reads or inference: an associated source is never proof it was supplied. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ArtifactProvenance = api;
})(globalThis, function () {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const collections = { note: 'notes', paper: 'papers', task: 'tasks', import: 'imports' };
  const LIMITS = Object.freeze({ title: 240, history: 20 });
  const clean = (value, limit = 200) => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) ? value.slice(0, limit) : '';
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const active = value => !!value && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !value.tombstone && !value.hidden && !value.hiddenAt && !value.wikiFileError && !['archived', 'deleted', 'hidden'].includes(value.status);
  const privateItem = value => !!(value?.private || value?.ephemeral || value?.incognito);
  const matches = (state, collection, id) => id ? list(state[collection]).filter(item => item?.id === id) : [];
  const unique = (state, collection, id) => { const found = matches(state, collection, id); return found.length === 1 ? found[0] : null; };
  const trashed = (state, collection, id) => !!id && list(state.trash).some(row => list(row?.data?.[collection]).some(item => item?.id === id));
  const privacyMatches = (state, collection, id) => !id ? [] : [...matches(state, collection, id), ...list(state.trash).flatMap(bundle => [
    ...list(bundle?.data?.[collection]).filter(item => item?.id === id),
    ...(collection === 'agentRuns' ? list(bundle?.data?.runs).filter(item => item?.id === id) : [])
  ])];
  function privateAncestry(state, ...values) {
    const queue = values.slice(), seen = new Set();
    while (queue.length) {
      const value = queue.shift(); if (!value || seen.has(value)) continue; seen.add(value);
      if (privateItem(value)) return true;
      if (value.provenance?.origin) queue.push(value.provenance.origin);
      for (const [key, ids] of [['projects', [value.projectId]], ['agentRuns', [value.agentRunId, value.runId]], ['conversations', [value.sourceConversationId, value.conversationId]]]) {
        for (const id of ids) queue.push(...privacyMatches(state, key, id));
      }
    }
    return false;
  }
  function access(state, ref) {
    const type = ref?.type, collection = type === 'local' ? 'projects' : collections[type];
    if (!collection) return { available: false, reason: '不支持的来源类型', private: false };
    const found = matches(state, collection, type === 'local' ? ref.projectId : ref.id), record = found.length === 1 ? found[0] : null;
    if (privateAncestry(state, ref, ...privacyMatches(state, collection, type === 'local' ? ref.projectId : ref.id))) return { available: false, reason: '私密内容不可从此处打开', private: true };
    const projectId = type === 'local' ? record?.id : record?.projectId;
    const parent = projectId ? unique(state, 'projects', projectId) : null;
    if (!active(record) || trashed(state, collection, record?.id) || projectId && (!active(parent) || trashed(state, 'projects', projectId)) || type === 'local' && record.localFolder?.id !== ref.candidateId)
      return { available: false, reason: '来源已删除、归档、隐藏或不再可用', private: false };
    return { available: true, record, reason: '', private: false };
  }
  // Same request-body fingerprint used by CitationEvidence; not a security hash.
  function hash(value) { let h = 2166136261; for (const c of String(value)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  // SQLite/cloud JSON serializers may reorder object keys without editing data.
  function stableJSON(value) { return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
  function body(record, type, variant = 'current') {
    if (variant === 'draft') return typeof record?.aiDraft?.content === 'string' ? record.aiDraft.content : null;
    if (!record) return '';
    if (type === 'paper') return stableJSON({ sections: record.structured || record.sections || {}, edits: record.userEdits || {}, content: record.content || record.summary || '' });
    return list(record.pages).length ? record.pages.map(page => `[page ${page.page || page.pageNumber || '?'}]\n${page.text || page.content || ''}`).join('\n') : String(record.content || record.text || record.extractedText || record.summary || '');
  }
  function outputStamp(type, record, variant = 'body') {
    const value = variant === 'draft' ? record.aiDraft : record;
    if (!value) return null;
    const payload = type === 'task' ? [value.title, value.description, value.status, value.priority, value.startAt, value.dueAt, value.reminderMinutes, value.checklist, value.dependsOn]
      : [value.title, type === 'paper' ? body(value, type) : String(value.content || '')];
    return 'artifact-v1-' + hash(stableJSON(payload));
  }
  function inputKey(input) { return JSON.stringify([input.type, input.id, input.refKey, input.page, input.offset, input.end, input.variant, input.version, input.bodyHash, input.bodyFormat, input.sourceId]); }
  function suppliedInput(value) {
    if (!value || value.provided !== true || !Object.hasOwn(collections, value.type) && value.type !== 'local') return null;
    const id = clean(value.id); if (!id && value.type !== 'local') return null;
    const input = { type: value.type, id: id || null, title: clean(value.title, LIMITS.title), sourceId: clean(value.sourceId) || null,
      projectId: clean(value.projectId) || null, variant: value.variant === 'draft' ? 'draft' : 'current', provided: true,
      page: integer(value.page) > 0 ? value.page : null, offset: integer(value.offset), end: integer(value.end),
      version: clean(value.version, 300) || null, capturedAt: integer(value.capturedAt), origin: clean(value.origin, 80),
      media: ['page_image', 'original_file', 'original_image'].includes(value.media) ? value.media : null };
    if (value.type === 'local') Object.assign(input, { candidateId: clean(value.candidateId) || null, refKey: clean(value.refKey, 700) || null, path: clean(value.path, 500) || null });
    if (value.bodyFormat === 'canonical-v1') input.bodyFormat = value.bodyFormat;
    // The receipt keeps page identity even when the immutable excerpt budget
    // was exhausted. Never copy the request body or infer a retained excerpt.
    if (['retained', 'omitted'].includes(value.excerptState)) input.excerptState = value.excerptState;
    if (integer(value.excerptCharacters) !== null) input.excerptCharacters = value.excerptCharacters;
    if (value.textRepresentation === 'normalized-page') input.textRepresentation = value.textRepresentation;
    // A legacy draft's bodyHash described the approved body, not its draft.
    if (clean(value.bodyHash, 80) && (input.variant !== 'draft' || value.bodyVariant === 'draft')) {
      input.bodyHash = clean(value.bodyHash, 80); input.bodyVariant = input.variant;
    }
    if (privateItem(value)) input.private = true;
    return input;
  }
  function capture(state, run, { type, id, record, variant = 'body', operation = 'created', at } = {}) {
    if (!['note', 'paper', 'task'].includes(type) || !clean(run?.id) || !record || record.id !== id) return null;
    const inputs = [], seen = new Set();
    // This compact index must cover every supplied source, independently of
    // the text budget and the inspector's presentation page size.
    const add = value => { if (!value) return; const key = inputKey(value); if (seen.has(key)) return; seen.add(key); inputs.push(value); };
    for (const value of list(run.evidenceSources)) add(suppliedInput(value));
    // A selected reference is only a saved read when FileContext prepared it.
    // No current source body or global attachmentSnapshots is sampled here.
    for (const ref of list(run.fileReferences)) {
      if (!integer(ref?.readAt) || !['note', 'local'].includes(ref.type)) continue;
      if (inputs.some(input => input.type === ref.type && (ref.type === 'local' ? input.candidateId === ref.candidateId && input.path === ref.path : input.id === ref.id))) continue;
      add(suppliedInput({ ...ref, provided: true, capturedAt: ref.readAt, origin: 'explicit_reference', variant: 'current' }));
    }
    const config = run.modelConfig || {};
    return { version: 1, output: { type, id, variant }, operation: ['created', 'updated', 'drafted', 'captured'].includes(operation) ? operation : 'updated',
      outputStamp: outputStamp(type, record, variant),
      origin: { recorded: true, runId: clean(run.id), conversationId: clean(run.conversationId) || null,
        userMessageId: clean(run.userMessageId) || null, at: integer(at) ?? integer(run.finishedAt) ?? integer(run.startedAt),
        model: clean(config.model, 160) || null, provider: clean(config.provider, 80) || null, effort: clean(config.effort, 40) || null,
        ...(privateAncestry(state, run) ? { private: true } : {}) },
      inputs, omittedInputs: 0, evidenceLimitReached: run.evidenceLimitReached === true,
      evidenceExcerptLimitReached: run.evidenceExcerptLimitReached === true };
  }
  function attach(state, run, ref) {
    const saved = capture(state, run, ref); if (!saved) return false;
    const target = ref.variant === 'draft' ? ref.record.aiDraft : ref.record;
    if (!target) return false;
    target.provenance = saved;
    return true;
  }
  function originView(state, saved, recorded) {
    const runId = clean(saved?.runId) || null, conversationId = clean(saved?.conversationId) || null;
    const run = unique(state, 'agentRuns', runId), conversation = unique(state, 'conversations', conversationId);
    const originPrivate = privateAncestry(state, saved, ...matches(state, 'agentRuns', runId), ...matches(state, 'conversations', conversationId));
    const parent = conversation?.projectId ? unique(state, 'projects', conversation.projectId) : null;
    const conversationAvailable = !originPrivate && active(conversation) && !trashed(state, 'conversations', conversationId) && (!conversation.projectId || active(parent) && !trashed(state, 'projects', parent.id));
    const runParent = run?.projectId ? unique(state, 'projects', run.projectId) : null;
    return { recorded: !!recorded, runId, conversationId, userMessageId: clean(saved?.userMessageId) || null,
      at: integer(saved?.at), model: originPrivate ? null : clean(saved?.model, 160) || null,
      provider: originPrivate ? null : clean(saved?.provider, 80) || null, effort: originPrivate ? null : clean(saved?.effort, 40) || null,
      runAvailable: !originPrivate && active(run) && conversationAvailable && run.conversationId === conversationId && !trashed(state, 'runs', runId) && !trashed(state, 'agentRuns', runId) && (!run.projectId || active(runParent) && !trashed(state, 'projects', runParent.id)), conversationAvailable };
  }
  function projectInput(state, raw, index, bodyHashes = new Map()) {
    const ref = { type: raw.type, id: clean(raw.id) || null, projectId: clean(raw.projectId) || null, candidateId: clean(raw.candidateId) || null, private: !!raw.private };
    const found = access(state, ref), key = `source-${index}-${hash(inputKey(raw))}`;
    const base = { key, type: ref.type, id: ref.id, title: found.available ? clean(raw.title, LIMITS.title) || clean(found.record.title || found.record.name || found.record.originalName, LIMITS.title) || '来源' : found.private ? '私密来源' : '来源不可用',
      available: found.available, status: 'unavailable', detail: found.reason, page: found.available ? integer(raw.page) : null,
      pages: found.available && integer(raw.page) > 0 ? [raw.page] : [], offset: found.available ? integer(raw.offset) : null, end: found.available ? integer(raw.end) : null,
      variant: raw.variant === 'draft' ? 'draft' : 'current', provided: raw.provided === true };
    if (!found.available) return base;
    if (['retained', 'omitted'].includes(raw.excerptState)) base.excerptState = raw.excerptState;
    if (integer(raw.excerptCharacters) !== null) base.excerptCharacters = raw.excerptCharacters;
    if (raw.textRepresentation === 'normalized-page') base.textRepresentation = raw.textRepresentation;
    if (ref.type === 'local') return { ...base, available: false, projectId: ref.projectId, candidateId: ref.candidateId, path: clean(raw.path, 500), version: clean(raw.version, 300) || null,
      status: 'unrecorded', detail: raw.excerptState === 'omitted' ? '保留了本轮提供的文件身份和位置，未留存当时的正文摘录；这不代表结论已经核验。本入口暂不支持打开本机文件。' : raw.version ? '保留了本轮读取的文件版本，尚未重新核对；本入口暂不支持打开本机文件。' : '记录了本机文件引用，未留存可核对版本；本入口暂不支持打开本机文件。' };
    if (raw.excerptState === 'omitted') return { ...base, status: 'unretained', detail: '本轮已提供此来源，页码和位置记录仍保留；正文超过摘录保存预算，未留存当时片段。打开显示当前来源，不能还原或核对旧摘录；来源身份不代表结论已经核验。' };
    if (raw.provided && raw.bodyHash && (base.variant !== 'draft' || raw.bodyVariant === 'draft') && (ref.type !== 'paper' || raw.bodyFormat === 'canonical-v1')) {
      const cacheKey = JSON.stringify([ref.type, ref.id, base.variant]);
      if (!bodyHashes.has(cacheKey)) { const current = body(found.record, ref.type, base.variant); bodyHashes.set(cacheKey, current === null ? null : hash(current)); }
      if (bodyHashes.get(cacheKey) === null || bodyHashes.get(cacheKey) !== raw.bodyHash) return { ...base, status: 'changed', detail: base.variant === 'draft' ? '当时读取的草稿已变化或不再存在；打开显示当前笔记。' : '来源正文已变化；该产出依据的是当时读取的版本。' };
      if (!raw.media) return { ...base, status: 'current', detail: base.variant === 'draft' ? '当前草稿与当时读取的草稿版本一致；草稿尚未代表已采纳内容。' : '当前来源正文与读取时记录的指纹一致；这不代表结论已经核验。' };
    }
    return { ...base, status: 'unrecorded', detail: raw.media ? '本轮提供了原件或页面图像；未留存可核对原文件字节的版本。' : ref.type === 'paper' && raw.bodyHash && raw.bodyFormat !== 'canonical-v1' ? '记录了本轮提供的论文；旧版指纹受存储键序影响，无法可靠判断内容是否变化。' : raw.provided ? '记录了本轮提供的来源；没有可与当前内容比较的完整版本。' : '仅为现有关联，未留存当时实际读取的版本。' };
  }
  function legacyOrigin(state, record, type, variant) {
    const candidates = list(state.agentRuns).filter(run => active(run) && list(run.results).some(result => result?.type === type && result.id === record.id && (variant === 'draft' ? result.operation === 'drafted' : ['created', 'updated'].includes(result.operation))));
    const direct = unique(state, 'agentRuns', record.agentRunId);
    const run = direct && candidates.includes(direct) ? direct : candidates.length === 1 ? candidates[0] : null;
    return { recorded: false, runId: run?.id || null, conversationId: run?.conversationId || clean(record.sourceConversationId) || null,
      userMessageId: run?.userMessageId || clean(record.sourceMessageId) || null, at: run?.finishedAt || run?.startedAt || null,
      model: run?.modelConfig?.model, provider: run?.modelConfig?.provider, effort: run?.modelConfig?.effort };
  }
  function project(state = {}, ref = {}, { variant = 'body' } = {}) {
    variant = variant === 'draft' ? 'draft' : 'body';
    const found = access(state, ref);
    const blank = { available: false, reason: found.reason, title: found.private ? '私密成果' : '成果不可用', variant, hasDraft: false,
      recordKind: 'unrecorded', bodyChanged: false, operation: null, origin: originView(state, null, false), inputs: [], related: [], omittedInputs: 0 };
    if (!['note', 'paper', 'task'].includes(ref.type) || !found.available) return blank;
    const record = found.record, target = variant === 'draft' ? record.aiDraft : record;
    if (!target) return { ...blank, reason: '待审阅草稿已不存在' };
    const candidate = target.provenance;
    const saved = candidate?.version === 1 && candidate.origin?.recorded === true && candidate.output?.type === ref.type && candidate.output.id === ref.id && candidate.output.variant === variant ? candidate : null;
    if (saved && privateAncestry(state, saved.origin)) return { ...blank, reason: '生成来源已设为私密', title: '私密成果' };
    const origin = originView(state, saved?.origin || legacyOrigin(state, record, ref.type, variant), !!saved);
    const bodyHashes = new Map();
    const inputs = list(saved?.inputs).filter(row => row && typeof row === 'object' && (Object.hasOwn(collections, row.type) || row.type === 'local')).map((row, index) => projectInput(state, row, index, bodyHashes));
    const related = [], seen = new Set(inputs.map(row => `${row.type}:${row.id}`));
    for (const [type, ids] of [['import', target.sourceAttachmentIds || record.sourceAttachmentIds], ['note', target.sourceNoteIds || record.sourceNoteIds]]) {
      for (const id of list(ids)) {
        if (typeof id !== 'string' || seen.has(`${type}:${id}`)) continue; seen.add(`${type}:${id}`);
        related.push(projectInput(state, { type, id, provided: false }, related.length + inputs.length, bodyHashes));
      }
    }
    return { available: true, reason: '', title: clean(target.title || record.title, LIMITS.title), variant, hasDraft: typeof record.aiDraft?.content === 'string',
      recordKind: saved ? 'recorded' : origin.runId || origin.conversationId ? 'legacy-linked' : 'unrecorded',
      bodyChanged: !!saved?.outputStamp && saved.outputStamp !== outputStamp(ref.type, record, variant),
      operation: saved?.operation || null, origin, inputs, related, omittedInputs: integer(saved?.omittedInputs) || 0,
      evidenceLimitReached: saved?.evidenceLimitReached === true,
      evidenceExcerptLimitReached: saved?.evidenceExcerptLimitReached === true };
  }
  return { capture, attach, project, access, outputStamp, LIMITS };
});
