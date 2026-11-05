const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Engine, DEFAULTS } = require('../src/engine');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exits-'));
const wallet = { exists: () => true, isUnlocked: () => true, address: () => 'W', keypair: null };

function engine(overrides = {}) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'exits-')), 's.json', DEFAULTS);
  store.set({ mode: 'paper', takeProfitPct: 40, stopLossPct: 20, maxHoldSec: 600, trailArmPct: 15, trailGivePct: 8, tp1Pct: 0, breakEvenPct: 0, triggerHoldMs: 0, ...overrides });
  const e = new Engine(wallet, store);
  clearInterval(e._bal);
  clearInterval(e._ui);
  e.refreshBalance = () => {};
  e._log = () => {};
  e.running = true;
  // A real session always knows the exchange rate, because the engine asks for it before judging a market-priced
  // coin. Without one here, a dollar net-flow figure could not be turned into SOL and every such coin would fail on
  // "needs net buying" for a reason the test is not about.
  e.market.solPrice = () => 150;
  return e;
}

function open(e, mint, solIn = 1) {
  const p = { mint, symbol: mint, entryMc: 100, mc: 100, peakMc: 100, solIn, feeBuy: 0.0001, openedAt: Date.now(), status: 'open', closing: false, paper: true, fails: 0, nextTry: 0 };
  e.positions.set(mint, p);
  e.tokens.set(mint, { mint, symbol: mint, mc: 100, mcHist: [], trades: [], status: 'bought', sources: new Set(['launch']) });
  return p;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  // Price at a given gross move: mcap 100 -> move of +x% is 100 * (1 + x/100).
  const at = (pct) => 100 * (1 + pct / 100);

  // Take profit fires on the net move, and a 40% target needs the fee drag on top.
  {
    const e = engine();
    const p = open(e, 'TP');
    p.mc = at(30);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('TP'), 'a 30% gross move is only 27% net, below a 40% target');

    p.mc = at(46);
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('TP'), 'a 43% net move clears the target');
    assert.match(e.history[0].reason, /Take profit/);
    // RULE ADDED: a closed coin goes back to being watched (with a cooldown) instead of staying "Bought" for ever,
    // which used to make it invisible to every later evaluation while the market table said it was still held.
    assert.strictEqual(e.tokens.get('TP').status, 'watching', 'the coin is back on the board after the sale');
  }

  // RULE CHANGED: a stop loss no longer waits `triggerHoldMs`. It has to be seen on a second, fresh price after
  // STOP_HOLD_MS (150 ms), and a coin already through twice its stop sells on the first reading. The 400 ms wait was
  // written for a take profit, where a spike has to prove itself; on a falling coin it is a fifth of the move -
  // measured in paper mode against the live market, a 10% stop held for 400 ms booked -26%, and a 22% stop -37%.
  {
    const e = engine({ stopLossPct: 20, triggerHoldMs: 400 });
    const p = open(e, 'SL');
    p.mc = at(-25);
    e._tick();
    assert.ok(e.positions.has('SL'), 'a stop is never sold on the reading that first sees it');
    await new Promise((r) => setTimeout(r, 170));
    e._tick();
    await settle();
    assert.ok(!e.positions.has('SL'), 'a stop sells 150 ms after the level is first seen, not after triggerHoldMs (400 ms)');
    assert.match(e.history[0].reason, /Stop loss/);
  }

  // A crash through twice the stop does not wait even for that, and a take profit still does.
  {
    const e = engine({ stopLossPct: 20, takeProfitPct: 40, triggerHoldMs: 400 });
    const p = open(e, 'CRASH');
    p.mc = at(-45);
    e._tick();
    assert.ok(e.positions.has('CRASH'), 'the first reading only arms the rule');
    e._tick();
    await settle();
    assert.ok(!e.positions.has('CRASH'), 'a coin through twice its stop sells on the next reading, with no hold at all');

    const q = open(e, 'SLOW');
    q.mc = at(45);
    e._tick();
    assert.ok(e.positions.has('SLOW'), 'a take profit waits for the level to hold');
    e._tick();
    await settle();
    assert.ok(e.positions.has('SLOW'), 'a take profit does not sell 0 ms after the level appears: triggerHoldMs still guards it');
  }

  // RULE CHANGED: the trailing stop is a RISK rule, so it waits `STOP_HOLD_MS` (150 ms) rather than `triggerHoldMs`
  // (400 ms). Measured in a paper run: a coin that peaked at +12.8% was sold by the trailing stop at -5.3%, because
  // 400 ms of confirmation on a falling coin is a fifth of the move. The trigger is also keyed on the rule rather than
  // on the label - the label carries the peak, and a label is not an identity.
  // RULE CHANGED AGAIN: the room the trail gives back is a share of the peak (45%, floored at `trailGivePct`), so this
  // coin that peaked at +47% net is not sold by a 10-point pull-back any more - only by one past 21 points.
  {
    const e = engine({ takeProfitPct: 80, trailArmPct: 15, trailGivePct: 8, triggerHoldMs: 400 });
    const p = open(e, 'TRAILKEY');
    p.mc = at(50);
    e._tick();
    assert.ok(e.positions.has('TRAILKEY'), 'the first reading arms the peak and sells nothing');

    // A pull-back inside the room the peak has earned holds the position: 47% net peaked, 21 points of room.
    p.mc = at(35);
    e._tick();
    assert.ok(e.positions.has('TRAILKEY'), 'a pull-back smaller than the peak\'s own room holds the position');

    // Give back more than the trail allows: the rule is on, the position has to hold the level before it sells.
    p.mc = at(20);
    e._tick();
    assert.ok(e.positions.has('TRAILKEY'), 'the give-back is seen, not acted on, on the first reading');
    await new Promise((r) => setTimeout(r, 170));
    e._tick();
    await settle();
    assert.ok(!e.positions.has('TRAILKEY'), 'a trailing stop sells 150 ms after the give-back, not after triggerHoldMs (400 ms)');
    assert.match(e.history[0].reason, /Trailing stop/);
    assert.match(e.history[0].reason, /peaked at \+/);
  }

  // RULE CHANGED: the trailing stop gives back a SHARE of the peak instead of a fixed number of points that was
  // tightened to 5 after the first rung and to 2 once past three times the target. With that shape every profit rule
  // in a paper session closed between +6% and +12% while the losses filled at -21% to -33% - a desk that cannot pay for
  // its own losers, whatever the entry rule does. The floor (`trailGivePct`) still protects a small peak tightly.
  {
    const e = engine({ takeProfitPct: 300, trailArmPct: 10, trailGivePct: 6 });
    assert.ok(Math.abs(e._trailGive(20) - 9) < 0.01, 'a +20% peak gives back 45% of it (9 points)');
    assert.ok(Math.abs(e._trailGive(100) - 45) < 0.01, 'a +100% peak gives back 45 points, so a runner has room to run');
    assert.ok(Math.abs(e._trailGive(5) - 6) < 0.01, 'under the floor the profile\'s own give-back still applies');
  }

  // The whole point of the wider room: a runner that pulls back 20 points and then doubles is still held.
  {
    const e = engine({ takeProfitPct: 300, trailArmPct: 10, trailGivePct: 6 });
    const p = open(e, 'RUNNER');
    p.mc = at(100);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('RUNNER'), 'a +97% net peak is not sold on the way up');
    p.mc = at(80);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('RUNNER'), 'a 20-point pull-back from a +97% peak is inside the room it earned');
    p.mc = at(200);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('RUNNER'), 'and the runner is still open at +194% net');
  }

  // The trailing stop protects a runner: peak 47% net, a pull-back inside the room it earned holds, a bigger one closes.
  {
    const e = engine({ takeProfitPct: 80 });
    const p = open(e, 'TRAIL');
    p.mc = at(50);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('TRAIL'), 'the peak is tracked but nothing fires yet');

    p.mc = at(45);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('TRAIL'), 'a small give back from the peak holds the position');

    // RULE CHANGED: 45% of a +47% net peak is 21 points of room, so the give-back that closes it is a bigger one.
    p.mc = at(25);
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('TRAIL'), 'a give back past the peak\'s own room closes it');
    assert.match(e.history[0].reason, /Trailing stop/);
    assert.match(e.history[0].reason, /peaked at \+/);
  }

  // A closed trade carries what it was worth at best, what fired it and how long it was held: the row in the window
  // has to be readable without the log, and a trade that peaked at +41% and filled at +8% has to keep that fact.
  {
    const e = engine({ takeProfitPct: 60, tp1Pct: 0 });
    const p = open(e, 'ROW');
    p.mc = at(45);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('ROW'), 'nothing closes on the way up');
    p.mc = at(75);
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('ROW'));
    const row = e.history[0];
    assert.ok(typeof row.heldSec === 'number' && row.heldSec >= 0, 'the row knows how long the coin was held');
    assert.ok(row.peakPct > 40, `the row keeps the best it was worth (got ${row.peakPct})`);
    assert.ok(row.firedPct != null && row.firedPct >= 60, `the row keeps the move that fired the rule (got ${row.firedPct})`);
  }

  // Partial take profit: half out at the first rung, the rest keeps running.
  {
    const e = engine({ tp1Pct: 20, tp1SellPct: 50 });
    const p = open(e, 'PART', 1);
    p.mc = at(25);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('PART'), 'the position stays open after the first rung');
    assert.strictEqual(e.positions.get('PART').tp1Done, true, 'the rung is marked so it cannot fire twice');
    assert.ok(Math.abs(e.positions.get('PART').solIn - 0.5) < 1e-9, 'half the size was sold');
    assert.strictEqual(e.books.paper.trades, 0, 'a partial sale is not a closed trade');
    assert.match(e.history[0].reason, /part 1/);
    assert.ok(e.history[0].pnlSol > 0, 'the rung banked a profit');
    assert.ok(e.paper.balance > 5, 'and the paper balance grew');

    // The rest exits on the hard target.
    p.mc = at(50);
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('PART'), 'the runner closes on the target');
    assert.strictEqual(e.books.paper.trades, 1, 'one round trip counted once');
  }

  // Stop loss is measured on the same net number the card shows: a 20% stop fires when the ticket is really
  // down 20%, which on this market is about a 17% fall of the price (the round trip costs 3%).
  {
    const e = engine();
    const p = open(e, 'SL');
    p.mc = at(-14);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('SL'), 'a 14% fall is 17% net, still above the 20% stop');
    p.mc = at(-19);
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('SL'), 'a 19% fall is 22% net, past the stop');
    assert.match(e.history[0].reason, /Stop loss/);
  }

  // A cold streak pauses new entries but never blocks an exit.
  {
    const e = engine({ maxLossStreak: 2, pauseMinutes: 5 });    for (const id of ['L1', 'L2']) {
      const p = open(e, id);
      p.mc = at(-25);
      e._tick(); e._tick();
      await settle();
    }
    assert.ok(e.pausedUntil > Date.now(), 'two losses in a row paused the desk');
    const before = e.positions.size;
    await e._buy({ mint: 'BLOCKED', symbol: 'B', mc: 100 }, { score: 90, m: { buyers: 20 } });
    assert.strictEqual(e.positions.size, before, 'no entry during the pause');

    const still = open(e, 'STILL');
    still.mc = at(-25);
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('STILL'), 'an open position still exits during the pause');
  }

  // The time limit closes a coin that went nowhere.
  {
    const e = engine({ maxHoldSec: 5 });
    const p = open(e, 'TIME');
    p.openedAt = Date.now() - 6000;
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('TIME'));
    assert.match(e.history[0].reason, /Time limit/);
  }

  // Break even: a coin that has been up a real amount is never allowed to become a loss. Losses in this market
  // are mostly winners given back, and the round trip costs fees twice.
  {
    const e = engine({ breakEvenPct: 12, tp1Pct: 0, takeProfitPct: 80, trailArmPct: 90 });
    const p = open(e, 'EVEN');
    p.mc = at(20);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('EVEN'), 'a 20% run arms the rule but does not close anything');

    p.mc = at(4);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('EVEN'), 'still 1% net up, so it holds');
    p.mc = at(1);
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('EVEN'), 'back to zero leaves the position');
    assert.match(e.history[0].reason, /Break even/);

    const off = engine({ breakEvenPct: 0, takeProfitPct: 80, trailArmPct: 90 });
    const q = open(off, 'NOEVEN');
    q.mc = at(20);
    off._tick();
    await settle();
    q.mc = at(1);
    off._tick();
    await settle();
    assert.ok(off.positions.has('NOEVEN'), 'zero switches the rule off');
  }

  // RULE CHANGED: a coin that has already run is not an entry. Buying it is buying the exit of whoever is up,
  // which is what the first sessions of live-practice data showed most often.
  {
    const e = engine({ maxChange5mPct: 120, minScore: 10, minBuyers: 1, minNetFlowSol: 0.1 });
    open(e, 'HOT');
    const hot = e.tokens.get('HOT');
    hot.mcHist = [[Date.now() - 10000, 10], [Date.now(), 40]];
    hot.ext = { at: Date.now(), change5m: 180, buys: 40, sells: 5, netUsd: 500, liqUsd: 9000, mcSol: 40 };
    hot.mc = 40;
    const v = e._eval(hot, Date.now());
    assert.strictEqual(v.pass, false);
    assert.match(v.reason, /Already up 180%/);

    hot.ext.change5m = 60;
    assert.ok(e._eval(hot, Date.now()).reason !== v.reason, 'a sane move is judged on the normal rules');
  }

  // A stop that is blown through in one tick is still a stop loss, not a break even: the label has to describe
  // what happened to the money.
  {
    const e = engine({ breakEvenPct: 12, tp1Pct: 0, takeProfitPct: 80, trailArmPct: 90 });
    const p = open(e, 'GAP');
    p.mc = at(20);
    e._tick(); e._tick();
    await settle();
    assert.ok(e.positions.has('GAP'), 'a healthy run first');

    p.mc = at(-40);
    e._tick(); e._tick();
    await settle();
    assert.ok(!e.positions.has('GAP'));
    assert.match(e.history[0].reason, /Stop loss/, 'a gap through the stop is reported as the stop');
  }

  // A chain that refuses the price is not a verdict on the coin: the order is placed once more through the backup
  // route, which quotes fresh against the same market and puts the tolerance on the tokens, so the ticket stands.
  // A market that has moved to PumpSwap is marked so the backup route finds the new pool by itself.
  {
    const e = engine({ slippagePct: 25 });
    e.store.set({ mode: 'live', slippagePct: 25 });
    e.running = true; e.walletBalance = 5;
    const t = { mint: 'SLIP', symbol: 'SLIP', creator: 'c', createdAt: Date.now(), mc: 40, mcHist: [], trades: [], devSold: false, status: 'watching', score: 80, reason: '', lastActivity: Date.now(), launched: true, sources: new Set(['launch']) };
    e.tokens.set('SLIP', t);
    const slips = [];
    e._tradeLive = async (action, mint, sol, opt) => { slips.push(['primary', opt.slippage]); return { sig: 's' + slips.length, raw: null }; };
    e._backupTrade = async (action, mint, sol, opt) => { slips.push(['backup', opt.slippage]); return { sig: 'b' + slips.length, raw: null, landed: true }; };
    let attempts = 0;
    e._confirm = async () => { attempts++; return attempts === 1 ? { state: 'failed', err: '{"InstructionError":[3,{"Custom":6002}]}' } : { state: 'confirmed', err: '' }; };
    e._tokenBalanceRaw = async () => 7n;
    await e._buy(t, { score: 80, m: { buyers: 9 } });
    assert.strictEqual(slips.length, 2, 'the order is placed twice, never more');
    assert.strictEqual(slips[0][0], 'primary', 'the first attempt is the primary route at the smart tolerance');
    assert.deepStrictEqual(slips[1], ['backup', 25], 'the retry goes through the backup route at the ceiling the user set');
    assert.ok(e.positions.has('SLIP'), 'and the position is booked when the retry fills');

    // A curve that has already moved on is marked graduated. With the setting on, the retry follows it to the new
    // pool through the backup route; with it off (the default) the coin is left alone instead of being traded on a
    // market the user switched off - and it is not asked a second time.
    const g = { mint: 'MOVED', symbol: 'MOVED', creator: 'c', createdAt: Date.now(), mc: 40, mcHist: [], trades: [], devSold: false, status: 'watching', score: 80, reason: '', lastActivity: Date.now(), launched: true, sources: new Set(['launch']) };
    e.tokens.set('MOVED', g);
    e.store.set({ allowGraduated: true });
    const routes = [];
    e._tradeLive = async (action, mint, sol, opt) => { routes.push(['primary', opt.pool]); return { sig: 'x', raw: null }; };
    e._backupTrade = async () => { routes.push(['backup', 'auto']); return { sig: 'xb', raw: null, landed: true }; };
    let n = 0;
    e._confirm = async () => { n++; return n === 1 ? { state: 'failed', err: '{"InstructionError":[3,{"Custom":6005}]}' } : { state: 'confirmed', err: '' }; };
    await e._buy(g, { score: 80, m: { buyers: 9 } });
    assert.deepStrictEqual(routes, [['primary', 'pump'], ['backup', 'auto']], 'the second attempt follows the coin to the market it moved to');
    assert.strictEqual(g.graduated, true);

    const off = { mint: 'LEFT', symbol: 'LEFT', creator: 'c', createdAt: Date.now(), mc: 40, mcHist: [], trades: [], devSold: false, status: 'watching', score: 80, reason: '', lastActivity: Date.now(), launched: true, sources: new Set(['launch']) };
    e.tokens.set('LEFT', off);
    e.store.set({ allowGraduated: false });
    const pools2 = [];
    e._tradeLive = async (action, mint, sol, opt) => { pools2.push(opt.pool); return { sig: 'y', raw: null }; };
    e._confirm = async () => ({ state: 'failed', err: '{"InstructionError":[3,{"Custom":6005}]}' });
    await e._buy(off, { score: 80, m: { buyers: 9 } });
    assert.deepStrictEqual(pools2, ['pump'], 'a coin that graduated is not traded when that is switched off');
    assert.strictEqual(e.positions.has('LEFT'), false);
    assert.strictEqual(off.graduated, true, 'and it is remembered as graduated');

    // 6063 is UnsupportedQuoteMint: a curve quoted in something other than SOL. Measured on chain, no tolerance and
    // no route can fill it, so the coin is retired after one attempt instead of being paid for again.
    const q = { mint: 'QUOTE', symbol: 'QUOTE', creator: 'c', createdAt: Date.now(), mc: 40, mcHist: [], trades: [], devSold: false, status: 'watching', score: 80, reason: '', lastActivity: Date.now(), launched: true, sources: new Set(['launch']) };
    e.tokens.set('QUOTE', q);
    const pools3 = [];
    let backups = 0;
    e._tradeLive = async (action, mint, sol, opt) => { pools3.push(opt.pool); return { sig: 'z', raw: null }; };
    e._backupTrade = async () => { backups++; return { sig: 'zb', raw: null, landed: true }; };
    e._confirm = async () => ({ state: 'failed', err: '{"InstructionError":[3,{"Custom":6063}]}' });
    await e._buy(q, { score: 80, m: { buyers: 9 } });
    assert.deepStrictEqual(pools3, ['pump'], 'exactly one attempt is paid for');
    assert.strictEqual(backups, 0, 'and no backup order is spent on a curve that cannot quote SOL');
    assert.strictEqual(q.unsupported, true);
    assert.strictEqual(e.positions.has('QUOTE'), false);
    assert.match(e._eval(q, Date.now()).reason, /another token/);
  }

  // A position the RPC could not vouch for is dropped, not booked, when the wallet proves its buy never landed:
  // a sale that never happened must not appear in the live result as a real one.
  {
    const e = engine({ mode: 'live' });
    e.store.set({ mode: 'live' });
    const p = { mint: 'PHANTOM', symbol: 'PHANTOM', entryMc: 100, mc: 100, peakMc: 100, solIn: 0.001, feeBuy: 0.00005, openedAt: Date.now(), status: 'open', closing: false, paper: false, fails: 0, nextTry: 0, sig: null, tokIn: null };
    e.positions.set('PHANTOM', p);
    e._tradeLive = async () => { throw new Error('Nothing to sell'); };
    e._tokenBalanceRaw = async () => 0n;
    await e._sell(p, 'Stop loss');
    assert.strictEqual(e.positions.has('PHANTOM'), false, 'the phantom leaves the book');
    assert.strictEqual(e.history.length, 0, 'and nothing is booked as a sale');
    assert.strictEqual(e.books.live.pnl, 0, 'the live result is untouched');
  }

  // Statistics live in two books, so practice results can never be mistaken for real ones.
  {
    const e = engine();
    const p = open(e, 'BOOKS');
    p.mc = at(46);
    e._tick(); e._tick();
    await settle();
    assert.strictEqual(e.books.paper.trades, 1, 'the practice book counts the round trip');
    assert.strictEqual(e.books.live.trades, 0, 'the real book is untouched');
    assert.ok(e.books.paper.pnl > 0);

    e.resetStats('paper');
    assert.strictEqual(e.books.paper.trades, 0);
    assert.strictEqual(e.books.paper.pnl, 0);
    assert.strictEqual(e.history.length, 0, 'and the practice trades leave the list');
  }

  // The sell side of the same ladder. It is a separate path in the engine, and it carried a bare `s` that only
  // showed up live: "VOLITION has not sold yet: s is not defined" meant every refused sell skipped the rescue and
  // waited for the slow retry instead.
  // RULE CHANGED: an urgent exit now asks BOTH doors at once (the first signed transaction wins), so a stalled
  // primary cannot hold a stop - a refused primary then re-quotes through the backup route, which is the third call
  // in the slip list below.
  {
    const e = engine({ slippagePct: 25 });
    e.store.set({ mode: 'live', slippagePct: 25, autoReclaim: false });
    e.running = true; e.walletBalance = 5;
    e._sweepDust = async () => {};
    e._scheduleReclaim = () => {};
    const p = {
      mint: 'SELLSLIP', symbol: 'SELLSLIP', entryMc: 100, mc: 100, peakMc: 100, solIn: 0.001, feeBuy: 0,
      openedAt: Date.now(), status: 'open', closing: false, paper: false, fails: 0, nextTry: 0, tokIn: 1000n,
    };
    e.positions.set('SELLSLIP', p);
    e.tokens.set('SELLSLIP', { mint: 'SELLSLIP', symbol: 'SELLSLIP', mc: 100, mcHist: [], trades: [], status: 'bought', sources: new Set(['launch']) });
    const slips = [];
    e._tradeLive = async (action, mint, sol, opt) => { slips.push(['primary', opt.slippage]); return { sig: 'p1', raw: null }; };
    let held = 1000n;
    e._backupTrade = async (action, mint, sol, opt) => { slips.push(['backup', opt.slippage]); held = 0n; return { sig: 'b1', raw: null, landed: true }; };
    let n = 0;
    e._confirm = async () => { n++; return n === 1 ? { state: 'failed', err: '{"InstructionError":[3,{"Custom":6002}]}' } : { state: 'confirmed', err: '' }; };
    e._tokenBalanceRaw = async () => held;
    e._finishSell = (pos, why) => { e.positions.delete(pos.mint); e.sold = why; };
    await e._sell(p, 'Stop loss', 100);
    assert.strictEqual(slips.filter((x) => x[0] === 'primary').length, 1, 'the primary door is asked once');
    assert.strictEqual(slips.filter((x) => x[0] === 'backup').length, 2, 'the backup races the primary and then carries the re-quote');
    assert.ok(slips.every((x) => x[1] === 25), `every attempt carries the exit's own tolerance, got ${JSON.stringify(slips)}`);
    assert.strictEqual(e.sold, 'Stop loss', 'and the exit is booked once it fills');
    assert.ok(!e.positions.has('SELLSLIP'));
  }

  // A wallet under the rent-exempt floor cannot pay any fee, so an exit is refused before an order is wasted and the
  // owner is told the one thing only he can fix. Measured live: 0.000658 SOL with two profitable positions that could
  // not be sold, and every log line said "not confirmed by the RPC", which is not the problem.
  {
    const e = engine({ mode: 'live', maxHoldSec: 0 });
    const said = [];
    e._log = (level, msg) => said.push({ level, msg });
    e.walletBalance = 0.000658;
    const p = open(e, 'NOFEE');
    p.paper = false;
    p.status = 'open';
    let ordered = 0;
    e._tradeLive = async () => { ordered++; return { sig: 'x', raw: null }; };
    e._backupTrade = async () => { ordered++; return { sig: 'y', raw: null }; };
    await e._sell(p, 'Stop loss', 100);
    assert.strictEqual(ordered, 0, 'no order is sent from a wallet that cannot pay a fee');
    assert.ok(e.positions.has('NOFEE'), 'the position stays in the book, so it closes by itself after a deposit');
    assert.ok(p.nextTry > Date.now(), 'and it is tried again, not abandoned');
    const line = said.find((l) => /0\.00089/.test(l.msg));
    assert.ok(line, 'the owner is told the rent floor, in plain words');
    assert.strictEqual(line.level, 'error');
    assert.match(line.msg, /65|W/, 'with the address to send to');
    assert.ok(!said.some((l) => /has not sold yet/.test(l.msg)), 'and not with the misleading not-confirmed sentence');
  }

  // The reserve: an entry may never spend the SOL that pays the exits, and an order in flight is not offered again
  // while the chain reading is still behind.
  {
    const e = engine({ mode: 'live', buyAmountSol: 0.001 });
    const said = [];
    e._log = (level, msg) => said.push({ level, msg });
    e.walletBalance = 0.02;
    assert.ok(Math.abs(e._freeSol() - 0.018) < 1e-9, 'the reserve is not spendable');
    e._noteSpend(0.005);
    assert.ok(Math.abs(e._freeSol() - 0.013) < 1e-9, 'an order in flight is counted against the wallet');
    e.walletBalance = 0.004;
    const t = { mint: 'RESERVE', symbol: 'RESERVE', mc: 100, status: 'watching' };
    await e._buy(t, { score: 90, m: { buyers: 20 } });
    assert.strictEqual(e.positions.size, 0, 'a 0.004 SOL wallet does not buy a 0.001 ticket with a 0.002 reserve');
    assert.ok(said.some((l) => /keep the exit fees aside/.test(l.msg)), 'and it says so');
  }

  // A take profit that has slipped back to break-even before the order went out is not sold: the owner's rule is that
  // a winner is never closed at a loss, and the stop or the trail decides afterwards.
  {
    const e = engine({ takeProfitPct: 40, maxHoldSec: 600, trailArmPct: 0, breakEvenPct: 0 });
    const p = open(e, 'SLIP');
    p.paper = false;
    p.entryMc = 100;
    p.mc = 100;
    p.tokIn = 1000n;
    let ordered = 0;
    e._tradeLive = async () => { ordered++; return { sig: 'x', raw: null }; };
    e._backupTrade = async () => { ordered++; return { sig: 'y', raw: null }; };
    e._tokenBalanceRaw = async () => 1000n;
    await e._sell(p, 'Take profit', 100);
    assert.strictEqual(ordered, 0, 'a winner that slipped to a loss is not sold');
    assert.ok(p.nextTry > Date.now(), 'and it is looked at again on the next tick');
    assert.strictEqual(p.closing, false, 'the position stays open, not stuck');
  }

  // The safeguard the owner asked for: a level has to HOLD before the bot sells. One tick that touches +60% and is
  // gone again must not close anything, and the same level held for the window must.
  {
    const e = engine({ takeProfitPct: 40, triggerHoldMs: 300 });
    const p = open(e, 'HOLD');
    p.mc = at(60);
    e._tick();
    await settle();
    assert.ok(e.positions.has('HOLD'), 'a single reading does not sell, however high');
    e._tick();
    await settle();
    assert.ok(e.positions.has('HOLD'), 'nor does a second reading inside the window');
    await new Promise((r) => setTimeout(r, 320));
    e._tick();
    await settle();
    assert.ok(!e.positions.has('HOLD'), 'a level that holds for the window is sold');
    assert.match(e.history[0].reason, /Take profit/);
  }

  // A spike far above its target is an exit where two round trips decide whether the spike is kept: both doors are
  // asked at once and the first signed transaction wins.
  // RULE CHANGED: this used to be reached through a "Stop loss" at +97%, which is exactly the nonsense the new
  // re-check refuses (a stop cannot sell a profit). A runner that really is giving back from its peak still races both
  // doors.
  // RULE CHANGED AGAIN: the give-back that makes a trailing sale genuine is a share of the peak now, so this coin that
  // peaked at +117% net has to be 52 points down before the trail is really gone - the price here is +42% net.
  {
    const e = engine({ takeProfitPct: 30, maxHoldSec: 600, trailArmPct: 0, breakEvenPct: 0 });
    const p = open(e, 'SPIKE');
    p.paper = false;
    p.entryMc = 100;
    p.mc = at(45);
    p.peakMc = at(120);
    p.tokIn = 1000n;
    const asked = { primary: 0, backup: 0 };
    e._tradeLive = async () => { asked.primary++; return { sig: 'P', raw: null }; };
    e._backupTrade = async () => { asked.backup++; await new Promise((r) => setTimeout(r, 60)); return { sig: 'B', raw: null }; };
    e._confirm = async () => ({ state: 'confirmed', err: '' });
    e._tokenBalanceRaw = async () => 0n;
    e._finishSell = (pos, why) => { e.positions.delete(pos.mint); e.sold = why; };
    await e._sell(p, 'Trailing stop (peaked at +117.0%)', 100);
    assert.strictEqual(asked.primary + asked.backup, 2, 'both doors are asked at once on a spike');
    assert.match(String(e.sold), /Trailing stop/, 'and the exit is booked once it fills');
  }

  // A trade on a coin that is held prices it the moment it arrives, with no poll and no network in front of it, and
  // stamps a fresh reading so a held level can fire. Measured live, the poll used to await a quote request first, so a
  // move the stream had already delivered was acted on hundreds of milliseconds late.
  {
    const e = engine({ triggerHoldMs: 0 });
    const p = open(e, 'FAST');
    assert.ok(!p.pxAt, 'a fresh position has no reading yet');
    e.ingest({ mint: 'FAST', txType: 'buy', marketCapSol: 160, solAmount: 1, traderPublicKey: 'someone' });
    assert.ok(Math.abs(p.mc - 160) < 0.01, `the trade itself set the price, got ${p.mc}`);
    assert.strictEqual(p.pxSource, 'chain');
    assert.ok(p.pxAt > 0, 'and the reading is stamped');
    e._tick();
    await settle();
    assert.ok(e.positions.has('FAST'), 'the first sight of a level only arms it');
    e.ingest({ mint: 'FAST', txType: 'buy', marketCapSol: 162, solAmount: 1, traderPublicKey: 'someone' });
    e._tick();
    await settle();
    assert.ok(!e.positions.has('FAST'), 'the second fresh reading fires the exit - no poll was involved');
    assert.match(e.history[0].reason, /Take profit/);
  }

  // The positions panel must move with the market, not with the slowest timer on the page: a price change on a held
  // coin is pushed on its own channel at once, and a quiet tick pushes nothing at all.
  {
    const e = engine();
    const p = open(e, 'FASTPX');
    e._persistPositions();
    const pushes = [];
    e.on('positions', (list) => pushes.push(list));
    e._pushPositions();
    assert.strictEqual(pushes.length, 1, 'a structural change is pushed immediately');
    assert.strictEqual(pushes[0][0].mint, 'FASTPX');
    e._pushPositions();
    assert.strictEqual(pushes.length, 1, 'a quiet tick pushes nothing');
    const t = e.tokens.get('FASTPX');
    t.lastStreamAt = Date.now();
    t.mc = 130;
    e._pricePosition(p, Date.now());
    e._pushPositions();
    assert.strictEqual(pushes.length, 2, 'a price change is pushed');
    assert.ok(pushes[1][0].pnlPct > 25, `the percentage travelled with it, got ${pushes[1][0].pnlPct}`);
  }

  // A risk rule is re-checked right before the order is signed: a stop that fired on a dip the coin has already
  // recovered from does not sell. Measured live, a coin was closed with "Stop loss" written on it at +5.9% - the bot
  // paying a whole round trip to lower a risk that had already gone away.
  {
    const logs = [];
    const e = engine();
    e._log = (lvl, msg) => logs.push(msg);
    const p = open(e, 'RECOV');
    p.paper = false; p.status = 'open'; p.tokIn = 1000n; p.solIn = 0.01; p.feeBuy = 0;
    let asked = 0;
    e._tradeLive = async () => { asked++; return { sig: 'S', raw: null, landed: true }; };
    e._backupTrade = async () => { asked++; return { sig: 'B', raw: null, landed: true }; };
    p.mc = at(12);                                 // +12% gross on a 0.01 ticket is +5% after every cost: no loss
    await e._sell(p, 'Stop loss', 100);
    assert.strictEqual(asked, 0, 'no order is built for a loss that is no longer there');
    assert.ok(e.positions.has('RECOV'), 'the position stays and is watched again');
    assert.ok(logs.some((l) => /no longer there/.test(l)), 'and the log says why it was not sold');
    assert.ok(!p.closing, 'the position is not left locked by the abandoned sale');
  }

  // The same guard for the trail: a coin that bounced back above its give-back level is not a trail exit.
  {
    const e = engine();
    const p = open(e, 'TRAILUP');
    p.paper = false; p.status = 'open'; p.tokIn = 1000n; p.solIn = 0.01; p.feeBuy = 0; p.tp1Done = true;
    let asked = 0;
    e._tradeLive = async () => { asked++; return { sig: 'S', raw: null, landed: true }; };
    p.peakMc = at(50);
    p.mc = at(48);
    await e._sell(p, 'Trailing stop (peaked at +47.0%)', 100);
    assert.strictEqual(asked, 0, 'a bounce above the give-back is not a trail exit');
  }

  // A runner is no longer handed the whole tolerance. 40% did not fill better, it removed the floor: a position at
  // +40% filled at -30% on a spike. A spike now gets SPIKE_SLIP, and anything worse is refused.
  // RULE CHANGED: the tight tolerance is no longer keyed on "twice the target" (which a moon target never reaches) or
  // on the size of the move: ANY exit still in profit gets SPIKE_SLIP, and only an exit that is under water keeps the
  // wide tolerance it needs in order to fill at all.
  {
    const e = engine({ takeProfitPct: 30 });
    open(e, 'SPIKE');
    assert.strictEqual(e._slippageFor('SPIKE', true, 70), 15, 'a spike gets 15%, not 40%');
    assert.strictEqual(e._slippageFor('SPIKE', true, 5), 15, 'and so does a small profit: a 40% order may fill at -32%');
    assert.ok(e._slippageFor('SPIKE', true, -12) >= 20, 'a losing exit keeps its wide tolerance, because it has to fill');
    assert.ok(e._slippageFor('SPIKE', false, 0) <= 10, 'a take profit keeps the tight ceiling');
  }

  // A price that is not arriving any more must not look like a price. Measured live on 2026-11-05: a coin went from a
  // 50k market cap to nothing while the position card kept printing +71%, and the owner sold it by hand because the
  // bot never did. Two separate faults made that possible, and both are held here.
  {
    // 1) A FALL is the market and is taken on the first reading, whatever its size. Only a jump UP needs a second
    // opinion. The old guard refused both, and because the refused reading was never accepted, the old number stayed
    // for ever: every later reading was "too big a jump" from it too.
    const e = engine({ takeProfitPct: 500, stopLossPct: 30, trailArmPct: 0, maxHoldSec: 3600, triggerHoldMs: 0 });
    const p = open(e, 'CRASH');
    p.mc = 100; p.pxAt = Date.now(); p.pxSource = 'chain';
    p.extRef = { priceUsd: 1, mc: 100 };
    p.pxPull = 0.2; p.pxPullAt = Date.now();          // the quote collapsed by 80% in one reading
    e._pricePosition(p, Date.now());
    assert.ok(Math.abs(p.mc - 20) < 0.01, `a fall of 80% in one reading is the market and is taken at once, got ${p.mc}`);
    assert.strictEqual(p.pxSource, 'quote');

    // ...while a jump UP of the same size still has to be seen twice, so one printed price cannot inflate a position.
    const q = open(e, 'PUMP');
    q.mc = 100; q.pxAt = Date.now(); q.pxSource = 'chain';
    q.extRef = { priceUsd: 1, mc: 100 };
    q.pxPull = 5; q.pxPullAt = Date.now();            // 5x in one reading
    e._pricePosition(q, Date.now());
    assert.strictEqual(q.mc, 100, 'a 5x jump is not taken on one reading');
    q.pxPull = 5; q.pxPullAt = Date.now();            // ...the same value again agrees with itself
    e._pricePosition(q, Date.now());
    assert.ok(Math.abs(q.mc - 500) < 1, `two readings that agree become the price, got ${q.mc}`);
  }
  {
    // 2) A position nobody is pricing is SOLD instead of held blind: the last number a feed gave is not what the coin
    // is worth now, and holding it is how a winner turns into nothing.
    const e = engine();
    const p = open(e, 'BLIND');
    e.history.length = 0;
    p.paper = false; p.tokIn = 1000n; p.solIn = 0.01; p.feeBuy = 0;
    let sold = null;
    e._tradeLive = async () => ({ sig: 'S', raw: null, landed: true });
    e._tokenBalanceRaw = async () => 0n;
    e._confirm = async () => ({ state: 'confirmed', err: '' });
    e._finishSell = (pos, why) => { sold = why; e.positions.delete(pos.mint); };
    p.pxAt = Date.now() - 120000;                      // two minutes with no reading
    e._tick();
    await settle();
    assert.match(String(sold), /Price lost/, `a position with no price for two minutes is closed, got ${sold}`);
    assert.ok(!e.positions.has('BLIND'));

    // A position whose price is current is never touched by that watchdog.
    const e2 = engine();
    const live = open(e2, 'LIVE');
    live.paper = false; live.tokIn = 1000n;
    let asked2 = 0;
    e2._tradeLive = async () => { asked2++; return { sig: 'S', raw: null, landed: true }; };
    live.pxAt = Date.now();
    e2._tick();
    await settle();
    assert.strictEqual(asked2, 0, 'a priced position is left to its own rules');
    assert.ok(e2.positions.has('LIVE'));

    // And the panel says how old the number is, so a still percentage cannot look live.
    const view = e2._positionsView().find((v) => v.mint === 'LIVE');
    assert.ok(view && Number.isFinite(view.pxAgeSec), 'the view carries the age of the price');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Exits test passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

