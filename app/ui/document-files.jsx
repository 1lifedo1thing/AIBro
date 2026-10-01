import React, { useLayoutEffect, useRef } from 'react';
import { IconButton, Button } from './halaska-kit.jsx';
import { KitSegmentedControl, KitSearchInput } from './kit-controls.jsx';
import { ChevronRight, Folder, FolderOpen, FileText, FileCode2, FileImage, File, Plus, RefreshCw, GitPullRequest } from 'lucide-react';
import styles from './document-files.css';

const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang || '') ? en : zh;
const fileIcon = node => /\.(?:png|jpg|jpeg|webp|gif|svg|heic)$/i.test(node.name) ? FileImage : /\.(?:js|jsx|ts|tsx|py|swift|rs|css|html|json|yaml|yml|toml)$/i.test(node.name) ? FileCode2 : node.kind === 'note' || /\.(?:md|mdx|txt|pdf)$/i.test(node.name) ? FileText : File;
function flatten(nodes, level = 1, parent = null) {
  return nodes.flatMap(node => [{ ...node, level, parent }, ...(node.folder && node.expanded ? flatten(node.children || [], level + 1, node.key) : [])]);
}
export function DocumentFiles({ scopeKey, scopeName, conversationAvailable = false, mode = 'all', query = '', nodes = [], selectedKey = '', openedKeys = [], focusedKey,
  scrollTop = 0, localSearch = false, canAdd = false, onMode, onQuery, onToggle, onOpen, onReview, onRefresh, onAdd, onRetry, onLoadMore, onFocus, onScroll }) {
  const scroller = useRef(null), tree = useRef(null), previousScope = useRef(null), rememberedFocus = useRef(null);
  const rows = flatten(nodes), rowKeys = new Set(rows.map(row => row.key)), openSet = new Set(openedKeys);
  const active = rowKeys.has(focusedKey) ? focusedKey : rowKeys.has(selectedKey) ? selectedKey : rows[0]?.key;
  useLayoutEffect(() => {
    if (previousScope.current !== scopeKey) { scroller.current.scrollTop = scrollTop; previousScope.current = scopeKey; }
    // React retains keyed rows across refreshes. Only restore a disappearing
    // row's focus if the tree itself owned focus; never take it from the editor.
    if (rememberedFocus.current && document.activeElement === document.body && !rowKeys.has(rememberedFocus.current)) tree.current?.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  });
  function keyDown(event) {
    if (event.isComposing || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const control = event.target.closest('[data-document-file-key]'); if (!control) return;
    const index = rows.findIndex(row => row.key === control.dataset.documentFileKey), row = rows[index]; if (!row) return;
    let next;
    if (event.key === 'ArrowDown') next = rows[index + 1];
    if (event.key === 'ArrowUp') next = rows[index - 1];
    if (event.key === 'Home') next = rows[0];
    if (event.key === 'End') next = rows.at(-1);
    if (event.key === 'ArrowRight' && row.folder) { if (row.expanded) next = rows[index + 1]?.parent === row.key ? rows[index + 1] : null; else onToggle?.(row); }
    if (event.key === 'ArrowLeft') { if (row.folder && row.expanded) onToggle?.(row); else next = rows.find(item => item.key === row.parent); }
    event.preventDefault();
    if (next) { const target = [...tree.current.querySelectorAll('[data-document-file-key]')].find(element => element.dataset.documentFileKey === next.key); target?.focus(); }
  }
  const empty = query ? t('没有匹配的文件', 'No matching files') : mode === 'conversation' ? t('这条对话还没有文件', 'This conversation has no files yet') : t('这里还没有文件', 'No files here yet');
  return <section className="document-files-kit" aria-label={t('文件工作区', 'File workspace')}>
    <style>{styles}</style>
    <header className="document-files-heading">
      <KitSegmentedControl label={t('文件范围', 'File scope')} value={mode} onChange={onMode} options={[
        { value: 'conversation', label: t('对话文件', 'Chat files'), disabled: !conversationAvailable },
        { value: 'all', label: t('所有文件', 'All files') },
      ]} />
      <div className="document-files-actions">
        {canAdd && <IconButton size={28} label={t('添加文件', 'Add files')} icon={<Plus size={16} aria-hidden="true" />} onClick={onAdd} />}
        <IconButton size={28} label={t('刷新文件列表', 'Refresh files')} icon={<RefreshCw size={15} aria-hidden="true" />} onClick={onRefresh} />
      </div>
    </header>
    <div className="document-files-scope" title={scopeName} data-user-content>{scopeName}</div>
    <div className="document-files-search"><KitSearchInput label={t('搜索文件名或路径', 'Search file names or paths')} placeholder={t('搜索文件或路径…', 'Search files or paths…')} value={query} onChange={onQuery} attributes={{ 'data-document-file-search': '' }} /></div>
    <div className="document-files-scroll" ref={scroller} onScroll={event => onScroll?.(event.currentTarget.scrollTop)}>
      <div ref={tree} className="document-files-tree" role="tree" aria-label={mode === 'conversation' ? t('对话文件', 'Chat files') : t('所有文件', 'All files')} onKeyDown={keyDown} onBlurCapture={event => { if (event.relatedTarget && !tree.current.contains(event.relatedTarget)) rememberedFocus.current = null; }}>
        {rows.map(node => {
          const pendingReview = node.group === 'review', hasReview = !!node.review || !!node.reviews?.length, selected = selectedKey === node.key || (node.reviews || []).some(review => selectedKey === JSON.stringify([review.kind || (node.kind === 'local-file' ? 'local-review' : 'review'), review.runId]));
          const available = !node.disabled && node.available !== false && (!!node.open || hasReview), Icon = node.folder ? node.expanded ? FolderOpen : Folder : fileIcon(node);
          return <React.Fragment key={node.key}>
            <button type="button" role="treeitem" className={`document-file-row${node.folder ? ' is-folder' : ''}${node.group ? ' is-group' : ''}${selected ? ' is-selected' : ''}`}
              data-document-file-key={node.key} data-project-file-key={node.folder ? undefined : node.key} tabIndex={active === node.key ? 0 : -1}
              aria-level={node.level} aria-expanded={node.folder ? node.expanded : undefined} aria-current={!node.folder && selected ? 'page' : undefined}
              aria-disabled={!node.folder && !available || undefined} title={[node.path || node.name, node.reason].filter(Boolean).join(' · ')}
              style={{ '--file-depth': node.level - 1 }} onFocus={event => { rememberedFocus.current = node.key; tree.current.querySelectorAll('[role=treeitem]').forEach(row => { row.tabIndex = row === event.currentTarget ? 0 : -1; }); onFocus?.(node.key); }}
              onClick={() => node.folder ? onToggle?.(node) : available && onOpen?.(node)}>
              <span className="document-file-disclosure" aria-hidden="true">{node.folder && <ChevronRight size={13} />}</span>
              <Icon size={16} className={`document-file-icon${pendingReview ? ' has-review' : ''}`} aria-hidden="true" />
              <span className="document-file-name" data-user-content>{node.name}</span>
              {node.group && <small className="document-file-count">{node.count}</small>}
              {!node.folder && pendingReview && <small className="document-file-state is-review">{t('待审阅', 'Review')}</small>}
              {!node.folder && !pendingReview && !available && <small className="document-file-state">{t('不可用', 'Unavailable')}</small>}
              {!node.folder && !pendingReview && available && openSet.has(node.key) && <span className="document-file-opened" title={t('已打开', 'Open')} aria-label={t('已打开', 'Open')} />}
            </button>
            {!node.folder && (node.reviews || []).length > 1 && <div className="document-file-review-list" style={{ '--file-depth': node.level }}>
              {node.reviews.map((review, index) => <Button key={JSON.stringify([review.runId, review.editId])} variant="ghost" size="sm" onClick={() => onReview?.(node, review)}
                title={review.label || review.title || review.runId}><GitPullRequest size={12} aria-hidden="true" />{review.label || t(`审阅修改 ${index + 1}`, `Review change ${index + 1}`)}</Button>)}
            </div>}
            {node.folder && node.expanded && (node.loading || node.error || node.loaded && !node.children?.length) && <div className="document-file-directory-status" style={{ '--file-depth': node.level }} role="status">
              {node.loading ? t('正在读取目录…', 'Loading folder…') : node.error || (query ? t('已加载目录没有匹配文件', 'No matches in this loaded folder') : t('空目录', 'Empty folder'))}
              {node.error && <Button variant="ghost" size="sm" onClick={() => onRetry?.(node)}>{t('重试', 'Retry')}</Button>}
            </div>}
            {node.folder && node.expanded && node.nextOffset != null && !node.loading && <div className="document-file-directory-status" style={{ '--file-depth': node.level }}>
              <Button variant="ghost" size="sm" onClick={() => onLoadMore?.(node)}>{t('加载更多文件', 'Load more files')}</Button>
            </div>}
          </React.Fragment>;
        })}
      </div>
      {!rows.length && <div className="document-files-empty"><FileText size={24} aria-hidden="true" /><strong>{empty}</strong>
        <p>{query ? t('试试其他文件名或路径。', 'Try another file name or path.') : mode === 'conversation' ? t('对话中的附件、引用与生成文档会显示在这里。', 'Attachments, references and documents from this conversation appear here.') : t('添加资料，或连接项目的本机目录。', 'Add documents or connect a local project folder.')}</p>
        {canAdd && !query && <Button variant="secondary" size="sm" onClick={onAdd}>{t('添加文件', 'Add files')}</Button>}
      </div>}
    </div>
    {localSearch && <p className="document-files-footnote">{t('本机文件在已展开、已加载的目录中筛选。', 'Local search filters folders that have been expanded and loaded.')}</p>}
  </section>;
}
