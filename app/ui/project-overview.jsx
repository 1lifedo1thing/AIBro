import React from 'react';
import { Button, EmptyState, Heading } from './halaska-kit.jsx';
import styles from './project-overview.css';

if (!document.getElementById('halaska-project-overview')) {
  const style = document.createElement('style'); style.id = 'halaska-project-overview'; style.textContent = styles; document.head.append(style);
}
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang || '') ? en : zh;
const count = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const text = value => typeof value === 'string' ? value : '';
const list = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
const callback = value => typeof value === 'function' ? value : undefined;

function OutputRow({ item, onOutput }) {
  const title = text(item.title) || t('未命名成果', 'Untitled output');
  const status = item.review ? t('待审阅', 'Needs review') : text(item.statusLabel);
  return <li className="project-overview-row" data-overview-output={item.key}>
    <Button variant="ghost" size="sm" disabled={!callback(onOutput)} title={title}
      onClick={callback(onOutput) ? event => onOutput(item.key, event.currentTarget) : undefined}>
      <span className="project-overview-row-copy"><strong data-user-content>{title}</strong>
        <span className="project-overview-row-meta">{text(item.typeLabel) && <span>{item.typeLabel}</span>}
          {status && <span className={item.review ? 'project-overview-review' : undefined}>{status}</span>}
          {text(item.updatedLabel) && <span>{item.updatedLabel}</span>}</span>
      </span><span className="project-overview-row-arrow" aria-hidden="true">↗</span>
    </Button>
  </li>;
}
function TaskRow({ item, onTask }) {
  const title = text(item.title) || t('未命名任务', 'Untitled task');
  return <li className="project-overview-row" data-overview-task={item.id}>
    <Button variant="ghost" size="sm" disabled={!callback(onTask)} title={title}
      onClick={callback(onTask) ? event => onTask(item.id, event.currentTarget) : undefined}>
      <span className="project-overview-row-copy"><strong data-user-content>{title}</strong>
        <span className="project-overview-row-meta">{text(item.statusLabel) && <span>{item.statusLabel}</span>}{text(item.dueLabel) && <span>{item.dueLabel}</span>}</span>
      </span><span className="project-overview-row-arrow" aria-hidden="true">↗</span>
    </Button>
  </li>;
}

export function ProjectOverview({ available = false, description = '', taskCount = 0, doneCount = 0, sourceCount = 0, recordCount = 0, outputCount = 0, reviewCount = 0,
  tasks = [], outputs = [], onTask, onOutput, onNavigate, onAddSources, onAddTask, onStart }) {
  // Availability is authoritative: stale labels/rows from an inaccessible
  // project must not be rendered behind an empty state.
  if (!available) return <section className="project-overview-kit project-overview-unavailable"><div className="project-overview-empty">
    <EmptyState title={t('项目当前不可用', 'Project unavailable')} description={t('选择一个可用项目继续。', 'Choose an available project to continue.')} />
  </div></section>;
  const nextTasks = list(tasks).slice(0, 3), recentOutputs = list(outputs).slice(0, 4);
  const sources = count(sourceCount), records = count(recordCount), results = count(outputCount), reviews = count(reviewCount);
  const totalTasks = count(taskCount), pending = Math.max(0, totalTasks - count(doneCount));
  const hasContent = sources > 0 || records > 0 || results > 0 || reviews > 0 || totalTasks > 0 || nextTasks.length > 0 || recentOutputs.length > 0;
  const navigate = section => callback(onNavigate) ? () => onNavigate(section) : undefined;
  const intro = text(description).trim();
  if (!hasContent) return <section className="project-overview-kit" aria-label={t('项目总览', 'Project overview')}>
    {intro && <p className="project-overview-description" data-user-content>{description}</p>}
    <div className="project-overview-empty project-overview-start"><EmptyState title={t('从第一份资料开始', 'Start with your first source')}
      description={t('添加资料，或在项目中开启一段对话。', 'Add a source or start a conversation in this project.')}
      action={<div className="project-overview-start-actions">
        <Button variant="primary" size="sm" disabled={!callback(onAddSources)} onClick={callback(onAddSources)}>{t('添加资料', 'Add sources')}</Button>
        <Button variant="ghost" size="sm" disabled={!callback(onStart)} onClick={callback(onStart)}>{t('新建对话', 'New conversation')}</Button>
      </div>} /></div>
  </section>;
  return <section className="project-overview-kit" aria-label={t('项目总览', 'Project overview')}>
    {intro && <p className="project-overview-description" data-user-content>{description}</p>}
    <nav className="project-overview-counts" aria-label={t('项目内容概况', 'Project contents')}>
      <span data-overview-nav="knowledge"><Button variant="ghost" size="sm" disabled={!callback(onNavigate)} onClick={navigate('knowledge')}>
        <span>{t('资料', 'Sources')}</span><strong>{sources}</strong>{records > 0 && <small>{t(`项目记录 ${records}`, `${records} project records`)}</small>}
      </Button></span>
      <span data-overview-nav="outputs"><Button variant="ghost" size="sm" disabled={!callback(onNavigate)} onClick={navigate('outputs')}>
        <span>{t('成果', 'Outputs')}</span><strong>{results}</strong>{reviews > 0 && <small className="project-overview-review">{t(`${reviews} 待审阅`, `${reviews} to review`)}</small>}
      </Button></span>
      <span data-overview-nav="tasks"><Button variant="ghost" size="sm" disabled={!callback(onNavigate)} onClick={navigate('tasks')}>
        <span>{t('待办', 'To do')}</span><strong>{pending}</strong>
      </Button></span>
    </nav>
    <div className="project-overview-sections">
      <section className="project-overview-section" aria-label={t('最近成果', 'Recent outputs')}>
        <header><Heading level={3}>{t('最近成果', 'Recent outputs')}</Heading><Button variant="ghost" size="sm" disabled={!callback(onNavigate)} onClick={navigate('outputs')}
          aria-label={t('查看全部成果', 'View all outputs')}>{t('查看全部', 'View all')}</Button></header>
        {recentOutputs.length > 0 ? <ul className="project-overview-list">{recentOutputs.map(item => <OutputRow key={item.key} item={item} onOutput={onOutput} />)}</ul>
          : <div className="project-overview-empty"><EmptyState title={t('暂无成果', 'No outputs yet')}
            action={<Button variant="ghost" size="sm" disabled={!callback(onStart)} onClick={callback(onStart)}>{t('开始对话', 'Start a conversation')}</Button>} /></div>}
      </section>
      <section className="project-overview-section" aria-label={t('下一步任务', 'Next tasks')}>
        <header><Heading level={3}>{t('下一步任务', 'Next tasks')}</Heading><Button variant="ghost" size="sm" disabled={!callback(onNavigate)} onClick={navigate('tasks')}
          aria-label={t('查看全部任务', 'View all tasks')}>{t('查看全部', 'View all')}</Button></header>
        {nextTasks.length > 0 ? <ul className="project-overview-list">{nextTasks.map(item => <TaskRow key={item.id} item={item} onTask={onTask} />)}</ul>
          : <div className="project-overview-empty"><EmptyState title={t('暂无待办', 'No tasks to do')}
            action={<Button variant="ghost" size="sm" disabled={!callback(onAddTask)} onClick={callback(onAddTask)}>{t('添加任务', 'Add task')}</Button>} /></div>}
      </section>
    </div>
  </section>;
}
