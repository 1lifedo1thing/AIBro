import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Heading, Text, Caption, Badge, Button, TextInput, AlertBanner, EmptyState } from './halaska-kit.jsx';
import { KitSearchInput, KitSelect, KitCheckbox } from './kit-controls.jsx';
import styles from './conversation-organizer.css';

if (!document.getElementById('conversation-organizer-styles')) {
  const style = document.createElement('style'); style.id = 'conversation-organizer-styles'; style.textContent = styles; document.head.append(style);
}
const t = (zh,en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;
const MIME = 'application/x-aibro-conversation';
const match = (value, query) => String(value || '').normalize('NFKC').toLocaleLowerCase().includes(query.trim().normalize('NFKC').toLocaleLowerCase());
const titleOf = chat => chat.title || t('新对话','New conversation');

function NamedInput({ id, label, value, onChange, disabled, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => { const input=ref.current.querySelector('input'); input.id=id;input.setAttribute('aria-label',label);input.maxLength=100; }, [id,label]);
  return <div ref={ref} className="organizer-named-input" onKeyDownCapture={event=>{if(event.key==='Enter'&&(event.isComposing||event.nativeEvent?.isComposing||event.keyCode===229))event.preventDefault();}}><TextInput {...{label,value,onChange,disabled}} {...props} /></div>;
}
function Member({ chat, selected, onChange, busy, onInspect }) {
  const ref=useRef(null);
  useLayoutEffect(()=>{ref.current.querySelector('input').dataset.organizerMember=chat.id;},[chat.id]);
  return <div className="organizer-member" ref={ref}>
    <KitCheckbox label={titleOf(chat)} checked={selected} disabled={busy} onChange={onChange} />
    <Button size="sm" variant="ghost" disabled={busy} onClick={()=>onInspect(chat.id)} aria-label={t(`预览 ${titleOf(chat)}`,`Preview ${titleOf(chat)}`)}>{t('摘要','Preview')}</Button>
  </div>;
}
function RecommendationEditor({ recommendation, folders, busy, onCommand, onInspect }) {
  const [name,setName]=useState(recommendation.proposedName),[target,setTarget]=useState(recommendation.folderId||''),[members,setMembers]=useState(recommendation.conversationIds);
  const [query,setQuery]=useState('');
  useEffect(()=>{setName(recommendation.proposedName);setTarget(recommendation.folderId||'');setMembers(recommendation.conversationIds);setQuery('');},[recommendation.id,recommendation.sourceStamp]);
  const items=(recommendation.members||[]).filter(chat=>match(titleOf(chat),query));
  const reason=/^en(?:-|$)/i.test(document.documentElement.lang)?recommendation.reasonEn||recommendation.reason:recommendation.reason;
  const valid=members.length>=(target?1:2)&&(target||name.trim());
  return <section className="organizer-recommendation-editor" aria-label={t('审阅整理建议','Review organization recommendation')}>
    <div className="organizer-detail-heading"><Badge>{t('待确认','Proposed')}</Badge><Heading level={3}>{t('审阅这组对话','Review this group')}</Heading></div>
    <p className="organizer-reason" data-user-content>{reason}</p>
    {!!recommendation.evidence?.terms?.length&&<div className="organizer-evidence" aria-label={t('共同主题','Shared topics')}>{recommendation.evidence.terms.map(term=><Badge key={term}>{term}</Badge>)}</div>}
    <label className="organizer-field-label" htmlFor="organizerTargetFolder">{t('放入文件夹','Destination folder')}</label>
    <KitSelect id="organizerTargetFolder" label={t('放入文件夹','Destination folder')} value={target} disabled={busy} onChange={setTarget} options={[{value:'',label:t('新建文件夹','Create a new folder')},...folders.map(folder=>({value:folder.id,label:folder.name}))]} />
    {!target&&<NamedInput id="organizerProposedName" label={t('文件夹名称','Folder name')} value={name} onChange={setName} disabled={busy} />}
    <div className="organizer-members-heading"><strong>{t('归入的对话','Conversations to include')}</strong><Caption>{t(`已选 ${members.length} 条`,`${members.length} selected`)}</Caption></div>
    {(recommendation.members||[]).length>6&&<KitSearchInput label={t('筛选建议成员','Filter suggested members')} value={query} onChange={setQuery} disabled={busy} placeholder={t('搜索这组对话','Search this group')} />}
    <div className="organizer-members">{items.map(chat=><Member key={chat.id} chat={chat} selected={members.includes(chat.id)} busy={busy} onInspect={onInspect} onChange={checked=>setMembers(previous=>checked?[...previous,chat.id]:previous.filter(id=>id!==chat.id))} />)}</div>
    <Caption>{t('只整理所选对话的位置，不合并消息，也不改变项目归属。','Only the selected conversations move. Messages and project associations stay intact.')}</Caption>
    <div className="organizer-detail-actions"><Button id="organizerDismiss" size="sm" variant="ghost" disabled={busy} onClick={()=>onCommand({action:'dismiss',recommendation})}>{t('忽略这条建议','Dismiss suggestion')}</Button><Button id="organizerApprove" size="sm" variant="accent" disabled={busy||!valid} loading={busy} onClick={()=>onCommand({action:'approve',recommendation,conversationIds:members,name:name.trim(),targetFolderId:target||null})}>{t('确认归入文件夹','Confirm grouping')}</Button></div>
  </section>;
}
function Summary({ selection, conversations, folders, busy, onCommand, onOpenConversation }) {
  const chat=conversations.find(item=>item.id===selection?.id),[target,setTarget]=useState(chat?.folderId||'');
  useEffect(()=>setTarget(chat?.folderId||''),[chat?.id,chat?.folderId]);
  if(!selection||!chat)return <div className="organizer-summary-empty"><EmptyState title={t('快速了解对话','Preview a conversation')} description={t('选择一条对话，查看目标、最近答复与整理操作。','Choose a conversation to see its goal, latest reply and organization actions.')} /></div>;
  return <section className="organizer-summary" tabIndex={-1} aria-label={t('对话摘要','Conversation summary')}>
    <div className="organizer-detail-heading"><Badge>{t('原文摘录','Message excerpts')}</Badge><Heading level={3}><span data-user-content>{selection.title}</span></Heading></div>
    <div className="organizer-summary-copy"><Caption>{t('最近的目标','Latest goal')}</Caption><p data-user-content>{selection.goal||t('尚无消息','No messages yet')}</p><Caption>{t('对应答复','Following reply')}</Caption><p data-user-content>{selection.outcome||t('这条目标之后尚无已完成的答复。','There is no completed reply after this goal yet.')}</p></div>
    <Caption>{t(`来自 ${selection.messageCount} 条可见消息；不会调用模型。`,`From ${selection.messageCount} visible messages; no model request.`)}</Caption>
    <div className="organizer-summary-buttons"><Button id="organizerOpenConversation" size="sm" variant="accent" disabled={busy} onClick={()=>onOpenConversation(chat.id)}>{t('打开对话','Open conversation')}</Button><Button id="organizerPin" size="sm" variant="secondary" disabled={busy} onClick={()=>onCommand({action:'pin',conversationId:chat.id,pinned:!chat.pinned})}>{chat.pinned?t('取消置顶','Unpin'):t('置顶对话','Pin conversation')}</Button></div>
    <div className="organizer-move"><label className="organizer-field-label" htmlFor="organizerMoveTarget">{t('移动到','Move to')}</label><KitSelect id="organizerMoveTarget" label={t('目标文件夹','Destination folder')} disabled={busy} value={target} onChange={setTarget} options={[{value:'',label:t('未分组','Unfiled')},...folders.map(folder=>({value:folder.id,label:folder.name}))]} /><Button id="organizerMove" size="sm" disabled={busy||target===(chat.folderId||'')} onClick={()=>onCommand({action:'move',conversationId:chat.id,folderId:target||null})}>{t('移动对话','Move conversation')}</Button></div>
  </section>;
}

export function ConversationOrganizerView({ conversations=[],folders=[],recommendations=[],selection,busy,error,notice,generation,initialTab='suggestions',initialConversationId,onClose,onRefresh,onInspect,onCommand,onOpenConversation }) {
  const [tab,setTab]=useState(initialTab),[recommendationId,setRecommendationId]=useState(recommendations[0]?.id||null),[query,setQuery]=useState(''),[limit,setLimit]=useState(80);
  const [creating,setCreating]=useState(false),[folderName,setFolderName]=useState(''),[dropTarget,setDropTarget]=useState(null),[showPreview,setShowPreview]=useState(!!initialConversationId);
  const detailRef=useRef(null);
  const recommendation=recommendations.find(item=>item.id===recommendationId)||recommendations[0];
  useEffect(()=>{setTab(initialTab);setQuery('');setLimit(80);setShowPreview(!!initialConversationId);},[generation,initialTab]);
  useEffect(()=>{if(creating)document.getElementById('organizerFolderName')?.focus();},[creating]);
  useEffect(()=>{if(selection?.id&&showPreview){const summary=detailRef.current?.querySelector('.organizer-summary');summary?.focus({preventScroll:true});if(matchMedia('(max-width:800px)').matches)summary?.scrollIntoView({block:'start',behavior:'auto'});}},[selection?.id,showPreview]);
  const selectTab=value=>{if(busy)return;setTab(value);setQuery('');setLimit(80);setShowPreview(value!=='suggestions');};
  const inspect=id=>{setShowPreview(true);onInspect(id);};
  const drop=(event,folderId)=>{setDropTarget(null);const id=event.dataTransfer.getData(MIME);if(!id||busy||!conversations.some(chat=>chat.id===id))return;event.preventDefault();onCommand({action:'move',conversationId:id,folderId:folderId||null});};
  const folderNav=(value,label,count,dropFolder)=> <button key={value} type="button" className={`organizer-nav-item ${tab===value?'is-selected':''} ${dropTarget===value?'is-drop-target':''}`} disabled={busy} data-organizer-nav={value} data-organizer-drop={dropFolder===undefined?undefined:dropFolder||'unfiled'} aria-current={tab===value?'page':undefined} onClick={()=>selectTab(value)}
    onDragOver={event=>{if(dropFolder!==undefined&&!busy&&Array.from(event.dataTransfer.types).includes(MIME)){event.preventDefault();event.dataTransfer.dropEffect='move';setDropTarget(value);}}} onDragLeave={()=>setDropTarget(null)} onDrop={event=>{if(dropFolder!==undefined)drop(event,dropFolder);}}><span>{label}</span><Badge>{count}</Badge></button>;
  const filtered=conversations.filter(chat=>(tab==='all'||tab==='suggestions'||(tab==='unfiled'?!chat.folderId:chat.folderId===tab))&&match(`${chat.title} ${chat.projectName}`,query));
  const folderTitle=tab==='all'?t('全部对话','All conversations'):tab==='unfiled'?t('未分组','Unfiled'):folders.find(folder=>folder.id===tab)?.name||t('对话','Conversations');
  return <section className="organizer-view" aria-busy={busy||undefined}>
    <header className="organizer-heading"><div><Heading level={2}>{t('整理对话','Organize conversations')}</Heading><Text as="p" size="sm" secondary>{t('先查看建议和依据，确认后再归入文件夹。','Review suggestions and their reasons before grouping conversations.')}</Text></div><Button id="organizerClose" size="sm" variant="ghost" disabled={busy} onClick={onClose} aria-label={t('关闭对话整理','Close conversation organizer')}>×</Button></header>
    {(error||notice||busy)&&<div className="organizer-feedback">{error?<div role="alert"><AlertBanner title={t('更改尚未完成','Change not completed')} description={error} variant="danger" /></div>:<p role="status">{busy?t('正在保存，请稍候…','Saving, please wait…'):notice}</p>}</div>}
    <div className="organizer-layout">
      <aside className="organizer-navigation" aria-label={t('对话文件夹','Conversation folders')}>
        {folderNav('suggestions',t('整理建议','Suggestions'),recommendations.length)}{folderNav('all',t('全部对话','All conversations'),conversations.length)}{folderNav('unfiled',t('未分组','Unfiled'),conversations.filter(chat=>!chat.folderId).length,null)}
        <div className="organizer-folders-label"><Caption>{t('文件夹','Folders')}</Caption></div>
        {folders.map(folder=>folderNav(folder.id,folder.name,conversations.filter(chat=>chat.folderId===folder.id).length,folder.id))}
        <Button id="organizerCreateFolder" size="sm" variant="ghost" disabled={busy} onClick={()=>setCreating(value=>!value)}>{t('＋ 新建文件夹','＋ New folder')}</Button>
        {creating&&<form className="organizer-folder-form" onSubmit={async event=>{event.preventDefault();if(busy||!folderName.trim())return;const saved=await onCommand({action:'createFolder',name:folderName.trim()});if(saved){setFolderName('');setCreating(false);}}}><NamedInput id="organizerFolderName" label={t('新文件夹名称','New folder name')} value={folderName} onChange={setFolderName} disabled={busy} /><Button id="organizerSaveFolder" type="submit" size="sm" disabled={busy||!folderName.trim()}>{t('创建','Create')}</Button></form>}
        <p className="organizer-drag-hint">{t('可拖动对话到文件夹；也可在摘要中选择“移动到”。','Drag a conversation into a folder, or choose “Move to” in its preview.')}</p>
      </aside>
      <main className="organizer-main">
        {tab==='suggestions'?<>
          <div className="organizer-list-heading"><div><Heading level={3}>{t('值得放在一起的对话','Conversations that belong together')}</Heading><Caption>{t('根据本机对话的项目和共同主题生成。','Based on projects and shared topics in local conversations.')}</Caption></div><Button id="organizerRefresh" size="sm" variant="secondary" disabled={busy} onClick={onRefresh}>{t('刷新建议','Refresh')}</Button></div>
          {!recommendations.length?<EmptyState title={t('暂时没有新的分组建议','No new grouping suggestions')} description={t('已有文件夹和对话保持不变。你可以手动创建文件夹，或查看全部对话。','Your folders and conversations are unchanged. Create a folder manually or browse all conversations.')} action={<Button size="sm" onClick={()=>selectTab('all')}>{t('查看全部对话','View all conversations')}</Button>} />:<div className="organizer-suggestions">{recommendations.map(item=><button key={item.id} type="button" data-recommendation-id={item.id} className={`organizer-suggestion ${recommendation?.id===item.id?'is-selected':''}`} disabled={busy} aria-pressed={recommendation?.id===item.id} onClick={()=>{setRecommendationId(item.id);setShowPreview(false);}}><span className="organizer-suggestion-title" data-user-content>{item.proposedName}</span><Badge>{item.conversationIds.length} {t('条对话','chats')}</Badge><span className="organizer-suggestion-reason" data-user-content>{/^en(?:-|$)/i.test(document.documentElement.lang)?item.reasonEn||item.reason:item.reason}</span></button>)}</div>}
        </>:<>
          <div className="organizer-list-heading"><Heading level={3}><span data-user-content>{folderTitle}</span></Heading><Badge>{filtered.length}</Badge></div>
          <KitSearchInput value={query} onChange={value=>{setQuery(value);setLimit(80);}} disabled={busy} label={t('搜索对话','Search conversations')} placeholder={t('搜索对话或项目名称','Search conversations or projects')} attributes={{'data-organizer-search':''}} />
          <div className="organizer-conversations">{filtered.slice(0,limit).map(chat=><article key={chat.id} className={`organizer-conversation ${selection?.id===chat.id?'is-selected':''}`} data-organizer-conversation={chat.id} draggable={!busy} onDragStart={event=>{if(busy){event.preventDefault();return;}event.dataTransfer.setData(MIME,chat.id);event.dataTransfer.effectAllowed='move';}}><button type="button" className="organizer-conversation-preview" data-organizer-preview={chat.id} disabled={busy} onClick={()=>inspect(chat.id)} aria-pressed={selection?.id===chat.id} title={chat.title}><span className="organizer-conversation-title" data-user-content>{chat.pinned&&<span aria-label={t('已置顶','Pinned')}>★ </span>}{chat.title}</span><small><span data-user-content>{chat.projectName||chat.workspace||t('独立对话','Independent conversation')}</span> · {chat.messageCount} {t('条消息','messages')}</small></button></article>)}</div>
          {!filtered.length&&<EmptyState title={t('没有匹配的对话','No matching conversations')} description={query?t('试试其他关键词，或清除搜索。','Try another keyword or clear the search.'):t('把对话拖到这里，或从摘要中移动过来。','Drag a conversation here, or move it from its preview.')} />}
          {filtered.length>limit&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>setLimit(value=>value+80)}>{t(`显示更多 · 还有 ${filtered.length-limit} 条`,`Show more · ${filtered.length-limit} remaining`)}</Button>}
        </>}
      </main>
      <aside className="organizer-detail" ref={detailRef}>{tab==='suggestions'&&recommendation?<><div hidden={showPreview}><RecommendationEditor key={`${recommendation.id}:${generation}`} {...{recommendation,folders,busy,onCommand}} onInspect={inspect} /></div>{showPreview&&<><Button size="sm" variant="ghost" disabled={busy} onClick={()=>{setShowPreview(false);requestAnimationFrame(()=>document.getElementById('organizerTargetFolder')?.focus());}}>{t('← 返回建议','← Back to suggestion')}</Button><Summary {...{selection,conversations,folders,busy,onCommand,onOpenConversation}} /></>}</>:<Summary {...{selection,conversations,folders,busy,onCommand,onOpenConversation}} />}</aside>
    </div>
  </section>;
}
