'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const Native = require('../scripts/release-native');
const { copyAssets, fingerprint, readManifest } = require('../app/app-assets');

function git(root, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
  const result = spawnSync('/usr/bin/git', ['-C', root, '-c', 'user.name=Release Fixture',
    '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t, { untracked } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-native-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function put(name, content) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  put('app/asset-manifest.json', JSON.stringify({ schemaVersion: 1, web: ['index.html'],
    runtime: ['runtime.js', 'package.json'], optionalRuntime: ['native-glass.node', 'python-runtime-manifest.json'] }));
  put('app/index.html', '<!doctype html><title>Isolated release fixture</title>');
  put('app/runtime.js', 'module.exports = "fixture";');
  put('app/package.json', '{}');
  put('app/ui/vendor/fixture/component.tsx', 'export const Component = () => null;');
  put('app/editor/adapter.js', 'export const adapter = {};');
  put('native/Sources/AIBro/Another.swift', '// synthetic source');
  put('native/Resources/extra.js', '// synthetic native resource');
  put('docs/licenses/UPSTREAM.txt', 'Synthetic license fixture');
  for (const file of Native.requiredNativeSourceInputs(root)) {
    if (!fs.existsSync(path.join(root, file))) put(file, 'synthetic ' + file);
  }
  put('.gitignore', 'native-glass.node\npython-runtime-manifest.json\n');
  git(root, 'init', '--quiet', '--template=');
  git(root, 'add', '--', '.gitignore', ...Native.requiredNativeSourceInputs(root).filter(file => file !== untracked));
  git(root, 'commit', '--quiet', '-m', 'Synthetic native release source');
  return root;
}
function withEnvironment(values, fn) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try { Object.assign(process.env, values); return fn(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('complete committed native sources produce a stable identity without packaging', t => {
  const root = fixture(t), identity = Native.sourceIdentity(root);
  assert.equal(identity.revision, git(root, 'rev-parse', 'HEAD'));
  assert.equal(identity.trackedSourceClean, true);
  assert.match(identity.inputsSha256, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(root, 'unrelated-untracked.txt'), 'not a release input');
  fs.writeFileSync(path.join(root, 'app/native-glass.node'), 'generated optional output');
  fs.writeFileSync(path.join(root, 'app/python-runtime-manifest.json'), '{}');
  assert.deepEqual(Native.sourceIdentity(root), identity);
});

test('untracked required runtime, Swift, native resource, UI source, notice and build input are rejected', t => {
  for (const untracked of ['app/runtime.js', 'app/ai-bro-icon.icns', 'package-lock.json',
    'native/Sources/AIBro/Another.swift', 'native/Resources/extra.js',
    'app/ui/vendor/fixture/component.tsx', 'app/editor/adapter.js', 'docs/licenses/UPSTREAM.txt',
    'scripts/build-document-editors.mjs', 'scripts/run-native-preview.sh', 'scripts/copy-native-assets.js']) {
    const root = fixture(t, { untracked });
    assert.equal(git(root, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.throws(() => Native.sourceIdentity(root), error => /not tracked.*commit/.test(error.message) && error.message.includes(untracked));
  }
});

test('native staging excludes an ignored stale Electron addon without changing its source or Electron copying', t => {
  const root = fixture(t), source = path.join(root, 'app');
  const addon = path.join(source, 'native-glass.node');
  fs.writeFileSync(addon, 'stale ignored addon from another Electron build');
  const identity = Native.sourceIdentity(root);
  assert.equal(git(root, 'status', '--porcelain'), '');
  const native = path.join(root, 'native-stage'), electron = path.join(root, 'electron-stage');
  const script = path.resolve(__dirname, '../scripts/copy-native-assets.js');
  const stage = () => {
    const result = spawnSync(process.execPath, [script, native, source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  stage();
  assert.equal(fs.existsSync(path.join(native, 'native-glass.node')), false);
  assert.equal(fs.readFileSync(addon, 'utf8'), 'stale ignored addon from another Electron build');
  for (const file of readManifest(source).files.filter(name => name !== 'native-glass.node')) {
    assert.deepEqual(fs.readFileSync(path.join(native, file)), fs.readFileSync(path.join(source, file)));
  }
  const nativeFingerprint = fingerprint(native);
  fs.writeFileSync(addon, 'another ignored Electron build');
  stage();
  assert.equal(fingerprint(native), nativeFingerprint);
  assert.deepEqual(Native.sourceIdentity(root), identity);
  copyAssets(electron, source);
  assert.equal(fs.readFileSync(path.join(electron, 'native-glass.node'), 'utf8'), 'another ignored Electron build');
  assert.equal(fingerprint(electron), fingerprint(source));
  assert.notEqual(fingerprint(electron), nativeFingerprint);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../scripts/build-native-app.sh'), 'utf8'),
    /node "\$ROOT\/scripts\/copy-native-assets\.js" "\$OUT\/Contents\/Resources\/app"/);
  const same = spawnSync(process.execPath, [script, source, source], { encoding: 'utf8' });
  assert.notEqual(same.status, 0);
  assert.equal(fs.readFileSync(addon, 'utf8'), 'another ignored Electron build');
});

test('a newly added source adapter cannot escape the identity after the source commit', t => {
  const root = fixture(t);
  Native.sourceIdentity(root);
  fs.writeFileSync(path.join(root, 'app/ui/new-adapter.jsx'), 'export default null;');
  assert.throws(() => Native.sourceIdentity(root), /not tracked.*app\/ui\/new-adapter.jsx/);
});

test('committed input deletion and symlink substitution are rejected before release work', t => {
  const missing = fixture(t);
  git(missing, 'rm', '--quiet', 'scripts/build-document-markdown.mjs');
  git(missing, 'commit', '--quiet', '-m', 'Remove required build input');
  assert.throws(() => Native.sourceIdentity(missing), /regular file: scripts\/build-document-markdown.mjs/);
  const linked = fixture(t), icon = path.join(linked, 'app/ai-bro-icon.icns');
  fs.renameSync(icon, path.join(linked, 'outside-icon'));
  fs.symlinkSync('../outside-icon', icon);
  assert.throws(() => Native.sourceIdentity(linked), /regular file: app\/ai-bro-icon.icns/);
});

test('dirty and staged native inputs refuse a release before creating its output', async t => {
  const root = fixture(t), output = path.join(root, 'new-release-output');
  fs.appendFileSync(path.join(root, 'native/Sources/AIBro/AIBro.swift'), '\nchanged');
  assert.throws(() => Native.sourceIdentity(root), /uncommitted.*Commit/);
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    await assert.rejects(Native.buildNativeRelease({ root, output }), /uncommitted.*Commit/);
    assert.equal(fs.existsSync(output), false);
  }
  git(root, 'add', 'native/Sources/AIBro/AIBro.swift');
  assert.throws(() => Native.sourceIdentity(root), /uncommitted.*Commit/);
});

test('GIT_DIR and worktree/index/config injection cannot identify a different clean repository', t => {
  const target = fixture(t), other = fixture(t);
  fs.appendFileSync(path.join(target, 'app/runtime.js'), '\nchanged in actual target');
  withEnvironment({ GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other,
    GIT_INDEX_FILE: path.join(other, '.git/index'), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: other }, () => {
    assert.throws(() => Native.sourceIdentity(target), /uncommitted.*Commit/);
  });
});

test('inherited Git overrides are ignored without altering the caller environment', t => {
  const root = fixture(t), expected = Native.sourceIdentity(root);
  withEnvironment({ GIT_DIR: '/nonexistent/synthetic-release-git',
    GIT_WORK_TREE: '/nonexistent/synthetic-release-tree', HTTPS_PROXY: 'http://127.0.0.1:9' }, () => {
    assert.deepEqual(Native.sourceIdentity(root), expected);
    assert.equal(process.env.GIT_DIR, '/nonexistent/synthetic-release-git');
    assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:9');
  });
});

test('a nested folder cannot claim the identity of its parent repository', t => {
  const root = fixture(t);
  assert.throws(() => Native.sourceIdentity(path.join(root, 'app')), /Git checkout root/);
});
