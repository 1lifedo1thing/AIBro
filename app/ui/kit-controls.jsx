import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Choicebox, Checkbox, RadioGroup, SwitchToggle, SegmentedControl, Tabs, SearchInput, Select,
  Heading, Text, Button, IconButton, Divider, AlertBanner,
} from './halaska-kit.jsx';
import styles from './kit-controls.css';

// The named upstream components own their visual structure and motion. These
// adapters add host semantics, disabled guards and real controlled callbacks;
// no upstream demo state or simulated save operation is used.
if (!document.getElementById('halaska-controls-styles')) {
  const style = document.createElement('style'); style.id = 'halaska-controls-styles';
  style.textContent = styles; document.head.append(style);
}
// Render chrome explicitly in the document language; never translate user values.
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;
const normalOptions = options => (options || []).map(option => typeof option === 'string' ? { value: option, label: option } : option);
function focusOption(event, buttons) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return null;
  const enabled = buttons.filter(button => !button.disabled);
  if (!enabled.length) return null;
  const index = Math.max(0, enabled.indexOf(event.target.closest('button')));
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + enabled.length) % enabled.length;
  event.preventDefault(); enabled[next].focus(); return enabled[next];
}

export function KitChoicebox({ options = [], value, onChange, multiple = false, disabled = false, label = t('选择选项', 'Choose an option'), optionClassName = '', theme }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    [...ref.current.querySelectorAll('button')].forEach((button, index) => {
      const option = options[index]; if (!option) return;
      button.className = optionClassName; button.dataset.mode = option.id;
      button.disabled = disabled || !!option.disabled;
      button.setAttribute('aria-pressed', String(multiple ? (value || []).includes(option.id) : value === option.id));
    });
  }, [options, value, disabled, multiple, optionClassName]);
  return <div ref={ref} className="kit-choicebox" role="group" aria-label={label} aria-busy={disabled || undefined}
    onKeyDown={event => focusOption(event, [...ref.current.querySelectorAll('button')])}>
    <Choicebox options={options} value={value} multiple={multiple} theme={theme}
      onChange={next => { if (!disabled && (multiple || !options.find(option => option.id === next)?.disabled)) onChange?.(next); }} />
  </div>;
}

// Upstream Checkbox/Radio render clickable divs. A real input supplies native
// Space/arrow keys, labels and disabled behavior; their named kit component is
// retained as the presentation rather than exposing duplicate controls to AT.
export function KitCheckbox({ id, checked = false, onChange, label, description, disabled = false, theme }) {
  const generated = useId(), inputId = id || `kit-checkbox-${generated}`;
  return <div className="kit-input-wrap kit-checkbox-wrap">
    <input id={inputId} className="kit-input-hit" type="checkbox" checked={checked} disabled={disabled}
      aria-label={label} aria-describedby={description ? `${inputId}-description` : undefined} onChange={event => onChange?.(event.target.checked)} />
    <div aria-hidden="true" className="kit-input-presentation"><Checkbox checked={checked} label={label} disabled={disabled} theme={theme} /></div>
    {description && <div id={`${inputId}-description`} className="kit-control-description">{description}</div>}
  </div>;
}
export function KitSwitch({ id, checked = false, onChange, label, description, disabled = false, theme }) {
  const generated = useId(), inputId = id || `kit-switch-${generated}`, ref = useRef(null);
  useLayoutEffect(() => { const button = ref.current?.querySelector('button'); if (button) { button.tabIndex = -1; button.disabled = true; } }, [checked]);
  return <div className="kit-input-wrap kit-switch-wrap" ref={ref} data-disabled={disabled || undefined}>
    <input id={inputId} className="kit-input-hit" type="checkbox" role="switch" checked={checked} disabled={disabled}
      aria-label={label} aria-describedby={description ? `${inputId}-description` : undefined} onChange={event => onChange?.(event.target.checked)} />
    <div aria-hidden="true" className="kit-input-presentation"><SwitchToggle checked={checked} label={label} theme={theme} /></div>
    {description && <div id={`${inputId}-description`} className="kit-control-description">{description}</div>}
  </div>;
}
export function KitRadioGroup({ options = [], value, onChange, label, disabled = false, theme }) {
  const groupId = useId(), items = normalOptions(options);
  return <fieldset className="kit-radio-group" disabled={disabled}>
    {label && <legend>{label}</legend>}
    {items.map(option => <div key={option.value} className="kit-input-wrap kit-radio-wrap">
      <input type="radio" className="kit-input-hit" name={groupId} checked={value === option.value} disabled={disabled || option.disabled}
        aria-label={option.label} value={option.value} onChange={event => { if (event.target.checked) onChange?.(option.value); }} />
      <div aria-hidden="true" className="kit-input-presentation"><RadioGroup options={[option]} value={value} theme={theme} /></div>
    </div>)}
  </fieldset>;
}

