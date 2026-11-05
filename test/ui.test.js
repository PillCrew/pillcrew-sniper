const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');
const { Engine, DEFAULTS } = require('../src/engine');
const { trustedSender } = require('../src/ipcguard');
const Share = require('../src/share');

app.setPath('userData', require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'pillcrew-ui-')));
const timer = setTimeout(() => { console.error('UI test timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const entry = path.join(__dirname, '..', 'renderer', 'index.html');
  const win = new BrowserWindow({ show: false, width: 1320, height: 860, webPreferences: {
    preload: path.join(__dirname, '..', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  const settings = { ...DEFAULTS, onboarded: true };
  const store = { get: () => settings, set: (patch) => Object.assign(settings, patch) };
  const wallet = { exists: () => false, address: () => null, isUnlocked: () => false };
  const engine = new Engine(wallet, store);
  for (const [name, handler] of Object.entries({
    'settings:get': () => settings,
    'wallet:status': () => ({ exists: false, unlocked: false, address: null }),
    'settings:share': () => ({ code: Share.encode(settings), text: Share.describe(settings) }),
  })) {
    ipcMain.handle(name, (event) => {
      assert.ok(trustedSender(event, win, entry), 'real preload IPC passes the main-frame check');
      return { ok: true, data: handler() };
    });
  }
  const errors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  try { await win.loadURL(pathToFileURL(entry).href); } catch (err) {
    console.error('Renderer diagnostics:', { url: win.webContents.getURL(), loading: win.webContents.isLoading(), errors });
    throw err;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  engine.once('state', (state) => win.webContents.send('state', state));
  engine._emitState();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("#startBtn").disabled'), false);
  await win.webContents.executeJavaScript('document.querySelector("#nav [data-tab=settings]").click()');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(await win.webContents.executeJavaScript('document.querySelector("#tab-settings").classList.contains("active")'));
  assert.deepEqual(errors, []);
  clearTimeout(timer);
  console.log('Electron UI smoke test passed (hidden window, isolated mock wallet, trading stopped)');
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
