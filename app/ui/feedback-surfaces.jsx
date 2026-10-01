import React from 'react';
import { Button, Caption, Heading } from './halaska-kit.jsx';
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang || '') ? en : zh;
function Thumb({ down = false }) { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={down ? { transform: 'rotate(180deg)' } : undefined}><path d="M7 10v11H3V10h4Zm0 0 5-8c2 0 3 1 3 3l-1 5h5a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7" /></svg>; }
export function FeedbackActions({ feedback, busy, memoryOnly, draft, notice, error, onRate, onEdit, onContinue }) {
  const privacy = t(memoryOnly ? '反馈仅留在本次无痕会话，退出或重启后清除。' : '反馈保存在对话中，不会自动发送给模型服务。', memoryOnly ? 'Feedback stays in this private session and is cleared when you leave or restart.' : 'Feedback is saved with the conversation and is not automatically sent to the model service.');
  return <div className="answer-feedback" aria-label={t('回答反馈', 'Answer feedback')}>
    <div className="answer-feedback-buttons">
      <Button size="sm" variant="ghost" disabled={busy} aria-pressed={feedback?.rating === 'helpful'} aria-label={t(feedback?.rating === 'helpful' ? '撤销有帮助反馈' : '这条回答有帮助', feedback?.rating === 'helpful' ? 'Remove helpful feedback' : 'This answer is helpful')} title={privacy} onClick={() => onRate('helpful')}><Thumb /></Button>
      <Button size="sm" variant="ghost" disabled={busy} aria-pressed={feedback?.rating === 'unhelpful'} aria-label={t(feedback?.rating === 'unhelpful' ? '撤销需改进反馈' : '这条回答需要改进', feedback?.rating === 'unhelpful' ? 'Remove needs-improvement feedback' : 'This answer needs improvement')} title={privacy} onClick={() => onRate('unhelpful')}><Thumb down /></Button>
      {(feedback || draft) && <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>{draft ? t('意见草稿', 'Feedback draft') : t('补充意见', 'Add details')}</Button>}
      {feedback?.rating === 'unhelpful' && !!(feedback.reason || feedback.comment || feedback.correction) && <Button size="sm" variant="ghost" disabled={busy} onClick={onContinue}>{t('带着建议继续', 'Continue with feedback')}</Button>}
    </div>
    {(busy || notice) && <span className="answer-feedback-notice" role="status" aria-live="polite">{busy ? t('正在保存…', 'Saving…') : notice}</span>}
    {error && <span className="answer-feedback-error" role="alert">{error}</span>}
  </div>;
}
export function FeedbackEditor({ draft, busy, unavailable, memoryOnly, onChange, onSave, onClose, onContinue, canContinue }) {
  return <section className="answer-feedback-editor">
    <header><div><Caption>{t('回答反馈', 'ANSWER FEEDBACK')}</Caption><Heading level={2}><span id="answerFeedbackTitle">{t('让下一次回答更贴近你的需要', 'Make the next answer more useful')}</span></Heading></div><Button size="sm" variant="ghost" disabled={busy} aria-label={t('关闭反馈，保留草稿', 'Close feedback and retain draft')} onClick={onClose}>✕</Button></header>
    <p id="answerFeedbackPrivacy" className="answer-feedback-privacy">{memoryOnly ? t('只记在本次无痕会话，退出或重启后清除。不会发送给模型服务。', 'Stored only for this private session and cleared when you leave or restart. Not sent to the model service.') : t('反馈保存到本机对话，随工作区的同步设置处理。不会作为训练反馈自动发送给模型服务。', 'Feedback is saved to the local conversation and follows your workspace sync settings. It is not automatically sent to the model service as training feedback.')}</p>
    <div className="answer-feedback-fields">
      <label htmlFor="answerFeedbackRating">{t('这条回答', 'This answer')}<select id="answerFeedbackRating" value={draft.rating} onChange={e => onChange('rating', e.target.value)} disabled={unavailable}><option value="helpful">{t('有帮助', 'Helpful')}</option><option value="unhelpful">{t('需要改进', 'Needs improvement')}</option></select></label>
      <label htmlFor="answerFeedbackReason">{t('问题类型 · 选填', 'Issue type · optional')}<select id="answerFeedbackReason" value={draft.reason} onChange={e => onChange('reason', e.target.value)} disabled={unavailable}><option value="">{t('不选择', 'No selection')}</option>{[['accuracy','准确性','Accuracy'],['incomplete','信息不完整','Missing information'],['relevance','不够相关','Relevance'],['clarity','表达不清晰','Clarity'],['instruction','没有遵循要求','Did not follow instructions'],['other','其他问题','Other issue']].map(([value, zh, en]) => <option key={value} value={value}>{t(zh, en)}</option>)}</select></label>
      <label htmlFor="answerFeedbackComment" className="answer-feedback-wide">{t('具体哪里做得好，或需要改进？ · 选填', 'What worked, or what should improve? · optional')}<textarea id="answerFeedbackComment" value={draft.comment} rows={4} maxLength={4000} placeholder={t('例如：结论清晰，但没有说明数据来自哪里。', 'For example: the conclusion was clear, but the data sources were missing.')} onChange={e => onChange('comment', e.target.value)} disabled={unavailable} /><span className="answer-feedback-count">{draft.comment.length} / 4000</span></label>
      <label htmlFor="answerFeedbackCorrection" className="answer-feedback-wide">{t('建议修正 · 选填', 'Suggested correction · optional')}<textarea id="answerFeedbackCorrection" value={draft.correction} rows={3} maxLength={4000} placeholder={t('写下你希望采用的事实、表达或处理方式。', 'Add the facts, wording, or approach you would prefer.')} onChange={e => onChange('correction', e.target.value)} disabled={unavailable} /></label>
    </div>
    {unavailable && <p className="answer-feedback-error" role="alert">{t('回答或对话已不可用，草稿仍保留在当前窗口。', 'This answer or conversation is unavailable. Your draft is still retained here.')}</p>}
    {draft.error && <p className="answer-feedback-error" role="alert">{draft.error}</p>}
    <p className="answer-feedback-save-state" role="status" aria-live="polite">{busy ? t('正在保存；你仍可继续写，后续修改会保留为草稿。', 'Saving. You can keep typing; later edits remain in the draft.') : draft.notice || t('关闭会保留尚未保存的意见，直到本次应用会话结束。', 'Closing retains unsaved feedback until this app session ends.')}</p>
    <footer><Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t('稍后再说', 'Close')}</Button><div><Button size="sm" variant="secondary" disabled={!canContinue} onClick={onContinue}>{t('带着建议继续', 'Continue with feedback')}</Button><Button size="sm" variant="accent" loading={busy} disabled={unavailable} onClick={onSave}>{t('保存反馈', 'Save feedback')}</Button></div></footer>
    <p className="answer-feedback-send-note">{t('“带着建议继续”只填入对话草稿，发送前你可以检查和修改。', '“Continue with feedback” only fills a conversation draft for you to review before sending.')}</p>
  </section>;
}
