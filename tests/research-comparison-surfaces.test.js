'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const esbuild = require('esbuild');
const source = fs.readFileSync(require.resolve('../app/ui/comparison-surfaces.jsx'), 'utf8');
const css = fs.readFileSync(require.resolve('../app/source-comparison.css'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
// Exercise the visible projection and callback contract here; actual Kit DOM,
// composition, layout, and native focus are covered by the renderer acceptance.
const primitives = Object.fromEntries(['AlertBanner', 'Badge', 'Button', 'Caption', 'Card', 'EmptyState', 'Heading', 'StatusBadge', 'TextArea', 'TextInput', 'KitCheckbox', 'KitRadioGroup', 'KitSearchInput', 'KitSelect', 'KitTabs'].map(name => [name, `Kit:${name}`]));
function fixture(language = 'zh') {
  let ids = 0;
  const react = { ...React, useId: () => String(++ids), useLayoutEffect: () => {}, useRef: value => ({ current: value }), useState: value => [typeof value === 'function' ? value() : value, () => {}] };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, document: { documentElement: { lang: language } }, require: id => id === 'react' ? react : primitives });
  const calls = [], callbacks = Object.fromEntries(['onChange', 'onCriterion', 'onCell', 'onAddCriterion', 'onRemoveCriterion', 'onRefresh', 'onSelectExcerpt', 'onSource', 'onReview', 'onClaim', 'onAddClaim', 'onRemoveClaim', 'onSave', 'onSaveAs', 'onOpenNote', 'onNew', 'onDiscard', 'onClose', 'onStart', 'onSelect', 'onQuery'].map(name => [name, (...args) => calls.push({ name, args })]));
  return { calls, render: props => module.exports.SourceComparisonSurface({ ...callbacks, ...props }), picker: props => module.exports.ComparisonPicker({ items: [], count: 0, selected: [], query: '', page: 0, pages: 1, saved: [], ...callbacks, ...props }) };
}
function nodes(node) { if (!React.isValidElement(node)) return []; if (typeof node.type === 'function') return nodes(node.type(node.props)); return [node, ...React.Children.toArray(node.props.children).flatMap(nodes)]; }
function copy(node) { if (typeof node === 'string' || typeof node === 'number') return String(node); if (!React.isValidElement(node)) return ''; if (typeof node.type === 'function') return copy(node.type(node.props)); return React.Children.toArray(node.props.children).map(copy).join(' '); }
const find = (tree, kind, predicate = () => true) => nodes(tree).find(node => node.type === `Kit:${kind}` && predicate(node.props));
const button = (tree, id) => find(tree, 'Button', props => props.id === id);
function base(patch = {}) {
  const sources = ['a', 'b'].map(id => ({ key: `note:${id}`, kind: 'note', id, title: `Source ${id}`, excerpt: `Exact ${id} excerpt.`, totalCharacters: 16, metadata: {}, excerptLabel: 'note-content' }));
  const data = { version: 2, mode: 'research', title: '研究', question: '什么条件下有效？', scope: '', researchStatus: 'draft', claims: [{ id: 'claim-1', text: '初步结论', evidenceIds: ['actual-id-a'] }], openQuestions: '', projectId: null, sources, criteria: [{ id: 'row-1', label: '适用条件', cells: { 'note:a': { quote: 'Exact a excerpt.', judgment: '我的解读', relation: 'supports' }, 'note:b': { quote: 'Exact b excerpt.', judgment: '', relation: 'contradicts' } } }] };
  const evidence = sources.map((s, index) => ({ id: `actual-id-${s.id}`, rowId: 'row-1', sourceKey: s.key, label: '适用条件', sourceTitle: s.title, quote: s.excerpt, relation: index ? 'contradicts' : 'supports', available: true, exact: true, confirmed: true, canReview: true, canOpen: true, status: 'confirmed' }));
  return { data, statuses: { 'note:a': { available: true }, 'note:b': { available: true } }, research: { ready: true, evidence, claims: [], counts: { quoted: 2, confirmed: 2 }, readinessReasons: [] }, changed: true, projects: [], ...patch };
}

