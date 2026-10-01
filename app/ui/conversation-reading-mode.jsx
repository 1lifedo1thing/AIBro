import React from 'react';
import {Button,Caption} from './halaska-kit.jsx';
const t=(zh,en)=>globalThis.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
export function ConversationReadingMode({count,full,loading,onToggle}){
 return <><div className="conversation-reading-mode-copy"><Caption>{t(`${count} 条消息`,`${count} messages`)}</Caption><span className="conversation-reading-mode-hint">{loading?t('正在展开完整历史…','Opening complete history…'):full?t('完整阅读 · 可全选与连续朗读','Complete reading · Select all or use a screen reader'):t('按阅读位置加载 · 查找覆盖全部历史','Loads as you read · Search covers all history')}</span></div><Button size="sm" variant="ghost" onClick={onToggle} aria-pressed={full} title={t('完整阅读会展开全部消息，便于全选、复制和屏幕阅读器连续阅读','Complete reading opens every message for selection, copying and screen readers')}>{full?t('恢复流畅阅读','Resume efficient reading'):t('完整阅读','Complete reading')}</Button></>;
}
