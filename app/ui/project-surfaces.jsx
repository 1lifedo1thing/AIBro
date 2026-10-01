import React, { useLayoutEffect, useRef } from 'react';
import { Button, Badge, Caption, Card, Stat, Progress, EmptyState } from './halaska-kit.jsx';
import { KitSearchInput, KitSelect, KitSegmentedControl } from './kit-controls.jsx';
import styles from './project-surfaces.css';

const t = (zh,en) => document.documentElement.lang.startsWith('en') ? en : zh;
const typeName = option => ({all:t('全部类型','All types'),task:t('任务','Tasks'),note:t('笔记','Notes'),import:t('资料','Sources'),paper:t('论文','Papers'),'pending-analysis':t('待 AI 分析','Awaiting AI analysis')})[option.value] || option.label;

const style = document.createElement('style');
style.id = 'halaska-project-surfaces'; style.textContent = styles; document.head.append(style);

// Keep the actual Kit button and its controlled state; expose the application's
// existing selectors for automation without installing a second click handler.
function Action({ attribute, children, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (attribute) ref.current.querySelector('button')?.setAttribute(attribute, ''); }, [attribute]);
  return <span ref={ref} className="kit-library-action"><Button size="sm" {...props}>{children}</Button></span>;
}

export function ProjectSourceActions({ connected, onAdd, onConnect, busy = false }) {
  return <div className="kit-project-source-actions" aria-label={t('添加项目资料', 'Add project sources')}>
    <Button id="projectAddSource" variant="primary" size="sm" disabled={busy || typeof onAdd !== 'function'} onClick={onAdd}>{t('添加资料', 'Add sources')}</Button>
    {!connected && <Button id="projectLocalFiles" variant="ghost" size="sm" disabled={busy || typeof onConnect !== 'function'} onClick={onConnect}>{t('连接本机目录', 'Connect local folder')}</Button>}
  </div>;
}

export function LibraryToolbar({ query, type, types, sortLabel, view, count, pendingCount = 0, busy, onQuery, onType, onSort, onView, onPending, onCompositionStart, onCompositionEnd }) {
  const pending = Number.isFinite(pendingCount) ? Math.max(0, Math.floor(pendingCount)) : 0;
  return <div className="collection-toolbar kit-library-toolbar">
    <div className="kit-library-search"><KitSearchInput value={query} onChange={onQuery} disabled={busy}
      label={t("搜索工作区内容","Search workspace content")} placeholder={t("搜索名称、标签和状态","Search names, tags, and statuses")} attributes={{ 'data-cui-search': '' }}
      onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} /></div>
    <div className="kit-library-type"><KitSelect value={type} onChange={onType} options={types.map(option=>({...option,label:typeName(option)}))} disabled={busy} label={t("类型筛选","Filter by type")} attributes={{ 'data-cui-type': '' }} /></div>
    <Action attribute="data-cui-sort" variant="ghost" disabled={busy} onClick={onSort} aria-label={t("切换排序","Change sort order")}>{t(sortLabel,sortLabel.replace("更新时间","Updated").replace("名称","Name").replace("类型","Type"))}</Action>
    <KitSegmentedControl label={t("资料显示方式","Source view")} value={view} disabled={busy} onChange={onView}
      options={[
        { value: 'tree', label: t('目录','Tree') }, { value: 'list', label: t('列表','List') }, { value: 'cards', label: t('卡片','Cards') },
      ].map(option => ({ ...option, attributes: { 'data-cui-view': option.value, 'aria-pressed': view === option.value } }))} />
    {pending > 0 && <Action attribute="data-cui-pending" variant="ghost" disabled={busy || typeof onPending !== 'function'} onClick={onPending}
      title={t('查看当前目录待分析的原始资料，不会开始 AI 分析。', 'View sources awaiting analysis in this folder. This does not start AI analysis.')}
      aria-label={t(`查看 ${pending} 份待分析原始资料`, `View ${pending} sources awaiting analysis`)}>{t(`待分析 ${pending}`, `Awaiting analysis ${pending}`)}</Action>}
    <span className="collection-count" role="status"><Badge>{count} {t("项","items")}</Badge></span>
  </div>;
}

