import React, { useLayoutEffect, useRef, useState } from 'react';
import { Badge, Breadcrumb, Button, EmptyState, Heading, MiddleTruncate, SegmentedControl, StatusBadge } from './halaska-kit.jsx';

const lang = () => document.documentElement.lang.startsWith('en');
const label = (zh, en) => lang() ? en : zh;
const stats = (added, removed) => <span className="kit-review-stats" aria-label={label(`新增 ${added} 行，删除 ${removed} 行`, `${added} lines added, ${removed} removed`)}>
  <Badge variant="success">+{added}</Badge><Badge variant="danger">−{removed}</Badge>
</span>;

export function ReviewSummary({ count, added, removed }) {
  return <div className="kit-review-summary"><strong>{label('本轮变更', 'Changes this turn')}</strong><Badge>{count} {label('个文件', 'files')}</Badge>{Number.isFinite(added) && stats(added, removed)}</div>;
}

export function ReviewHeading({ path, added, removed, notice = '' }) {
  const parts = path.split('/').filter(Boolean), filename = parts.pop() || path;
  const [status, ...description] = notice.split(' · ');
  const variant = /^(已采纳|Adopted|已保存到本机|Saved to file)$/.test(status) ? 'online' : /^(待采纳草稿|Draft to review|待处理|Pending review|待保存到本机|Ready to save|部分已审阅|Partially reviewed|需要检查当前文件|Check current file)$/.test(status) ? 'pending' : 'default';
  return <div className="kit-review-heading">
    {parts.length > 0 && <div className="kit-review-path review-breadcrumb" title={path} aria-label={label('文件路径：', 'File path: ') + path}>
      <Breadcrumb items={[{ label: <MiddleTruncate text={path} tail={Math.min(18, filename.length)} mono={false} /> }]} />
    </div>}
    <div className="kit-review-title-row"><Heading level={3}><MiddleTruncate text={filename} tail={Math.min(16, filename.length)} mono={false} style={{ color: 'var(--text)', fontSize: 'inherit', fontWeight: 'inherit' }} /></Heading>{stats(added, removed)}</div>
    {notice && <div className="kit-review-notice review-notice"><StatusBadge status={variant}>{status}</StatusBadge>{description.length > 0 && <span>{description.join(' · ')}</span>}</div>}
  </div>;
}

// The kit owns the visual control; the reader still owns mode and source rows.
// Add the ARIA/roving-focus contract missing from the upstream primitive.
export function ReviewModeControl({ id, options, value, onChange }) {
  const host = useRef(null);
  useLayoutEffect(() => {
    const group = host.current.firstElementChild;
    group.setAttribute('role', 'tablist'); group.setAttribute('aria-label', label('文件视图', 'File view'));
    const buttons = group.querySelectorAll('button');
    buttons.forEach((button, index) => {
      const mode = options[index][0], selected = mode === value;
      button.id = `${id}-${mode}`; button.dataset.mode = mode; button.classList.add('review-tab');
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', id);
      button.setAttribute('aria-selected', String(selected)); button.setAttribute('aria-pressed', String(selected)); button.tabIndex = selected ? 0 : -1;
    });
  }, [id, options, value]);
  const keydown = event => {
    const buttons = [...host.current.querySelectorAll('button')], index = buttons.indexOf(event.target);
    if (index < 0) return;
    const next = ({ ArrowRight: (index + 1) % options.length, ArrowLeft: (index + options.length - 1) % options.length, Home: 0, End: options.length - 1 })[event.key];
    if (next == null) return;
    event.preventDefault(); event.stopPropagation(); onChange(options[next][0]); buttons[next].focus();
  };
  return <div ref={host} className="kit-review-modes" onKeyDown={keydown}><SegmentedControl options={options.map(option => option[1])} value={options.find(option => option[0] === value)?.[1]} onChange={next => onChange(options.find(option => option[1] === next)[0])} /></div>;
}

