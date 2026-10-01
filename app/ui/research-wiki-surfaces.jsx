import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, Heading, Text, TextInput, TextArea, AlertBanner, tokens, motion, usePal } from './halaska-kit.jsx';
import { KitSearchInput, KitSelect } from './kit-controls.jsx';
import { MoreHorizontal, Plus, Upload, RefreshCw, Download, Link2, ScanSearch, Search, Files, BookOpen, Sparkles, FolderOpen, GitMerge, Trash2, RotateCcw, X, ChevronDown, Check } from 'lucide-react';

const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement.lang)?en:zh;
const icons={refresh:RefreshCw,export:Download,links:Link2,health:ScanSearch,search:Search,sources:Files,relations:Link2,merge:GitMerge,remove:Trash2};

// Adapted from the pinned Halaska DropdownMenu: same anchor/panel structure,
// 4px inset, 8px rows, 16px shell and emphasized entrance. Hidden menus unmount,
// native keys and outside focus replace its demo-only click-away backdrop.
function WikiOverflow({items,busy,onAction,cardId,entryTitle}){
 const [open,setOpen]=useState(false),[hover,setHover]=useState(-1),wrapper=useRef(null),menu=useRef(null),first=useRef('first'),id=useId(),pal=usePal();
 const attribute=cardId?'data-wiki-card-action':'data-wiki-action';
 const trigger=()=>wrapper.current?.querySelector('button');
 const close=(restore=false)=>{setOpen(false);if(restore)trigger()?.focus({preventScroll:true});};
 useLayoutEffect(()=>{const button=trigger();if(button){button.setAttribute(attribute,'more');button.setAttribute('aria-haspopup','menu');}},[attribute]);
 useLayoutEffect(()=>{if(open){const buttons=[...menu.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];(first.current==='last'?buttons.at(-1):buttons[0])?.focus({preventScroll:true});}},[open]);
 useLayoutEffect(()=>{
  if(!open||!cardId)return;
  const place=()=>{const panel=menu.current,anchor=wrapper.current;if(!panel||!anchor)return;const rect=anchor.getBoundingClientRect(),above=rect.top-12,below=innerHeight-rect.bottom-12,up=below<panel.scrollHeight&&above>below;panel.style.top=up?'auto':'calc(100% + 6px)';panel.style.bottom=up?'calc(100% + 6px)':'auto';panel.style.maxHeight=Math.max(48,Math.min(440,up?above:below))+'px';panel.style.transformOrigin=up?'bottom right':'top right';};
  const scrolled=event=>{if(!menu.current?.contains(event.target))place();};place();window.addEventListener('resize',place);document.addEventListener('scroll',scrolled,true);
  return()=>{window.removeEventListener('resize',place);document.removeEventListener('scroll',scrolled,true);};
 },[open,cardId]);
 useEffect(()=>{
  if(!open)return;
  const outside=event=>{if(!wrapper.current?.contains(event.target))setOpen(false);};
  document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside);
  return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);};
 },[open]);
 useEffect(()=>{if(busy)setOpen(false);},[busy]);
 const onKey=event=>{
  if(event.isComposing||event.keyCode===229)return;
  if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close(true);return;}
  if(event.target===trigger()&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();first.current=event.key==='ArrowUp'?'last':'first';setOpen(true);return;}
  if(!open||!menu.current?.contains(event.target))return;
  if(event.key==='Tab'){close(true);return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();const buttons=[...menu.current.querySelectorAll('[role="menuitem"]:not(:disabled)')],index=buttons.indexOf(document.activeElement);
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length;
  buttons[next]?.focus({preventScroll:true});buttons[next]?.scrollIntoView({block:'nearest',inline:'nearest'});
 };
 return <div ref={wrapper} className={`wiki-more${cardId?' wiki-card-more':''}`} onKeyDown={onKey}>
  <Button variant="ghost" size="sm" disabled={!!busy} aria-label={cardId?t(`「${entryTitle}」的更多操作`,`More actions for ${entryTitle}`):t('更多 Wiki 操作','More Wiki actions')} aria-expanded={open} aria-controls={open?id:undefined}
   style={cardId?{width:30,padding:0}:undefined} icon={<MoreHorizontal size={17} aria-hidden="true"/>} onClick={()=>{first.current='first';setOpen(value=>!value);}}>{cardId?null:t('更多','More')}</Button>
  {open&&<div ref={menu} id={id} role="menu" aria-label={cardId?t('条目操作','Entry actions'):t('Wiki 工具','Wiki tools')} data-wiki-card-menu={cardId} className="wiki-more-panel" style={{
   border:`1px solid ${pal.borderSubtle}`,borderRadius:tokens.radius.md,padding:4,
   animation:`halaska-scale-in ${motion.fast} ${motion.emphasized} both`,transformOrigin:'top right'
  }}>
   {items.map((item,index)=>{const Icon=icons[item.id]||Files;return <React.Fragment key={item.id}>
    {(index===0||item.group!==items[index-1].group)&&(cardId?(index>0&&<div className="wiki-more-divider" role="separator"/>):<div className="wiki-more-group" role="presentation">{item.group==='checks'?t('检查与维护','Checks & maintenance'):t('Markdown 文件','Markdown files')}</div>)}
    <button type="button" role="menuitem" {...{[attribute]:item.id}} disabled={item.disabled||!!busy}
     onMouseEnter={()=>setHover(index)} onMouseLeave={()=>setHover(-1)} onClick={()=>{close(true);onAction(item.id);}}
     style={{...tokens.type.sm,padding:'8px 12px',borderRadius:tokens.radius.sm,color:item.danger?pal.danger:pal.text,background:hover===index?pal.bgSubtle:'transparent',transition:`background ${motion.normal} ${motion.easeInOut}, color ${motion.normal} ${motion.easeInOut}`}}>
     <Icon size={15} aria-hidden="true" style={item.danger?{color:pal.danger}:undefined}/><span>{item.label}</span>
    </button>
   </React.Fragment>;})}
  </div>}
 </div>;
}

