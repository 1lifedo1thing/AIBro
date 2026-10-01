'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Body = require('../app/streaming-body');
// A small DOM contract with actual parent/child moves and CharacterData edits.
// Browser Range/focus and production Markdown parsing are tested in the smoke.
class Node {
  constructor(name, data = '') { this.nodeName = name; this.nodeType = name === '#text' ? 3 : 1; this.nodeValue = data; this.childNodes = []; this.attrs = new Map(); this.namespaceURI = null; this.parentNode = null; this.edits = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get outerHTML() { return `<${this.nodeName}${[...this.attrs].map(([k,v]) => ` ${k}=${JSON.stringify(v)}`).join('')}>${this.childNodes.map(child => child.nodeType === 3 ? JSON.stringify(child.nodeValue) : child.outerHTML).join('')}</${this.nodeName}>`; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join(''); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  matches(selector) { return selector.split(',').some(value => { const part = value.trim(); return part[0] === '.' ? (this.getAttribute('class') || '').split(' ').includes(part.slice(1)) : part[0] === '[' ? this.hasAttribute(part.slice(1, -1)) : this.nodeName === part.toUpperCase(); }); }
  querySelectorAll(selector) { return this.childNodes.flatMap(child => child.nodeType === 1 ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : []); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, reference) { if (node === reference) return node; if (node.parentNode) node.parentNode.removeChild(node); const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length; assert.notEqual(index, -1); this.childNodes.splice(index, 0, node); node.parentNode = this; return node; }
  removeChild(node) { const index = this.childNodes.indexOf(node); assert.notEqual(index, -1); this.childNodes.splice(index, 1); node.parentNode = null; return node; }
  isEqualNode(other) { return this.nodeType === other.nodeType && (this.nodeType === 3 ? this.nodeValue === other.nodeValue : this.outerHTML === other.outerHTML); }
  replaceData(offset, count, data) { this.edits.push({ offset, count, data }); this.nodeValue = this.nodeValue.slice(0, offset) + data + this.nodeValue.slice(offset + count); }
}
const text = value => new Node('#text', value);
function element(name, ...children) { const node = new Node(name.toUpperCase()); node.append(...children.map(child => typeof child === 'string' ? text(child) : child)); return node; }
const body = (...children) => element('div', ...children);

test('an appended answer keeps completed blocks and edits only the existing tail text', () => {
  const current = body(element('h2', '已完成标题'), element('p', '正在回答'));
  const heading = current.firstChild, paragraph = heading.nextSibling, tail = paragraph.firstChild;
  for (let n = 1; n <= 20; n++) {
    const fresh = body(element('h2', '已完成标题'), element('p', '正在回答' + '。'.repeat(n)));
    const expected = fresh.outerHTML;
    assert.equal(Body.patch(current, fresh), true); assert.equal(current.outerHTML, expected);
    assert.equal(current.firstChild, heading); assert.equal(heading.nextSibling, paragraph); assert.equal(paragraph.firstChild, tail);
  }
  assert.equal(tail.edits.length, 20); assert.ok(tail.edits.every(edit => edit.count === 0 && edit.data === '。'));
});

test('insertions, removals and corrections preserve exact surviving siblings', () => {
  const a = element('p', 'A'), b = element('p', 'B'), c = element('p', 'C');
  const current = body(a, b, c);
  const fresh = body(element('h2', 'New'), element('p', 'A'), element('p', 'Corrected'), element('p', 'C'));
  const expected = fresh.outerHTML; Body.patch(current, fresh);
  assert.equal(current.outerHTML, expected); assert.equal(current.childNodes[1], a); assert.equal(current.childNodes[3], c); assert.equal(current.childNodes[2], b);
  const compact = body(element('p', 'C'), element('p', 'A')); const expectedCompact = compact.outerHTML;
  Body.patch(current, compact); assert.equal(current.outerHTML, expectedCompact); assert.deepEqual(current.childNodes, [c, a]);
});

test('incomplete inline syntax can become markup without retaining stale literal text', () => {
  const current = body(element('p', 'Intro **bold'));
  const paragraph = current.firstChild, prefix = paragraph.firstChild;
  const fresh = body(element('p', 'Intro ', element('strong', 'bold'), ' tail'));
  const expected = fresh.outerHTML; Body.patch(current, fresh);
  assert.equal(current.outerHTML, expected); assert.equal(current.firstChild, paragraph); assert.equal(paragraph.firstChild, prefix); assert.equal(prefix.nodeValue, 'Intro ');
});

test('list and table structural changes produce exactly the fresh tree', () => {
  const current = body(element('ul', element('li', 'One'), element('li', 'Two')));
  const first = current.firstChild.firstChild;
  const fresh = body(element('ul', element('li', 'One'), element('li', 'Two more'), element('li', 'Three')), element('div', element('table', element('tr', element('td', 'cell')))));
  const expected = fresh.outerHTML; Body.patch(current, fresh);
  assert.equal(current.outerHTML, expected); assert.equal(current.firstChild.firstChild, first);
  const replaced = body(element('p', 'No list now')); const replacementMarkup = replaced.outerHTML;
  Body.patch(current, replaced); assert.equal(current.outerHTML, replacementMarkup); assert.equal(current.querySelector('ul'), null);
});

test('a changed destination gets a fresh control but the same destination keeps its node', () => {
  const link = element('a', 'Reference'); link.setAttribute('href', 'https://example.com/a');
  const current = body(element('p', link));
  const sameLink = element('a', 'Reference updated'); sameLink.setAttribute('href', 'https://example.com/a');
  Body.patch(current, body(element('p', sameLink))); assert.equal(current.querySelector('a'), link);
  const changed = element('a', 'Reference updated'); changed.setAttribute('href', 'https://example.com/b');
  Body.patch(current, body(element('p', changed))); assert.equal(current.querySelector('a'), changed); assert.equal(link.parentNode, null);
});

test('equal citation DOM refreshes source snapshots and sibling bindings', () => {
  const bindings = new WeakMap(), saved = globalThis.CitationEvidence;
  globalThis.CitationEvidence = { resolveTarget: (_, node) => bindings.get(node), bind(node, source, siblings) { bindings.set(node, { source, siblings }); } };
  try {
    const chip = source => { const node = element('button', '1'); node.setAttribute('data-citation-source', 's'); node.setAttribute('data-citation-run', 'r'); bindings.set(node, { source, siblings: [source] }); return node; };
    const original = chip({ sourceId: 's', excerpt: 'old excerpt' }), current = body(element('p', 'Fact', original));
    const redacted = { sourceId: 's', excerpt: null, private: true }, newer = chip(redacted), fresh = body(element('p', 'Fact', newer));
    assert.equal(current.outerHTML, fresh.outerHTML); Body.patch(current, fresh);
    assert.equal(current.querySelector('button'), original); assert.equal(bindings.get(original).source, redacted); assert.deepEqual(bindings.get(original).siblings, [redacted]);
  } finally { globalThis.CitationEvidence = saved; }
});

test('preview and controller ownership decline before mutating either tree', () => {
  for (const field of ['data-safe-preview', 'data-preview-action', 'data-halaska-root', 'data-halaska-conversation', 'data-citation-panel']) {
    for (const side of ['previous', 'next']) {
      const previous = body(element('p', 'Before')), next = body(element('p', 'After'));
      (side === 'previous' ? previous : next).firstChild.setAttribute(field, 'owned');
      const before = previous.outerHTML, after = next.outerHTML;
      assert.equal(Body.patch(previous, next), false); assert.equal(previous.outerHTML, before); assert.equal(next.outerHTML, after);
    }
  }
});

test('root attributes follow the renderer without retaining obsolete hidden state', () => {
  const current = body(element('p', 'Answer')); current.setAttribute('hidden', ''); current.setAttribute('data-old', 'old');
  const fresh = body(element('p', 'Answer')); fresh.setAttribute('class', 'message-body');
  const expected = fresh.outerHTML; Body.patch(current, fresh); assert.equal(current.outerHTML, expected); assert.equal(current.hasAttribute('hidden'), false);
});

test('duplicate blocks are each used once and remain in the requested order', () => {
  const originals = Array.from({ length: 200 }, () => element('p', 'Repeated'));
  const current = body(...originals), fresh = body(element('h2', 'New'), ...Array.from({ length: 220 }, () => element('p', 'Repeated')));
  const expected = fresh.outerHTML; Body.patch(current, fresh); assert.equal(current.outerHTML, expected);
  assert.deepEqual(current.childNodes.slice(1, 201), originals); assert.equal(new Set(current.childNodes).size, 221);
});

test('mixed insert/edit/reorder sequences always converge to the fresh rendered tree', () => {
  let seed = 43; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const tree = () => body(...Array.from({ length: Math.floor(random() * 9) }, () => {
    const tag = ['p', 'h2', 'blockquote'][Math.floor(random() * 3)];
    return element(tag, ...Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
      const value = ['A', 'B', 'Repeated', 'Text corrected'][Math.floor(random() * 4)];
      return random() < .5 ? value : element(random() < .5 ? 'strong' : 'code', value);
    }));
  }));
  let current = tree();
  for (let n = 0; n < 250; n++) {
    const fresh = tree(), expected = fresh.outerHTML; assert.equal(Body.patch(current, fresh), true); assert.equal(current.outerHTML, expected, 'sequence ' + n);
    assert.equal(new Set(current.childNodes).size, current.childNodes.length);
  }
});

