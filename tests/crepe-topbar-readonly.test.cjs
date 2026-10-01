const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { transform } = require('esbuild');
const Vue = require('vue');

const root = path.resolve(__dirname, '..');
const crepeRoot = path.join(root, 'node_modules/@milkdown/crepe');
const installed = JSON.parse(fs.readFileSync(path.join(crepeRoot, 'package.json'), 'utf8'));
const patchModule = import(pathToFileURL(path.join(root, 'scripts/lib/document-editor-patches.mjs')).href);

async function upstream() {
  const { CREPE_TOP_BAR_PATCH, patchCrepeTopBar } = await patchModule;
  const source = fs.readFileSync(path.join(crepeRoot, CREPE_TOP_BAR_PATCH.sourcePath), 'utf8');
  return { source, patchCrepeTopBar };
}

// Execute the installed production component, not a rewritten render function.
// Only its surrounding editor/menu context is supplied here. DOM mounting is
// outside this Node test; Vue's real effect tracks the same render dependencies.
async function mountRender(source, { editable = true } = {}) {
  const start = source.indexOf('const TopBar = defineComponent({');
  const end = source.indexOf('\nvar __typeError', start);
  assert.ok(start >= 0 && end > start, 'installed TopBar component boundary must be revalidated on upgrade');
  assert.equal(source.indexOf('const TopBar = defineComponent({', start + 1), -1);
  const { code } = await transform(`${source.slice(start, end)}\nexport { TopBar };`, {
    loader: 'js', format: 'cjs', target: 'node20'
  });
  const editorCtx = Symbol('editor'), editorViewCtx = Symbol('view');
  const view = { editable }, version = Vue.ref(0);
  let active = false, clicked = 0, output, renders = 0;
  const ctx = { get: key => {
    if (key === editorCtx) return { status: 'Created' };
    if (key === editorViewCtx) return view;
    throw new Error(`Unexpected editor context: ${String(key)}`);
  } };
  const groups = [{ key: 'format', items: [
    { key: 'heading', selector: {
      options: [{ label: 'Paragraph', onSelect() {} }],
      activeLabel: () => active ? 'Heading 1' : 'Paragraph'
    } },
    { key: 'bold', icon: 'B', active: () => active, onRun: () => { clicked++; } },
    { key: 'italic', icon: 'I', active: () => false, onRun() {} }
  ] }];
  const bindings = {
    defineComponent: Vue.defineComponent, ref: Vue.ref, computed: Vue.computed, h: Vue.h,
    onMounted() {}, onUnmounted() {}, Icon: 'span', editorCtx, editorViewCtx,
    EditorStatus: { Created: 'Created' }, keepAlive() {}, getGroups: () => groups,
    clsx: (...values) => values.filter(Boolean).join(' ')
  };
  const module = { exports: {} };
  new Function('module', 'exports', ...Object.keys(bindings), code)(module, module.exports, ...Object.values(bindings));
  const render = module.exports.TopBar.setup({ ctx, version, config: {} });
  const runner = Vue.effect(() => { renders++; output = render(); });
  return {
    get output() { return output; },
    get renders() { return renders; },
    get clicked() { return clicked; },
    setReadonly(value) {
      view.editable = !value;
      // TopBarView.update increments this ref after ProseMirror setProps.
      version.value++;
    },
    changeSelection(value) { active = value; version.value++; },
    destroy() { Vue.stop(runner); }
  };
}

function buttons(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  return [...(node.type === 'button' ? [node] : []), ...buttons(node.children)];
}

test('installed unpatched Crepe reproduces loss of the render subscription after readonly', async t => {
  const { source } = await upstream();
  const render = await mountRender(source);
  t.after(() => render.destroy());
  assert.equal(buttons(render.output).length, 3);
  render.setReadonly(true);
  assert.equal(render.output, null);
  const readonlyRenders = render.renders;
  render.setReadonly(false);
  assert.equal(render.renders, readonlyRenders, 'upstream readonly return drops its version dependency');
  assert.equal(render.output, null);
});

test('production patch restores actual Crepe controls after repeated save readonly cycles', async t => {
  const { source, patchCrepeTopBar } = await upstream();
  const render = await mountRender(patchCrepeTopBar(source, { version: installed.version }));
  t.after(() => render.destroy());
  assert.equal(buttons(render.output).length, 3);
  for (let cycle = 0; cycle < 3; cycle++) {
    render.setReadonly(true);
    assert.equal(render.output, null);
    const readonlyRenders = render.renders;
    render.setReadonly(false);
    assert.equal(render.renders, readonlyRenders + 1);
    assert.equal(buttons(render.output).length, 3);
    const bold = buttons(render.output).find(node => node.key === 'bold');
    bold.props.onPointerdown({ preventDefault() {} });
    assert.equal(render.clicked, cycle + 1, 'restored controls retain their command handlers');
  }
  render.changeSelection(true);
  const bold = buttons(render.output).find(node => node.key === 'bold');
  assert.match(bold.props.class, /\bactive\b/, 'restored controls continue to observe selection updates');
});

test('production patch subscribes even when Crepe first renders readonly', async t => {
  const { source, patchCrepeTopBar } = await upstream();
  const render = await mountRender(patchCrepeTopBar(source, { version: installed.version }), { editable: false });
  t.after(() => render.destroy());
  assert.equal(render.output, null);
  assert.equal(render.renders, 1);
  render.setReadonly(false);
  assert.equal(render.renders, 2);
  assert.equal(buttons(render.output).length, 3);
});

test('Crepe patch rejects a different installed package version', async () => {
  const { source, patchCrepeTopBar } = await upstream();
  assert.throws(() => patchCrepeTopBar(source, { version: '0.0.0' }), /requires .*found 0\.0\.0.*Revalidate/);
  assert.throws(() => patchCrepeTopBar(source), /requires .*found unknown.*Revalidate/);
});

test('Crepe patch rejects upstream render changes instead of silently building unpatched', async () => {
  const { source, patchCrepeTopBar } = await upstream();
  const changed = source.replace('if (isReadonly) return null;', 'if (isReadonly) return undefined;');
  assert.notEqual(changed, source);
  assert.throws(() => patchCrepeTopBar(changed, { version: installed.version }), /expected one readonly render anchor; found 0/);
});

test('Crepe patch rejects ambiguous duplicate render anchors', async () => {
  const { source, patchCrepeTopBar } = await upstream();
  assert.throws(() => patchCrepeTopBar(`${source}\n${source}`, { version: installed.version }), /expected one readonly render anchor; found 2/);
});
