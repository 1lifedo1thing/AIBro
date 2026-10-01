import React, { useId, useLayoutEffect, useRef } from 'react';
import { Button } from './halaska-kit.jsx';
import { KitSegmentedControl } from './kit-controls.jsx';
import styles from './project-library.css';

const t=(zh,en)=>document.documentElement.lang.startsWith('en')?en:zh;
const scopeName=scope=>scope==='records'?t('项目记录','Project records'):scope==='all'?t('全部内容','All content'):t('资料','Sources');
const rootName=scope=>scope==='records'?t('全部记录','All records'):scope==='all'?t('全部内容','All content'):t('全部资料','All sources');
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
if(!document.getElementById('halaska-project-library')){const style=document.createElement('style');style.id='halaska-project-library';style.textContent=styles;document.head.append(style);}

// Kit owns the button. The pinned kit supports expansion attributes but not
// aria-current or data-*; set only those attributes on its actual native button.
function FolderAction({path,selected,all=false,label,count,onClick}){
  const ref=useRef(null);
  useLayoutEffect(()=>{const button=ref.current?.querySelector('button');if(!button)return;
    if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    if(all){button.setAttribute('data-project-library-all','');button.removeAttribute('data-project-library-folder');}
    else{button.setAttribute('data-project-library-folder',path);button.removeAttribute('data-project-library-all');}
  },[path,selected,all]);
  return <span ref={ref} className={`kit-project-folder-select${selected?' is-selected':''}`}><Button variant="ghost" size="sm" onClick={onClick} title={path||label}
    aria-label={`${path||label} · ${count} ${t('项','items')}`} style={{width:'100%',justifyContent:'flex-start',minWidth:0,padding:'7px 8px',gap:7,fontWeight:selected?550:450}}>
    <svg aria-hidden="true" viewBox="0 0 20 20" className="kit-project-folder-icon"><path d={all?'M5 2h8l3 3v12H5z M13 2v4h3 M2 5v13':'M2 5h6l2 2h8v10H2z'} /></svg>
    <span className="kit-project-folder-name" data-user-content={path?true:undefined}>{label}</span><span className="kit-project-folder-count" aria-hidden="true">{count}</span>
  </Button></span>;
}
function FolderNode({node,onSelect,onToggle,depth=0}){
  const id=useId(),hasChildren=node.children.length>0;
  return <li className="kit-project-folder-node"><div className="kit-project-folder-row" style={{paddingLeft:Math.min(depth,4)*12}}>
    <span className="kit-project-folder-disclosure">{hasChildren&&<Button variant="ghost" size="sm" aria-label={`${node.expanded?t('收起','Collapse'):t('展开','Expand')} ${node.path}`} aria-expanded={node.expanded} aria-controls={id}
      onClick={()=>onToggle(node.path,!node.expanded)} style={{padding:0,width:24,minWidth:24,height:30}}><svg aria-hidden="true" viewBox="0 0 16 16" className={node.expanded?'is-open':''}><path d="m6 4 4 4-4 4"/></svg></Button>}</span>
    <FolderAction path={node.path} label={node.label} count={node.count} selected={node.selected} onClick={()=>onSelect(node.path)}/>
  </div>{hasChildren&&<ul id={id} hidden={!node.expanded} className="kit-project-folder-children">{node.children.map(child=><FolderNode key={child.path} node={child} onSelect={onSelect} onToggle={onToggle} depth={depth+1}/>)}</ul>}</li>;
}
export function ProjectLibraryNavigation({projectId,model,scope='content',counts={content:model.count,records:0,all:model.count},onScope,onSelect,onToggle}){
  const scopeId=useId(),content=count(counts.content),records=count(counts.records),all=content+records;
  return <nav className="kit-project-library-nav" aria-label={scope==='records'?t('按目录浏览项目记录','Browse project records by folder'):scope==='all'?t('按目录浏览全部内容','Browse all content by folder'):t('按目录浏览资料','Browse sources by folder')} data-project-library={projectId} data-project-library-scope={scope}>
    <div className="kit-project-library-scopes" aria-describedby={scopeId}><KitSegmentedControl value={scope} onChange={onScope} disabled={typeof onScope!=='function'} label={t('项目内容范围','Project content scope')}
      options={[
        {value:'content',label:t(`资料 ${content}`,`Sources ${content}`),attributes:{'data-project-library-scope':'content','aria-label':t(`资料，${content} 项`,`Sources, ${content} items`)}},
        {value:'records',label:t(`记录 ${records}`,`Records ${records}`),attributes:{'data-project-library-scope':'records','aria-label':t(`项目记录，${records} 项`,`Project records, ${records} items`)}},
        {value:'all',label:t(`全部 ${all}`,`All ${all}`),attributes:{'data-project-library-scope':'all','aria-label':t(`全部内容，${all} 项`,`All content, ${all} items`)}},
      ]}/></div>
    <p id={scopeId} className="kit-project-library-scope-caption">{t('当前范围：','Current scope: ')}<span>{scopeName(scope)}</span></p>
    <ul className="kit-project-folder-list">
      <li className="kit-project-folder-row"><span className="kit-project-folder-disclosure"/><FolderAction all path={null} label={rootName(scope)} count={model.count} selected={model.selected===null} onClick={()=>onSelect(null)}/></li>
      {model.uncategorized>0&&<li className="kit-project-folder-row"><span className="kit-project-folder-disclosure"/><FolderAction path="" label={t('未分类','Uncategorized')} count={model.uncategorized} selected={model.selected===''} onClick={()=>onSelect('')}/></li>}
      {model.roots.map(node=><FolderNode key={node.path} node={node} onSelect={onSelect} onToggle={onToggle}/>)}
    </ul>
  </nav>;
}
export function ProjectLibraryBreadcrumb({model,scope='content',onSelect,onReveal}){
  return <nav className="kit-project-library-location" aria-label={scope==='records'?t('当前项目记录位置','Current project record location'):scope==='all'?t('当前内容位置','Current content location'):t('当前资料位置','Current source location')}>
    <ol><li>{model.selected===null?<span aria-current="location">{rootName(scope)}</span>:<Button variant="ghost" size="sm" onClick={()=>onSelect(null)} style={{padding:'3px 5px',fontWeight:450}}>{rootName(scope)}</Button>}</li>
      {model.breadcrumbs.map((part,index)=><li key={part.path}><span className="kit-project-location-separator" aria-hidden="true">/</span>{index===model.breadcrumbs.length-1?<span className="kit-project-location-current" aria-current="location" data-user-content={part.path?true:undefined}>{part.label||t('未分类','Uncategorized')}</span>:<Button variant="ghost" size="sm" title={part.path} onClick={()=>onSelect(part.path)} style={{padding:'3px 5px',fontWeight:450,whiteSpace:'normal',overflowWrap:'anywhere',textAlign:'left'}}>{part.label}</Button>}</li>)}
    </ol>{model.hiddenSelection&&<Button variant="ghost" size="sm" onClick={onReveal} aria-label={t('在目录中显示当前位置','Reveal current folder in navigation')} style={{padding:'3px 6px',flexShrink:0}}>{t('在目录中显示','Show in folders')}</Button>}
  </nav>;
}
