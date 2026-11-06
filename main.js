const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./src/store');
const { WalletManager } = require('./src/wallet');
const { Engine, DEFAULTS, PROFILES, AUTOPILOT } = require('./src/engine');
const Share = require('./src/share');
const { trustedSender } = require('./src/ipcguard');

const ALLOWED_HOSTS = new Set(['pump.fun', 'solscan.io', 'pumpportal.fun', 'pumpdev.io', 'www.pumpdev.io', 'www.helius.dev', 'helius.dev', 'phantom.app', 'solflare.com', 'pillcrew.fun', 'www.pillcrew.fun', 'developers.jup.ag', 'portal.jup.ag', 'twitter.com', 'x.com', 'api.dashboard.sol-incinerator.com', 'sol-incinerator.com']);

let win;
let wallet;
let store;
let engine;

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 820, minHeight: 620,
    backgroundColor: '#0a0516', title: 'PillCrew Sniper', autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((err) => {
    dialog.showErrorBox('PillCrew Sniper could not open', 'The interface failed to load. Check the application logs before continuing.\n\n' + err.message);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Closing the window while the desk holds real coins is allowed, because the book is saved and restored on the
  // next Start, but the user has to know that the exits stop running the moment the window closes.
  win.on('close', (e) => {
    const live = engine ? [...engine.positions.values()].filter((p) => !p.paper).length : 0;
    if (!live) return;
    const answer = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep the window open', 'Close anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Real positions are still open',
      message: `${live} real position${live > 1 ? 's are' : ' is'} still open.`,
      detail: 'The bot stops managing them when this window closes. They stay in your wallet and are picked up again the next time you press Start, but nothing will sell them while the app is closed.',
    });
    if (answer === 0) e.preventDefault();
  });
}

const wrap = (fn) => async (event, ...args) => {
  try {
    if (!trustedSender(event, win, path.join(__dirname, 'renderer', 'index.html'))) throw new Error('Untrusted IPC sender');
    return { ok: true, data: await fn(...args) };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
};

function openDiary(dir) {
  const folder = path.join(dir, 'logs');
  try { fs.mkdirSync(folder, { recursive: true }); } catch (_) { return () => {}; }
  // Fourteen days of diary answers "what happened last week" and stops the folder growing for ever: measured at
  // 3 MB on a busy day. Housekeeping only - a folder that cannot be pruned never stops a start.
  try {
    const keep = 14;
    const files = fs.readdirSync(folder).filter((f) => /^pillcrew-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(folder, f));
  } catch (_) { /* pruning is housekeeping */ }
  const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
  let day = '';
  let stream = null;
  const open = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today === day && stream) return stream;
    try { if (stream) stream.end(); } catch (_) { /* the old day is done */ }
    day = today;
    try {
      stream = fs.createWriteStream(path.join(folder, `pillcrew-${today}.log`), { flags: 'a' });
      stream.on('error', () => { stream = null; });
    } catch (_) { stream = null; }
    return stream;
  };
  const write = (level, scope, msg) => {
    const s = open();
    if (!s) return;
    const line = `${stamp(Date.now())} ${String(level || 'info').toUpperCase().padEnd(5)} [app:${scope}] ${msg}\n`;
    try { s.write(line); } catch (_) { /* never a reason to stop trading */ }
  };
  write('info', 'app', `PillCrew Sniper ${app.getVersion()} starting (${process.platform}/${process.arch})`);
  return write;
}

let diary = () => {};

// Replacing or removing the wallet is the one action that can lose money that is still on chain, so it is
// blocked while the bot is trading and while a real position is open.
const openLivePositions = () => [...engine.positions.values()].filter((p) => !p.paper).length;
function guardWalletChange(replace) {
  if (!replace) return;
  if (engine.running) throw new Error('Stop the bot before replacing the wallet.');
  if (openLivePositions()) throw new Error('Close or sell the open positions first.');
}

