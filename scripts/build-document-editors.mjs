import { build } from 'esbuild';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CREPE_TOP_BAR_PATCH, patchCrepeTopBar } from './lib/document-editor-patches.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'app');
const crepeRoot = path.join(root, 'node_modules/@milkdown/crepe');
const crepePackage = JSON.parse(await readFile(path.join(crepeRoot, 'package.json'), 'utf8'));
const localPatches = [];
const bundle = await build({
  absWorkingDir: root, entryPoints: ['app/editor/entry.js'],
  outfile: 'app/document-editors-bundle.js', bundle: true, write: false,
  format: 'iife', platform: 'browser', target: ['safari15', 'chrome110'],
  minify: true, charset: 'utf8', legalComments: 'inline', metafile: true,
  loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'aibro-pinned-crepe-topbar',
    setup(builder) {
      builder.onLoad({ filter: /@milkdown\/crepe\/lib\/esm\/feature\/top-bar\/index\.js$/ }, async ({ path: sourcePath }) => {
        const expected = path.join(crepeRoot, CREPE_TOP_BAR_PATCH.sourcePath);
        if (path.resolve(sourcePath) !== expected) throw new Error('Unexpected Crepe TopBar source path; revalidate the pinned patch.');
        const original = await readFile(sourcePath, 'utf8');
        const contents = patchCrepeTopBar(original, { version: crepePackage.version });
        localPatches.push({ ...CREPE_TOP_BAR_PATCH,
          originalSha256: createHash('sha256').update(original).digest('hex'),
          patchedSha256: createHash('sha256').update(contents).digest('hex') });
        return { contents, loader: 'js' };
      });
    }
  }],
});
if (localPatches.length !== 1) throw new Error(`Expected exactly one Crepe TopBar build patch; applied ${localPatches.length}.`);

// Keep the exact notices of every package whose code ships in this bundle.
const packages = new Map();
const missingNotices = [];
for (const input of Object.keys(bundle.metafile.inputs).filter(name => name.includes('node_modules/'))) {
  let dir = path.dirname(path.resolve(root, input));
  while (dir.startsWith(root) && dir !== root) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) {
        if (!packages.has(dir)) {
          const candidates = (await readdir(dir)).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(name));
          const notices = [];
          for (const name of candidates) {
            try { notices.push(`${name}\n${await readFile(path.join(dir, name), 'utf8')}`); } catch (_) { /* directories are not notices */ }
          }
          if (!notices.length) {
            try { notices.push(await readFile(path.join(root, 'docs/licenses', `EDITOR-${pkg.name.replaceAll('/', '_')}-${pkg.version}.txt`), 'utf8')); }
            catch (error) { if (error.code !== 'ENOENT') throw error; missingNotices.push({ name: pkg.name, version: pkg.version, repository: pkg.repository, license: pkg.license }); }
          }
          packages.set(dir, { name: pkg.name, version: pkg.version, license: pkg.license, notices: notices.join('\n\n') });
        }
        break;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    dir = path.dirname(dir);
  }
}
const ordered = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
if (missingNotices.length) throw new Error(`Missing license texts; verify upstream version and save a pinned fallback in docs/licenses: ${JSON.stringify(missingNotices)}`);
const notices = ordered.map(pkg => `${pkg.name}@${pkg.version} (${pkg.license})\n${pkg.notices}`).join('\n\n');
const safeNotices = notices.replaceAll('*/', '* /');
await writeFile(path.join(app, 'document-editors-bundle.js'), `/*! AI Bro document editors — bundled third-party notices\n${safeNotices}\n*/\n${bundle.outputFiles[0].text}`);
await writeFile(path.join(root, 'docs/licenses/DOCUMENT-EDITORS.txt'), notices + '\n');

// Inline local KaTeX fonts to retain the flat native resource manifest and
// keep the editor entirely offline. No upstream theme or web font imports.
await build({
  absWorkingDir: root, entryPoints: ['app/editor/base.css'],
  outfile: 'app/document-editors.css', bundle: true, minify: true,
  target: ['safari15', 'chrome110'], legalComments: 'inline',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
const assets = await Promise.all(['document-editors-bundle.js', 'document-editors.css'].map(async name => {
  const contents = await readFile(path.join(app, name));
  return { name, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
}));
const report = { packages: ordered.map(({ notices, ...pkg }) => pkg), localPatches, assets };
await writeFile(path.join(app, 'editor/provenance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ packages: ordered.length, localPatches, assets }, null, 2));
