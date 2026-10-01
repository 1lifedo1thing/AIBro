const test = require('node:test');
const assert = require('node:assert/strict');
const Editor = require('../app/note-editor');

const initial = () => ({ projects: [{ id: 'p', name: '科研项目', workspace: '科研' }], imports: [{ id: 'pdf', name: 'paper.pdf' }], notes: [{ id: 'n', title: '主题主笔记', content: '# 动机\n\n原始分析', workspace: '科研', projectId: 'p', paperId: 'paper', sourceAttachmentIds: ['pdf'], createdAt: 1, updatedAt: 2 }, { id: 'other', title: '另一篇', content: '其他正文', workspace: '科研' }] });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function harness(options = {}) {
  const elements = [], timers = new Map(); let timerId = 0, state = options.state || initial(), saves = 0;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.style = { setProperty: (key, value) => { this.style[key] = value; } }; this.hidden = false; this.value = ''; elements.push(this); }
    append(...nodes) { nodes.forEach(item => { item.remove(); item.parentElement = this; this.children.push(item); }); }
    replaceChildren(...nodes) { this.children.forEach(item => { item.parentElement = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    async fire(type, extras = {}) { const event = { target: this, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extras }; for (const handler of this.listeners[type] || []) await handler(event); return event; }
    focus() { document.activeElement = this; }
    scrollIntoView() { this.scrolled = true; }
    querySelectorAll(query) { const result = []; const tags = query.toUpperCase().split(','); const walk = item => item.children.forEach(child => { if (tags.includes(child.tagName)) result.push(child); walk(child); }); walk(this); return result; }
    querySelector(query) { return this.querySelectorAll(query)[0] || null; }
    showModal() { this.open = true; }
    close() { this.open = false; void this.fire('close'); }
    set innerHTML(value) { this.html = String(value); this.replaceChildren(); for (const match of this.html.matchAll(/<(h[1-6])[^>]*>([^<]*)<\/h[1-6]>/g)) { const header = new Element(match[1]); header.textContent = match[2]; this.append(header); } }
    get innerHTML() { return this.html || ''; }
  }
  const document = { createElement: tag => new Element(tag), activeElement: null };
  document.body = new Element('body');
  const unload = [], saved = [], toasts = [], rendered = [];
  const env = { document, NoteEditorRecovery: options.recovery, ReadingPane: options.reader, addEventListener: (type, callback) => { if (type === 'beforeunload') unload.push(callback); }, setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) };
  const api = Editor[options.legacy ? 'createController' : 'createInlineController']({ getState: () => state, save: () => { saves++; return options.save?.(); }, renderAll: () => rendered.push(true), onSaved: id => saved.push(id), toast: message => toasts.push(message) }, env);
  const host = options.legacy ? document.body : new Element('section');
  const mount = (id = 'n', config = {}) => options.legacy ? api.open(id) : api.mount(host, id, config);
  mount('n', options.config || {});
  const live = node => { for (let item = node; item; item = item.parentElement) if (item === host) return true; return false; };
  const el = name => elements.filter(live).find(node => node.dataset.noteAction === name || node.attrs['aria-label'] === name || node.className === name || node.id === name);
  return { api, host, elements, document, saved, toasts, rendered, el, mount,
    get state() { return state; }, set state(value) { state = value; }, get saves() { return saves; },
    input: async (name, value) => { const input = el(name); input.value = value; await input.fire('input'); },
    click: async name => { await el(name).fire('click'); await flush(); },
    flushPreview: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
    beforeUnload: () => { const event = { preventDefault() { this.prevented = true; } }; unload.forEach(callback => callback(event)); return event; }
  };
}

test('document mounts nonmodally, renders through the safe host renderer and has a working heading outline', async () => {
  const received = [], h = harness({ config: { renderMarkdown: content => { received.push(content); return '<h1>动机</h1><h2>方法</h2>'; } } });
  assert.equal(h.elements.some(node => node.tagName === 'DIALOG' || node.tagName === 'FORM'), false);
  assert.equal(h.api.snapshot().mode, 'read'); assert.equal(h.api.isActive('n'), true);
  assert.equal(received[0], '# 动机\n\n原始分析');
  const links = h.elements.filter(node => node.className?.includes('note-document-outline-link'));
  assert.equal(links.length, 2); await links[1].fire('click');
  assert.equal(h.elements.find(node => node.tagName === 'H2').scrolled, true);
  await h.click('edit'); await h.input('Markdown 正文', '# 修订后的全文'); h.flushPreview();
  assert.equal(received.at(-1), '# 修订后的全文'); assert.equal(h.state.notes[0].content, '# 动机\n\n原始分析');
  await h.click('preview'); assert.equal(h.api.snapshot().mode, 'preview'); assert.equal(h.api.snapshot().dirty, true);
});

