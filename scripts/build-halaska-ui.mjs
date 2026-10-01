import { build } from 'esbuild';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { patchHalaskaDataTable } from './halaska-data-table-patch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, 'app/ui/halaska-kit.jsx');
const expectedHash = '0ab6ad465c3e0d2659212cce3c4957ff50491c9ac5f4ac690e58ce1832e0de3e';
const raw = await readFile(upstream, 'utf8');
const sha256 = text => createHash('sha256').update(text).digest('hex');
if (sha256(raw) !== expectedHash) throw new Error('Halaska upstream changed. Review/update the integration patches and source fingerprint before building.');
let source = patchHalaskaDataTable(raw);
function replaceOnce(before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Halaska patch no longer unique: ${before.slice(0, 90)}`);
  source = source.replace(before, after);
}

// Local fonts and scoped rules prevent a UI library from changing the host app
// or making requests to a third-party font service.
replaceOnce('  @media (max-width: 719px) { html, body { overflow-x: hidden; } }\n', '');
replaceOnce("@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');", '');
replaceOnce('button:focus-visible, a:focus-visible, [tabindex]:focus-visible {', '[data-halaska-root] button:focus-visible, [data-halaska-root] a:focus-visible, [data-halaska-root] [tabindex]:focus-visible {');
replaceOnce('outline: 2px solid #3b82f6 !important;', 'outline: 2px solid var(--accent) !important;');
replaceOnce('input[type="range"]::-webkit-slider-thumb {', '[data-halaska-root] input[type="range"]::-webkit-slider-thumb {');
replaceOnce('textarea::-webkit-resizer {', '[data-halaska-root] textarea::-webkit-resizer {');
replaceOnce('  el.textContent = GLOBAL_STYLES;', '  el.id = "halaska-kit-styles";\n  el.textContent = GLOBAL_STYLES;');

const palette = {
  bg: 'var(--bg)', bgElevated: 'var(--panel-raised)', bgSubtle: 'var(--panel)',
  bgMuted: 'var(--panel-hover)', bgHover: 'var(--panel-hover)', bgInput: 'var(--panel)',
  border: 'var(--line-strong)', borderSubtle: 'var(--line)', borderInput: 'var(--line-strong)', borderFocus: 'var(--accent)',
  text: 'var(--text)', textSecondary: 'var(--muted)', textTertiary: 'var(--faint)', textMuted: 'var(--faint)', textInverse: 'var(--bg)',
  accent: 'var(--accent)', accentHover: 'var(--accent-solid, var(--accent))', accentBg: 'var(--accent-soft)', accentText: 'var(--accent)',
  success: 'var(--green)', successHover: 'var(--green)', successBg: 'color-mix(in srgb, var(--green) 12%, transparent)',
  warning: 'var(--orange)', warningHover: 'var(--orange)', warningBg: 'color-mix(in srgb, var(--orange) 12%, transparent)',
  danger: 'var(--red)', dangerHover: 'var(--red)', dangerBg: 'color-mix(in srgb, var(--red) 12%, transparent)',
};
replaceOnce('  const base = theme === "dark" ? tokens.dark : tokens.light;\n  return base;', `  const base = theme === "dark" ? tokens.dark : tokens.light;\n  return { ...base, ...${JSON.stringify(palette)} };`);
replaceOnce('pal.accent + "55"', '`color-mix(in srgb, ${pal.accent} 33%, transparent)`');

// Every kit button is an action by default. A button can opt into submit via
// the explicit Button prop, rather than accidentally submitting an outer form.
source = source.replace(/<button\b([^>]*?)>/g, (tag, attributes) => /\btype\s*=/.test(attributes) ? tag : `<button type="button"${attributes}>`);
replaceOnce('  disabled, loading, fullWidth, onClick, theme: tp, style: sp,\n}) {', '  disabled, loading, fullWidth, onClick, theme: tp, style: sp, type = "button", id, title, tabIndex,\n  "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy, "aria-expanded": ariaExpanded, "aria-controls": ariaControls, "aria-pressed": ariaPressed,\n}) {');
replaceOnce('    <button type="button"\n      onClick={disabled || loading ? undefined : onClick}', '    <button type={type} id={id} title={title} tabIndex={tabIndex}\n      aria-label={ariaLabel} aria-describedby={ariaDescribedBy} aria-expanded={ariaExpanded} aria-controls={ariaControls} aria-pressed={ariaPressed} aria-busy={loading || undefined}\n      onClick={disabled || loading ? undefined : onClick}');
replaceOnce('      disabled={disabled}\n      style={{\n        ...interactiveBase, ...s, border: "none", ...v,', '      disabled={disabled || loading}\n      style={{\n        ...interactiveBase, ...s, border: "none", ...v,');
// The workstation uses pale accents in dark mode. White accent-button text
// would disappear, so use the same theme inverse text as primary buttons.
source = source.replaceAll('color: disabled ? pal.textMuted : "#ffffff",', 'color: disabled ? pal.textMuted : pal.textInverse,');
const licenses = await Promise.all(['HALASKA-MIT.txt', 'REACT-MIT.txt', 'REACT-DOM-MIT.txt', 'GEIST-OFL.txt', 'AICSS-MIT.txt', 'BENCHO-MIT.txt', 'FRAMER-MOTION-MIT.txt', 'MOTION-DOM-MIT.txt', 'MOTION-UTILS-MIT.txt', 'LUCIDE-ISC.txt', 'TSLIB-0BSD.txt'].map(async name =>
  `${name}\n${await readFile(path.join(root, 'docs/licenses', name), 'utf8')}`));

// Preserve all upstream source and API docs. Tree shaking includes only the
// allowlisted named imports; no demo screen or timed business pattern ships.
await build({
  entryPoints: [path.join(root, 'app/ui/halaska-bridge.jsx')], outfile: path.join(root, 'app/halaska-ui.js'),
  bundle: true, format: 'iife', platform: 'browser', target: ['safari15', 'chrome110'],
  jsx: 'automatic', minify: true, legalComments: 'inline', charset: 'utf8',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' },
  banner: { js: `/*! AI Bro Halaska integration — third-party notices (including the bundled Geist fonts).\n${licenses.join('\n\n')}\n*/` },
  plugins: [{ name: 'halaska-host-adapter', setup(build) { build.onLoad({ filter: /halaska-kit\.jsx$/ }, () => ({ contents: source, loader: 'jsx', resolveDir: path.dirname(upstream) })); } }],
});
for (const [from, to] of [['Geist-Variable.woff2','halaska-geist.woff2'], ['GeistMono-Variable.woff2','halaska-geist-mono.woff2']]) {
  await copyFile(path.join(root, 'app/ui/fonts', from), path.join(root, 'app', to));
}
const report = {
  upstream: 'https://ui.halaska.com/halaska-kit.jsx', sourceSha256: expectedHash,
  api: 'https://ui.halaska.com/llms.txt', apiSha256: sha256(await readFile(path.join(root, 'app/ui/halaska-llms.txt'))),
  fontPackage: 'https://registry.npmjs.org/geist/-/geist-1.7.2.tgz',
  assets: await Promise.all(['halaska-ui.js', 'halaska-geist.woff2', 'halaska-geist-mono.woff2'].map(async name => {
    const content = await readFile(path.join(root, 'app', name)); return { name, bytes: content.length, sha256: sha256(content) };
  })),
};
await writeFile(path.join(root, 'app/ui/halaska-provenance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
