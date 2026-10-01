import { build } from 'esbuild';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'app');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pinned = { unified: '11.0.5', 'remark-parse': '11.0.0', 'remark-gfm': '4.0.1', 'remark-math': '6.0.0', katex: '0.18.9' };
const sources = [];
for (const [name, version] of Object.entries(pinned)) {
  const file = path.join(root, 'node_modules', name, 'package.json');
  const raw = await readFile(file);
  const pkg = JSON.parse(raw);
  if (pkg.version !== version) throw Error(`Document Markdown dependency changed: ${name}@${pkg.version}; expected ${version}. Revalidate before updating the pin.`);
  sources.push({ name, version, repository: pkg.repository, packageSha256: sha256(raw) });
}
const bundle = await build({
  absWorkingDir: root, entryPoints: ['app/editor/document-markdown.js'],
  outfile: 'app/document-markdown-bundle.js', bundle: true, write: false,
  format: 'iife', platform: 'browser', target: ['safari15', 'chrome110'],
  minify: true, charset: 'utf8', legalComments: 'inline', metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
// Preserve each shipped package's real license text, including transitive code.
// Missing notices are a build failure; never silently substitute a license name.
const packages = new Map();
for (const input of Object.keys(bundle.metafile.inputs).filter(name => name.includes('node_modules/'))) {
  let directory = path.dirname(path.resolve(root, input));
  while (directory.startsWith(root + path.sep)) {
    let pkg;
    try { pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pkg?.name && pkg.version) {
      if (!packages.has(directory)) {
        const notices = [];
        const files = (await readdir(directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(name));
        for (const name of files) {
          try { notices.push(`${name}\n${await readFile(path.join(directory, name), 'utf8')}`); }
          catch (error) { if (error.code !== 'EISDIR') throw error; }
        }
        if (!notices.length) {
          const fallback = path.join(root, 'docs/licenses', `EDITOR-${pkg.name.replaceAll('/', '_')}-${pkg.version}.txt`);
          try { notices.push(await readFile(fallback, 'utf8')); }
          catch (error) { throw Error(`Missing pinned notice for ${pkg.name}@${pkg.version}: ${error.message}`); }
        }
        packages.set(directory, { name: pkg.name, version: pkg.version, license: pkg.license, notices: notices.join('\n\n') });
      }
      break;
    }
    directory = path.dirname(directory);
  }
}
const ordered = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const notices = ordered.map(pkg => `${pkg.name}@${pkg.version} (${pkg.license})\n${pkg.notices}`).join('\n\n');
const script = `/*! AI Bro document reading — pinned third-party notices\n${notices.replaceAll('*/', '* /')}\n*/\n${bundle.outputFiles[0].text}`;
await writeFile(path.join(app, 'document-markdown-bundle.js'), script);
await writeFile(path.join(root, 'docs/licenses/DOCUMENT-MARKDOWN.txt'), notices + '\n');
// The supported WKWebView/Chromium targets all use WOFF2. Embedding WOFF
// and TTF fallbacks triples these same offline fonts without adding coverage.
const katexDist = path.join(root, 'node_modules/katex/dist');
const originalCss = await readFile(path.join(katexDist, 'katex.min.css'), 'utf8');
let fontFaces = 0;
const fontCss = originalCss.replace(/src:(url\([^)]*\.woff2\)\s*format\("woff2"\))[^}]+/g, (_, woff2) => { fontFaces++; return 'src:' + woff2; });
if (fontFaces !== (originalCss.match(/@font-face/g) || []).length || !fontFaces || /url\([^)]*\.(woff|ttf)\)/.test(fontCss)) throw Error('KaTeX font sources changed; revalidate WOFF2 bundling.');
await build({
  absWorkingDir: root,
  stdin: { contents: fontCss, resolveDir: katexDist, loader: 'css', sourcefile: 'document-markdown-katex.css' },
  outfile: 'app/document-markdown.css', bundle: true, minify: true,
  target: ['safari15', 'chrome110'], legalComments: 'inline',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
const assets = await Promise.all(['document-markdown-bundle.js', 'document-markdown.css'].map(async name => {
  const content = await readFile(path.join(app, name)); return { name, bytes: content.length, sha256: sha256(content) };
}));
const inputs = await Promise.all(Object.keys(bundle.metafile.inputs).sort().map(async name => ({ name, sha256: sha256(await readFile(path.resolve(root, name))) })));
const provenance = { entry: 'app/editor/document-markdown.js', sources, packages: ordered.map(({ notices, ...pkg }) => pkg), inputs, assets,
  runtime: { network: false, fonts: 'WOFF2 only, inlined in document-markdown.css', fontFaces, math: { trust: false, throwOnError: false, maxExpand: 1000, maxSize: 30, output: 'htmlAndMathml' } } };
await writeFile(path.join(app, 'editor/document-markdown-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ packages: ordered.length, sources, assets }, null, 2));