test('without an HTML renderer the document treats malicious Markdown as literal text', () => {
  const state = initial(); state.notes[0].content = '<img src=x onerror=alert(1)>[bad](javascript:alert(1))';
  const h = harness({ state }); const pre = h.elements.find(node => node.tagName === 'PRE' && node.textContent === state.notes[0].content);
  assert.ok(pre); assert.equal(h.el('note-document-preview').innerHTML, '');
});
test('reading renderer receives full YAML source while source editing and saved content keep exact metadata', async () => {
  const state = initial(); const original = '\uFEFF---\r\ntitle: 主笔记\r\nsources: [pdf]\r\n---\r\n# 正文\r\n\r\n内容'; state.notes[0].content = original;
  const received = [], h = harness({ state, config: { renderMarkdown: content => { received.push(content); return '<h1>正文</h1>'; } } });
  assert.equal(received[0], original); assert.equal(h.el('Markdown 正文').value, original);
  await h.click('edit'); await h.input('Markdown 正文', original + '\r\n补充'); assert.equal(await h.api.save(), true);
  assert.equal(state.notes[0].content, original + '\r\n补充');
  assert.equal(Editor.markdownBody('---\nA paragraph\n---\n正文'), '---\nA paragraph\n---\n正文');
  assert.equal(Editor.markdownBody('---\ntitle: unclosed'), '---\ntitle: unclosed');
});

test('editing a paper main note and Cmd+S retain paper identity, sources, manual authority and revision history', async () => {
  const h = harness(); await h.click('edit'); await h.input('笔记标题', '完整主笔记'); await h.input('Markdown 正文', '人工校正的全文');
  const event = await h.el('note-document').fire('keydown', { key: 's', metaKey: true }); await flush();
  assert.equal(event.defaultPrevented, true); assert.equal(h.saves, 1);
  assert.equal(h.state.notes[0].content, '人工校正的全文'); assert.equal(h.state.notes[0].paperId, 'paper');
  assert.deepEqual(h.state.notes[0].sourceAttachmentIds, ['pdf']); assert.equal(h.state.notes[0].userEdited, true);
  assert.equal(h.state.notes[0].revisionHistory[0].content, '# 动机\n\n原始分析'); assert.deepEqual(h.saved, ['n']);
  assert.equal(h.api.snapshot().dirty, false); assert.equal(await h.api.beforeLeave(), true);
});

test('leave protection keeps the document on Stay, discards only explicit unsaved changes, and never opens a modal', async () => {
  const h = harness(), before = JSON.stringify(h.state);
  await h.click('edit'); await h.input('Markdown 正文', '我的草稿');
  let settled = false; const first = h.api.beforeLeave().then(value => { settled = true; return value; }); await flush();
  assert.equal(settled, false); assert.equal(h.el('note-document-leave').hidden, false);
  await h.click('stay'); assert.equal(await first, false); assert.equal(h.el('Markdown 正文').value, '我的草稿');
  const second = h.api.beforeLeave(); await h.click('discard'); assert.equal(await second, true);
  assert.equal(JSON.stringify(h.state), before); assert.equal(h.api.snapshot().dirty, false); assert.equal(h.api.getDraft('n'), null);
  assert.equal(h.saves, 0); assert.equal(h.beforeUnload().prevented, undefined);
});

test('a dirty retained document reveals its existing leave decision before focus and reuses that decision',async()=>{
  let resumed=0;const h=harness({reader:{resume(){resumed++;}}});
  assert.equal(h.api.beforeLeave(),true);assert.equal(resumed,0,'clean documents do not interrupt the navigation destination');
  await h.click('edit');await h.input('Markdown 正文','保留中的编辑草稿');
  const decision=h.api.beforeLeave();assert.equal(resumed,1);assert.equal(h.document.activeElement,h.el('stay'));
  assert.equal(h.api.beforeLeave(),decision);assert.equal(resumed,2,'an existing decision can also have been parked by global navigation');
  await h.click('stay');assert.equal(await decision,false);assert.equal(h.el('Markdown 正文').value,'保留中的编辑草稿');assert.equal(h.saves,0);
});

