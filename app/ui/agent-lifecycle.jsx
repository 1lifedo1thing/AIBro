import React from 'react';
import { Orb, StatusBadge, Button, Card, Heading, Kbd, Caption, Text } from './halaska-kit.jsx';
import { AICSSThinkingState } from './aicss-thinking-state.jsx';
import { KitTabs } from './kit-controls.jsx';

const uiLabel = text => window.WorkstationI18n?.t(text) || text;

export function AgentProcessTabs({ messageId, value, progressCount, toolCount, progressPanelId, toolsPanelId }) {
  const t = (zh, en) => window.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  // Keep labels stable: upstream Tabs keys its buttons by label. New events
  // must update counts without replacing the focused tab during streaming.
  const options = [
    { value: 'progress', label: t('进展', 'Progress'), id: progressPanelId + '-tab', controls: progressPanelId,
      attributes: { 'aria-label': t(`进展，${progressCount} 项记录`, `Progress, ${progressCount} entries`) } },
    { value: 'tools', label: t('工具', 'Tools'), id: toolsPanelId + '-tab', controls: toolsPanelId,
      attributes: { 'aria-label': t(`工具，${toolCount} 次调用`, `Tools, ${toolCount} calls`) } },
  ];
  return <div className="halaska-process-tabs">
    <KitTabs options={options} value={value} label={t('查看执行过程', 'Inspect this run')}
      onChange={view => document.dispatchEvent(new CustomEvent('conversation-process-view', { detail: { messageId, view } }))} />
    <Caption style={{ fontSize: 10, lineHeight: 1.6 }}>
      {t(`${progressCount} 项进展 · ${toolCount} 次工具调用`, `${progressCount} entries · ${toolCount} tool calls`)}
    </Caption>
  </div>;
}

// Adapted lifecycle structure, driven only by recorded run events. In
// particular, none of the reference patterns' timers or demo actions run here.
export function AgentLifecycleSummary({ phase, status, label, detail, count, elapsed, startedAt, keyboardHint }) {
  const live = status === 'running';
  const tone = status === 'failed' ? 'error' : status === 'awaiting-approval' ? 'pending'
    : ['completed', 'completed-local', 'done'].includes(status) ? 'online' : 'default';
  return <span className="halaska-lifecycle-line" data-lifecycle-status={status}>
    {live ? <span className="progress-heading-mark progress-activity" aria-hidden="true">
      <Orb variant={phase === 'tool' ? 'orbit' : phase === 'writing' ? 'sweep' : 'pulse'} size={20} label={label} />
    </span> : null}
    {live ? <span className="progress-phase-label"><AICSSThinkingState label={label} active /></span> : <StatusBadge status={tone}>{label}</StatusBadge>}
    {detail ? <span className="progress-heading-text" data-user-content="">{detail}</span> : null}
    <span className="progress-count">{count}</span>
    {elapsed ? <span className="progress-elapsed" data-progress-start={live && startedAt > 0 ? startedAt : undefined}>{elapsed}</span> : null}
    <span className="halaska-lifecycle-key" aria-hidden="true"><Kbd>↵</Kbd><span>{keyboardHint}</span></span>
    <span className="progress-chevron" aria-hidden="true">›</span>
  </span>;
}

