import React, { useState, useRef, useLayoutEffect } from 'react';
import { Badge, Button, Card, Heading, StatusBadge, Text } from './halaska-kit.jsx';
import { KitTabs } from './kit-controls.jsx';
import styles from '../artifact-provenance.css';

if (!document.getElementById('halaska-artifact-provenance-styles')) {
  const style = document.createElement('style');
  style.id = 'halaska-artifact-provenance-styles';
  style.textContent = styles;
  document.head.appendChild(style);
}

const t = (zh, en) => /^en(?:-|$)/i.test(globalThis.WorkstationI18n?.getLanguage?.() || document.documentElement.lang || '') ? en : zh;
const text = value => typeof value === 'string' ? value : '';
const list = value => Array.isArray(value) ? value : [];
const typeLabel = type => ({ note: t('笔记', 'Note'), import: t('资料', 'Material'), paper: t('论文记录', 'Paper record'), task: t('任务', 'Task'), local: t('本机文件', 'Local file'), web: t('网页', 'Web page') })[type] || t('来源', 'Source');
const actionStyle = { minHeight: 34, height: 'auto', lineHeight: 1.5, whiteSpace: 'normal', textAlign: 'center', maxWidth: '100%' };
const cardStyle = { minWidth: 0, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'none', backdropFilter: 'none', WebkitBackdropFilter: 'none' };

function InputRow({ item, related, busy, act }) {
  // Do not rely on the caller retaining a redacted title after a live access
  // change. Unavailable rows expose neither old titles nor saved locations.
  const available = item.available === true && !item.private && !['unavailable', 'private'].includes(item.status);
  const status = available && ['current', 'changed', 'unretained'].includes(item.status) ? item.status : available ? 'unrecorded' : 'unavailable';
  const title = available ? text(item.title) || t('未命名来源', 'Untitled source') : t('来源当前不可用', 'Source currently unavailable');
  const labels = { current: t('版本一致', 'Version matches'), changed: t('来源已变化', 'Source changed'), unretained: t('未留存摘录', 'Excerpt not retained'), unrecorded: t('未记录版本', 'Version not recorded'), unavailable: t('不可用', 'Unavailable') };
  const pages = [...new Set([item.page, ...list(item.pages)].filter(page => Number.isSafeInteger(page) && page > 0))];
  const offset = Number.isSafeInteger(item.offset) && item.offset >= 0 ? item.offset : null;
  const end = Number.isSafeInteger(item.end) && item.end >= (offset ?? 0) ? item.end : null;
  const detail = available ? text(item.detail) : t('来源或所属项目已不可访问，无法打开原件。', 'The source or its project is inaccessible. The original cannot be opened.');
  return <li className="artifact-provenance-source" data-provenance-source={text(item.key)} data-provenance-source-status={status}>
    <Card padding={14} style={cardStyle}>
      <div className="artifact-provenance-source-top">
        <div className="artifact-provenance-source-copy">
          <div className="artifact-provenance-source-labels"><Badge>{typeLabel(item.type)}</Badge><StatusBadge status={status === 'changed' ? 'pending' : 'default'} pulse={false}>{labels[status]}</StatusBadge>{available && item.excerptState === 'omitted' && status !== 'unretained' && <Badge>{labels.unretained}</Badge>}</div>
          <h4 data-user-content="">{title}</h4>
        </div>
        <Button size="sm" variant="secondary" style={actionStyle} disabled={busy || !available} aria-label={available ? t(`打开来源：${title}`, `Open source: ${title}`) : t('来源不可用，无法打开', 'Source unavailable; cannot open')}
          onClick={() => { if (available) act('open-source', { key: item.key, type: item.type, id: item.id, related: !!related }); }}>
          {t('打开来源', 'Open source')} <span aria-hidden="true">↗</span>
        </Button>
      </div>
      {available && pages.length > 0 && <p className="artifact-provenance-location">{t(`记录页码：${pages.join('、')}`, `Recorded pages: ${pages.join(', ')}`)}</p>}
      {available && offset !== null && <p className="artifact-provenance-location">{t(`记录字符位置：${offset}${end !== null ? `–${end}` : ''}`, `Recorded character position: ${offset}${end !== null ? `–${end}` : ''}`)}</p>}
      {detail && <p className="artifact-provenance-source-detail" data-user-content="">{detail}</p>}
    </Card>
  </li>;
}

