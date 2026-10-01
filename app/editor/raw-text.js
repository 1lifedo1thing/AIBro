/* CodeMirror coordinates are LF-normalized UTF-16 offsets without the file
 * BOM. The saved document retains its BOM and every untouched line ending. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DocumentRawText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const normalize = value => String(value ?? '').replace(/\r\n?/g, '\n');
  const display = value => typeof value === 'string' ? normalize(value).replace(/^\ufeff/, '') : normalize(value.raw).slice(value.bom);
  const lowerBound = (values, value) => { let lo = 0, hi = values.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < value) lo = mid + 1; else hi = mid; } return lo; };
  function create(value, options = {}) {
    const raw = String(value ?? ''), endings = [], positions = [], crlfRaw = [], crlfDisplay = [];
    const bom = options.bom === undefined ? Number(raw.startsWith('\ufeff')) : Number(!!options.bom);
    if (bom && !raw.startsWith('\ufeff')) throw Error('Source BOM metadata does not match the raw document');
    const matcher = /\r\n|\r|\n/g; let match, extra = 0;
    while ((match = matcher.exec(raw))) {
      positions.push(match.index); endings.push(match[0]);
      if (match[0] === '\r\n') { crlfRaw.push(match.index); crlfDisplay.push(match.index - extra - bom); extra++; }
    }
    return { raw, bom, endings, positions, crlfRaw, crlfDisplay, length: raw.length - extra - bom };
  }
  function checked(value, length) {
    if (!Number.isSafeInteger(value) || value < 0 || value > length) throw RangeError('Source selection is outside the document');
    return value;
  }
  function toRaw(document, offset) {
    const value = typeof document === 'string' ? create(document) : document;
    checked(offset, value.length); return value.bom + offset + lowerBound(value.crlfDisplay, offset);
  }
  function toDisplay(document, offset, bias = -1) {
    const value = typeof document === 'string' ? create(document) : document;
    checked(offset, value.raw.length); const before = lowerBound(value.crlfRaw, offset);
    const inside = before > 0 && value.crlfRaw[before - 1] + 1 === offset;
    return Math.max(0, offset - value.bom - before + (inside && bias > 0 ? 1 : 0));
  }
  function separatorAt(document, rawOffset) {
    const index = lowerBound(document.positions, rawOffset);
    return document.endings[index] || document.endings.at(-1) || '\n';
  }
  function restoreEndings(display, endings, bom = false) {
    let index = 0;
    const raw = normalize(display).replace(/\n/g, () => {
      const value = endings[index++];
      if (!['\n', '\r', '\r\n'].includes(value)) throw Error('Line-ending history no longer matches this document');
      return value;
    });
    if (index !== endings.length) throw Error('Line-ending history no longer matches this document');
    return (bom ? '\ufeff' : '') + raw;
  }
  function applyChanges(document, changes) {
    const before = typeof document === 'string' ? create(document) : document, pieces = []; let cursor = before.bom, last = '';
    const append = piece => {
      if (!piece) return;
      // Deleting the text between a lone CR and an LF must not accidentally
      // merge two editor lines into one CRLF. Extend the edited boundary's CR
      // to CRLF so both logical newlines remain represented in the raw file.
      if (last === '\r' && piece[0] === '\n') pieces.push('\n');
      pieces.push(piece); last = piece.at(-1);
    };
    const apply = (from, to, inserted) => {
      const start = toRaw(before, from), end = toRaw(before, to), display = normalize(typeof inserted === 'string' ? inserted : inserted.toString());
      if (start < cursor || end < start) throw RangeError('Source changes must be ordered and non-overlapping');
      const old = before.raw.slice(start, end);
      append(before.raw.slice(cursor, start)); append(normalize(old) === display ? old : display.replace(/\n/g, separatorAt(before, start)));
      cursor = end;
    };
    append(before.raw.slice(0, before.bom));
    if (typeof changes?.iterChanges === 'function') changes.iterChanges((from, to, _fromB, _toB, inserted) => apply(from, to, inserted));
    else for (const change of changes || []) apply(change.from, change.to ?? change.from, change.insert ?? '');
    append(before.raw.slice(cursor)); return create(pieces.join(''), { bom: before.bom });
  }
  return { normalize, display, create, toRaw, toDisplay, separatorAt, restoreEndings, applyChanges };
});