app.whenReady().then(() => {
  const dir = app.getPath('userData');
  diary = openDiary(dir);
  store = new Store(dir, 'settings.json', DEFAULTS);
  // Settings that no longer exist: the Jupiter route and the price service need no key, and the old market switch
  // was replaced by `wideDiscovery`.
  store.unset(['useJupiter']);
  wallet = new WalletManager(dir);
  engine = new Engine(wallet, store);

  engine.on('state', (s) => { if (win && !win.isDestroyed()) win.webContents.send('state', s); });
  // The open positions travel on their own channel, far more often than the rest of the window: a percentage on
  // screen has to move with the market, not with the slowest panel on the page.
  engine.on('positions', (list) => { if (win && !win.isDestroyed()) win.webContents.send('positions', list); });
  engine.on('log', (l) => {
    if (win && !win.isDestroyed()) win.webContents.send('log', l);
    // Every line the window shows is also written to disk, so a session can be read after the fact.
    const scope = l.level === 'buy' || l.level === 'sell' ? 'trade' : 'engine';
    diary(l.level === 'buy' || l.level === 'sell' ? 'info' : l.level, scope, l.msg);
  });

  const walletInfo = () => ({ exists: wallet.exists(), unlocked: wallet.isUnlocked(), address: wallet.address(), damaged: wallet.damaged || null });

  ipcMain.handle('wallet:status', wrap(async () => walletInfo()));
  ipcMain.handle('wallet:create', wrap(async (pw, replace) => {
    guardWalletChange(replace);
    wallet.create(pw, { replace: Boolean(replace) });
    engine.refreshBalance();
    return walletInfo();
  }));
  ipcMain.handle('wallet:import', wrap(async (key, pw, replace) => {
    guardWalletChange(replace);
    wallet.importKey(key, pw, { replace: Boolean(replace) });
    engine.refreshBalance();
    return walletInfo();
  }));
  ipcMain.handle('wallet:reset', wrap(async () => {
    if (engine.running) throw new Error('Stop the bot before removing the wallet.');
    if (openLivePositions()) throw new Error('Close or sell the open positions first.');
    wallet.reset();
    return walletInfo();
  }));
  ipcMain.handle('wallet:unlock', wrap(async (pw) => {
    wallet.unlock(pw);
    engine.refreshBalance();
    // Coins bought in an earlier session belong on the panel the moment the wallet opens, not only after Start:
    // a saved position is restored and any holding the book never knew about is adopted.
    if (store.get().mode === 'live') await engine.recoverBook();
    return walletInfo();
  }));
  ipcMain.handle('wallet:lock', wrap(async () => {
    // Locking while an exit is still owed strands it: every sell would fail on a locked wallet.
    if (openLivePositions()) throw new Error('Close or sell the open positions first.');
    wallet.lock();
    return walletInfo();
  }));
  ipcMain.handle('wallet:export', wrap(async (pw) => wallet.exportPrivateKey(pw)));
  // A password check that does not hand the secret to the renderer. Everything that only needs proof of ownership
  // uses this, so the key never crosses the bridge for a mere confirmation.
  ipcMain.handle('wallet:verify', wrap(async (pw) => wallet.verify(pw)));
  ipcMain.handle('wallet:withdraw', wrap(async (to, amount, pw) => {
    if (openLivePositions()) throw new Error('Close or sell the open positions first.');
    if (engine.running && store.get().mode === 'live') throw new Error('Stop the bot before withdrawing.');
    // The reserve pays the exit fees, so a withdrawal may never take it: a wallet that cannot pay a fee holds coins
    // it can no longer sell, and that is the one state no setting may create.
    const reserve = engine.reserveForFees();
    const bal = Number(engine.walletBalance || 0);
    const left = bal - Number(amount || 0);
    if (Number(amount) > 0 && left < reserve) {
      throw new Error(`That would leave ${Math.max(0, left).toFixed(4)} SOL, under the ${reserve.toFixed(4)} SOL the bot keeps for network fees. Send at most ${Math.max(0, bal - reserve).toFixed(4)} SOL.`);
    }
    const r = await wallet.withdraw((fn, opts) => engine.rpcCall(fn, opts), to, amount, pw);
    engine.refreshBalance();
    return r;
  }));

  ipcMain.handle('settings:get', wrap(async () => store.get()));
  function cleanSettings(patch) {
    const allowed = Object.keys(DEFAULTS);
    const clean = {};
    const LIMITS = {
      buyAmountSol: [0.001, 5], maxPositions: [1, 50], slippagePct: [1, 90], priorityFeeSol: [0.000001, 0.05],
      paperLatencyMs: [0, 10000], paperBaseSlippagePct: [0, 50], paperUnknownImpactPct: [0, 90], paperFailurePct: [0, 100], paperSeed: [0, 4294967295],
      jitoTipSol: [0.000001, 0.01], sessionLossLimitSol: [0.001, 5], maxHoldSec: [5, 3600],
      stopLossPct: [0, 95], takeProfitPct: [1, 5000], trailArmPct: [0, 5000], trailGivePct: [0, 5000],
      tp1Pct: [0, 5000], tp1SellPct: [0, 100], triggerHoldMs: [0, 10000], maxBuysPerMin: [1, 600],
      maxLossStreak: [1, 100], pauseMinutes: [0, 1440], watchSec: [0, 600], minChange5mPct: [0, 5000],
      maxChange5mPct: [0, 5000], minHolders: [0, 1000000], maxBuyers: [0, 100000],
      // The two clocks a sniping desk lives by, and the fee gate. The round trip can never be switched off - a 5%
      // floor keeps a typo from turning the desk into a machine that pays its own tips.
      minTokenAgeSec: [0, 86400], maxTokenAgeSec: [0, 86400], maxRoundTripPct: [5, 90],
    };
    // `openPositions` is the engine's own book on disk. The renderer must never be able to rewrite it.
    const INTERNAL = new Set(['openPositions']);
    for (const [k, v] of Object.entries(patch || {})) {
      if (!allowed.includes(k) || INTERNAL.has(k)) continue;
      const want = typeof DEFAULTS[k];
      if (typeof v !== want) throw new Error('Invalid value for ' + k);
      if (want === 'number') {
        if (!Number.isFinite(v)) throw new Error('Invalid number for ' + k);
        // No setting in this app is meaningful as a negative number, and a negative one is how a mistyped or hostile
        // code turns a rule inside out (a -20% stop is a target).
        if (v < 0) throw new Error(`${k} cannot be negative`);
        const lim = LIMITS[k]; if (lim && (v < lim[0] || v > lim[1])) throw new Error(`${k} must be between ${lim[0]} and ${lim[1]}`);
      }
      if (k === 'feedSource' && !['auto', 'chain', 'pumpdev', 'pumpportal', 'geyser'].includes(v)) throw new Error('Unknown data feed');
      if (k === 'geyserUrl') {
        const u = String(v || '').trim();
        if (u && !/^(wss|ws|https|http):\/\//.test(u)) throw new Error('The Geyser endpoint must start with wss://, ws://, https:// or http://');
        clean[k] = u;
        continue;
      }
      if (k === 'geyserToken') {
        const t = String(v || '').trim();
        if (!/^[A-Za-z0-9._\-]{0,200}$/.test(t)) throw new Error('That Geyser token has invalid characters. Paste only the token.');
        clean[k] = t;
        continue;
      }
      // A copy roster is a list of wallet addresses typed by hand: keep only the ones that could be a Solana address, and
      // refuse the whole save if nothing usable is left, instead of writing a list that silently follows nobody.
      if (k === 'copyWallets') {
        const list = String(v).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
        const bad = list.filter((x) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x));
        if (bad.length) throw new Error(`That is not a Solana address: ${bad[0].slice(0, 12)}…`);
        if (list.length > 20) throw new Error('Follow at most 20 wallets.');
        clean[k] = list.join(' ');
        continue;
      }
      clean[k] = v;
    }
    return clean;
  }
  ipcMain.handle('settings:set', wrap(async (patch) => {
    const clean = cleanSettings(patch);
    // Switching either way mid-run changes which book the screen shows while real positions are still moving, so
    // the mode is frozen while the bot runs.
    if (clean.mode && clean.mode !== store.get().mode && engine.running) throw new Error('Stop the bot before switching modes.');
    if (clean.mode && clean.mode !== 'live' && clean.mode !== 'paper') delete clean.mode;
    for (const k of ['incineratorKey', 'pumpdevKey', 'jupiterKey']) {
      if (k in clean) {
        const v = String(clean[k] || '').trim();
        if (!/^[A-Za-z0-9._\-]{0,200}$/.test(v)) throw new Error('That API key has invalid characters. Paste only the key.');
        clean[k] = v;
      }
    }
    if (clean.feedSource && !['auto', 'chain', 'pumpdev', 'pumpportal', 'geyser'].includes(clean.feedSource)) delete clean.feedSource;
    if (clean.rpcUrl && !/^https:\/\//.test(clean.rpcUrl)) throw new Error('RPC URL must start with https:// (or leave empty for automatic)');
    if (clean.rpcBackupUrl && !/^https:\/\//.test(clean.rpcBackupUrl)) throw new Error('The backup RPC URL must start with https:// (or leave it empty)');
    if (clean.rpcWsUrl && !/^wss?:\/\//.test(clean.rpcWsUrl)) throw new Error('The WebSocket URL must start with wss:// (or leave it empty)');
    for (const k of ['rpcUrl', 'rpcBackupUrl', 'rpcWsUrl']) if (k in clean) clean[k] = String(clean[k] || '').trim();
    // A node list is applied to the running desk at once: otherwise a corrected URL only took effect after a restart,
    // and the log kept naming the node that had been replaced.
    const switched = ['rpcUrl', 'rpcBackupUrl', 'rpcWsUrl'].some((k) => k in clean);
    if (switched) {
      engine.rpc.setCustoms([clean.rpcUrl ?? store.get().rpcUrl, clean.rpcBackupUrl ?? store.get().rpcBackupUrl]);
    }
    return store.set(clean);
  }));
  ipcMain.handle('settings:profile', wrap(async (name) => {
    if (!Object.prototype.hasOwnProperty.call(PROFILES, name)) throw new Error('Unknown profile');
    return store.set({ profile: name, ...PROFILES[name] });
  }));
  // RULE CHANGED 2026-11-05 (1.0.4, the owner: "BEST PROFIT setting ma tylko ustawienia ustawiać a nie startować bota"):
  // this handler wrote the preset and then pressed Start itself, so one press in Practice mode began trading. A settings
  // button that starts a bot is a trap - the same press in Real Money would have moved real money - so the start is gone
  // and the argument is ignored on purpose.
  ipcMain.handle('settings:autopilot', wrap(async () => {
    if (engine.running) throw new Error('Stop the bot first, then apply the preset.');
    const cap = Math.min(store.get().sessionLossLimitSol, AUTOPILOT.sessionLossLimitSol);
    return store.set({ ...AUTOPILOT, marketScan: true, wideDiscovery: true, sessionLossLimitSol: cap });
  }));
  ipcMain.handle('stats:reset', wrap(async (mode) => engine.resetStats(mode)));

  // A settings code for sharing on X: it carries the entry bar and the exit plan, never a key, an RPC URL, the mode
  // or an open position. Applying one goes through the same validation as typing the numbers by hand.
  ipcMain.handle('settings:share', wrap(async () => ({
    code: Share.encode(store.get()),
    text: Share.describe(store.get()),
  })));
  ipcMain.handle('settings:applyShared', wrap(async (code) => {
    if (engine.running) throw new Error('Stop the bot first, then apply a code.');
    const { profile, values } = Share.decode(code);
    const allowed = new Set(Share.SHARE_KEYS);
    const shared = {};
    for (const [k, v] of Object.entries(values)) if (allowed.has(k)) shared[k] = v;
    // The code stores every setting as a number, including the on/off switches (1/0): they are read back as real
    // booleans before the typed-path validation checks their type.
    for (const k of Object.keys(shared)) if (typeof DEFAULTS[k] === 'boolean') shared[k] = Boolean(Number(shared[k]));
    // The same gate the typed path uses: a code from a stranger may not carry a negative stop, a 5 SOL tip or a
    // 900-coin position limit into this desk.
    const clean = cleanSettings(shared);
    if (PROFILES[profile]) clean.profile = profile;
    // The ticket is the one number a stranger must not set for you: it is your money, so it is kept unless the code's
    // value is smaller than yours, in which case the smaller one is the safer reading of the same plan.
    const mine = Number(store.get().buyAmountSol) || 0;
    if (!(Number(clean.buyAmountSol) > 0) || (mine > 0 && Number(clean.buyAmountSol) > mine)) clean.buyAmountSol = mine;
    return store.set(clean);
  }));

  ipcMain.handle('bot:start', async (event) => {
    if (!trustedSender(event, win, path.join(__dirname, 'renderer', 'index.html'))) return { ok: false, error: 'Untrusted IPC sender' };
    try { return await engine.start(); } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('bot:stop', wrap(async () => engine.stop()));
  ipcMain.handle('bot:sell', wrap(async (mint) => engine.sellPosition(mint)));
  ipcMain.handle('bot:sellAll', wrap(async () => engine.sellAll()));
  // Undo a pause now instead of waiting it out. The pause itself is a rule (a cold streak, or a hand on Sell every
  // coin); the keeper's own decision to go on is not one the app should argue with.
  ipcMain.handle('bot:resume', wrap(async () => engine.resumeEntries()));
  ipcMain.handle('bot:resetPractice', wrap(async () => engine.resetPractice()));

  ipcMain.handle('reclaim:scan', wrap(async () => engine.scanWallet()));
  ipcMain.handle('reclaim:close', wrap(async () => engine.closeEmptyAccounts()));
  ipcMain.handle('wallet:sellEverything', wrap(async () => engine.sellEverything()));
  ipcMain.handle('wallet:sellHolding', wrap(async (mint) => engine.sellHolding(mint)));
  ipcMain.handle('inc:closeAll', wrap(async () => engine.incineratorCloseAll()));
  ipcMain.handle('inc:burn', wrap(async (mint) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(mint))) throw new Error('Invalid token address.');
    return engine.incineratorBurn(String(mint));
  }));

  ipcMain.handle('open:external', wrap(async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error('Blocked link');
    await shell.openExternal(u.toString());
  }));

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
