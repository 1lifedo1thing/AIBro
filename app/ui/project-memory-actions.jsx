import React from 'react';
import { Button } from './halaska-kit.jsx';
import styles from './project-memory-actions.css';
const t=(zh,en)=>document.documentElement.lang.startsWith('en')?en:zh;
if(!document.getElementById('halaska-project-memory-actions')){const style=document.createElement('style');style.id='halaska-project-memory-actions';style.textContent=styles;document.head.append(style);}
export function ProjectMemoryActions({busy=false,onOpen,onAutomation}){
  return <div className="kit-project-memory-actions" role="group" aria-label={t('项目记录','Project records')} aria-busy={busy||undefined}>
    {[['long',t('项目记忆','Project memory')],['plan',t('计划与产出','Plan & outputs')],['daily',t('进展日记','Daily progress')]].map(([kind,label])=><Button key={kind} variant="ghost" size="sm" disabled={busy||typeof onOpen!=='function'} onClick={event=>onOpen(kind,event.currentTarget)}>{label}</Button>)}
    {onAutomation&&<Button variant="ghost" size="sm" disabled={busy} onClick={event=>onAutomation(event.currentTarget)}>{t('自动任务','Automatic tasks')}</Button>}
  </div>;
}
