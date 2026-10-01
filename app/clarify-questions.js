/* 结构化问询卡片（对齐 NewMax 的 ask-user 形态）：需要用户补充信息、且可选答案能
   明确枚举时，Agent 以选择题形式提问；用户点选后可一键提交。
   本模块只做清洗、答案组装与渲染——它不执行任何动作，也不改变权限与审批：
   提交的回答就是一条普通的用户消息，走既有的发送 / 排队路径。 */
(function (root) {
  'use strict';
  const MAX_QUESTIONS = 6;
  const MAX_OPTIONS = 8;
  const QUESTION_LIMIT = 200;
  const OPTION_LIMIT = 100;
  const text = value => typeof value === 'string' ? value.trim() : '';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // 只接受“至少两个可枚举选项”的问题：没有选项的追问属于普通对话，不在这里冒充
  // 选择题；结构不完整的条目直接丢弃——不编造选项，也不猜测用户可能想要的答案。
  function validate(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const question = text(item.question).slice(0, QUESTION_LIMIT);
      if (!question) continue;
      const options = [...new Set((Array.isArray(item.options) ? item.options : [])
        .map(option => text(option).slice(0, OPTION_LIMIT)).filter(Boolean))].slice(0, MAX_OPTIONS);
      if (options.length < 2) continue;
      let id = text(item.id).slice(0, 40) || `q${out.length + 1}`;
      while (out.some(entry => entry.id === id)) id = `${id}_`;
      out.push({ id, question, options, multiple: item.multiple === true });
      if (out.length >= MAX_QUESTIONS) break;
    }
    return out;
  }
  function picks(question, draft) {
    const raw = draft && Array.isArray(draft[question.id]) ? draft[question.id] : [];
    return raw.map(value => text(value)).filter(value => question.options.includes(value));
  }
  // 组装给模型看的用户消息：逐题带上原问题与所选答案，保证脱离卡片后语义完整。
  function answerText(questions, draft = {}) {
    const lines = [];
    for (const question of questions || []) {
      const selected = picks(question, draft);
      if (selected.length) lines.push(`· ${question.question} ${selected.join('、')}`);
    }
    if (!lines.length) return null;
    return `回答上面的问题：\n${lines.join('\n')}`;
  }
  function markup(clarify) {
    const questions = clarify && Array.isArray(clarify.questions) ? clarify.questions : [];
    if (!questions.length) return '';
    const submitted = Number(clarify?.submittedAt) > 0;
    // 已提交后展示的是“当时实际发送的选择”（answers），而不是后来可能变化的草稿。
    const answers = submitted ? (clarify?.answers || {}) : (clarify?.draft || {});
    const body = questions.map(question => {
      const selected = new Set(picks(question, answers));
      const options = question.options.map(option => submitted
        ? `<span class="clarify-option${selected.has(option) ? ' is-picked' : ''}">${esc(option)}</span>`
        : `<button type="button" class="clarify-option${selected.has(option) ? ' is-picked' : ''}" data-clarify-pick="${esc(question.id)}" data-clarify-value="${esc(option)}" aria-pressed="${selected.has(option)}">${esc(option)}</button>`).join('');
      return `<div class="clarify-question" data-clarify-question="${esc(question.id)}" data-choice-kind="${question.multiple ? 'multiple' : 'single'}"><div class="clarify-question-text">${esc(question.question)}${question.multiple ? '<span class="clarify-multiple">可多选</span>' : ''}</div><div class="clarify-options" role="group" aria-label="${esc(question.question)}">${options}</div></div>`;
    }).join('');
    const foot = submitted
      ? '<div class="clarify-foot"><span class="clarify-note">已回答：回答已作为你的消息发送，原问题与选择保留可核对。</span></div>'
      : '<div class="clarify-foot"><button type="button" class="primary clarify-submit">提交回答</button><span class="clarify-note">也可以直接在输入框里回答</span></div>';
    return `<div class="clarify-card" data-clarify-state="${submitted ? 'answered' : 'pending'}" role="group" aria-label="需要你补充信息"><div class="clarify-head">${submitted ? '已回答' : '需要你补充信息'}</div>${body}${foot}</div>`;
  }
  root.ClarifyQuestions = { validate, answerText, markup };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ClarifyQuestions;
})(typeof globalThis !== 'undefined' ? globalThis : this);
