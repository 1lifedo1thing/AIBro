(function (root) {
  'use strict';
  const Core = root.WorkstationSkillsCore;
  let hooks = null;
  let dialog, listBox, editor, status, sidebarButton, composerButton, picker, input, selectedBar, selectedSummary;
  const selectionControls = new Map();
  const chipHosts = new Map();
  const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement?.lang || '') ? en : zh;
  let editingId = null;
  let choices = [];
  let activeChoice = 0;
  let dismissedSlash = null;
  let initialized = false;
  const state = () => hooks.getState();
  const conversation = () => hooks.getConversation?.() || (state().conversations || []).find(item => item.id === state().currentConversationId);
  const element = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; };
  const button = (label, className, action) => { const node = element('button', className, label); node.type = 'button'; if (action) node.addEventListener('click', action); return node; };
  const report = message => { if (status) status.textContent = message; hooks.toast?.(message); };

  function commit(next) {
    const current = state();
    if (Array.isArray(next.skills)) current.skills = next.skills;
    // Keep conversation identities intact for active agent runs.
    (next.conversations || []).forEach(updated => {
      const original = (current.conversations || []).find(item => item.id === updated.id);
      if (original && Object.prototype.hasOwnProperty.call(updated, 'skillId')) original.skillId = updated.skillId;
      if (original && Array.isArray(updated.skillIds)) original.skillIds = [...updated.skillIds];
      if (original && updated.updatedAt) original.updatedAt = updated.updatedAt;
    });
    const saved = hooks.save();
    if (saved?.catch) saved.catch(error => report(error?.message || '技能保存失败，请重试'));
    refresh();
  }
  function applySkill(id, { toggle = false } = {}) {
    try {
      let current = conversation();
      if (!current && hooks.newConversation) { hooks.newConversation(); current = conversation(); }
      const ids = Core.selectedAll(state(), current).map(skill => skill.id);
      commit(id ? toggle ? Core.toggle(state(), current?.id, id) : Core.setSelection(state(), current?.id, [...ids, id]) : Core.setSelection(state(), current?.id, []));
      const slash = Core.slashQuery(input.value) !== null;
      if (slash) { input.value = ''; if (current) current.draft = ''; input.dispatchEvent(new Event('input', { bubbles: true })); hooks.save(); }
      closePicker();
      if (!dialog.open) input.focus();
      status.textContent = `${t('已选择', 'Selected')} ${Core.selectedAll(state(), current).length} ${t('个技能，将共同用于后续消息。', 'skills for future messages.')}`;
    } catch (error) { report(error.message); }
  }
  function updateSelections() {
    const skills = Core.selectedAll(state(), conversation()), ids = skills.map(skill => skill.id), enabled = state().settings?.skillsEnabled !== false;
    for (const [id, host] of selectionControls) {
      const skill = Core.get(state(), id); if (!skill) continue;
      const checked = ids.includes(id), label = `${t('选择', 'Select ')}${skill.name}`;
      if (root.HalaskaUI && host.dataset.halaskaRoot) root.HalaskaUI.update(host, { checked, label, disabled: skill.enabled === false && !checked });
      else { const check = host.querySelector('input'); if (check) { check.checked = checked; check.disabled = skill.enabled === false && !checked; } }
    }
    if (selectedSummary) selectedSummary.textContent = skills.length ? `${t('已选择', 'Selected')} ${skills.length} ${t('项 · 可继续勾选', '· choose more')}${enabled ? '' : t(' · 已暂停注入', ' · injection paused')}` : t('可同时选择多个技能，点击“完成”返回对话。', 'Choose multiple skills, then return to the conversation.');
    if (dialog) { const clear = dialog.querySelector('#skillsClear'); if (clear) clear.disabled = !skills.length; }
    if (!selectedBar) return;
    selectedBar.hidden = !skills.length;
    selectedBar.dataset.paused = String(!enabled);
    for (const [id, host] of chipHosts) if (!ids.includes(id)) { root.HalaskaUI?.unmount(host); host.remove?.(); chipHosts.delete(id); }
    for (const skill of skills) {
      let host = chipHosts.get(skill.id);
      if (!host) { host = element('span', 'skill-selected-chip'); host.dataset.skillChip = skill.id; host.setAttribute('data-user-content', ''); chipHosts.set(skill.id, host); selectedBar.append(host); }
      const paused = !enabled || skill.enabled === false;
      const label = `${skill.name}${paused ? t('（已暂停）', ' (paused)') : ''} ×`;
      const remove = () => { applySkill(skill.id, { toggle: true }); if (!dialog.open) input.focus(); };
      if (root.HalaskaUI) root.HalaskaUI.mount(host, 'Button', { size: 'sm', variant: 'secondary', children: label, title: skill.description || skill.name, 'aria-label': `${t('移除技能：', 'Remove skill: ')}${skill.name}`, onClick: remove });
      else { host.replaceChildren(button(label, 'skill-chip-remove', remove)); }
    }
  }
  function renderList() {
    editingId = null; editor.hidden = true; listBox.hidden = false;
    dialog.querySelector('.skills-toolbar').hidden = false;
    for (const host of selectionControls.values()) root.HalaskaUI?.unmount(host);
    selectionControls.clear();
    listBox.replaceChildren(); status.textContent = '';
    const selectedIds = Core.selectedAll(state(), conversation()).map(skill => skill.id);
    Core.list(state()).forEach(skill => {
      const row = element('div', 'skills-row');
      const copy = element('div', 'skills-copy');
      const name = element('div', `skills-name${skill.builtin ? ' skills-builtin' : ''}`);
      const title = element('span', '', skill.name); title.setAttribute(skill.builtin ? 'data-i18n' : 'data-user-content', ''); name.append(title);
      name.append(element('code', 'skills-command', `/${skill.command}`));
      if (skill.builtin) { const badge = element('span', 'skills-badge', '内置'); badge.setAttribute('data-i18n', ''); name.append(badge); }
      const description = element('p', '', skill.description || '自定义工作流'); description.setAttribute(skill.builtin || !skill.description ? 'data-i18n' : 'data-user-content', '');
      copy.append(name, description);
      const actions = element('div', 'skills-actions');
      actions.append(button(skill.builtin ? '查看' : '编辑', 'skills-button', () => showEditor(skill)));
      const host = element('span', 'skill-selection-control'); host.dataset.skillControl = skill.id; actions.append(host); row.append(copy, actions); listBox.append(row);
      selectionControls.set(skill.id, host);
      const label = `${t('选择', 'Select ')}${skill.name}`, checked = selectedIds.includes(skill.id), onChange = () => applySkill(skill.id, { toggle: true });
      if (root.HalaskaUI) root.HalaskaUI.mount(host, 'KitCheckbox', { id: `skill-check-${skill.id}`, checked, label, disabled: skill.enabled === false && !checked, onChange });
      else { const wrap = element('label'), check = element('input'); check.type = 'checkbox'; check.checked = checked; check.setAttribute('aria-label', label); check.addEventListener('change', onChange); wrap.append(check, element('span', '', t('选择', 'Select'))); host.append(wrap); }
    });
    updateSelections();
    const toggle = dialog.querySelector('#skillsEnabled');
    if (toggle) toggle.checked = state().settings?.skillsEnabled !== false;
  }
  function field(label, key, value, maxLength, multiline, readonly) {
    const wrap = element('label', 'skills-field'); wrap.append(element('span', '', label));
    const control = element(multiline ? 'textarea' : 'input', 'skills-input');
    control.name = key; control.id = `skillsField-${key}`; control.value = value || ''; control.maxLength = maxLength; control.readOnly = !!readonly;
    if (!multiline) { control.type = 'text'; control.autocomplete = 'off'; }
    if (key === 'command') { control.placeholder = '例如 weekly-review'; control.spellcheck = false; }
    if (key === 'instructions') control.placeholder = '描述适用场景、具体步骤和期望结果……';
    wrap.append(control); return wrap;
  }
  function copyAsCustom(skill) {
    // Allocate from the current catalog when the user opens a copy. Core.upsert
    // validates again on Save in case another operation claimed the command.
    const commands = new Set(Core.list(state()).map(item => item.command));
    let index = 1, command;
    do {
      const suffix = index === 1 ? '-custom' : `-custom-${index}`;
      command = `${skill.command.slice(0, 40 - suffix.length)}${suffix}`;
      index++;
    } while (commands.has(command));
    const nameSuffix = index === 2 ? ' · 自定义' : ` · 自定义 ${index - 1}`;
    const draft = { name: `${skill.name.slice(0, 60 - nameSuffix.length)}${nameSuffix}`, command, description: skill.description, instructions: skill.instructions, builtin: false };
    showEditor(draft);
    status.textContent = `已复制「${skill.name}」的说明，可按研究方向修改。点击“保存技能”后才会创建；当前对话的技能不会改变。`;
  }
  function showEditor(skill = null) {
    editingId = skill?.id || null; status.textContent = '';
    listBox.hidden = true; dialog.querySelector('.skills-toolbar').hidden = true; editor.hidden = false; editor.replaceChildren();
    editor.append(field('名称', 'name', skill?.name, 60, false, skill?.builtin), field('快捷命令 /', 'command', skill?.command, 40, false, skill?.builtin), field('简介', 'description', skill?.description, 240, false, skill?.builtin), field('工作流说明', 'instructions', skill?.instructions, 12000, true, skill?.builtin));
    const actions = element('div', 'skills-editor-actions');
    if (skill?.builtin) actions.append(button('复制为自定义', 'skills-button skills-primary', () => copyAsCustom(skill)));
    if (skill?.id && !skill.builtin) actions.append(button('删除技能', 'skills-button skills-danger', () => {
      if (!root.confirm(`删除「${skill.name}」？它会从对话选择中移除，其他技能保持不变。`)) return;
      try { commit(Core.remove(state(), skill.id)); renderList(); hooks.toast?.('技能已删除'); } catch (error) { report(error.message); }
    }));
    actions.append(button('返回', 'skills-button', renderList));
    if (!skill?.builtin) actions.append(button('保存技能', 'skills-button skills-primary', () => {
      const draft = { id: editingId };
      ['name', 'command', 'description', 'instructions'].forEach(key => { draft[key] = editor.querySelector(`[name=${key}]`).value; });
      try { commit(Core.upsert(state(), draft)); renderList(); hooks.toast?.('技能已保存'); } catch (error) { report(error.message); }
    }));
    editor.append(actions); editor.querySelector('input')?.focus();
  }
  // 导入外部技能：只做映射与风险告知，不执行技能里的任何内容，也不改写正文。
  async function readEntries(fileList) {
    const entries = [], skipped = [];
    for (const file of fileList) {
      const path = file.webkitRelativePath || file.name;
      if (!/\.(md|markdown)$/i.test(path)) continue;
      if (file.size > 400000) { skipped.push(path + '（超过 400 KB）'); continue; }
      try { entries.push({ path, text: await file.text() }); } catch (_) { skipped.push(path + '（读取失败）'); }
    }
    return { entries, skipped };
  }
  function showImport() {
    editingId = null; status.textContent = '';
    listBox.hidden = true; dialog.querySelector('.skills-toolbar').hidden = true; editor.hidden = false; editor.replaceChildren();
    const Importer = root.SkillsImport;
    editor.append(element('h3', 'skills-import-title', '导入技能'));
    if (!Importer) { editor.append(element('p', 'skills-field-note', '导入模块未加载，请重新打开应用。'), button('返回', 'skills-button', renderList)); return; }
    editor.append(element('p', 'skills-field-note', '支持技能文件夹（含 SKILL.md）或多个 Markdown 文件。只做字段映射与风险告知；技能里的命令与链接不会被自动执行。'));
    const folderInput = element('input'); folderInput.type = 'file'; folderInput.webkitdirectory = true; folderInput.multiple = true; folderInput.hidden = true; folderInput.id = 'skillsImportFolder';
    const fileInput = element('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = '.md,.markdown'; fileInput.hidden = true; fileInput.id = 'skillsImportFiles';
    const preview = element('div', 'skills-import-preview');
    const read = async input => {
      const picked = [...(input.files || [])];
      if (!picked.length) return;
      const { entries, skipped } = await readEntries(picked);
      if (!entries.length) { report('没有找到可识别的 Markdown 技能文件。'); return; }
      renderPreview(preview, entries, skipped);
    };
    folderInput.addEventListener('change', () => read(folderInput));
    fileInput.addEventListener('change', () => read(fileInput));
    const actions = element('div', 'skills-editor-actions');
    actions.append(button('选择技能文件夹', 'skills-button', () => folderInput.click()), button('选择 Markdown 文件', 'skills-button', () => fileInput.click()), button('返回', 'skills-button', renderList));
    editor.append(folderInput, fileInput, actions, preview);
  }
  function renderPreview(container, entries, skipped) {
    const Importer = root.SkillsImport;
    const items = Importer.resolve(Importer.fromEntries(entries), Core.list(state()));
    container.replaceChildren();
    if (skipped.length) container.append(element('p', 'skills-field-note', `已跳过 ${skipped.length} 个文件：${skipped.slice(0, 3).join('、')}`));
    const usable = items.filter(item => item.draft.name || item.draft.instructions);
    if (!usable.length) { container.append(element('p', 'skills-field-note', '这些文件里没有可识别的技能：需要名为 SKILL.md，或带有 name / description 头部的 Markdown。')); return; }
    const rows = [];
    const actionLabels = { create: '新增', overwrite: '将覆盖同名命令的现有技能', duplicate: '与本批另一项重复', builtin: '与内置技能的快捷命令冲突' };
    items.forEach((item, index) => {
      const row = element('div', 'skills-import-row');
      const head = element('label', 'skills-import-head');
      const check = element('input'); check.type = 'checkbox'; check.checked = !item.problems.length && item.action !== 'duplicate' && item.action !== 'builtin'; check.disabled = !!item.problems.length || item.action === 'duplicate' || item.action === 'builtin';
      head.append(check, element('strong', '', item.draft.name || '(未命名)'));
      row.append(head);
      const meta = element('p', 'skills-import-meta');
      meta.textContent = [actionLabels[item.action] || item.action, item.existing ? `（${item.existing.name}）` : '', item.draft.instructions ? `${item.draft.instructions.length} 字` : ''].filter(Boolean).join(' · ');
      row.append(meta);
      if (item.problems.length) row.append(element('p', 'skills-import-warning skills-import-high', '无法导入：' + item.problems.join('；')));
      const commandRow = element('label', 'skills-import-command'); commandRow.append(element('span', '', '快捷命令 /'));
      const commandInput = element('input', 'skills-input'); commandInput.value = item.draft.command; commandInput.maxLength = 40; commandInput.spellcheck = false; commandInput.setAttribute('aria-label', `${item.draft.name || '技能'}的快捷命令`);
      commandRow.append(commandInput); row.append(commandRow);
      for (const warning of item.warnings) row.append(element('p', `skills-import-warning${warning.level === 'high' ? ' skills-import-high' : ''}`, `提示：${warning.label} —— ${warning.sample}`));
      container.append(row); rows.push({ item, check, commandInput });
    });
    const actions = element('div', 'skills-editor-actions');
    actions.append(button('导入所选', 'skills-button skills-primary', () => runImport(rows)), button('重新选择', 'skills-button', showImport));
    container.append(actions);
  }
  function runImport(rows) {
    const chosen = rows.filter(row => row.check.checked && !row.check.disabled);
    if (!chosen.length) { report('先勾选要导入的技能。'); return; }
    let created = 0, updated = 0; const failures = []; let working = state();
    for (const row of chosen) {
      const draft = { name: row.item.draft.name, command: row.commandInput.value.trim().toLowerCase(), description: row.item.draft.description, instructions: row.item.draft.instructions };
      if (row.item.action === 'overwrite' && row.item.existing?.id) draft.id = row.item.existing.id;
      if (!draft.command) { failures.push(`${draft.name || '未命名'}：缺少快捷命令`); continue; }
      try { working = Core.upsert(working, draft); if (draft.id) updated += 1; else created += 1; }
      catch (error) { failures.push(`${draft.name || '未命名'}：${error.message}`); }
    }
    if (created || updated) commit(working);
    renderList();
    status.textContent = [created || updated ? `已导入 ${created} 个新技能${updated ? `，更新 ${updated} 个` : ''}。` : '没有导入任何技能。', ...failures].join(' ');
    hooks.toast?.(created || updated ? `已导入 ${created + updated} 个技能` : '没有导入任何技能');
  }
  function open() { closePicker(); renderList(); if (!dialog.open) dialog.showModal(); }
  function closePicker() {
    if (!picker) return;
    picker.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  function syncChoice() {
    picker.querySelectorAll('[role=option]').forEach((node, index) => node.setAttribute('aria-selected', String(index === activeChoice)));
    const active = picker.querySelector(`[aria-selected=true]`);
    if (active) { input.setAttribute('aria-activedescendant', active.id); active.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function showPicker() {
    const query = Core.slashQuery(input.value);
    if (query === null || dismissedSlash === input.value || dialog.open) { closePicker(); return; }
    choices = Core.list(state(), query); activeChoice = 0; picker.replaceChildren(); picker.hidden = false; input.setAttribute('aria-expanded', 'true');
    choices.forEach((skill, index) => {
      const item = button('', 'skill-option', () => applySkill(skill.id));
      item.id = `skill-option-${skill.id}`; item.setAttribute('role', 'option'); item.tabIndex = -1;
      const copy = element('span', 'skill-option-copy', skill.name); copy.append(element('small', '', skill.description));
      item.append(copy, element('code', 'skill-option-command', `/${skill.command}`));
      if (Core.selectionIds(conversation()).includes(skill.id)) item.append(element('span', 'skill-option-added', t('已添加', 'Added')));
      item.disabled = skill.enabled === false;
      item.addEventListener('mouseenter', () => { activeChoice = index; syncChoice(); });
      item.addEventListener('mousedown', event => event.preventDefault()); picker.append(item);
    });
    if (!choices.length) picker.append(element('div', 'skills-empty', '没有匹配的技能，可在侧栏 Skills 中创建。'));
    syncChoice();
  }
  function refresh() {
    if (!initialized) return;
    const skills = Core.selectedAll(state(), conversation());
    composerButton.replaceChildren(element('span', '', skills.length ? `Skills · ${skills.length}` : 'Skills')); composerButton.insertAdjacentHTML('afterbegin', root.WorkstationIcons.icon('spark'));
    composerButton.dataset.active = String(!!skills.length);
    composerButton.title = skills.length ? `${t('当前技能：', 'Selected skills: ')}${skills.map(skill => skill.name).join('、')}` : t('选择工作流技能，也可输入 /', 'Choose workflow skills, or type /');
    updateSelections();
    if (!picker.hidden) showPicker();
  }
  function init(options) {
    if (!Core) throw new Error('请先加载 skills-core.js');
    if (typeof options?.getState !== 'function' || typeof options?.save !== 'function') throw new Error('Skills 需要 getState 和 save 接口');
    hooks = options;
    if (initialized) { refresh(); return api; }
    input = document.querySelector(options.inputSelector || '#agentInput');
    const sidebar = document.querySelector(options.sidebarSelector || '#sidebar .sidebar-tools');
    const footer = document.querySelector(options.composerSelector || '#composer .composer-footer');
    if (!input || !sidebar || !footer) throw new Error('找不到 Skills 的侧栏或输入框挂载点');
    
    sidebarButton = button('', 'tool-link', open); sidebarButton.id = 'skillsButton';
    const mark = element('span', 'icon-slot'); mark.innerHTML = root.WorkstationIcons.icon('spark'); sidebarButton.append(mark, element('span', '', 'Skills')); sidebarButton.setAttribute('aria-haspopup', 'dialog'); sidebar.append(sidebarButton);
    composerButton = button('Skills', 'composer-skill', open); composerButton.id = 'composerSkill'; composerButton.setAttribute('aria-haspopup', 'dialog'); footer.insertBefore(composerButton, root.ComposerUI?.rootFor(footer.querySelector('.composer-model'))||footer.querySelector('.composer-model'));
    dialog = element('dialog'); dialog.id = 'skillsDialog'; dialog.setAttribute('aria-labelledby', 'skillsTitle');
    const header = element('div', 'skills-header'); const heading = element('div'); const title = element('h2', '', 'Skills'); title.id = 'skillsTitle'; heading.append(title, element('p', '', '可同时选择多个工作流。在输入框键入 / 可继续添加。'));
    const close = button('×', 'skills-close', () => dialog.close()); close.setAttribute('aria-label', '关闭技能管理'); header.append(heading, close);
    const toolbar = element('div', 'skills-toolbar'); const clear = button('清除全部选择', 'skills-button', () => applySkill(null)); clear.id = 'skillsClear';
    const toggleLabel = element('label', 'skills-toggle'); const toggle = element('input'); toggle.type = 'checkbox'; toggle.id = 'skillsEnabled'; toggle.checked = state().settings?.skillsEnabled !== false; toggle.addEventListener('change', () => { const current = state(); current.settings ||= {}; current.settings.skillsEnabled = toggle.checked; hooks.save(); refresh(); }); const toggleText = element('span', '', '允许注入技能说明'); toggleText.setAttribute('data-i18n', ''); toggleLabel.append(toggle, toggleText);
    const toolbarActions = element('div'); toolbarActions.style.cssText = 'display:flex;gap:8px;align-items:center'; toolbarActions.append(clear, button('导入技能', 'skills-button', () => showImport()), button('＋ 新建技能', 'skills-button skills-primary', () => showEditor())); toolbar.append(toggleLabel, toolbarActions);
    listBox = element('div', 'skills-list'); editor = element('div', 'skills-editor'); editor.hidden = true;
    status = element('div', 'skills-status'); status.setAttribute('role', 'status');
    selectedSummary = element('p', 'skills-selection-summary'); selectedSummary.setAttribute('role', 'status');
    const done = element('div', 'skills-done'); done.append(button(t('完成', 'Done'), 'skills-button skills-primary', () => { dialog.close(); input.focus(); }));
    dialog.append(header, toolbar, selectedSummary, listBox, editor, status, done); document.body.append(dialog);
    selectedBar = element('div', 'composer-selected-skills'); selectedBar.id = 'composerSelectedSkills'; selectedBar.setAttribute('role', 'group'); selectedBar.setAttribute('aria-label', t('已选择的技能，点击移除', 'Selected skills; click to remove')); selectedBar.hidden = true; footer.parentElement.insertBefore(selectedBar, footer);
    picker = element('div'); picker.id = 'skillPicker'; picker.hidden = true; picker.setAttribute('role', 'listbox'); picker.setAttribute('aria-label', '选择工作流技能'); input.closest('#composer').append(picker);
    input.setAttribute('aria-controls', 'skillPicker'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-autocomplete', 'list');
    input.addEventListener('input', () => { dismissedSlash = null; showPicker(); });
    input.addEventListener('focus', showPicker);
    root.addEventListener('keydown', event => {
      if (event.target !== input || event.isComposing || event.keyCode === 229) return;
      const isSlash = Core.slashQuery(input.value) !== null;
      if (picker.hidden && event.key === 'Enter' && isSlash && !event.shiftKey) showPicker();
      if (picker.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismissedSlash = input.value; closePicker(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); if (choices.length) activeChoice = (activeChoice + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; syncChoice(); return; }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); if (choices[activeChoice]) applySkill(choices[activeChoice].id); }
    }, true);
    document.addEventListener('click', event => {
      if (!picker.contains(event.target) && event.target !== input) closePicker();
      // Existing navigation stays in charge of state. Read its new selection
      // once its click handler has completed, without rewriting that handler.
      queueMicrotask(refresh);
    });
    document.addEventListener('workstation-language-change', () => { refresh(); if (dialog.open && !listBox.hidden) renderList(); });
    initialized = true; refresh(); return api;
  }
  const api = { init, refresh, open: () => { if (initialized) open(); }, instructionForCurrent: () => initialized ? Core.instructions(state(), conversation()) : '', instructions: (value, current) => Core.instructions(value, current) };
  root.WorkstationSkills = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