function SourceGroup({ items, related = false, recorded, linked, busy, act }) {
  const [page, setPage] = useState(0), surface = useRef(null), pageFocus = useRef(false);
  const pages = Math.ceil(items.length / 20), shown = Math.min(page, Math.max(0, pages - 1));
  useLayoutEffect(() => {
    const clamped = page !== shown;
    if (clamped) setPage(shown);
    if (pageFocus.current || clamped) {
      pageFocus.current = false;
      const target = surface.current?.querySelector('[data-provenance-source] button:not(:disabled)') || surface.current?.querySelector('[data-provenance-group-heading]');
      target?.focus({ preventScroll: true }); target?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    }
  }, [page, shown, items.length]);
  const changePage = next => { if (busy || next < 0 || next >= pages || next === shown) return; pageFocus.current = true; setPage(next); };
  const title = related ? t('当前关联资料', 'Current linked materials') : recorded ? t('记录的输入资料', 'Recorded inputs') : linked ? t('关联运行的输入记录', 'Inputs from the linked run') : t('留存的输入记录', 'Retained input records');
  return <section ref={surface} className="artifact-provenance-group" aria-label={title}>
    <div className="artifact-provenance-group-heading" data-provenance-group-heading tabIndex={-1}><Heading level={3} style={{ fontSize: 16, margin: 0 }}>{title}</Heading><Badge>{items.length}</Badge></div>
    <p className="artifact-provenance-caption">{related
      ? t('这些是条目当前的显式关联，不代表它们参与过本正文的生成。', 'These are the entry’s current explicit links, not proof that they were used to generate this body.')
      : t('版本一致只表示与留存版本匹配，不代表来源支持每一项结论，也不代表已读完全文。', 'A matching version does not establish support for every claim or that the entire source was read.')}</p>
    {items.length ? <ul className="artifact-provenance-sources">{items.slice(shown * 20, shown * 20 + 20).map((item, index) => <InputRow key={item.key || `${item.type}:${item.id}:${shown * 20 + index}`} {...{ item, related, busy, act }}/>)}</ul>
      : <p className="artifact-provenance-empty">{related ? t('没有记录当前关联资料。', 'No current linked materials are recorded.') : t('没有留存可追溯的输入版本。可查看原对话与执行记录了解当时上下文。', 'No traceable input versions were retained. The original conversation and run may provide more context.')}</p>}
    {pages > 1 && <div className="artifact-provenance-origin-actions" role="navigation" aria-label={t(`${title}分页`, `${title} pagination`)}>
      <Button size="sm" variant="ghost" disabled={busy || shown === 0} onClick={() => changePage(shown - 1)}>{t('上一页', 'Previous')}</Button>
      <span aria-live="polite"><Text size="sm" secondary>{t(`第 ${shown + 1} / ${pages} 页 · 共 ${items.length} 项`, `Page ${shown + 1} / ${pages} · ${items.length} items`)}</Text></span>
      <Button size="sm" variant="ghost" disabled={busy || shown >= pages - 1} onClick={() => changePage(shown + 1)}>{t('下一页', 'Next')}</Button>
    </div>}
  </section>;
}

