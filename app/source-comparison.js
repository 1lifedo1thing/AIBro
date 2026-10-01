/* Evidence-led comparison of saved workspace sources. No model requests. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SourceComparison = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  const LIMITS = Object.freeze({ sources: 4, excerpt: 6000, criteria: 8, quote: 1200, judgment: 1600, conclusion: 6000, title: 240, label: 100, question: 2000, scope: 2000, claims: 16, claim: 1600, openQuestions: 6000 });
  const RELATIONS = ['unclassified', 'supports', 'contradicts', 'related'];
  const isResearch = data => data?.version === 2 && data.mode === 'research';
  const emptyCell = research => ({ quote: '', judgment: '', ...(research ? { relation: 'unclassified', reviewedStamp: '' } : {}) });
  const evidenceId = (rowId, sourceKey) => `evidence-${encodeURIComponent(JSON.stringify([rowId, sourceKey]))}`;
  const COLLECTIONS = { note: 'notes', import: 'imports', paper: 'papers' };
  const list = value => Array.isArray(value) ? value : [];
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const t = (zh, en) => /^en(?:-|$)/i.test(root.document?.documentElement.lang || '') ? en : zh;
  const fault = (code, zh, en) => Object.assign(new Error(t(zh, en)), { code });
  const text = value => typeof value === 'string' ? value : '';
  const short = (value, max = 240) => text(value).replace(/\s+/g, ' ').trim().slice(0, max);
  const privateItem = item => !!(item?.ephemeral || item?.private || item?.incognito);
  const active = item => !!item && !item.deleted && !item.deletedAt && !item.archived && !item.archivedAt && !item.hidden && !item.hiddenAt && !item.wikiFileError && !['deleted', 'archived', 'hidden'].includes(item.status);
  const keyOf = ref => `${ref.kind}:${ref.id}`;
  const stableJSON = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  function hash(value) { let a = 2166136261, b = 5381; for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); a = Math.imul(a ^ code, 16777619); b = Math.imul(b, 33) ^ code; } return `${value.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`; }
  const safeURL = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; } };
  function unique(items, id) { const found = list(items).filter(item => item.id === id); if (found.length > 1) throw fault('DUPLICATE_SOURCE', '来源或所属记录存在重复 ID，无法安全确定比较内容。', 'A source or owner has duplicate IDs. Its comparison content cannot be identified safely.'); return found[0]; }
  function sourceRecord(state, ref) {
    if (!COLLECTIONS[ref?.kind] || typeof ref.id !== 'string') throw fault('SOURCE_KIND', '只能比较笔记、资料或论文。', 'Compare notes, materials, or papers.');
    const record = unique(state?.[COLLECTIONS[ref.kind]], ref.id);
    const project = record?.projectId && unique(state.projects, record.projectId);
    const run = record?.agentRunId && unique(state.agentRuns, record.agentRunId);
    const conversationId = record?.sourceConversationId || run?.conversationId;
    const conversation = conversationId && unique(state.conversations, conversationId);
    if (privateItem(record) || privateItem(project) || privateItem(run) || privateItem(conversation)) throw fault('SOURCE_PRIVATE', '无痕或私密来源不能加入持久比较。', 'Private sources cannot enter a saved comparison.');
    if (!active(record) || (record.projectId && !active(project))) throw fault('SOURCE_GONE', '来源或所属项目已删除、归档或不可用。', 'The source or its project was deleted, archived, or is unavailable.');
    return record;
  }
  function sectionText(value) { if (typeof value === 'string') return value; if (Array.isArray(value)) return value.map(sectionText).filter(Boolean).join('\n'); if (value && typeof value === 'object') return ['text', 'content', 'summary'].map(key => text(value[key])).filter(Boolean).join('\n'); return ''; }
  function bodyFor(record, kind) {
    if (kind === 'paper') {
      const sections = { ...(record.structured || {}), ...(record.userEdits || {}) };
      const body = Object.entries(sections).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => { const body = sectionText(value); return body ? `[${key}]\n${body}` : ''; }).filter(Boolean).join('\n\n');
      return { body: body || text(record.abstract || record.metadata?.abstract), label: 'paper-record' };
    }
    if (kind === 'import' && !text(record.content).trim() && list(record.pages).length) {
      return { body: record.pages.map((page, index) => { const body = text(page?.text || page?.content); return body ? `[${page.page || page.pageNumber || index + 1}]\n${body}` : ''; }).filter(Boolean).join('\n\n'), label: 'extracted-pages' };
    }
    return { body: text(record.content), label: kind === 'note' ? 'note-content' : 'extracted-text' };
  }
  const snapshotCache = new WeakMap();
  function fingerprint(record, kind) {
    const { body, label } = bodyFor(record, kind);
    const metadata = { authors: Array.isArray(record.authors) ? record.authors.map(item => short(typeof item === 'string' ? item : item?.name, 100)).slice(0, 20) : [], year: short(String(record.year || ''), 20), venue: short(record.venue, 160), doi: short(record.doi, 200), url: safeURL(record.url || record.sourceUrl || record.metadata?.url), pageCount: Math.max(0, Number(record.pageCount) || list(record.pages).length) };
    const small = JSON.stringify([record.title, record.name, record.originalName, record.projectId, record.workspace, record.updatedAt, record.createdAt, metadata, label]);
    const previous = snapshotCache.get(record);
    if (previous?.body === body && previous.small === small) return previous;
    const result = { body, label, metadata, small, version: hash(small + '\n' + body) }; snapshotCache.set(record, result); return result;
  }
  function snapshot(state, ref, now = Date.now()) {
    const record = sourceRecord(state, ref), view = fingerprint(record, ref.kind), excerpt = view.body.slice(0, LIMITS.excerpt);
    return { key: keyOf(ref), kind: ref.kind, id: ref.id, title: short(record.title || record.name || record.originalName) || t('未命名来源', 'Untitled source'), projectId: record.projectId || null, workspace: record.workspace || '日常', sourceVersion: view.version, capturedAt: now, excerpt, excerptOffset: 0, excerptLabel: view.label, totalCharacters: view.body.length, truncated: view.body.length > excerpt.length, metadata: view.metadata };
  }
  function sourceStatus(state, source) {
    try { const record = sourceRecord(state, source), view = fingerprint(record, source.kind), offset = source.excerptOffset || 0; const stale = view.version !== source.sourceVersion || view.body.slice(offset, offset + source.excerpt.length) !== source.excerpt || source.totalCharacters !== view.body.length || source.excerptLabel !== view.label || source.projectId !== (record.projectId || null) || source.workspace !== (record.workspace || '日常') || source.title !== (short(record.title || record.name || record.originalName) || t('未命名来源', 'Untitled source')) || Object.entries(view.metadata).some(([key, value]) => JSON.stringify(source.metadata?.[key]) !== JSON.stringify(value)); return { available: true, stale, message: stale ? t('来源已有修改，需刷新摘录并核对证据。', 'The source changed. Refresh the excerpt and review your evidence.') : '' }; }
    catch (error) { return { available: false, stale: false, private: error.code === 'SOURCE_PRIVATE', redacted: true, message: error.message }; }
  }
  function candidates(state, query = '') {
    const result = [], q = query.trim().toLocaleLowerCase();
    for (const [kind, collection] of Object.entries(COLLECTIONS)) for (const record of list(state?.[collection])) {
      if (record.sourceComparison) continue;
      try { sourceRecord(state, { kind, id: record.id }); } catch (_) { continue; }
      const title = short(record.title || record.name || record.originalName) || t('未命名来源', 'Untitled source');
      const project = list(state.projects).find(item => item.id === record.projectId);
      if (q && !`${title} ${project?.name || ''} ${record.doi || ''}`.toLocaleLowerCase().includes(q)) continue;
      result.push({ kind, id: record.id, key: keyOf({ kind, id: record.id }), title, projectName: short(project?.name), updatedAt: Number(record.updatedAt || record.createdAt) || 0 });
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  }
  function begin(state, refs, options = {}) {
    if (!Array.isArray(refs) || refs.length < 2 || refs.length > LIMITS.sources || new Set(refs.map(keyOf)).size !== refs.length) throw fault('SOURCE_COUNT', '请选择 2–4 个不同来源进行比较。', 'Select 2–4 distinct sources to compare.');
    const sources = refs.map(ref => snapshot(state, ref, options.now));
    const commonProject = sources.every(source => source.projectId === sources[0].projectId) ? sources[0].projectId : null;
    const research = options.mode === 'research';
    const projectId = options.projectId === undefined ? research && commonProject && unique(state.projects, commonProject)?.workspace !== '科研' ? null : commonProject : options.projectId;
    const project = projectId && unique(state.projects, projectId);
    if (projectId && (!active(project) || privateItem(project))) throw fault('PROJECT_GONE', '保存项目已不可用，请重新选择。', 'Choose an available project for saving.');
    if (research && project && project.workspace !== '科研') throw fault('RESEARCH_PROJECT', '研究成果只能保存到科研空间的项目。', 'Research outputs can only be saved to a research project.');
    return { version: research ? 2 : 1, ...(research ? { mode: 'research', question: '', scope: '', researchStatus: 'draft', claims: [], openQuestions: '' } : {}), language: /^en/.test(root.document?.documentElement.lang || '') ? 'en' : 'zh', title: research ? t('研究问题与证据', 'Research question and evidence') : t('来源比较', 'Source comparison'), projectId: projectId || null, workspace: research ? '科研' : project?.workspace || sources[0].workspace || '日常', sources,
      criteria: (research ? [t('证据与适用条件', 'Evidence and applicable conditions')] : [t('核心观点', 'Core claim'), t('依据与局限', 'Evidence and limits'), t('对当前目标的价值', 'Value for this goal')]).map((label, index) => ({ id: `criterion-${index + 1}`, label, cells: Object.fromEntries(sources.map(source => [source.key, emptyCell(research)])) })), selectedKey: '', conclusion: '' };
  }
  function validate(data, incomplete = false) {
    if (data?.version !== 1 && !isResearch(data) || !Array.isArray(data.sources) || data.sources.length < 2 || data.sources.length > LIMITS.sources || data.sources.some(s => !s || typeof s !== 'object') || new Set(data.sources.map(s => s.key)).size !== data.sources.length) throw fault('COMPARISON_FORMAT', '比较来源格式无效。', 'Invalid comparison sources.');
    if (typeof data.title !== 'string' || (!incomplete && !data.title.trim()) || data.title.length > LIMITS.title) throw fault('TITLE', '填写 1–240 字符的比较标题。', 'Use a comparison title of 1–240 characters.');
    if (!Array.isArray(data.criteria) || !data.criteria.length || data.criteria.length > LIMITS.criteria || new Set(data.criteria.map(row => row.id)).size !== data.criteria.length) throw fault('CRITERIA', '比较需要 1–8 个不同维度。', 'Use 1–8 distinct comparison criteria.');
    if (text(data.conclusion).length > LIMITS.conclusion) throw fault('CONCLUSION', '结论最多 6000 个字符。', 'The conclusion can contain up to 6,000 characters.');
    if (data.selectedKey && !data.sources.some(source => source.key === data.selectedKey)) throw fault('CHOICE', '所选方案已不在比较中。', 'The selected option is no longer in this comparison.');
    for (const source of data.sources) if (!COLLECTIONS[source.kind] || typeof source.id !== 'string' || !source.id || source.id.length > 200 || /[\x00-\x1f`]/.test(source.id) || source.key !== keyOf(source) || typeof source.excerpt !== 'string' || source.excerpt.length > LIMITS.excerpt || !Number.isSafeInteger(source.excerptOffset ?? 0) || (source.excerptOffset || 0) < 0 || typeof source.sourceVersion !== 'string' || source.sourceVersion.length > 120 || !Number.isFinite(source.capturedAt) || !Number.isFinite(new Date(source.capturedAt).getTime())) throw fault('SOURCE_FORMAT', '来源快照格式无效。', 'Invalid source snapshot.');
    for (const row of data.criteria) {
      if (typeof row.id !== 'string' || !row.id || row.id.length > 100) throw fault('CRITERION_ID', '比较维度标识无效。', 'Invalid comparison criterion identity.');
      if (typeof row.label !== 'string' || (!incomplete && !row.label.trim()) || row.label.length > LIMITS.label) throw fault('LABEL', '每个比较维度需填写 1–100 个字符。', 'Each criterion needs a label of 1–100 characters.');
      for (const source of data.sources) {
        const cell = row.cells?.[source.key] || {}, quote = text(cell.quote).trim();
        if (quote.length > LIMITS.quote || text(cell.judgment).length > LIMITS.judgment) throw fault('CELL_LONG', '摘录最多 1200 字符，个人判断最多 1600 字符。', 'Evidence quotes allow 1,200 characters; judgments allow 1,600.');
        if (!incomplete && !isResearch(data) && quote && !source.excerpt.includes(quote)) throw fault('EVIDENCE_MISMATCH', `「${row.label}」中「${source.title}」的摘录不在冻结来源内。请核对原文；自己的概括请放入个人判断。`, `Evidence for “${source.title}” under “${row.label}” is not in its frozen excerpt. Check the source, or put your summary in the judgment field.`);
        if (isResearch(data) && (!RELATIONS.includes(cell.relation || 'unclassified') || typeof (cell.reviewedStamp || '') !== 'string' || text(cell.reviewedStamp).length > 180)) throw fault('REVIEW_FORMAT', '证据关系或确认记录格式无效。', 'Invalid evidence relationship or review record.');
      }
    }
    if (isResearch(data)) {
      for (const field of ['question', 'scope', 'openQuestions']) if (typeof data[field] !== 'string' || data[field].length > LIMITS[field]) throw fault('RESEARCH_FIELD', '研究问题、范围或待确认事项超过允许长度。', 'The research question, scope or open questions exceed their limits.');
      if (!['draft', 'insufficient', 'ready'].includes(data.researchStatus)) throw fault('RESEARCH_STATUS', '研究状态无效。', 'Invalid research status.');
      if (!Array.isArray(data.claims) || data.claims.length > LIMITS.claims || data.claims.some(claim => !claim || typeof claim.id !== 'string' || !claim.id || claim.id.length > 100 || /[\x00-\x1f`]/.test(claim.id) || typeof claim.text !== 'string' || claim.text.length > LIMITS.claim || !Array.isArray(claim.evidenceIds) || claim.evidenceIds.length > LIMITS.sources * LIMITS.criteria || claim.evidenceIds.some(id => typeof id !== 'string' || !id || id.length > 1400 || /[\x00-\x1f`]/.test(id)) || new Set(claim.evidenceIds).size !== claim.evidenceIds.length) || new Set(data.claims.map(claim => claim.id)).size !== data.claims.length) throw fault('CLAIM_FORMAT', '研究结论或证据引用格式无效。', 'Invalid research claims or evidence references.');
      if (data.sources.some(source => /[\x00-\x1f`]/.test(source.sourceVersion))) throw fault('SOURCE_FORMAT', '来源版本标识格式无效。', 'Invalid source version identifier.');
    }
    return true;
  }
  function canonical(data, incomplete = false) {
    validate(data, incomplete);
    return { version: isResearch(data) ? 2 : 1, ...(isResearch(data) ? { mode: 'research', question: data.question, scope: data.scope, researchStatus: data.researchStatus, claims: data.claims.map(claim => ({ id: claim.id, text: claim.text, evidenceIds: [...claim.evidenceIds] })), openQuestions: data.openQuestions } : {}), language: data.language === 'en' ? 'en' : 'zh', title: data.title, projectId: typeof data.projectId === 'string' ? data.projectId : null, workspace: isResearch(data) ? '科研' : ['日常', '课程', '科研'].includes(data.workspace) ? data.workspace : '日常',
      sources: data.sources.map(source => ({ key: source.key, kind: source.kind, id: source.id, title: short(source.title), projectId: typeof source.projectId === 'string' ? source.projectId : null, workspace: ['日常', '课程', '科研'].includes(source.workspace) ? source.workspace : '日常', sourceVersion: source.sourceVersion, capturedAt: source.capturedAt, excerpt: source.excerpt, excerptOffset: source.excerptOffset || 0, excerptLabel: source.excerptLabel, totalCharacters: source.totalCharacters, truncated: !!source.truncated, metadata: { authors: list(source.metadata?.authors).map(author => short(author, 100)).slice(0, 20), year: short(source.metadata?.year, 20), venue: short(source.metadata?.venue, 160), doi: short(source.metadata?.doi, 200), url: safeURL(source.metadata?.url), pageCount: Math.max(0, Number(source.metadata?.pageCount) || 0) } })),
      criteria: data.criteria.map(row => ({ id: row.id, label: row.label, cells: Object.fromEntries(data.sources.map(source => { const cell = row.cells?.[source.key] || {}; return [source.key, { quote: text(cell.quote), judgment: text(cell.judgment), ...(isResearch(data) ? { relation: cell.relation || 'unclassified', reviewedStamp: text(cell.reviewedStamp) } : {}) }]; })) })), selectedKey: data.selectedKey || '', conclusion: text(data.conclusion) };
  }
  function reviewStamp(data, row, source) {
    const cell = row.cells?.[source.key] || {};
    return 'review-v1:' + hash(JSON.stringify([data.question, data.scope, row.id, row.label, source.key, source.sourceVersion, source.excerptLabel, source.excerptOffset || 0, source.excerpt, source.capturedAt, cell.quote, cell.judgment, cell.relation]));
  }
  function evidenceLocation(state, source, quote) {
    const position = quote ? source.excerpt.indexOf(quote) : -1;
    if (position < 0 || source.excerpt.indexOf(quote, position + 1) >= 0) return { offset: null, page: null };
    const offset = (source.excerptOffset || 0) + position;
    let page = null;
    // Only the extracted-pages body has an explicit, verifiable page mapping.
    if (source.kind === 'import' && source.excerptLabel === 'extracted-pages' && state) {
      const record = sourceRecord(state, source); let start = 0;
      for (const [index, entry] of list(record.pages).entries()) {
        const body = text(entry?.text || entry?.content); if (!body) continue;
        const number = entry.page || entry.pageNumber || index + 1, prefix = `[${number}]\n`, end = start + prefix.length + body.length;
        if (offset >= start + prefix.length && offset + quote.length <= end && Number.isSafeInteger(Number(number)) && Number(number) > 0) { page = Number(number); break; }
        start = end + 2;
      }
    }
    return { offset, page };
  }
  function researchView(state, data) {
    if (!isResearch(data)) return null;
    const statuses = new Map(data.sources.map(source => [source.key, state ? sourceStatus(state, source) : { available: true, stale: false }]));
    const evidence = data.criteria.flatMap(row => data.sources.map(source => {
      const access = statuses.get(source.key), cell = row.cells?.[source.key] || {}, quote = text(cell.quote).trim(), index = source.excerpt.indexOf(quote), exact = !!quote && index >= 0, ambiguous = exact && source.excerpt.indexOf(quote, index + 1) >= 0;
      const relation = RELATIONS.includes(cell.relation) ? cell.relation : 'unclassified';
      const valid = access.available && !access.stale && exact && !ambiguous;
      const canReview = valid && !!text(data.question).trim() && relation !== 'unclassified';
      const confirmed = canReview && !!cell.reviewedStamp && cell.reviewedStamp === reviewStamp(data, row, source);
      const status = !access.available ? 'unavailable' : access.stale ? 'stale' : !quote ? 'empty' : !exact || ambiguous ? 'unmatched' : relation === 'unclassified' ? 'unclassified' : confirmed ? 'confirmed' : 'unreviewed';
      const location = valid ? evidenceLocation(state, source, quote) : { offset: null, page: null };
      const labels = { unavailable: t('来源不可用', 'Source unavailable'), stale: t('来源已变化，需核对', 'Source changed; review required'), empty: t('尚无证据摘录', 'No evidence quote'), unmatched: ambiguous ? t('摘录重复出现，需更多上下文', 'Repeated quote; include more context') : t('摘录与冻结来源不匹配', 'Quote does not match the frozen source'), unclassified: t('尚未说明与研究问题的关系', 'Relationship to the question is unclassified'), unreviewed: t('待你核对', 'Awaiting your review'), confirmed: t('你已核对当前版本', 'You reviewed this version') };
      return { id: evidenceId(row.id, source.key), rowId: row.id, sourceKey: source.key, label: row.label, sourceTitle: access.available ? source.title : t('来源不可用', 'Source unavailable'), kind: source.kind, sourceId: source.id, quote: access.available ? quote : '', judgment: access.available ? text(cell.judgment) : '', relation, available: access.available, stale: access.stale, exact, ambiguous, valid, confirmed, reviewed: confirmed, canReview, canOpen: valid, status, reviewLabel: labels[status], ...location, sourceVersion: source.sourceVersion };
    }));
    evidence.forEach((item, index) => { item.referenceLabel = `E${index + 1}`; });
    const byId = new Map(evidence.map(item => [item.id, item])), readinessReasons = [];
    if (!text(data.question).trim()) readinessReasons.push(t('先填写研究问题。', 'Enter a research question.'));
    if (!data.claims.length) readinessReasons.push(t('至少记录一条结论并关联证据。', 'Add at least one claim with evidence.'));
    const claims = data.claims.map((claim, index) => {
      const issues = [];
      if (!text(claim.text).trim()) issues.push(t('结论内容为空。', 'The claim is empty.'));
      if (!claim.evidenceIds.length) issues.push(t('尚未关联证据。', 'No evidence is linked.'));
      for (const id of claim.evidenceIds) { const item = byId.get(id); if (!item) issues.push(t('关联的证据已移除。', 'Linked evidence was removed.')); else if (!item.confirmed) issues.push(t('关联证据尚未核对当前版本。', 'Linked evidence has not been reviewed for the current version.')); }
      if (issues.length) readinessReasons.push(t(`结论 ${index + 1}：${[...new Set(issues)].join(' ')}`, `Claim ${index + 1}: ${[...new Set(issues)].join(' ')}`));
      return { id: claim.id, text: claim.text, evidenceIds: [...claim.evidenceIds], valid: !issues.length, issues: [...new Set(issues)] };
    });
    const blocked = [...statuses.values()].some(status => !status.available);
    if (blocked) readinessReasons.push(t('部分来源不可用；恢复访问后才能保存研究成果。', 'Some sources are unavailable. Restore access before saving.'));
    const ready = !readinessReasons.length;
    return { ready, effectiveStatus: data.researchStatus === 'ready' && !ready ? 'draft' : data.researchStatus, needsReview: data.researchStatus === 'ready' && !ready, readinessReasons, problems: readinessReasons, evidence, claims, blocked, counts: { total: evidence.length, quoted: evidence.filter(item => item.quote).length, confirmed: evidence.filter(item => item.confirmed).length, stale: evidence.filter(item => item.stale).length, unmatched: evidence.filter(item => item.status === 'unmatched').length } };
  }
  function reviewEvidence(state, data, rowId, key) {
    validate(data); if (!isResearch(data)) throw fault('RESEARCH_MODE', '只有研究证据可以确认版本。', 'Version review is available for research evidence.');
    const evidence = researchView(state, data).evidence.find(item => item.id === evidenceId(rowId, key));
    if (!evidence?.canReview) throw fault('EVIDENCE_REVIEW', '请先填写研究问题，选择关系，并核对可用来源中唯一、精确的原文摘录。', 'Enter the question and relationship, then use a unique exact quote from the current available source.');
    const next = copy(data), row = next.criteria.find(row => row.id === rowId), source = next.sources.find(source => source.key === key);
    row.cells[key].reviewedStamp = reviewStamp(next, row, source); return next;
  }
  const escapeMd = value => String(value || '').replace(/[\\`*_[\]<>#!|()]/g, '\\$&');
  function markdown(data) {
    validate(data); if (isResearch(data)) return researchMarkdown(data); const en = data.language === 'en', phrase = (zh, english) => en ? english : zh;
    const chosen = data.sources.find(source => source.key === data.selectedKey);
    const lines = [`# ${escapeMd(data.title)}`, '', phrase('> 来源事实来自下方冻结摘录；比较中的判断与结论由用户填写，不是自动核验结果。', '> Source facts come from the frozen excerpts below. Judgments and conclusions were written by the user and are not automated verification.'), '', `## ${phrase('选择与结论', 'Decision')}`, '', `${phrase('倾向选择', 'Preferred option')}: ${chosen ? escapeMd(chosen.title) : phrase('尚未选择', 'Not selected')}`, '', escapeMd(data.conclusion) || phrase('尚未填写结论。', 'No conclusion yet.'), '', `## ${phrase('比较维度', 'Criteria')}`];
    for (const row of data.criteria) {
      lines.push('', `### ${escapeMd(row.label)}`);
      for (const source of data.sources) { const cell = row.cells?.[source.key] || {}; lines.push('', `#### ${escapeMd(source.title)}`, '', `**${phrase('来源摘录', 'Source evidence')}**`, '', cell.quote?.trim() ? cell.quote.trim().split('\n').map(line => `> ${escapeMd(line)}`).join('\n') : phrase('未填写来源证据。', 'No source evidence entered.'), '', `**${phrase('个人判断', 'Your judgment')}**`, '', escapeMd(cell.judgment) || phrase('尚未填写。', 'Not entered.')); }
    }
    lines.push('', `## ${phrase('来源快照', 'Frozen sources')}`);
    for (const source of data.sources) {
      lines.push('', `### ${escapeMd(source.title)}`, '', `${phrase('来源 ID', 'Source ID')}: \`${source.key.replace(/`/g, '')}\``, `${phrase('摘录时间', 'Captured')}: ${new Date(source.capturedAt).toISOString()}`, `${phrase('版本标识', 'Version')}: \`${source.sourceVersion.replace(/`/g, '')}\``, `${phrase('范围', 'Scope')}: ${source.excerptOffset || 0}–${(source.excerptOffset || 0) + source.excerpt.length} / ${source.totalCharacters} ${phrase('字符（从 0 起算）', 'characters (zero-based)')}${source.truncated ? phrase('（部分摘录）', ' (partial excerpt)') : ''}`, source.kind === 'paper' ? phrase('这是已保存论文记录的摘录，可能包含既有分析，不代表论文原文。', 'This excerpt is from the saved paper record, which may contain earlier analysis. It is not necessarily the original paper text.') : '', safeURL(source.metadata?.url) ? `${phrase('原始链接', 'Original URL')}: ${escapeMd(safeURL(source.metadata.url))}` : '', '', source.excerpt ? source.excerpt.split('\n').map(line => `> ${escapeMd(line)}`).join('\n') : phrase('来源没有可用文本；没有推断文件内容。', 'No source text is available. File contents were not inferred.'));
    }
    return lines.join('\n').trim() + '\n';
  }
  function researchMarkdown(data) {
    const en = data.language === 'en', phrase = (zh, english) => en ? english : zh, view = researchView(null, data);
    const status = { draft: phrase('草稿', 'Draft'), insufficient: phrase('证据不足', 'Insufficient evidence'), ready: phrase('已整理', 'Ready') }[data.researchStatus];
    const relation = { unclassified: phrase('未分类', 'Unclassified'), supports: phrase('支持研究问题', 'Supports the question'), contradicts: phrase('反对研究问题', 'Contradicts the question'), related: phrase('与研究问题相关', 'Related to the question') };
    const lines = [`# ${escapeMd(data.title)}`, '', phrase('> 研究问题、关系判断和结论由用户填写。核对标记只表示用户检查过冻结摘录，不代表 AI 验证了事实；来源当前状态请在工作台重新检查。', '> The question, relationships and claims were written by the user. Review marks record a human check of frozen excerpts, not AI fact verification. Recheck current source status in the workspace.'), '', `## ${phrase('研究问题与范围', 'Question and scope')}`, '', `${phrase('保存时的研究状态', 'Research status when saved')}: ${status}`, '', escapeMd(data.question) || phrase('尚未填写研究问题。', 'No research question yet.'), '', `**${phrase('适用范围与边界', 'Scope and boundaries')}**`, '', escapeMd(data.scope) || phrase('尚未声明适用范围。', 'No scope declared.'), '', `## ${phrase('证据与用户判断', 'Evidence and user judgments')}`];
    const referenceLabels = new Map(view.evidence.map((item, index) => [item.id, `E${index + 1}`]));
    for (const item of view.evidence) {
      lines.push('', `### ${referenceLabels.get(item.id)} · ${escapeMd(item.sourceTitle)}`, '', `**${escapeMd(item.label)}**`, `${phrase('与研究问题的关系', 'Relationship to the question')}: ${relation[item.relation]}`, `${phrase('用户核对', 'Human review')}: ${item.confirmed ? phrase('用户曾核对该冻结版本', 'The user reviewed this frozen version') : phrase('未确认或核对条件已变化', 'Unconfirmed or review conditions changed')}`, `${phrase('摘录定位', 'Quote location')}: ${item.offset === null ? phrase('无法唯一定位，需核对原文', 'Not uniquely located; check the original') : `${item.offset}–${item.offset + item.quote.length} ${phrase('字符（从 0 起算）', 'characters (zero-based)')}`}`, '', item.quote ? item.quote.split('\n').map(line => `> ${escapeMd(line)}`).join('\n') : phrase('尚无原文证据。', 'No source evidence yet.'), '', `**${phrase('个人判断', 'Your judgment')}**`, '', escapeMd(item.judgment) || phrase('尚未填写。', 'Not entered.'));
    }
    lines.push('', `## ${phrase('结论及其证据引用', 'Claims and their evidence references')}`);
    if (!data.claims.length) lines.push('', phrase('尚未形成结论。', 'No claims yet.'));
    for (const [index, claim] of data.claims.entries()) lines.push('', `### ${phrase('结论', 'Claim')} ${index + 1}`, '', escapeMd(claim.text) || phrase('结论尚未填写。', 'Claim text is empty.'), '', `${phrase('关联依据', 'Evidence references')}: ${claim.evidenceIds.length ? claim.evidenceIds.map(id => { const item = view.evidence.find(item => item.id === id); return item ? `${referenceLabels.get(id)} · ${escapeMd(item.sourceTitle)}` : phrase('已移除的证据（需重新关联）', 'Removed evidence (relink required)'); }).join('；') : phrase('无', 'None')}`);
    lines.push('', `## ${phrase('待确认事项', 'Open questions')}`, '', escapeMd(data.openQuestions) || phrase('尚未记录。', 'Not recorded.'), '', `## ${phrase('补充说明', 'Additional notes')}`, '', escapeMd(data.conclusion) || phrase('尚无补充。', 'No additional notes.'), '', `## ${phrase('冻结来源与范围', 'Frozen sources and ranges')}`);
    for (const source of data.sources) lines.push('', `### ${escapeMd(source.title)}`, '', `${phrase('来源 ID', 'Source ID')}: \`${source.key}\``, `${phrase('版本标识', 'Version')}: \`${source.sourceVersion}\``, `${phrase('摘录时间', 'Captured')}: ${new Date(source.capturedAt).toISOString()}`, `${phrase('范围', 'Range')}: ${source.excerptOffset || 0}–${(source.excerptOffset || 0) + source.excerpt.length} / ${source.totalCharacters} ${phrase('字符（从 0 起算）', 'characters (zero-based)')}`, source.kind === 'paper' ? phrase('这是已保存论文记录，可能包含既有分析，不代表论文原文。', 'This saved paper record may contain prior analysis and is not necessarily original paper text.') : '', '', source.excerpt ? source.excerpt.split('\n').map(line => `> ${escapeMd(line)}`).join('\n') : phrase('来源没有可用文本。', 'No source text available.'));
    return lines.join('\n').trim() + '\n';
  }
  function evidenceTarget(state, data, key, id) {
    const source = data.sources.find(source => source.key === key); if (!source) return null;
    const status = sourceStatus(state, source); if (!status.available || status.stale) return null;
    const target = { kind: source.kind, id: source.id };
    if (id) {
      const item = researchView(state, data)?.evidence.find(item => item.id === id && item.sourceKey === key);
      if (!item?.canOpen) return null;
      target.comparisonEvidence = { quote: item.quote, offset: item.offset, sourceVersion: item.sourceVersion, ...(item.page ? { page: item.page } : {}) };
    }
    return target;
  }
  const noteVersion = note => hash(stableJSON([note.title, note.content, note.sourceComparison, note.updatedAt, note.projectId, note.workspace, note.sourceNoteIds, note.sourceAttachmentIds, note.revisionHistory]));
  function reopen(state, noteId) {
    const note = sourceRecord(state, { kind: 'note', id: noteId });
    if (note.sourceComparison?.version !== 1 && !isResearch(note.sourceComparison)) throw fault('NO_COMPARISON', '这篇笔记没有可编辑的比较结构。', 'This note has no editable comparison structure.');
    const data = canonical(note.sourceComparison);
    return { data, noteId, base: noteVersion(note), externalChanged: markdown(data) !== note.content };
  }
  function refreshSource(state, data, key) {
    const source = data.sources.find(source => source.key === key); if (!source) throw fault('SOURCE_GONE', '比较来源已不存在。', 'The comparison source is unavailable.');
    const next = copy(data), updated = snapshot(state, source), body = fingerprint(sourceRecord(state, source), source.kind).body;
    const found = source.excerpt ? body.indexOf(source.excerpt) : -1;
    const offset = found >= 0 && body.indexOf(source.excerpt, found + 1) === -1 ? found : Math.min(source.excerptOffset || 0, Math.max(0, body.length - 1));
    updated.excerptOffset = offset; updated.excerpt = body.slice(offset, offset + (source.excerpt.length || LIMITS.excerpt)); updated.truncated = updated.excerpt.length < body.length;
    next.sources = next.sources.map(item => item.key === key ? updated : item);
    if (isResearch(next)) { for (const row of next.criteria) if (row.cells?.[key]) row.cells[key].reviewedStamp = ''; if (next.researchStatus === 'ready') next.researchStatus = 'draft'; }
    return next;
  }
  function selectExcerpt(state, data, key, value) {
    const source = data.sources.find(source => source.key === key); if (!source) throw fault('SOURCE_GONE', '比较来源已不存在。', 'The comparison source is unavailable.');
    if (typeof value !== 'string' || !value.trim() || value.length > LIMITS.excerpt) throw fault('EXCERPT_LENGTH', '粘贴 1–6000 字符的连续原文。', 'Paste a continuous excerpt of 1–6,000 characters.');
    const record = sourceRecord(state, source), view = fingerprint(record, source.kind);
    if (view.version !== source.sourceVersion) throw fault('SOURCE_CHANGED', '来源已修改，请先刷新，再选择摘录。', 'The source changed. Refresh it before choosing an excerpt.');
    const offset = view.body.indexOf(value);
    if (offset < 0) throw fault('EXCERPT_MISMATCH', '这段内容不在当前来源原文中。请原样复制，个人概括写在判断栏。', 'This text is not in the current source. Copy it exactly; summaries belong in the judgment field.');
    if (view.body.indexOf(value, offset + 1) >= 0) throw fault('EXCERPT_AMBIGUOUS', '相同片段出现多次，请多复制一些上下文以准确定位。', 'This text appears more than once. Include more context to locate it precisely.');
    const next = copy(data); next.sources = next.sources.map(item => item.key === key ? { ...item, excerpt: value, excerptOffset: offset, capturedAt: Date.now(), truncated: value.length < view.body.length } : item);
    if (isResearch(next)) { for (const row of next.criteria) if (row.cells?.[key]) row.cells[key].reviewedStamp = ''; if (next.researchStatus === 'ready') next.researchStatus = 'draft'; }
    return next;
  }
  function createController(host) {
    let busy = false;
    async function save(session, options = {}) {
      if (busy) throw fault('BUSY', '正在保存比较，请稍候。', 'The comparison is being saved.');
      const state = host.getState(), data = canonical(session.data);
      for (const source of data.sources) { const status = sourceStatus(state, source); if (!status.available || !isResearch(data) && status.stale) throw fault('SOURCE_CHANGED', status.available ? `${source.title}：${status.message}` : status.message, status.available ? `${source.title}: ${status.message}` : status.message); }
      if (isResearch(data) && data.researchStatus === 'ready' && !researchView(state, data).ready) throw fault('RESEARCH_NOT_READY', '结论仍有缺少、失效或未核对的证据；请先补充核对，或保存为草稿 / 证据不足。', 'Claims have missing, outdated or unreviewed evidence. Review them first, or save as draft / insufficient evidence.');
      const project = data.projectId && unique(state.projects, data.projectId);
      if (data.projectId && (!active(project) || privateItem(project))) throw fault('PROJECT_GONE', '保存项目已不可用，请重新选择。', 'Choose an available project for saving.');
      if (isResearch(data) && project && project.workspace !== '科研') throw fault('RESEARCH_PROJECT', '研究成果只能保存到科研空间的项目。', 'Research outputs can only be saved to a research project.');
      const asNew = options.asNew || !session.noteId;
      let note = asNew ? null : sourceRecord(state, { kind: 'note', id: session.noteId });
      if (note && (noteVersion(note) !== session.base || session.externalChanged)) throw fault('COMPARISON_CONFLICT', '这篇笔记已在别处编辑，未覆盖原内容。请另存为新笔记。', 'This note was edited elsewhere. Its content was not overwritten. Save as a new note.');
      if (typeof host.save !== 'function') throw fault('SAVE_UNAVAILABLE', '比较保存接口尚未连接。', 'Comparison saving is not connected.');
      const now = Date.now(), before = note && copy(note), id = note?.id || host.uid?.('note') || `comparison_${now}_${Math.random().toString(36).slice(2, 8)}`;
      const content = markdown(data), sourceNoteIds = data.sources.filter(source => source.kind === 'note').map(source => source.id), sourceAttachmentIds = [...new Set(data.sources.flatMap(source => source.kind === 'import' ? [source.id] : source.kind === 'paper' ? list(sourceRecord(state, source).sourceAttachmentIds).filter(id => { try { sourceRecord(state, { kind: 'import', id }); return true; } catch (_) { return false; } }) : []))];
      const fields = { title: data.title.trim(), content, sourceComparison: data, sourceNoteIds, sourceAttachmentIds, projectId: data.projectId || null, workspace: isResearch(data) ? '科研' : project?.workspace || data.workspace || '日常', updatedAt: now, userEdited: true, userEditedAt: now };
      if (note) fields.revisionHistory = [...list(note.revisionHistory).slice(-19), { title: note.title, content: note.content, updatedAt: note.updatedAt || note.createdAt, savedAt: now, userEdited: note.userEdited === true, ...(note.sourceComparison ? { sourceComparison: copy(note.sourceComparison) } : {}), ...(note.provenance ? { provenance: copy(note.provenance) } : {}), sourceNoteIds: copy(note.sourceNoteIds || []), sourceAttachmentIds: copy(note.sourceAttachmentIds || []) }];
      else { note = { id, createdAt: now, kind: isResearch(data) ? '科研 Wiki/output' : '来源比较', tags: [] }; state.notes ||= []; state.notes.push(note); }
      Object.assign(note, fields); const after = copy(fields), savedVersion = noteVersion(note); busy = true; host.onChanged?.();
      try { if (await host.save() === false) throw fault('SAVE_FAILED', '比较未保存，请重试。', 'The comparison was not saved. Please retry.'); const latest = unique(host.getState().notes, id); return { noteId: id, data: copy(data), base: savedVersion, externalChanged: state !== host.getState() || latest !== note || !latest || noteVersion(latest) !== savedVersion }; }
      catch (error) {
        const current = list(host.getState().notes).find(item => item.id === id);
        if (asNew) { if (current === note && Object.entries(after).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value))) host.getState().notes = host.getState().notes.filter(item => item !== note); }
        else if (current === note) for (const [key, value] of Object.entries(after)) if (JSON.stringify(current[key]) === JSON.stringify(value)) { if (Object.hasOwn(before, key)) current[key] = copy(before[key]); else delete current[key]; }
        throw error;
      } finally { busy = false; host.onChanged?.(); }
    }
    return { save, isBusy: () => busy };
  }

  let hooks = {}, controller, dialog, hostElement, session = null, mode = 'picker', pickerOptions = {}, pickerQuery = '', pickerPage = 0, selected = new Map(), opener, composing = false, navigating = false, skipClose = 0, error = '', notice = '', changed = false;
  let draftStore = null, draftLoaded = false, draftLoading = null, draftAction = false, draftPersistence = null;
  const privateMode = () => !!(hooks.isPrivate?.() || root.PrivateMode?.isOn?.());
  function draftSession(owner) {
    return { data: canonical(owner.data, true), noteId: owner.noteId || null, base: owner.base || null, externalChanged: !!owner.externalChanged };
  }
  function rememberDraft() {
    if (!draftStore || !session || !changed || privateMode()) return;
    try { draftStore.schedule(draftSession(session)); }
    catch (failure) { draftPersistence = { state: 'error', message: failure.message }; }
  }
  function restoreDraft(result) {
    if (!result?.session) return false;
    const restored = draftSession(result.session), state = hooks.getState();
    if (restored.noteId) {
      try { const note = sourceRecord(state, { kind: 'note', id: restored.noteId }); restored.externalChanged ||= noteVersion(note) !== restored.base || reopen(state, restored.noteId).externalChanged; }
      catch (_) { restored.externalChanged = true; }
    }
    session = restored; changed = true; mode = 'editor';
    draftPersistence = { ...draftStore.getStatus(), recovered: true };
    return true;
  }
  async function loadDraft() {
    if (!draftStore || draftLoaded) return false;
    if (draftLoading) return draftLoading;
    draftLoading = (async () => {
      try { const result = await draftStore.load(); if (privateMode()) return false; draftLoaded = true; return restoreDraft(result); }
      catch (failure) { draftLoaded = true; hooks.toast?.(t('本机草稿未能载入。当前编辑只保留在窗口内，请重试草稿保存。', 'The local draft could not be loaded. Current edits remain in this window; retry draft storage.')); return false; }
      finally { draftLoading = null; }
    })();
    return draftLoading;
  }
  async function discardDraft() {
    if (controller.isBusy() || navigating || draftAction || privateMode()) return false;
    draftAction = true; refresh();
    try {
      if (draftStore) {
        if (['conflict', 'unavailable'].includes(draftStore.getStatus().state) && !draftStore.getStatus().blocked) {
          const result = await draftStore.reload();
          session = null; changed = false; mode = 'picker';
          if (restoreDraft(result)) { notice = t('已载入本机现存草稿。', 'Loaded the current local draft.'); return true; }
        } else if (!await draftStore.clear()) { rememberDraft(); return false; }
      }
      if (session) pickerOptions = { mode: isResearch(session.data) ? 'research' : 'comparison', projectId: session.data.projectId };
      session = null; changed = false; mode = 'picker'; selected.clear(); error = ''; notice = ''; return true;
    } catch (failure) { error = failure.message; return false; }
    finally { draftAction = false; refresh(); }
  }
  async function retryDraft() {
    if (!draftStore || draftAction || controller.isBusy() || privateMode()) return false;
    draftAction = true; refresh();
    try {
      if (!session && !draftStore.hasPending()) {
        const result = await draftStore.reload(); restoreDraft(result); return !result.blocked;
      }
      return await draftStore.flush({ retry: true });
    } catch (failure) { error = failure.message; return false; }
    finally { draftAction = false; refresh(); }
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = root.document.createElement('dialog'); dialog.id = 'sourceComparisonDialog'; dialog.className = 'source-comparison-dialog'; dialog.setAttribute('aria-labelledby', 'sourceComparisonTitle'); hostElement = root.document.createElement('div'); dialog.append(hostElement); root.document.body.append(dialog);
    dialog.addEventListener('compositionstart', () => { composing = true; }); dialog.addEventListener('compositionend', () => { composing = false; });
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!composing) close(); });
    dialog.addEventListener('keydown', event => { if (event.isComposing || composing || event.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && mode === 'editor') { event.preventDefault(); void save(); } });
    dialog.addEventListener('close', () => { if (skipClose) { skipClose--; return; } root.HalaskaUI?.unmount(hostElement); if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true }); opener = null; hooks.onChanged?.(); });
  }
  function refresh() {
    if (!dialog?.open) return;
    if (privateMode()) { dialog.close(); return; }
    const state = hooks.getState(), busy = controller.isBusy() || navigating || draftAction;
    if (mode === 'picker') {
      const items = candidates(state, pickerQuery), pages = Math.max(1, Math.ceil(items.length / 20)); pickerPage = Math.min(pickerPage, pages - 1);
      const saved = list(state.notes).filter(note => note.sourceComparison?.version === 1 || isResearch(note.sourceComparison)).filter(note => { try { sourceRecord(state, { kind: 'note', id: note.id }); return true; } catch (_) { return false; } }).filter(note => !pickerQuery || note.title?.toLocaleLowerCase().includes(pickerQuery.toLocaleLowerCase())).slice(0, 8).map(note => ({ id: note.id, title: note.title, mode: isResearch(note.sourceComparison) ? 'research' : 'comparison' }));
      root.HalaskaUI.mount(hostElement, 'ComparisonPicker', { items: items.slice(pickerPage * 20, (pickerPage + 1) * 20), count: items.length, selected: [...selected.keys()], query: pickerQuery, page: pickerPage, pages, saved, mode: pickerOptions.mode || 'comparison', error, draftPersistence, onRetryDraft: retryDraft, onDiscard: discardDraft, onQuery: value => { pickerQuery = value; pickerPage = 0; refresh(); }, onPage: page => { pickerPage = page; refresh(); }, onSelect: ref => { if (selected.has(ref.key)) selected.delete(ref.key); else if (selected.size < 4) selected.set(ref.key, ref); refresh(); }, onStart: requested => { if (controller.isBusy() || navigating || draftAction || privateMode() || draftPersistence?.blocked || mode !== 'picker') return; try { const requestedMode = typeof requested === 'string' ? requested : requested?.mode; session = { data: begin(hooks.getState(), [...selected.values()], { ...pickerOptions, ...(requestedMode ? { mode: requestedMode } : {}) }), noteId: null, base: null }; changed = true; mode = 'editor'; error = ''; rememberDraft(); refresh(); } catch (failure) { error = failure.message; refresh(); } }, onReopen: id => openSaved(id), onClose: close }); return;
    }
    const owner = session, data = owner.data, statuses = Object.fromEntries(data.sources.map(source => [source.key, sourceStatus(state, source)]));
    const editable = () => session === owner && session.data === data && dialog.open && !controller.isBusy() && !navigating && !draftAction && !privateMode();
    const markChanged = (invalidate = true) => { changed = true; notice = ''; error = ''; if (invalidate && isResearch(data) && data.researchStatus === 'ready') { data.researchStatus = 'draft'; notice = t('内容已修改，已回到草稿；核对相关证据后可重新标记已整理。', 'Content changed and returned to draft. Review the evidence before marking it ready again.'); } rememberDraft(); refresh(); };
    root.HalaskaUI.mount(hostElement, 'SourceComparisonSurface', { data, statuses, research: researchView(state, data), busy, changed, noteId: owner.noteId, externalChanged: owner.externalChanged, error, notice, draftPersistence, onRetryDraft: retryDraft, projects: list(state.projects).filter(project => active(project) && !privateItem(project) && (!isResearch(data) || project.workspace === '科研')).map(project => ({ id: project.id, name: project.name, workspace: project.workspace })),
      onChange: (field, value) => { if (!editable() || !['title', 'projectId', 'selectedKey', 'conclusion', 'question', 'scope', 'researchStatus', 'openQuestions'].includes(field)) return; data[field] = value; markChanged(field !== 'researchStatus'); },
      onCriterion: (id, value) => { if (!editable()) return; const row = data.criteria.find(row => row.id === id); if (!row) return; row.label = value; markChanged(); },
      onCell: (id, key, field, value) => { if (!editable() || !['quote', 'judgment', 'relation'].includes(field) || !data.sources.some(source => source.key === key)) return; const row = data.criteria.find(row => row.id === id); if (!row) return; row.cells[key] ||= emptyCell(isResearch(data)); row.cells[key][field] = value; markChanged(); },
      onReview: (id, key) => { if (!editable()) return false; try { session.data = reviewEvidence(hooks.getState(), data, id, key); changed = true; error = ''; notice = t('已记录你对这段证据当前版本的核对。', 'Your review of this evidence version is recorded.'); rememberDraft(); refresh(); return true; } catch (failure) { error = failure.message; refresh(); return false; } },
      onClaim: (id, field, value) => { if (!editable() || !isResearch(data) || !['text', 'evidenceIds'].includes(field)) return; const claim = data.claims.find(claim => claim.id === id); if (!claim) return; claim[field] = field === 'evidenceIds' ? [...new Set(list(value))] : value; markChanged(); },
      onAddClaim: () => { if (!editable() || !isResearch(data) || data.claims.length >= LIMITS.claims) return; data.claims.push({ id: `claim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: '', evidenceIds: [] }); markChanged(); },
      onRemoveClaim: id => { if (!editable() || !isResearch(data)) return; data.claims = data.claims.filter(claim => claim.id !== id); markChanged(); },
      onAddCriterion: () => { if (!editable() || data.criteria.length >= LIMITS.criteria) return; data.criteria.push({ id: `criterion-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label: t('新维度', 'New criterion'), cells: Object.fromEntries(data.sources.map(source => [source.key, emptyCell(isResearch(data))])) }); markChanged(); },
      onRemoveCriterion: id => { if (!editable() || data.criteria.length <= 1) return; data.criteria = data.criteria.filter(row => row.id !== id); markChanged(); },
      onRefresh: key => { if (!editable()) return; try { session.data = refreshSource(hooks.getState(), data, key); changed = true; error = ''; notice = t('摘录已刷新；你的证据和判断已保留，请核对是否仍然适用。', 'Excerpt refreshed. Your evidence and judgments remain; review whether they still apply.'); rememberDraft(); } catch (failure) { error = failure.message; } refresh(); },
      onSelectExcerpt: (key, value) => { if (!editable()) return false; try { session.data = selectExcerpt(hooks.getState(), data, key, value); changed = true; error = ''; notice = t('已切换到这段原文；你的证据与判断保留，请核对是否仍然适用。', 'The excerpt was changed. Your evidence and judgments are retained; review whether they still apply.'); rememberDraft(); refresh(); return true; } catch (failure) { error = failure.message; refresh(); return false; } },
      onSource: (key, id) => editable() && navigate(key, id), onSave: () => editable() && save(false), onSaveAs: () => editable() && save(true), onOpenNote: () => editable() && !changed && navigate(null), onNew: () => { if (!editable()) return; if (draftStore && ['conflict', 'error', 'unavailable'].includes(draftStore.getStatus().state)) { error = t('先处理本机草稿的保存问题，再新建。', 'Resolve the local draft storage issue before starting another.'); refresh(); return; } if (changed) { error = t('先保存当前比较，或使用“放弃草稿”后再新建。', 'Save this comparison, or discard its draft before starting another.'); refresh(); return; } pickerOptions = { mode: isResearch(data) ? 'research' : 'comparison', projectId: data.projectId }; session = null; mode = 'picker'; selected.clear(); error = ''; notice = ''; refresh(); },
      onDiscard: () => editable() && discardDraft(), onClose: close });
  }
  async function save(asNew = false) {
    if (!session || controller.isBusy() || navigating || draftAction || composing) return false;
    const owner = session; error = ''; notice = '';
    try { const pending = controller.save(owner, { asNew }); refresh(); const saved = await pending; if (session !== owner) return false; session = saved; changed = false; notice = isResearch(saved.data) ? t('已保存为科研 Wiki 成果；问题、原文证据与结论引用一起保留。', 'Saved as a research Wiki output with the question, source evidence and claim references.') : t('已保存为可编辑笔记。来源快照与个人判断一起保留。', 'Saved as an editable note with source snapshots and your judgments.'); hooks.onSaved?.(saved.noteId); if (draftStore && !await draftStore.clear()) notice += t(' 本机旧草稿尚未清理，请处理下方草稿提示。', ' The old local draft still needs cleanup; see its status below.'); return true; }
    catch (failure) { if (session === owner) error = failure.message; return false; }
    finally { refresh(); }
  }
  async function navigate(key, id) {
    if (!session || controller.isBusy() || navigating || draftAction || privateMode()) return false;
    const owner = session, data = owner.data;
    const resolve = () => { if (session !== owner || session.data !== data || privateMode()) return null; try { if (key) return evidenceTarget(hooks.getState(), data, key, id); if (owner.noteId) { sourceRecord(hooks.getState(), { kind: 'note', id: owner.noteId }); return { kind: 'note', id: owner.noteId }; } } catch (_) {} return null; };
    const target = resolve();
    if (!target) { error = t('来源或证据定位已变化，请先核对当前版本。', 'The source or evidence location changed. Review the current version first.'); refresh(); return false; }
    const identity = stableJSON(target), canOpen = () => { const current = resolve(); return !!current && stableJSON(current) === identity; };
    navigating = true; refresh();
    if (draftStore && changed && !await draftStore.flush()) { navigating = false; error = t('请先重试保存本机草稿，或保存为笔记，再打开来源。', 'Retry local draft storage or save as a note before opening the source.'); refresh(); return false; }
    if (!canOpen()) { navigating = false; refresh(); return false; }
    skipClose++; dialog.close(); hooks.onChanged?.();
    try { if (!canOpen() || typeof hooks.openTarget !== 'function' || await hooks.openTarget(target, canOpen) === false || !canOpen()) throw fault('NAV_CANCELLED', '没有离开当前编辑；比较草稿仍保留。', 'The current edit remains open. Your comparison draft is retained.'); root.HalaskaUI.unmount(hostElement); opener = null; return true; }
    catch (failure) { if (session === owner) { error = failure.message; if (!privateMode()) dialog.showModal(); } return false; }
    finally { navigating = false; refresh(); hooks.onChanged?.(); }
  }
  function open(refs, options = {}) {
    if (draftStore && !draftLoaded) return loadDraft().then(restored => openCurrent(restored ? undefined : refs, restored ? {} : options));
    return openCurrent(refs, options);
  }
  function openCurrent(refs, options = {}) {
    if (privateMode()) { hooks.toast?.(t('请先退出无痕模式，再创建来源比较。', 'Leave private mode before creating a source comparison.')); return false; }
    if (!controller) return false;
    if (session && changed && options.mode && (isResearch(session.data) ? 'research' : 'comparison') !== options.mode) { hooks.toast?.(t('当前窗口保留了另一种比较草稿。请先保存或放弃草稿。', 'A different comparison draft is retained. Save or discard it first.')); return false; }
    ensureDialog(); if (navigating || draftAction || controller.isBusy()) return false;
    if (draftPersistence?.blocked && !session) refs = undefined;
    if (session && !changed && options.mode && (isResearch(session.data) ? 'research' : 'comparison') !== options.mode) {
      session = null; mode = 'picker'; selected.clear(); pickerOptions = { ...options };
      if (dialog.open) { refresh(); return true; }
    }
    if (dialog.open) return true;
    if (!session) pickerOptions = { ...pickerOptions, ...options };
    if (refs?.length) {
      if (session && changed && refs.map(keyOf).sort().join('|') !== session.data.sources.map(source => source.key).sort().join('|')) { hooks.toast?.(t('当前窗口保留了比较草稿。请先保存或放弃草稿。', 'A comparison draft is retained. Save or discard it first.')); return false; }
      if (!session || !changed) { try { session = { data: begin(hooks.getState(), refs, options), noteId: null, base: null }; changed = true; rememberDraft(); } catch (failure) { hooks.toast?.(failure.message); return false; } }
    }
    mode = session ? 'editor' : 'picker'; opener = root.document.activeElement; error = ''; notice = ''; dialog.showModal(); refresh(); dialog.querySelector('input,button')?.focus({ preventScroll: true }); hooks.onChanged?.(); return true;
  }
  function openSaved(noteId) {
    if (draftAction) return false;
    if (draftStore && !draftLoaded) return loadDraft().then(restored => restored ? openCurrent() : openSaved(noteId));
    if (draftPersistence?.blocked && !session) return openCurrent();
    if (privateMode() || controller?.isBusy() || navigating) return false;
    if (session && changed && session.noteId !== noteId) { hooks.toast?.(t('请先保存或放弃当前比较草稿。', 'Save or discard the current comparison draft first.')); return false; }
    try { if (!session || session.noteId !== noteId || !changed) session = reopen(hooks.getState(), noteId); mode = 'editor'; if (!dialog?.open) return open(); refresh(); return true; }
    catch (failure) { error = failure.message; hooks.toast?.(error); refresh(); return false; }
  }
  function close() {
    if (!dialog?.open || controller.isBusy() || navigating || draftAction || composing) return false;
    if (draftStore && changed) return (async () => {
      draftAction = true; refresh();
      try { if (!await draftStore.flush()) { hooks.toast?.(t('草稿尚未写入本机。请重试，或先保存为笔记。', 'The draft is not stored locally yet. Retry or save it as a note first.')); return false; } dialog.close(); return true; }
      finally { draftAction = false; refresh(); }
    })();
    dialog.close(); return true;
  }
  function init(host) {
    hooks = host || {}; controller = createController({ ...hooks, onChanged: () => { refresh(); hooks.onChanged?.(); } });
    if (hooks.draftRequest && root.ComparisonDraftStore) {
      draftStore = root.ComparisonDraftStore.create({ request: hooks.draftRequest, onStatus: status => { draftPersistence = { ...status, recovered: draftPersistence?.recovered }; refresh(); } });
    }
    return controller;
  }
  root.addEventListener?.('beforeunload', event => { if (composing || draftStore?.hasPending() || draftAction) { event.preventDefault(); event.returnValue = ''; } });
  root.addEventListener?.('pagehide', () => { void draftStore?.flush(); });
  root.document?.addEventListener('workstation-language-change', refresh);
  return { LIMITS, draftSession, evidenceId, reviewEvidence, researchView, evidenceTarget, snapshot, sourceRecord, sourceStatus, candidates, begin, validate, markdown, refreshSource, selectExcerpt, noteVersion, createController, init, open, reopen: openSaved, reopenSession: reopen, refresh, close, isOpen: () => !!dialog?.open || navigating, isBusy: () => !!controller?.isBusy() || navigating || draftAction || !!draftLoading, hasDraft: () => !!session && changed };
});