test('Save and continue resolves navigation only after persistence; pending save is single flight', async () => {
  let done; const h = harness({ save: () => new Promise(resolve => { done = resolve; }) });
  await h.click('edit'); await h.input('Markdown 正文', '待保存'); const leaving = h.api.beforeLeave();
  await h.click('save-leave'); let settled = false; leaving.then(() => { settled = true; }); await flush();
  void h.api.save(); assert.equal(h.saves, 1); assert.equal(settled, false); assert.equal(h.el('Markdown 正文').disabled, true);
  done(true); assert.equal(await leaving, true); await flush(); assert.equal(h.api.snapshot().dirty, false);
});

test('save failure keeps the editor and its draft, leaves navigation cancelled, and rolls back only its own write', async () => {
  const h = harness({ save: () => Promise.reject(new Error('磁盘已满')) });
  await h.click('edit'); await h.input('Markdown 正文', '待恢复'); const leave = h.api.beforeLeave(); await h.click('save-leave');
  assert.equal(await leave, false); assert.equal(h.api.getDraft('n').content, '待恢复');
  assert.equal(h.state.notes[0].content, '# 动机\n\n原始分析'); assert.match(h.el('note-document-status').textContent, /磁盘已满/);
  assert.equal(h.api.snapshot().saving, false); assert.deepEqual(h.saved, []);
});

test('external changes or deleted projects block stale saves without changing user data', async () => {
  for (const mutation of [h => { h.state.notes[0].content = '外部更新'; }, h => { h.state.projects[0].archived = true; }]) {
    const h = harness(); await h.click('edit'); await h.input('Markdown 正文', '本机草稿'); mutation(h); const before = JSON.stringify(h.state);
    assert.equal(await h.api.save(), false); assert.equal(JSON.stringify(h.state), before); assert.equal(h.saves, 0);
    assert.equal(h.api.getDraft('n').content, '本机草稿');
  }
});

test('AI proposal needs explicit load and save; a newer proposal blocks applying the older draft', async () => {
  const state = initial(); state.notes[0].userEdited = true; state.notes[0].aiDraft = { title: 'AI 建议', content: '增量候选', createdAt: 3 };
  const h = harness({ state }); await h.click('apply-ai'); assert.equal(h.el('Markdown 正文').value, '增量候选'); assert.equal(h.saves, 0);
  assert.equal(state.notes[0].content, '# 动机\n\n原始分析');
  state.notes[0].aiDraft = { title: '新建议', content: '更新候选', createdAt: 4 };
  assert.equal(await h.api.save(), false); assert.equal(state.notes[0].aiDraft.content, '更新候选');
  const fresh = harness({ state: initial() }); fresh.state.notes[0].aiDraft = { content: '候选', createdAt: 5 };
  fresh.mount(); await fresh.click('apply-ai'); await fresh.input('Markdown 正文', '候选 + 人工修订'); assert.equal(await fresh.api.save(), true);
  assert.equal(fresh.state.notes[0].aiDraft, undefined); assert.equal(fresh.state.notes[0].content, '候选 + 人工修订');
});

test('AI draft cannot replace an unsaved human draft and normal save preserves an unapplied proposal', async () => {
  const state = initial(); state.notes[0].aiDraft = { content: 'AI 候选', createdAt: 3 }; const h = harness({ state });
  await h.click('edit'); await h.input('Markdown 正文', '人工未存稿'); await h.click('apply-ai');
  assert.equal(h.el('Markdown 正文').value, '人工未存稿'); assert.match(h.el('note-document-status').textContent, /先保存/);
  assert.equal(await h.api.save(), true); assert.equal(state.notes[0].aiDraft.content, 'AI 候选');
});

