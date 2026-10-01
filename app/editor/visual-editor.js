import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar } from '@milkdown/crepe/feature/toolbar';
import { topBar } from '@milkdown/crepe/feature/top-bar';
import { editorViewCtx, prosePluginsCtx, remarkCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { undo, redo, undoDepth, redoDepth, closeHistory } from '@milkdown/kit/prose/history';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { IMAGE_ACCEPT, createImageUploads } from './image-uploads.mjs';
import { replaceAll } from '@milkdown/kit/utils';
import { EditorView as CodeView } from '@codemirror/view';
import { LanguageDescription } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { splitFrontmatter, diagnoseMarkdown, safeDocumentUrl, sourceTextMappings, mapProsePosition, mapSourcePosition } from './visual-policy.mjs';
import styles from './visual-editor.css';

const commandLabels = {
  bold: '粗体', italic: '斜体', strikethrough: '删除线', code: '行内代码', link: '链接', image: '插入图片',
  table: '插入表格', 'code-block': '代码块', math: '数学公式', quote: '引用', hr: '分隔线',
  'bullet-list': '无序列表', 'ordered-list': '有序列表', 'task-list': '任务列表', undo: '撤销', redo: '重做',
};
const languages = [
  ['JavaScript', ['js', 'jsx'], javascript({ jsx: true })],
  ['TypeScript', ['ts', 'tsx'], javascript({ typescript: true, jsx: true })],
  ['Python', ['py'], python()], ['JSON', ['json'], json()], ['CSS', ['css'], css()],
  ['HTML', ['html', 'xml'], html()], ['Markdown', ['md', 'markdown'], markdown()],
].map(([name, alias, support]) => LanguageDescription.of({ name, alias, support }));
const codeTheme = CodeView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text, #202020)' },
  '.cm-content': { fontFamily: 'var(--crepe-font-code)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted, #777)', border: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--crepe-color-selected)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--crepe-color-hover)' },
});

function plainIcon(text) { return `<span aria-hidden="true" class="document-visual-symbol">${text}</span>`; }

// Only the tooltip's explicit Open anchor navigates a document. Clicking a
// link inside the prose remains an editing action, never a WebView navigation.
export function installDocumentLinkNavigation(outer, options = {}) {
  let disposed = false, intent = 0;
  const click = event => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || !outer.contains(anchor)) return;
    const url = anchor.getAttribute('href') || '';
    if (safeDocumentUrl(url) && /^(?:https?:\/\/|mailto:|tel:)/i.test(url)) return;
    event.preventDefault();
    if (!anchor.matches('.link-preview a.link-display')) return;
    event.stopPropagation();
    if (disposed || options.isAvailable?.() === false) return;
    const serial = ++intent, isCurrent = () => !disposed && serial === intent && outer.isConnected && outer.contains(anchor) && options.isAvailable?.() !== false;
    if (!url || !safeDocumentUrl(url) || /^[a-z][a-z\d+.-]*:/i.test(url) || typeof options.onOpenDocumentLink !== 'function') {
      options.onError?.(new Error('此链接没有可用的文档位置，无法从当前笔记打开。')); return;
    }
    Promise.resolve().then(() => isCurrent() && options.onOpenDocumentLink(url, { anchor, isCurrent }))
      .catch(error => { if (isCurrent()) options.onError?.(error); });
  };
  outer.addEventListener('click', click, true);
  return () => { disposed = true; outer.removeEventListener('click', click, true); };
}

