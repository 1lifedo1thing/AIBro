/*! Adapted from AICSS ThinkingState, MIT Copyright (c) 2026 AICSS.
 * Commit cfe5549c3931452f517471bf1ac18639d1edcedd.
 * Original source and hashes: vendor/aicss/thinking-state/provenance.json.
 * The actual application supplies the label and lifecycle; no demo timers run.
 */
import React from 'react';
import styles from './aicss-thinking-state.css';

if (!document.getElementById('aicss-thinking-state-styles')) {
  const style = document.createElement('style');
  style.id = 'aicss-thinking-state-styles';
  style.textContent = styles;
  document.head.append(style);
}

export function AICSSThinkingState({ label, active = false }) {
  return <span className="aicss-thinking-label" data-aicss-thinking-state={active ? 'running' : 'settled'}>{label}</span>;
}
