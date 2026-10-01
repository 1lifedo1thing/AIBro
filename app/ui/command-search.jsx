import React from 'react';
import { Badge, Button, Kbd, EmptyState } from './halaska-kit.jsx';

const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement.lang)?en:zh;

// The host owns the dialog, combobox, selection and routing. This island owns
// only its results. Upstream CommandMenu binds another window key handler and
// loses IME/disabled semantics; use its row pattern with actual Kit primitives.
export function CommandSearchResults({groups=[],query='',pending=false,onEdit,onClear,onClearRecent,icon}) {
  if(!groups.length&&!query)return null;
  if(!groups.length)return <div className="command-search-empty">
    <EmptyState title={t('没有匹配的命令或内容','No matching commands or content')} description={query.startsWith('>')?t('试试“新建”“设置”或“整理”，也可以移除 > 搜索工作区内容。','Try “new”, “settings” or “organize”, or remove > to search workspace content.'):t('可以搜索项目名称、对话正文、笔记或资料标题。试试更短的关键词。','Search project names, conversations, notes or material titles. Try a shorter keyword.')} />
    <div className="command-search-empty-actions"><Button size="sm" variant="secondary" onClick={onEdit}>{t('编辑关键词','Edit query')}</Button><Button size="sm" variant="ghost" onClick={onClear}>{t('清空搜索','Clear search')}</Button></div>
  </div>;
  let index=0;
  return <>{groups.map((group,groupIndex)=><div key={group.type} className="command-search-group" role="group" aria-labelledby={`command-search-group-${groupIndex}`}>
    <div className="command-search-group-heading" id={`command-search-group-${groupIndex}`}><span>{group.label}</span><Badge>{group.items.length}</Badge>{group.type==='recent-command'&&<Button size="sm" variant="ghost" onClick={onClearRecent} aria-label={t('清除最近使用的命令','Clear recent commands')}>{t('清除','Clear')}</Button>}</div>
    {group.items.map(row=>{
      const n=index++,id=`command-search-option-${n}`,isCommand=row.type==='command',unavailable=!!row.disabled||pending;
      return <button key={`${row.type}:${row.id}`} id={id} className="search-result" type="button" tabIndex={-1} role="option" aria-selected="false" aria-disabled={unavailable||undefined} aria-describedby={row.disabledReason?`${id}-reason`:undefined} data-search-result={`${row.type}:${row.id}`}>
        <span className="search-result-icon" aria-hidden="true">{isCommand?'›':icon?<span dangerouslySetInnerHTML={{__html:icon(row.type)||''}} />:'⌕'}</span>
        <span className="search-result-copy"><b title={row.title} data-user-content>{row.title}</b><small data-user-content>{row.meta}</small>{row.disabledReason&&<small id={`${id}-reason`} className="command-search-unavailable">{row.disabledReason}</small>}</span>
        <span className="command-search-row-end">{row.shortcut&&<Kbd>{row.shortcut}</Kbd>}<span className="command-search-enter" aria-hidden="true">↵</span></span>
      </button>;
    })}
  </div>)}</>;
}