function WikiAction({id,children,...props}){
 const ref=useRef(null);useLayoutEffect(()=>{ref.current?.querySelector('button')?.setAttribute('data-wiki-action',id);},[id]);
 return <span ref={ref} className="wiki-header-action"><Button size="sm" {...props}>{children}</Button></span>;
}

export function ResearchWikiHeader({query='',type='',scope='all',count=0,scopes=[],types=[],canImport,canResearch,actions=[],busy='',error='',onQuery,onType,onScope,onAction}){
 return <header className="wiki-header-kit">
  <div className="wiki-title-row">
   <div className="wiki-title-copy"><Text size="xs" muted style={{letterSpacing:'0.08em'}}>RESEARCH / WIKI</Text>
    <div className="wiki-title-line"><Heading level={1} style={{fontSize:28,lineHeight:1.25,margin:0}}>{t('科研 Wiki','Research Wiki')}</Heading><span className="wiki-entry-count" role="status" aria-live="polite"><Badge>{count} {t('条目','entries')}</Badge></span></div>
    <Text as="p" size="sm" secondary style={{margin:0}}>{t('连接资料、方法与发现，让研究不断积累。','Connect sources, methods and discoveries across your research.')}</Text>
   </div>
   <div className="wiki-header-actions" role="group" aria-label={t('Wiki 操作','Wiki actions')}>
    {canResearch&&<WikiAction id="research" variant="outline" disabled={!!busy} icon={<Files size={14} aria-hidden="true"/>} onClick={()=>onAction('research')}>{t('研究问题','Research question')}</WikiAction>}
    {canImport&&<WikiAction id="import" variant="outline" disabled={!!busy} icon={<Upload size={14} aria-hidden="true"/>} onClick={()=>onAction('import')}>{t('导入','Import')}</WikiAction>}
    <WikiAction id="new" variant="primary" disabled={!!busy} icon={<Plus size={15} aria-hidden="true"/>} onClick={()=>onAction('new')}>{t('新建条目','New entry')}</WikiAction>
    <WikiOverflow items={actions} busy={busy} onAction={onAction}/>
   </div>
  </div>
  <div className="wiki-filter-bar" role="search" aria-label={t('查找科研条目','Find research entries')}>
   <div className="wiki-query-control"><span className="wiki-filter-label">{t('搜索','Search')}</span><KitSearchInput value={query} onChange={onQuery} label={t('搜索科研 Wiki','Search research Wiki')} placeholder={t('问题、方法、证据或失败经验…','Questions, methods, evidence or lessons…')} attributes={{id:'wikiSearch','data-wiki-search':''}}/></div>
   <div className="wiki-scope-control"><span className="wiki-filter-label">{t('项目范围','Project scope')}</span><KitSelect id="wikiScope" value={scope} options={scopes} onChange={onScope} label={t('科研项目范围','Research project scope')} size="md" attributes={{'data-wiki-scope':''}}/></div>
   <div className="wiki-type-control"><span className="wiki-filter-label">{t('条目类型','Entry type')}</span><KitSelect id="wikiType" value={type} options={types.map(item=>({...item,label:`${item.label} · ${item.count}`}))} onChange={onType} label={t('科研条目类型','Research entry type')} size="md" attributes={{'data-wiki-type':''}}/></div>
  </div>
  {busy==='refresh'&&<p className="wiki-sync-status" role="status">{t('正在同步 Markdown…','Synchronizing Markdown…')}</p>}
  {error&&<div className="wiki-header-error" role="alert"><AlertBanner variant="warning" title={t('Wiki 需要检查','Wiki needs attention')} description={error}/></div>}
 </header>;
}

