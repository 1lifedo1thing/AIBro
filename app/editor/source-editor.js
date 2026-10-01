import { EditorState, EditorSelection, StateField, StateEffect, Compartment, Transaction, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, highlightActiveLine } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, invertedEffects, undo, redo, undoDepth, redoDepth, indentMore, indentLess, indentSelection, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { css as cssLanguage } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, LanguageDescription, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import Raw from './raw-text.js';
import { createImageUploads, imageMarkdown } from './image-uploads.mjs';
import { imageAnchors, imageAnchorChange } from './source-image-anchors.mjs';
import css from './source-editor.css';

const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading, class: 'source-token-heading' }, { tag: tags.strong, class: 'source-token-strong' },
  { tag: tags.emphasis, class: 'source-token-emphasis' }, { tag: tags.strikethrough, class: 'source-token-strike' },
  { tag: tags.link, class: 'source-token-link' }, { tag: tags.url, class: 'source-token-url' },
  { tag: [tags.meta, tags.comment, tags.processingInstruction], class: 'source-token-muted' },
  { tag: [tags.keyword, tags.tagName], class: 'source-token-keyword' },
  { tag: [tags.string, tags.literal, tags.inserted], class: 'source-token-string' },
  { tag: [tags.number, tags.bool, tags.atom], class: 'source-token-number' },
  { tag: [tags.typeName, tags.definition(tags.variableName)], class: 'source-token-definition' },
  { tag: [tags.deleted, tags.invalid], class: 'source-token-invalid' }
]);
// Ship only these common code parsers, never the entire language-data catalog.
const codeLanguages = [
  ['JavaScript', ['js', 'jsx'], javascript({ jsx: true })],
  ['TypeScript', ['ts', 'tsx'], javascript({ typescript: true, jsx: true })],
  ['Python', ['py'], python()], ['JSON', ['json'], json()]
].map(([name, alias, support]) => LanguageDescription.of({ name, alias, support }));
export function sourceLanguage(filename) {
  // Notes have no filename and default to Markdown. Unknown actual file types
  // retain plain text rather than interpreting source code as Markdown.
  const extension = String(filename || '').split('.').at(-1).toLowerCase();
  if (!filename || ['md', 'markdown', 'mdx'].includes(extension)) return markdown({ base: markdownLanguage, codeLanguages });
  if (['js', 'mjs', 'cjs', 'jsx'].includes(extension)) return javascript({ jsx: extension === 'jsx' });
  if (['ts', 'tsx'].includes(extension)) return javascript({ typescript: true, jsx: extension === 'tsx' });
  if (extension === 'py') return python();
  if (extension === 'json') return json();
  if (extension === 'css') return cssLanguage();
  if (['html', 'htm'].includes(extension)) return html();
  return [];
}
const chinesePhrases = {
  Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全选',
  'match case': '区分大小写', regexp: '正则表达式', 'by word': '全词匹配',
  replace: '替换', 'replace all': '全部替换', close: '关闭',
  'Fold line': '折叠此段', 'Unfold line': '展开此段', 'Go to line': '跳转到行', go: '跳转',
  'current match': '当前匹配', 'on line': '所在行', 'replaced match on line $': '已替换第 $ 行的匹配', 'replaced $ matches': '已替换 $ 处匹配'
};

