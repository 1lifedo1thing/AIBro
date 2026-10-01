import React, { useState } from 'react';
import { Badge, Button, Caption } from './halaska-kit.jsx';
const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement.lang)?en:zh;
const summaryKey=event=>{if(event.target!==event.currentTarget||event.key!=='Enter'||event.repeat||event.isComposing||event.nativeEvent?.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;event.preventDefault();event.currentTarget.click();};
const privateSource=(source,status=source.status)=>source.private||status?.kind==='private';
const privateNotice=()=>t('该来源已设为私密，标题与摘录已隐藏。','This source is private. Its title and excerpt are hidden.');
const unretained=source=>source.excerptState==='omitted'||source.status?.kind==='unretained';
export function CitationPeek({ source, status, location, index=0, count=1, onOpen, onPrevious, onNext, onClose, busy=false, error='' }) {
 const hidden=privateSource(source,status),omitted=source.excerptState==='omitted'||status.kind==='unretained';
 return <div className="citation-peek">
  <header className="citation-peek-heading"><Badge>{source.provided?t('本轮来源','Request source'):t('参考资料','Reference')}</Badge><Caption>{count>1?`${index+1} / ${count}`:''}</Caption></header>
  <strong data-user-content>{hidden?t('私密来源','Private source'):source.title}</strong>
  {!hidden&&!!location&&<small className="citation-location" data-user-content>{location}</small>}
  <p className="citation-excerpt" data-user-content>{hidden?privateNotice():omitted?t('本轮已保留来源编号，但正文摘录未保存，无法在此还原当时提供的片段。','The citation identifier was retained, but its text excerpt was not saved. The originally supplied passage cannot be reconstructed here.'):source.excerpt||source.legacyPreview||(source.media==='page_image'?t('本轮提供了此页图像，没有保存可复制的文字摘录。','This page image was supplied; no copyable text excerpt was recorded.'):source.media?t('本轮提供了原始文件，没有保存可复制的文字摘录。','The original file was supplied; no copyable text excerpt was recorded.'):t('未保存该来源的实际摘录。','No request excerpt was recorded.'))}</p>
  <div className={`citation-notice is-${hidden?'private':status.kind}`}>{hidden?privateNotice():status.notice}</div>
  {!hidden&&error&&<div className="citation-error" role="alert">{error}</div>}
  <footer className="citation-peek-actions"><Button id="citationOpenOriginal" variant="ghost" size="sm" disabled={hidden||!status.canOpen||busy} loading={busy} onClick={onOpen}>{t('打开原文 ↗','Open original ↗')}</Button><div className="citation-pager"><Button id="citationPrevious" variant="ghost" size="sm" disabled={index===0||busy} onClick={onPrevious} aria-label={t('上一个来源','Previous source')}>←</Button><Button id="citationNext" variant="ghost" size="sm" disabled={index>=count-1||busy} onClick={onNext} aria-label={t('下一个来源','Next source')}>→</Button><Button id="citationClose" variant="ghost" size="sm" onClick={onClose} aria-label={t('关闭来源预览','Close source preview')}>×</Button></div></footer>
 </div>;
}
function EvidenceMetrics({values=[]}) {
 return values.length?<dl className="citation-evidence-metrics">{values.map(({label,value})=><div key={label}><dt>{label}</dt><dd><Badge>{value}</Badge></dd></div>)}</dl>:null;
}
function EvidenceContext({retrieval,attachments,onInspect,onBind}) {
 if(!retrieval&&!attachments)return null;
 return <details className="citation-context-details"><summary onKeyDown={summaryKey}>{t('检索与附件详情','Search and attachment details')}</summary>
  {retrieval&&<section className="citation-context-group" aria-label={t('检索范围','Search coverage')}><Caption>{retrieval.strategy==='hybrid-rrf'?t('混合检索','Hybrid search'):retrieval.strategy==='local-bm25'?t('关键词检索','Keyword search'):t('检索记录','Search record')}</Caption><EvidenceMetrics values={retrieval.metrics}/>{retrieval.notes.map(note=><p key={note}>{note}</p>)}</section>}
  {attachments&&<section className="citation-context-group" aria-label={t('附件准备记录','Attachment preparation')}><Caption>{t('附件准备记录','Attachment preparation')}</Caption><EvidenceMetrics values={attachments.metrics}/>{attachments.textMetrics?.length>0&&<EvidenceMetrics values={attachments.textMetrics}/>}<div className="citation-attachment-links">{attachments.sources.map(source=><span key={source.sourceId} onFocusCapture={event=>{if(!privateSource(source))onBind?.(source,event.target.closest('button'));}} onPointerOverCapture={event=>{if(!privateSource(source))onBind?.(source,event.target.closest('button'));}}><Button variant="ghost" size="sm" disabled={privateSource(source)||!source.status.canOpen} onClick={event=>onInspect?.(source,event.currentTarget)}><span data-user-content>{privateSource(source)?t('私密来源','Private source'):source.title}</span></Button></span>)}</div>{attachments.notes.map(note=><p key={note}>{note}</p>)}</section>}
 </details>;
}
export function CitationSourceList({sources=[],onInspect,onBind,limited=false,excerptLimited=false,retrieval=null,attachments=null}) {
 const [page,setPage]=useState(0),total=Math.ceil(sources.length/20),shown=Math.min(page,Math.max(0,total-1));
 return <div className="citation-source-list">
  {sources.length>0&&<p className="citation-list-note">{t('来源归属与已保存摘录供你核对；列入参考资料不代表支持回答中的每个判断。','Inspect attribution and saved excerpts. Listing a reference does not establish support for every claim.')}</p>}
  {limited&&<p className="citation-list-note">{t('旧版记录中，部分已提供材料未保存引用映射；此处不会补造历史引用编号。','In this older record, some supplied material has no saved citation mapping. Missing historical identifiers have not been reconstructed.')}</p>}
  {excerptLimited&&<p className="citation-list-note">{limited
   ?t('新增记录的来源编号已保留，部分正文摘录未保存；旧版缺失映射仍不可恢复。','Citation identifiers for newly recorded sources were retained, but some text excerpts were not saved. Missing mappings from the older record remain unrecoverable.')
   :t('来源编号已完整保留，部分正文摘录未保存。','All citation identifiers were retained; some text excerpts were not saved.')}</p>}
  {sources.length>0&&<ul>{sources.slice(shown*20,shown*20+20).map(source=><li key={source.sourceId} onFocusCapture={event=>{if(!privateSource(source))onBind?.(source,event.target.closest('button'));}} onPointerOverCapture={event=>{if(!privateSource(source))onBind?.(source,event.target.closest('button'));}}>
   <div className="citation-source-title"><Badge>{source.number||'↗'}</Badge><Button variant="ghost" size="sm" disabled={privateSource(source)} onClick={event=>onInspect?.(source,event.currentTarget)}><span data-user-content>{privateSource(source)?t('私密来源','Private source'):source.title}</span></Button></div>
   {!privateSource(source)&&source.location&&<small data-user-content>{source.location}</small>}
   <p>{privateSource(source)?privateNotice():unretained(source)?t('来源编号已保留 · 文字摘录未保存','Citation identifier retained · text excerpt not saved'):source.provided?(source.media==='page_image'?t('已提供页面图像','Page image supplied'):source.media?t('已提供原件','Original supplied'):t('已提供文字片段','Text excerpt supplied')):t('参考资料 · 无引用映射','Reference · no citation mapping')}{!privateSource(source)&&['missing','changed','draft','unretained'].includes(source.status.kind)?' · '+source.status.notice:''}</p>
  </li>)}</ul>}
  {total>1&&<div className="citation-list-pager"><Button variant="ghost" size="sm" disabled={shown===0} onClick={()=>setPage(shown-1)}>{t('上一页','Previous')}</Button><Caption>{shown+1} / {total}</Caption><Button variant="ghost" size="sm" disabled={shown>=total-1} onClick={()=>setPage(shown+1)}>{t('下一页','Next')}</Button></div>}
  <EvidenceContext retrieval={retrieval} attachments={attachments} onInspect={onInspect} onBind={onBind}/>
 </div>;
}
