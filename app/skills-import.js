(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SkillsImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  // 把外部 SKILL.md（Claude Code / agentskills 约定）映射到本应用的技能结构。
  // 风险扫描只做告知：命中项展示给用户，但不阻止导入，也不修改内容。
  const MAX_INSTRUCTIONS = 12000;
  const MAX_DESCRIPTION = 240;

  const text = value => typeof value === 'string' ? value.trim() : '';
  const okName = value => !!value && value.length <= 60;
  const okCommand = value => /^[a-z][a-z0-9-]{0,39}$/.test(value);
  const okDescription = value => value.length <= MAX_DESCRIPTION;
  const okInstructions = value => !!value && value.length <= MAX_INSTRUCTIONS;

  const RISKS = [
    { id: 'shell', level: 'high', label: '要求执行终端命令', pattern: /rm\s+-rf|sudo\s|curl\s|wget\s|执行(以下|下列)?命令|运行(以下|下列)?命令|终端命令|bash\s+-c|shell\s+command/i },
    { id: 'exfil', level: 'high', label: '可能把内容发送到外部', pattern: /上传到|发送到|同步到(云|服务器)|上传(数据|内容|文件)|upload\s+to|post\s+to|webhook|exfiltrat/i },
    { id: 'bypass', level: 'high', label: '要求绕过审批或忽略既有规则', pattern: /绕过(审批|权限|确认|限制)|无需(确认|审批|询问)|不用(确认|询问)|忽略(上述|以上|之前|前面)的?(规则|指令|要求)|ignore (the )?(previous|above|prior)/i },
    { id: 'credentials', level: 'high', label: '涉及凭据或敏感文件', pattern: /api[_\s-]?key|access[_\s-]?token|\.env\b|密钥|密码|凭据|credential/i },
    { id: 'network', level: 'info', label: '引用了外部网址', pattern: /https?:\/\/[^\s)]+/i }
  ];

  function scan(value) {
    const body = String(value == null ? '' : value);
    const found = [];
    for (const risk of RISKS) {
      const match = body.match(risk.pattern);
      if (!match) continue;
      // 片段从匹配处向前回退，但不在词中间切断（避免出现残缺的网址）。
      const hit = match.index || 0;
      let at = Math.max(0, hit - 20);
      if (at > 0) { const boundary = Math.max(body.lastIndexOf(' ', at), body.lastIndexOf('\n', at), body.lastIndexOf('，', at)); if (boundary >= 0 && boundary > at - 20) at = boundary + 1; }
      found.push({ id: risk.id, level: risk.level, label: risk.label, sample: body.slice(at, at + 90).replace(/\s+/g, ' ').trim() });
    }
    return found;
  }

  function parseDocument(value) {
    const source = String(value == null ? '' : value).replace(/^﻿/, '');
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return { meta: {}, body: source.trim() };
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!pair) continue;
      let value2 = pair[2].trim();
      if ((value2.startsWith('"') && value2.endsWith('"')) || (value2.startsWith("'") && value2.endsWith("'"))) value2 = value2.slice(1, -1);
      meta[pair[1].toLowerCase()] = value2;
    }
    return { meta, body: source.slice(match[0].length).trim() };
  }

  function command(value) {
    return text(value).toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  function fromEntries(entries, options) {
    const list = Array.isArray(entries) ? entries : [];
    const settings = options && typeof options === 'object' ? options : {};
    const results = [];
    for (const entry of list) {
      const path = text(entry?.path) || 'SKILL.md';
      const segments = path.split('/').filter(Boolean);
      const file = segments.at(-1) || 'SKILL.md';
      const folder = segments.length > 1 ? segments.at(-2) : '';
      if (!/\.md$/i.test(file)) continue;
      const source = String(entry?.text == null ? '' : entry.text);
      const { meta, body } = parseDocument(source);
      const isSkillFile = /^skill\.md$/i.test(file);
      if (!isSkillFile && !Object.keys(meta).length) continue; // 既非 SKILL.md 也无 frontmatter：不作为技能候选
      const displayName = text(meta.name) || text(meta.title) || folder || file.replace(/\.md$/i, '');
      const draft = {
        name: displayName,
        command: command(meta.name || folder || file.replace(/\.md$/i, '')),
        description: text(meta.description).slice(0, MAX_DESCRIPTION),
        instructions: body
      };
      const problems = [];
      if (!okName(draft.name)) problems.push(draft.name ? '名称超过 60 字' : '缺少名称');
      if (!okCommand(draft.command)) problems.push(draft.command ? `快捷命令不合法：${draft.command}` : '无法从名称生成快捷命令');
      if (!okInstructions(draft.instructions)) problems.push(draft.instructions ? `工作流说明超过 ${MAX_INSTRUCTIONS} 字，请先拆分或精简` : '没有可用的工作流说明');
      if (!okDescription(draft.description)) problems.push('简介超过 240 字');
      results.push({ path, draft, warnings: scan(`${draft.description}\n${draft.instructions}`), problems, descriptionMissing: !draft.description });
    }
    return results;
  }

  // 冲突只在"命令"这一维度判定：命令是用户实际输入的东西，也决定能否并存。
  function resolve(items, existing) {
    const taken = new Map();
    for (const skill of Array.isArray(existing) ? existing : []) {
      if (skill?.builtin || !skill?.command) continue;
      taken.set(skill.command, { id: skill.id, name: skill.name });
    }
    const builtinCommands = new Set((Array.isArray(existing) ? existing : []).filter(skill => skill?.builtin).map(skill => skill.command));
    const withinBatch = new Set();
    return (Array.isArray(items) ? items : []).map(item => {
      const name = item.draft?.command || '';
      const conflict = taken.get(name) || null;
      const builtinConflict = builtinCommands.has(name) ? name : '';
      const duplicate = withinBatch.has(name);
      withinBatch.add(name);
      const action = duplicate ? 'duplicate' : builtinConflict ? 'builtin' : conflict ? 'overwrite' : 'create';
      return { ...item, action, existing: conflict, builtinConflict };
    });
  }

  function summarize(items) {
    const counts = { create: 0, overwrite: 0, duplicate: 0, builtin: 0 };
    for (const item of Array.isArray(items) ? items : []) if (Object.hasOwn(counts, item.action)) counts[item.action] += 1;
    return counts;
  }

  return { parseDocument, scan, command, fromEntries, resolve, summarize, RISKS, MAX_INSTRUCTIONS, MAX_DESCRIPTION };
});
