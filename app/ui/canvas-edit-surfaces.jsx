import React from 'react';
import { Badge, Button, StatusBadge } from './halaska-kit.jsx';

const t=(zh,en)=>document.documentElement.lang.startsWith('en')?en:zh;
export function CanvasEditSurface({selection,instruction,output,status,error,diff,saved,onInstruction,onGenerate,onStop,onApply,onUndo,onClose,onCopy}) {
 const generating=status==='generating',ready=status==='ready',applied=status==='applied';
 const label={editing:t('选区改写','Rewrite selection'),generating:t('正在生成草稿','Generating draft'),ready:t('等待审阅','Ready to review'),applied:saved?t('已保存','Saved'):t('已应用到草稿','Applied to draft'),undone:t('已撤销到草稿','Undone in draft'),stopped:t('已停止','Stopped'),error:t('生成失败','Generation failed')}[status];
 const submit=event=>{if(!event.isComposing&&!event.nativeEvent?.isComposing&&event.keyCode!==229&&(event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();event.stopPropagation();if(!generating)onGenerate();}};
 return <section className="canvas-edit" aria-label={t('AI 选区改写','AI selection rewrite')} aria-busy={generating}>
  <header className="canvas-edit-header"><div><strong>{t('AI 改写','AI rewrite')}</strong><Badge>{Array.from(selection.text).length} {t('字选区','selected characters')}</Badge></div><Button size="sm" variant="ghost" onClick={onClose} aria-label={t('关闭选区改写','Close selection rewrite')}>{t('关闭','Close')}</Button></header>
  <p className="canvas-edit-scope">{t('只改写选中文字。先审阅，再应用到草稿；点击文档「保存」后才写入笔记。','Rewrite only this selection. Review and apply to the draft; use the document Save action to store it.')}</p>
  <details className="canvas-edit-selection"><summary>{t('查看原选区','View original selection')}</summary><pre data-user-content>{selection.text}</pre></details>
  <label className="canvas-edit-instruction"><span>{t('改写要求','Rewrite instructions')}</span><textarea value={instruction} rows={3} maxLength={4000} disabled={generating} onChange={event=>onInstruction(event.target.value)} onKeyDown={submit} placeholder={t('例如：保留结论与引用，把这一段写得更清楚、更精炼。','For example: make this paragraph clearer and shorter while preserving conclusions and citations.')} /></label>
  <div className="canvas-edit-actions">{generating?<Button size="sm" variant="secondary" onClick={onStop}>{t('停止生成','Stop')}</Button>:<Button size="sm" variant="accent" onClick={onGenerate} disabled={!instruction.trim()||applied||status==='undone'}>{output?t('重新生成','Generate again'):t('生成改写','Generate rewrite')}</Button>}<span className="canvas-edit-status" role="status" aria-live="polite"><StatusBadge status={generating?'pending':applied?'online':'default'}>{label}</StatusBadge></span></div>
  {error&&<p className="canvas-edit-error" role="alert">{error}</p>}
  {!!output&&<div className="canvas-edit-diff" aria-label={t('选区差异','Selection changes')}>
   <section><h4>{t('原文','Original')}</h4><pre data-user-content>{diff.prefix}<del>{diff.removed}</del>{diff.suffix}</pre></section>
   <section><h4>{generating?t('生成中 · 尚不可应用','Generating · not ready to apply'):t('改写草稿','Rewrite draft')}</h4><pre data-user-content>{diff.prefix}<ins>{diff.added}</ins>{diff.suffix}</pre></section>
  </div>}
  {!!output&&<div className="canvas-edit-actions canvas-edit-result-actions"><Button size="sm" variant="ghost" disabled={generating} onClick={onCopy}>{t('复制结果','Copy result')}</Button>{ready&&<Button size="sm" variant="accent" onClick={onApply}>{t('应用到草稿','Apply to draft')}</Button>}{applied&&<Button size="sm" variant="secondary" onClick={onUndo}>{t('撤销本次改写','Undo rewrite')}</Button>}{(applied||status==='undone')&&<span>{t('需要点击文档「保存」才写入。','Use the document Save action to store this change.')}</span>}</div>}
 </section>;
}
