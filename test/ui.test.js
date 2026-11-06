const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');
const { Engine, DEFAULTS } = require('../src/engine');
const { trustedSender } = require('../src/ipcguard');
const Share = require('../src/share');

// RULE ADDED 2026-11-06 (1.1.1): the profile this test opens lives under one scratch root and is removed when the test
// exits. Electron writes a whole Chromium profile per run, and a harness that leaves it behind fills the temp folder.
// Every scratch directory this test makes lives under one root that is removed on exit, and roots left by an earlier
// run are swept (see `test/scratch.js`).
const scratchDir = require('./scratch').root;
app.setPath('userData', path.join(scratchDir, 'profile'));
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
  const calls = { autopilotArgs: 'never called', botStart: 0 };
  for (const [name, handler] of Object.entries({
    'settings:get': () => settings,
    'wallet:status': () => ({ exists: false, unlocked: false, address: null }),
    'settings:share': () => ({ code: Share.encode(settings), text: Share.describe(settings) }),
    // RULE ADDED 2026-11-05 (1.0.4): a settings button must never start trading.
    // The button must write settings and nothing else, so both channels are recorded and checked below.
    'settings:autopilot': (...args) => { calls.autopilotArgs = args; return settings; },
    'bot:start': () => { calls.botStart += 1; return { ok: true }; },
    // The connection doctor, answered from a fixture so the UI test never dials anything.
    'diag:check': () => ({
      rows: [
        { ok: true, label: 'Main node', ms: 120, detail: 'Answered in 120 ms (solana-core 2.1.0).' },
        { ok: false, label: 'Your socket', ms: 90, detail: 'Refused without a key. Copy the socket URL together with the key your provider gives for it.' },
      ],
      notes: ['No private socket or Geyser endpoint: the feed will read public nodes.'],
    }),
  })) {
    ipcMain.handle(name, (event, ...args) => {
      assert.ok(trustedSender(event, win, entry), 'real preload IPC passes the main-frame check');
      return { ok: true, data: handler(...args) };
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
  // One press of Best Profit writes the preset and stops there: no arguments on the channel that could ask for a start,
  // no call to the start channel at all, and the button says what it does.
  assert.ok(await win.webContents.executeJavaScript('document.querySelector("#autopilotBtn span").textContent.includes("Apply")'),
    'the button promises to apply settings, not to start a scan');
  await win.webContents.executeJavaScript('document.querySelector("#autopilotBtn").click()');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(calls.autopilotArgs, [], 'the preset channel is called with no start request');
  assert.equal(calls.botStart, 0, 'pressing Best Profit never starts the bot');
  assert.ok(await win.webContents.executeJavaScript('(document.querySelector("#autopilotMsg").textContent || "").includes("Press Start")'),
    'and the message says the run has to be started by hand');
  // RULE ADDED 2026-11-06 (1.0.9): the "Test my connection" button must reach the doctor and draw its answer, and it
  // must show the failing door in words rather than a silent blank.
  assert.ok(await win.webContents.executeJavaScript('Boolean(document.querySelector("#diagBtn"))'), 'the doctor has a button');
  await win.webContents.executeJavaScript('document.querySelector("#diagBtn").click()');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const diagText = await win.webContents.executeJavaScript('document.querySelector("#diagOut").textContent');
  assert.ok(/Main node/.test(diagText), 'the answer names each door: ' + diagText);
  assert.ok(/✕/.test(diagText), 'and a refused door is marked');
  assert.deepEqual(errors, []);
  clearTimeout(timer);
  console.log('Electron UI smoke test passed (hidden window, isolated mock wallet, trading stopped)');
  // The window is closed before exit, and the profile is removed on the way out. While Chromium's own children are
  // still alive this usually fails on Windows - so the sweep in `test/scratch.js` removes it at the start of the next
  // run, which is what keeps the temp folder from growing.
  win.destroy();
  try { require('fs').rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* swept by the next run */ }
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