function KitNavigation({ options, value, onChange, label, disabled, theme, tabs }) {
  const ref = useRef(null), generated = useId(), items = normalOptions(options);
  const labels = items.map(option => option.label), selected = items.find(option => option.value === value);
  useLayoutEffect(() => {
    const buttons = [...ref.current.querySelectorAll('button')];
    buttons.forEach((button, index) => {
      const option = items[index]; if (!option) return;
      button.disabled = !!disabled || !!option.disabled;
      button.dataset.value = option.value;
      button.id = option.id || `kit-${tabs ? 'tab' : 'segment'}-${generated}-${index}`;
      if (option.controls) button.setAttribute('aria-controls', option.controls); else button.removeAttribute('aria-controls');
      if (option.attributes) Object.entries(option.attributes).forEach(([name, attribute]) => { if (/^(data-|aria-)/.test(name)) button.setAttribute(name, String(attribute)); });
      button.setAttribute(tabs ? 'aria-selected' : 'aria-checked', String(option.value === value));
      button.setAttribute('role', tabs ? 'tab' : 'radio');
      button.tabIndex = option.value === value || (!selected && !index) ? 0 : -1;
    });
  });
  const select = nextLabel => { const item = items.find(option => option.label === nextLabel); if (!disabled && item && !item.disabled) onChange?.(item.value); };
  return <div ref={ref} className={`kit-navigation ${tabs ? 'kit-tabs' : 'kit-segments'}`} role={tabs ? 'tablist' : 'radiogroup'} aria-label={label}
    onKeyDown={event => { const button = focusOption(event, [...ref.current.querySelectorAll('button')]); if (button) onChange?.(button.dataset.value); }}>
    {tabs ? <Tabs tabs={labels} value={selected?.label} onChange={select} theme={theme} /> : <SegmentedControl options={labels} value={selected?.label} onChange={select} theme={theme} />}
  </div>;
}
export function KitSegmentedControl({ options = [], value, onChange, label = t('切换视图', 'Switch view'), disabled = false, theme }) {
  return <KitNavigation {...{ options, value, onChange, label, disabled, theme }} />;
}
export function KitTabs({ tabs, options = tabs || [], value, onChange, label = t('切换页面', 'Switch page'), disabled = false, theme }) {
  return <KitNavigation {...{ options, value, onChange, label, disabled, theme }} tabs />;
}

export function KitPermissionPicker({ choices, mode, reviewerApprove, reviewerHalted, busy, error, onModeChange, onReviewerChange, onClose }) {
  return <section className="kit-permission-content" aria-busy={busy || undefined}>
    <header className="kit-dialog-heading"><div><Heading level={3}>{t('操作权限', 'Operation permissions')}</Heading><Text size="sm" secondary>{t('如何批准这条对话中的 Agent 操作？', 'How should the agent request approval in this chat?')}</Text></div>
      <IconButton icon="×" label={t('关闭权限选择', 'Close permission picker')} onClick={onClose} /></header>
    <KitChoicebox options={choices} value={mode} onChange={onModeChange} disabled={busy} label={t('当前对话的操作权限', 'This chat’s permissions')} optionClassName="permission-choice" />
    <Divider spacing={16} />
    <div className="permission-delegate kit-permission-delegate"><KitSwitch id="reviewerApprove" checked={reviewerApprove} disabled={busy} label={t('审查者可代批需审批的动作', 'Let the reviewer decide approval-required actions')} onChange={onReviewerChange}
      description={reviewerHalted ? t('审查者已连续不建议执行，代批已暂停；你亲自批准或拒绝一次后恢复。', 'The reviewer objected repeatedly, so delegation is paused. Approve or reject once yourself to resume.') : t('只对非破坏性、本应用范围内的动作生效；不可逆动作与归属确认始终由你点头。连续 3 次不建议执行会自动停止。', 'Applies only to non-destructive actions inside this app. Irreversible actions and routing confirmations always need your approval. Three consecutive objections stop delegation automatically.')} /></div>
    {error && <div role="alert"><AlertBanner variant="danger" title={t('更改尚未保存', 'Changes have not been saved')} description={error} /></div>}
    {busy && <p className="kit-control-description" role="status">{t('正在保存权限设置…', 'Saving permissions…')}</p>}
    <p className="permission-picker-note">{t('仅应用于此对话的后续执行。文件修改限已连接目录并保留审阅快照；浏览器默认自动执行，“请求批准”模式会逐次询问；终端命令仍需具体参数审批，已记住的固定检查除外。', 'Applies to future turns in this chat. File edits stay within connected folders with review snapshots. Browser actions run automatically by default; Ask for approval prompts for each action. Terminal commands still require approval of exact arguments, except remembered fixed checks.')}</p>
  </section>;
}
export function KitReadConfirmation({ title, detail, onCancel, onApprove }) {
  return <section className="kit-read-content" data-user-content><Heading level={3}>{title}</Heading><Text as="p" secondary>{detail}</Text>
    <div className="kit-dialog-actions dialog-actions"><Button variant="secondary" onClick={onCancel}>{t('取消', 'Cancel')}</Button><Button variant="accent" onClick={onApprove}>{t('允许本次读取', 'Allow this read')}</Button></div>
  </section>;
}