test('selection offsets follow unchanged suffix text through prepend and earlier correction in both directions', () => {
  for (const backward of [false, true]) {
    const current = body(element('p', 'old selected suffix')), node = current.firstChild.firstChild;
    const at = node.nodeValue.indexOf('selected suffix'), finish = node.nodeValue.length;
    const selection = { anchor: node, anchorOffset: backward ? finish : at, focus: node, focusOffset: backward ? at : finish, anchorIsStart: !backward };
    for (const after of ['PREFIX old selected suffix', 'PREFIX much longer corrected selected suffix', 'selected suffix', 'selected suffix APPENDED']) {
      Body.patch(current, body(element('p', after)), { onTextEdit: (changed, edit) => Body.remapSelection(selection, changed, edit) });
      assert.equal(current.firstChild.firstChild, node);
      const low = Math.min(selection.anchorOffset, selection.focusOffset), high = Math.max(selection.anchorOffset, selection.focusOffset);
      assert.equal(node.nodeValue.slice(low, high), 'selected suffix');
      assert.equal(selection.anchorOffset > selection.focusOffset, backward);
    }
  }
});

test('changed selected content collapses while a surviving prefix and unrelated node retain offsets', () => {
  const current = body(element('p', 'prefix selected suffix')), node = current.firstChild.firstChild;
  const start = node.nodeValue.indexOf('selected');
  const selection = { anchor: node, anchorOffset: start, focus: node, focusOffset: start + 'selected'.length, anchorIsStart: true };
  Body.patch(current, body(element('p', 'prefix REPLACEMENT suffix')), { onTextEdit: (changed, edit) => Body.remapSelection(selection, changed, edit) });
  assert.equal(selection.anchorOffset, selection.focusOffset); assert.equal(selection.anchorOffset, start);
  const prefix = { anchor: node, anchorOffset: 0, focus: node, focusOffset: 'prefix'.length, anchorIsStart: true };
  const unrelated = text('another body'), untouched = { anchor: unrelated, anchorOffset: 2, focus: unrelated, focusOffset: 4, anchorIsStart: true };
  Body.patch(current, body(element('p', 'prefix different ending')), { onTextEdit: (changed, edit) => { Body.remapSelection(prefix, changed, edit); Body.remapSelection(untouched, changed, edit); } });
  assert.equal(node.nodeValue.slice(prefix.anchorOffset, prefix.focusOffset), 'prefix');
  assert.equal(untouched.anchorOffset, 2); assert.equal(untouched.focusOffset, 4);
});

test('a collapsed caret preserves the surviving suffix boundary and never becomes a selection', () => {
  const cases = [
    ['old suffix', 'longer suffix', 3, 6],
    ['old suffix', 'longer suffix', 0, 0],
    ['old suffix', 'longer suffix', 1, 0],
    ['old suffix', 'longer suffix', 4, 7],
    ['old suffix', ' suffix', 3, 0],
    [' suffix', 'new suffix', 0, 3],
    ['tail', 'tail appended', 4, 4]
  ];
  for (const [before, after, at, expected] of cases) {
    const current = body(element('p', before)), node = current.firstChild.firstChild;
    const selection = { anchor: node, anchorOffset: at, focus: node, focusOffset: at, anchorIsStart: true };
    Body.patch(current, body(element('p', after)), { onTextEdit: (changed, edit) => Body.remapSelection(selection, changed, edit) });
    assert.equal(current.firstChild.firstChild, node);
    assert.equal(selection.anchorOffset, expected, `${before} -> ${after} at ${at}`);
    assert.equal(selection.focusOffset, expected, 'the caret must remain collapsed');
  }
});
