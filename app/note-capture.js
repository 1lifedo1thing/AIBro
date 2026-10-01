/* 对话产出 → 可编辑文档：把一条回复存成笔记的纯逻辑（标题取材 + 查找 + 计划）。
   三条边界：
   1) 只读取原消息，不改写消息、不改写任何既有笔记；
   2) 只从原文取材生成标题（去 Markdown 标记后截断），不总结、不改写、不调用模型；
   3) 同一条消息只存一次（按 sourceMessageId 查重），重复点击是"打开已有文档"而不是再造一份。 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./artifact-provenance.js') : root.ArtifactProvenance);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provenance) {
  'use strict';

  const MAX_TITLE = 60;
  const WORKSPACES = ['日常', '课程', '科研'];

  // 标题：取第一条有内容的行，剥掉 Markdown 标记后截断。不做语义总结——
  // 标题就是原文的剪影，用户一眼能认出它来自哪条回复。
  function titleFromMessage(value) {
    const lines = String(value == null ? '' : value).split('\n');
    for (const raw of lines) {
      const line = String(raw)
        .replace(/^\s*#{1,6}\s*/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!line) continue;
      const chars = Array.from(line);
      return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE).join('')}…` : line;
    }
    return '';
  }

  function findMessage(state, messageId) {
    const conversations = (state && state.conversations) || [];
    for (const conversation of conversations) {
      const message = (conversation.messages || []).find(item => item && item.id === messageId);
      if (message) return { conversation, message };
    }
    return null;
  }

  function existingNote(state, messageId) {
    return ((state && state.notes) || []).find(note => note
      && note.sourceMessageId === messageId
      && !note.deletedAt
      && !note.archived) || null;
  }

  // Only explicit prose citations become navigable source relationships.
  // A delivered attachment or search hit alone is not support for this answer.
  // Keep the same code-span/fence boundary as CitationEvidence.exportText.
  function citedSources(state, messageId, evidence) {
    const found = findMessage(state, messageId);
    if (!found || found.message.role === 'user' || !evidence?.sourcesFor || !evidence?.markers || !evidence?.access) return [];
    const { message } = found;
    const runId = message.runId || message.pendingRunId || message.retryRunId;
    const runs = (state.agentRuns || []).filter(item => item?.id === runId);
    const run = runs.length === 1 && runs[0].conversationId === found.conversation.id ? runs[0] : null;
    if (!run) return [];
    const sources = evidence.sourcesFor(message, run, state), used = new Map();
    let prose = '', fence = null;
    const flush = () => {
      for (const { source } of evidence.markers(prose, sources)) {
        if (!source?.provided || sources.filter(item => item.sourceId === source.sourceId).length !== 1 || !['import', 'note'].includes(source.type) || !source.id || !evidence.access(state, source).available) continue;
        used.set(source.sourceId, source);
      }
      prose = '';
    };
    for (const line of String(message.text || '').split(/(?<=\n)/)) {
      const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) { if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null; continue; }
      if (match) { flush(); fence = match[1]; continue; }
      let start = 0, code; const pattern = /(`+)([^\n]*?)\1/g;
      while ((code = pattern.exec(line))) { prose += line.slice(start, code.index); flush(); start = code.index + code[0].length; }
      prose += line.slice(start);
    }
    flush();
    return [...used.values()];
  }

  // A failed creation may remove only its own untouched object. Conservatively
  // retain it if any other workspace record now holds its exact ID, including
  // links, result cards, source lists, wiki maps or records unknown to this module.
  function canRollbackCreation(state, note, snapshot) {
    if (!(state.notes || []).includes(note) || JSON.stringify(note) !== snapshot) return false;
    const seen = new Set();
    function references(value) {
      if (value === note) return false;
      if (value === note.id) return true;
      if (!value || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      return Object.entries(value).some(([key, item]) => key === note.id || references(item));
    }
    return !references(state);
  }

  // plan 只回答"该做什么"，不产生副作用：create / exists / empty / missing。
  // id 由调用方注入（保持本模块不依赖运行时的 uid）。
  function plan(state, messageId, options = {}) {
    const now = Number(options.now) || Date.now();
    const found = findMessage(state, messageId);
    if (!found) return { kind: 'missing' };
    const text = String(found.message.text || '');
    if (!text.trim()) return { kind: 'empty' };
    const existing = existingNote(state, messageId);
    if (existing) return { kind: 'exists', note: existing };
    const conversation = found.conversation || {};
    const sources = citedSources(state, messageId, options.citationEvidence);
    const note = {
      id: String(options.id || ''),
      kind: '对话产出',
      title: titleFromMessage(text) || `来自对话：${conversation.title || '新对话'}`,
      content: text,
      workspace: WORKSPACES.includes(conversation.workspace) ? conversation.workspace : '日常',
      projectId: conversation.projectId || null,
      sourceConversationId: conversation.id || null,
      sourceMessageId: messageId,
      sourceAttachmentIds: [...new Set(sources.filter(source => source.type === 'import').map(source => source.id))],
      createdAt: now,
      updatedAt: now,
    };
    const noteSources = [...new Set(sources.filter(source => source.type === 'note').map(source => source.id))];
    if (noteSources.length) note.sourceNoteIds = noteSources;
    const runId = found.message.runId || found.message.pendingRunId || found.message.retryRunId;
    const runs = ((state && state.agentRuns) || []).filter(run => run?.id === runId);
    if (found.message.role !== 'user' && options.citationEvidence?.documentText) {
      const run = runs.length === 1 && runs[0].conversationId === conversation.id && provenance?.capture ? runs[0] : null;
      note.content = options.citationEvidence.documentText(found.message, run, state);
      note.title = titleFromMessage(note.content) || note.title;
      if (run) note.provenance = provenance.capture(state, run, { type: 'note', id: note.id, record: note, operation: 'captured', at: now });
    }
    return { kind: 'create', note };
  }

  return { MAX_TITLE, titleFromMessage, findMessage, existingNote, citedSources, canRollbackCreation, plan };
});