// Crepe's link input confirms/cancels on Enter/Escape before host bubbling
// guards can see the event. Preserve the IME default, but keep its candidate
// keys away from that shortcut handler, including Safari's end-before-keydown.
export function installLinkCompositionGuard(outer, clock = globalThis) {
  const composing = new Set(), settling = new Map();
  let disposed = false;
  const ownedInput = event => {
    const input = event.target?.closest?.('.link-edit .input-area');
    return input && outer.contains(input) ? input : null;
  };
  const start = event => {
    const input = ownedInput(event); if (!input) return;
    if (settling.has(input)) clock.clearTimeout(settling.get(input));
    settling.delete(input); composing.add(input);
  };
  const end = event => {
    const input = ownedInput(event); if (!input) return;
    composing.delete(input);
    if (settling.has(input)) clock.clearTimeout(settling.get(input));
    const timer = clock.setTimeout(() => {
      if (!disposed && settling.get(input) === timer) settling.delete(input);
    }, 0);
    settling.set(input, timer);
  };
  const keydown = event => {
    if (!['Enter', 'Escape'].includes(event.key)) return;
    const input = ownedInput(event); if (!input) return;
    if (event.isComposing || event.keyCode === 229 || composing.has(input) || settling.has(input)) event.stopImmediatePropagation();
  };
  for (const [type, listener] of [['compositionstart', start], ['compositionend', end], ['keydown', keydown]]) outer.addEventListener(type, listener, true);
  return () => {
    disposed = true;
    for (const [type, listener] of [['compositionstart', start], ['compositionend', end], ['keydown', keydown]]) outer.removeEventListener(type, listener, true);
    for (const timer of settling.values()) clock.clearTimeout(timer);
    composing.clear(); settling.clear();
  };
}

