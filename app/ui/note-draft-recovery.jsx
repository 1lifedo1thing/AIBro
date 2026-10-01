import React from 'react';
import { AlertBanner, Button, Card, StatusBadge } from './halaska-kit.jsx';
import styles from './note-draft-recovery.css';

if (!document.getElementById('note-draft-recovery-styles')) {
  const style = document.createElement('style');
  style.id = 'note-draft-recovery-styles'; style.textContent = styles;
  document.head.append(style);
}

const english = () => /^en(?:-|$)/i.test(document.documentElement.lang || '');
const t = (zh, en) => english() ? en : zh;
const cardStyle = { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'none' };
const available = callback => typeof callback === 'function';

function SavedTime({ updatedAt }) {
  if (updatedAt == null || updatedAt === '') return null;
  // Display only the controller's persisted timestamp. Relative timers would
  // repeatedly announce updates and could imply a save that never happened.
  const date = new Date(updatedAt);
  if (!Number.isFinite(date.getTime())) return null;
  return <time className="note-draft-time" dateTime={date.toISOString()} aria-live="off">
    {t('本机保存时间：', 'Saved locally: ')}{date.toLocaleString(english() ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
  </time>;
}

// Presentation only. The note controller owns the editor, persistence, conflict
// checks and clipboard content; this island never receives or stores the draft.
export function NoteDraftRecovery({ state = 'idle', blocked = false, message = '', updatedAt, restored = false, busy = false, confirmReplace = false, cleanupPending = false, onRetry, onReload, onConfirmReload, onCancelReload, onCopy }) {
  const unavailable = !!blocked || state === 'unavailable';
  const failed = state === 'error', conflict = state === 'conflict';
  const hasProblem = unavailable || failed || conflict;
  const confirming = !!confirmReplace && !unavailable && !cleanupPending;
  if (state === 'idle' && !restored && !cleanupPending && !blocked && !confirming) return null;

  const label = cleanupPending ? t('笔记已保存，恢复草稿尚未清理', 'Note saved; recovery draft still needs cleanup')
    : unavailable ? t('草稿仅保留在当前窗口', 'Draft kept in this window only')
    : conflict ? t('另一窗口更新了本机草稿', 'Another window updated the local draft')
    : failed ? t('草稿尚未保存在本机', 'Draft has not been saved locally')
    : state === 'loading' ? t('正在读取本机草稿…', 'Reading the local draft…')
    : state === 'saving' ? t('正在保存本机草稿…', 'Saving the local draft…')
    : state === 'saved' ? t('草稿已保存在本机', 'Draft saved locally')
    : t('已恢复本机草稿', 'Local draft restored');
  const detail = cleanupPending ? t('正文已经写入笔记。这里只重试清理恢复记录，不会再次保存或替换正文。', 'The note content has been saved. Retry only removes the recovery record; it does not save or replace the note again.')
    : unavailable ? t('当前草稿不会写入本机恢复存储，关闭窗口后无法从这里恢复。可以先复制当前草稿。', 'This draft is not written to local recovery storage and cannot be restored here after closing the window. You can copy the current draft first.')
    : conflict ? t('当前编辑仍在此窗口。为避免覆盖另一窗口的修改，自动保存已暂停；载入前可以先复制当前草稿。', 'Your edits remain in this window. Autosave is paused to avoid overwriting changes from the other window. You can copy your current draft before loading its version.')
    : failed ? t('当前编辑仍在此窗口；本机恢复记录可能不是最新内容。请重试，或先复制当前草稿。', 'Your edits remain in this window; the local recovery record may be out of date. Retry, or copy your current draft first.')
    : '';
  const expanded = cleanupPending || hasProblem || restored || confirming;
  const retry = available(onRetry) && (cleanupPending || (!blocked && (failed || conflict || state === 'unavailable')));
  const reload = available(onReload) && !unavailable && !cleanupPending && (failed || conflict);
  const copy = available(onCopy) && (hasProblem || confirming || cleanupPending);
  const guard = callback => () => { if (!busy && available(callback)) callback(); };

  const content = <>
    <div className="note-draft-announcement" role="status" aria-live="polite" aria-atomic="true">
      {hasProblem || cleanupPending ? <AlertBanner variant="warning" title={label} description={detail} />
        : <div className="note-draft-state"><StatusBadge status={state === 'saved' ? 'online' : state === 'loading' || state === 'saving' ? 'accent' : 'default'} pulse={false}>{label}</StatusBadge></div>}
      {restored && !cleanupPending && <p className="note-draft-restored">{t('已恢复本机草稿，保存后才写入笔记。', 'The local draft has been restored. Save it to write these changes to the note.')}</p>}
      {!!message && <p className="note-draft-message" data-user-content>{String(message)}</p>}
    </div>
    {!unavailable && !cleanupPending && <SavedTime updatedAt={updatedAt} />}
    {confirming && <div className="note-draft-confirm" role="group" aria-label={t('确认载入另一窗口草稿', 'Confirm loading the other window’s draft')}>
      <p>{t('载入会替换当前编辑区的内容。尚未复制的当前修改将无法从此窗口找回。', 'Loading replaces the contents of this editor. Current changes that you have not copied will no longer be available in this window.')}</p>
      <div className="note-draft-actions">
        {available(onCancelReload) && <Button id="noteDraftCancelReload" variant="secondary" size="sm" disabled={!!busy} onClick={guard(onCancelReload)}>{t('保留当前编辑', 'Keep current edits')}</Button>}
        {available(onConfirmReload) && <Button id="noteDraftConfirmReload" variant="accent" size="sm" disabled={!!busy} onClick={guard(onConfirmReload)}>{t('确认载入另一窗口草稿', 'Load the other window’s draft')}</Button>}
      </div>
    </div>}
    {(copy || (!confirming && (retry || reload))) && <div className="note-draft-actions">
      {!confirming && retry && <Button id="noteDraftRetry" variant="secondary" size="sm" disabled={!!busy} onClick={guard(onRetry)}>{cleanupPending ? t('重试清理恢复草稿', 'Retry recovery draft cleanup') : t('重试保存草稿', 'Retry saving the draft')}</Button>}
      {copy && <Button id="noteDraftCopy" variant="outline" size="sm" onClick={() => onCopy()}>{t('复制当前草稿', 'Copy current draft')}</Button>}
      {!confirming && reload && <Button id="noteDraftReload" variant="ghost" size="sm" disabled={!!busy} onClick={guard(onReload)}>{t('载入另一窗口草稿…', 'Load the other window’s draft…')}</Button>}
    </div>}
  </>;
  return <section className={`note-draft-recovery${expanded ? ' note-draft-expanded' : ''}`} aria-label={t('本机草稿恢复', 'Local draft recovery')} data-state={cleanupPending ? 'cleanup-pending' : unavailable ? 'unavailable' : state} data-busy={busy || undefined}>
    {expanded ? <Card padding={0} style={cardStyle}><div className="note-draft-body">{content}</div></Card> : <div className="note-draft-compact">{content}</div>}
  </section>;
}