// This component owns only the contents of a native summary. The host keeps
// disclosure state, persisted user pins, keyboard focus and the full body.
export function AgentActivitySummary({ title, kindLabel, status, statusLabel, active = false, elapsed = '', countLabel = '', detail = '' }) {
  const tone = status === 'failed' ? 'error'
    : ['pending', 'awaiting-approval', 'awaiting-save', 'rejected'].includes(status) ? 'pending'
    : ['completed', 'completed-local', 'done'].includes(status) ? 'online'
    : status === 'running' && active ? 'accent' : 'default';
  return <span className="halaska-activity-line" data-activity-status={status}>
    <span className="halaska-activity-heading" data-user-content="">
      <Text size="sm" weight="medium" style={{ fontSize: 12, lineHeight: 1.65, color: 'inherit' }}>
        {active ? <AICSSThinkingState label={title} active /> : title}
      </Text>
      {countLabel ? <Caption style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{countLabel}</Caption> : null}
    </span>
    <span className="halaska-activity-meta">
      {kindLabel ? <Caption style={{ fontSize: 10 }}>{kindLabel}</Caption> : null}
      {elapsed ? <Caption style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{elapsed}</Caption> : null}
      <span className="halaska-activity-state"><StatusBadge status={tone}>{statusLabel}</StatusBadge></span>
    </span>
    {detail ? <span className="halaska-activity-group-detail"><Caption style={{ fontSize: 11, lineHeight: 1.6 }}>{detail}</Caption></span> : null}
  </span>;
}

export function AgentLifecycleActions({ status, title, description, hint, statusLabel, actions = [], compact = false, diagnosticDetails = [], diagnosticLabel = '诊断详情', diagnosticOpen = false }) {
  const buttons = <div className="halaska-lifecycle-buttons">
    {actions.map(action => <span key={action.key} data-lifecycle-action={action.key}>
      <Button variant={action.variant || 'secondary'} size="sm" disabled={action.disabled} title={action.title}
        style={{ height: 'auto', minHeight: 32, whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.4 }}>
        {uiLabel(action.label)}
      </Button>
    </span>)}
  </div>;
  if (compact) return buttons;
  return <Card padding={14} style={{ borderRadius: 14, boxShadow: 'none', background: 'var(--panel)' }}>
    <div className="halaska-lifecycle-card" data-lifecycle-status={status}>
      <div className="halaska-lifecycle-card-heading">
        <Heading level={6} style={{ fontSize: 13, lineHeight: 1.55 }}>{title}</Heading>
        <StatusBadge status={status === 'failed' ? 'error' : status === 'awaiting-approval' ? 'pending' : 'default'}>
          {statusLabel}
        </StatusBadge>
      </div>
      {description ? <p className="halaska-lifecycle-description" data-user-content="">{description}</p> : null}
      {buttons}
      {status === 'failed' && diagnosticDetails.length > 0 ? <details className="halaska-failure-diagnostics" open={diagnosticOpen}
        style={{ minWidth: 0, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, lineHeight: 1.6, padding: '3px 0', overflowWrap: 'anywhere' }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || event.key !== 'Enter' || event.repeat || event.isComposing || event.nativeEvent?.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault(); event.currentTarget.click();
          }}>
          <Caption style={{ fontSize: 11, lineHeight: 1.6 }}>{diagnosticLabel}</Caption>
        </summary>
        <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.5fr)', gap: '6px 12px', margin: '8px 0 0', minWidth: 0 }}>
          {diagnosticDetails.map((row, index) => <React.Fragment key={index}>
            <dt style={{ minWidth: 0, overflowWrap: 'anywhere' }}><Caption style={{ fontSize: 11, lineHeight: 1.6 }}>{row.label}</Caption></dt>
            <dd style={{ margin: 0, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><Text size="xs" style={{ fontSize: 11, lineHeight: 1.6 }}>{row.value}</Text></dd>
          </React.Fragment>)}
        </dl>
      </details> : null}
      {hint ? <Caption style={{ display: 'block', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{hint}</Caption> : null}
    </div>
  </Card>;
}

export function AgentReceipt({ title, description, label }) {
  return <div className="halaska-agent-receipt">
    <div className="halaska-lifecycle-card-heading">
      <Heading level={6} style={{ fontSize: 13, lineHeight: 1.55 }}>{title}</Heading>
      <StatusBadge status="online">{label}</StatusBadge>
    </div>
    {description ? <Caption style={{ display: 'block', fontSize: 11, lineHeight: 1.6 }}>{description}</Caption> : null}
  </div>;
}
