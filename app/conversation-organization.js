/* Read-only local conversation analysis and explicit, immutable organization commands.
   No transcript merge, provider call or project/workspace reassignment happens here. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationOrganization = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const active = item => !!item && !item.deleted && !item.deletedAt && !item.archived && !item.archivedAt && !['deleted', 'archived'].includes(item.status);
  const eligible = item => active(item) && !item.ephemeral && !item.private && !item.incognito;
  const norm = value => String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  const stop = new Set(('the this that these those with from into have has had will would could should shall can and for you your our are was were not but then than also please help make new chat conversation project task update fix code analysis implement work current want need use using about how what when where which why more same just actually think thanks yes continue okay done plan result summary ' +
    '这个 那个 这些 那些 然后 还有 现在 目前 已经 可以 需要 希望 帮我 请你 请把 一下 一些 一个 进行 对于 相关 关于 具体 功能 实现 优化 修改 问题 处理 项目 对话 继续 好的 谢谢 首先 其次 最后 总结 内容 分析 代码 文件 工作 任务 结果 方案 支持 保持 使用 完成 检查 更新').split(/\s+/));
  let segmenter;
  try { segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null; } catch (_) { segmenter = null; }
  function textOf(message) {
    if (typeof message?.text === 'string') return message.text;
    if (typeof message?.content === 'string') return message.content;
    return list(message?.content).filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
  }
  function plain(value) {
    return String(value || '').replace(/<(?:think|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:think|thinking|analysis)>/gi, '')
      .replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/^\s*(?:#{1,6}\s+|[-*>]\s+|\d+[.)、]\s*)/gm, '')
      .replace(/[*_`~]/g, '').replace(/[ \t]+/g, ' ').trim();
  }
  function clip(value, maxLength) {
    const chars = Array.from(String(value || ''));
    return chars.length <= maxLength ? chars.join('') : `${chars.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
  }
  function publicMessages(conversation) {
    return list(conversation?.messages).filter(message => message && !message.deletedAt && !message.deleted && ['user', 'agent', 'assistant'].includes(message.role) && !message.hidden && !message.internal && !['analysis', 'reasoning', 'tool'].includes(message.channel));
  }
  function excerpt(value, maxLength = 100) {
    const lines = plain(value).split(/\n+|(?<=[。！？.!?])\s+/).map(line => line.trim()).filter(line => line.length > 3);
    // Prefer a substantive sentence over a greeting or a Markdown section heading.
    const meaningful = lines.find(line => line.length > 12 && !/^(?:好的|当然|没问题|谢谢|Sure[,! ]|Certainly[,! ])/i.test(line));
    return clip(meaningful || lines.find(line => line.length > 8) || lines[0] || '', maxLength);
  }
  function summarize(conversation, options = {}) {
    const maxLength = Math.max(40, Math.min(1000, Number(options.maxLength) || 180));
    const messages = publicMessages(conversation);
    const user = messages.filter(message => message.role === 'user' && plain(textOf(message)));
    const substantive = user.filter(message => !/^(?:继续|接着|好的?|谢谢|收到|嗯|ok(?:ay)?|yes|thanks?|continue|go on)[。.!！\s]*$/i.test(plain(textOf(message))));
    const goalMessage = substantive[substantive.length - 1] || user[user.length - 1];
    // An older answer cannot be presented as the answer to a newer request.
    const goalIndex = goalMessage ? messages.indexOf(goalMessage) : -1;
    const answer = messages.slice(goalIndex + 1).filter(message => ['agent', 'assistant'].includes(message.role) && !message.live && !message.pending && plain(textOf(message))).pop();
    const goal = excerpt(goalMessage ? textOf(goalMessage) : conversation?.title, Math.floor(maxLength * .52));
    const outcome = answer ? excerpt(textOf(answer), Math.floor(maxLength * .52)) : '';
    const en = options.language === 'en';
    const parts = [goal ? `${en ? 'Goal' : '目标'}：${goal}` : '', outcome ? `${en ? 'Latest reply' : '最近答复'}：${outcome}` : messages.length ? (en ? 'Awaiting a reply' : '等待答复') : (en ? 'No messages yet' : '尚无消息')].filter(Boolean);
    return { goal, outcome, text: clip(parts.join(' · '), maxLength), messageCount: messages.length, sourceMessageIds: [goalMessage?.id, answer?.id].filter(Boolean) };
  }
  function timestamp(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const date = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(date) ? date : 0;
  }
  function activity(conversation) {
    return Math.max(timestamp(conversation?.updatedAt), timestamp(conversation?.createdAt), ...list(conversation?.messages).slice(-8).map(message => timestamp(message?.at || message?.createdAt)));
  }
  function isPinned(conversation) { return !!(conversation?.favorite || conversation?.pinned || timestamp(conversation?.pinnedAt)); }
  function sort(conversations) {
    return list(conversations).map((item, index) => ({ item, index })).sort((a, b) => Number(isPinned(b.item)) - Number(isPinned(a.item)) || activity(b.item) - activity(a.item) || a.index - b.index).map(entry => entry.item);
  }
  function hash(value) {
    let result = 2166136261;
    for (const char of String(value)) { result ^= char.codePointAt(0); result = Math.imul(result, 16777619); }
    return (result >>> 0).toString(36);
  }
  function tokens(value) {
    const source = norm(plain(value)).slice(0, 12000);
    let words = segmenter ? [...segmenter.segment(source)].filter(part => part.isWordLike).map(part => part.segment) : (source.match(/[a-z][a-z0-9+#.-]*|[\p{Script=Han}]+/gu) || []).flatMap(word => /^[\p{Script=Han}]{3,}$/u.test(word) ? Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)) : [word]);
    return [...new Set(words.filter(word => word.length >= 2 && !stop.has(word) && !/^\d+(?:\.\d+)?$/.test(word)))].slice(0, 180);
  }
  function features(conversation) {
    const messages = publicMessages(conversation);
    const users = messages.filter(message => message.role === 'user');
    const selected = [...new Set([...users.slice(0, 2), ...users.slice(-5)])];
    const title = tokens(conversation.title), goal = tokens(selected.map(message => textOf(message)).join('\n'));
    const weights = new Map();
    title.forEach(word => weights.set(word, 3));
    goal.forEach(word => weights.set(word, (weights.get(word) || 0) + 1));
    return { conversation, title: new Set(title), weights };
  }
  function compatible(a, b) {
    if (a.projectId && b.projectId && a.projectId !== b.projectId) return false;
    const wa = a.workspace, wb = b.workspace;
    return !wa || !wb || wa === 'auto' || wb === 'auto' || wa === wb;
  }
  function similarity(a, b, frequencies, count) {
    if (!compatible(a.conversation, b.conversation)) return { score: 0, terms: [] };
    const common = [...a.weights.keys()].filter(word => b.weights.has(word) && !(count >= 12 && frequencies.get(word) > count * .6 && !(a.title.has(word) && b.title.has(word))));
    if (!common.length) return { score: 0, terms: [] };
    const idf = word => 1 + Math.log((count + 1) / ((frequencies.get(word) || 0) + 1));
    const total = feature => [...feature.weights].reduce((sum, [word, weight]) => sum + weight * idf(word), 0);
    const shared = common.reduce((sum, word) => sum + Math.min(a.weights.get(word), b.weights.get(word)) * idf(word), 0);
    const score = shared / Math.max(1, Math.min(total(a), total(b)));
    const titleShared = common.filter(word => a.title.has(word) && b.title.has(word));
    const reliable = common.length >= 2 && (score >= .24 || titleShared.length >= 2) || common.length === 1 && common[0].length >= 4 && titleShared.length === 1 && score >= .5;
    return { score: reliable ? score : 0, terms: common.sort((x, y) => (Number(b.title.has(y) && a.title.has(y)) - Number(b.title.has(x) && a.title.has(x))) || idf(y) - idf(x) || x.localeCompare(y)).slice(0, 5) };
  }
  function sourceStamp(conversations) {
    return hash(conversations.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).map(conversation => [conversation.id, conversation.folderId || '', conversation.projectId || '', conversation.workspace || '', conversation.title || '', publicMessages(conversation).map(message => [message.id || '', textOf(message)]).slice(-8)]).map(value => JSON.stringify(value)).join('|'));
  }
  function projectFolder(state, projectId) {
    const folders = list(state?.folders?.conversations).filter(active), chats = list(state?.conversations).filter(eligible);
    const project = list(state?.projects).find(item => item.id === projectId && active(item));
    return folders.find(folder => folder.projectId === projectId) || folders.find(folder => {
      const members = chats.filter(chat => chat.folderId === folder.id);
      return members.length ? members.every(chat => chat.projectId === projectId) : project && norm(folder.name) === norm(project.name);
    });
  }
  function recommendation(state, kind, conversations, extra = {}) {
    const conversationIds = conversations.map(item => item.id).sort();
    const fingerprint = `org-v1-${hash(JSON.stringify([kind, extra.projectId || '', extra.folderId || '', conversationIds]))}`;
    const project = list(state?.projects).find(item => item.id === extra.projectId);
    const proposedName = extra.folderName || project?.name || extra.terms?.slice(0, 3).join(' · ') || conversations[0]?.title || '相关对话';
    const reason = kind === 'project' ? `这些对话属于「${project?.name || '同一项目'}」，可集中到一个文件夹。` : `对话标题和用户消息中共同出现「${(extra.terms || []).join('、')}」，可能在讨论同一主题。`;
    const reasonEn = kind === 'project' ? `These conversations belong to “${project?.name || 'the same project'}” and can share a folder.` : `Their titles and user messages share ${(extra.terms || []).join(', ')}, suggesting a common topic.`;
    return { id: fingerprint, fingerprint, sourceStamp: sourceStamp(conversations), kind, proposedName: clip(proposedName, 60), folderId: extra.folderId || null, projectId: extra.projectId || null, conversationIds, reason, reasonEn, evidence: kind === 'project' ? { projectId: extra.projectId } : { terms: extra.terms || [] }, members: sort(conversations).map(item => ({ id: item.id, title: item.title || '新对话', projectId: item.projectId || null, workspace: item.workspace || 'auto', summary: summarize(item) })) };
  }
  function recommend(state, options = {}) {
    const liveFolders = new Set(list(state?.folders?.conversations).filter(active).map(folder => folder.id));
    const candidates = sort(list(state?.conversations).filter(item => eligible(item) && item.id && !liveFolders.has(item.folderId) && (publicMessages(item).length || !/^(?:新对话|new chat)?$/i.test(norm(item.title)))));
    const all = [], assigned = new Set();
    const projectIds = [...new Set(candidates.map(item => item.projectId).filter(Boolean))];
    for (const projectId of projectIds) {
      if (!list(state?.projects).some(project => project.id === projectId && active(project))) continue;
      const members = candidates.filter(item => item.projectId === projectId), folder = projectFolder(state, projectId);
      const existingCount = folder ? list(state?.conversations).filter(item => eligible(item) && item.folderId === folder.id).length : 0;
      if (members.length < 2 && !existingCount) continue;
      all.push(recommendation(state, 'project', members, { projectId, folderId: folder?.id, folderName: folder?.name }));
      members.forEach(item => assigned.add(item.id));
    }
    const remaining = candidates.filter(item => !assigned.has(item.id)).map(features), frequencies = new Map();
    remaining.forEach(item => item.weights.forEach((_, word) => frequencies.set(word, (frequencies.get(word) || 0) + 1)));
    const titleTerms = new Set(remaining.flatMap(item => [...item.title]));
    const postings = new Map();
    remaining.forEach((item, index) => item.weights.forEach((_, word) => {
      if (remaining.length >= 12 && frequencies.get(word) > remaining.length * .6 && !titleTerms.has(word)) return;
      if (!postings.has(word)) postings.set(word, []);
      postings.get(word).push(index);
    }));
    const pair = new Map();
    function related(i, j) {
      const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
      if (!pair.has(key)) pair.set(key, similarity(remaining[i], remaining[j], frequencies, remaining.length));
      return pair.get(key);
    }
    // Complete-link groups: every member must match every other member. A vague
    // bridge conversation cannot pull unrelated topics/projects into a folder.
    const consumed = new Set();
    for (let i = 0; i < remaining.length; i++) {
      if (consumed.has(i)) continue;
      const group = [i];
      const potential = new Set();
      remaining[i].weights.forEach((_, word) => (postings.get(word) || []).forEach(index => { if (index > i && !consumed.has(index)) potential.add(index); }));
      for (const j of [...potential].sort((a, b) => a - b)) if (group.every(index => related(index, j).score > 0)) group.push(j);
      if (group.length < 2) continue;
      const terms = new Map();
      for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) related(group[a], group[b]).terms.forEach(word => terms.set(word, (terms.get(word) || 0) + 1));
      const common = [...terms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).filter(([, n]) => n >= group.length - 1).slice(0, 4).map(([word]) => word);
      if (!common.length) continue;
      all.push(recommendation(state, 'topic', group.map(index => remaining[index].conversation), { terms: common }));
      group.forEach(index => consumed.add(index));
    }
    const dismissed = new Set(list(state?.conversationOrganization?.dismissed).map(item => typeof item === 'string' ? item : item?.fingerprint));
    const limit = options.limit === Infinity ? Infinity : Math.max(0, Number.isFinite(options.limit) ? options.limit : 8);
    return all.filter(item => options.includeDismissed || !dismissed.has(item.fingerprint)).slice(0, limit);
  }
  function apply(original, command, options = {}) {
    if (!original || typeof original !== 'object') throw new Error('工作区不可用。');
    const now = options.now ?? Date.now(), makeId = options.makeId || (() => `folder_${now}_${Math.random().toString(36).slice(2, 9)}`);
    const state = { ...original, conversations: list(original.conversations).slice(), folders: { ...(original.folders || {}), conversations: list(original.folders?.conversations).slice() } };
    const findFolder = id => state.folders.conversations.find(folder => folder.id === id && active(folder));
    const nameOf = value => { const name = String(value || '').trim(); if (!name) throw new Error('请填写文件夹名称。'); if (Array.from(name).length > 100) throw new Error('文件夹名称请控制在 100 字以内。'); return name; };
    const uniqueName = (name, except) => { if (state.folders.conversations.some(folder => active(folder) && folder.id !== except && norm(folder.name) === norm(name))) throw new Error('已有同名文件夹，请选择现有文件夹或修改名称。'); };
    const create = (name, projectId) => { uniqueName(name); const id = makeId(); if (!id || state.folders.conversations.some(folder => folder.id === id)) throw new Error('文件夹标识冲突，请重试。'); const folder = { id, name, createdAt: now, updatedAt: now, ...(projectId ? { projectId } : {}) }; state.folders.conversations.push(folder); return folder; };
    const members = ids => { const unique = [...new Set(list(ids))]; if (!unique.length) throw new Error('请选择至少一条对话。'); return unique.map(id => { const chat = state.conversations.find(item => item.id === id && eligible(item)); if (!chat) throw new Error('对话已归档、删除或不可用，请刷新后重试。'); return chat; }); };
    const move = (chats, folderId) => { if (folderId && !findFolder(folderId)) throw new Error('目标文件夹不可用。'); const ids = new Set(chats.map(chat => chat.id)); state.conversations = state.conversations.map(chat => ids.has(chat.id) ? { ...chat, folderId: folderId || null, organizationUpdatedAt: now } : chat); };
    switch (command?.action) {
      case 'createFolder': create(nameOf(command.name), null); break;
      case 'renameFolder': {
        const folder = findFolder(command.id); if (!folder) throw new Error('文件夹不可用。'); const name = nameOf(command.name); uniqueName(name, folder.id);
        state.folders.conversations = state.folders.conversations.map(item => item === folder ? { ...folder, name, updatedAt: now } : item); break;
      }
      case 'move': move(members(command.conversationIds || [command.conversationId || command.id]), command.folderId || null); break;
      case 'pin': {
        const chats = members(command.conversationIds || [command.conversationId || command.id]), ids = new Set(chats.map(chat => chat.id));
        state.conversations = state.conversations.map(chat => {
          if (!ids.has(chat.id)) return chat;
          const pinned = command.pinned === undefined ? !isPinned(chat) : !!command.pinned;
          const next = { ...chat, favorite: pinned, pinnedAt: pinned ? (timestamp(chat.pinnedAt) || now) : null, organizationUpdatedAt: now }; delete next.pinned; return next;
        }); break;
      }
      case 'dismiss': {
        const id = command.recommendation?.fingerprint || command.recommendationId || command.id;
        const current = recommend(original, { limit: Infinity, includeDismissed: true }).find(item => item.fingerprint === id);
        if (!current) throw new Error('这条整理建议已经变化，请重新分析。');
        const previous = list(original.conversationOrganization?.dismissed).filter(item => (typeof item === 'string' ? item : item?.fingerprint) !== id);
        state.conversationOrganization = { ...(original.conversationOrganization || {}), dismissed: [...previous, { fingerprint: id, at: now }].slice(-200) }; break;
      }
      case 'approve': {
        const input = command.recommendation;
        const id = input?.fingerprint || command.recommendationId || command.id;
        const current = recommend(original, { limit: Infinity, includeDismissed: true }).find(item => item.fingerprint === id);
        if (!current || input?.sourceStamp && input.sourceStamp !== current.sourceStamp) throw new Error('对话或文件夹已变化，请重新查看整理建议后确认。');
        const selected = command.conversationIds || current.conversationIds;
        if (list(selected).some(id => !current.conversationIds.includes(id))) throw new Error('所选对话不属于这条整理建议。');
        const chats = members(selected), target = command.targetFolderId === undefined ? current.folderId : command.targetFolderId;
        if (chats.length < 2 && !target) throw new Error('至少选择两条对话，或选择现有文件夹。');
        const folder = target ? findFolder(target) : create(nameOf(command.name || current.proposedName), current.kind === 'project' ? current.projectId : null);
        if (!folder) throw new Error('目标文件夹不可用。');
        move(chats, folder.id); break;
      }
      default: throw new Error('不支持的对话整理操作。');
    }
    return state;
  }
  const equal = (a, b) => a === b || a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
  function restoreFields(before, after, current) {
    let restored = current;
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
      if (equal(before?.[key], after?.[key]) || !equal(current?.[key], after?.[key])) continue;
      if (restored === current) restored = { ...current };
      if (Object.prototype.hasOwnProperty.call(before || {}, key)) restored[key] = before[key];
      else delete restored[key];
    }
    return restored;
  }
  function rollbackOwned(before, after, current) {
    // Revert only values this command still owns. Do not resurrect removed
    // conversations, replace transcripts or undo a newer folder/pin choice.
    if (!current || typeof current !== 'object') return current;
    let next = current;
    const assign = (key, value) => { if (next === current) next = { ...current }; next[key] = value; };
    const previousChats = new Map(list(before?.conversations).map(chat => [chat.id, chat]));
    const afterChats = new Map(list(after?.conversations).map(chat => [chat.id, chat]));
    let changed = false;
    const conversations = list(current.conversations).map(chat => {
      const old = previousChats.get(chat.id), ours = afterChats.get(chat.id);
      if (!old || !ours || old === ours) return chat;
      const restored = restoreFields(old, ours, chat);
      if (restored !== chat) changed = true;
      return restored;
    });
    if (changed) assign('conversations', conversations);
    const previousFolders = new Map(list(before?.folders?.conversations).map(folder => [folder.id, folder]));
    const afterFolders = new Map(list(after?.folders?.conversations).map(folder => [folder.id, folder]));
    changed = false;
    const folders = list(current.folders?.conversations).flatMap(folder => {
      const old = previousFolders.get(folder.id), ours = afterFolders.get(folder.id);
      if (!ours || old === ours) return [folder];
      if (!old) {
        // A later move into our newly created folder gives it another owner.
        if (equal(folder, ours) && !list(next.conversations).some(chat => chat.folderId === folder.id)) { changed = true; return []; }
        return [folder];
      }
      const restored = restoreFields(old, ours, folder);
      if (restored !== folder) changed = true;
      return [restored];
    });
    if (changed) assign('folders', { ...(current.folders || {}), conversations: folders });
    if (before?.conversationOrganization !== after?.conversationOrganization) {
      const oldMeta = before?.conversationOrganization, oursMeta = after?.conversationOrganization;
      if (equal(current.conversationOrganization, oursMeta)) {
        if (next === current) next = { ...current };
        if (oldMeta === undefined) delete next.conversationOrganization;
        else next.conversationOrganization = oldMeta;
      } else if (current.conversationOrganization && oursMeta) {
        const oldDismissed = list(oldMeta?.dismissed), oursDismissed = list(oursMeta.dismissed);
        const additions = oursDismissed.filter(item => !oldDismissed.some(previous => equal(previous, item)));
        const existing = list(current.conversationOrganization.dismissed);
        const kept = existing.filter(item => !additions.some(added => equal(added, item)));
        if (kept.length !== existing.length) assign('conversationOrganization', { ...current.conversationOrganization, dismissed: kept });
      }
    }
    return next;
  }
  async function commit(hooks, command) {
    if (typeof hooks?.getState !== 'function' || typeof hooks?.setState !== 'function' || typeof hooks?.save !== 'function') throw new Error('对话整理的保存接口不可用。');
    const before = hooks.getState(), after = apply(before, command, { now: hooks.now, makeId: hooks.makeId });
    hooks.setState(after);
    try {
      const saved = await hooks.save();
      if (saved === false) throw new Error('保存未完成，请重试。');
      return hooks.getState();
    } catch (error) {
      const current = hooks.getState(), restored = rollbackOwned(before, after, current);
      if (restored !== current) hooks.setState(restored);
      throw error;
    }
  }
  return { active, eligible, summarize, sort, isPinned, activity, recommend, apply, rollbackOwned, commit };
});
