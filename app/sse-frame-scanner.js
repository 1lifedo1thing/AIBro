/* Incremental SSE boundaries. This bounds fragment metadata and avoids
 * rescanning an unfinished frame; the frame's actual content is not truncated. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SSEFrameScanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const BLOCK = 16384;
  function create({ onFrame }) {
    if (typeof onFrame !== 'function') throw new TypeError('SSE frame callback is required.');
    let blocks = [], tail = '', length = 0, lineLength = 0, pendingCR = false, ended = false;
    let characters = 0, frames = 0;
    function append(value) {
      length += value.length;
      let offset = 0;
      if (tail) {
        const count = Math.min(BLOCK - tail.length, value.length);
        tail += value.slice(0, count); offset = count;
        if (tail.length === BLOCK) { blocks.push(tail); tail = ''; }
      }
      while (offset + BLOCK <= value.length) { blocks.push(value.slice(offset, offset + BLOCK)); offset += BLOCK; }
      if (offset < value.length) tail = value.slice(offset);
    }
    function emit() {
      if (!length) return;
      if (tail) blocks.push(tail);
      const frame = blocks.join('');
      blocks = []; tail = ''; length = 0; frames++;
      onFrame(frame);
    }
    function push(value) {
      if (ended) throw new Error('The SSE frame scanner has ended.');
      if (typeof value !== 'string') throw new TypeError('SSE input must be decoded text.');
      characters += value.length;
      if (!value.length) return;
      let start = 0;
      if (pendingCR) { if (value.charCodeAt(0) === 10) start = 1; pendingCR = false; }
      // Search only the new chunk. A line's preceding content never enters
      // this loop again, even when a provider splits one data line byte by byte.
      const endings = /[\r\n]/g; endings.lastIndex = start;
      let match;
      while ((match = endings.exec(value))) {
        const segment = value.slice(start, match.index);
        append(segment); lineLength += segment.length;
        if (lineLength === 0) emit();
        else { append('\n'); lineLength = 0; }
        start = match.index + 1;
        if (match[0] === '\r') {
          if (value.charCodeAt(start) === 10) start++;
          else if (start === value.length) pendingCR = true;
        }
        endings.lastIndex = start;
      }
      const remainder = value.slice(start);
      append(remainder); lineLength += remainder.length;
    }
    function finish() {
      if (ended) return;
      ended = true; pendingCR = false; lineLength = 0; emit();
    }
    return { push, finish, inspect: () => ({ bufferedCharacters: length, fragments: blocks.length + (tail ? 1 : 0), scannedCharacters: characters, frames, ended }) };
  }
  return { create };
});
