/* Continuation of a fence already recognized by renderRichText. This module
 * never identifies Markdown blocks or changes the final renderer's grammar. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StreamCode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const CHUNK = 32768;
  const initialLine = () => ({ phase: 'indent', spaces: 0, marks: 0 });
  function feed(line, value, marker) {
    const next = { ...line };
    for (const char of value) {
      if (next.phase === 'invalid') break;
      if (next.phase === 'indent') {
        if (char === ' ' && ++next.spaces <= 3) continue;
        if (char === marker[0]) { next.phase = 'markers'; next.marks = 1; continue; }
      } else if (next.phase === 'markers') {
        if (char === marker[0]) { next.marks++; continue; }
        if (char === ' ' || char === '\t') { next.phase = 'space'; continue; }
      } else if (next.phase === 'space' && (char === ' ' || char === '\t')) continue;
      next.phase = 'invalid';
    }
    return next;
  }
  const closing = (line, marker) => line.phase !== 'invalid' && line.marks >= marker.length;
  function seed(fence, raw) {
    if (!fence || typeof raw !== 'string') return null;
    const tailStart = Math.max(raw.lastIndexOf('\n'), raw.lastIndexOf('\r')) + 1;
    return { raw, marker: fence.marker, line: feed(initialLine(), fence.tailLine, fence.marker),
      tailLength: fence.tailLine.length, tailStart, separator: fence.tailHasSeparator,
      codeLength: fence.codeLength, trailingCR: raw.endsWith('\r') };
  }
  function advance(before, raw) {
    if (!before || typeof raw !== 'string' || !raw.startsWith(before.raw)) return null;
    const state = { ...before, line: { ...before.line }, raw }, edits = [];
    let cursor = before.raw.length;
    // Tool/status frames can render the same text between the two bytes of a
    // CRLF. They must not consume the pending CR delimiter.
    if (cursor === raw.length) return { state, edits, scannedCharacters: 0, validatedCharacters: before.raw.length };
    // A trailing CR already emitted one LF. Its later LF is the second half of
    // that same delimiter, not an extra blank code line.
    if (state.trailingCR && raw[cursor] === '\n') { cursor++; state.tailStart = cursor; }
    state.trailingCR = false;
    const append = value => { if (value) { edits.push({ append: value }); state.codeLength += value.length; } };
    while (cursor < raw.length) {
      let end = cursor;
      while (end < raw.length && raw[end] !== '\r' && raw[end] !== '\n') end++;
      const part = raw.slice(cursor, end), wasClosing = closing(state.line, state.marker);
      state.line = feed(state.line, part, state.marker);
      const nowClosing = closing(state.line, state.marker);
      if (nowClosing && !wasClosing) {
        const removed = state.tailLength + (state.separator ? 1 : 0);
        if (removed) { edits.push({ remove: removed }); state.codeLength -= removed; }
      } else if (!nowClosing && wasClosing) {
        append((state.separator ? '\n' : '') + raw.slice(state.tailStart, end));
      } else if (!nowClosing) append(part);
      state.tailLength += part.length;
      cursor = end;
      if (cursor < raw.length) {
        // A complete closing line establishes a new Markdown boundary. The
        // canonical parser handles it and everything after it in one pass.
        if (nowClosing) return null;
        const cr = raw[cursor] === '\r'; cursor++;
        if (cr && raw[cursor] === '\n') cursor++;
        else if (cr && cursor === raw.length) state.trailingCR = true;
        append('\n'); state.line = initialLine(); state.tailLength = 0;
        state.tailStart = cursor; state.separator = true;
      }
    }
    return { state, edits, scannedCharacters: raw.length - before.raw.length, validatedCharacters: before.raw.length };
  }
  function textNodes(element) {
    const result = [], walker = element.ownerDocument.createTreeWalker(element, 4); let node;
    while ((node = walker.nextNode())) result.push(node);
    return result;
  }
  function endpoint(element, node, offset) {
    if (!element.contains(node)) return null;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element); range.setEnd(node, offset);
    return range.toString().length;
  }
  function capture(element, selection) {
    if (!selection) return null;
    const anchor = endpoint(element, selection.anchor, selection.anchorOffset);
    const focus = endpoint(element, selection.focus, selection.focusOffset);
    return anchor === null && focus === null ? null : { anchor, focus };
  }
  function locate(element, offset) {
    const nodes = textNodes(element); let left = Math.max(0, offset);
    for (const node of nodes) { if (left <= node.length) return { node, offset: left }; left -= node.length; }
    const last = nodes.at(-1); return last ? { node: last, offset: last.length } : { node: element, offset: 0 };
  }
  function restore(element, selection, saved) {
    if (!selection || !saved) return;
    for (const key of ['anchor', 'focus']) if (saved[key] !== null) {
      const value = locate(element, saved[key]); selection[key] = value.node; selection[key + 'Offset'] = value.offset;
    }
  }
  function apply(code, edits, selection) {
    // A bounded Text node size avoids repeatedly extending one enormous DOM
    // string. Nodes are not made per token; append fills the last chunk first.
    for (const edit of edits) {
      if (edit.remove) {
        let left = edit.remove;
        while (left > 0 && code.lastChild) {
          const node = code.lastChild, count = Math.min(left, node.length);
          node.deleteData(node.length - count, count); left -= count;
          if (!node.length && code.childNodes.length > 1) node.remove();
          else if (!count) return false;
        }
        if (left) return false;
      } else {
        let cursor = 0;
        while (cursor < edit.append.length) {
          let node = code.lastChild;
          if (!node || node.length >= CHUNK) { node = code.ownerDocument.createTextNode(''); code.append(node); }
          const part = edit.append.slice(cursor, cursor + CHUNK - node.length);
          node.appendData(part); cursor += part.length;
        }
      }
    }
    // Retain explicit endpoint offsets. Browser Range auto-adjustment can
    // expand a selection or move a caret at the previous end on append.
    if (selection) for (const key of ['anchor', 'focus']) {
      const node = selection[key];
      if (node?.isConnected && code.contains(node) && node.nodeType === 3) selection[key + 'Offset'] = Math.min(selection[key + 'Offset'], node.length);
    }
    return true;
  }
  return { seed, advance, apply, capture, restore, textNodes, CHUNK };
});
