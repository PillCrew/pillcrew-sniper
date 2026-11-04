const EventEmitter = require('events');
const WebSocket = require('ws');
const { PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { RPCManager } = require('./rpc');
const { ChainFeed } = require('./chain');
const { Jupiter, WSOL } = require('./jupiter');
const { Jito, MIN_TIP_LAMPORTS } = require('./jito');
const { readCurves } = require('./curve');
const { Market } = require('./market');
const { Incinerator } = require('./incinerator');
const { assertCleanupTx, assertSwapTx, readTx, lamportsOut } = require('./txguard');
const reclaim = require('./reclaim');

const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';
const PUMPDEV_WS = 'wss://pumpdev.io/ws';
const TRADE_URL = 'https://pumpportal.fun/api/trade-local';
const FEE = 0.015;
const PAPER_SLIP = 0.01;
const HARD_MAX_SOL_PER_TRADE = 5;
const MARKET_EVERY_MS = 3000;
const HOT_EVERY_MS = 1000;
// Open positions are repriced on their own short cadence: one small request that covers every coin held, and the
// difference between a stop that reacts at the price it saw and one that fills a second later.
const POS_EVERY_MS = 150;
const HOT_BATCH = 30;
const TICK_MS = 50;
// A price that moves further than this between two readings is treated as a possible bad quote on a thin pool and
// has to be seen twice before it closes a position. Anything smaller, or anything the trade stream corroborates,
// is acted on immediately.
const MAX_TICK_JUMP_PCT = 40;
// A quote older than this is not a price: it is the last thing known about the coin. A held position is priced from
// the curve while the stream talks, from the price service while it answers, and from the board when neither does -
// and a reading that none of the three refreshed inside this window is left alone rather than acted on.
const PX_STALE_MS = 6000;
// How often the bonding curve itself is read for coins whose stream is quiet and whose price service answer is gone.
// One `getMultipleAccountsInfo` for every coin held, so the cost is a single request, not one per position. A held
// coin is the one place where a tenth of a second of price is worth a request: a risk rule can only fire on a reading
// it has seen, so this interval is the floor under how fast a stop can answer.
const CURVE_EVERY_MS = 120;
// How far the pool may sit below the board price before an entry is refused: past this the row we judged is behind a
// fall that is happening right now, and buying it is buying a coin on its way down (see `_entryPrice`).
const BOARD_STALE_FRAC = 0.08;
// A curve reading that is more than this multiple above the price the position is measured at is not taken on its own:
// two readings that agree are needed first (see `_pollPositions`). A fall is never held back - a stop has to fire.
const CURVE_JUMP_UP = 3;
// How old the last thing heard about a coin may be before its board price stops being a price to buy on, when no
// bonding curve could be read for it.
const ENTRY_PX_MAX_AGE_MS = 30000;
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const FEE_FLOOR_SOL = 0.00005;
const FEE_CU_ESTIMATE = 150000;
const MIN_SLIP = 3;
// A stop or a target must land on the first order: the tolerance on an exit is not a promise about the price, it is
// the promise that the coins leave. Measured live: a refused stop cost 1.2 s of re-quoting while the coin fell.
const EXIT_SLIP_MIN = 20;
const EXIT_SLIP_MAX = 40;
// A runner far above its target used to be given the whole 40% in exchange for one round trip. Measured on a spike,
// that is how a position at +40% filled at -30%: the tolerance did not make the fill better, it only removed the floor
// under it. A spike now gets this much, and a fill beyond it is refused - the trailing stop and the break even are the
// rules for a coin on its way down, not a wide market order.
// The tolerance an exit in profit is given, instead of the wide 20-40% a losing exit needs in order to fill at all.
// Measured live, a coin that peaked at +70% was given 40% and filled at -5%: a wide tolerance does not fill better on
// a coin that is up, it only removes the floor.
const SPIKE_SLIP = 15;
// How long a stop loss has to be seen before it sells, however long `triggerHoldMs` is. A profit rule is waiting for a
// spike to prove itself; a stop is watching money leave. Measured on a falling coin, holding the level for 400 ms first
// booked a 10% stop at -26% and a 22% stop at -37%, because 400 ms is a fifth of the move. The guards against a bad
// print are elsewhere and they still hold: the price has to be a fresh reading, a quote that jumps is not believed, and
// the sale is abandoned when the coin is already back above water by the time the order is ready.
const STOP_HOLD_MS = 150;
// How much of a peak the trailing stop gives back, as a share of the peak itself (see `_trailGive`). The floor is the
// profile's `trailGivePct`.
const TRAIL_GIVE_FRAC = 0.45;
// The rules that are watching money leave rather than waiting for a move to prove itself. Their hold is
// `STOP_HOLD_MS` at most (see `_riskHoldMs`), never the profit rule's `triggerHoldMs`.
const RISK_RULES = new Set(['Stop loss', 'Trailing stop', 'Break even']);
const TX_GUARD_MAX_SOL = 0.01;
const MAX_TRACKED = 400;
const ENRICH_PER_CYCLE = 90;
const SCAN_PER_TICK = 40;
const TRADES_KEPT = 240;
const SUB_BUDGET = 20;
// A stream that has been quiet this long is not the price any more: the coin graduated, the feed dropped it or
// the chain feed fell back to launches only. Open positions switch to the market board after this.
const STREAM_FRESH_MS = 15000;
// A broadcast that has not answered in about a second is useless to a sniper; the same signed bytes can
// safely be sent again, so the budget is deliberately short.
const BROADCAST = { timeoutMs: 1500, attempts: 3, budgetMs: 4500 };
const CONFIRM_POLLS = 40;
// Rent locked by a fresh token account, returned when the account is closed after the sell.
const TOKEN_RENT_SOL = 0.00204;
// The rent-exempt floor plus a fee and a tip per open position: never spent on an entry, so anything bought can
// always pay for its own way out (measured: the wallet hit 0.00066 SOL and no exit could be submitted).
const MIN_WALLET_RESERVE_SOL = 0.002;
// A wallet may not drop under the rent-exempt minimum, and a transaction that would do it is refused by the runtime
// with InsufficientFundsForRent - the fee included. The reserve is that floor plus a fee and a tip for every open
// position, so a wallet with little SOL can always pay its own way out of everything it holds.
const RENT_EXEMPT_SOL = 0.00089;
// A wallet under this cannot pay for an exit at all: the rent-exempt floor is 0.00089 SOL and the runtime refuses
// any transaction that would leave the fee payer below it.
const EXIT_FEE_FLOOR_SOL = 0.0012;

/**
 * A profile is a whole plan: what the coin must look like, and how the position is closed.
 *
 * Every percentage here is measured NET of everything a round trip costs - the protocol both ways plus the tips - so
 * the number the window shows is the number the rules use. That matters most on a small ticket, where the tips are a
 * fixed amount: at 0.004 SOL a 10% stop is reached only when the price has fallen about 23%, because the first 13%
 * of any move goes on paying for the round trip.
 * That is why no profile carries a break-even rule any more. At a net zero the trade has paid its costs and earned
 * nothing, the fill lands under the reading that triggered it, and it pre-empts the trailing stop, which sells at
 * arm - give, above water by construction. A rule that sells the winners early and books a small loss is worse than
 * no rule at all.
 *
 * The shape is what decides whether a desk makes money, and it is asymmetric on purpose: many small losses, a few
 * large wins. Measured in paper on the live market with a fixed 4-point trail and a 28% target, every profit rule
 * closed between +6% and +12% while the losses filled at -21% to -33% - a shape that no entry rule can rescue. So a
 * winner is now banked in part early (`tp1Pct`) and the rest is a RUNNER, trailed by a share of its own peak
 * (`_trailGive`), with room that grows as the move grows. The stop stays tight and fast, because it is the only rule
 * that touches losers.
 */
const PROFILES = {
  safe: {
    minScore: 70, minBuyers: 6, minNetFlowSol: 2, minMcSol: 20, maxMcSol: 80,
    takeProfitPct: 60, stopLossPct: 6, maxHoldSec: 150, slippagePct: 8, priorityFeeSol: 0.0002,
    tp1Pct: 18, tp1SellPct: 50, trailArmPct: 14, trailGivePct: 8, breakEvenPct: 0,
  },
  balanced: {
    minScore: 64, minBuyers: 6, minNetFlowSol: 1.5, minMcSol: 20, maxMcSol: 150,
    takeProfitPct: 90, stopLossPct: 9, maxHoldSec: 200, slippagePct: 10, priorityFeeSol: 0.0002,
    tp1Pct: 22, tp1SellPct: 40, trailArmPct: 18, trailGivePct: 12, breakEvenPct: 0,
  },
  aggressive: {
    minScore: 50, minBuyers: 4, minNetFlowSol: 0.8, minMcSol: 15, maxMcSol: 250,
    takeProfitPct: 150, stopLossPct: 12, maxHoldSec: 300, slippagePct: 15, priorityFeeSol: 0.0006,
    tp1Pct: 30, tp1SellPct: 30, trailArmPct: 22, trailGivePct: 15, breakEvenPct: 0,
  },
};
const DEFAULTS = {
  mode: 'paper',
  profile: 'balanced',
  buyAmountSol: 0.02,
  maxPositions: 4,
  maxBuysPerMin: 20,
  watchSec: 2,
  entryWindowSec: 40,
  trendMode: true,
  sessionLossLimitSol: 0.35,
  marketScan: true,
  // The wide doors: the DexScreener search board and GeckoTerminal's newest pools, on top of the launch feeds. They
  // carry coins no trending list shows, which is most of what a sniper has to choose from.
  wideDiscovery: true,
  pumpdevKey: '',
  incineratorKey: '',
  autoReclaim: true,
  // Leftovers that neither door can sell are worth less than the rent their account holds: burning them and closing
  // the account returns about 0.00204 SOL each. Off means they are left alone.
  recoverDust: true,
  feedSource: 'auto',
  smartFees: true,
  // Jito: offer every signed trade to the block engine's auction as well, with a tip that is only paid if the bundle
  // lands. Off by default - it costs SOL on the trades that land, and the public RPC already works without it.
  useJito: false,
  jitoTipSol: 0.0001,
  maxDevBuySol: 3,
  maxDevHoldPct: 35,
  // A coin that finished its curve trades on PumpSwap, a different program with different liquidity. The route to
  // it is unreliable from a keyless build, so it is off until the user asks for it.
  allowGraduated: false,
  maxTraderSharePct: 45,
  maxChange5mPct: 0,
  minChange5mPct: 0,
  // Extra entry filters: minimum holders and the market cap band shown in the same panel. Off until the user turns
  // the switch on; while on, a coin with fewer holders than the bar is never bought, and neither is a coin whose
  // holder count cannot be read - a filter that silently passes when its data source is down is not a filter.
  deepEntry: false,
  minHolders: 0,
  // Simple settings: when on, only the basic numbers apply - the market cap band, the buyer floor and ceiling, and
  // a price that is not falling. Every advanced rule (score, net flow, depth, dev bags, five minute band, holder
  // bar, first rung, trailing stop, break even) is deliberately off, because that is the whole point of choosing it.
  simpleMode: false,
  maxBuyers: 0,
  minLiqUsd: 1500,
  // A price rule has to hold this long, on fresh readings, before it may sell: the safeguard against a spike that is
  // gone before the order lands. Measured live, a coin showed +135% for a moment and the sale filled at -3%.
  triggerHoldMs: 400,
  openPositions: [],
  maxLossStreak: 4,
  pauseMinutes: 5,
  rpcUrl: '',
  onboarded: false,
  ...PROFILES.balanced,
};

/**
 * The one press preset. It is the plan that survived measurement, written in the same net-of-everything percentages the
 * rules use. Three things decide whether a small desk makes money, and all three are in here:
 *
 *  - the ENTRY: a coin already up 35% in five minutes is somebody else's exit, and a coin that has not moved at all has
 *    nothing to join. The preset buys inside a band (4-35% up in 5 minutes) with high bars (score 68, eight buyers, 2
 *    SOL of net buying), and the entry is priced at the bonding curve, not at a board row that may be a minute old;
 *  - the SALE: SEVENTY percent is banked at +18% net. Measured over several sessions on the live market, a coin that
 *    reaches +20% comes back more often than it runs: a forty percent rung left most of the ticket to give everything
 *    back, and one measured coin peaked at +84% and closed at -9% because the bid vanished in one reading. The smaller
 *    sell sizes were structurally unable to pay for a loss of ten, so the rung is the win and everything after it is a
 *    bonus;
 *  - the RUNNER: the remaining 30% is trailed by 45% of its own peak (arm +12%, floor 8 points) with a +130% moon
 *    target, so the rare coin that does run is not sold at the first wobble.
 */
const AUTOPILOT = {
  profile: 'balanced',
  minScore: 68,
  minBuyers: 8,
  minNetFlowSol: 2,
  minMcSol: 20,
  maxMcSol: 150,
  takeProfitPct: 130,
  stopLossPct: 9,
  maxHoldSec: 240,
  slippagePct: 12,
  priorityFeeSol: 0.0002,
  trailArmPct: 12,
  trailGivePct: 8,
  tp1Pct: 18,
  tp1SellPct: 70,
  breakEvenPct: 0,
  triggerHoldMs: 400,
  minLiqUsd: 2000,
  maxDevHoldPct: 30,
  maxDevBuySol: 3,
  maxTraderSharePct: 40,
  maxChange5mPct: 35,
  // The floor of the same band: a launch that has not moved yet is where a move starts. Measured in paper, entries at
  // the top of a five minute push were the ones that stopped out within seconds.
  minChange5mPct: 4,
  // The extra entry filters, on: a coin needs this many holders to be bought at all. Distribution is the slow
  // signal that separates a coin people are in from a coin only its creator is in.
  deepEntry: true,
  minHolders: 25,
  maxPositions: 1,
  maxBuysPerMin: 10,
  sessionLossLimitSol: 0.35,
  maxLossStreak: 5,
  pauseMinutes: 8,
  watchSec: 3,
  entryWindowSec: 45,
  marketScan: true,
  smartFees: true,
  autoReclaim: true,
  recoverDust: true,
  trendMode: true,
  feedSource: 'auto',
  wideDiscovery: true,
};

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const emptyBook = () => ({ trades: 0, wins: 0, losses: 0, pnl: 0, sessionPnl: 0 });

class Engine extends EventEmitter {
  constructor(wallet, store) {
    super();
    this.wallet = wallet;
    this.store = store;
    this.tokens = new Map();
    this.positions = new Map();
    this.history = [];
    this.logs = [];
    this.running = false;
    this.connected = false;
    this.ws = null;
    this.wantWs = false;
    this._subbed = new Set();
    this.walletBalance = null;
    this.paper = { balance: 5 };
    // Practice money and real money are kept apart, so a bad practice session can never flatter or ruin the
    // real win rate, and each book can be reset on its own.
    this.books = { paper: emptyBook(), live: emptyBook() };
    // `entryPx` says where the entry price really came from: the pool, the board, or a refusal. It is the number that
    // decides whether the entry fix is actually in effect - a public node that answers "too many requests" silently
    // drops every entry back to the board, and then the desk is buying blind again without saying so.
    this.stats = { seen: 0, lastLatencyMs: null, lastSellMs: null, reclaimedSol: 0, launches: 0, feeSpentSol: 0, orderFails: 0, entryPx: { curve: 0, board: 0, refused: 0 } };
    // Said in the log panel, once, when the settings file was damaged or unreadable: the app is then running on
    // defaults, and that is something the person has to know before pressing Start.
    if (store && store.damaged) this._log('error', 'Settings: ' + store.damaged);
    this.launchTimes = [];
    this.buyTimes = [];
    this.cooldowns = new Map();
    // Coins waiting for their leftover to be sold and their rent freed. Two exits can finish in the same second
    // (Sell all, two time limits at once) and both must be settled, so a settle that finds another one running joins
    // this queue instead of being dropped.
    this._settleQueue = new Set();
    // Mints whose curve is not quoted in SOL: no tolerance or route can fill them, so they are remembered for the
    // session instead of being re-ordered (and re-paid for) every time the market board scores them again.
    this._unsupported = new Set();
    this.jup = new Jupiter();
    this.jito = new Jito();
    this.market = new Market({
      onError: (e) => this._marketError(e),
    });
    this.inc = new Incinerator(() => this.s.incineratorKey);
    this.rpc = new RPCManager({
      custom: store.get().rpcUrl,
      onSwitch: (from, to, why) => this._log('warn', `RPC switched (${why}): ${new URL(to).hostname}`),
    });
    this._loop = null;
    this._ui = setInterval(() => this._emitState(), 400);
    // The open positions are pushed on their own, twenty times a second, and only when a price really moved. Waiting
    // for the whole window (five times slower) is what made the panel look frozen while the market was moving.
    this._pxTimer = setInterval(() => this._pushPositions(), 50);
    this._bal = setInterval(() => this.refreshBalance(), 6000);
    setTimeout(() => this.refreshBalance(), 500);
  }

  get s() { return this.store.get(); }

  /** Run an RPC call with automatic node failover. */
  rpcCall(fn, opts) { this.rpc.setCustom(this.s.rpcUrl); return this.rpc.call(fn, opts); }

  async refreshBalance() {
    const addr = this.wallet.address();
    if (!addr) { this.walletBalance = null; return; }
    try {
      const lamports = await this.rpcCall((c) => c.getBalance(new PublicKey(addr)));
      this.walletBalance = lamports / 1e9;
      // Orders placed more than a moment ago are inside this reading; anything newer may still be in flight and
      // stays counted against the wallet so a burst cannot spend the same lamports twice.
      const cut = Date.now() - 1200;
      this._spends = (this._spends || []).filter((x) => x.ms > cut);
    } catch (_) { /* RPC hiccup - keep last value */ }
  }

  _balance() { return this.s.mode === 'live' ? (this.walletBalance || 0) : this.paper.balance; }

  /** SOL that an order has committed but the next balance reading may not show yet. */
  _pendingSpend() {
    const now = Date.now();
    this._spends = (this._spends || []).filter((x) => now - x.ms < 60000);
    return this._spends.reduce((n, x) => n + x.sol, 0);
  }

  _noteSpend(sol) {
    (this._spends || (this._spends = [])).push({ ms: Date.now(), sol });
  }

  /** SOL the desk always keeps: the rent floor plus a fee and a tip for every open position. No entry may spend it. */
  _reserveSol() {
    const open = [...this.positions.values()].filter((p) => !p.paper).length;
    const perExit = (Number(this.s.priorityFeeSol) || 0.0002) + 0.0001;   // the tip, the fee, and one retry
    const needs = RENT_EXEMPT_SOL + perExit * Math.max(1, open) + 0.0004;
    return Math.max(MIN_WALLET_RESERVE_SOL, Math.round(needs * 1e9) / 1e9);
  }

  /** SOL an entry may really spend: balance minus orders still in flight minus the reserve. Without it a burst of
   *  buys drained the wallet past the point where it could pay a network fee (measured at 0.00066 SOL). */
  _freeSol() {
    if (this.s.mode !== 'live') return this._balance();
    return Math.max(0, this._balance() - this._pendingSpend() - this._reserveSol());
  }

  _log(level, msg) {
    const entry = { ts: Date.now(), level, msg };
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.shift();
    this.emit('log', entry);
  }

  resetPractice() {
    this.paper.balance = 5;
    this.resetStats('paper');
  }

  /** Clears one book. Positions that are open stay open; only the numbers behind them are forgotten. */
  resetStats(mode) {
    const key = mode === 'live' ? 'live' : 'paper';
    this.books[key] = emptyBook();
    this.history = this.history.filter((h) => (key === 'live' ? h.paper : !h.paper));
    // The pause belongs to the book that earned it: clearing the practice numbers must not hand the real desk a
    // fresh licence to trade after three real losses.
    if (key === (this.s.mode === 'live' ? 'live' : 'paper')) {
      this.lossStreak = 0;
      this.pausedUntil = 0;
    }
    this._log('info', key === 'live' ? 'Real money statistics cleared.' : 'Practice statistics cleared.');
    return this.books[key];
  }

  async start(opts = {}) {
    if (this.running) return { ok: true };
    const s = this.s;
    // An engine started without a network must not wait for one: the entry price falls back to the coin's own trade
    // stream instead of asking a bonding curve nobody can reach (see `_entryPrice`).
    this.offline = Boolean(opts.offline);
    if (!opts.offline && s.mode === 'live') {
      if (!this.wallet.isUnlocked()) return { ok: false, error: 'Unlock your wallet first (Wallet tab).' };
      await this.refreshBalance();
      if (this.walletBalance == null) {
        return { ok: false, error: 'Your wallet balance could not be read. Check the network or set an RPC URL in Settings, then press Start again.' };
      }
      // The only number that cannot lie about a session: what the wallet holds now against what it held at the start.
      // Every wasted tip, every rejected order and every fee is inside it, which a sum of trades can never show.
      this.sessionStart = { at: Date.now(), balance: this.walletBalance };
      // The saved positions come back first, because they are money that is already on chain: a wallet whose free
      // SOL sits in open positions and their rent must still be able to manage them, and must still show them.
      await this._restorePositions();
      await this._adoptOnChain();
      // The reserve is what pays the exits, so a wallet that cannot hold it is holding coins it cannot sell. With
      // nothing open the ticket is asked for as well, otherwise the bot would start only to refuse every entry.
      const needed = this.positions.size ? 0 : this._reserveSol() + this._cashNeeded();
      if (this.walletBalance < needed) {
        return {
          ok: false,
          error: `Not enough SOL in your wallet: ${needed.toFixed(4)} SOL covers the buy, its rent and the reserve that pays the exit fee. Deposit SOL or switch to Practice Mode.`,
        };
      }
      // Coins that are already bought are always shown and always managed, whatever the balance: the reserve is a
      // rule about spending, never about being able to sell. If there is nothing for the fee, it is said in words.
      if (this.positions.size && this.walletBalance < EXIT_FEE_FLOOR_SOL) this._warnNoFeeSol();
    }
    this.running = true;
    this.books[this.s.mode === 'live' ? 'live' : 'paper'].sessionPnl = 0;
    this._log('info', s.mode === 'live' ? 'Bot started in REAL MONEY mode.' : 'Bot started in Practice Mode (no real money).');
    if (!opts.offline) { this._connect(); this._startMarket(); }
    if (!this._loop) this._loop = setInterval(() => this._tick(), TICK_MS);
    return { ok: true };
  }

  /** SOL one entry really needs: the ticket, the tip, and the rent for the token account the buy creates. The exit
   *  fees are not in here - they live in `_reserveSol()`, which no entry may touch. */
  _cashNeeded() {
    return Math.min(this.s.buyAmountSol, HARD_MAX_SOL_PER_TRADE) + (this.s.priorityFeeSol || 0) + TOKEN_RENT_SOL + 0.0005;
  }

  /** Positions are written to disk on every change: a crash must not leave coins nobody is managing. On the next
   *  Start the book is rebuilt against the wallet - adopted if the tokens are there, dropped if they are not. */
  _persistPositions() {
    // Every structural change to the book goes through here, so this is also where the fast position feed is told
    // that the panel has something new to draw (a position opened, closed or was restored).
    this._pxDirty = true;
    const live = [...this.positions.values()]
      .filter((p) => !p.paper)
      .map((p) => ({
        mint: p.mint, symbol: p.symbol, entryMc: p.entryMc, mc: p.mc, peakMc: p.peakMc, solIn: p.solIn,
        feeBuy: p.feeBuy, openedAt: p.openedAt, tp1Done: Boolean(p.tp1Done), sig: p.sig || null,
        adopted: Boolean(p.adopted), graduated: Boolean(p.graduated),
      }));
    try { this.store.set({ openPositions: live }); } catch (_) { /* a full disk is not a reason to stop trading */ }
  }

  async _restorePositions() {
    const saved = Array.isArray(this.s.openPositions) ? this.s.openPositions : [];
    if (!saved.length) return;
    let missing = 0;
    for (const rec of saved) {
      if (!rec || !rec.mint || this.positions.has(rec.mint)) continue;
      const held = await this._tokenBalanceRaw(rec.mint).catch(() => null);
      if (held === 0n) { missing++; continue; }
      const now = Date.now();
      this.positions.set(rec.mint, {
        mint: rec.mint, symbol: rec.symbol || rec.mint.slice(0, 4), name: rec.symbol || '',
        // No made-up numbers: a record without an entry price is measured from the first price it is seen at, and
        // `_pnlPct` reads 0 until then, so nothing sells on a reference that was never paid.
        entryMc: Number(rec.entryMc) || 0, mc: Number(rec.mc) || Number(rec.entryMc) || 0,
        peakMc: Number(rec.peakMc) || Number(rec.mc) || Number(rec.entryMc) || 0,
        solIn: Number(rec.solIn) || this.s.buyAmountSol, feeBuy: Number(rec.feeBuy) || 0,
        openedAt: Number(rec.openedAt) || now, status: 'open', closing: false, paper: false,
        fails: 0, nextTry: 0, pending: held === null, tp1Done: Boolean(rec.tp1Done), sig: rec.sig,
        tokIn: held, adopted: Boolean(rec.adopted), graduated: Boolean(rec.graduated),
      });
      if (!this.tokens.has(rec.mint)) {
        this._adopt({ mint: rec.mint, source: 'restore', launched: true });
        const t = this.tokens.get(rec.mint);
        if (t) { t.mc = Number(rec.mc) || Number(rec.entryMc) || 1; t.status = 'bought'; }
      }
      this._log('warn', held === null
        ? `Restored an open position in ${rec.symbol || rec.mint} from the last session. Its balance could not be read yet.`
        : `Restored an open position in ${rec.symbol || rec.mint} from the last session. It is managed and sold by the normal rules.`);
    }
    if (missing) this._log('info', `${missing} saved position${missing > 1 ? 's were' : ' was'} already closed in the wallet and removed from the book.`);
    this._persistPositions();
  }

  /** Bring the book up to date with the chain without starting the bot, so the panel shows the real coins at once. */
  async recoverBook() {
    if (!this.wallet.isUnlocked()) return 0;
    const before = this.positions.size;
    await this._restorePositions().catch(() => {});
    await this._adoptOnChain().catch(() => 0);
    return this.positions.size - before;
  }

  /** Every token account of this wallet, with the rent it holds. */
  async _tokenAccounts() {
    const addr = this.wallet.address();
    if (!addr) throw new Error('Create your wallet first.');
    return reclaim.scanTokenAccounts((fn, opts) => this.rpcCall(fn, opts), addr);
  }

  /** Coins in the wallet the book never recorded are adopted and priced where they trade now, so nothing sits in the
   *  wallet with no rule looking after it. A leftover worth less than a fifth of a ticket is not a position - it is
   *  dust, and the settle path sells or burns it for the rent. */
  async _adoptOnChain() {
    if (!this.wallet.isUnlocked()) return 0;
    let scan;
    try { scan = await this._tokenAccounts(); } catch (_) { return 0; }
    const holdings = scan.dust.filter((a) => !this.positions.has(a.mint) && a.uiAmount > 0);
    // The exchange rate is needed to compare a holding's value with a ticket. Asking for it here matters: on a cold
    // start there is no rate yet, so every holding read as unpriced and was booked at the ticket size - a made-up
    // entry price, a made-up loss the moment it sold, and an instant "take profit" at a number nobody ever paid.
    if (holdings.length && !(this.market.solPrice() > 0)) await this.market.enrich([WSOL]).catch(() => {});
    // The holding's value decides whether it is a position or a leftover: booking dust at the ticket size invented
    // money in the books and re-sold the same coin over and over.
    const prices = holdings.length ? await this.market.prices(holdings.map((a) => a.mint)).catch(() => new Map()) : new Map();
    const solUsd = this.market.solPrice();
    let added = 0;
    let skipped = 0;
    let unknown = 0;
    for (const a of holdings) {
      const px = prices.get(a.mint);
      const usd = px ? Number(a.uiAmount) * px.priceUsd : null;
      const solValue = usd != null && solUsd > 0 ? usd / solUsd : null;
      const floor = Math.max(0.0005, this.s.buyAmountSol * 0.2);
      if (solValue != null && solValue < floor) { skipped++; continue; }
      // Neither a market price nor an exchange rate: this is a leftover whose value nobody can measure, so it is not
      // booked as a position (a book entry that was never bought invents profit and loss alike). It is sold - or
      // burned when the market will not take it - and its account closed, which is what the settle path is for.
      if (solValue == null) {
        unknown++;
        if (this.s.autoReclaim) this._settleMint(a.mint);
        continue;
      }
      const t = this.tokens.get(a.mint);
      const mc = t && t.mc > 0 ? t.mc : 0;
      this.positions.set(a.mint, {
        mint: a.mint, symbol: (t && t.symbol) || a.mint.slice(0, 4), name: (t && t.name) || '',
        entryMc: mc, mc, peakMc: mc, solIn: solValue > 0 ? solValue : this.s.buyAmountSol,
        feeBuy: 0, openedAt: Date.now(),
        status: 'open', closing: false, paper: false, fails: 0, nextTry: 0, pending: false,
        tp1Done: false, sig: null, tokIn: BigInt(a.amount), adopted: true,
      });
      if (!t) {
        this._adopt({ mint: a.mint, source: 'wallet', launched: true });
        const nt = this.tokens.get(a.mint);
        if (nt) { nt.mc = mc || nt.mc; nt.status = 'bought'; }
      }
      added++;
    }
    if (added) {
      this._log('warn', `Found ${added} coin${added > 1 ? 's' : ''} in the wallet that the book did not know about. Adopted, and the normal exit rules now manage ${added > 1 ? 'them' : 'it'}.`);
      this._persistPositions();
    }
    if (unknown) this._log('info', `${unknown} holding${unknown > 1 ? 's have' : ' has'} no price anywhere, so ${unknown > 1 ? 'they are' : 'it is'} sold as a leftover instead of being booked as a position.`);
    if (skipped) this._log('info', `${skipped} leftover holding${skipped > 1 ? 's are' : ' is'} too small to manage as a position; the sell-all or the next exit sweeps ${skipped > 1 ? 'them' : 'it'} and returns the rent.`);
    return added;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this._log('info', this.positions.size
      ? 'Bot stopped. Still managing open positions until they close.'
      : 'Bot stopped.');
    this._scheduleReclaim();
    this._shutdownIfIdle();
  }

  _shutdownIfIdle() {
    if (this.running || this.positions.size) return;
    this.wantWs = false;
    this._portalOnly = false;
    this._subbed = new Set();
    if (this.chain) { this.chain.stop(); this.chain.removeAllListeners(); this.chain = null; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
    this.connected = false;
    if (this._loop) { clearInterval(this._loop); this._loop = null; }
    if (this._marketTimer) { clearInterval(this._marketTimer); this._marketTimer = null; }
    if (this._hotTimer) { clearInterval(this._hotTimer); this._hotTimer = null; }
    if (this._posTimer) { clearInterval(this._posTimer); this._posTimer = null; }
    this.tokens.clear();
  }

  _connect() {
    this.wantWs = true;
    const src = this.s.feedSource;
    if (src === 'pumpportal' || this._portalOnly) return this._connectPortal(PUMPPORTAL_WS, 'pumpportal');
    const pumpdev = this._pumpdevUrl();
    if (src === 'pumpdev') return this._connectPortal(pumpdev, 'pumpdev');
    if (src !== 'chain' && pumpdev) return this._connectPortal(pumpdev, 'pumpdev');
    if (src === 'auto' && !this.s.rpcUrl) {
      if (!this._tipShown) { this._tipShown = true; this._log('info', 'Tip: a free PumpDev key in Settings turns on the live trade stream.'); }
      return this._connectPortal(PUMPPORTAL_WS, 'pumpportal');
    }
    this._startChain();
  }

  _pumpdevUrl() {
    const key = String(this.s.pumpdevKey || '').trim();
    if (!key) return '';
    const bare = (key.match(/[?&](?:api-key|key)=([^&]+)/) || [])[1] || key;
    return `${PUMPDEV_WS}?key=${encodeURIComponent(bare)}`;
  }

  /** Primary feed: decode Pump.fun program logs straight from a Solana RPC websocket (no data API). */
  _startChain() {
    if (this.chain) return;
    const feed = new ChainFeed({ customRpc: this.s.rpcUrl });
    this.chain = feed;
    this.feedSource = 'chain';
    this._chainAt = Date.now();
    this._lastEv = 0;
    feed.on('event', (ev) => { this._lastEv = Date.now(); this.ingest(ev); });
    feed.on('status', (st) => {
      this.connected = st.connected;
      if (st.connected) { this._chainAt = Date.now(); this._log('ok', 'Reading Pump.fun straight from the blockchain (' + new URL(st.url.replace(/^wss/, 'https')).hostname + ').'); }
    });
    feed.on('giveup', () => this._fallback('could not reach a node that allows log streaming'));
    feed.on('error', (e) => this._fallback(e.message));
    feed.start();
  }

  _fallback(reason) {
    if (!this.chain) return;
    if (this.s.feedSource === 'chain') {
      // A feed that is set to the chain keeps retrying, and each retry reports again: said once a minute instead of
      // once every five seconds, because a wall of identical warnings hides the line that matters.
      if (this._chainWarnAt && Date.now() - this._chainWarnAt < 60000) return;
      this._chainWarnAt = Date.now();
      this._log('warn', 'On-chain feed problem: ' + reason + ' (retrying)');
      return;
    }
    this.chain.stop(); this.chain.removeAllListeners(); this.chain = null;
    this._portalOnly = true;
    const pumpdev = this._pumpdevUrl();
    if (pumpdev) {
      this._log('warn', `On-chain feed unavailable (${reason}). Using the PumpDev trade stream instead.`);
      return this._connectPortal(pumpdev, 'pumpdev');
    }
    this._log('warn', `On-chain feed unavailable (${reason}). Using PumpPortal - launches only, so prices come from the market scan. A PumpDev key in Settings brings the full trade stream back.`);
    this._connectPortal(PUMPPORTAL_WS, 'pumpportal');
  }

  _connectPortal(url, label = 'pumpportal') {
    this.wantWs = true;
    this.feedSource = label;
    this._feedLabel = label;
    if (this.ws) return;
    if (!url) {
      this._log('warn', 'No trade stream configured - prices come from the market scan.');
      return;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      this._subbed = new Set();
      if (label === 'pumpdev') this._syncSubscriptions();
      this._log('ok', label === 'pumpdev'
        ? 'Connected to the PumpDev stream (launches and trades).'
        : 'Connected to PumpPortal (launches only).');
    });
    ws.on('message', (d) => this._onMessage(d.toString()));
    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      if (this.wantWs) setTimeout(() => this._connectPortal(url, label), 2500);
    });
    ws.on('error', (e) => {
      this._log('warn', 'Feed error: ' + e.message);
      if (/CONNECTION_LIMIT/.test(e.message)) this._log('warn', 'This PumpDev key is already in use by another window.');
    });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // A free trade-stream plan caps how many coins can be watched at once (PumpDev: 25) and how many control
  // messages may be sent per ten seconds (40). Subscribing to every scanned coin broke both limits, so the engine
  // keeps a budget: open positions always, then the best-scoring candidates, sent in one batched call.
  //
  // The set is STICKY and it is upgraded slowly. Scores are re-ranked every few seconds, and a plain "top twenty"
  // swapped coins in and out on every tick: each swap is a control message, and the plan counts both the subscribe
  // and the unsubscribe. Measured live, that churn is what produced "your free plan allows 25 live subscriptions per
  // IP and this IP has reached it" while only twenty coins were ever wanted. So: positions always, what is watched
  // keeps its slot while it is alive, and a newcomer only takes a slot from a coin that has been quiet for a while
  // and is beaten by a clear margin.
  _syncSubscriptions() {
    if (this._feedLabel !== 'pumpdev') return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const budget = SUB_BUDGET;
    const all = [...this.tokens.values()].filter((t) => t.status !== 'skipped' && t.mc > 0);
    const byMint = new Map(all.map((t) => [t.mint, t]));
    const keep = new Map();
    for (const mint of this.positions.keys()) keep.set(mint, Infinity);            // never replaced
    const watched = [...this._subbed]
      .filter((mint) => !keep.has(mint) && byMint.has(mint))
      .sort((a, b) => byMint.get(b).score - byMint.get(a).score);
    for (const mint of watched) { if (keep.size >= budget) break; keep.set(mint, byMint.get(mint).score); }
    const fresh = all.filter((t) => !keep.has(t.mint)).sort((a, b) => b.score - a.score);
    const MARGIN = 8;                                                              // a coin must be clearly better
    const QUIET_MS = 5000;                                                         // and the one it replaces quiet
    for (const t of fresh) {
      if (keep.size < budget) { keep.set(t.mint, t.score); continue; }
      let weakest = null;
      for (const [mint, score] of keep) if (score !== Infinity && (!weakest || score < weakest.score)) weakest = { mint, score };
      if (!weakest || t.score < weakest.score + MARGIN) break;                      // the rest are no better either
      const rec = byMint.get(weakest.mint);
      if (rec && now - (rec.lastActivity || 0) < QUIET_MS) continue;
      keep.delete(weakest.mint);
      keep.set(t.mint, t.score);
    }
    const want = new Set(keep.keys());
    const add = [...want].filter((m) => !this._subbed.has(m));
    // Only coins that lost their slot are released: a tick that changes nothing sends nothing.
    const drop = [...this._subbed].filter((m) => !want.has(m));
    if (add.length) {
      this._send({ method: 'subscribeTokenTrade', keys: add });
      for (const m of add) this._subbed.add(m);
    }
    if (drop.length) {
      this._send({ method: 'unsubscribeTokenTrade', keys: drop });
      for (const m of drop) this._subbed.delete(m);
    }
    if (!this._subNote && want.size >= SUB_BUDGET) {
      this._subNote = true;
      this._log('info', `Trade stream is watching ${want.size} coins at once (plan limit). Every other coin is scored from market data.`);
    }
  }

  /** Public so tests can inject events. */
  ingest(m) {
    if (!m || !m.mint || !m.txType) return;
    if (m.txType === 'create') this._onCreate(m);
    else if (m.txType === 'buy' || m.txType === 'sell') {
      if (m.fromChain && !this.tokens.has(m.mint)) this._adoptHot(m);
      this._onTrade(m);
    }
  }

  /** A coin we did not see launch (already trending) shows real buying on-chain - start tracking it. */
  _adoptHot(m) {
    const s = this.s;
    if (!this.running || !s.trendMode || m.txType !== 'buy') return;
    const mc = Number(m.marketCapSol) || 0;
    if ((Number(m.solAmount) || 0) < 0.3 || mc < s.minMcSol || mc > s.maxMcSol * 1.2) return;
    if (this.tokens.size >= MAX_TRACKED) this._prune(true);
    if (this.tokens.size >= MAX_TRACKED) return;
    const now = Date.now();
    this.tokens.set(m.mint, {
      mint: m.mint, name: 'Trending coin', symbol: m.mint.slice(0, 4) + '…', creator: null, creatorUnknown: true,
      createdAt: now - (s.entryWindowSec + 1) * 1000, mc, mcHist: [[now, mc]], trades: [], devSold: false, devBuySol: 0,
      status: 'watching', score: 0, reason: 'Spotted on-chain', lastActivity: now, trending: true,
      launched: true, sources: new Set(['chain']), lastStreamAt: now,
    });
    this.stats.seen++;
  }

  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.type === 'error' || m.code) {
      if (m.code === 'CONNECTION_LIMIT') this._log('warn', 'The PumpDev key is already connected somewhere else - close the other window.');
      else if (m.message) this._log('warn', 'Feed: ' + m.message);
      return;
    }
    this.ingest(m);
  }

  _onCreate(m) {
    if (this.tokens.has(m.mint) || !this.running) return;
    const now = Date.now();
    const mc = Number(m.marketCapSol) || 0;
    this.stats.launches++;
    this.launchTimes.push(now);
    if (this.launchTimes.length > 500) this.launchTimes.shift();
    const t = {
      mint: m.mint, name: String(m.name || '').slice(0, 40), symbol: String(m.symbol || '?').slice(0, 12),
      creator: m.traderPublicKey, createdAt: now, mc, mcHist: mc > 0 ? [[now, mc]] : [],
      trades: [], devSold: false, status: 'watching', score: 0, reason: 'New launch', lastActivity: now,
      devBuySol: Number(m.solAmount) || 0, launched: true, sources: new Set(['launch']), lastStreamAt: now,
    };
    this.tokens.set(t.mint, t);
    this.stats.seen++;
    if (this.tokens.size > MAX_TRACKED) this._prune(true);
  }

  _onTrade(m) {
    const t = this.tokens.get(m.mint);
    if (!t) return;
    const now = Date.now();
    const mc = Number(m.marketCapSol);
    t.lastStreamAt = now;
    if (mc > 0) {
      t.mc = mc;
      t.mcHist.push([now, mc]);
      if (t.mcHist.length > 150) t.mcHist.shift();
    }
    t.lastActivity = now;
    const side = m.txType;
    if (m.traderPublicKey === t.creator) {
      if (side === 'sell') t.devSold = true;
      else t.devBuySol = (t.devBuySol || 0) + (Number(m.solAmount) || 0);
    } else {
      t.trades.push({ ts: now, side, sol: Number(m.solAmount) || 0, trader: m.traderPublicKey });
      if (t.trades.length > TRADES_KEPT) t.trades.shift();
    }
    const p = this.positions.get(m.mint);
    if (p && mc > 0) {
      p.extRef = null;
      // Priced the moment the trade arrives, never at the next poll: the tick that decides exits runs every 50 ms and
      // must not be reading a number the market has already left. This also stamps a fresh reading, which is what the
      // hold rule waits for before it lets a level fire.
      this._pricePosition(p, now);
    }
    if (this.running && t.status === 'watching' && side === 'buy' && now - (t.lastEval || 0) >= 40) {
      t.lastEval = now;
      this._evalOne(t, now);
    }
  }

  _evalOne(t, now) {
    const s = this.s;
    if (t.status !== 'watching') return;
    if (this._unsupported.has(t.mint)) { t.status = 'skipped'; t.reason = 'Quoted in another token, not SOL'; return; }
    const until = this.cooldowns.get(t.mint);
    if (until) {
      if (now < until) {
        t.reason = `Cooling down after a close (${Math.ceil((until - now) / 60000)} min)`;
        return;
      }
      this.cooldowns.delete(t.mint);
    }
    const age = (now - t.createdAt) / 1000;
    if (age < s.watchSec) { t.reason = 'Watching…'; return; }
    if (t.retryAt && now < t.retryAt) return;
    const ev = this._eval(t, now);
    t.score = ev.score;
    t.reason = ev.reason;
    t.buyers = ev.m.buyers;
    t.net = ev.m.net;
    t.growth = ev.m.growth;
    t.metricSource = ev.m.source;
    if (ev.dead) { t.status = 'skipped'; return; }
    if (ev.pass) this._buy(t, ev);
  }

  _startMarket() {
    if (this._marketTimer) return;
    this._marketBusy = false;
    // The three pollers are staggered on purpose: fired together they are a burst at a public host that answers with
    // a rate limit before it has served anything, and the first thing it refuses is a price an exit needs.
    setTimeout(() => { if (this.running || this.positions.size) this._pollMarket(); }, 400);
    this._marketTimer = setInterval(() => this._pollMarket(), MARKET_EVERY_MS);
    setTimeout(() => { this._hotTimer = setInterval(() => this._pollHot(), HOT_EVERY_MS); }, 800);
    // An exit watches only the coins it is holding, which is one request for a handful of mints: that is cheap
    // enough to ask far more often than the candidate board, and a stop that reads a half-second-old price is a
    // stop that fills half a second late.
    this._posTimer = setInterval(() => this._pollPositions(), POS_EVERY_MS);
  }

  /** Prices for the open positions alone, on the shortest cadence the market allows. */
  async _pollPositions() {
    if (!this.positions.size) return;
    // One poll may still be in flight; a second is allowed after a tenth of a second, so a slow answer cannot shut the
    // feed for a whole cycle. Two in flight at once is the ceiling.
    if (this._posBusy && Date.now() - (this._posAt || 0) < 100) return;
    this._posBusy = true;
    this._posAt = Date.now();
    try {
      const mints = [...this.positions.keys()];
      // The curve price first, with no network in front of it. The stream already carries it, so an exit never waits
      // for a quote request to come back before it can see a move - that wait was the slowest part of a sell.
      const before = Date.now();
      for (const mint of mints) {
        const p = this.positions.get(mint);
        if (p) this._pricePosition(p, before);
      }
      // The tick that can close a position: the curve price when the stream is alive, one request for every coin held
      // when it is not. A coin whose curve is speaking needs no quote at all - asking anyway spends a rate limit the
      // whole app shares, and the free endpoints answer a shared limit with silence.
      const quiet = mints.filter((mint) => {
        const t = this.tokens.get(mint);
        return !(t && t.mc > 0 && before - (t.lastStreamAt || 0) < 2000);
      });
      const quick = quiet.length ? await this.market.prices(quiet).catch(() => new Map()) : new Map();
      const now = Date.now();
      for (const mint of mints) {
        const p = this.positions.get(mint);
        if (!p) continue;
        // A quote only replaces the previous one when a quote was actually asked for: zeroing it would take the
        // fallback away from a coin whose stream went quiet a moment ago.
        if (quick.has(mint)) {
          const row = quick.get(mint);
          p.pxPull = row ? row.priceUsd : 0;
          if (p.pxPull > 0) p.pxPullAt = now;
        }
        this._pricePosition(p, now);
      }
      // The curve is the price that always exists: no key, no third-party service, and one request for every coin
      // held. A quiet stream plus a price service that does not know a minute-old mint used to leave a position on the
      // number it was bought at for its whole life - measured in a paper run, five of six positions never got a second
      // reading and were closed by the time limit, blind, with every price rule unable to fire.
      if (now - (this._curveAt || 0) > CURVE_EVERY_MS) {
        this._curveAt = now;
        const blind = mints.filter((mint) => {
          const p = this.positions.get(mint);
          if (!p || p.closing) return false;
          const t = this.tokens.get(mint);
          const curveLive = t && t.mc > 0 && now - (t.lastStreamAt || 0) < 2000;
          const quoteFresh = p.pxPull > 0 && now - (p.pxPullAt || 0) < PX_STALE_MS;
          return !curveLive && !quoteFresh;
        });
        if (blind.length) {
          const curves = await readCurves((fn, opts) => this.rpcCall(fn, opts), blind).catch(() => new Map());
          const at = Date.now();
          for (const [mint, c] of curves) {
            const p = this.positions.get(mint);
            if (!p || p.closing) continue;
            // A graduated coin's curve stopped at the graduation figure: it is not a price any more, and using it made
            // a coin on PumpSwap look like it had fallen 70% (or risen 300%) the moment the fossil was first read.
            if (c.complete) continue;
            // The reserves are the market, not one print on it, so a FALL is taken at once - a stop must fire on it.
            // A jump UP is different: our own entry may have been priced from a stale board, and a 3x in one 120 ms
            // reading is almost always two numbers from two sources rather than a market move. Such a jump has to be
            // seen twice, on two readings that agree, before it becomes the price.
            if (p.mc > 0 && c.mcSol > p.mc * CURVE_JUMP_UP) {
              const prev = p.pxOdd;
              p.pxOdd = c.mcSol;
              if (!(prev > 0 && Math.abs(c.mcSol / prev - 1) < 0.25)) continue;
            }
            p.mcPrev = p.mc;
            p.mc = c.mcSol;
            p.pxAt = at;
            p.pxSource = 'curve';
            this._pxDirty = true;
          }
        }
      }
      // Depth, buyers and the dex are still read from the market board, only more slowly, because they change slowly.
      if (now - (this._posEnrichAt || 0) > 1200) {
        this._posEnrichAt = now;
        const rows = await this.market.enrich(mints, true);
        for (const [mint, row] of rows) {
          this._applyMarket(mint, row, { price: false });
          // A brand-new coin is very often not in the price service at all, and without a trade stream that left a
          // held position with no price but the one it was bought at. Measured in a paper run: three of four positions
          // sat at their entry for the whole hold and were closed by the time limit, blind. The board is the last
          // resort, and on a coin whose curve has not graduated the pump.fun pair IS the market; the anchor in
          // `_pricePosition` still stops one wild print from dragging the number.
          const p = this.positions.get(mint);
          const t = this.tokens.get(mint);
          const curveLive = t && t.mc > 0 && now - (t.lastStreamAt || 0) < 2000;
          const quoteFresh = p && p.pxPull > 0 && now - (p.pxPullAt || 0) < PX_STALE_MS;
          if (p && !curveLive && !quoteFresh && row.priceUsd > 0) {
            p.pxPull = row.priceUsd;
            p.pxPullAt = Date.now();
            this._pricePosition(p, Date.now());
          }
        }
      }
    } catch (_) {
      /* the wide sweep reports its own failures */
    } finally {
      this._posBusy = false;
    }
  }

  /**
   * The price a position is measured at. The bonding curve itself comes first - the same number the buy was priced
   * at, straight from the trade stream - and an aggregator only fills in while that stream is quiet. Measured live: a
   * fresh coin's aggregator quote moved +135% to -70% within a second, because our own sale is a large share of a
   * pool that small. Exits cannot be decided on a number like that.
   */
  _pricePosition(p, now = Date.now()) {
    if (p.closing) return;
    // A holding adopted from the wallet can arrive with no reference price. The first price it is seen at becomes
    // the reference, so the rules measure the move from where it was found instead of dividing by nothing.
    if (!(p.entryMc > 0) && p.mc > 0) { p.entryMc = p.mc; p.peakMc = p.mc; }
    const t = this.tokens.get(p.mint);
    if (t && t.mc > 0 && now - (t.lastStreamAt || 0) < 2000) {
      p.mcPrev = p.mc;
      p.mc = t.mc;
      p.pxAt = now;
      p.pxSource = 'chain';
      this._pxDirty = true;
      return;
    }
    const px = p.pxPull;
    // A quote is only a price while it is recent. One that stopped being refreshed is the last thing known about the
    // coin, not what it is worth now, and a rule must not fire on it as if it were live.
    if (!(px > 0) || now - (p.pxPullAt || 0) > PX_STALE_MS) return;
    if (!p.extRef || !(p.extRef.priceUsd > 0)) {
      p.extRef = { priceUsd: px, mc: p.mc };
      p.pxSource = 'quote';
      this._pxDirty = true;
      return;
    }
    const next = p.extRef.mc * (px / p.extRef.priceUsd);
    // A quote that jumps more than this cannot be believed on its own: the anchor stays where it was and the reading
    // is only used for the confirmation, never to drag the percentage the rules read.
    if (p.mc > 0 && Math.abs(next / p.mc - 1) * 100 > MAX_TICK_JUMP_PCT) { p.pxOdd = next; return; }
    p.mcPrev = p.mc;
    p.mc = next;
    p.pxAt = now;
    p.pxSource = 'quote';
    this._pxDirty = true;
  }

  /** The open positions exactly as the panel draws them: small enough to push twenty times a second. */
  _positionsView() {
    const now = Date.now();
    return [...this.positions.values()].map((p) => ({
      mint: p.mint, symbol: p.symbol, pnlPct: this._pnlPct(p), mc: p.mc, solIn: p.solIn,
      heldSec: Math.round((now - p.openedAt) / 1000), status: p.status, paper: p.paper,
      pending: Boolean(p.pending), closing: Boolean(p.closing),
    }));
  }

  /** Push the positions when a price moved since the last push, and never on a quiet tick. */
  _pushPositions() {
    if (!this.positions.size || !this._pxDirty) return;
    this._pxDirty = false;
    this.emit('positions', this._positionsView());
  }

  // Prices for the coins that matter - open positions first, then the best candidates - refreshed about once a
  // second, so an exit never reads a quote that is minutes old. The wide sweep below keeps the rest honest.
  async _pollHot() {
    if (this._hotBusy) return;
    if (!this.market.ready()) return;
    const targets = [...this.positions.keys()];
    const ranked = [...this.tokens.values()]
      .filter((t) => !this.positions.has(t.mint) && t.status !== 'skipped' && t.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const t of ranked) {
      if (targets.length >= HOT_BATCH) break;
      targets.push(t.mint);
    }
    if (!targets.length) return;
    // The exchange rate is what turns a dollar figure into SOL, and every market-priced coin is judged on that
    // conversion. Asking for it here means a session with the market scan switched off still learns it.
    if (!this.market.solPrice() && !targets.includes(WSOL)) targets.unshift(WSOL);
    this._hotBusy = true;
    try {
      const rows = await this.market.enrich(targets.slice(0, HOT_BATCH));
      for (const [mint, row] of rows) this._applyMarket(mint, row);
    } catch (_) {
      /* the wide sweep reports its own failures */
    } finally {
      this._hotBusy = false;
    }
  }

  async _pollMarket() {
    const holding = this.positions.size > 0;
    if ((!this.running && !holding) || this._marketBusy) return;
    if (!this.market.ready()) return;
    this._marketBusy = true;
    try {
      if (this.running && this.s.marketScan) {
        const found = await this.market.discover(this.s.wideDiscovery !== false);
        let added = 0;
        for (const c of found) if (this._adopt(c)) added++;
        if (added > 4) this._log('info', `Market scan: ${added} new coins (${this.tokens.size} tracked).`);
        if (!this.market.solPrice()) await this.market.enrich([WSOL]);
      }
      const all = [...this.tokens.keys()].concat([...this.positions.keys()]);
      if (!all.length) return;
      const batch = [];
      for (let i = 0; i < all.length && batch.length < ENRICH_PER_CYCLE; i++) {
        this._enrichCursor = ((this._enrichCursor || 0) + 1) % all.length;
        batch.push(all[this._enrichCursor]);
      }
      const rows = await this.market.enrich(batch);
      for (const [mint, row] of rows) this._applyMarket(mint, row);
    } catch (e) {
      this._log('warn', 'Market scan: ' + e.message);
    } finally {
      this._marketBusy = false;
    }
  }

  _marketError(e) {
    this._marketFails = (this._marketFails || 0) + 1;
    if (this._marketFails === 1 || this._marketFails % 20 === 0) {
      this._log('warn', `Market data: ${e.message} (retrying quietly)`);
    }
  }

  _adopt(c) {
    if (!c?.mint || this.tokens.has(c.mint)) return false;
    if (this.tokens.size >= MAX_TRACKED) this._prune(true);
    if (this.tokens.size >= MAX_TRACKED) return false;
    const now = Date.now();
    const hint = c.hint || null;
    const solUsd = this.market.solPrice();
    const hintMc = hint
      ? hint.priceNative > 0
        ? hint.priceNative * 1e9
        : solUsd > 0 && hint.mcapUsd > 0
          ? hint.mcapUsd / solUsd
          : 0
      : 0;
    this.tokens.set(c.mint, {
      mint: c.mint,
      name: hint?.name || 'New coin',
      symbol: hint?.symbol || c.mint.slice(0, 4),
      creator: hint?.creator || null,
      creatorUnknown: !hint?.creator,
      createdAt: now - (this.s.entryWindowSec + 1) * 1000,
      launchedAt: hint?.createdAt || 0,
      mc: hintMc,
      mcHist: hintMc > 0 ? [[now, hintMc]] : [],
      trades: [],
      devSold: false,
      devBuySol: 0,
      status: 'watching',
      score: 0,
      reason: 'New from ' + c.source,
      lastActivity: now,
      trending: true,
      launched: Boolean(c.launched),
      sources: new Set([c.source]),
      ext: hint ? { ...hint, mcSol: hintMc, at: now } : null,
    });
    this.stats.seen++;
    return true;
  }

  _applyMarket(mint, row, opts = {}) {
    const t = this.tokens.get(mint);
    const solUsd = this.market.solPrice();
    const quotedInSol = !row.quoteMint || row.quoteMint === WSOL;
    const mcSol = quotedInSol && row.priceNative > 0 ? row.priceNative * 1e9 : solUsd > 0 ? row.mcapUsd / solUsd : 0;
    const now = Date.now();
    if (!t) return;
    if (!t.launched && !this.market.isPumpCoin(row)) {
      t.status = 'skipped';
      t.reason = 'Not a Pump.fun coin';
      return;
    }
    // The dex tells the two markets apart, and the buy route uses it: the bonding curve is `pump`, a graduated coin
    // is `pump-amm`. Guessing between them is what produced a stream of on-chain rejections.
    if (row.dexId === 'pumpswap' || row.dexId === 'pump-amm') t.graduated = true;
    else if (row.dexId === 'pumpfun') t.graduated = false;
    t.ext = { ...row, mcSol, at: now };
    if (row.symbol && row.symbol !== '?') t.symbol = row.symbol;
    if (row.name) t.name = row.name;
    if (row.pairCreatedAt > 0) t.launchedAt = row.pairCreatedAt;
    if (mcSol > 0 && now - (t.lastStreamAt || 0) > STREAM_FRESH_MS) {
      t.mc = mcSol;
      t.mcHist.push([now, mcSol]);
      if (t.mcHist.length > 150) t.mcHist.shift();
      t.lastActivity = Math.max(t.lastActivity, now);
    }
    const p = this.positions.get(mint);
    // The market board never moves the price a position is measured at: its quote is an aggregate of every pool the
    // mint trades in, and on a fresh coin that is not the pool the order will fill against. It still sets the fallback
    // quote, used only while the trade stream is quiet.
    if (p && row.priceUsd > 0 && opts.price !== false && !(p.pxPull > 0)) { p.pxPull = row.priceUsd; p.pxPullAt = now; }
  }

  _prune(force) {
    const now = Date.now();
    for (const [mint, t] of this.tokens) {
      if (this.positions.has(mint)) continue;
      const age = (now - t.createdAt) / 1000;
      const idle = (now - t.lastActivity) / 1000;
      if (age > 900 || t.status === 'skipped' || (idle > 120 && age > this.s.entryWindowSec) || (force && idle > 45)) {
        this.tokens.delete(mint);
      }
    }
  }

  _metrics(t, now, winSec) {
    const from = now - winSec * 1000;
    let buys = 0, sells = 0, bv = 0, sv = 0;
    const buyers = new Set();
    const per = new Map();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const x = t.trades[i];
      if (x.ts < from) break;
      if (x.side === 'buy') { buys++; bv += x.sol; buyers.add(x.trader); per.set(x.trader, (per.get(x.trader) || 0) + x.sol); } else { sells++; sv += x.sol; }
    }
    let base = t.mc;
    for (const [ts, mc] of t.mcHist) { if (ts >= from) { base = mc; break; } }
    const ext = t.ext;
    const marketFresh = Boolean(ext && ext.at && now - ext.at < 60000);
    // The five minute change is the market's own reading. It is kept beside the stream's growth so the entry rule
    // can refuse a coin that a single fresh trade makes look alive while the coin is really falling.
    const marketGrowth = marketFresh && typeof ext.change5m === 'number' ? ext.change5m / 100 : null;
    const streamFresh = now - (t.lastStreamAt || 0) < 15000;
    if ((buys || sells) && streamFresh) {
      let top = 0; for (const v of per.values()) if (v > top) top = v;
      return { buys, sells, buyers: buyers.size, net: bv - sv, growth: base > 0 ? t.mc / base - 1 : 0, topShare: bv > 0 ? top / bv : 0, source: 'stream', windowSec: winSec, marketGrowth };
    }
    if (marketFresh) {
      const solUsd = this.market.solPrice();
      return {
        buys: ext.buys || 0,
        sells: ext.sells || 0,
        // A market row counts transactions, not wallets, so distinct buyers are estimated at half the buys. Every
        // rule that compares against a buyer bar treats this number as the same kind of estimate.
        buyers: Math.round((ext.buys || 0) / 2),
        // Without an exchange rate a dollar figure cannot be turned into SOL, and the honest answer is "no evidence
        // of buying", not a division by a made-up 1 - which booked thousands of SOL of net flow nobody ever spent and
        // handed every scanned coin full marks on the strongest entry rule.
        net: solUsd > 0 ? (ext.netUsd || 0) / solUsd : 0,
        growth: (ext.change5m || 0) / 100,
        topShare: 0,
        source: 'market',
        windowSec: 300,
        marketGrowth,
      };
    }
    let top = 0; for (const v of per.values()) if (v > top) top = v;
    return { buys, sells, buyers: buyers.size, net: bv - sv, growth: base > 0 ? t.mc / base - 1 : 0, topShare: bv > 0 ? top / bv : 0, source: 'stream', windowSec: winSec, marketGrowth };
  }

  _eval(t, now) {
    const s = this.s;
    const age = (now - t.createdAt) / 1000;
    const m = this._metrics(t, now, 20);
    if (t.devSold) return { score: 0, pass: false, dead: true, reason: 'Creator sold', m };
    const trending = age > s.entryWindowSec;
    if (trending && !s.trendMode) return { score: t.score, pass: false, dead: true, reason: 'Entry window closed', m };
    const external = m.source === 'market';
    // A scanned coin is already a few minutes old when it shows up, so its market cap has usually grown past the
    // launch band. It gets a wider ceiling: the entry size and the stop are what limit the risk, not the cap.
    const maxMc = external ? s.maxMcSol * 4 : s.maxMcSol;
    const minScore = s.minScore + (t.creatorUnknown ? 10 : 0);
    // The profile's buyer bar is written for a twenty-second window of distinct wallets. A market row counts
    // transactions over five minutes, so it is scaled down here; measured on live data, a healthy young coin
    // carries twenty to forty of them.
    const needBuyers = external ? Math.max(6, Math.round(s.minBuyers * 2)) : s.minBuyers;
    const needNet = external ? Math.max(0.4, Math.round(s.minNetFlowSol * 100) / 100) : s.minNetFlowSol;
    const ratio = m.buys / Math.max(1, m.buys + m.sells);
    // Two readings of the same coin: the stream's own window and the market's five minute change. The entry is
    // judged on the worse one, because a single fresh buy must never make a coin that fell 80% look alive.
    const growth = m.marketGrowth == null ? m.growth : Math.min(m.growth, m.marketGrowth);
    let score = Math.min(m.buyers, Math.max(4, needBuyers)) / Math.max(4, needBuyers) * 35
      + Math.min(Math.max(m.net, 0), needNet * 2) / Math.max(0.5, needNet * 2) * 30
      + ratio * 20
      + Math.min(Math.max(growth, 0), 0.3) / 0.3 * 15;
    if (m.sells > m.buys) score -= 15;
    score = Math.round(clamp(score, 0, 100));
    // A number that is not a number can never be "below the minimum": every comparison against NaN is false, so a
    // broken input would walk straight through the entry gate. Zero is what it is worth.
    if (!Number.isFinite(score)) score = 0;
    // Simple settings: only the basic numbers gate the entry. The band, the buyer floor and ceiling, and "the price
    // is not falling" - the score, net flow, depth, dev bags, the five minute band and the holder bar are all off,
    // because the person chose the simple mode precisely so those would stop deciding. The score is still computed
    // and shown, it is just not a gate any more. The safety protections (creator sold, unsupported, graduated)
    // checked above never turn off in either mode.
    if (s.simpleMode) {
      let reason = '';
      if (!s.allowGraduated && t.graduated) reason = 'Graduated to PumpSwap';
      else if (t.unsupported) reason = 'Quoted in another token, cannot be bought here';
      else if (t.mc <= 0) reason = 'Waiting for a price';
      else if (t.mc < s.minMcSol || t.mc > maxMc) reason = `Market cap out of range (${s.minMcSol}-${Math.round(maxMc)} SOL)`;
      else if (m.buyers < needBuyers) reason = external ? `Needs ${needBuyers} buyers in 5m (has ${m.buyers})` : `Needs ${needBuyers} buyers (has ${m.buyers})`;
      else if (s.maxBuyers > 0 && m.buyers > s.maxBuyers) reason = `Too many buyers (${m.buyers}, cap ${s.maxBuyers})`;
      else if (growth <= -0.3) reason = `Dumping hard (${(growth * 100).toFixed(0)}% in 5m)`;
      else if (growth < (trending ? 0.03 : 0)) reason = trending ? 'Not pumping yet' : 'Price falling';
      const dead = t.mc > maxMc * 1.5;
      return { score, pass: !reason, dead, reason: reason || 'Looks strong', m, trending };
    }
    const ext = t.ext;
    let reason = '';
    if (ext && ext.mintRisk) reason = 'Creator can still mint more';
    else if (ext && ext.freezeRisk) reason = 'Token can be frozen';
    else if (!s.allowGraduated && t.graduated) reason = 'Graduated to PumpSwap';
    else if (t.unsupported) reason = 'Quoted in another token, cannot be bought here';
    else if (ext && s.maxDevHoldPct > 0 && ext.devHoldPct >= s.maxDevHoldPct) reason = 'Creator holds too much';
    else if (t.devBuySol > s.maxDevBuySol) reason = 'Creator holds too much';
    else if (m.buys >= 3 && m.topShare > s.maxTraderSharePct / 100) reason = 'One wallet dominates buying';
    else if (growth <= -0.3) reason = `Dumping hard (${(growth * 100).toFixed(0)}% in 5m)`;
    else if (m.buys >= 5 && ratio < 0.35) reason = `Sellers in control (${m.buys} buys, ${m.sells} sells)`;
    else if (ext && s.minLiqUsd > 0 && ext.liqUsd > 0 && ext.liqUsd < s.minLiqUsd) reason = 'Pool too thin';
    else if (t.mc <= 0) reason = 'Waiting for a price';
    else if (t.mc < s.minMcSol || t.mc > maxMc) reason = `Market cap out of range (${s.minMcSol}-${Math.round(maxMc)} SOL)`;
    else if (m.buyers < needBuyers) reason = external ? `Needs ${needBuyers} buyers in 5m (has ${m.buyers})` : `Needs ${needBuyers} buyers (has ${m.buyers})`;
    // The ceiling of the same bar: past it the crowd is already in, and a small ticket is buying their exit.
    else if (s.maxBuyers > 0 && m.buyers > s.maxBuyers) reason = `Too many buyers (${m.buyers}, cap ${s.maxBuyers})`;
    else if (m.net < needNet) reason = `Needs +${needNet} SOL net buying`;
    // A coin that is falling right now is never bought, however good its tape looked a minute ago: measured on the
    // live market, entries into weakness produced the stop-loss and time-limit cluster that dominates the losses.
    else if (growth < (trending ? 0.03 : 0)) reason = trending ? 'Not pumping yet' : 'Price falling';
    // Buying a coin that has already run a long way is buying somebody else's exit. The ceiling is the profile's
    // own number, so it is a policy the user can move, and it is checked after the depth and dump guards.
    else if (s.maxChange5mPct > 0 && m.marketGrowth != null && m.marketGrowth * 100 > s.maxChange5mPct) {
      reason = `Already up ${(m.marketGrowth * 100).toFixed(0)}% in 5m`;
    }
    // The other side of the same coin: a launch that has NOT moved yet is where a move starts, and one that has
    // already run 40-60% is where it ends. Measured in paper on the live market, buys at the top of a five minute
    // push were the ones that stopped out in two to twelve seconds.
    else if (s.minChange5mPct > 0 && m.marketGrowth != null && m.marketGrowth * 100 < s.minChange5mPct) {
      reason = `Only up ${(m.marketGrowth * 100).toFixed(0)}% in 5m, no move to join yet`;
    }
    // The holder bar, from the cache the buy path fills: once the count is known, a coin under it is refused here
    // without another request. The buy path itself enforces the bar on the freshest count.
    else if (s.deepEntry && s.minHolders > 0 && t.holders > 0 && t.holders < s.minHolders) {
      reason = `Needs ${s.minHolders} holders (has ${t.holders})`;
    }
    else if (score < minScore) reason = `Score ${score} below ${minScore}${t.creatorUnknown ? ' (creator unknown)' : ''}`;
    const dead = t.mc > maxMc * 1.5;
    return { score, pass: !reason, dead, reason: reason || 'Looks strong', m, trending };
  }

  _scan(now) {
    // Bounded work per tick: a rotating slice of the table, at most one evaluation per token every 700 ms. With a
    // few hundred coins tracked this keeps the hundred millisecond loop flat instead of walking every coin's trade
    // history ten times a second.
    const all = [...this.tokens.values()];
    if (!all.length) return;
    const due = [];
    for (let i = 0; i < all.length && due.length < SCAN_PER_TICK; i++) {
      this._scanCursor = ((this._scanCursor || 0) + 1) % all.length;
      const t = all[this._scanCursor];
      if (now - (t.lastCheck || 0) < 700) continue;
      t.lastCheck = now;
      due.push(t);
    }
    for (const t of due) this._evalOne(t, now);
    if (now - (this._pruneAt || 0) > 10000) { this._pruneAt = now; this._prune(false); }
  }

  /**
   * How long a risk rule waits before it sells. A stop, a trail or a break even is watching money leave, so it only
   * has to be seen on a second, fresh reading (`STOP_HOLD_MS`), and a coin already through twice its stop - or twice
   * the trail's give-back - is a crash, not a threshold: that one sells on the first reading. `triggerHoldMs` is not a
   * ceiling here either: it is the guard for a take profit, where a spike has to prove itself before anything is sold
   * into it.
   */
  _riskHoldMs(rule, pnl, peak, source) {
    const s = this.s;
    const stop = Math.abs(Number(s.stopLossPct) || 0);
    // The bonding curve's reserves are the pool's own state, not one print on it: there is nothing to confirm. A
    // reading taken from a quote is a different thing - any single aggregator number can be wrong - so that one still
    // has to be seen twice.
    if (source === 'curve') return 0;
    if (rule === 'Stop loss' && stop > 0 && pnl <= -stop * 2) return 0;
    if (rule === 'Trailing stop') {
      const give = this._trailGive(peak);
      if (give > 0 && Number.isFinite(peak) && pnl <= peak - give * 2) return 0;
    }
    return Math.min(Math.max(0, Number(s.triggerHoldMs) || 0), STOP_HOLD_MS);
  }

  /**
   * How much of a peak the trailing stop gives back, in net points. It is a SHARE of the peak, not a fixed number of
   * points, because every launch pull-back is proportional to the run: a 15-20% wobble is normal on a coin up 60%, and
   * a flat 4-point trail sold those runners at the first wobble. That is the whole shape of the desk - the rare big
   * winner has to be allowed to be big, or a hundred small losses have nothing to pay for them.
   *
   * Measured before (fixed give-back, tightening to 5 after the first rung and to 2 once past three times the target):
   * every profit rule in a paper session closed between +6% and +12% while the losses filled at -21% to -33%, which
   * cannot be won by any entry rule. The floor (`trailGivePct`) still protects a small peak tightly.
   */
  _trailGive(peak) {
    const floor = Math.max(0, Number(this.s.trailGivePct) || 0);
    const wide = Math.max(0, Number(peak) || 0) * TRAIL_GIVE_FRAC;
    return Math.max(floor, wide);
  }

  _pnlPct(p) {
    // A position with no reference price cannot be measured. Returning 0 instead of Infinity keeps every rule quiet
    // until a real price arrives, which is the only honest reading of "nobody knows what this cost".
    if (!(p.entryMc > 0) || !(p.mc >= 0)) return 0;
    return (p.mc / p.entryMc - 1) * 100 - this._costPct(p);
  }

  /**
   * Everything a trade costs, as a percentage of the ticket: the protocol both ways plus the tips that are actually
   * paid. The tips are a fixed amount, so on a small ticket they are most of the round trip - at a 0.004 SOL ticket
   * two 0.0002 SOL tips and the protocol are 12% of the ticket, so a 12% stop is reached only once the price has
   * fallen about 24%. Every rule and every percentage the window shows is measured net of this, because that is the
   * number that decides whether money was made.
   *
   * The tips are the ones the trade really pays, not the configured ceiling: smart fees follow the live fee market,
   * so the entry tip is the one recorded on the position and the exit tip is what an exit would cost right now.
   */
  _costPct(p) {
    const ticket = Math.max(0.001, Number(p.solIn) || 0);
    const entry = Number(p.feeBuy) || 0;
    const exit = Number(this._feeFor(true)) || 0;
    const tips = ((entry + exit) / ticket) * 100;
    return FEE * 2 * 100 + (Number.isFinite(tips) ? tips : 0);
  }

  /**
   * A chain rejection as a sentence. The raw code stays available to the engine, but nothing a person reads should
   * ever contain `{"InstructionError":[3,{"Custom":6002}]}`.
   */
  _whyRejected(err) {
    const text = String(err || '');
    if (/6063|UnsupportedQuoteMint/i.test(text)) return 'this coin is quoted in another token, not SOL';
    if (/6002|6003|SlippageExceeded|slippage/i.test(text)) return 'the price moved before the order landed';
    if (/6005|BondingCurveComplete/i.test(text)) return 'the curve closed while the order was in flight';
    if (/6004|MintDoesNotMatch/i.test(text)) return 'the market is not the one asked for';
    if (/6001|InsufficientFunds/i.test(text)) return 'the wallet did not have the SOL for it';
    // The rent-exempt floor is 0.00089 SOL: under it the runtime refuses to debit the fee payer at all, so the order
    // never lands and the position looks like it is simply not selling. Measured live at 0.000658 SOL.
    if (/InsufficientFundsForRent|rent.exempt|no record of a prior credit/i.test(text)) return 'the wallet is below the 0.00089 SOL the network keeps for rent, so it cannot pay a fee';
    if (/6006|BondingCurveNotComplete/i.test(text)) return 'the curve is not finished, so the new pool refused it';
    if (/BlockhashNotFound|blockhash/i.test(text)) return 'the transaction expired before it landed';
    if (/insufficient|not enough/i.test(text)) return 'the wallet did not have the SOL for it';
    return 'the chain refused it';
  }

  /**
   * The price an entry is taken at, and the refusal when the board behind it is out of date.
   *
   * The board price is what the entry rules were judged on, and it can be a minute old: a scanned coin's row is
   * refreshed in tens of seconds, a rate-limited exchange answer is older than its arrival stamp, and a launch can give
   * back half its move in that time. Measured in paper on the live market, entries were booked at the board's price and
   * the very first reading - the pool's own reserves - showed -18% to -31%, which booked a stop loss 0 to 16 seconds
   * after the buy on a coin that had not fallen that far. That is not the exit rule being late, it is the entry being
   * blind.
   *
   * So the entry asks the pool, right now, in both modes:
   *  - the pool is the number the order fills against, so it is the entry price (a paper trade then measures the plan
   *    instead of measuring a stale number);
   *  - a pool more than `BOARD_STALE_FRAC` BELOW the board means the coin is falling right now, while the row we judged
   *    says it is rising. That is the single most common shape of a losing entry, and the entry is refused;
   *  - a pool far ABOVE the board is a coin running away from a slow row. The entry is still taken, at the pool's
   *    price, because that is what it would cost.
   *
   * With no curve to read (a graduated coin, or a failing node) the board is used only when the coin's own trade stream
   * is fresh: a coin priced by nothing recent is not a coin to buy.
   */
  async _entryPrice(t) {
    const board = Number(t.mc) || 0;
    let pool = 0;
    // One read with a short budget: a node that cannot answer in 700 ms is not a node to wait for while a coin is
    // moving, and the entry falls back to the board only when the coin's own trade stream is fresh. An engine started
    // offline (the test harness) has no pool to ask and must not wait for one.
    try {
      if (!this.offline) {
        const curves = await readCurves((fn, opts) => this.rpcCall(fn, { attempts: 1, budgetMs: 700, ...opts }), [t.mint]);
        const row = curves.get(t.mint);
        // A FINISHED curve is a fossil: its reserves stop moving when the coin graduates, so its "market cap" stays at
        // the graduation figure for ever while the coin trades on PumpSwap at whatever the pool there says. Measured in
        // a paper run on the live market: two coins were bought at a frozen curve price and then "ran" +264% and +308%
        // in a second, which was not a move, it was the fossil being read as a price.
        if (row && row.mcSol > 0 && !row.complete) pool = row.mcSol;
      }
    } catch (_) { pool = 0; }
    if (!(pool > 0)) {
      // Nothing to read a pool from - a graduated coin, or a node that could not answer in time. The board price is
      // used, but only while the coin has been heard about recently: a row nobody has refreshed is not a price.
      if (!(board > 0)) return { mc: board, refuse: 'No price to buy on' };
      const heard = Math.max(Number(t.lastActivity) || 0, Number(t.lastStreamAt) || 0, Number(t.ext && t.ext.at) || 0);
      if (Date.now() - heard > ENTRY_PX_MAX_AGE_MS) return { mc: board, refuse: 'No fresh price to buy on' };
      return { mc: board, src: 'board' };
    }
    // A pool three times the board is not the same coin (a foreign supply, a wrong account): the board is the safer
    // number, and the position's own curve reading will correct it within the second anyway.
    const usable = board > 0 && pool < board * 3;
    const mc = usable ? pool : board;
    t.mc = mc;
    if (board > 0 && pool < board * (1 - BOARD_STALE_FRAC)) {
      return { mc, src: 'curve', refuse: `Price dropped ${Math.round((1 - pool / board) * 100)}% while the coin was being judged` };
    }
    return { mc, src: 'curve' };
  }

  /**
   * The holder count for one candidate, fetched once and remembered for ten minutes. Only the extra entry filters
   * ask for it, so the market host is never hammered: a coin that passes the rest of the gates costs one request,
   * and a coin that is already cached costs none. A count that could not be read comes back as 0 - the caller is the
   * one that decides what "unknown" means.
   */
  async _holdersFor(t) {
    const now = Date.now();
    if (t.holders > 0 && now - (t.holdersAt || 0) < 10 * 60000) return t.holders;
    try {
      const row = await this.market.holders(t.mint);
      if (row && row.holders > 0) { t.holders = row.holders; t.holdersAt = now; }
    } catch (_) { /* unknown */ }
    return t.holders > 0 ? t.holders : 0;
  }

  async _buy(t, ev) {
    const s = this.s;
    const now = Date.now();
    this.buyTimes = this.buyTimes.filter((x) => now - x < 60000);
    if (this.buyTimes.length >= s.maxBuysPerMin) return;
    if (this.positions.size >= s.maxPositions) return;
    // One entry per coin at a time, and never a coin that was just closed. An exit takes about a second to land,
    // and checking this only when the decision is made let the same falling coin be bought again in that gap.
    if (this.positions.has(t.mint) || this._unsupported.has(t.mint)) return;
    const cool = this.cooldowns.get(t.mint);
    if (cool && now < cool) return;
    if (this.pausedUntil && now < this.pausedUntil) return;
    const book = this.books[s.mode === 'live' ? 'live' : 'paper'];
    if (book.sessionPnl <= -s.sessionLossLimitSol) {
      // The limit protects the wallet; it must not switch the desk off while it still holds coins. Entries stop,
      // exits keep working, and the reason is on screen with the time it ends.
      this.pausedUntil = now + 30 * 60000;
      this.pauseReason = `session loss limit reached (${book.sessionPnl.toFixed(3)} SOL)`;
      this._log('warn', `Session loss limit reached (${book.sessionPnl.toFixed(3)} SOL). New entries paused for 30 minutes. Open positions still close normally.`);
      return;
    }
    const sol = Math.min(s.buyAmountSol, HARD_MAX_SOL_PER_TRADE);
    if (this._freeSol() < this._cashNeeded()) {
      if (!this._lowBalWarned || now - this._lowBalWarned > 30000) {
        this._lowBalWarned = now;
        const free = this._freeSol();
        this._log('warn', `Not enough SOL to buy and keep the exit fees aside (${free.toFixed(4)} SOL free, ${this._cashNeeded().toFixed(4)} needed). Deposit SOL or lower the buy amount.`);
      }
      return;
    }
    // The extra entry filters, on the freshest count the market can give. A coin under the holder bar is not bought,
    // and neither is a coin whose count cannot be read: a filter that silently passes when its data source is down
    // is not a filter. The coin stays on the list with the reason, so the market explains itself. Off while the
    // simple settings are on - those are an advanced rule, and the simple mode turns advanced rules off.
    if (!s.simpleMode && s.deepEntry && s.minHolders > 0) {
      const holders = await this._holdersFor(t);
      if (holders < s.minHolders) {
        t.reason = holders > 0 ? `Needs ${s.minHolders} holders (has ${holders})` : 'Holder count unknown';
        return;
      }
    }
    t.status = 'bought';
    const t0 = Date.now();
    const feeBuy = this._feeFor(false);
    const paper = s.mode !== 'live';
    // The slot is reserved BEFORE any network wait: the entry is priced at the pool and refused when the board behind
    // the decision is behind a fall (see `_entryPrice`), and a second coin that passes while this one is still pricing
    // has to see this position already taking one of the allowed slots. The order build starts at the same moment as
    // the price read and waits behind a gate: nothing is broadcast, and nothing is counted against the rate cap, on a
    // refusal. The two waits overlap instead of adding up, which is one network round trip saved on every entry.
    const p = {
      mint: t.mint, symbol: t.symbol, name: t.name, entryMc: Number(t.mc) || 0, mc: Number(t.mc) || 0, peakMc: Number(t.mc) || 0,
      solIn: sol, feeBuy, openedAt: now, status: 'confirming', closing: false, paper, fails: 0, nextTry: 0, pending: !paper,
      // What the coin looked like when it was taken, kept with the row: without it a closed trade says what it did and
      // never why it was chosen, and a plan cannot be judged from that.
      entryScore: ev.score, entryCh5: t.ext && typeof t.ext.change5m === 'number' ? t.ext.change5m : null,
      entryBuyers: ev.m ? ev.m.buyers : null,
    };
    this.positions.set(t.mint, p);
    this._persistPositions();
    const pxP = this._entryPrice(t);
    let first = null;
    if (!paper) {
      const slip = this._slippageFor(t.mint, false);
      const gate = pxP.then((px) => { if (px.refuse) { const e = new Error('Refused by the entry price gate'); e.aborted = true; throw e; } });
      first = this._tradeLive('buy', t.mint, sol, { slippage: slip, fee: feeBuy, pool: t.graduated ? 'auto' : 'pump', gate })
        .catch((e) => e);
    }
    const px = await pxP;
    if (px.refuse) {
      this.positions.delete(t.mint);
      this._persistPositions();
      t.status = 'watching';
      t.reason = px.refuse;
      this.stats.entryPx.refused++;
      return;
    }
    p.entryMc = px.mc;
    p.mc = px.mc;
    p.peakMc = px.mc;
    this.stats.entryPx[px.src === 'curve' ? 'curve' : 'board']++;
    this.buyTimes.push(now);
    // A coin that was just bought has to be priced at its curve from the first second, not four seconds later when
    // the next scheduled sync runs: every exit rule is measured on that number.
    if (!paper && this._feedLabel === 'pumpdev') this._syncSubscriptions();
    this._log('buy', `Buying ${t.symbol} for ${sol} SOL (score ${ev.score}, ${ev.m.buyers} buyers)`);
    try {
      if (paper) {
        p.entryMc = px.mc * (1 + PAPER_SLIP);
        this.paper.balance -= sol * (1 + FEE) + feeBuy;
        p.status = 'open';
        p.pending = false;
      } else {
        // One order, then at most one more when the chain refused the price rather than the market. A rejected
        // transaction is free of tokens and costs only the fee, so trying again wider is safe and it is the
        // difference between missing a runner and catching it. The retry also re-routes: if the curve has moved to
        // PumpSwap the coin is marked graduated and the second attempt goes to the right market.
        const place = (slippage, via) => (via === 'backup'
          ? this._backupTrade('buy', t.mint, sol, { slippage })
          : this._tradeLive('buy', t.mint, sol, { slippage, fee: feeBuy, pool: t.graduated ? 'auto' : 'pump' }));
        // The ticket, the tip and the rent for the new token account leave the wallet the moment the order is
        // placed, so they are counted against it before the chain has confirmed anything.
        const order = (slippage, via) => {
          if (!p.spendNoted) { p.spendNoted = true; this._noteSpend(sol + feeBuy + TOKEN_RENT_SOL); }
          return place(slippage, via);
        };
        const settle = async (r) => {
          p.sig = r.sig;
          this.stats.lastLatencyMs = Date.now() - t0;
          if (r.landed) { await this.refreshBalance(); return { state: 'confirmed', err: '' }; }
          // The balance read and the first status poll run at once: neither answer depends on the other, and the
          // confirm loop is what decides whether the desk can act on this position.
          const confP = this._confirm(r.sig, r.raw);
          await this.refreshBalance();
          return confP;
        };
        let confirmed;
        if (first) {
          // The order that was already being built behind the gate: an error here is exactly the error the old
          // serial path would have thrown, so the retry ladder below sees the same thing.
          const r = await first;
          if (r instanceof Error) throw r;
          if (!p.spendNoted) { p.spendNoted = true; this._noteSpend(sol + feeBuy + TOKEN_RENT_SOL); }
          confirmed = await settle(r);
        } else {
          confirmed = await settle(await order(this._slippageFor(t.mint, false)));
        }
        if (confirmed.state === 'failed') {
          // Measured on chain: 6063 is UnsupportedQuoteMint, a coin whose curve is not quoted in SOL. No tolerance
          // or route can fill that order, so the coin is retired instead of being paid for again.
          // 6005 and 6004 mean the curve has moved on; 6002 is a price that ran while the order was in flight.
          const unsupported = /6063|UnsupportedQuoteMint/i.test(confirmed.err);
          const wrongMarket = /6005|6004|BondingCurve|Complete/i.test(confirmed.err);
          const priceRefused = /6002|6003|slippage/i.test(confirmed.err);
          if (unsupported) {
            t.unsupported = true;
            this._unsupported.add(t.mint);
          } else if (wrongMarket) {
            t.graduated = true;
          }
          if (wrongMarket && !s.allowGraduated) {
            this._log('info', `${t.symbol} finished its curve while the order was in flight. Left alone, because graduated coins are switched off.`);
          } else if (priceRefused || wrongMarket) {
            // A refused order costs nothing but the fee, so it is retried once - through the backup route, which
            // quotes fresh against the same market and puts the tolerance on the tokens instead of on the SOL.
            this._log('info', `${t.symbol} moved while the order was in flight. Re-quoting.`);
            confirmed = await settle(await order(s.slippagePct, 'backup'));
            if (confirmed.state === 'confirmed') this._log('info', `${t.symbol} filled on the re-quote.`);
          }
        }
        // Live from the first byte on the wire: a stop, a target or the time limit must work while the chain is
        // still answering. `pending` is the only thing the confirmation decides.
        p.status = 'open';
        p.openedAt = Date.now();
        if (confirmed.state === 'unknown') {
          const held = await this._tokenBalanceRaw(t.mint).catch(() => null);
          if (held === 0n) throw new Error('Not confirmed and the wallet holds none of it');
          p.pending = false;
          this._log('warn', held === null
            ? `The RPC could not confirm the buy of ${t.symbol}. Keeping it on the book and managing it.`
            : `Buy of ${t.symbol} verified through the wallet balance.`);
        } else if (confirmed.state === 'failed') {
          throw Object.assign(new Error(this._whyRejected(confirmed.err)), {
            definite: true, phase: 'rejected',
          });
        } else {
          p.pending = false;
          this._log('ok', `Bought ${t.symbol} for ${sol.toFixed(4)} SOL.`);
        }
        // The token amount the wallet really holds is the baseline every later sale is measured against.
        if (this.positions.get(t.mint) === p) p.tokIn = await this._tokenBalanceRaw(t.mint).catch(() => null);
      }
    } catch (e) {
      // An exit may have closed this position while the confirmation was still running.
      if (this.positions.get(t.mint) !== p) return;
      // A send that timed out may still land, so the wallet gets the last word before the buy is called off.
      const unsure = !paper && !e.definite && e.phase !== 'build';
      const held = unsure ? await this._tokenBalanceRaw(t.mint).catch(() => null) : null;
      if (held > 0n) {
        p.status = 'open'; p.pending = false; p.tokIn = held;
        this._persistPositions();
        this._log('warn', `Buy of ${t.symbol} landed after the error - now managing it.`);
        return;
      }
      if (held === null && unsure) {
        // The balance could not be read either, so nothing here proves the order failed. Keeping the position is
        // the safe side: if the tokens are there they get managed and sold, if not the first exit says so.
        p.status = 'open'; p.pending = false;
        this._persistPositions();
        this._log('warn', `The RPC could not tell whether the buy of ${t.symbol} landed (${e.message}). Managing it and checking on the first exit.`);
        return;
      }
      this.positions.delete(t.mint);
      this._persistPositions();
      t.tries = (t.tries || 0) + 1;
      const fatal = /locked|Safety check|Not enough/i.test(e.message);
      // A coin the chain refused on its own terms is not tried again: an unsupported quote mint cannot be bought
      // from here at all, and a graduated coin is only bought when the user switched that on.
      const settled = t.unsupported || (t.graduated && !this.s.allowGraduated);
      // Only an order that certainly never reached the chain is tried again: a second buy of a coin whose first
      // order might still land would leave twice the tokens on a book that tracks one entry.
      if (!fatal && !settled && (e.definite || e.phase === 'build') && t.tries < 2) {
        t.status = 'watching'; t.retryAt = Date.now() + 2500;
        this._log('info', `${t.symbol}: ${e.message}. Trying once more.`);
      } else {
        t.status = 'skipped';
        // A refusal from the chain is an ordinary event in a sniping desk - the price ran, the curve closed, the
        // market quotes another token - and it reads as one sentence, never as a program error.
        this._log(fatal ? 'error' : 'info', `Skipped ${t.symbol}: ${e.message}.`);
      }
    }
  }

  async _sell(p, why, pct = 100, opts = {}) {
    if (p.closing || Date.now() < p.nextTry) return;
    p.closing = true;
    const s = this.s;
    const t1 = Date.now();
    const part = Math.max(1, Math.min(100, Number(pct) || 100));
    const urgent = why !== 'Take profit' && why !== 'Take profit part 1';
    const feeSell = this._feeFor(urgent);
    try {
      if (!p.paper) {
        // No SOL in the wallet means no fee, and no fee means the order is refused before it reaches the chain. It
        // is said once, in plain words with the address to send to, instead of an endless "not confirmed".
        if (this._balance() < EXIT_FEE_FLOOR_SOL) {
          this._warnNoFeeSol();
          throw Object.assign(new Error(this._noFeeSentence()), { noFee: true });
        }
        // A take-profit exit must never be filled below break-even just because the price fell while the order was
        // built. If the level is gone, the sale is abandoned and the next tick decides - the stop and the trail are
        // there for that, and selling a winner at a loss is the one thing the owner asked never to see.
        if (!urgent && this._pnlPct(p) <= 0) {
          p.closing = false;
          p.nextTry = Date.now() + 250;
          p.trigger = null;
          this._log('info', `${p.symbol} slipped back to ${this._pnlPct(p).toFixed(1)}% before the order went out. Not selling it at a loss; watching again.`);
          return;
        }
        // And a risk rule is checked once more against the freshest price, right before the order is signed. A stop
        // that fired on a dip the coin has already recovered from is not a stop: selling there is how a coin that was
        // still climbing got closed at a profit with "Stop loss" written on it, and how a trailing stop sold a coin
        // that had already bounced back above its give-back level. A press of Sell or Sell all is never second-guessed.
        if (!opts.manual) {
          const now2 = this._pnlPct(p);
          const peak = this._pnlPct({ ...p, mc: p.peakMc || p.mc });
          // The room the trail gives back has to be asked for from the same rule the sale came from: a fixed 4-5 points
          // here would call every legitimate trailing sale "gone", because the trail now fires 45% of a peak below it.
          const give = this._trailGive(peak);
          let gone = null;
          if (/^Stop loss/.test(why) && now2 > 0) gone = `it is back to +${now2.toFixed(1)}%`;
          else if (/^Break even/.test(why) && now2 > 0) gone = `it is back to +${now2.toFixed(1)}%`;
          else if (/^Trailing stop/.test(why) && peak > 0 && now2 > peak - give) {
            gone = `the give-back is gone (peak +${peak.toFixed(1)}%, now +${now2.toFixed(1)}%)`;
          }
          if (gone) {
            p.closing = false;
            p.nextTry = Date.now() + 150;
            p.trigger = null;
            this._log('info', `${p.symbol}: ${why} was about to sell a risk that is no longer there - ${gone}. Not selling it; watching again.`);
            return;
          }
        }
        const order = (slippage, via) => (via === 'backup'
          ? this._backupTrade('sell', p.mint, null, { slippage, pct: part })
          : this._tradeLive('sell', p.mint, null, { slippage, fee: feeSell, pct: part, pool: p.graduated ? 'auto' : 'pump' }));
        // What the wallet holds before the order goes out is not needed any more: the trade's own transaction says
        // exactly what it moved, and that is the only number that cannot be a neighbour's opinion.
        const settle = async (r) => {
          this.stats.lastSellMs = Date.now() - t1;
          // An exit does not wait ten seconds on an order that never landed: it asks for two and a half seconds, and
          // an order that has not shown up by then is retried, which on a falling coin is worth far more than
          // certainty about the first one.
          const out = r.landed ? { state: 'confirmed', err: '' } : await this._confirm(r.sig, r.raw, { acceptProcessed: true, polls: 10 });
          if (out.state === 'confirmed' && r.sig) {
            const delta = await this._txSolDelta(r.sig);
            if (delta != null) p.proceeds = delta;
          }
          return out;
        };
        let confirmed;
        const pnlNow = this._pnlPct(p);
        const slip = this._slippageFor(p.mint, urgent, pnlNow);
        if (urgent && part >= 99.5) {
          // An exit cannot afford to wait for one door: both are asked at once and the first signed transaction wins.
          // If the second lands too it fails on a balance that is already gone, which costs a fee and never sells
          // twice. The tolerance is the exit's own (`slip`), which is already the tight 15% while the coin is up and
          // the wide one when it is under water. Measured before: a refused stop cost 1.2 s of re-quoting while the
          // coin fell - with both doors in the air a stalled primary does not hold the stop any more.
          const r = await Promise.any([
            this._tradeLive('sell', p.mint, null, { slippage: slip, fee: feeSell, pct: part, pool: p.graduated ? 'auto' : 'pump' }),
            this._backupTrade('sell', p.mint, null, { slippage: slip, pct: part }),
          ]);
          confirmed = await settle(r);
        } else {
          confirmed = await settle(await order(slip));
        }
        if (confirmed.state === 'failed') {
          const wrongMarket = /6005|6004|BondingCurve|Complete/i.test(confirmed.err);
          const priceRefused = /6002|6003|6063|slippage/i.test(confirmed.err);
          // A coin can finish its curve while it is being held, and then the curve can no longer sell it. The
          // position follows the market: the retry asks the backup route, which finds the new pool itself.
          if (wrongMarket) { p.graduated = true; const tok = this.tokens.get(p.mint); if (tok) tok.graduated = true; }
          if (wrongMarket || priceRefused) {
            this._log('info', `${p.symbol} moved while the sell was in flight. Re-quoting.`);
            // The re-quote carries the exit's own tolerance, not the entry ceiling: a stop re-quoted at 10% after a
            // 20% refusal is a stop that gets refused twice while the coin keeps falling.
            confirmed = await settle(await order(this._slippageFor(p.mint, urgent, this._pnlPct(p)), 'backup'));
          }
        }
        if (confirmed.state === 'failed') {
          throw Object.assign(new Error(this._whyRejected(confirmed.err)), { phase: 'rejected' });
        }
        if (confirmed.state === 'unknown') throw new Error('Sell not confirmed by the RPC');
        this.refreshBalance();
      }
      // What actually left the wallet decides what the book records. A route that sells a different amount than it
      // was asked for (a partial fill, a percentage resolved against a smaller balance) must not close a position
      // that still holds tokens, and must not book a size it never sold.
      let soldPct = p.paper ? part : await this._measuredPct(p, part);
      if (!p.paper && soldPct != null && soldPct < 0.5) {
        // A node that is a block behind still reports the tokens it just saw sold, so the reading is taken again a
        // moment later before the sale is called a no-op.
        await new Promise((r) => setTimeout(r, 700));
        soldPct = await this._measuredPct(p, part);
      }
      if (!p.paper && soldPct == null) throw new Error('The sale could not be measured against the wallet balance');
      if (soldPct < 0.5) throw new Error('The sale went through but the wallet still holds the tokens');
      this._finishSell(p, why, feeSell, soldPct);
    } catch (e) {
      // A sell that landed after the timeout leaves nothing to sell: detect it instead of retrying forever.
      if (!p.paper) {
        try {
          const held = await this._tokenBalanceRaw(p.mint);
          if (held === 0n) {
            // A position kept on the safe side when the RPC could not say whether its buy landed, and which the
            // wallet now proves never did: nothing was spent, so nothing is booked against the live result.
            if (!p.sig && p.tokIn == null) {
              this.positions.delete(p.mint);
              this._persistPositions();
              this._log('warn', `${p.symbol}: the wallet holds none of it, so the buy never landed. Dropped from the book.`);
              return;
            }
            this._finishSell(p, why, feeSell, 100);
            return;
          }
          // The balance moved but the confirmation did not arrive: some of it sold, so that part is booked and the
          // rest stays a position instead of being sold twice.
          const soldPct = await this._measuredPct(p, part);
          if (soldPct != null && soldPct >= 0.5) { this._finishSell(p, why, feeSell, soldPct); return; }
        } catch (_) { /* unknown */ }
      }
      p.closing = false;
      p.fails++;
      // An exit never waits long: a refused order costs one fee, while a position that could not be closed for
      // minutes is the whole risk of the desk. The first retry is a blink - a refused stop on a falling coin is worth
      // re-sending at once - and only a repeated refusal is given a longer rest.
      p.nextTry = Date.now() + (p.fails === 1 ? 300 : Math.min(6000, 900 * p.fails));
      if (e.noFee) {
        // The automatic exits keep trying quietly; a press of Sell must answer, or the button looks broken.
        if (opts.manual) throw e;
        return;
      }
      this._log(p.fails >= 5 ? 'error' : 'warn', `${p.symbol} has not sold yet: ${e.message}. Retrying${p.fails >= 5 ? ' - if this keeps up, close it from the Wallet tab with Sell every coin' : ''}.`);
    }
  }

  /** The one sentence about the fee, written once so the log and the button say the same thing. */
  _noFeeSentence() {
    const addr = this.wallet.address() || 'your wallet';
    return `Out of SOL for the network fee: the wallet holds ${this._balance().toFixed(6)} SOL, under the 0.00089 SOL the network keeps for rent, so nothing can be sent. Send SOL to ${addr} and the coins sell by themselves.`;
  }

  /** One plain sentence per minute about the one thing only the owner can fix. */
  _warnNoFeeSol() {
    const now = Date.now();
    if (this._noFeeWarned && now - this._noFeeWarned < 60000) return;
    this._noFeeWarned = now;
    this._log('error', this._noFeeSentence());
  }

  /**
   * How much of the position really left, as a percentage of what it held before the sale. The wallet balance is
   * the only witness that cannot be wrong, so it is the one that is asked.
   */
  async _measuredPct(p, wantPct) {
    const seen = { gone: false };
    const now = await this._tokenBalanceRaw(p.mint, seen).catch(() => null);
    if (now == null) return null;
    // An account that is gone means its rent came back to the wallet in the same sale: that is not profit.
    if (now === 0n) { p.tokIn = 0n; p.rentBack = seen.gone ? TOKEN_RENT_SOL : 0; return 100; }
    const before = p.tokIn == null ? null : p.tokIn;
    if (before == null || before <= 0n) {
      // No baseline: assume the request is what happened, and keep the fresh balance as the new baseline.
      p.tokIn = now;
      return wantPct;
    }
    const sold = before > now ? Number(before - now) / Number(before) : 0;
    p.tokIn = now;
    return Math.round(sold * 1000) / 10;
  }

  /**
   * The SOL a given transaction moved for this wallet, read from the transaction itself. Reading the wallet balance
   * twice was wrong: two RPC nodes can be at different blocks, so the difference carried the previous trade and a real
   * profit was reported as a loss of the whole ticket.
   */
  async _txSolDelta(sig) {
    const kp = this.wallet.keypair;
    if (!kp || !sig) return null;
    // An exit is confirmed at `processed`, which is often a moment before the transaction is readable at `confirmed`,
    // so the same lookup is tried twice at the looser level rather than falling back to an estimate.
    for (const commitment of ['processed', 'confirmed']) {
      const tx = await this.rpcCall((c) => c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment }), { attempts: 3, budgetMs: 8000 }).catch(() => null);
      const keys = tx && tx.transaction && tx.transaction.message.staticAccountKeys;
      if (!keys || !tx.meta) continue;
      const i = keys.findIndex((k) => k.equals(kp.publicKey));
      if (i < 0) continue;
      return (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
    }
    return null;
  }

  _finishSell(p, why, feeSell, pct = 100) {
    const s = this.s;
    // A sale measured at 99.6% is a full exit with dust left over, not a partial one. Rounding it the other way
    // would keep a position whose whole value is a few tokens nobody can sell.
    const raw = Math.max(0, Math.min(100, Number(pct) || 100));
    const part = (raw >= 99.5 ? 100 : raw) / 100;
    const soldSol = Math.max(1e-9, p.solIn * part);
    let pnlSol;
    const measured = !p.paper && p.proceeds != null && part === 1;
    if (p.paper) {
      const exitMc = p.mc * (1 - PAPER_SLIP);
      const proceeds = soldSol * (exitMc / p.entryMc) * (1 - FEE);
      this.paper.balance += proceeds;
      pnlSol = proceeds - soldSol * (1 + FEE) - p.feeBuy * part - feeSell;
    } else if (measured) {
      // What the wallet actually gained, minus what was put in and the entry costs, minus any rent the same
      // transaction returned for a closed account. This is the money, not an estimate.
      pnlSol = p.proceeds - (p.rentBack || 0) - soldSol - p.feeBuy * part;
    } else {
      // The exit price is the one the rule fired at: `p.mc` may already be a quote of the pool our own sale moved.
      const exitMc = p.mcAtFire || p.mc;
      pnlSol = soldSol * (exitMc / p.entryMc) * (1 - FEE) - soldSol * (1 + FEE) - p.feeBuy * part - feeSell;
    }
    p.proceeds = null;
    const pnlPct = (pnlSol / soldSol) * 100;
    const book = this.books[p.paper ? 'paper' : 'live'];
    book.pnl += pnlSol;
    book.sessionPnl += pnlSol;
    this.history.unshift({
      ts: Date.now(), symbol: p.symbol, mint: p.mint, solIn: soldSol, pnlSol, pnlPct, reason: why, paper: p.paper,
      // What the trade actually was, so the row can be read without the log: how long it was held, the move that fired
      // the rule, and the best it was ever worth. A closed trade that "peaked at +41%" and filled at +8% is an exit
      // that was too early, and that is a fact the desk has to keep, not a number that disappears with the position.
      heldSec: p.openedAt ? Math.round((Date.now() - p.openedAt) / 1000) : null,
      firedPct: p.firedAt == null ? null : Number(p.firedAt),
      peakPct: p.peakPct == null ? null : Math.round(Number(p.peakPct) * 10) / 10,
      src: p.pxSource || null,
      // Why the coin was taken, beside what it did.
      score: p.entryScore == null ? null : p.entryScore,
      ch5: p.entryCh5 == null ? null : Math.round(Number(p.entryCh5)),
      buyers: p.entryBuyers == null ? null : p.entryBuyers,
    });
    if (this.history.length > 100) this.history.pop();
    // The move that fired the rule is in the line, and so is the move that was actually filled when the two differ:
    // "Take profit at +70%, filled at -5%" is the truth about a spike that got away, and it must not be hidden.
    const firedAt = this._pnlPct({ ...p, mc: p.mcAtFire || p.mc });
    const slipNote = p.firedAt != null && Math.abs(firedAt - p.firedAt) >= 5
      ? `, filled at ${firedAt >= 0 ? '+' : ''}${firedAt.toFixed(1)}%`
      : '';
    const atNote = slipNote ? ` (${why} at ${p.firedAt >= 0 ? '+' : ''}${p.firedAt.toFixed(1)}%${slipNote})` : ` (${why} at ${firedAt >= 0 ? '+' : ''}${firedAt.toFixed(1)}%)`;
    const basis = p.paper ? '' : measured ? ' (paid by the chain)' : ' (estimated)';
    this._log(pnlSol >= 0 ? 'ok' : 'sell', `Sold ${part < 1 ? Math.round(part * 100) + '% of ' : ''}${p.symbol}${atNote}: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL${basis}`);

    if (part < 1) {
      p.solIn -= soldSol;
      // The entry tip is spent once, so the part that is still open must not carry it again: without this a remainder
      // sold at +14% was booked as a small loss.
      p.feeBuy = Math.max(0, p.feeBuy * (1 - part));
      p.tp1Done = true;
      p.peakMc = p.mc;
      p.peakPct = this._pnlPct({ ...p, mc: p.peakMc });
      p.closing = false;
      p.nextTry = 0;
      this._persistPositions();
      return;
    }

    this.positions.delete(p.mint);
    this._persistPositions();
    book.trades++;
    // The coin goes back on the market board as a watched coin, not as "Bought" for ever: the status was never reset,
    // so a coin that had been bought once could never be judged again (and the table kept saying it was held) even
    // after its cooldown had passed.
    const tok = this.tokens.get(p.mint);
    if (tok && tok.status === 'bought') { tok.status = 'watching'; tok.reason = 'Sold, waiting for the cooldown'; }
    // A coin that just closed is left alone for a while. Without this the desk bought the same falling coin three
    // times in a row (measured on the live feed: one mint, four entries, three losses).
    this.cooldowns.set(p.mint, Date.now() + 15 * 60000);
    if (pnlSol >= 0) {
      book.wins++;
      this.lossStreak = 0;
    } else {
      book.losses++;
      this.lossStreak = (this.lossStreak || 0) + 1;
      if (s.pauseMinutes > 0 && this.lossStreak >= s.maxLossStreak) {
        this.pausedUntil = Date.now() + s.pauseMinutes * 60000;
        this.pauseReason = `${this.lossStreak} losses in a row`;
        this._log('warn', `${this.lossStreak} losses in a row - new entries paused for ${s.pauseMinutes} minutes. Open positions still close normally.`);
        this.lossStreak = 0;
      }
    }
    if (!p.paper) this._settleMint(p.mint);
    this._shutdownIfIdle();
  }

  /** Sell a balance the book does not track. The trade door comes first: the backup route has no quote for amounts
   *  that small, which is why leftovers used to stay in the wallet for ever. */
  async _sellAny(mint, slippage) {
    const slip = Math.max(Number(slippage) || 0, this.s.slippagePct, 20);
    try {
      const r = await this._tradeLive('sell', mint, null, { slippage: slip, fee: this._feeFor(true), pct: 100, pool: 'auto' });
      const left = await this._tokenBalanceRaw(mint).catch(() => null);
      if (left === 0n) return true;
      if (r && r.landed) return true;
    } catch (_) { /* the next door may still fill it */ }
    await this._backupTrade('sell', mint, null, { slippage: slip, pct: 100 }).catch(() => {});
    const left = await this._tokenBalanceRaw(mint).catch(() => null);
    return left === 0n;
  }

  /** Every sale ends here: the remainder is sold (or burned when it is worth less than its rent), the account is
   *  closed and the ~0.00204 SOL of rent comes back. One at a time, never in the way of the next exit - and never
   *  dropped: a coin that arrives while another is settling waits its turn in the queue. */
  async _settleMint(mint) {
    if (this.s.mode !== 'live' || !this.wallet.isUnlocked() || !this.s.autoReclaim) return;
    if (this.positions.has(mint)) return;
    this._settleQueue.add(mint);
    if (this._settling) return;
    this._settling = true;
    try {
      while (this._settleQueue.size) {
        const next = this._settleQueue.values().next().value;
        this._settleQueue.delete(next);
        await this._settleOne(next).catch(() => {});
      }
    } finally {
      this._settling = false;
    }
  }

  async _settleOne(mint) {
    const before = await this._tokenBalanceRaw(mint).catch(() => null);
    if (before == null) return;
    let left = before;
    // The remainder a full sell leaves is the trade door's own cut. It goes back out through that door first.
    if (left > 0n) {
      await this._sellAny(mint, Math.max(this.s.slippagePct, 20)).catch(() => {});
      left = await this._tokenBalanceRaw(mint).catch(() => null);
      if (left == null) return;
    }
    // What neither door could sell is dust worth less than the rent it is holding: burning it and closing the
    // account returns the ~0.00204 SOL instead of leaving it locked for good. Anything worth more is left alone.
    if (left > 0n) {
      const freed = await this._burnDust(mint, left).catch(() => false);
      if (freed) left = 0n;
    }
    if (left > 0n) return;
    await this._closeEmptyWhenFree();
    await this.refreshBalance();
  }

  /** Close the accounts an exit just emptied. A cleanup already running (the sweep, a press of Recover rent) holds
   *  the lock for a moment; waiting for it beats throwing the rent the exit just freed away. */
  async _closeEmptyWhenFree(tries = 8) {
    for (let i = 0; i < tries; i++) {
      if (!this._reclaiming) return this.closeEmptyAccounts().catch(() => null);
      await new Promise((r) => setTimeout(r, 300));
    }
    this._scheduleReclaim();
    return null;
  }

  /** True when the leftover was burned and its account closed, which is only worth doing for dust. */
  async _burnDust(mint, amountRaw) {
    if (!this.s.recoverDust) return false;
    const scan = await this._tokenAccounts().catch(() => null);
    const acct = scan && scan.accounts.find((a) => a.mint === mint);
    if (!acct) return false;
    const price = (await this.market.prices([mint]).catch(() => new Map())).get(mint);
    const usd = price ? Number(acct.uiAmount) * price.priceUsd : null;
    const rentSol = acct.lamports / 1e9;
    const rentUsd = rentSol * (this.market.solPrice() || 0);
    // Burn only when the trade destroys less than it frees. A token no price service knows AND that neither door
    // could sell is worth nothing measurable - that is exactly the case whose rent would otherwise stay locked for
    // ever, so it is treated as worthless. A priced holding is left alone when it is worth more than half its rent.
    if (usd != null && (!(rentUsd > 0) || usd > rentUsd * 0.5)) return false;
    const kp = this._requireWallet();
    const burn = reclaim.makeBurner((fn, opts) => this.rpcCall(fn, opts), kp);
    await burn({ ...acct, amount: amountRaw.toString() });
    if (acct.lamports) this.stats.reclaimedSol += rentSol;
    this._log('ok', `Closed the dust account of ${mint.slice(0, 6)}: ${usd == null ? 'a leftover no market prices' : usd < 0.01 ? 'under a cent' : '$' + usd.toFixed(2)} of tokens burned to get ${rentSol.toFixed(5)} SOL of rent back.`);
    return true;
  }

  async sellPosition(mint) {
    const p = this.positions.get(mint);
    if (!p) throw new Error('That coin is not an open position.');
    if (p.status !== 'open') throw new Error(`${p.symbol} is still confirming its buy. Try again in a second.`);
    p.nextTry = 0;
    await this._sell(p, 'Manual sell', 100, { manual: true });
    const left = p.paper ? 0n : await this._tokenBalanceRaw(mint).catch(() => null);
    if (left && left > 0n) throw new Error(`${p.symbol} did not sell: the wallet still holds it. Press Sell again, or use Sell all in the Wallet tab.`);
    return { sold: true, symbol: p.symbol };
  }

  async sellAll() {
    const open = [...this.positions.values()].filter((p) => p.status === 'open');
    if (!open.length) throw new Error('No open positions to sell.');
    const failed = [];
    for (const p of open) {
      p.nextTry = 0;
      try {
        await this._sell(p, 'Manual sell', 100, { manual: true });
        const left = p.paper ? 0n : await this._tokenBalanceRaw(p.mint).catch(() => null);
        if (left && left > 0n) failed.push(`${p.symbol}: still in the wallet`);
      } catch (e) { failed.push(`${p.symbol}: ${e.message}`); }
    }
    if (failed.length) throw new Error(failed[0]);
    // Closing everything is an instruction about the market, not only about the coins: without this the desk bought
    // again in the same second and the hand that pressed "sell all" watched it refill.
    this.pausedUntil = Date.now() + 2 * 60000;
    this.pauseReason = 'you sold everything';
    this._log('info', 'All positions sold. New entries paused for 2 minutes; anything open now still closes by its rules.');
    return { sold: open.length };
  }

  _tick() {
    const now = Date.now();
    const s = this.s;
    this._seq = (this._seq || 0) + 1;
    for (const p of this.positions.values()) {
      if (p.status !== 'open' || p.closing) continue;
      const t = this.tokens.get(p.mint);
      if (p.mc > (p.peakMc || 0)) { p.peakMc = p.mc; p.peakPct = this._pnlPct(p); }
      const pnl = this._pnlPct(p);
      const peak = this._pnlPct({ ...p, mc: p.peakMc || p.mc });
      let why = null;
      // The RULE and the label are two different things. The label carries the number that made it interesting ("peaked
      // at +12.8%"), and that number moves - so keying the trigger on the label made a trailing stop start its wait
      // again on every tick where the peak changed, and it never fired at its give-back at all. Measured in a paper
      // run: a coin that peaked at +12.8% was sold by the trailing stop at -5.3%.
      let rule = null;
      let pct = 100;
      // Order matters for the label the player reads, and the sale is the same whichever rule matched. A stop that
      // is blown through in one tick is still a stop, so the loss limit is checked before the rules that protect a
      // profit: a coin that gapped from +12% to -31% must not be reported as "break even".
      if (t && t.devSold) { rule = 'Creator sold'; why = rule; }
      else if (pnl >= s.takeProfitPct) { rule = 'Take profit'; why = rule; }
      // Simple settings closes only on the target, the stop and the time limit: the first rung, the trail and the
      // break even are advanced rules, and while the simple mode is on they are off by definition.
      else if (!s.simpleMode && s.tp1Pct > 0 && !p.tp1Done && pnl >= s.tp1Pct) { rule = 'Take profit part 1'; why = rule; pct = clamp(s.tp1SellPct, 10, 90); }
      else if (pnl <= -s.stopLossPct) { rule = 'Stop loss'; why = rule; }
      // After the first rung has been banked the rest is a runner, and a runner is given less room: the whole point of
      // taking the first bite is that the remainder can be sold at the top instead of giving the move back.
      else if (!s.simpleMode && peak >= s.trailArmPct && pnl <= peak - this._trailGive(peak)) { rule = 'Trailing stop'; why = `${rule} (peaked at +${peak.toFixed(1)}%)`; }
      // A coin that has already shown a real gain is not allowed to become a loss: most of the losing trades in
      // this market are winners that were given back, and the fees make a round trip to zero worse than nothing.
      else if (!s.simpleMode && s.breakEvenPct > 0 && peak >= s.breakEvenPct && pnl <= 0) { rule = 'Break even'; why = rule; }
      else if ((now - p.openedAt) / 1000 >= s.maxHoldSec) { rule = 'Time limit'; why = rule; }
      if (!why) { p.trigger = null; continue; }
      // The creator selling and the time limit are not price thresholds and act at once. Everything else is a level
      // that has to HOLD: it must be seen again after `triggerHoldMs`, on a fresh reading, before the bot sells. A
      // spike that is gone in one tick is not a signal, and selling into it is how a +135% print filled at -3%.
      // A RISK rule is the exception, and it is timed by `_riskHoldMs`: a profit target waits for a spike to prove
      // itself, while a stop or a trail is watching money leave, and 400 ms of it is a fifth of the move.
      if (rule === 'Creator sold' || rule === 'Time limit') { this._sell(p, why, pct); continue; }
      const seen = p.trigger;
      if (!seen || seen.rule !== rule || now - seen.at > 3000) { p.trigger = { rule, at: now, pxAt: p.pxAt || 0, seq: this._seq }; continue; }
      const holdMs = RISK_RULES.has(rule) ? this._riskHoldMs(rule, pnl, peak, p.pxSource) : Math.max(0, Number(s.triggerHoldMs) || 0);
      const held = now - seen.at >= holdMs;
      const fresh = p.pxAt ? (p.pxAt || 0) > seen.pxAt : this._seq > seen.seq;
      if (!held || !fresh) continue;
      p.trigger = null;
      p.firedAt = Math.round(pnl * 10) / 10;
      p.mcAtFire = p.mc;
      this._sell(p, why, pct);
    }
    if (s.mode === 'live' && s.smartFees && now - (this._feeAt || 0) > 4000 && (this.running || this.positions.size)) { this._feeAt = now; this._refreshFee(); }
    if (this.ws && this._feedLabel === 'pumpdev' && now - (this._subAt || 0) > 4000) { this._subAt = now; this._syncSubscriptions(); }
    if (this.chain && now - Math.max(this._chainAt || 0, this._lastEv || 0) > 12000) {
      // The chain feed can be silently blocked by a public node. Say it once a minute, not on every tick.
      if (!this._chainWarnAt || now - this._chainWarnAt > 60000) {
        this._chainWarnAt = now;
        this._fallback('no data received for 12 s');
      }
    }
    if (this.running) this._scan(now);
    this._shutdownIfIdle();
  }

  /** Priority fee in SOL. Smart mode follows live network fees (cheap when quiet); profile value is the ceiling. */
  _feeFor(urgent) {
    const s = this.s;
    const cap = s.priorityFeeSol;
    if (!s.smartFees || s.mode !== 'live' || this._feeSol == null) return cap;
    const v = this._feeSol * (urgent ? 2 : 1);
    return Math.max(Math.min(FEE_FLOOR_SOL, cap), Math.min(cap, v));
  }

  async _refreshFee() {
    try {
      const rows = await this.rpcCall((c) => c.getRecentPrioritizationFees({ lockedWritableAccounts: [new PublicKey(PUMP_PROGRAM)] }));
      const vals = rows.slice(-30).map((r) => r.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
      const p75 = vals.length ? vals[Math.floor(vals.length * 0.75)] : 0;               // micro-lamports per CU
      this._feeSol = Math.max(FEE_FLOOR_SOL, (p75 * FEE_CU_ESTIMATE) / 1e6 / 1e9);
    } catch (_) { /* keep last known value */ }
  }

  /**
   * Slippage tolerance in %. The ceiling is a promise: nothing here ever goes above it. Smart mode only makes an
   * entry tighter on a calm coin, because an exit must be able to land at the number the user chose.
   */
  _slippageFor(mint, urgent, pnlPct = null) {
    const s = this.s;
    const cap = s.slippagePct;
    // An exit that does not fill is worse than an exit that fills lower: a refused stop costs a whole second of
    // re-quoting while the coin keeps falling. So an urgent exit is never tighter than EXIT_SLIP_MIN.
    if (urgent) {
      const base = Math.min(EXIT_SLIP_MAX, Math.max(cap, EXIT_SLIP_MIN));
      // Any exit that is still in profit gets the tight tolerance, whatever its trigger was called. A stop needs room to
      // fill because any price beats no sale; a profit does not - a 40% tolerance on a coin that is +8% is an
      // instruction that may fill at -32%, which is exactly the "it was up and it sold me a loss" report.
      const inProfit = Number.isFinite(pnlPct) && pnlPct >= 0;
      return inProfit ? Math.min(base, SPIKE_SLIP) : base;
    }
    if (!s.smartFees) return cap;
    const t = this.tokens.get(mint);
    const g = t ? Math.abs(this._metrics(t, Date.now(), 5).growth) : 0.05;
    return Math.round(clamp(MIN_SLIP + g * 100 * 1.2, Math.min(MIN_SLIP, cap), cap) * 10) / 10;
  }

  _guardTx(tx, amountSol) {
    // Refuse transactions that move far more SOL out through plain transfers than this trade is supposed to spend.
    // The allowance has to cover the ticket itself: a route that funds a wrapped SOL account sends exactly the
    // ticket through a system transfer, and a guard that refused that would block the buy it is protecting.
    // `lamportsOut` refuses a message whose program ids sit in an address lookup table, so nothing is invisible.
    const { instructions } = readTx(tx);
    const total = lamportsOut(instructions);
    const ticket = typeof amountSol === 'number' && amountSol > 0 ? amountSol : 0;
    const allowed = BigInt(Math.round((TX_GUARD_MAX_SOL + ticket * 1.1) * 1e9));
    if (total > allowed) throw new Error('Safety check blocked a suspicious transaction.');
  }

  /**
   * Send signed bytes to several nodes at once and take the first signature that comes back. A transaction only
   * lands when it reaches a leader, so the same bytes go out on parallel doors: the first sender that answers wins
   * and the rest are left to fail quietly. The bytes are identical, so a second node accepting them cannot make a
   * second trade.
   *
   * With Jito switched on the same transaction is also offered to the block engine as a bundle with a tip, started
   * before the RPC doors so both are in the air at once. The bundle either lands whole - trade and tip together - or
   * not at all, so the tip costs nothing when it loses; the RPC send is never given up in exchange for it.
   */
  async _broadcast(raw) {
    const lane = this._jitoLane(raw).catch(() => false);
    const sig = this.rpc.broadcast ? await this.rpc.broadcast(raw) : await this.rpcCall((c) => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }), BROADCAST);
    lane.catch(() => {});
    return sig;
  }

  /**
   * The Jito lane: the trade's own signed bytes plus one tip transfer, as one bundle. Never throws and never changes
   * what the normal route did - the tip only leaves the wallet if the bundle lands.
   */
  async _jitoLane(raw) {
    if (!this.s.useJito || !raw) return false;
    const kp = this.wallet.keypair;
    if (!kp) return false;
    try {
      const lamports = Math.round(Math.max(0.000001, Number(this.s.jitoTipSol) || 0.0001) * 1e9);
      if (BigInt(lamports) < MIN_TIP_LAMPORTS) throw new Error("the tip is below Jito's own minimum");
      const tips = await this.jito.tipAccounts();
      const to = tips[Math.floor(Math.random() * tips.length)];
      // The tip transaction reuses the trade's blockhash, so both are valid for exactly as long as the trade is.
      const trade = VersionedTransaction.deserialize(new Uint8Array(raw));
      const { Transaction, SystemProgram } = require('@solana/web3.js');
      const tipTx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: trade.message.recentBlockhash });
      tipTx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports }));
      tipTx.sign(kp);
      // The tip is built here and nowhere else: one transfer, to an address Jito itself named, for an amount the user
      // set. Anything else in this transaction would be a bug, so it is checked rather than trusted.
      if (tipTx.instructions.length !== 1) throw new Error('the tip transaction is not a single transfer');
      const ix = tipTx.instructions[0];
      if (!ix.programId.equals(SystemProgram.programId)) throw new Error('the tip is not a system transfer');
      if (!ix.keys[1].pubkey.equals(new PublicKey(to))) throw new Error('the tip does not pay a Jito account');
      const id = await this.jito.sendBundle([raw, tipTx.serialize()]);
      this._log('info', `Offered to Jito as a bundle (tip ${(lamports / 1e9).toFixed(6)} SOL, paid only if it lands).`);
      return Boolean(id);
    } catch (e) {
      // Once a minute at most: a block engine that is down is not an error the trade depends on.
      if (!this._jitoWarnedAt || Date.now() - this._jitoWarnedAt > 60000) {
        this._jitoWarnedAt = Date.now();
        this._log('warn', `Jito: ${e.message}. The normal route is unaffected.`);
      }
      return false;
    }
  }

  /** Primary route: PumpPortal builds the transaction, we sign it locally and send it through our own RPC. */
  async _execLive(action, mint, amount, denomSol, opt = {}) {
    const kp = this.wallet.keypair;
    if (!kp) throw new Error('Wallet is locked');
    const s = this.s;
    const body = {
      publicKey: kp.publicKey.toBase58(), action, mint, amount,
      denominatedInSol: denomSol ? 'true' : 'false',
      slippage: opt.slippage != null ? opt.slippage : s.slippagePct,
      priorityFee: opt.fee != null ? opt.fee : s.priorityFeeSol, pool: opt.pool || 'auto',
    };
    // An error from this half of the route means nothing was signed, so trying the other door is safe. An error
    // after the send is a different animal: the transaction may already be on chain, and a second order would buy
    // the same coin twice with real money.
    const buildFail = (message) => Object.assign(new Error(message), { phase: 'build' });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    let r;
    try {
      r = await fetch(TRADE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw buildFail(e.name === 'AbortError' ? 'Trade API timed out' : 'Trade API unreachable: ' + e.message);
    } finally { clearTimeout(timer); }
    if (!r.ok) {
      // The door answers a 400 with a sentence of its own. It is passed on in plain words, because it is what decides
      // whether the coin is worth a second look ("Bad Request" alone tells nobody anything).
      const why = (await r.text().catch(() => '')).slice(0, 120);
      throw buildFail(/bad request/i.test(why)
        ? 'the trade door could not price this coin yet'
        : `the trade door refused it${why ? ` (${why})` : ''}`);
    }
    let tx;
    try {
      tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
    } catch (e) {
      throw buildFail('Trade API sent a transaction that could not be read: ' + e.message);
    }
    this._guardTx(tx, denomSol ? amount : null);
    tx.sign([kp]);
    const raw = tx.serialize();
    // An entry starts its build while the pool price is still being read, so the two waits overlap. The gate is the
    // price verdict: a coin the desk refuses is discarded here, signed but never broadcast - the wire is the only
    // place money can leave.
    if (opt && opt.gate) await opt.gate;
    const sig = await this._broadcast(raw);
    return { sig, raw };
  }

  /**
   * Execute a live trade. The backup route is used only when the primary one provably did not fill the order: a
   * failure before anything was signed, or a transaction the chain itself rejected (which by definition bought
   * nothing). A send whose outcome is unknown never falls back, because that could buy the same coin twice.
   */
  async _tradeLive(action, mint, solAmount, opt) {
    const tip = Number(this.s.priorityFeeSol) || 0;
    try {
      const r = await this._execLive(action, mint, action === 'buy' ? solAmount : (opt && opt.pct && opt.pct < 100 ? opt.pct + '%' : '100%'), action === 'buy', opt);
      this.stats.feeSpentSol = (this.stats.feeSpentSol || 0) + tip;
      return r;
    } catch (e) {
      if (e.phase !== 'build' && e.phase !== 'rejected') throw e;
      if (/locked|Safety check/i.test(e.message)) throw e;
      // A rejection on chain is a transaction that landed and failed: the tip is gone, and the book must say so.
      if (e.phase === 'rejected') {
        this.stats.feeSpentSol = (this.stats.feeSpentSol || 0) + tip;
        this.stats.orderFails = (this.stats.orderFails || 0) + 1;
      }
      this._log('info', `The first route did not fill (${this._whyRejected(e.message)}). Trying the backup route.`);
      try {
        const sig = await this._jupiterSwap(action, mint, solAmount, opt);
        // No tip is counted here: the backup route pays no priority fee of ours, it takes its cut inside the swap
        // itself, and that shows up in the fill the wallet reports. Counting a tip that never left the wallet is how
        // the fee line became a number nobody could reconcile.
        return { sig, raw: null, landed: true };
      } catch (jupErr) {
        // Neither door filled the order, so the caller still knows nothing was signed and may retry safely.
        throw Object.assign(new Error(`${e.message}; the backup route also failed (${jupErr.message})`), {
          phase: e.phase,
          definite: Boolean(e.definite),
        });
      }
    }
  }

  /**
   * The backup route as an order like any other: same shape as `_execLive`, so the retry ladders treat both doors
   * the same. A swap that answers with a signature has landed, which is why `landed` is true here.
   */
  async _backupTrade(action, mint, solAmount, opt) {
    try {
      // The fee counter is only for tips this wallet really paid on its own transactions. A swap route charges
      // inside the fill, so nothing is added here; the measured proceeds already carry that cost.
      const sig = await this._jupiterSwap(action, mint, solAmount, opt);
      return { sig, raw: null, landed: true };
    } catch (e) {
      this.stats.orderFails = (this.stats.orderFails || 0) + 1;
      throw e;
    }
  }

  async _jupiterSwap(action, mint, solAmount, opt) {
    const kp = this.wallet.keypair;
    if (!kp) throw new Error('Wallet is locked');
    let amountRaw;
    if (action === 'buy') amountRaw = BigInt(Math.floor(solAmount * 1e9));
    else {
      amountRaw = await this._tokenBalanceRaw(mint);
      // A partial exit must stay partial on the backup route too, otherwise the book keeps a position whose
      // tokens are already gone.
      const pct = Number(opt && opt.pct) || 100;
      if (pct < 100) amountRaw = (amountRaw * BigInt(Math.round(pct))) / 100n;
      if (amountRaw <= 0n) throw new Error('Nothing to sell');
    }
    return this.jup.swap({
      keypair: kp, inputMint: action === 'buy' ? WSOL : mint, outputMint: action === 'buy' ? mint : WSOL,
      amountRaw: amountRaw.toString(), slippageBps: (opt.slippage != null ? opt.slippage : this.s.slippagePct) * 100,
      guard: (tx, owner) => assertSwapTx(tx, owner, { maxSolOut: action === 'buy' ? solAmount : 0 }),
    });
  }

  /**
   * Raw token balance of the wallet for one mint, and whether the account itself is gone - which is what returns its
   * rent. The two are returned together because a shared flag could be overwritten by another balance read between
   * the answer and the moment it is used, and that would put a rent-sized hole in the profit of a sale.
   */
  async _balanceDetail(mint) {
    const owner = this.wallet.keypair && this.wallet.keypair.publicKey;
    if (!owner) throw new Error('Wallet is locked');
    // Bounded on purpose: this runs while a position is held back by an exit, so it must not stall the loop.
    const res = await this.rpcCall((c) => c.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }), { timeoutMs: 2500, attempts: 3, budgetMs: 6000 });
    let amount = 0n;
    for (const it of res.value) amount += BigInt(it.account.data.parsed.info.tokenAmount.amount);
    return { amount, gone: res.value.length === 0 };
  }

  /** Raw token balance of the wallet for one mint (0n if there is no account). `out`, when given, receives whether
   *  the account itself is gone - which is what returns its rent. It is written into the caller's own object rather
   *  than a shared field, because another balance read can finish before the value is used. */
  async _tokenBalanceRaw(mint, out = null) {
    const d = await this._balanceDetail(mint);
    if (out) out.gone = d.gone;
    return d.amount;
  }

  /**
   * Wait for the chain to answer. Three outcomes, because "the RPC could not tell me" is not "it failed":
   * `confirmed`, `failed` (the chain rejected it, and only that) and `unknown` (no confirmation, no rejection).
   * The rejection reason is returned with it, because the code names the market that refused the order.
   *
   * The first status is asked for at once - a slot is 400 ms and the first poll used to burn one of them - and the
   * exit path accepts `processed`, because the wallet balance is what decides whether tokens really left. A status
   * that is written into a fork the chain then drops comes back as a failed or missing transaction on the balance
   * read, and that read is the one that closes a position.
   * @returns {Promise<{state: 'confirmed'|'failed'|'unknown', err: string}>}
   */
  async _confirm(sig, raw, opts = {}) {
    const step = opts.step || 250;
    const polls = Math.max(2, Number(opts.polls) || CONFIRM_POLLS);
    const acceptProcessed = Boolean(opts.acceptProcessed);
    for (let i = 0; i < polls; i++) {
      if (i) await new Promise((r) => setTimeout(r, step));
      if (raw && i % 8 === 7 && i < polls - 1) {
        this.rpcCall((c) => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }), BROADCAST).catch(() => {});
      }
      try {
        const { value } = await this.rpcCall((c) => c.getSignatureStatuses([sig]), { attempts: 2, budgetMs: 4000 });
        const st = value[0];
        if (st) {
          if (st.err) return { state: 'failed', err: JSON.stringify(st.err).slice(0, 200) };
          if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { state: 'confirmed', err: '' };
          if (acceptProcessed && st.confirmationStatus === 'processed') return { state: 'confirmed', err: '' };
        }
      } catch (_) { /* ask again */ }
    }
    return { state: 'unknown', err: '' };
  }

  _requireWallet() {
    if (!this.wallet.exists()) throw new Error('Create your wallet first.');
    if (!this.wallet.isUnlocked()) throw new Error('Unlock your wallet first.');
    return this.wallet.keypair;
  }

  async scanWallet() {
    const addr = this.wallet.address();
    if (!addr) throw new Error('Create your wallet first.');
    const r = await reclaim.scanTokenAccounts((fn, opts) => this.rpcCall(fn, opts), addr);
    const mini = (a) => ({ mint: a.mint, uiAmount: a.uiAmount, rentSol: a.lamports / 1e9, frozen: a.frozen });
    return {
      emptyCount: r.empty.length, emptyRentSol: r.emptyRentSol,
      dust: r.dust.map(mini), dustRentSol: r.dustRentSol,
      frozen: r.frozen.map(mini), frozenRentSol: r.frozenRentSol,
    };
  }

  /** Free local cleanup: closes only zero-balance token accounts and returns the rent to the wallet. */
  async closeEmptyAccounts() {
    const kp = this._requireWallet();
    if (this._reclaiming) throw new Error('A cleanup is already running.');
    this._reclaiming = true;
    try {
      const r = await reclaim.scanTokenAccounts((fn, opts) => this.rpcCall(fn, opts), kp.publicKey.toBase58());
      const held = new Set(this.positions.keys());
      const accounts = r.empty.filter((a) => !held.has(a.mint));
      if (!accounts.length) return { closed: 0, sol: 0, errors: [] };
      const res = await reclaim.closeEmpty({ accounts, sendChunk: reclaim.makeSender((fn, opts) => this.rpcCall(fn, opts), kp) });
      this.stats.reclaimedSol += res.sol;
      if (res.closed) this._log('ok', `Recovered ${res.sol.toFixed(5)} SOL from ${res.closed} empty token account${res.closed > 1 ? 's' : ''}.`);
      if (res.errors.length) this._log('warn', 'Some accounts could not be closed: ' + res.errors[0]);
      this.refreshBalance();
      return res;
    } finally { this._reclaiming = false; }
  }

  /**
   * Sell one holding the wallet carries, whether or not the book has a position for it. Used for the leftover
   * balances listed in the Wallet tab, where burning would destroy value that can still be sold.
   */
  async sellHolding(mint) {
    this._requireWallet();
    const m = String(mint || '');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) throw new Error('Invalid token address.');
    const held = await this._tokenBalanceRaw(m);
    if (held == null) throw new Error('The balance of that token could not be read.');
    if (held === 0n) throw new Error('The wallet holds none of that token.');
    const before = this.walletBalance;
    await this._sellAny(m, Math.max(this.s.slippagePct, 10));
    const left = await this._tokenBalanceRaw(m).catch(() => null);
    await this.refreshBalance();
    const gained = before != null && this.walletBalance != null ? this.walletBalance - before : null;
    this._log('ok', `Sold the leftover balance of ${m.slice(0, 6)}${gained != null && gained > 0 ? ` for about ${gained.toFixed(5)} SOL` : ''}${left === 0n ? '' : ' (some tokens are still there)'}.`);
    const p = this.positions.get(m);
    if (p && left === 0n) { p.nextTry = 0; this._finishSell(p, 'Sell all', this._feeFor(true), 100); }
    return { left: left == null ? null : left.toString(), gained };
  }

  /**
   * Sell every coin the wallet holds and hand the rent back.
   * The book only knows what this process bought, and a wallet can hold more than that: a coin bought by hand, one
   * left behind by a crash before the book was written, an account closed by a partial exit. So the wallet balance,
   * not the book, decides what leaves: each holding goes out through the backup route, which quotes the market it
   * finds rather than the one assumed, and each account that ends empty is closed so its rent comes home.
   */
  async sellEverything() {
    this._requireWallet();
    if (this._sellingAll) throw new Error('A sell-all is already running.');
    // Said before anything is attempted: with no SOL for the fees every order is refused, and a button that spends
    // a minute failing in silence reads as a broken button.
    if (this._balance() < EXIT_FEE_FLOOR_SOL) { this._warnNoFeeSol(); throw new Error(this._noFeeSentence()); }
    this._sellingAll = true;
    const out = { sold: 0, tokens: 0, skipped: 0, failed: [], closed: 0, rentSol: 0, solBefore: this.walletBalance, solAfter: null };
    this._log('info', 'Selling every coin the wallet holds.');
    try {
      // Tracked positions first, through the normal ladder: it books the result and follows a coin that has moved
      // to PumpSwap. A position whose tokens are already gone is booked from the wallet, never sold twice.
      for (const p of [...this.positions.values()]) {
        if (p.paper) continue;
        p.nextTry = 0;
        const held = await this._tokenBalanceRaw(p.mint).catch(() => null);
        if (held === 0n) { this._finishSell(p, 'Sell all', this._feeFor(true), 100); continue; }
        await this._sell(p, 'Sell all', 100, { manual: true }).catch((e) => out.failed.push(`${p.symbol}: ${e.message}`));
        const left = await this._tokenBalanceRaw(p.mint).catch(() => null);
        if (left === 0n && this.positions.has(p.mint)) this._finishSell(p, 'Sell all', this._feeFor(true), 100);
      }
      // Then whatever is still on chain, tracked or not. Frozen accounts belong to the token's issuer, so they are
      // reported instead of attempted.
      const scan = await this._tokenAccounts();
      for (const a of scan.frozen) out.failed.push(`${a.mint.slice(0, 6)} is frozen by its issuer, so it cannot be sold`);
      for (const a of scan.dust) {
        out.tokens++;
        try {
          await this._sellAny(a.mint, Math.max(this.s.slippagePct, 10));
          const left = await this._tokenBalanceRaw(a.mint).catch(() => null);
          if (left === 0n) out.sold++;
          else {
            // Worth less than its own rent: burned and closed so the SOL comes home instead of sitting locked.
            if (await this._burnDust(a.mint, left).catch(() => false)) out.sold++;
            else out.failed.push(`${a.mint.slice(0, 6)}: the market took only part of the balance`);
          }
          this.refreshBalance();
        } catch (e) {
          out.failed.push(`${a.mint.slice(0, 6)}: ${this._whyRejected(e.message)}`);
        }
      }
      const closed = await this.closeEmptyAccounts().catch((e) => { out.failed.push('Closing accounts: ' + e.message); return null; });
      if (closed) { out.closed = closed.closed; out.rentSol = closed.sol; }
      // Selling everything is an instruction about the market, not only about the coins: without this the desk bought
      // again in the same second and the hand that pressed the button watched the wallet refill.
      this.pausedUntil = Date.now() + 2 * 60000;
      this.pauseReason = 'you sold every coin';
      await this.refreshBalance();
      out.solAfter = this.walletBalance;
      const recovered = out.solBefore != null && out.solAfter != null ? out.solAfter - out.solBefore : null;
      this._log(out.failed.length ? 'warn' : 'ok', `Sell-all finished: ${out.sold} of ${out.tokens} coin${out.tokens === 1 ? '' : 's'} sold, ${out.closed} account${out.closed === 1 ? '' : 's'} closed, ${out.rentSol.toFixed(5)} SOL of rent back${recovered != null ? `, wallet ${recovered >= 0 ? '+' : ''}${recovered.toFixed(5)} SOL` : ''}.`);
      for (const f of out.failed.slice(0, 3)) this._log('warn', `  ${f}`);
      return out;
    } finally { this._sellingAll = false; }
  }

  _scheduleReclaim() {
    if (!this.s.autoReclaim || this.s.mode !== 'live' || !this.wallet.isUnlocked()) return;
    clearTimeout(this._reclaimTimer);
    this._reclaimTimer = setTimeout(() => {
      this.closeEmptyAccounts().catch((e) => {
        // Housekeeping, never an alarm: a scan that could not be answered is retried on the next exit, and the
        // rent it would return is a fraction of a cent. Said once per ten minutes at most.
        if (this._reclaimWarned && Date.now() - this._reclaimWarned < 600000) return;
        this._reclaimWarned = Date.now();
        this._log('info', 'Rent recovery is waiting for a node that can list the token accounts; it runs again after the next sell.');
      });
    }, 20000);
  }

  async _signAndSendApi(b58tx, guard) {
    const kp = this.wallet.keypair;
    if (!kp) throw new Error('Wallet is locked');
    const { VersionedTransaction, Transaction } = require('@solana/web3.js');
    const bs58 = require('bs58');
    const bytes = bs58.decode(String(b58tx || ''));
    // A transaction built by an API is inspected before it is signed: whoever wrote those bytes decides what the
    // wallet does, and the signature is unconditional.
    let tx;
    try { tx = VersionedTransaction.deserialize(bytes); } catch (_) { tx = Transaction.from(bytes); }
    guard(tx, kp.publicKey.toBase58());
    if (tx instanceof VersionedTransaction) {
      tx.sign([kp]);
      const raw = tx.serialize();
      const sig = await this.rpcCall((c) => c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }), BROADCAST);
      return (await this._confirm(sig, raw)).state === 'confirmed';
    }
    tx.partialSign(kp);
    const raw = tx.serialize();
    const sig = await this.rpcCall((c) => c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }), BROADCAST);
    return (await this._confirm(sig, raw)).state === 'confirmed';
  }

  /** Sol Incinerator: close every empty account (API builds the transactions, we inspect, sign and send them). */
  async incineratorCloseAll() {
    const kp = this._requireWallet();
    const before = await this.rpcCall((c) => c.getBalance(kp.publicKey)).catch(() => null);
    const out = await this.inc.batchCloseAll(kp.publicKey.toBase58());
    const txs = Array.isArray(out.transactions) ? out.transactions : [];
    if (!txs.length) return { transactions: 0, confirmed: 0, accountsClosed: 0, sol: 0 };
    let ok = 0;
    const refused = [];
    for (const t of txs) {
      try {
        if (await this._signAndSendApi(t, (tx, owner) => assertCleanupTx(tx, owner))) ok++;
      } catch (e) { refused.push(e.message); }
    }
    // Only what the wallet actually gained counts. The API's own "reclaimed" figure is an estimate made before any
    // of these transactions existed, so it is never reported as money.
    const after = await this.rpcCall((c) => c.getBalance(kp.publicKey)).catch(() => null);
    const gained = before != null && after != null && after > before ? (after - before) / 1e9 : 0;
    if (refused.length) this._log('error', 'Sol Incinerator: ' + refused[0]);
    this._log(ok ? 'ok' : 'warn', `Sol Incinerator: ${ok} of ${txs.length} transactions confirmed${gained ? `, ${gained.toFixed(5)} SOL back in the wallet` : ''}.`);
    this.refreshBalance();
    return { transactions: txs.length, confirmed: ok, accountsClosed: out.accountsClosed || 0, sol: gained };
  }

  /** Sol Incinerator: burn the whole balance of one leftover token and close its account. */
  async incineratorBurn(mint) {
    const kp = this._requireWallet();
    if (this.positions.has(mint)) throw new Error('That coin is an open position. Sell it first.');
    if (String(mint) !== String(new PublicKey(mint).toBase58())) throw new Error('Invalid token address.');
    const out = await this.inc.burn(kp.publicKey.toBase58(), mint);
    if (out && out.assetId && String(out.assetId) !== String(mint)) throw new Error('The burn answer was for a different token and was refused.');
    const ok = await this._signAndSendApi(out.serializedTransaction, (tx, owner) => assertCleanupTx(tx, owner, { burnMint: mint }));
    if (!ok) throw new Error('The burn transaction was not confirmed.');
    this.refreshBalance();
    return { sol: Number(out.solanaReclaimed || 0) };
  }

  /**
   * SOL the wallet must keep for network fees: the rent-exempt floor plus a fee and a tip for every open position.
   * Public so the Wallet tab can hold it back from a withdrawal.
   */
  reserveForFees() { return this._reserveSol(); }

  _emitState() {
    const now = Date.now();
    const s = this.s;
    const all = [...this.tokens.values()];
    const list = all
      .sort((a, b) => (b.status === 'bought') - (a.status === 'bought') || b.score - a.score || b.createdAt - a.createdAt)
      .slice(0, 80)
      .map((t) => ({
        mint: t.mint, symbol: t.symbol, name: t.name, age: Math.round((now - (t.launchedAt || t.createdAt)) / 1000),
        mc: t.mc, score: t.score, buyers: t.buyers || 0, net: t.net || 0, status: t.status, reason: t.reason,
        source: [...(t.sources || [])].join('+') || 'launch',
        change5m: t.ext ? t.ext.change5m : null,
        liq: t.ext ? t.ext.liqUsd : null,
        live: now - (t.lastStreamAt || 0) < 15000,
      }));
    const buysPerMin = this.buyTimes.filter((x) => now - x < 60000).length;
    const launchesPerMin = this.launchTimes.filter((x) => now - x < 60000).length;
    const coverage = { total: all.length, launch: 0, trending: 0, callout: 0, new: 0, chain: 0, priced: 0, fresh: 0 };
    for (const t of all) {
      for (const src of t.sources || []) if (src in coverage) coverage[src]++;
      if (t.ext?.at) coverage.priced++;
      if (now - (t.lastStreamAt || 0) < 15000) coverage.fresh++;
    }
    this.emit('state', {
      running: this.running, mode: s.mode, connected: this.connected,
      balance: this._balance(), walletBalance: this.walletBalance,
      reserveSol: s.mode === 'live' ? this._reserveSol() : 0,
      freeSol: s.mode === 'live' ? this._freeSol() : this._balance(),
      // What the wallet really did since Start, fees included. While coins are open the money is inside them, so the
      // open part is marked at the price it is held at and its rent is counted back - otherwise a buy would look like
      // a loss. With nothing open this is exactly the wallet, which is the number that cannot lie.
      sessionStartSol: this.sessionStart ? this.sessionStart.balance : null,
      walletDeltaSol: (() => {
        if (!this.sessionStart || this.walletBalance == null) return null;
        let equity = this.walletBalance;
        for (const p of this.positions.values()) {
          if (p.paper) continue;
          const ratio = p.entryMc > 0 ? p.mc / p.entryMc : 1;
          equity += p.solIn * ratio + TOKEN_RENT_SOL;
        }
        return equity - this.sessionStart.balance;
      })(),
      stats: { ...this.stats, ...this.books[s.mode === 'live' ? 'live' : 'paper'], buysPerMin, launchesPerMin },
      paused: this.pausedUntil && now < this.pausedUntil ? { until: this.pausedUntil, reason: this.pauseReason || 'taking a break' } : null,
      coverage,
      feed: list,
      positions: [...this.positions.values()].map((p) => ({
        mint: p.mint, symbol: p.symbol, solIn: p.solIn, status: p.status, paper: p.paper, pending: Boolean(p.pending),
        pnlPct: this._pnlPct(p), heldSec: Math.round((now - p.openedAt) / 1000), mc: p.mc,
      })),
      rpc: this.rpc.status(), feeSol: this._feeFor(false),
      feedInfo: {
        source: this.feedSource || null,
        label: this._feedLabel || null,
        rate: this.chain ? this.chain.rate : 0,
        solUsd: this.market.solPrice(),
      },
      history: this.history.filter((h) => h.paper === (s.mode !== 'live')).slice(0, 30),
      logs: this.logs.slice(-40),
    });
  }
}

module.exports = { Engine, DEFAULTS, PROFILES, AUTOPILOT };