function CardAction({action,children,...props}){
 const ref=useRef(null);useLayoutEffect(()=>{ref.current?.querySelector('button')?.setAttribute('data-wiki-card-action',action);},[action]);
 return <span ref={ref} className="wiki-card-action"><Button size="sm" {...props}>{children}</Button></span>;
}

function ResearchWikiCard({note,onAction,onError}){
 const ref=useRef(null),titleId=useId(),busyRef=useRef(false),mounted=useRef(true),returnFocus=useRef(null);
 const [busy,setBusy]=useState(''),[error,setError]=useState('');
 const actionBusy=busy||note.pendingAction,actionError=error||note.actionError;
 useEffect(()=>()=>{mounted.current=false;},[]);
 useLayoutEffect(()=>{
  if(actionBusy||!returnFocus.current)return;
  const previous=returnFocus.current;returnFocus.current=null;
  if(document.activeElement!==document.body)return;
  const target=previous.isConnected&&!previous.disabled?previous:ref.current?.querySelector('[data-wiki-card-action="open"]');
  if(target?.getClientRects().length)target.focus({preventScroll:true});
 },[actionBusy]);
 const run=async action=>{
  if(busyRef.current||note.pendingAction)return;busyRef.current=true;returnFocus.current=document.activeElement;setBusy(action);setError('');
  try{await onAction(note.id,action);}
  catch(cause){if(mounted.current){const message=cause?.message||String(cause);setError(message);onError?.(message);}}
  finally{busyRef.current=false;if(mounted.current)setBusy('');}
 };
 const more=[
  ...(note.canRelations?[{id:'relations',group:'entry',label:t('来源与关联','Sources and links')}]:[]),
  ...(note.canMerge?[{id:'merge',group:'entry',label:t('合并条目','Merge entries')}]:[]),
  {id:'remove',group:'destructive',label:t('移入回收站','Move to trash'),danger:true}
 ];
 const date=note.date?new Date(note.date):null,dateLabel=date?date.toLocaleDateString(t('zh-CN','en'),{year:'numeric',month:'short',day:'numeric'}):t('未记录时间','No date recorded');
 return <article ref={ref} className="wiki-card wiki-kit-card" data-wiki-note={note.id} aria-labelledby={titleId} aria-busy={!!actionBusy}>
  <Card padding={0} style={{background:'var(--panel)',border:'1px solid var(--line)',borderRadius:18,boxShadow:'none',backdropFilter:'none',WebkitBackdropFilter:'none'}}>
   <div className="wiki-card-head">
    <div className="wiki-meta"><Badge style={{textTransform:'none',letterSpacing:0}}><span aria-hidden="true">{note.typeIcon}</span>{note.typeLabel}</Badge><time dateTime={note.date||undefined} title={dateLabel}>{dateLabel}</time></div>
    <WikiOverflow items={more} busy={actionBusy} onAction={run} cardId={note.id} entryTitle={note.title}/>
   </div>
   <div className="wiki-card-body">
    <div id={titleId} data-user-content><Heading level={2} style={{fontSize:18,lineHeight:1.5,fontWeight:600,letterSpacing:'-.01em',margin:0}}>{note.title}</Heading></div>
    <p className="wiki-excerpt" data-user-content><Text size="sm" secondary style={{lineHeight:1.75}}>{note.excerpt||t('尚无正文，打开条目继续记录。','No body yet. Open this entry to continue writing.')}</Text></p>
    <div className="wiki-card-context"><span className="wiki-owner" data-user-content title={note.owner}><FolderOpen size={13} aria-hidden="true"/><Text size="xs" secondary style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{note.owner}</Text></span>
     <span className="wiki-provenance"><Text size="xs" muted>{t('来源','Sources')} {note.sourceCount} <span aria-hidden="true">·</span> {t('反向关联','Backlinks')} {note.backlinkCount}</Text></span>
    </div>
    {note.pendingDraft&&<div className="wiki-card-notice wiki-draft-notice"><Badge variant="warning" style={{textTransform:'none'}}>{t('修改待审阅','Changes to review')}</Badge><Text size="xs" secondary>{t('正文保留当前版本','Current body is preserved')}</Text></div>}
    {note.fileError&&<div className="wiki-card-notice wiki-file-notice"><div><Text size="sm" weight="medium">{t('原文件暂不可读','Source file is unavailable')}</Text><Text as="p" size="xs" secondary style={{margin:'4px 0 0',lineHeight:1.6}}>{t('当前显示已保存正文。','Showing the saved body.')} {note.fileError}</Text></div><CardAction action="restore" variant="outline" disabled={!!actionBusy} loading={actionBusy==='restore'} icon={<RotateCcw size={13} aria-hidden="true"/>} onClick={()=>run('restore')}>{t('恢复已保存正文','Restore saved content')}</CardAction></div>}
    {actionError&&<div className="wiki-card-action-error" role="alert"><Text size="xs" color="var(--red)">{actionError}</Text></div>}
   </div>
   <footer className="wiki-card-actions">
    <CardAction action="open" variant="primary" disabled={!!actionBusy} loading={actionBusy==='open'} icon={<BookOpen size={14} aria-hidden="true"/>} onClick={()=>run('open')}>{t('阅读与编辑','Read & edit')}</CardAction>
    <CardAction action="continue" variant="ghost" disabled={!!actionBusy} loading={actionBusy==='continue'} icon={<Sparkles size={14} aria-hidden="true"/>} onClick={()=>run('continue')}>{t('继续研究','Continue with AI')}</CardAction>
   </footer>
  </Card>
 </article>;
}