export function KitSearchInput({ value = '', onChange, onCompositionStart, onCompositionEnd, disabled = false, label = t('搜索', 'Search'), placeholder = t('搜索…', 'Search…'), attributes = {}, theme }) {
  const ref = useRef(null), composing = useRef(false), lastSubmitted = useRef(String(value));
  const [draft, setDraft] = useState(String(value));
  useLayoutEffect(() => { if (!composing.current) { setDraft(String(value)); lastSubmitted.current = String(value); } }, [value]);
  const submit = next => { if (next !== lastSubmitted.current) { lastSubmitted.current = next; onChange?.(next); } };
  useLayoutEffect(() => {
    const input = ref.current.querySelector('input');
    input.disabled = disabled; input.setAttribute('aria-label', label); input.type = 'search';
    Object.entries(attributes).forEach(([name, attribute]) => { if (/^(data-|aria-)/.test(name) || ['id', 'title', 'name'].includes(name)) input.setAttribute(name, String(attribute)); });
    const clear = ref.current.querySelector('button'); if (clear) { clear.disabled = disabled; clear.setAttribute('aria-label', t('清除搜索', 'Clear search')); }
    const start = event => { composing.current = true; onCompositionStart?.(event); };
    const end = event => { composing.current = false; const next = event.target.value; setDraft(next); submit(next); onCompositionEnd?.(event); };
    input.addEventListener('compositionstart', start); input.addEventListener('compositionend', end);
    return () => { input.removeEventListener('compositionstart', start); input.removeEventListener('compositionend', end); };
  });
  return <div ref={ref} className="kit-search-input"><SearchInput value={draft} placeholder={placeholder} shortcut={false} theme={theme}
    onChange={next => { if (disabled) return; setDraft(next); if (!composing.current) submit(next); if (!next) ref.current?.querySelector('input')?.focus({ preventScroll: true }); }} /></div>;
}
export function KitSelect({ id, options = [], value, onChange, label = t('选择', 'Select'), placeholder = t('选择…', 'Select…'), disabled = false, attributes = {}, size = 'sm', theme }) {
  const ref = useRef(null), items = normalOptions(options);
  useLayoutEffect(() => { const button = ref.current.querySelector('button'); if (button) { button.tabIndex = -1; button.disabled = true; } });
  const safeAttributes = Object.fromEntries(Object.entries(attributes).filter(([name]) => /^(data-|aria-)/.test(name) || ['title', 'name'].includes(name)));
  return <div ref={ref} className="kit-input-wrap kit-select-wrap" data-disabled={disabled || undefined}>
    <select {...safeAttributes} id={id} className="kit-input-hit" aria-label={label} value={value} disabled={disabled} onChange={event => onChange?.(event.target.value)}>
      {!items.some(option => String(option.value) === String(value)) && <option value="" disabled>{placeholder}</option>}
      {items.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    <div aria-hidden="true" className="kit-input-presentation"><Select options={items} value={value} placeholder={placeholder} size={size} disabled={disabled} theme={theme} /></div>
  </div>;
}