export function LibrarySelection({ count, pending, done, notes, imports, comparable, busy, canMerge, canDelete, canAnalyze, canCompare, onCompare, onMerge, onComplete, onReopen, onAnalyze, onDelete, onClear }) {
  if (!count) return null;
  return <section className="collection-batch kit-library-batch" aria-label={t("已选内容的操作","Selected item actions")} aria-busy={busy || undefined}>
    <strong className="kit-selection-count">{t(`已选择 ${count} 项`,`${count} selected`)}</strong>
    {comparable === count && count >= 2 && count <= 4 && <Action attribute="data-cui-compare" variant="secondary" disabled={busy || !canCompare} onClick={onCompare}>{t('并排比较', 'Compare side by side')}</Action>}
    {notes > 1 && notes === count && <Action attribute="data-cui-merge" disabled={busy || !canMerge} onClick={onMerge}>{t("合并为一篇笔记","Merge into one note")}</Action>}
    {!!pending && <Action attribute="data-cui-complete" disabled={busy} onClick={onComplete}>{t("标为完成","Mark completed")} · {pending}</Action>}
    {!!done && <Action attribute="data-cui-reopen" disabled={busy} onClick={onReopen}>{t("标为未完成","Mark incomplete")} · {done}</Action>}
    {!!imports && <Action attribute="data-cui-analyze-selected" variant="accent" disabled={busy || !canAnalyze} onClick={onAnalyze}>{t("交给 AI 分析","Analyze with AI")} · {imports}</Action>}
    <Action attribute="data-cui-delete-selected" variant="ghost" disabled={busy || !canDelete} onClick={onDelete}>{t("移入回收站","Move to Trash")}</Action>
    <Action attribute="data-cui-clear" variant="ghost" disabled={busy} onClick={onClear}>{t("清除选择","Clear selection")}</Action>
    {!!imports && <small>{t("准备对话与附件，发送指令后才开始分析。","Prepares the chat and attachments. Analysis begins when you send the request.")}</small>}
    {busy && <small role="status">{t("正在处理，请稍候…","Processing, please wait…")}</small>}
  </section>;
}

export function LibraryEmpty({ filtered, onReset, onAdd, recordScope = false, onOverview }) {
  return <EmptyState title={filtered ? t('没有匹配内容','No matching items') : recordScope ? t('暂无项目记录','No project records yet') : t('暂无内容','No items yet')}
    description={filtered ? t('清除搜索和类型筛选，重新查看这个位置的内容。','Clear the search and type filter to see everything in this location.') : recordScope ? t('项目记忆、计划与进展日记会显示在这里。','Project memory, plans and progress journals appear here.') : t('添加文件或用 AI 整理后，资料与成果会显示在这里。','Add files or organize them with AI. Your sources and results will appear here.')}
    action={filtered ? <Button variant="outline" size="sm" onClick={onReset}>{t("清除筛选","Clear filters")}</Button> : recordScope && typeof onOverview === 'function' ? <Button variant="outline" size="sm" onClick={onOverview}>{t('查看项目总览','View project overview')}</Button> : typeof onAdd === 'function' ? <Button variant="primary" size="sm" onClick={onAdd}>{t("添加资料","Add sources")}</Button> : undefined} />;
}

export function ProjectMetrics({ pending, done, notes, imports, progress, nextDue }) {
  const en = document.documentElement.lang.startsWith('en');
  const cards = [
    [en ? 'Open tasks' : '未完成任务', pending, en ? `${done} completed` : `已完成 ${done} 项`],
    [en ? 'Knowledge entries' : '知识条目', notes, en ? 'Available in Sources' : '在资料中查看'],
    [en ? 'Original sources' : '原始资料', imports, en ? 'Original files can be previewed' : '原件可预览'],
    [en ? 'Task completion' : '任务完成度', `${progress}%`, nextDue || (en ? 'No due date' : '暂无截止日期')],
  ];
  return <div className="kit-project-metrics">{cards.map(([label, value, caption], index) => <Card key={label} padding={16}>
    <Stat label={label} value={value} />
    <Caption>{caption}</Caption>
    {index === 3 && <div className="kit-project-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><Progress value={progress} height={4} /></div>}
  </Card>)}</div>;
}