// History stores only line-ending metadata, not another full document snapshot.
// The last effect is the oldest state when CodeMirror groups typing events.
const restoreLineEndings = StateEffect.define();
const replaceRaw = StateEffect.define();
export const rawDocument = StateField.define({
  create: state => Raw.create(state.doc.toString()),
  update(before, transaction) {
    const replacement = transaction.effects.filter(effect => effect.is(replaceRaw)).at(-1);
    if (replacement) {
      if (Raw.display(replacement.value) !== transaction.newDoc.toString()) throw Error('Source replacement does not match the editor document');
      return Raw.create(replacement.value);
    }
    const restored = transaction.effects.filter(effect => effect.is(restoreLineEndings)).at(-1);
    if (restored) return Raw.create(Raw.restoreEndings(transaction.newDoc.toString(), restored.value.endings, restored.value.bom), { bom: restored.value.bom });
    return transaction.docChanged ? Raw.applyChanges(before, transaction.changes) : before;
  }
});
const rawHistory = invertedEffects.of(transaction => {
  const before = transaction.startState.field(rawDocument), after = transaction.state.field(rawDocument);
  // Balanced multiline replacements still need their old exact separators.
  // Ordinary single-line typing does not: avoid retaining one full endings
  // array per keystroke inside a grouped native history event.
  let crossesLine = false;
  if (transaction.docChanged) transaction.changes.iterChangedRanges((from, to, fromB, toB) => {
    if (transaction.startState.doc.lineAt(from).number !== transaction.startState.doc.lineAt(to).number ||
        transaction.newDoc.lineAt(fromB).number !== transaction.newDoc.lineAt(toB).number) crossesLine = true;
  });
  return crossesLine || before.bom !== after.bom || before.endings.length !== after.endings.length || before.endings.some((value, i) => value !== after.endings[i]) ? [restoreLineEndings.of({ endings: before.endings, bom: before.bom })] : [];
});
export function createSourceState(value, extensions = []) {
  const raw = String(value ?? '');
  return EditorState.create({ doc: Raw.display(raw), extensions: [rawDocument.init(() => Raw.create(raw)), history(), rawHistory, ...extensions] });
}
export function replaceSourceValue(state, value) {
  const raw = String(value ?? '');
  return state.update({ changes: { from: 0, to: state.doc.length, insert: Raw.display(raw) }, effects: replaceRaw.of(raw), annotations: [Transaction.userEvent.of('input.replace'), isolateHistory.of('full')] });
}
function installStyles(document) {
  if (document.getElementById('document-source-editor-style')) return;
  const style = document.createElement('style'); style.id = 'document-source-editor-style'; style.textContent = css; document.head.append(style);
}
export function mount(container, options = {}) {
  if (!container?.ownerDocument) throw Error('Source editor needs a document container');
  const document = container.ownerDocument; installStyles(document);
  const shell = document.createElement('div'); shell.className = 'document-source-editor'; container.append(shell);
  const historyOwner = Symbol('source-history');
  const editable = new Compartment(); let disabled = !!options.disabled, destroyed = false, silent = 0, composing = false, settling = false, settleTimer = null, view;
  const editableConfig = () => [EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)];
  const english = () => document.documentElement.lang?.startsWith('en');
  const report = error => options.onError?.(error instanceof Error ? error : Error(String(error)));
  const status = () => options.onStatus?.(english() ? disabled ? 'Read only' : composing || settling ? 'Composing text…' : 'Source editor ready' : disabled ? '只读' : composing || settling ? '正在组合输入…' : '源码编辑器已就绪');
  const raw = () => view.state.field(rawDocument);
  function selectionSource() {
    if (destroyed || !view) return null;
    const main = view.state.selection.main, value = raw();
    return { start: Raw.toRaw(value, main.from), end: Raw.toRaw(value, main.to), exact: true, value: value.raw, direction: main.anchor > main.head ? 'backward' : main.empty ? 'none' : 'forward' };
  }
  const uploads = createImageUploads({
    upload: options.onUploadImage,
    available: () => !destroyed && !disabled && !!view && shell.isConnected,
    report, onBusy: count => options.onImageBusy?.(count),
    async settle() { while (!destroyed && !disabled && isComposing()) await new Promise(resolve => setTimeout(resolve, 20)); },
    capture(files, position) {
      const id = Symbol('source-image-upload');
      const pos = Number.isInteger(position) ? Math.max(0, Math.min(position, view.state.doc.length)) : view.state.selection.main.from;
      view.dispatch({ effects: imageAnchorChange.of({ add: { id, pos, count: files.length } }) });
      return id;
    },
    insert(id, images) {
      const anchor = view.state.field(imageAnchors).get(id);
      if (!anchor) return false;
      const { pos } = anchor;
      const prefix = pos > 0 && view.state.sliceDoc(Math.max(0, pos - 2), pos) !== '\n\n' ? '\n\n' : '';
      const suffix = pos < view.state.doc.length && view.state.sliceDoc(pos, pos + 2) !== '\n\n' ? '\n\n' : '';
      view.dispatch({ changes: { from: pos, insert: prefix + imageMarkdown(images) + suffix },
        effects: imageAnchorChange.of({ remove: id }),
        annotations: [Transaction.userEvent.of('input.image'), isolateHistory.of('full')] });
      return true;
    },
    remove(id) { if (!destroyed && view) view.dispatch({ effects: imageAnchorChange.of({ remove: id }) }); },
  });
  function insertImageFiles(files, position) { return isComposing() ? Promise.resolve(false) : uploads.insertFiles(files, position); }
  const extensions = [
    imageAnchors, editable.of(editableConfig()),
    EditorState.phrases.of(english() ? {} : chinesePhrases),
    EditorState.allowMultipleSelections.of(true), lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), drawSelection(), dropCursor(), rectangularSelection(),
    indentOnInput(), bracketMatching(), foldGutter(), highlightActiveLine(), syntaxHighlighting(sourceHighlight), sourceLanguage(options.filename), search({ top: true }), highlightSelectionMatches(),
    // Tab retains native focus navigation. Indentation uses explicit familiar
    // shortcuts; Markdown's Enter/Backspace handling remains CodeMirror-owned.
    Prec.high(keymap.of([{ key: 'Mod-z', run: () => routeHistory('undo') }, { key: 'Mod-Shift-z', run: () => routeHistory('redo') }, { key: 'Mod-y', run: () => routeHistory('redo') }])),
    keymap.of([...defaultKeymap.filter(binding => binding.key !== 'Tab' && binding.key !== 'Shift-Tab'), ...historyKeymap, ...searchKeymap, ...foldKeymap,
      { key: 'Mod-]', run: indentMore }, { key: 'Mod-[', run: indentLess }, { key: 'Mod-Alt-\\', run: indentSelection }]),
    EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel || (english() ? 'Markdown source' : 'Markdown 源码'), 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    EditorView.exceptionSink.of(report),
    Prec.high(EditorView.domEventHandlers({
      paste(event) {
        if (!event.clipboardData?.files?.length || typeof options.onUploadImage !== 'function') return false;
        event.preventDefault(); event.stopPropagation(); void insertImageFiles(event.clipboardData.files); return true;
      },
      drop(event) {
        if (!event.dataTransfer?.files?.length || typeof options.onUploadImage !== 'function') return false;
        event.preventDefault(); event.stopPropagation();
        void insertImageFiles(event.dataTransfer.files, view.posAtCoords({ x: event.clientX, y: event.clientY })); return true;
      },
      dragover(event) {
        if (typeof options.onUploadImage === 'function' && Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); return true; }
        return false;
      },
      compositionstart() { clearTimeout(settleTimer); settling = false; composing = true; status(); return false; },
      compositionend() {
        composing = false; settling = true;
        // The final input and MutationObserver commit may follow this event.
        // Do not let a save or a view switch consume the earlier document.
        clearTimeout(settleTimer); settleTimer = setTimeout(() => { settling = false; if (!destroyed) status(); }, 0);
        return false;
      },
      keydown(event) {
        // A parent dialog must not close before CodeMirror's search panel uses
        // Escape, and app-wide handlers must not replace editor undo/find.
        if ((event.metaKey || event.ctrlKey) && /^(?:f|g|z|y|\[|\])$/i.test(event.key)) event.stopPropagation();
        if (event.key === 'Escape' && view?.dom.querySelector('.cm-search')) event.stopPropagation();
        return false;
      }
    })),
    EditorView.updateListener.of(update => {
      if (destroyed || silent) return;
      const before = update.startState.field(rawDocument).raw, after = update.state.field(rawDocument).raw;
      if (before !== after) options.onHistoryChange?.();
      if (before !== after) options.onChange?.(after, { selection: selectionSource(), origin: update.transactions.some(tr => tr.isUserEvent('undo')) ? 'undo' : update.transactions.some(tr => tr.isUserEvent('redo')) ? 'redo' : 'input' });
    })
  ];
  const freshState = value => createSourceState(value, extensions).update({ effects: editable.reconfigure(editableConfig()) }).state;
  try { view = new EditorView({ state: freshState(options.value), parent: shell }); }
  catch (error) { shell.remove(); report(error); throw error; }
  view.contentDOM.setAttribute('data-aibro-file-drop-owner', 'document-image');
  view.contentDOM.aibroCanReceiveFileDrop = () => !destroyed && !disabled && !isComposing() && typeof options.onUploadImage === 'function';
  shell.dataset.disabled = String(disabled); status();
  function isComposing() { return !destroyed && (composing || settling || !!view.compositionStarted); }
  function setSelectionRange(start, end = start, direction = 'forward') {
    if (destroyed) return false;
    const value = raw(), from = Raw.toDisplay(value, start, -1), to = start === end ? from : Raw.toDisplay(value, end, 1);
    view.dispatch({ selection: EditorSelection.single(direction === 'backward' ? to : from, direction === 'backward' ? from : to), scrollIntoView: true }); return true;
  }
  function setValue(value, opts = {}) {
    if (destroyed) return false;
    const next = String(value ?? ''); if (next === raw().raw && !opts.resetHistory) return true;
    if (isComposing()) return false;
    uploads.cancel();
    const old = selectionSource(); silent++;
    try {
      if (opts.addToHistory === true) view.dispatch(replaceSourceValue(view.state, next));
      else view.setState(freshState(next));
      const selected = opts.selection || old;
      if (selected) setSelectionRange(Math.min(next.length, selected.start ?? 0), Math.min(next.length, selected.end ?? selected.start ?? 0), selected.direction);
      view.requestMeasure(); return true;
    } finally { silent--; }
  }
  function routeHistory(direction) {
    if (typeof options.onHistory !== 'function') return false;
    if (!destroyed && !disabled && !isComposing()) options.onHistory(direction);
    return true;
  }
  shell.addEventListener('beforeinput', event => {
    if (!['historyUndo', 'historyRedo'].includes(event.inputType) || !view.contentDOM.contains(event.target)) return;
    if (routeHistory(event.inputType === 'historyUndo' ? 'undo' : 'redo')) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  function captureHistory() { return destroyed ? null : { owner: historyOwner, state: view.state, value: raw().raw, undo: undoDepth(view.state), redo: redoDepth(view.state) }; }
  function restoreHistory(checkpoint) {
    if (destroyed || isComposing() || uploads.isBusy() || checkpoint?.owner !== historyOwner) return false;
    silent++;
    try { view.setState(checkpoint.state); view.dispatch({ effects: editable.reconfigure(editableConfig()) }); view.requestMeasure(); return true; }
    finally { silent--; }
  }
  function setDisabled(value) {
    if (destroyed || disabled === !!value) return;
    disabled = !!value; if (disabled) uploads.cancel(); view.dispatch({ effects: editable.reconfigure(editableConfig()) }); shell.dataset.disabled = String(disabled); status();
  }
  function outline() {
    if (destroyed) return [];
    const result = [], value = raw();
    syntaxTree(view.state).iterate({ enter(node) {
      const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name); if (!match) return;
      const start = Raw.toRaw(value, node.from), end = Raw.toRaw(value, node.to);
      result.push({ level: Number(match[1]), start, end, text: view.state.sliceDoc(node.from, node.to).replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').split('\n')[0] });
    } });
    return result;
  }
  const handle = {
    ready: Promise.resolve(true), captureHistory, restoreHistory, historyDepth: () => ({ undo: undoDepth(view.state), redo: redoDepth(view.state) }), getValue: () => raw().raw, setValue, setDisabled, selectionSource, setSelectionRange,
    focus() { if (!destroyed) view.focus(); }, isComposing, insertImageFiles, isImageBusy: uploads.isBusy,
    async flushPending() {
      if (destroyed || isComposing()) return false;
      if (!await uploads.flush() || destroyed || isComposing()) return false;
      // Yield a task, not just a microtask: browser input and CodeMirror's DOM
      // observer must finish before the host reads the value for persistence.
      await new Promise(resolve => setTimeout(resolve, 0)); if (destroyed || isComposing()) return false;
      return true;
    },
    find() { return !destroyed && openSearchPanel(view); }, outline,
    undo() { return !destroyed && !disabled && !isComposing() && undo(view); },
    redo() { return !destroyed && !disabled && !isComposing() && redo(view); },
    requestMeasure() { if (!destroyed) view.requestMeasure(); },
    destroy() { if (destroyed) return; uploads.destroy(); destroyed = true; composing = false; settling = false; clearTimeout(settleTimer); view.destroy(); shell.remove(); }
  };
  return handle;
}

export default { mount };