export function ReviewDiffTools({ mode = 'diff', narrow, split, full, wrap = true, onSplit, onContext, onWrap }) {
  const host = useRef(null);
  useLayoutEffect(() => {
    const buttons = host.current.querySelectorAll('button');
    if (mode === 'diff') { buttons[0].dataset.reviewSplit = ''; buttons[1].dataset.reviewContext = ''; }
    buttons[buttons.length - 1].dataset.reviewWrap = '';
  }, [mode, narrow, split, full, wrap]);
  return <div ref={host} className="kit-review-diff-tools">
    {mode === 'diff' && <><Button size="sm" variant={split && !narrow ? 'secondary' : 'ghost'} disabled={narrow} aria-pressed={split && !narrow} onClick={onSplit} title={narrow ? label('加宽审阅区域可使用并排视图', 'Widen the review to compare side by side') : label('切换统一 / 并排差异', 'Switch unified / split diff')}>{narrow ? label('统一视图', 'Unified') : label('并排', 'Split')}</Button>
    <Button size="sm" variant={full ? 'secondary' : 'ghost'} aria-pressed={!!full} onClick={onContext}>{label('完整内容', 'Full context')}</Button></>}
    <Button size="sm" variant={wrap ? 'secondary' : 'ghost'} aria-pressed={wrap} onClick={onWrap} title={label('切换长行自动换行；不修改文件内容', 'Toggle line wrapping without changing file contents')}>{label('自动换行', 'Wrap lines')}</Button>
  </div>;
}

// Existing controllers supply real action nodes. Invoke their original handler,
// retain datasets used by local-file writes, and settle only with its Promise.
export function ReviewActions({ actions }) {
  const host = useRef(null), active = useRef(false), [pending, setPending] = useState(null), [failure, setFailure] = useState('');
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useLayoutEffect(() => {
    host.current.querySelectorAll('button').forEach((button, index) => {
      const original = actions[index];
      for (const [key, value] of Object.entries(original.dataset)) button.dataset[key] = value;
      button.classList.add('review-action');
    });
  }, [actions, pending]);
  async function act(action, index, event) {
    if (pending != null || action.disabled) return;
    setPending(index); setFailure('');
    try { await action.onclick?.call(action, event); }
    catch (error) { if (active.current) setFailure(error?.message || String(error)); }
    finally { if (active.current) setPending(null); }
  }
  return <div ref={host} className="kit-review-actions">
    {actions.map((action, index) => <Button key={index} size="sm" variant={action.dataset.localEditAction === 'apply' || action.dataset.hunkAction === 'accept-hunk' || action.dataset.draftReviewAction === 'adopt' ? 'accent' : 'secondary'} disabled={action.disabled || pending != null} loading={pending === index} onClick={event => act(action, index, event)} title={action.title || undefined}>{action.textContent}</Button>)}
    {failure && <p className="file-review-error" role="alert">{failure}</p>}
  </div>;
}

export function ReviewEmptyState({ title, description, onClear }) {
  return <div className="kit-review-empty"><EmptyState title={title} description={description} action={onClear && <Button variant="secondary" size="sm" onClick={onClear}>{label('清除搜索', 'Clear search')}</Button>} /></div>;
}

export function ReviewChangeCard({ changes, commandCount, onSelect, onReview }) {
  return <><header><strong>{label('本轮文件', 'Files this turn')}<span className="file-result-count">{changes.length}</span></strong></header>
    <div className="file-change-list kit-review-change-list">{changes.map(change => <div key={change.id} className="file-change-row">
      <Button variant="ghost" onClick={event => onSelect(change.id, event.currentTarget)} title={change.path} aria-label={`${change.openLabel}：${change.path}`} style={{ flex: 1, minWidth: 0, padding: '8px 2px', textAlign: 'left', justifyContent: 'flex-start' }}>
        <span className="file-result-entry"><span className="file-result-name"><MiddleTruncate text={change.path} tail={Math.min(16, change.path.split('/').at(-1).length)} mono={false} /></span><span className="file-result-detail"><span className="file-result-status">{change.status}</span><span className="file-result-open">{change.openLabel}</span></span></span>
      </Button>
      {change.canOpen && <Button variant="ghost" size="sm" onClick={event => onReview(change.id, event.currentTarget)} aria-label={`${label('审阅修改', 'Review changes')}：${change.path}`}>{label('审阅修改', 'Review changes')}</Button>}
    </div>)}</div>
    {commandCount > 0 && <p className="file-change-caution">{label(`本轮还执行过 ${commandCount} 条终端命令：其效果不会随撤销回滚，请先在命令记录中核对。`, `${commandCount} terminal commands also ran. Undoing files does not reverse their effects; check the command history.`)}</p>}
  </>;
}
