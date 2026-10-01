(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./note-editor.js') : root.NoteEditor);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DraftReview = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Editor) {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const same = (a, b) => canonical(a) === canonical(b);
  const commits = new WeakMap();
  const active = value => value && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !['archived', 'deleted'].includes(value.status);
  const hasDraft = note => active(note) && typeof note.aiDraft?.content === 'string';
  const scope = conversation => JSON.stringify([conversation.id, conversation.projectId || null, conversation.workspace || 'auto']);
  const resultIds = results => [...new Set(list(results).filter(result => result?.type === 'note' && result.id).map(result => result.id))];
  function groups(state, conversation) {
    const messages = list(conversation?.messages).filter(active);
    const rows = messages.map((message, order) => ({ ids: [...resultIds(message.results),...list(list(state.agentRuns).find(r=>r.id===message.runId)?.memoryNoteIds)], at: Number(message.at || message.createdAt) || 0, order }));
    for (const run of list(state.agentRuns)) {
      if (!active(run) || run.conversationId !== conversation?.id) continue;
      // Message results are the user-visible review boundary; avoid duplicating
      // their underlying run with a different timestamp.
      if (messages.some(message => message.runId === run.id && resultIds(message.results).length)) continue;
      rows.push({ ids: [...resultIds(run.results),...list(run.memoryNoteIds)], at: Number(run.finishedAt || run.completedAt || run.startedAt) || 0, order: rows.length });
    }
    return rows.filter(row => row.ids.length).sort((a, b) => b.at - a.at || b.order - a.order);
  }
  function inScope(state, note, conversation) {
    if (!active(note)) return false;
    if (note.projectId && !list(state.projects).some(project => project.id === note.projectId && active(project))) return false;
    if (!conversation) return true; // A direct note-reader button already identifies its note.
    if (!active(conversation)) return false;
    if (conversation.projectId && note.projectId !== conversation.projectId) return false;
    if (!conversation.projectId && conversation.workspace && conversation.workspace !== 'auto' && note.workspace !== conversation.workspace) return false;
    if (!conversation.projectId && !groups(state, conversation).some(row => row.ids.includes(note.id))) return false;
    return true;
  }
  function begin(state, noteId, conversation) {
    const note = list(state.notes).find(item => item.id === noteId);
    if (!hasDraft(note)) throw new Error('这份待处理草稿已不可用，请刷新笔记。');
    if (!inScope(state, note, conversation)) throw new Error('这份草稿不属于当前对话的项目或结果，未作修改。');
    return {
      noteId, expectedDraft: JSON.stringify(note.aiDraft), expectedNote: JSON.stringify(note),
      editorSession: Editor.begin(state, noteId),
      ...(conversation ? { conversationId: conversation.id, expectedScope: scope(conversation) } : {})
    };
  }
  function prepare(state, review, action, now = Date.now()) {
    if (!['adopt', 'discard'].includes(action)) throw new Error('未知的草稿处理操作。');
    if (!review || typeof review.expectedDraft !== 'string' || typeof review.expectedNote !== 'string') throw new Error('缺少草稿版本，请重新打开待处理草稿。');
    const note = list(state.notes).find(item => item.id === review.noteId);
    if (!hasDraft(note) || JSON.stringify(note.aiDraft) !== review.expectedDraft || JSON.stringify(note) !== review.expectedNote) throw new Error('笔记或草稿已被其他操作修改，请查看最新版本；未覆盖任何内容。');
    const conversation = review.conversationId ? list(state.conversations).find(item => item.id === review.conversationId) : null;
    if (review.conversationId && (!conversation || scope(conversation) !== review.expectedScope) || !inScope(state, note, conversation)) throw new Error('对话或项目归属已变化，请重新查看草稿。');
    const session = clone(review.editorSession);
    if (session.id !== review.noteId) throw new Error('草稿与笔记版本不匹配。');
    if (action === 'adopt') {
      session.title = note.aiDraft.title || note.title;
      session.content = note.aiDraft.content;
      session.appliedAiDraft = review.expectedDraft;
    }
    const change = Editor.prepare(state, session, now);
    const before = clone(note);
    const after = clone(action === 'adopt' ? change.after : note);
    if (action === 'adopt') {
      after.sourceAttachmentIds = [...new Set([...list(note.sourceAttachmentIds), ...list(note.aiDraft.sourceAttachmentIds)].filter(id => typeof id === 'string' && id))];
      // Retain the old body's provenance alongside its existing revision.
      if (after.revisionHistory?.length) after.revisionHistory.at(-1).sourceAttachmentIds = clone(list(note.sourceAttachmentIds));
    }
    after.aiDraftHistory = [...clone(list(note.aiDraftHistory)), { action, reviewedAt: now, draft: clone(note.aiDraft) }];
    after.updatedAt = now;
    delete after.aiDraft;
    return { changed: true, action, note, before, after };
  }
  // Only evidence about this exact proposal can settle it. Historical snapshots
  // are immutable; the current draft, decision history and body origin supply
  // its present status without interpreting matching prose as an acceptance.
  function proposalStatus(state, change, { runId, includeReview = true } = {}) {
    const labels = { pending: ['待采纳草稿', 'Draft to review'], adopted: ['已采纳', 'Adopted'], discarded: ['已放弃', 'Discarded'], superseded: ['已被新草稿替代', 'Superseded'], unavailable: ['提案不可用', 'Proposal unavailable'] };
    const result = (status, extra = {}) => ({ status, label: labels[status][/^en(?:-|$)/i.test(globalThis.WorkstationI18n?.getLanguage?.() || '') ? 1 : 0], ...extra });
    const matches = list(state?.notes).filter(note => note.id === change?.id);
    const note = matches.length === 1 ? matches[0] : null, draft = change?.after?.aiDraft;
    if (change?.type !== 'note' || change.operation !== 'drafted' || !draft || typeof draft.content !== 'string' || !active(note) || !inScope(state, note) || list(state?.trash).some(entry => list(entry?.data?.notes).some(item => item.id === change.id))) return result('unavailable');
    if (note.projectId && list(state.projects).filter(project => project.id === note.projectId).length !== 1) return result('unavailable');
    const origin = draft.provenance?.origin;
    if (runId && origin?.runId && origin.runId !== runId) return result('unavailable');
    const saving = commits.get(state)?.get(note.id);
    if (saving && same(JSON.parse(saving.review.expectedDraft), draft)) return result('pending', {
      saving: true, label: /^en(?:-|$)/i.test(globalThis.WorkstationI18n?.getLanguage?.() || '') ? 'Saving decision…' : '正在保存决定…',
      ...(includeReview ? { review: clone(saving.review) } : {})
    });
    if (hasDraft(note) && same(note.aiDraft, draft)) {
      try { return result('pending', includeReview ? { review: begin(state, note.id) } : {}); } catch (_) { return result('unavailable'); }
    }
    const decision = [...list(note.aiDraftHistory)].reverse().find(item => ['adopt', 'discard'].includes(item.action) && same(item.draft, draft));
    if (decision) return result(decision.action === 'adopt' ? 'adopted' : 'discarded', { reviewedAt: decision.reviewedAt });
    const body = note.provenance, output = body?.output;
    if (origin?.recorded === true && origin.runId && same(origin, body?.origin) && output?.type === 'note' && output.id === note.id && output.variant === 'body') return result('adopted');
    return result(hasDraft(note) ? 'superseded' : 'unavailable');
  }
  function rollback(change, currentState, written) {
    const current = list(currentState?.notes).find(note => note.id === change.note.id);
    // A removed or replaced object belongs to its newer writer, including a
    // restored object with the same ID. Never resurrect it on save failure.
    if (current !== change.note) return;
    for (const key of new Set([...Object.keys(change.before), ...Object.keys(change.after)])) {
      if (same(change.before[key], change.after[key]) && Object.hasOwn(change.before, key) === Object.hasOwn(change.after, key)) continue;
      if (Object.hasOwn(current, key) === Object.hasOwn(change.after, key) && same(current[key], change.after[key])) {
        if (Object.hasOwn(change.before, key)) current[key] = clone(change.before[key]); else delete current[key];
        continue;
      }
      // Concurrent history appends must survive, but our own decision/revision
      // must not remain as false evidence that the failed write was saved.
      if (['revisionHistory', 'aiDraftHistory'].includes(key) && Array.isArray(current[key])) {
        const prior = list(change.before[key]), applied = list(change.after[key]);
        const own = written.historyEntries[key] || [];
        if (!own.some(item => current[key].includes(item.entry) && same(item.entry, item.snapshot))) continue;
        const retained = applied.slice(0, Math.max(0, applied.length - own.length));
        const keptPrefix = same(current[key].slice(0, retained.length), retained);
        current[key] = current[key].filter(entry => !own.some(item => item.entry === entry && same(entry, item.snapshot)));
        // Editor history has a bounded prefix. Restore only entries discarded
        // by our append, before any later writer's surviving entries.
        const dropped = prior.slice(0, Math.max(0, prior.length - retained.length));
        if (keptPrefix) current[key].unshift(...clone(dropped));
        if (!current[key].length && !Object.hasOwn(change.before, key)) delete current[key];
      }
    }
  }
  function commit(state, review, action, persist, { getState = () => state } = {}) {
    if (!state || typeof state !== 'object' || typeof persist !== 'function') return Promise.reject(new Error('草稿处理缺少持久化接口。'));
    let pending = commits.get(state); if (!pending) { pending = new Map(); commits.set(state, pending); }
    const existing = pending.get(review?.noteId);
    if (existing) return existing.action === action && same(existing.review, review) ? existing.promise : Promise.reject(new Error('这篇笔记正在保存草稿决定，请稍候。'));
    let change;
    try { if (getState() !== state) throw new Error('工作区已变化，请重新打开草稿。'); change = prepare(state, review, action); }
    catch (error) { return Promise.reject(error); }
    const applied = clone(change.after), written = { historyEntries: {} };
    for (const key of ['revisionHistory', 'aiDraftHistory']) {
      const prior = list(change.before[key]), after = list(applied[key]);
      written[key] = after;
      written.historyEntries[key] = after.filter(entry => !prior.some(old => same(old, entry))).map(entry => ({ entry, snapshot: clone(entry) }));
    }
    Object.assign(change.note, applied); delete change.note.aiDraft;
    const entry = { action, review: clone(review), promise: null };
    // Start after the guard is installed so even a synchronous persistence
    // callback cannot re-enter the same note's transaction.
    entry.promise = Promise.resolve().then(async () => {
      try { if (await persist() === false) throw new Error('草稿决定尚未成功保存，请重试。'); }
      catch (error) { rollback(change, getState(), written); throw error; }
      const currentState = getState(), matches = list(currentState?.notes).filter(note => note.id === change.note.id), current = matches.length === 1 ? matches[0] : null;
      if (currentState !== state || current !== change.note || !inScope(currentState, current)) throw new Error('保存期间笔记或工作区已变化，请查看当前文件；未覆盖后续修改。');
      return { note: current, action, reviewedAt: change.after.updatedAt, changedAfterReview: !same(current, change.after) };
    }).finally(() => { if (pending.get(review.noteId) === entry) pending.delete(review.noteId); });
    pending.set(review.noteId, entry); return entry.promise;
  }
  function command(text) {
    const value = String(text || '').trim().replace(/[。.!！]+$/, '').trim().toLowerCase();
    if (/^(?:采纳|采纳草稿|采纳这份草稿|接受草稿|accept(?: (?:the )?draft)?|adopt(?: (?:the )?draft)?)$/.test(value)) return 'adopt';
    if (/^(?:放弃|放弃草稿|放弃这份草稿|不采纳|丢弃草稿|discard(?: (?:the )?draft)?|reject(?: (?:the )?draft)?)$/.test(value)) return 'discard';
    return null;
  }
  function resolve(state, conversation, text) {
    const action = command(text);
    if (!action) return { status: 'unhandled', action: null, candidateIds: [] };
    if (!active(conversation)) return { status: 'missing', action, candidateIds: [] };
    for (const row of groups(state, conversation)) {
      const candidates = row.ids.filter(id => {
        const note = list(state.notes).find(item => item.id === id);
        return hasDraft(note) && inScope(state, note, conversation);
      });
      if (!candidates.length) continue;
      if (candidates.length > 1) return { status: 'ambiguous', action, candidateIds: candidates };
      return { status: 'resolved', action, candidateIds: candidates, review: begin(state, candidates[0], conversation) };
    }
    return { status: 'missing', action, candidateIds: [] };
  }
  return { begin, prepare, commit, proposalStatus, resolve, command };
}));
