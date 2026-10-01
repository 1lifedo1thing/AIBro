const { app, BrowserWindow, shell, dialog, ipcMain, Menu } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { fingerprint } = require('./app-assets');
const { createApiCredentialStore, registerApiCredentialHandlers } = require('./native-api-credentials');
const { createNativeLanguage } = require('./native-ui-language');
const { createNativeGlass } = require('./native-liquid-glass');
const { selectPythonRuntime } = require('./python-runtime');

let mainWindow;
let localServer;
let quitting = false;
// Display branding must never rotate Chromium's existing Keychain identity.
// Previous versions initialized Electron with package.name = ai-workstation.
app.setName('ai-workstation');
const APP_VERSION = require('./package.json').version;
const ASSET_FINGERPRINT = fingerprint(__dirname);
let port = Number(process.env.AI_WORKSTATION_PORT || 8765);
let localOrigin = `http://127.0.0.1:${port}`;

// Keep Electron's cache, session data and single-instance lock separate from
// older QA builds. The workspace itself remains in the server-owned
// ~/Library/Application Support/ai-workstation directory, so user data is
// preserved while an old build cannot block a new release from launching.
app.setPath('userData', path.join(app.getPath('appData'), 'ai-workstation-studio'));
const nativeUI = createNativeLanguage({ app, Menu, directory: app.getPath('userData'), platform: process.platform, getWindow: () => mainWindow, getLocalOrigin: () => localOrigin, getNativeTheme: () => require('electron').nativeTheme });
ipcMain.handle('workstation:ui-language', nativeUI.setLanguage);
ipcMain.handle('workstation:ui-appearance', nativeUI.setAppearance);
const nativeGlass = createNativeGlass({ getWindow: () => mainWindow, getLocalOrigin: () => localOrigin, platform: process.platform });
ipcMain.handle('workstation:native-glass:status', event => nativeGlass.status(event));
ipcMain.handle('workstation:native-glass:regions', (event, regions) => nativeGlass.setRegions(event, regions));

let apiCredentialStore;
registerApiCredentialHandlers({
  ipcMain,
  getWindow: () => mainWindow,
  getLocalOrigin: () => localOrigin,
  getStore: () => apiCredentialStore ||= createApiCredentialStore({
    directory: path.join(app.getPath('userData'), 'credentials'),
    // Accessing Electron's safeStorage getter can itself enter the Keychain.
    // Constructing the store and polling status must stay entirely lazy.
    safeStorage: {
      isEncryptionAvailable: () => require('electron').safeStorage.isEncryptionAvailable(),
      getSelectedStorageBackend: () => require('electron').safeStorage.getSelectedStorageBackend(),
      encryptString: value => require('electron').safeStorage.encryptString(value),
      decryptString: value => require('electron').safeStorage.decryptString(value)
    }
  })
});

// Embedding credentials are independent of chat credentials and never synced.
let embeddingCredentialStore;
registerApiCredentialHandlers({
  ipcMain, channelPrefix: 'workstation:embedding-credentials:',
  getWindow: () => mainWindow, getLocalOrigin: () => localOrigin,
  getStore: () => embeddingCredentialStore ||= createApiCredentialStore({
    directory: path.join(app.getPath('userData'), 'embedding-credentials'),
    safeStorage: {
      isEncryptionAvailable: () => require('electron').safeStorage.isEncryptionAvailable(),
      getSelectedStorageBackend: () => require('electron').safeStorage.getSelectedStorageBackend(),
      encryptString: value => require('electron').safeStorage.encryptString(value),
      decryptString: value => require('electron').safeStorage.decryptString(value)
    }
  })
});

// Multiple writers can give different windows stale localStorage snapshots.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
});

