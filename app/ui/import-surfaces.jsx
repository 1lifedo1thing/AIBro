import React, { useLayoutEffect, useRef } from 'react';
import { Heading, Text, Button, IconButton, Badge, AlertBanner, Spinner } from './halaska-kit.jsx';
import { KitSelect } from './kit-controls.jsx';
import { Upload, FileText, Check, CircleAlert, ArrowUpRight } from 'lucide-react';
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;

function InputSlot({ attach }) {
  const ref = useRef(null);
  useLayoutEffect(() => attach('urlInput', ref.current), [attach]);
  return <div ref={ref} className="import-url-slot" />;
}
export function ImportSurface({ attach, options = [], target = '', rows = [], busy = false, pending = false, result = null, hasSelection = false, onTarget, onPick, onSubmit, onRetrySave, onClose, onOpen }) {
  const labels = { ready: t('待添加', 'Ready'), saving: t('保存原件…', 'Saving original…'), parsing: t('读取内容…', 'Reading content…'), 'pending-save': t('等待保存', 'Awaiting save'), saved: t('已保存', 'Saved'), failed: t('未添加', 'Not added') };
  const locked = busy || pending;
  return <div className="import-workspace-kit">
    <header className="import-heading"><div><Heading level={2} style={{ margin: 0, fontSize: 22 }}>{t('添加资料', 'Add sources')}</Heading><Text as="p" secondary size="sm" style={{ margin: '7px 0 0', lineHeight: 1.65 }}>{t('选择去向，保存原件，然后在对话中使用。', 'Choose a destination, save originals, then use them in a conversation.')}</Text></div><IconButton icon="×" label={t('关闭添加资料', 'Close add sources')} onClick={onClose} /></header>
    <div className="import-main">
      <div className="import-target"><label htmlFor="importTarget">{t('保存到', 'Save to')}</label><KitSelect id="importTarget" label={t('资料保存位置', 'Source destination')} size="md" options={options} value={target} onChange={onTarget} disabled={locked} /><Text as="p" secondary size="xs" style={{ margin: 0 }}>{t('仅添加到所选位置。AI 分析由你在对话中发起。', 'Sources go only to the selected destination. Start AI analysis from a conversation.')}</Text></div>
      <section className="import-file-picker"><span className="import-upload-icon"><Upload size={23} aria-hidden="true" /></span><div><Heading level={3} style={{ fontSize: 15, margin: 0 }}>{t('文件与原件', 'Files & originals')}</Heading><Text as="p" secondary size="xs" style={{ margin: '5px 0 0', lineHeight: 1.6 }}>PDF · Office · {t('图片 · Markdown · 文本', 'Images · Markdown · Text')}</Text></div><Button variant="outline" size="sm" disabled={locked} onClick={onPick}>{t('选择文件', 'Choose files')}</Button></section>
      <div className="import-link-field"><label htmlFor="urlInput">{t('或添加网页链接', 'Or add a webpage link')}</label><InputSlot attach={attach} /></div>
      {!!rows.length && <section className="import-items" aria-label={t('本次资料', 'Sources in this batch')}><div className="import-items-heading"><Text size="sm">{t('本次添加', 'This batch')}</Text><Badge>{rows.length} {t('项', 'items')}</Badge></div><ul>{rows.map((row, index) => <li key={index} data-import-status={row.status}>
        <span className="import-item-icon" aria-hidden="true">{busy && ['saving', 'parsing', 'pending-save'].includes(row.status) ? <Spinner size={15} /> : row.status === 'saved' ? <Check size={16} /> : row.status === 'failed' ? <CircleAlert size={16} /> : <FileText size={16} />}</span>
        <div className="import-item-copy"><span className="import-item-name" data-user-content>{row.name}</span><span className="import-item-detail">{labels[row.status] || labels.ready}{row.size ? ` · ${row.size}` : ''}</span>{row.error && <span className="import-item-error" data-user-content>{row.error}</span>}</div>
        {row.status === 'saved' && row.id && <Button variant="ghost" size="sm" onClick={() => onOpen(row.id)} iconRight={<ArrowUpRight size={13} aria-hidden="true" />}>{t('查看', 'Open')}</Button>}
      </li>)}</ul></section>}
      <div className="import-result" role="status" aria-live="polite" aria-atomic="true">
        {pending ? <AlertBanner variant="warning" title={t('资料已读取，工作区尚未确认保存', 'Sources read; workspace save is unconfirmed')} description={t('保留了本次记录。重试保存会沿用相同记录，不会再次上传文件。请在退出 App 前完成保存。', 'This batch is retained. Retry saving reuses the same records without uploading again. Finish saving before quitting the app.')} />
          : result && <AlertBanner variant={result.failures?.length ? 'warning' : 'success'} title={result.failures?.length ? t(`已保存 ${result.imported?.length || 0} 项，${result.failures.length} 项未添加`, `${result.imported?.length || 0} saved, ${result.failures.length} not added`) : t(`已保存 ${result.imported?.length || 0} 项资料`, `${result.imported?.length || 0} sources saved`)} description={result.failures?.length ? t('失败项已保留，重试仅处理这些资料。', 'Failed items are retained. Retrying processes only those sources.') : t('现在可以查看原件，或回到对话使用这些资料。PDF 文字索引可能仍在后台处理。', 'Open the originals or use these sources in a conversation. PDF text indexing may still be running.')} />}
        {busy && <Text as="p" size="sm" secondary>{t('正在处理并保存；收起窗口后仍会继续。', 'Processing and saving. You can close this window while it continues.')}</Text>}
      </div>
    </div>
    <footer className="import-footer"><Button variant="ghost" onClick={onClose}>{busy ? t('收起，继续添加', 'Close and continue') : t('关闭', 'Close')}</Button>{pending ? <Button variant="accent" disabled={busy} loading={busy} onClick={onRetrySave}>{t('重试保存', 'Retry saving')}</Button> : <Button variant="accent" disabled={busy || !hasSelection || !target} loading={busy} onClick={onSubmit}>{result?.failures?.length ? t('重试失败项', 'Retry failed sources') : t('添加资料', 'Add sources')}</Button>}</footer>
  </div>;
}