/** An owned, offline Crepe surface. Persistence remains entirely with NoteEditor. */
export function mount(container, options = {}) {
  if (!container?.ownerDocument) throw new TypeError('可视编辑器需要一个独立 DOM 容器。');
  const document = container.ownerDocument;
  const outer = document.createElement('section');
  outer.className = 'document-visual-editor';
  outer.setAttribute('aria-label', '正文可视编辑器');
  const style = document.createElement('style');
  style.textContent = styles;
  const notice = document.createElement('div');
  notice.className = 'document-visual-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const noticeText = document.createElement('p');
  const sourceButton = document.createElement('button');
  sourceButton.type = 'button';
  sourceButton.className = 'document-visual-source-action';
  sourceButton.textContent = '使用 Markdown 源码';
  notice.append(noticeText, sourceButton);
  const editorRoot = document.createElement('div');
  editorRoot.className = 'document-visual-canvas';
  outer.append(style, notice, editorRoot);
  container.append(outer);

  const historyOwner = Symbol('visual-history');
  let destroyed = false, created = false, disabled = Boolean(options.disabled), composing = false;
  let engine, view, processor, baselineDoc, memoDoc, mappingDoc, mappingValue, mappingCache;
  let currentRaw = String(options.value ?? ''), parts = splitFrontmatter(currentRaw);
  let memoValue = currentRaw, lastNotified = currentRaw, supported = true, reason = '', applying = false;
  let timer = null, decorateQueued = false, pendingFocus = false, pendingSelection = null;
  const imageKey = new PluginKey('AI_BRO_IMAGE_UPLOADS');
  const picker = document.createElement('input');
  picker.type = 'file'; picker.accept = IMAGE_ACCEPT; picker.multiple = true; picker.hidden = true;
  picker.setAttribute('aria-label', '选择文档图片'); outer.append(picker);
  let pickerPosition = null;
  const uploads = createImageUploads({
    upload: options.onUploadImage,
    available: () => created && !destroyed && !disabled && supported && outer.isConnected,
    report, onBusy: count => options.onImageBusy?.(count),
    async settle() { while (!destroyed && !disabled && isComposing()) await new Promise(resolve => setTimeout(resolve, 20)); },
    capture(files, position) {
      const id = Symbol('image-upload');
      const pos = Number.isInteger(position) ? Math.max(0, Math.min(position, view.state.doc.content.size)) : view.state.selection.from;
      view.dispatch(view.state.tr.setMeta(imageKey, { add: { id, pos, count: files.length } }).setMeta('addToHistory', false));
      return id;
    },
    insert(id, images) {
      const entry = imageKey.getState(view.state)?.find(undefined, undefined, spec => spec.id === id)?.[0];
      if (!entry) return false;
      const imageType = view.state.schema.nodes['image-block'];
      if (!imageType) return false;
      // Canonical src belongs in document state; proxyDomURL only resolves DOM.
      const nodes = images.map(image => imageType.create({ src: image.url, caption: image.alt, ratio: 1 }));
      const at = view.state.doc.nodeAt(entry.from);
      const replacePlaceholder = at?.type === imageType && !at.attrs.src;
      const transaction = closeHistory(view.state.tr);
      if (replacePlaceholder) transaction.replaceWith(entry.from, entry.from + at.nodeSize, nodes);
      else transaction.insert(entry.from, nodes);
      view.dispatch(transaction.setMeta(imageKey, { remove: id }));
      notify();
      return true;
    },
    remove(id) {
      if (created && !destroyed && view && imageKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(imageKey, { remove: id }).setMeta('addToHistory', false));
    },
  });
  function insertImageFiles(files, position) { return isComposing() ? Promise.resolve(false) : uploads.insertFiles(files, position); }
  function chooseImages() {
    if (!created || destroyed || disabled || !supported || isComposing()) return false;
    if (typeof options.onUploadImage !== 'function') { report(Error('当前文档暂不支持保存本地图片。')); return false; }
    // Capture at picker activation; selection in the editor survives focus loss.
    pickerPosition = view.state.selection.from; picker.value = ''; picker.click(); return true;
  }
  const topCommands = new Map();
  const cleanups = [];
  const defer = (callback) => Promise.resolve().then(callback);

  function report(error) {
    if (destroyed) return;
    const issue = error instanceof Error ? error : new Error(String(error));
    options.onError?.(issue);
  }
  function status() {
    if (!destroyed) options.onStatus?.({ ready: created, supported, reason });
  }
  function setSupport(next, text = '') {
    supported = next; reason = text;
    outer.dataset.supported = String(next);
    notice.hidden = next;
    noticeText.textContent = text;
    editorRoot.hidden = !next;
    if (created) engine.setReadonly(disabled || !supported);
    status();
  }
  function getValue() {
    if (!created || destroyed || !supported || !view || !baselineDoc) return currentRaw;
    const doc = view.state.doc;
    if (doc === memoDoc) return memoValue;
    memoValue = doc.eq(baselineDoc) ? currentRaw : parts.prefix + engine.getMarkdown();
    memoDoc = doc;
    return memoValue;
  }
  function notify() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (destroyed || applying || !created || !supported) return;
    const value = getValue();
    if (value === lastNotified) return;
    lastNotified = value;
    options.onChange?.(value);
  }
  function changed() {
    memoDoc = null; mappingDoc = null;
    if (applying || destroyed || !created) return;
    options.onHistoryChange?.();
    // This timer coalesces host notifications only. State/getValue stay synchronous.
    if (timer === null) timer = setTimeout(notify, 60);
  }
  function on(target, type, listener, settings) {
    target.addEventListener(type, listener, settings);
    cleanups.push(() => target.removeEventListener(type, listener, settings));
  }
  function runTopCommand(key) {
    if (!created || destroyed || disabled || !supported || isComposing()) return false;
    const command = topCommands.get(key);
    if (!command) return false;
    try { engine.editor.action(command); return true; } catch (error) { report(error); return false; }
  }
  function decorate() {
    decorateQueued = false;
    if (destroyed) return;
    for (const button of outer.querySelectorAll('.top-bar-item')) {
      const key = button.querySelector('[data-document-command]')?.getAttribute('data-document-command');
      if (!key) continue;
      const label = commandLabels[key] || key;
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
      if (button.title !== label) button.title = label;
      button.setAttribute('aria-pressed', String(button.classList.contains('active')));
    }
    const heading = outer.querySelector('.top-bar-heading-button');
    if (heading) heading.setAttribute('aria-label', '段落与标题');
    for (const field of outer.querySelectorAll('.milkdown-image-block input[type="text"], .milkdown-image-inline input[type="text"]')) {
      field.setAttribute('aria-label', '图片链接地址');
    }
    for (const upload of outer.querySelectorAll('.milkdown-image-block .uploader, .milkdown-image-inline .uploader')) {
      upload.setAttribute('aria-disabled', String(disabled || typeof options.onUploadImage !== 'function'));
      upload.setAttribute('role', 'button'); upload.setAttribute('tabindex', '0');
      upload.setAttribute('aria-label', '选择本地图片'); upload.title = '选择 PNG、JPEG、GIF 或 WebP 图片';
    }
  }
  function queueDecorate() {
    if (destroyed || decorateQueued) return;
    decorateQueued = true;
    defer(decorate);
  }
  const Observer = document.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(queueDecorate) : null;
  observer?.observe(editorRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  on(picker, 'change', () => { void insertImageFiles(picker.files, pickerPosition); pickerPosition = null; picker.value = ''; });
  on(sourceButton, 'click', () => options.onRequestSource?.(selectionSource()));
  cleanups.push(installLinkCompositionGuard(outer));
  cleanups.push(installDocumentLinkNavigation(outer, { onOpenDocumentLink: options.onOpenDocumentLink, onError: options.onError,
    isAvailable: () => created && !destroyed && !disabled && !isComposing() }));
  on(outer, 'compositionstart', () => { composing = true; }, true);
  on(outer, 'compositionend', () => { composing = false; }, true);
  on(outer, 'click', (event) => {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (target?.closest('.milkdown-image-block .uploader, .milkdown-image-inline .uploader')) {
      event.preventDefault(); event.stopImmediatePropagation(); chooseImages(); return;
    }
    const button = target?.closest('.top-bar-item');
    if (button && event.detail === 0) {
      const key = button.querySelector('[data-document-command]')?.getAttribute('data-document-command');
      if (key) { event.preventDefault(); event.stopPropagation(); runTopCommand(key); }
    }
    // Upstream uses pointerdown only; keyboard/AX activation must run the same action.
    const selector = target?.closest('.top-bar-heading-option, .top-bar-heading-button');
    if (selector && event.detail === 0) {
      event.preventDefault();
      if (disabled || isComposing()) return;
      const EventType = document.defaultView?.PointerEvent || document.defaultView?.MouseEvent;
      if (EventType) selector.dispatchEvent(new EventType('pointerdown', { bubbles: true, cancelable: true }));
    }
    const anchor = target?.closest('a[href]');
    if (anchor && !safeDocumentUrl(anchor.getAttribute('href'))) event.preventDefault();
  }, true);
  on(outer, 'pointerdown', event => {
    if (event.target?.closest?.('.milkdown-image-block .uploader, .milkdown-image-inline .uploader')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  on(outer, 'keydown', event => {
    if (['Enter', ' '].includes(event.key) && event.target?.closest?.('.milkdown-image-block .uploader, .milkdown-image-inline .uploader')) {
      event.preventDefault(); event.stopImmediatePropagation(); chooseImages();
    }
  }, true);
  function receiveFiles(event) {
    const files = event.clipboardData?.files || event.dataTransfer?.files;
    if (!files?.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const position = event.type === 'drop' ? view?.posAtCoords({ left: event.clientX, top: event.clientY })?.pos : undefined;
    void insertImageFiles(files, position);
  }
  on(outer, 'paste', receiveFiles, true);
  on(outer, 'drop', receiveFiles, true);
  on(outer, 'dragover', event => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  }, true);

  function applyValue(value, opts = {}) {
    if (destroyed) return false;
    const next = String(value ?? '');
    if (created && supported && baselineDoc && next === getValue() && !opts.resetHistory) return true;
    if (isComposing()) return false;
    uploads.cancel();
    currentRaw = next; parts = splitFrontmatter(next); memoValue = next; memoDoc = null; mappingDoc = null;
    lastNotified = next;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!created) return true;
    try {
      const diagnostic = parts.supported ? diagnoseMarkdown(processor.parse(parts.body)) : parts;
      if (!diagnostic.supported) { setSupport(false, diagnostic.reason); return true; }
      applying = true;
      // A new host value has a new baseline; preserve history only when explicitly requested.
      engine.editor.action(replaceAll(parts.body, opts.preserveHistory !== true));
      view = engine.editor.action(ctx => ctx.get(editorViewCtx));
      // Settle upstream structural appenders (e.g. a paragraph after a final
      // table/code block) before choosing the pristine baseline. Otherwise a
      // later selection-only transaction could look like the first user edit.
      view.dispatch(view.state.tr.setMeta('addToHistory', false));
      baselineDoc = view.state.doc;
      memoDoc = baselineDoc; memoValue = next;
      setSupport(true);
      view.dom.setAttribute('aria-label', '正文 · 可视编辑');
      view.dom.setAttribute('aria-multiline', 'true');
      view.dom.setAttribute('role', 'textbox');
      queueDecorate();
      return true;
    } catch (error) {
      setSupport(false, '这份文档暂时无法使用可视编辑，原文已保留。请切换到 Markdown 源码。');
      report(error);
      return true; // The raw host value was accepted even when visual parsing failed.
    } finally { applying = false; }
  }
  function nativeHistory(direction) {
    if (!created || destroyed || disabled || !supported || isComposing() || uploads.isBusy()) return false;
    const okay = (direction === 'undo' ? undo : redo)(view.state, view.dispatch); if (okay) notify(); return okay;
  }
  function routeHistory(direction) {
    if (typeof options.onHistory === 'function') {
      if (!destroyed && !disabled && !isComposing()) options.onHistory(direction);
      return true;
    }
    return nativeHistory(direction);
  }
  function captureHistory() {
    return !created || destroyed || !supported ? null : {
      owner: historyOwner, state: view.state, value: getValue(), undo: undoDepth(view.state), redo: redoDepth(view.state), currentRaw, parts, baselineDoc
    };
  }
  function restoreHistory(checkpoint) {
    if (!created || destroyed || isComposing() || uploads.isBusy() || checkpoint?.owner !== historyOwner) return false;
    applying = true;
    try {
      if (timer !== null) clearTimeout(timer); timer = null;
      currentRaw = checkpoint.currentRaw; parts = checkpoint.parts; baselineDoc = checkpoint.baselineDoc;
      memoDoc = mappingDoc = null; lastNotified = checkpoint.value;
      view.updateState(checkpoint.state); setSupport(true); queueDecorate(); return true;
    } finally { applying = false; }
  }
  on(outer, 'keydown', event => {
    if (event.defaultPrevented || event.target?.closest?.('input,textarea') || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const direction = event.key.toLowerCase() === 'z' ? event.shiftKey ? 'redo' : 'undo' : event.key.toLowerCase() === 'y' ? 'redo' : null;
    if (direction && typeof options.onHistory === 'function') { event.preventDefault(); event.stopImmediatePropagation(); routeHistory(direction); }
  }, true);
  on(outer, 'beforeinput', event => {
    if (event.target?.closest?.('input,textarea') || !['historyUndo', 'historyRedo'].includes(event.inputType) || typeof options.onHistory !== 'function') return;
    event.preventDefault(); event.stopImmediatePropagation(); routeHistory(event.inputType === 'historyUndo' ? 'undo' : 'redo');
  }, true);
  function isComposing() { return !destroyed && Boolean(composing || view?.composing); }
  function mappings() {
    const value = getValue();
    if (!supported || !view || !processor) return [];
    if (mappingDoc === view.state.doc && mappingValue === value) return mappingCache;
    const source = splitFrontmatter(value);
    const leaves = [];
    view.state.doc.descendants((node, pos) => { if (node.isText) leaves.push({ pos, text: node.text }); });
    mappingCache = sourceTextMappings(source.body, processor.parse(source.body), leaves, source.prefix.length);
    mappingDoc = view.state.doc; mappingValue = value;
    return mappingCache;
  }
  function selectionSource() {
    const value = getValue();
    const fallback = { start: 0, end: 0, exact: false, value, direction: 'none', reason: '请在 Markdown 源码中重新选择，以准确定位原文。' };
    if (!created || destroyed || !supported || !view) return fallback;
    const { from, to, anchor, head } = view.state.selection;
    const direction = anchor > head ? 'backward' : anchor < head ? 'forward' : 'none';
    const map = mappings();
    const start = mapProsePosition(map, from, 1), end = mapProsePosition(map, to, -1);
    if (start === null || end === null || start > end) return { ...fallback, direction };
    const selected = view.state.doc.textBetween(from, to, '\n', '\uFFFC');
    if (value.slice(start, end) !== selected) return { ...fallback, start, end, direction };
    return { start, end, exact: true, value, direction };
  }
  function setSelectionRange(rawStart, rawEnd = rawStart, direction = 'forward') {
    if (destroyed || isComposing()) return false;
    if (!created) { pendingSelection = [rawStart, rawEnd, direction]; return true; }
    if (!supported || !view) return false;
    const value = getValue();
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawStart < 0 || rawEnd < rawStart || rawEnd > value.length) return false;
    const map = mappings();
    const from = mapSourcePosition(map, rawStart, 1), to = mapSourcePosition(map, rawEnd, -1);
    if (from === null || to === null || from > to || view.state.doc.textBetween(from, to, '\n', '\uFFFC') !== value.slice(rawStart, rawEnd)) return false;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, direction === 'backward' ? to : from, direction === 'backward' ? from : to)));
    return true;
  }
  function focus() {
    if (destroyed || disabled) return;
    if (!created) { pendingFocus = true; return; }
    if (supported) view?.focus(); else sourceButton.focus();
  }
  function setDisabled(value) {
    if (destroyed) return;
    disabled = Boolean(value);
    if (disabled && uploads.isBusy()) uploads.cancel();
    sourceButton.disabled = disabled;
    if (created) engine.setReadonly(disabled || !supported);
    outer.setAttribute('aria-disabled', String(disabled));
  }
  function outline() {
    if (!created || destroyed || !supported || !view) return [];
    const headings = [], map = mappings();
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'heading') return;
      headings.push({ text: node.textContent, level: Number(node.attrs.level) || 1, pos,
        start: mapProsePosition(map, pos + 1, 1), end: mapProsePosition(map, pos + 1 + node.content.size, -1) });
    });
    return headings;
  }
  async function flushPending() {
    if (destroyed || isComposing()) return false;
    if (!created) await ready;
    if (destroyed || isComposing()) return false;
    if (!await uploads.flush() || destroyed || isComposing()) return false;
    notify();
    return true;
  }
  function destroy() {
    if (destroyed) return;
    // Keep a last synchronous value available to the host after unmount.
    currentRaw = getValue();
    uploads.destroy();
    destroyed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    observer?.disconnect();
    for (const cleanup of cleanups) cleanup();
    outer.remove();
    if (created) return engine.destroy();
    // The ready continuation tears down an in-flight create without publishing it.
  }

  engine = new CrepeBuilder({ root: editorRoot, defaultValue: '' })
    .addFeature(cursor)
    .addFeature(listItem)
    .addFeature(linkTooltip, { inputPlaceholder: '粘贴链接地址…' })
    .addFeature(imageBlock, {
      // Local file gestures are intercepted above; never let upstream serialize
      // object URLs or leave a rejected-upload placeholder in the document.
      onUpload: async () => '',
      proxyDomURL: url => {
        if (!safeDocumentUrl(url, { image: true })) return '';
        const resolved = options.resolveImageUrl ? options.resolveImageUrl(url) : url;
        return typeof resolved === 'string' && safeDocumentUrl(resolved, { image: true }) ? resolved : '';
      },
      inlineUploadButton: plainIcon('＋'), blockUploadButton: '选择图片',
      inlineUploadPlaceholderText: '或填写图片链接', blockUploadPlaceholderText: '或填写图片链接',
      blockCaptionPlaceholderText: '图片说明', blockConfirmButton: '插入',
      onImageLoadError: () => report(new Error('图片暂时无法显示，链接仍保留，可继续编辑。')),
    })
    .addFeature(placeholder, { text: '开始写作，输入 / 插入内容…', mode: 'doc' })
    .addFeature(codeMirror, { languages, theme: codeTheme, searchPlaceholder: '搜索代码语言…', noResultText: '没有匹配的语言', copyText: '复制代码', previewToggleText: hidden => hidden ? '编辑' : '收起源码' })
    .addFeature(table)
    .addFeature(latex)
    .addFeature(toolbar, { boldLabel: '粗体', italicLabel: '斜体', strikethroughLabel: '删除线', codeLabel: '行内代码', linkLabel: '链接', latexLabel: '行内公式' })
    .addFeature(blockEdit, {
      textGroup: { label: '正文', text: { label: '段落' }, h1: { label: '标题 1' }, h2: { label: '标题 2' }, h3: { label: '标题 3' }, h4: { label: '标题 4' }, h5: { label: '标题 5' }, h6: { label: '标题 6' }, quote: { label: '引用' }, divider: { label: '分隔线' } },
      listGroup: { label: '列表', bulletList: { label: '无序列表' }, orderedList: { label: '有序列表' }, taskList: { label: '任务列表' } },
      advancedGroup: { label: '插入', image: { label: '图片' }, codeBlock: { label: '代码块' }, table: { label: '表格' }, math: { label: '数学公式' } },
    })
    .addFeature(topBar, {
      headingOptions: [{ label: '正文', level: null }, ...[1, 2, 3, 4, 5, 6].map(level => ({ label: `标题 ${level}`, level }))],
      buildTopBar(builder) {
        builder.addGroup('history', '历史')
          .addItem('undo', { icon: plainIcon('↶'), active: () => false, onRun: ctx => { const current = ctx.get(editorViewCtx); routeHistory('undo'); current.focus(); } })
          .addItem('redo', { icon: plainIcon('↷'), active: () => false, onRun: ctx => { const current = ctx.get(editorViewCtx); routeHistory('redo'); current.focus(); } });
        for (const group of builder.build()) for (const item of group.items) {
          if (!item.onRun) continue;
          if (item.key === 'image' && typeof options.onUploadImage === 'function') item.onRun = () => chooseImages();
          topCommands.set(item.key, item.onRun);
          item.icon = `<span data-document-command="${item.key}">${item.icon}</span>`;
        }
      },
    });
  engine.editor.config(ctx => {
    // Remark represents an omitted image title as null. Crepe 7.22.2 forwards
    // that null into a caption attribute validated as string, which breaks a
    // normal ![alt](url) on the next edit/readonly transaction. Adapt only this
    // parser boundary; preserve source bytes, named titles and resize behavior.
    ctx.update(imageBlockSchema.key, getSchema => context => {
      const schema = getSchema(context);
      return { ...schema, parseMarkdown: { ...schema.parseMarkdown,
        runner: (state, node, type) => schema.parseMarkdown.runner(state,
          { ...node, title: typeof node.title === 'string' ? node.title : '' }, type),
      } };
    });
    ctx.update(prosePluginsCtx, plugins => [...plugins, new Plugin({
      key: imageKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, previous) {
          let next = previous.map(tr.mapping, tr.doc);
          const action = tr.getMeta(imageKey);
          if (action?.add) {
            const { id, pos, count } = action.add;
            next = next.add(tr.doc, [Decoration.widget(pos, () => {
              const loading = document.createElement('span');
              loading.className = 'document-image-upload'; loading.setAttribute('role', 'status');
              loading.textContent = `正在保存 ${count} 张图片…`;
              return loading;
            }, { id, side: 1 })]);
          }
          if (action?.remove) next = next.remove(next.find(undefined, undefined, spec => spec.id === action.remove));
          return next;
        },
      },
      props: { decorations: state => imageKey.getState(state) },
    }), new Plugin({
      key: new PluginKey('AI_BRO_DOCUMENT_STATE'),
      view(initialView) {
        view = initialView;
        return { update(nextView, previousState) {
          view = nextView;
          if (!nextView.state.doc.eq(previousState.doc)) changed();
          queueDecorate();
        } };
      },
    })]);
  });

  const ready = (async () => {
    try {
      await engine.create();
      if (destroyed) { await engine.destroy(); return false; }
      created = true;
      view = engine.editor.action(ctx => ctx.get(editorViewCtx));
      view.dom.setAttribute('data-aibro-file-drop-owner', 'document-image');
      view.dom.aibroCanReceiveFileDrop = () => created && !destroyed && !disabled && supported && !isComposing() && typeof options.onUploadImage === 'function';
      processor = engine.editor.action(ctx => ctx.get(remarkCtx));
      applyValue(currentRaw);
      setDisabled(disabled);
      if (pendingSelection) { setSelectionRange(...pendingSelection); pendingSelection = null; }
      if (pendingFocus) focus();
      return supported;
    } catch (error) {
      try { await engine.destroy(); } catch { /* Preserve the original creation error. */ }
      created = false;
      if (!destroyed) {
        setSupport(false, '可视编辑器未能加载，原文已保留。请使用 Markdown 源码。');
        report(error);
      }
      return false;
    }
  })();
  status();
  return { ready, captureHistory, restoreHistory, historyDepth: () => ({ undo: view ? undoDepth(view.state) : 0, redo: view ? redoDepth(view.state) : 0 }), undo: () => nativeHistory('undo'), redo: () => nativeHistory('redo'), getValue, setValue: applyValue, setDisabled, selectionSource, setSelectionRange, focus, destroy, flushPending, isComposing, outline, insertImageFiles, isImageBusy: uploads.isBusy };
}
