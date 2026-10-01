/* Answer-level feedback. No provider request, telemetry, or browser storage. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AnswerFeedback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  const REASONS = ['accuracy', 'incomplete', 'relevance', 'clarity', 'instruction', 'other'];
  const MAX_TEXT = 4000;
  const COMPLETED = ['completed', 'completed-local', 'completed-local-fallback', 'done'];
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const t = (zh, en) => /^en(?:-|$)/i.test(root.document?.documentElement.lang || '') ? en : zh;
  const fault = (code, zh, en) => Object.assign(new Error(t(zh, en)), { code });
  const keyOf = (cid, mid) => JSON.stringify([cid, mid]);
  const privateConversation = c => !!(c?.ephemeral || c?.incognito || c?.private);
  const active = c => !!c && !c.archived && !c.archivedAt && !c.deleted && !c.deletedAt && !['archived', 'deleted'].includes(c.status);
  function eligible(conversation, message, run) {
    return active(conversation) && !!message?.id && ['agent', 'assistant'].includes(message.role) && !!String(message.text || '').trim() && !message.live && !message.deleted && !message.deletedAt && !message.retryRunId && (!(message.status || message.runStatus) || COMPLETED.includes(message.status || message.runStatus)) && (!message.pendingRunId || !!run) && (!run || COMPLETED.includes(run.status));
  }
  function normalize(value) {
    if (value == null) return null;
    if (!['helpful', 'unhelpful'].includes(value.rating)) throw fault('FEEDBACK_RATING', '请选择有帮助或需改进。', 'Choose helpful or needs improvement.');
    if (value.reason && !REASONS.includes(value.reason)) throw fault('FEEDBACK_REASON', '请选择有效的问题类型。', 'Choose a valid issue type.');
    const comment = String(value.comment || '').trim(), correction = String(value.correction || '').trim();
    if (comment.length > MAX_TEXT || correction.length > MAX_TEXT) throw fault('FEEDBACK_LONG', '说明和修正分别最多 4000 个字符。', 'Comments and corrections can each contain up to 4,000 characters.');
    return { version: 1, rating: value.rating, reason: value.reason || '', comment, correction };
  }
  function suggestion(message, feedback) {
    if (feedback?.rating !== 'unhelpful' || !(feedback.comment || feedback.correction || feedback.reason)) return '';
    const reasons = { accuracy: ['准确性', 'Accuracy'], incomplete: ['信息不完整', 'Missing information'], relevance: ['不够相关', 'Relevance'], clarity: ['表达不清晰', 'Clarity'], instruction: ['没有遵循要求', 'Did not follow instructions'], other: ['其他问题', 'Other issue'] };
    const reason = reasons[feedback.reason];
    return [t('请根据以下意见改进你之前的这条回答。', 'Please improve your earlier answer using this feedback.'),
      t('回答摘录：', 'Answer excerpt:') + '\n> ' + String(message.text || '').slice(0, 600).replace(/\n/g, '\n> ') + (String(message.text || '').length > 600 ? '…' : ''),
      reason ? t('问题类型：', 'Issue: ') + t(...reason) : '',
      feedback.comment ? t('我的意见：', 'My feedback: ') + feedback.comment : '',
      feedback.correction ? t('建议修正：', 'Suggested correction: ') + feedback.correction : '',
    ].filter(Boolean).join('\n\n');
  }
  function createController(host = {}) {
    const saving = new Set(), privateFeedback = new WeakMap();
    function resolve(cid, mid) {
      const conversation = host.getConversation?.(cid), message = conversation?.messages?.find(item => item.id === mid);
      const run = message && host.getRun?.(message.runId || message.pendingRunId || message.retryRunId);
      if (!eligible(conversation, message, run)) throw fault('FEEDBACK_GONE', '这条回答正在生成、已不可用，或对话已归档。', 'This answer is still being generated, unavailable, or in an archived conversation.');
      return { conversation, message };
    }
    function read(cid, mid) { const { conversation, message } = resolve(cid, mid); return copy(privateConversation(conversation) ? privateFeedback.get(message) : message.answerFeedback) || null; }
    async function commit(cid, mid, value, options = {}) {
      const key = keyOf(cid, mid);
      if (saving.has(key)) throw fault('FEEDBACK_BUSY', '正在保存这条回答的反馈。', 'Feedback for this answer is being saved.');
      const { conversation, message } = resolve(cid, mid), memoryOnly = privateConversation(conversation);
      const before = read(cid, mid);
      if (Object.hasOwn(options, 'expected') && !same(before, options.expected)) throw fault('FEEDBACK_CONFLICT', '这条反馈已在别处改变。请重新打开后编辑；你的意见仍保留在这里。', 'This feedback changed elsewhere. Reopen to edit it; your draft is still here.');
      if (Object.hasOwn(options, 'expectedText') && message.text !== options.expectedText) throw fault('FEEDBACK_ANSWER_CHANGED', '回答内容已改变，请重新打开反馈后核对。', 'The answer changed. Reopen feedback and review it first.');
      const normalized = normalize(value), next = normalized ? { ...normalized, updatedAt: Date.now() } : null;
      if (!memoryOnly && typeof host.save !== 'function') throw fault('FEEDBACK_SAVE', '反馈保存接口尚未连接。', 'Feedback saving is not connected.');
      saving.add(key);
      if (memoryOnly) { if (next) privateFeedback.set(message, next); else privateFeedback.delete(message); }
      else if (next) message.answerFeedback = next; else delete message.answerFeedback;
      try {
        if (!memoryOnly && await host.save() === false) throw fault('FEEDBACK_SAVE', '本机保存尚未完成，请重试。', 'Local saving did not complete. Please retry.');
        return copy(next);
      } catch (error) {
        const current = host.getConversation?.(cid)?.messages?.find(item => item.id === mid);
        // Restore only our field. Never resurrect a removed message or replace
        // concurrent transcript edits, another feedback value, or composer text.
        if (!memoryOnly && current && same(current.answerFeedback, next)) {
          if (before) current.answerFeedback = before; else delete current.answerFeedback;
        }
        throw error;
      } finally { saving.delete(key); host.onChanged?.(cid, mid); }
    }
    async function stage(cid, mid) {
      if (saving.has(keyOf(cid, mid))) throw fault('FEEDBACK_BUSY', '请等待反馈保存完成。', 'Wait until feedback is saved.');
      const { message } = resolve(cid, mid), feedback = read(cid, mid), text = suggestion(message, feedback);
      if (!text) throw fault('FEEDBACK_EMPTY', '先补充并保存问题类型、意见或修正。', 'Add and save an issue type, comment, or correction first.');
      if (typeof host.stageDraft !== 'function') throw fault('FEEDBACK_DRAFT', '对话草稿接口尚未连接。', 'The conversation draft is not connected.');
      const result = await host.stageDraft({ conversationId: cid, messageId: mid, text });
      if (result === false) throw fault('FEEDBACK_DRAFT', '输入框已有草稿，请先处理后再继续。', 'The composer already has a draft. Handle it before continuing.');
      return true;
    }
    return { read, resolve, commit, stage, isBusy: (cid, mid) => saving.has(keyOf(cid, mid)), anyBusy: () => saving.size > 0 };
  }

  let hooks = {}, controller, dialog, editorHost, editing = null, lastFocus = null, focusTarget = null, composing = false, cleanupPending = false;
  const mounts = new Map(), drafts = new Map(), notices = new Map();
  const editKey = () => editing && keyOf(editing.conversationId, editing.messageId);
  const currentDraft = () => drafts.get(editKey());
  function refreshActions(element, ids) {
      if (!element.isConnected) { mounts.delete(element); return; }
      let feedback, message, conversation;
      try { ({ message, conversation } = controller.resolve(ids.conversationId, ids.messageId)); feedback = controller.read(ids.conversationId, ids.messageId); }
      catch (_) { root.HalaskaUI?.unmount(element); element.remove(); mounts.delete(element); return; }
      const key = keyOf(ids.conversationId, ids.messageId), status = notices.get(key) || {};
      root.HalaskaUI.mount(element, 'FeedbackActions', { feedback, busy: controller.isBusy(ids.conversationId, ids.messageId), memoryOnly: privateConversation(conversation), draft: drafts.has(key), notice: status.notice || '', error: status.error || '',
        onRate: rating => rate(ids, rating), onEdit: () => open(ids), onContinue: () => continueWith(ids),
      });
  }
  function cleanup() {
    cleanupPending = false;
    for (const [element] of mounts) if (!element.isConnected) mounts.delete(element);
    for (const [key, draft] of drafts) {
      if (!draft.memoryOnly) continue;
      const [cid, mid] = JSON.parse(key);
      try { controller.resolve(cid, mid); } catch (_) { drafts.delete(key); notices.delete(key); if (key === editKey() && dialog?.open) { lastFocus = null; focusTarget = null; dialog.close(); } }
    }
  }
  function refresh() {
    cleanup();
    for (const [element, ids] of mounts) refreshActions(element, ids);
    refreshEditor();
  }
  function refreshEditor() {
    if (!dialog?.open || !editing) return;
    const draft = currentDraft(); if (!draft) return;
    const busy = controller.isBusy(editing.conversationId, editing.messageId);
    let unavailable = false;
    try { controller.resolve(editing.conversationId, editing.messageId); } catch (_) { unavailable = true; }
    const notice = draft.noticeKind === 'saved' ? t(draft.memoryOnly ? '已在本次无痕会话中记下。' : '反馈已保存到这条对话。', draft.memoryOnly ? 'Noted for this private session.' : 'Feedback saved with this conversation.') : draft.noticeKind === 'later' ? t('已保存刚才提交的意见；你之后输入的修改尚未保存。', 'Your submitted feedback was saved. Later edits in the fields are still unsaved.') : '';
    root.HalaskaUI.mount(editorHost, 'FeedbackEditor', { draft: { ...draft, notice }, busy, unavailable, memoryOnly: draft.memoryOnly,
      onChange: (field, value) => { draft[field] = value; draft.revision += 1; draft.noticeKind = ''; refreshEditor(); },
      onSave: () => saveEditor(), onClose: () => close(),
      onContinue: () => continueWith(editing), canContinue: !busy && !unavailable && !draftChanged(draft) && draft.rating === 'unhelpful' && !!(draft.reason || draft.comment.trim() || draft.correction.trim()),
    });
  }
  function draftChanged(draft) { return !same(normalize(draft), draft.expected ? normalize(draft.expected) : null); }
  function ensureDialog() {
    if (dialog) return;
    dialog = root.document.createElement('dialog'); dialog.id = 'answerFeedbackDialog'; dialog.className = 'answer-feedback-dialog';
    dialog.setAttribute('aria-labelledby', 'answerFeedbackTitle'); dialog.setAttribute('aria-describedby', 'answerFeedbackPrivacy');
    editorHost = root.document.createElement('div'); dialog.append(editorHost); root.document.body.append(dialog);
    dialog.addEventListener('compositionstart', () => { composing = true; }); dialog.addEventListener('compositionend', () => { composing = false; });
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!composing) close(); });
    dialog.addEventListener('keydown', event => {
      if (event.isComposing || composing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void saveEditor(); }
    });
    dialog.addEventListener('close', () => { editing = null; root.HalaskaUI?.unmount(editorHost); const fallback = focusTarget && [...mounts].find(([element, ids]) => element.isConnected && ids.conversationId === focusTarget.conversationId && ids.messageId === focusTarget.messageId)?.[0]?.querySelector('button'); if (lastFocus?.isConnected && lastFocus !== root.document.body) lastFocus.focus({ preventScroll: true }); else fallback?.focus({ preventScroll: true }); lastFocus = null; focusTarget = null; refresh(); });
  }
  function open(ids, opener) {
    if (controller.isBusy(ids.conversationId, ids.messageId)) return false;
    try {
      const { conversation, message } = controller.resolve(ids.conversationId, ids.messageId), feedback = controller.read(ids.conversationId, ids.messageId);
      ensureDialog();
      if (dialog.open) return false;
      const key = keyOf(ids.conversationId, ids.messageId), cached = drafts.get(key);
      // Keep an unsaved local draft after Escape. If its baseline changed, keep
      // the text but refresh its baseline and explain the conflict on reopen.
      if (cached) {
        if (!same(cached.expected, feedback) || cached.expectedText !== message.text) cached.error = t('回答或已保存的反馈发生了变化。你的草稿仍在，请核对后再保存。', 'The answer or saved feedback changed. Your draft is retained; review it before saving.');
        cached.expected = copy(feedback); cached.expectedText = message.text; cached.memoryOnly = privateConversation(conversation);
      } else drafts.set(key, { rating: feedback?.rating || 'unhelpful', reason: feedback?.reason || '', comment: feedback?.comment || '', correction: feedback?.correction || '', expected: copy(feedback), expectedText: message.text, memoryOnly: privateConversation(conversation), revision: 0, error: '', notice: '' });
      editing = { ...ids }; focusTarget = { ...ids }; lastFocus = opener || root.document.activeElement; dialog.showModal(); refreshEditor();
      root.document.getElementById('answerFeedbackComment')?.focus({ preventScroll: true }); return true;
    } catch (error) { hooks.toast?.(error.message); return false; }
  }
  function close() {
    if (!dialog?.open) return;
    if (controller.isBusy(editing?.conversationId, editing?.messageId)) return;
    const draft = currentDraft(); if (draft && !draftChanged(draft)) drafts.delete(editKey());
    dialog.close();
  }
  async function saveEditor() {
    if (!editing || controller.isBusy(editing.conversationId, editing.messageId)) return false;
    const ids = { ...editing }, key = editKey(), draft = currentDraft(), revision = draft.revision;
    draft.error = ''; draft.noticeKind = '';
    let pending;
    try { pending = controller.commit(ids.conversationId, ids.messageId, copy(draft), { expected: draft.expected, expectedText: draft.expectedText }); refresh(); const saved = await pending;
      draft.expected = saved;
      if (draft.revision === revision) { Object.assign(draft, normalize(saved)); draft.noticeKind = 'saved'; }
      else draft.noticeKind = 'later';
      notices.delete(key); refresh(); return true;
    } catch (error) { draft.error = error.message; refresh(); return false; }
  }
  async function rate(ids, rating) {
    const opener = root.document?.activeElement;
    const key = keyOf(ids.conversationId, ids.messageId);
    try {
      const before = controller.read(ids.conversationId, ids.messageId), value = before?.rating === rating ? null : { rating };
      const pending = controller.commit(ids.conversationId, ids.messageId, value, { expected: before }); notices.delete(key); refresh(); await pending;
      // An existing feedback draft belongs to the user's earlier edit. Keep it
      // when switching ratings and let reopen explicitly review the new baseline.
      notices.set(key, { notice: value ? t('已记下', 'Noted') : t('已撤销反馈', 'Feedback removed') }); refresh();
      if (value?.rating === 'unhelpful') open(ids, opener);
    } catch (error) { notices.set(key, { error: error.message }); refresh(); }
  }
  async function continueWith(ids) {
    const key = keyOf(ids.conversationId, ids.messageId);
    if (editing && editKey() === key && draftChanged(currentDraft())) { currentDraft().error = t('请先保存当前意见，再带着建议继续。', 'Save your edits before continuing with this feedback.'); refreshEditor(); return false; }
    try { await controller.stage(ids.conversationId, ids.messageId); if (dialog?.open) { lastFocus = null; focusTarget = null; close(); } notices.set(key, { notice: t('建议已放入输入框，发送前仍可修改。', 'Your suggestion is in the composer. Review it before sending.') }); refresh(); hooks.onDraftStaged?.(ids.conversationId); return true; }
    catch (error) { notices.set(key, { error: error.message }); if (currentDraft()) currentDraft().error = error.message; refresh(); return false; }
  }
  function mount(wrapper, ids) {
    if (!controller || !root.HalaskaUI?.componentNames.includes('FeedbackActions')) return null;
    try { controller.resolve(ids.conversationId, ids.messageId); } catch (_) { return null; }
    let element = wrapper.querySelector('.answer-feedback-host');
    if (!element) { element = root.document.createElement('div'); element.className = 'answer-feedback-host'; (wrapper.querySelector('.message-meta') || wrapper).append(element); }
    mounts.set(element, { ...ids }); refreshActions(element, ids); if (!cleanupPending) { cleanupPending = true; queueMicrotask(cleanup); } return element;
  }
  function unmount(wrapper) {
    if (!wrapper) return;
    const hosts = wrapper.matches?.('.answer-feedback-host') ? [wrapper] : [...wrapper.querySelectorAll('.answer-feedback-host')];
    for (const element of hosts) { root.HalaskaUI?.unmount(element); mounts.delete(element); }
  }
  function init(options = {}) {
    hooks = options; controller = createController({ ...options, onChanged: (cid, mid) => { hooks.onChanged?.(cid, mid); refresh(); } });
    root.document?.removeEventListener('workstation-language-change', refresh); root.document?.addEventListener('workstation-language-change', refresh); return api;
  }
  function destroy() { if (dialog?.open) dialog.close(); root.HalaskaUI?.unmount(editorHost); dialog?.remove(); dialog = null; editing = null; for (const element of mounts.keys()) root.HalaskaUI?.unmount(element); mounts.clear(); drafts.clear(); notices.clear(); root.document?.removeEventListener('workstation-language-change', refresh); }
  const api = { init, mount, unmount, refresh, open, close, destroy, isBusy: () => controller?.anyBusy() || false, isEditing: () => !!dialog?.open, createController, eligible, normalize, suggestion, REASONS, MAX_TEXT };
  return api;
});