test('same-note rerenders preserve edit state and source removal keeps a recoverable in-window draft', { timeout: 1000 }, async () => {
  const h = harness(); await h.click('edit'); await h.input('Markdown 正文', '未保存内容');
  const input = h.el('Markdown 正文'); assert.equal(h.mount(), true); assert.equal(h.el('Markdown 正文'), input);
  assert.equal(h.mount('other'), false); assert.equal(h.api.snapshot().id, 'n');
  h.state.notes = h.state.notes.filter(note => note.id !== 'n');
  let settled = false; const leaving = Promise.resolve(h.api.beforeLeave()).then(value => { settled = true; return value; }); await flush();
  assert.equal(settled, false, 'a removed source does not authorize dropping the unsaved buffer');
  assert.equal(h.el('note-document-leave').hidden, false);
  await h.click('stay'); assert.equal(await leaving, false);
  assert.equal(h.el('Markdown 正文'), input); assert.equal(h.api.getDraft('n').content, '未保存内容');
  h.api.unmount({ force: true }); assert.equal(h.api.getDraft('n').content, '未保存内容');
  h.state.notes.push(initial().notes[0]); h.mount(); assert.equal(h.el('Markdown 正文').value, '未保存内容');
  assert.equal(h.beforeUnload().prevented, true);
});

test('a forced lifecycle change while save is pending never opens or rewrites a newer document', async () => {
  let fail; const h = harness({ save: () => new Promise((_, reject) => { fail = reject; }) });
  await h.click('edit'); await h.input('Markdown 正文', '在途修改'); const saving = h.api.save();
  h.api.unmount({ force: true }); h.mount('other'); h.state.notes[0].content = '外部最新版本';
  fail(new Error('网络失败')); assert.equal(await saving, false);
  assert.equal(h.api.snapshot().id, 'other'); assert.equal(h.el('Markdown 正文').value, '其他正文');
  assert.equal(h.state.notes[0].content, '外部最新版本'); assert.deepEqual(h.saved, []);
});
test('a successful older persistence response never discards the draft when another writer already changed the note', async () => {
  let done; const h = harness({ save: () => new Promise(resolve => { done = resolve; }) });
  await h.click('edit'); await h.input('Markdown 正文', '我的修改'); const pending = h.api.save();
  h.state.notes[0].content = '外部更晚修改'; done(true);
  assert.equal(await pending, false); assert.equal(h.state.notes[0].content, '外部更晚修改');
  assert.equal(h.api.getDraft('n').content, '我的修改'); assert.deepEqual(h.saved, []);
});
test('editing a note folder normalizes a relative hierarchy and saves an immutable previous folder', async () => {
  const state = initial(); state.notes[0].folderPath = '知识/旧目录'; const h = harness({ state });
  await h.click('edit'); await h.input('保存目录', ' 文献\\DemoGraph//./方法 ');
  assert.equal(h.api.snapshot().dirty, true); assert.equal(state.notes[0].folderPath, '知识/旧目录');
  assert.equal(await h.api.save(), true); assert.equal(state.notes[0].folderPath, '文献/DemoGraph/方法');
  assert.equal(h.el('保存目录').value, '文献/DemoGraph/方法');
  assert.equal(state.notes[0].revisionHistory[0].folderPath, '知识/旧目录');
  assert.equal(state.notes[0].content, '# 动机\n\n原始分析'); assert.deepEqual(state.notes[0].sourceAttachmentIds, ['pdf']);
});
test('folder traversal, absolute paths, depth and size are rejected without a write; ordinary Unicode relative names work', () => {
  for (const value of ['../outside', '文献/../elsewhere', '文献\\..\\elsewhere', '/Users/private', 'C:\\private', '\\\\server\\file', 'a\0b', Array(13).fill('层').join('/'), 'a'.repeat(501)]) assert.throws(() => Editor.normalizeFolder(value), /保存目录/);
  assert.equal(Editor.normalizeFolder(' 文献\\DemoGraph//./分析 '), '文献/DemoGraph/分析');
  assert.equal(Editor.normalizeFolder(''), ''); assert.equal(Editor.normalizeFolder(Array(12).fill('层').join('/')).split('/').length, 12);
  const state = initial(), before = JSON.stringify(state), session = Editor.begin(state, 'n'); session.folderPath = '../escape';
  assert.throws(() => Editor.prepare(state, session), /保存目录/); assert.equal(JSON.stringify(state), before);
});
test('folder-only drafts receive leave protection and external moves invalidate a stale content save', async () => {
  const h = harness(); await h.click('edit'); await h.input('保存目录', '文献/DemoGraph'); const leaving = h.api.beforeLeave();
  await h.click('stay'); assert.equal(await leaving, false); assert.equal(h.api.getDraft('n').folderPath, '文献/DemoGraph');
  h.state.notes[0].folderPath = '其他目录'; const before = JSON.stringify(h.state);
  assert.equal(await h.api.save(), false); assert.equal(JSON.stringify(h.state), before);
});
test('folder persistence failure rolls back the folder and empty legacy sessions preserve their original shape', async () => {
  const h = harness({ save: () => false }); await h.click('edit'); await h.input('保存目录', '文献');
  assert.equal(await h.api.save(), false); assert.equal(Object.hasOwn(h.state.notes[0], 'folderPath'), false); assert.equal(h.api.getDraft('n').folderPath, '文献');
  const state = initial(), session = Editor.begin(state, 'n'); delete session.folderPath; delete session.originalFolderPath; session.content = '旧版session修改';
  const result = Editor.prepare(state, session); assert.equal(Object.hasOwn(result.after, 'folderPath'), false); assert.equal(Object.hasOwn(result.after.revisionHistory[0], 'folderPath'), false);
  const clean = harness(); await clean.click('edit'); await clean.input('保存目录', './'); assert.equal(await clean.api.save(), true); assert.equal(clean.api.snapshot().dirty, false); assert.equal(clean.saves, 0);
});