test('research renders actual Kit fields and controls with a sequential question/evidence/claim workflow', () => {
  const h = fixture(), tree = h.render(base()), all = nodes(tree), words = copy(tree);
  for (const type of ['Card', 'TextInput', 'TextArea', 'KitSelect', 'KitCheckbox', 'StatusBadge']) assert.ok(all.some(node => node.type === `Kit:${type}`), type);
  assert.equal(all.some(node => ['input', 'textarea', 'select'].includes(node.type)), false);
  assert.match(words, /明确问题/); assert.match(words, /核对证据/); assert.match(words, /写下结论/); assert.match(words, /不表示 AI 已验证结论/);
  assert.match(copy(button(tree, 'comparisonSave')), /保存到科研 Wiki/);
  assert.equal(find(tree, 'TextArea', p => p.label === '研究问题').props.value, '什么条件下有效？');
  assert.equal(find(tree, 'KitSelect', p => p.id === 'comparisonResearchStatus').props.value, 'draft');
});
test('local draft acknowledgement is distinct from a saved Wiki note and errors never claim durability', () => {
  const h = fixture(), saved = h.render(base({ draftPersistence: { state: 'saved', updatedAt: 100, recovered: true } }));
  assert.match(copy(saved), /草稿已保存在本机/); assert.match(copy(saved), /已从本机恢复/);
  assert.doesNotMatch(copy(saved), /刷新或退出应用后未保存内容会丢失/);
  const failed = h.render(base({ draftPersistence: { state: 'error', message: '磁盘写入失败' }, onRetryDraft() {} }));
  assert.match(find(failed, 'AlertBanner').props.description, /磁盘写入失败/); assert.doesNotMatch(copy(failed), /草稿已保存在本机/);
  assert.ok(find(failed, 'Button', props => props.children === '重试保存草稿'));
});
test('discard is a confirmation step and private persisted content never appears in the picker', () => {
  const h = fixture(), tree = h.render(base({ draftPersistence: { state: 'saved' } }));
  find(tree, 'Button', props => props.children === '放弃本机草稿').props.onClick();
  assert.equal(h.calls.some(call => call.name === 'onDiscard'), false);
  const picker = h.picker({ selected: ['note:a', 'note:b'], draftPersistence: { state: 'unavailable', blocked: 'private' } });
  assert.equal(button(picker, 'comparisonStart').props.disabled, true);
  assert.match(find(picker, 'AlertBanner').props.description, /不会显示/); assert.ok(find(picker, 'Button', props => props.children === '清除本机草稿'));
});
test('evidence review and source navigation delegate projection identities without constructing evidence IDs', () => {
  const h = fixture(), props = base(); props.research.evidence[0].confirmed = false;
  const tree = h.render(props);
  button(tree, 'comparisonReview-row-1-0').props.onClick();
  find(tree, 'Button', p => p.children?.[0] === '定位原文').props.onClick();
  assert.equal(h.calls[0].name, 'onReview'); assert.deepEqual(Array.from(h.calls[0].args), ['row-1', 'note:a']);
  assert.equal(h.calls[1].name, 'onSource'); assert.deepEqual(Array.from(h.calls[1].args), ['note:a', 'actual-id-a']);
});
test('claim choices use real evidence IDs, prevent new unreviewed links, and preserve selected stale links for removal', () => {
  const h = fixture(), props = base();
  props.research.evidence[0] = { ...props.research.evidence[0], confirmed: false, stale: true, status: 'stale' };
  props.research.evidence[1] = { ...props.research.evidence[1], confirmed: false, status: 'unreviewed' };
  const tree = h.render(props), first = find(tree, 'KitCheckbox', p => p.id === 'comparisonClaimEvidence-claim-1-0'), second = find(tree, 'KitCheckbox', p => p.id === 'comparisonClaimEvidence-claim-1-1');
  assert.equal(first.props.checked, true); assert.equal(!!first.props.disabled, false); assert.equal(second.props.disabled, true);
  first.props.onChange(false); assert.equal(h.calls[0].name, 'onClaim'); assert.equal(h.calls[0].args[0], 'claim-1'); assert.equal(h.calls[0].args[1], 'evidenceIds'); assert.equal(h.calls[0].args[2].length, 0);
  assert.match(copy(tree), /来源已变化/);
});
test('removed evidence remains visible and explicitly removable instead of silently disappearing', () => {
  const h = fixture(), props = base(); props.data.claims[0].evidenceIds = ['removed-evidence'];
  const tree = h.render(props), removed = find(tree, 'KitCheckbox', p => /已移除的证据/.test(p.label));
  assert.ok(removed); assert.equal(removed.props.checked, true); removed.props.onChange(false);
  assert.equal(h.calls[0].name, 'onClaim'); assert.equal(h.calls[0].args[2].length, 0);
});
test('drafts retain stale evidence while organized results require current reviewed evidence', () => {
  const h = fixture(), props = base(); props.statuses['note:a'].stale = true; props.research.ready = false; props.research.readinessReasons = ['结论引用待复核'];
  let tree = h.render(props); assert.equal(!!button(tree, 'comparisonSave').props.disabled, false); assert.match(copy(tree), /可以保存草稿/);
  const status = find(tree, 'KitSelect', p => p.id === 'comparisonResearchStatus'); assert.equal(status.props.options.find(o => o.value === 'ready').disabled, true);
  props.data.researchStatus = 'ready'; tree = h.render(props); assert.equal(button(tree, 'comparisonSave').props.disabled, true); assert.match(copy(tree), /结论引用待复核/);
});
test('private comparisons render no question, excerpt, claim, source title or editable controls', () => {
  const h = fixture(), props = base(); props.statuses['note:a'] = { available: false, private: true };
  const tree = h.render(props); assert.equal(nodes(tree).some(node => ['Kit:TextInput', 'Kit:TextArea', 'Kit:KitCheckbox'].includes(node.type)), false);
  assert.doesNotMatch(copy(tree), /Source a|Exact a|初步结论|什么条件下/); assert.ok(find(tree, 'EmptyState'));
});
test('inaccessible sources hide frozen titles, excerpt text, judgment, and metadata without losing source identity', () => {
  const h = fixture(), props = base(); props.statuses['note:a'] = { available: false, redacted: true };
  props.research.evidence[0] = { ...props.research.evidence[0], sourceTitle: '', quote: '', available: false, confirmed: false, canOpen: false, status: 'unavailable' };
  const tree = h.render(props); assert.doesNotMatch(copy(tree), /Source a|Exact a|我的解读/);
  assert.ok(nodes(tree).find(node => node.props['data-comparison-source'] === 'note:a')); assert.equal(button(tree, 'comparisonSave').props.disabled, true);
});
test('legacy comparisons retain the choice/conclusion contract while migrating inputs and radios', () => {
  const h = fixture('en'), props = base(); props.data.version = 1; delete props.data.mode; props.data.conclusion = 'Legacy conclusion'; props.data.selectedKey = 'note:a';
  const tree = h.render(props); assert.equal(find(tree, 'KitRadioGroup').props.value, 'note:a');
  const conclusion = find(tree, 'TextArea', p => p.value === 'Legacy conclusion'); assert.ok(conclusion); conclusion.props.onChange('Revised conclusion');
  assert.deepEqual(Array.from(h.calls[0].args), ['conclusion', 'Revised conclusion']); assert.match(copy(button(tree, 'comparisonSave')), /Save as note/); assert.doesNotMatch(copy(tree), /Research Wiki/);
});
test('picker research tab uses explicit mode when starting and preserves selection limits', () => {
  const h = fixture(), tree = h.picker({ mode: 'research', selected: ['a', 'b'], items: [{ key: 'a', title: 'A', kind: 'note' }] });
  assert.equal(find(tree, 'KitTabs').props.value, 'research'); assert.ok(find(tree, 'KitSearchInput')); assert.ok(find(tree, 'KitCheckbox'));
  button(tree, 'comparisonStart').props.onClick(); assert.deepEqual(Array.from(h.calls[0].args), ['research']);
  const full = h.picker({ selected: ['a', 'b', 'c', 'd'], items: [{ key: 'e', title: 'E', kind: 'note' }] }); assert.equal(find(full, 'KitCheckbox').props.disabled, true);
});
test('responsive stylesheet keeps native controls usable and honors reduced motion', () => {
  assert.doesNotThrow(() => esbuild.transformSync(css, { loader: 'css' })); assert.match(css, /max-width: 760px/); assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /\.source-comparison-dialog input\[/, 'do not override Kit hidden semantic controls');
  assert.match(source, /compositionstart/); assert.match(source, /compositionend/); assert.match(source, /input\.maxLength/);
});