export function ResearchWikiCards({notes=[],filtered=false,onAction,onError,onReset,onCreate}){
 if(!notes.length)return <div className="wiki-cards-empty"><EmptyState icon={<BookOpen size={24} aria-hidden="true"/>}
  title={filtered?t('没有匹配的研究条目','No matching research entries'):t('从一个问题，一次尝试开始。','Start with a question or an experiment.')}
  description={filtered?t('调整搜索或条目类型，查看这个范围里的其他记录。','Adjust the search or entry type to see other records in this scope.'):t('论文导读、方法、实验与失败经验会在这里积累。','Collect paper guides, methods, experiments and lessons here.')}
  action={<Button variant={filtered?'outline':'primary'} size="sm" onClick={filtered?onReset:onCreate}>{filtered?t('清除搜索与类型','Clear search and type'):t('新建条目','New entry')}</Button>}/></div>;
 return <>{notes.map(note=><ResearchWikiCard key={note.id} note={note} onAction={onAction} onError={onError}/>)}</>;
}


// The pinned kit owns the real text controls; this adapter supplies their missing
// identity/label contract and keeps composing text local through host refreshes.
function WikiDraftField({fieldKey,label,value='',onChange,onComposition,disabled,multiline=false}){
 const ref=useRef(null),composing=useRef(false),last=useRef(value),[draft,setDraft]=useState(value),id=useId();
 const commit=next=>{if(last.current===next)return;last.current=next;onChange(next);};
 useLayoutEffect(()=>{if(!composing.current){setDraft(value);last.current=value;}},[value]);
 useLayoutEffect(()=>{
  const input=ref.current?.querySelector(multiline?'textarea':'input');if(!input)return;
  input.id=id;input.setAttribute('aria-label',label);input.classList.add(multiline?'wiki-section-input':'wiki-title');
  if(multiline)input.dataset.wikiSection=fieldKey;else input.maxLength=240;
  const start=()=>{composing.current=true;onComposition(true);};
  const end=()=>{composing.current=false;onComposition(false);setDraft(input.value);commit(input.value);};
  input.addEventListener('compositionstart',start);input.addEventListener('compositionend',end);
  return()=>{input.removeEventListener('compositionstart',start);input.removeEventListener('compositionend',end);};
 });
 const props={label,value:draft,disabled,onChange:next=>{if(disabled)return;setDraft(next);commit(next);},style:{minWidth:0}};
 return <div ref={ref} className="wiki-compose-field" data-user-content>{multiline?<TextArea {...props} rows={3} placeholder={t('没有依据时可以留空。','Leave blank when evidence is unavailable.')}/>:<TextInput {...props} placeholder={t('为这个研究条目起个名字','Name this research entry')}/>}</div>;
}
function ComposerAction({action,children,...props}){
 const ref=useRef(null);useLayoutEffect(()=>{const button=ref.current?.querySelector('button');if(button){button.dataset.wikiComposeAction=action;if(action==='save')button.dataset.wikiSave='true';else delete button.dataset.wikiSave;}},[action]);
 return <span className="wiki-compose-action" ref={ref}><Button size="sm" {...props}>{children}</Button></span>;
}
export function ResearchWikiComposer({draft,types,scopes,fields,busy,error,savedId,onChange,onSave,onClose,onOpen}){
 const composing=useRef(false),compositionEnter=useRef(false),locked=!!busy||!!savedId||!!draft.pendingNoteId;
 const field=({key,label})=><WikiDraftField key={key} fieldKey={key} label={label} value={draft.sections[key]||''} disabled={locked} multiline onComposition={value=>{composing.current=value;}} onChange={value=>onChange({sections:{...draft.sections,[key]:value}})}/>;
 const primary=fields.filter(item=>!item.common),common=fields.filter(item=>item.common);
 const hasCommon=useRef(common.some(item=>draft.sections[item.key]?.trim()));
 return <form className="wiki-compose-kit" aria-busy={busy||undefined} onSubmit={event=>{event.preventDefault();if(!composing.current&&!compositionEnter.current&&!locked)onSave();}} onKeyDown={event=>{compositionEnter.current=event.key==='Enter'&&(event.isComposing||event.nativeEvent.isComposing||event.keyCode===229||composing.current);if(compositionEnter.current)event.stopPropagation();}} onKeyUp={event=>{if(event.key==='Enter')compositionEnter.current=false;}}>
  <header className="wiki-compose-heading"><div><div className="wiki-compose-eyebrow"><Text size="xs" muted>RESEARCH / WIKI</Text><Badge>{t('新条目','New entry')}</Badge></div><Heading level={2} style={{fontSize:23,lineHeight:1.35,margin:'8px 0'}}>{t('留下可复用的研究记忆','Save reusable research memory')}</Heading><Text as="p" size="sm" secondary style={{margin:0}}><span id="wikiComposeDescription">{t('先记录问题与依据，其他部分可以稍后补充。','Start with your question and evidence. Other sections can wait.')}</span></Text></div>
   <ComposerAction action="close" variant="ghost" disabled={!!busy} aria-label={t('关闭并保留草稿','Close and keep draft')} icon={<X size={17} aria-hidden="true"/>} onClick={onClose} style={{width:30,padding:0}}/>
  </header>
  {savedId?<section className="wiki-compose-result" role="status"><Check size={24} aria-hidden="true"/><Heading level={3}>{t('条目已保存','Entry saved')}</Heading><Text size="sm" secondary>{t('内容已保存，可以打开条目继续阅读与编辑。','Your content is saved. Open the entry to read and edit it.')}</Text></section>:<div className="wiki-compose-body">
   <div className="wiki-compose-selectors"><div><label className="wiki-filter-label" htmlFor="wikiComposeType">{t('条目类型','Entry type')}</label><KitSelect id="wikiComposeType" value={draft.type} options={types} size="md" disabled={locked} label={t('新条目类型','New entry type')} attributes={{'data-create-wiki-type':draft.type}} onChange={value=>onChange({type:value})}/></div>
    <div><label className="wiki-filter-label" htmlFor="wikiComposeScope">{t('所属项目','Project')}</label><KitSelect id="wikiComposeScope" value={draft.projectId||''} options={scopes} size="md" disabled={locked} label={t('新条目所属项目','New entry project')} onChange={value=>onChange({projectId:value||null})}/></div></div>
   <WikiDraftField fieldKey="title" label={t('标题','Title')} value={draft.title} disabled={locked} onComposition={value=>{composing.current=value;}} onChange={value=>onChange({title:value})}/>
   <div className="wiki-compose-fields">{primary.map(field)}</div>
   <details className="wiki-compose-context" open={hasCommon.current||undefined}><summary><span><Text size="sm" weight="medium">{t('补充研究上下文','Additional research context')}</Text><Text size="xs" muted>{t('选填 · 观察、推断与下一步','Optional · observations, inferences and next steps')}</Text></span><ChevronDown size={16} aria-hidden="true"/></summary><div className="wiki-compose-fields">{common.map(field)}</div></details>
  </div>}
  {error&&<div className="wiki-compose-error" role="alert"><AlertBanner variant="warning" title={savedId?t('条目已保存，暂未打开','Saved, but not opened'):t('需要处理后继续','Action needed')} description={error}/></div>}
  {draft.pendingNoteId&&!savedId&&<div className="wiki-compose-error"><AlertBanner variant="warning" title={t('已有条目需要继续处理','Continue with the existing entry')} description={t('保留了其他操作的修改。打开已有条目继续，避免创建副本。','Changes made by another operation were preserved. Open the existing entry to avoid a duplicate.')}/></div>}
  <footer className="wiki-compose-footer"><div className="wiki-compose-status" role="status"><Text size="xs" secondary>{busy?t('正在等待保存或打开结果…','Waiting for the save or reader…'):savedId?t('已收到保存确认','Save acknowledged'):t('稍后继续会保留当前草稿','Continue later keeps this draft')}</Text></div><div className="wiki-compose-buttons"><ComposerAction action="later" variant="ghost" disabled={!!busy} onClick={onClose}>{savedId?t('关闭','Close'):t('稍后继续','Continue later')}</ComposerAction>{savedId||draft.pendingNoteId?<ComposerAction action="open" variant="primary" disabled={!!busy} loading={!!busy} icon={<BookOpen size={14} aria-hidden="true"/>} onClick={onOpen}>{t('打开条目','Open entry')}</ComposerAction>:<ComposerAction action="save" type="submit" variant="primary" disabled={!!busy} loading={!!busy}>{t('保存并打开','Save & open')}</ComposerAction>}</div></footer>
 </form>;
}
