import React, { useId, useState } from 'react';
import { Button, Badge, EmptyState } from './halaska-kit.jsx';
import { KitSearchInput, KitSegmentedControl } from './kit-controls.jsx';
import { FileText, FileCode2, File, Folder, CheckSquare2, BookOpen, ArrowUpRight, GitPullRequest, ChevronDown, ChevronRight } from 'lucide-react';
import styles from './project-outputs.css';

const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang || '') ? en : zh;
const typeLabel = item => item.directory ? t('目录', 'Folder') : ({ note: t('笔记', 'Note'), paper: t('论文', 'Paper'), task: t('任务', 'Task'), import: t('文件', 'File'), local: t('本机文件', 'Local file') })[item.type] || t('成果', 'Output');
const iconFor = item => item.directory ? Folder : item.type === 'task' ? CheckSquare2 : item.type === 'paper' ? BookOpen : item.type === 'note' || /\.(md|txt|pdf)$/i.test(item.title) ? FileText : /\.(js|jsx|ts|tsx|py|swift|rs|css|json|html)$/i.test(item.title) ? FileCode2 : File;
function When({ at }) {
  if (!Number.isFinite(at) || at <= 0 || at > 8640000000000000) return <span>{t('时间未记录', 'Time not recorded')}</span>;
  const date = new Date(at);
  return <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleDateString([], { month: 'short', day: 'numeric' })}</time>;
}
function OriginLabel({ origin, onClick }) {
  if (!origin?.conversationId || origin.conversationAvailable === false)
    return <span title={t('成果已保留，原对话当前不可用。', 'The output is retained; its original conversation is unavailable.')}>{t('来源对话不可用', 'Source conversation unavailable')}</span>;
  return <button type="button" onClick={onClick} title={origin.conversationTitle} data-user-content>{origin.conversationTitle}</button>;
}
function OutputRow({ item, onOpen, onReview, onSource, onRun }) {
  const [expanded, setExpanded] = useState(false), sourcesId = useId(), Icon = iconFor(item), pending = item.group === 'review';
  const primary = pending || !item.open ? onReview : onOpen;
  const actionLabel = pending ? t('审阅', 'Review') : item.directory ? t('查看记录', 'View change') : t('打开', 'Open');
  const hasDetails = item.origins.length > 1 || item.origins.some(origin => origin.runId && origin.runAvailable !== false);
  return <li className={`project-output-row${pending ? ' is-review' : ''}`} data-project-output-key={item.key}>
    <div className="project-output-main">
      <span className="project-output-icon" aria-hidden="true"><Icon size={19} /></span>
      <div className="project-output-copy">
        <button type="button" className="project-output-title" title={item.path || item.title} onClick={event => primary?.(item.key, event.currentTarget)} data-user-content>{item.title}</button>
        <div className="project-output-meta"><span>{typeLabel(item)}</span><span aria-hidden="true">·</span><When at={item.at} />
          {pending && <Badge variant="warning">{t('待审阅', 'To review')}</Badge>}
        </div>
        {item.path && <div className="project-output-path" title={t(`${item.path} · 打开磁盘当前版本`, `${item.path} · Opens the current disk version`)} data-user-content>{item.path}</div>}
        <div className="project-output-origin">{item.source?.conversationId && item.source.conversationAvailable !== false && <span>{t('来自', 'From')}</span>}<OriginLabel origin={item.source} onClick={() => onSource?.(item.key, 0)} />
          {hasDetails && <span className="project-output-more-sources"><Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={sourcesId} onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}{item.origins.length > 1 ? t(`来源记录 ${item.origins.length}`, `${item.origins.length} origins`) : t('执行记录', 'Run details')}</Button></span>}
        </div>
      </div>
      <div className="project-output-actions">
        <Button size="sm" variant={pending ? 'secondary' : 'ghost'} onClick={event => primary?.(item.key, event.currentTarget)} aria-label={`${actionLabel} ${item.title}`} title={item.type === 'local' && !pending && !item.directory ? t('打开磁盘当前版本', 'Open the current disk version') : undefined}>
          {pending ? <GitPullRequest size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{actionLabel}
        </Button>
      </div>
    </div>
    {hasDetails && <ul id={sourcesId} hidden={!expanded} className="project-output-sources" aria-label={t('成果来源记录', 'Output origins')}>{expanded && item.origins.map((origin, index) => <li key={JSON.stringify([origin.recordedConversationId || origin.conversationId, origin.recordedRunId || origin.runId, origin.messageId])}>
      <OriginLabel origin={origin} onClick={() => onSource?.(item.key, index)} /><When at={origin.at} />
      {origin.runId && origin.runAvailable !== false && <Button size="sm" variant="ghost" onClick={() => onRun?.(item.key, index)}>{t('执行记录', 'Run details')}</Button>}
    </li>)}</ul>}
  </li>;
}
export function ProjectOutputsPanel({ available, projectName, items = [], counts = { all: 0, saved: 0, review: 0 }, total = 0, query = '', filter = 'all', page = 0, pages = 1,
  noOutputRuns = [], completedWithoutOutput = 0, showEmptyRuns, moreEmptyRuns = 0, onMoreEmptyRuns, onQuery, onFilter, onReset, onPage, onToggleEmptyRuns, onOpen, onReview, onSource, onRun, onEmptyRun, onStartConversation }) {
  const historyId = useId();
  if (!available) return <section className="project-outputs-kit"><style>{styles}</style><EmptyState title={t('项目当前不可用', 'Project unavailable')} description={t('返回项目列表，选择一个可用项目。', 'Choose an available project from the project list.')} /></section>;
  const filtered = !!query.trim() || filter !== 'all';
  return <section className="project-outputs-kit" aria-label={t('项目成果', 'Project outputs')}>
    <style>{styles}</style>
    {(counts.all > 0 || filtered) && <div className="project-outputs-toolbar">
      <KitSegmentedControl label={t('成果状态', 'Output status')} value={filter} onChange={onFilter} options={[
        { value: 'all', label: t(`全部 ${counts.all}`, `All ${counts.all}`) }, { value: 'saved', label: t(`已保存 ${counts.saved}`, `Saved ${counts.saved}`) }, { value: 'review', label: t(`待审阅 ${counts.review}`, `Review ${counts.review}`) }
      ]} />
      <KitSearchInput label={t('搜索成果名称、路径或来源对话', 'Search outputs, paths or source conversations')} placeholder={t('搜索成果或来源对话…', 'Search outputs or conversations…')} value={query} onChange={onQuery} />
    </div>}
    <p className={`project-outputs-result-count${filtered ? '' : ' is-visually-hidden'}`} role="status">{t(`${total} 项${filtered ? '匹配' : '可用'}成果`, `${total} ${filtered ? 'matching' : 'available'} outputs`)}</p>
    {!items.length && <div className="project-outputs-empty"><EmptyState icon={<FileText size={27} aria-hidden="true" />} title={filtered ? t('没有匹配的成果', 'No matching outputs') : t('这里还没有可打开的成果', 'No outputs to open yet')}
      description={filtered ? t('试试其他名称，或清除筛选。', 'Try another name or clear the filters.') : t('项目对话中保存的文档和待审阅修改会显示在这里。', 'Documents saved in project conversations and changes awaiting review appear here.')}
      action={filtered ? <Button size="sm" variant="secondary" onClick={onReset}>{t('清除筛选', 'Clear filters')}</Button> : onStartConversation ? <Button size="sm" onClick={onStartConversation}>{t('开始项目对话', 'Start a project conversation')}</Button> : undefined} /></div>}
    {!!items.length && <ul className="project-output-list" aria-label={t(`${projectName}的成果列表`, `Outputs in ${projectName}`)}>{items.map(item => <OutputRow key={item.key} item={item} onOpen={onOpen} onReview={onReview} onSource={onSource} onRun={onRun} />)}</ul>}
    {pages > 1 && <nav className="project-outputs-pagination" aria-label={t('成果分页', 'Output pages')}><Button size="sm" variant="ghost" disabled={page === 0} onClick={() => onPage?.(page - 1)}>{t('上一页', 'Previous')}</Button><span>{page + 1} / {pages}</span><Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => onPage?.(page + 1)}>{t('下一页', 'Next')}</Button></nav>}
    {!!completedWithoutOutput && !filtered && <aside className="project-outputs-no-result"><Button size="sm" variant="ghost" aria-expanded={!!showEmptyRuns} aria-controls={historyId} onClick={onToggleEmptyRuns}>{showEmptyRuns ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}<span>{t(`无成果的执行 · ${completedWithoutOutput}`, `Runs without outputs · ${completedWithoutOutput}`)}</span></Button>
      <div id={historyId} hidden={!showEmptyRuns}>{showEmptyRuns && <><p>{t('这些执行没有当前可打开的成果，查看记录了解详情。', 'These runs have no output currently available. Open a run for details.')}</p>
        <ul>{noOutputRuns.map(run => <li key={run.runId}><span data-user-content>{run.conversationTitle}</span><When at={run.at} /><Button size="sm" variant="ghost" onClick={() => onEmptyRun?.(run.runId)}>{t('查看执行', 'View run')}</Button></li>)}</ul>{moreEmptyRuns > 0 && <Button size="sm" variant="ghost" onClick={onMoreEmptyRuns}>{t(`加载更多执行记录（剩余 ${moreEmptyRuns}）`, `Load more runs (${moreEmptyRuns} remaining)`)}</Button>}</>}
      </div></aside>}
  </section>;
}
