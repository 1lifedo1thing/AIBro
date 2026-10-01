import React from 'react';
import { Button } from './halaska-kit.jsx';
import { KitSegmentedControl } from './kit-controls.jsx';
import styles from './document-toolbar.css';

export function DocumentToolbar({ mode = 'read', loading = false, saving = false, dirty = false,
  canVisual = true, onMode, onSave, onClose, onFind, onOutline, onInsertImage, imageBusy = 0, outlineOpen = false, status = '' }) {
  const english = /^en(?:-|$)/i.test(document.documentElement.lang || '');
  const t = (zh, en) => english ? en : zh;
  const current = mode === 'preview' ? 'read' : mode;
  return <div className="document-toolbar-kit" role="toolbar" aria-label={t('文档阅读与编辑', 'Document reading and editing')}>
    <style>{styles}</style>
    <KitSegmentedControl value={current} disabled={loading || saving} onChange={onMode}
      options={[
        { value: 'read', label: t('阅读', 'Read') },
        { value: 'rich', label: t('编辑', 'Edit'), disabled: !canVisual },
        { value: 'edit', label: t('源码', 'Source') },
      ]} />
    <div className="document-toolbar-kit-tools">
      {onInsertImage && current !== 'read' && <Button variant="ghost" size="sm" onClick={onInsertImage} disabled={loading || saving || !!imageBusy} title={t('选择图片，或直接粘贴、拖入正文', 'Choose images, or paste and drop into the document')}>
        {imageBusy ? t('正在保存图片…', 'Saving images…') : t('插入图片', 'Insert image')}</Button>}
      {onOutline && <Button variant="ghost" size="sm" onClick={onOutline} aria-pressed={outlineOpen} disabled={loading}>
        {t('大纲', 'Outline')}</Button>}
      {onFind && current === 'edit' && <Button variant="ghost" size="sm" onClick={onFind} disabled={loading} title={t('查找与替换（⌘F）', 'Find and replace (⌘F)')}>
        {t('查找', 'Find')}</Button>}
    </div>
    <span className="document-toolbar-kit-state" role="status" aria-live="polite" title={status || undefined}>
      {loading ? t('正在载入…', 'Loading…') : imageBusy ? t('正在保存图片…', 'Saving images…') : saving ? t('保存中…', 'Saving…') : dirty ? t('未保存', 'Unsaved') : t('已保存', 'Saved')}
    </span>
    {(current !== 'read' || dirty) && <div className="document-toolbar-kit-actions">
      <Button variant="ghost" size="sm" disabled={saving || loading} onClick={onClose}>{t('完成', 'Done')}</Button>
      <Button variant="primary" size="sm" loading={saving} disabled={loading || (!dirty && !imageBusy)} onClick={onSave} title={t('保存（⌘S）', 'Save (⌘S)')}>
        {saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}</Button>
    </div>}
  </div>;
}