function recoveryFixture() {
  let hooks, id;
  const remembered = [], mounts = [], clears = [], discards = [];
  const f = { remembered, mounts, clears, discards, savedResult: true, discardResult: true, flushes: 0, unmounts: 0,
    module: { create(value) { hooks = value; return {
      mount(host, noteId) { id = noteId; mounts.push({ host, id, session: { ...hooks.getSession() } }); hooks.onLoading(true); },
      remember(session) { remembered.push({ ...session }); },
      saved(noteId) { clears.push(noteId); return Promise.resolve(f.savedResult); },
      discard(noteId) { discards.push(noteId); return Promise.resolve(f.discardResult); },
      flushAll() { f.flushes++; return Promise.resolve(true); },
      unmount() { f.unmounts++; hooks.onLoading(false); }
    }; } },
    finish(session) { if (arguments.length) hooks.onRestore(session); hooks.onLoading(false); },
    restore(session) { hooks.onRestore(session); }, current: () => hooks.getSession(), id: () => id
  };
  return f;
}
test('recovery loading disables writes and AI while allowing clean navigation, then restores an editable note session', async () => {
  const recovery = recoveryFixture(), state = initial(); state.notes[0].aiDraft = { content: 'AI' };
  const h = harness({ state, recovery: recovery.module });
  assert.equal(h.el('Markdown 正文').disabled, true); assert.equal(h.el('apply-ai').disabled, true);
  assert.equal(await h.api.save(), false); assert.equal(h.saves, 0); assert.equal(h.api.beforeLeave(), true);
  assert.equal(recovery.remembered.length, 0, 'initial untouched content must not replace a saved draft');
  const restored = { ...Editor.begin(state, 'n'), content: '跨重启草稿', folderPath: '研究/草稿' }; recovery.finish(restored);
  assert.equal(h.el('Markdown 正文').value, '跨重启草稿'); assert.equal(h.el('保存目录').value, '研究/草稿');
  assert.equal(h.api.snapshot().mode, 'edit'); assert.equal(h.el('Markdown 正文').disabled, false);
  assert.equal(h.state.notes[0].content, '# 动机\n\n原始分析');
  await h.input('Markdown 正文', '继续编辑'); assert.equal(recovery.remembered.at(-1).content, '继续编辑');
  assert.equal(await h.api.flushDrafts(), true); assert.equal(recovery.flushes, 1);
});
test('explicit recovery of an empty draft resets the editor without overwriting the stored note', async () => {
  const recovery = recoveryFixture(), h = harness({ recovery: recovery.module }); recovery.finish();
  await h.click('edit'); await h.input('Markdown 正文', '当前草稿'); recovery.restore(null);
  assert.equal(h.el('Markdown 正文').value, '# 动机\n\n原始分析'); assert.equal(h.api.snapshot().mode, 'read');
  assert.equal(h.api.getDraft('n'), null); assert.equal(h.saves, 0);
});
test('formal note save with failed draft cleanup preserves the result, cancels leave and retries only cleanup', async () => {
  const recovery = recoveryFixture(), h = harness({ recovery: recovery.module }); recovery.finish(); recovery.savedResult = false;
  await h.click('edit'); await h.input('Markdown 正文', '已写入正文'); const leaving = h.api.beforeLeave();
  assert.equal(await h.api.save(), false); assert.equal(await leaving, false);
  assert.equal(h.state.notes[0].content, '已写入正文'); assert.equal(h.api.snapshot().mounted, true);
  assert.equal(h.api.getDraft('n').content, '已写入正文'); assert.match(h.el('note-document-status').textContent, /笔记已保存.*清理尚未确认/);
  assert.equal(h.saves, 1); recovery.savedResult = true;
  assert.equal(await h.api.save(), true); assert.equal(h.saves, 1); assert.deepEqual(recovery.clears, ['n', 'n']);
  assert.equal(h.api.getDraft('n'), null);
});
test('discard does not erase visible input or permit leave before the draft clear succeeds', async () => {
  const recovery = recoveryFixture(), h = harness({ recovery: recovery.module }); recovery.finish();
  let resolve; recovery.discardResult = new Promise(done => { resolve = done; });
  await h.click('edit'); await h.input('Markdown 正文', '未确认的放弃'); const leaving = h.api.beforeLeave();
  const discarding = h.click('discard'); assert.equal(h.el('Markdown 正文').value, '未确认的放弃'); assert.equal(h.el('Markdown 正文').disabled, true);
  resolve(false); await discarding; assert.equal(await leaving, false); assert.equal(h.api.getDraft('n').content, '未确认的放弃');
  recovery.discardResult = true; const retryLeave = h.api.beforeLeave(); await h.click('discard');
  assert.equal(await retryLeave, true); assert.equal(h.api.getDraft('n'), null); assert.equal(h.el('Markdown 正文').value, '# 动机\n\n原始分析');
});
test('runtime drafts are supplied on remount and forced navigation invalidates the old recovery surface', async () => {
  const recovery = recoveryFixture(), h = harness({ recovery: recovery.module }); recovery.finish();
  await h.click('edit'); await h.input('Markdown 正文', '同窗口草稿'); h.api.unmount({ force: true }); h.mount('other'); recovery.finish();
  h.api.unmount(); h.mount(); assert.equal(recovery.mounts.at(-1).session.content, '同窗口草稿');
  assert.ok(recovery.unmounts >= 3); assert.equal(h.el('Markdown 正文').value, '同窗口草稿');
});
test('a formal save from an earlier editor cannot clear a newer draft after a forced remount', async () => {
  const recovery = recoveryFixture(); let resolveSave;
  const h = harness({ recovery: recovery.module, save: () => new Promise(resolve => { resolveSave = resolve; }) }); recovery.finish();
  await h.click('edit'); await h.input('Markdown 正文', '较早保存'); const saving = h.api.save();
  h.api.unmount({ force: true }); h.mount(); recovery.finish(); await h.input('Markdown 正文', '重新打开后的新输入');
  resolveSave(true); assert.equal(await saving, false);
  assert.equal(h.el('Markdown 正文').value, '重新打开后的新输入'); assert.equal(h.api.getDraft('n').content, '重新打开后的新输入');
  assert.deepEqual(recovery.clears, []); assert.equal(h.state.notes[0].content, '较早保存');
});
test('legacy dialog restores local drafts, flushes on close and keeps the dialog when cleanup fails', async () => {
  const recovery = recoveryFixture(), h = harness({ legacy: true, recovery: recovery.module });
  assert.equal(h.el('noteEditorTitle').disabled, true); assert.equal(await h.api.save(), false);
  recovery.finish({ ...Editor.begin(h.state, 'n'), content: '恢复的旧式编辑器草稿' });
  assert.equal(h.el('noteEditorContent').value, '恢复的旧式编辑器草稿');
  h.api.close(); await flush(); assert.equal(h.el('noteEditorDialog').open, false); assert.ok(recovery.flushes >= 1);
  h.mount(); recovery.finish(); recovery.savedResult = false;
  assert.equal(await h.api.save(), false); assert.equal(h.el('noteEditorDialog').open, true);
  assert.equal(h.state.notes[0].content, '恢复的旧式编辑器草稿'); assert.match(h.el('noteEditorStatus').textContent, /清理尚未确认/);
  recovery.savedResult = true; assert.equal(await h.api.save(), true); assert.equal(h.saves, 1); assert.equal(h.el('noteEditorDialog').open, false);
});