function isServerReady() {
  return new Promise(resolve => {
    const req = http.get(`${localOrigin}/__health`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { const data = JSON.parse(body); resolve(res.statusCode === 200 && data.app === 'ai-workstation' && data.version === APP_VERSION && data.assetFingerprint === ASSET_FINGERPRINT); }
        catch (_) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
}

async function startLocalServer() {
  if (await isServerReady()) return;
  // A previous build may still own the preferred port. Use a private free
  // port for this bundle so launching the current app never renders stale
  // assets from an older Electron instance.
  if (await new Promise(resolve => {
    const probe = net.createServer(); probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  }) === false) port = await findFreePort();
  localOrigin = `http://127.0.0.1:${port}`;
  const python = selectPythonRuntime({resourcesPath:process.resourcesPath,assetDir:__dirname});
  const serverCandidates = [
    path.join(__dirname, 'server.py'),
    path.join(process.resourcesPath, 'server.py'),
    path.join(process.resourcesPath, 'app', 'server.py')
  ];
  const serverPath = serverCandidates.find(candidate => fs.existsSync(candidate));
  if (!serverPath) throw new Error('找不到内置的本地服务 server.py。请重新构建 AI Bro.app。');
  localServer = spawn(python.command, [...python.args,serverPath], {
    cwd: __dirname,
    env: { ...python.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_ASSET_DIR: __dirname },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let startupError = null;
  localServer.on('error', error => { startupError = error; });
  localServer.stdout.on('data', data => console.log(`[workstation] ${data}`));
  localServer.stderr.on('data', data => console.error(`[workstation] ${data}`));
  await new Promise(resolve => {
    const until = Date.now() + 5000;
    const check = async () => {
      if (startupError || await isServerReady() || Date.now() > until) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
  if (!(await isServerReady())) {
    throw new Error(startupError ? `无法启动 Python 3：${startupError.message}` : `本地服务未能在 ${port} 端口启动。请检查 Python 3 和端口占用情况。`);
  }
}

ipcMain.handle('workstation:open-auth', async (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame?.url?.split('/').slice(0, 3).join('/') !== localOrigin) throw new Error('Invalid auth sender');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Invalid OpenAI login URL');
  await shell.openExternal(url.href);
});

// Keep the lifetime decision independent of Electron so timeout, cancellation
// and stale renderer replies can be tested without launching another app.
function createDraftExitGate({ getWindow, flushWorkspace, flushDrafts, confirmFailure, approve, returned,
  schedule = setTimeout, unschedule = clearTimeout }) {
  let attempt = null, approvedWindow = null;
  const alive = token => attempt === token && getWindow() === token.window && !token.window.isDestroyed();
  const cancel = window => {
    if (attempt && (!window || attempt.window === window)) {
      unschedule(attempt.timer);
      attempt = null;
    }
    if (!window || approvedWindow === window) approvedWindow = null;
  };
  function commit(token) {
    if (!alive(token)) return;
    unschedule(token.timer);
    approvedWindow = token.window;
    attempt = null;
    approve(token.kind, token.window);
  }
  async function complete(token, success) {
    if (!alive(token) || token.phase !== 'flushing') return;
    unschedule(token.timer);
    if (success) { commit(token); return; }
    token.phase = 'decision';
    let exit = false;
    try { exit = (await confirmFailure(token.kind, token.window)) === true; }
    catch (_) { /* A missing dialog cannot authorize data loss. */ }
    if (!alive(token) || token.phase !== 'decision') return;
    if (exit) commit(token);
    else { cancel(token.window); returned(token.window); }
  }
  async function prepare(token) {
    // Preserve the previous workspace flush, with its existing bounded wait.
    // Do this first: edits made while it runs are included in the final draft
    // flush rather than trusting an acknowledgement from before that wait.
    await new Promise(resolve => {
      const timer = schedule(resolve, 2800);
      Promise.resolve().then(() => flushWorkspace(token.window)).catch(() => {}).finally(() => { unschedule(timer); resolve(); });
    });
    if (!alive(token) || token.phase !== 'flushing') return;
    token.timer = schedule(() => { void complete(token, false); }, 8000);
    try { await complete(token, (await flushDrafts(token.window)) === true); }
    catch (_) { await complete(token, false); }
  }
  return {
    begin(kind, window) {
      if (attempt && alive(attempt)) {
        // Cmd-Q while a close is waiting upgrades the same decision; it must
        // not start another flush or display another confirmation.
        if (kind === 'quit') attempt.kind = 'quit';
        return false;
      }
      cancel();
      const token = { kind, window, phase: 'flushing', timer: undefined };
      attempt = token;
      void prepare(token);
      return true;
    },
    allowsUnload: window => approvedWindow === window,
    cancel
  };
}

const desktopExitGate = createDraftExitGate({
  getWindow: () => mainWindow,
  flushWorkspace: window => window.webContents.executeJavaScript('window.flushWorkspace?.()'),
  flushDrafts: window => window.webContents.executeJavaScript('(async () => typeof window.flushLocalDrafts !== "function" ? true : (await window.flushLocalDrafts()) === true)()'),
  confirmFailure: async (kind, window) => {
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: nativeUI.text('有草稿尚未确认保存', 'Some drafts are not confirmed saved'),
      message: nativeUI.text('返回编辑并检查草稿，还是仍然离开？', 'Return to check your drafts, or leave anyway?'),
      detail: nativeUI.text('最新修改尚未确认写入本机，继续可能丢失这些修改。已保存的本机草稿、笔记与历史版本会保留；私密或无痕草稿仅在当前窗口保留。', 'The latest edits are not confirmed saved on this device and may be lost if you continue. Saved local drafts, notes and revisions are kept. Private or incognito drafts remain only in this window.'),
      buttons: [nativeUI.text('返回编辑', 'Return to editing'), kind === 'quit' ? nativeUI.text('仍然退出', 'Quit anyway') : nativeUI.text('仍然关闭', 'Close anyway')],
      defaultId: 0, cancelId: 0, noLink: true
    });
    return result.response === 1;
  },
  approve: (kind, window) => {
    if (kind === 'quit') { quitting = true; app.quit(); }
    else window.close();
  },
  returned: window => { quitting = false; if (!window.isDestroyed()) { window.show(); window.focus(); } }
});

async function createWindow() {
  await startLocalServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    title: 'AI Bro',
    icon: path.join(__dirname, 'ai-bro-icon.png'),
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#151515',
    ...(process.platform === 'darwin' ? (nativeGlass.status().supported
      ? { transparent: true }
      : { vibrancy: 'under-window', visualEffectState: 'followWindow' }) : {}),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const window = mainWindow;
  window.on('close', event => {
    if (desktopExitGate.allowsUnload(window)) return;
    event.preventDefault();
    desktopExitGate.begin('close', window);
  });
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      // A reply belonging to the previous document cannot close its successor.
      desktopExitGate.cancel(window);
      quitting = false;
    }
  });
  mainWindow.webContents.on('will-prevent-unload', event => {
    if (typeof desktopExitGate !== 'undefined' && desktopExitGate.allowsUnload(mainWindow)) { event.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question', title: nativeUI.text('有草稿尚未确认保存', 'Some drafts are not confirmed saved'),
      message: nativeUI.text('返回编辑，还是继续刷新或离开此页面？', 'Return to editing, or reload or leave this page?'),
      detail: nativeUI.text('未确认写入本机的最新修改可能丢失；已经保存的本机草稿、笔记与历史版本会保留。私密或无痕草稿仅在当前窗口保留。', 'The latest edits not confirmed saved on this device may be lost. Saved local drafts, notes and revisions are kept. Private or incognito drafts remain only in this window.'),
      buttons: [nativeUI.text('返回编辑', 'Return to editing'), nativeUI.text('仍然继续', 'Continue anyway')], defaultId: 0, cancelId: 0, noLink: true
    });
    // Electron's preventDefault explicitly allows an unload blocked by the
    // renderer. A normal refresh/navigation still requires explicit consent.
    if (typeof desktopExitGate !== 'undefined') desktopExitGate.cancel(mainWindow);
    quitting = false;
    if (choice === 1) event.preventDefault();
  });
  // Preserve the existing desktop origin and profile across upgrades.
  await mainWindow.loadURL(localOrigin);
  mainWindow.on('closed', () => { desktopExitGate.cancel(window); nativeGlass.dispose(); if (mainWindow === window) mainWindow = null; });
}

if (ownsInstance) app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: 'AI Bro', applicationVersion: APP_VERSION, iconPath: path.join(__dirname, 'ai-bro-icon.png'), credits: '学习、科研与日常的知识伙伴' });
  nativeUI.apply();
  return createWindow();
}).catch(error => {
  console.error('[workstation] startup failed', error);
  dialog.showErrorBox('AI Bro 启动失败', `${error.message}\n\n详细日志请查看启动终端。`);
  app.quit();
});
process.on('uncaughtException', error => console.error('[workstation] uncaught exception', error));
process.on('unhandledRejection', error => console.error('[workstation] unhandled rejection', error));
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
app.on('before-quit', event => {
  if (quitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) { quitting = true; return; }
  event.preventDefault();
  desktopExitGate.begin('quit', mainWindow);
});
// A beforeunload prompt may cancel quitting. Keep the backend alive until all
// windows have actually accepted shutdown, otherwise Cancel leaves a dead app.
app.on('will-quit', () => { if (localServer && !localServer.killed) localServer.kill(); });