// This surface has no execution or persistence state. The controller reprojects
// the selected body/draft and rechecks every destination before navigation.
export function ArtifactProvenanceSurface({ projection = {}, hasDraft, busy = false, notice = '', canOpenRelations = false, onAction }) {
  const locked = !!busy || typeof onAction !== 'function';
  const act = (action, payload = {}) => { if (!locked) return onAction(action, payload); };
  const available = projection.available === true;
  const variant = projection.variant === 'draft' ? 'draft' : 'body';
  const origin = projection.origin || {};
  const recorded = origin.recorded === true && projection.recordKind === 'recorded';
  const linked = !recorded && projection.recordKind === 'legacy-linked';
  const title = available ? text(projection.title) || t('未命名成果', 'Untitled artifact') : t('成果当前不可用', 'Artifact currently unavailable');
  const timestamp = typeof origin.at === 'number' && origin.at > 0 && Number.isFinite(new Date(origin.at).valueOf()) ? new Date(origin.at) : null;
  const inputs = list(projection.inputs), related = list(projection.related);
  const showVariants = hasDraft === undefined ? projection.hasDraft === true : !!hasDraft;
  const omitted = Number.isSafeInteger(projection.omittedInputs) && projection.omittedInputs > 0 ? projection.omittedInputs : 0;
  const originTitle = recorded ? variant === 'draft' ? t('本草稿生成记录', 'This draft’s generation record') : t('本正文生成记录', 'This body’s generation record')
    : linked ? t('关联历史运行', 'Linked historical run') : t('尚未留存生成记录', 'No generation record retained');
  return <section className="artifact-provenance-surface" aria-label={t('成果溯源', 'Artifact provenance')} aria-busy={!!busy || undefined} data-provenance-variant={variant}>
    <header className="artifact-provenance-header">
      <div className="artifact-provenance-header-copy"><Text size="xs" muted style={{ letterSpacing: '.08em' }}>PROVENANCE</Text><Heading level={2} style={{ fontSize: 23, lineHeight: 1.4, margin: '5px 0 0' }}><span id="artifactProvenanceTitle">{t('成果溯源', 'Artifact provenance')}</span></Heading><p className="artifact-provenance-title" data-user-content="">{title}</p></div>
      <Button id="artifactProvenanceClose" size="sm" variant="ghost" disabled={locked} aria-label={t('关闭成果溯源', 'Close artifact provenance')} onClick={() => act('close')} style={actionStyle}>×</Button>
    </header>
    {!available ? <div className="artifact-provenance-unavailable" role="status"><Heading level={3} style={{ fontSize: 17 }}>{t('无法查看这份成果', 'This artifact cannot be inspected')}</Heading><Text as="p" size="sm" secondary>{text(projection.reason) || t('成果已移除、归档或不可访问。', 'The artifact was removed, archived, or is inaccessible.')}</Text></div> : <>
      {showVariants && <KitTabs value={variant} disabled={locked} label={t('选择正文或待采纳草稿', 'Choose the body or proposed draft')} options={[
        { value: 'body', label: t('当前正文', 'Current body'), id: 'artifactProvenanceBodyTab', controls: 'artifactProvenancePanel' },
        { value: 'draft', label: t('待采纳草稿', 'Proposed draft'), id: 'artifactProvenanceDraftTab', controls: 'artifactProvenancePanel' },
      ]} onChange={next => { if (['body', 'draft'].includes(next)) act('variant', { variant: next }); }}/>}
      <div id="artifactProvenancePanel" className="artifact-provenance-panel" role={showVariants ? 'tabpanel' : undefined} aria-labelledby={showVariants ? variant === 'draft' ? 'artifactProvenanceDraftTab' : 'artifactProvenanceBodyTab' : undefined} tabIndex={showVariants ? 0 : undefined}>
        <Card padding={18} style={cardStyle}>
          <div className="artifact-provenance-origin-heading"><Heading level={3} style={{ fontSize: 17, lineHeight: 1.5, margin: 0 }}>{originTitle}</Heading><Badge variant={recorded ? 'accent' : 'default'}>{recorded ? t('已留存', 'Recorded') : linked ? t('历史关联', 'Historical link') : t('未留存', 'Not recorded')}</Badge></div>
          <p className="artifact-provenance-caption">{recorded ? t('留存的执行与输入版本帮助追溯生成过程；结论仍需结合原文核对。', 'The recorded run and input versions trace generation. Check conclusions against the originals.')
            : linked ? t('旧记录只保留了运行关联，无法确认它生成了当前正文或草稿。', 'The older record retains a run link, but cannot establish that it generated the current body or draft.')
              : t('这份内容没有保存生成时的执行与输入版本，无法补推它的生成来源。', 'No generation run or input versions were saved for this content. Its origin cannot be reconstructed from links alone.')}</p>
          {projection.bodyChanged && <p className="artifact-provenance-change" role="note">{variant === 'draft' ? t('草稿在生成记录建立后有修改；以下记录描述生成时的版本。', 'The draft changed after this record was captured. The record describes its generation-time version.') : t('正文在生成后有修改；以下记录描述生成时的版本。', 'The body changed after generation. The record describes its generation-time version.')}</p>}
          {(timestamp || text(origin.model) || text(origin.provider) || text(origin.effort)) && <dl className="artifact-provenance-metadata">
            {timestamp && <div><dt>{t('记录时间', 'Recorded at')}</dt><dd><time dateTime={timestamp.toISOString()}>{timestamp.toLocaleString(t('zh-CN', 'en-US'), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></dd></div>}
            {[[t('模型', 'Model'), origin.model], [t('服务商', 'Provider'), origin.provider], [t('推理配置', 'Reasoning setting'), origin.effort]].filter(([, value]) => text(value)).map(([label, value]) => <div key={label}><dt>{label}</dt><dd data-user-content="">{value}</dd></div>)}
          </dl>}
          <div className="artifact-provenance-origin-actions">
            <Button id="artifactProvenanceRun" size="sm" variant="secondary" disabled={locked || origin.runAvailable !== true || !origin.runId} style={actionStyle} onClick={() => act('open-run', { runId: origin.runId })}>{t('查看执行记录', 'View run record')}</Button>
            <Button id="artifactProvenanceConversation" size="sm" variant="ghost" disabled={locked || origin.conversationAvailable !== true || !origin.conversationId} style={actionStyle} onClick={() => act('open-conversation', { conversationId: origin.conversationId, userMessageId: origin.userMessageId })}>{t('打开原对话', 'Open original conversation')}</Button>
          </div>
          {((origin.runId && !origin.runAvailable) || (origin.conversationId && !origin.conversationAvailable)) && <p className="artifact-provenance-caption">{t('部分历史记录已不可打开；这里保留可用的溯源信息。', 'Some historical records cannot be opened. Available provenance remains visible here.')}</p>}
        </Card>
        {(omitted > 0 || projection.evidenceLimitReached === true) && <p className="artifact-provenance-change" role="note">{omitted > 0 ? t(`另有 ${omitted} 项输入未留存在这份记录中。`, `${omitted} additional inputs were not retained in this record.`) : ''}{projection.evidenceLimitReached === true ? t(' 旧版记录未完整留存来源身份；这里不能代表当时的完整输入范围。', ' This older record did not retain every source identity; this list does not represent its full input coverage.') : ''}</p>}
        {projection.evidenceExcerptLimitReached === true && <p className="artifact-provenance-change" role="note">{omitted > 0 || projection.evidenceLimitReached === true
          ? t('新增记录的来源编号已保留，部分正文摘录未保存；旧版缺失映射仍不可恢复。', 'Citation identifiers for newly recorded sources were retained, but some text excerpts were not saved. Missing mappings from the older record remain unrecoverable.')
          : t('已记录的来源身份均保留，部分正文摘录未保存，无法在此还原当时未留存的片段。', 'Recorded source identities were retained, but some text excerpts were not saved. Those original passages cannot be reconstructed here.')}</p>}
        <SourceGroup items={inputs} {...{ recorded, linked, busy: locked, act }}/>
        <SourceGroup items={related} related {...{ recorded, linked, busy: locked, act }}/>
      </div>
    </>}
    <footer className="artifact-provenance-footer">
      <p className="artifact-provenance-feedback" role="status" aria-live="polite" aria-atomic="true" data-user-content="">{text(notice) || (busy ? t('正在打开，请稍候…', 'Opening, please wait…') : '')}</p>
      {available && canOpenRelations && <Button id="artifactProvenanceRelations" size="sm" variant="ghost" disabled={locked} style={actionStyle} onClick={() => act('open-relations')}>{t('查看完整关联图', 'View all relationships')}</Button>}
    </footer>
  </section>;
}
