const EventEmitter = require('events');
const WebSocket = require('ws');

/**
 * On-chain Pump.fun feed. No third-party data API: we subscribe to the program's logs over a Solana
 * RPC websocket and decode the Anchor events (CreateEvent / TradeEvent) locally. One subscription
 * delivers every new launch AND every trade on every coin (so trending coins come for free).
 * Market cap is derived from the bonding-curve reserves carried by each trade event.
 *
 * Emits 'event' with objects shaped like the engine's input: { txType, mint, name, symbol,
 * traderPublicKey, solAmount, marketCapSol, fromChain: true }.
 */

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DISC_CREATE = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const DISC_TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const TOTAL_SUPPLY_TOKENS = 1e9;      // every pump.fun coin has 1B supply
const TOKEN_DECIMALS = 6;
const PUBLIC_WS = ['wss://api.mainnet-beta.solana.com', 'wss://solana-rpc.publicnode.com'];
const STALE_MS = 20000;               // no message for this long -> reconnect

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = 0n;
  for (const x of buf) n = (n << 8n) | BigInt(x);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of buf) { if (x === 0) s = '1' + s; else break; }
  return s;
}

/** Market cap in SOL from bonding-curve virtual reserves (lamports / raw token units). */
function marketCapSol(vSol, vTok) {
  if (!(vTok > 0n)) return 0;
  const priceSol = Number(vSol) / 1e9 / (Number(vTok) / 10 ** TOKEN_DECIMALS);
  return priceSol * TOTAL_SUPPLY_TOKENS;
}

function readString(buf, o) {
  const len = buf.readUInt32LE(o.p); o.p += 4;
  if (len > 400 || o.p + len > buf.length) throw new Error('bad string');
  const s = buf.toString('utf8', o.p, o.p + len); o.p += len;
  return s;
}

/** Decode one "Program data: <base64>" payload. Returns an engine event or null. */
function decodeEvent(base64) {
  let b;
  try { b = Buffer.from(base64, 'base64'); } catch (_) { return null; }
  if (b.length < 8) return null;
  const disc = b.subarray(0, 8);
  try {
    if (disc.equals(DISC_TRADE)) {
      if (b.length < 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8) return null;
      const mint = b58(b.subarray(8, 40));
      const sol = b.readBigUInt64LE(40);
      const isBuy = b[56] === 1;
      const user = b58(b.subarray(57, 89));
      const vSol = b.readBigUInt64LE(97);
      const vTok = b.readBigUInt64LE(105);
      return { txType: isBuy ? 'buy' : 'sell', mint, traderPublicKey: user, solAmount: Number(sol) / 1e9, marketCapSol: marketCapSol(vSol, vTok), fromChain: true };
    }
    if (disc.equals(DISC_CREATE)) {
      const o = { p: 8 };
      const name = readString(b, o);
      const symbol = readString(b, o);
      readString(b, o); // uri
      const mint = b58(b.subarray(o.p, o.p + 32)); o.p += 32;
      o.p += 32;        // bonding curve
      const user = b58(b.subarray(o.p, o.p + 32));
      return { txType: 'create', mint, name, symbol, traderPublicKey: user, solAmount: 0, marketCapSol: marketCapSol(30000000000n, 1073000000000000n), fromChain: true };
    }
  } catch (_) { /* malformed / newer layout - ignore */ }
  return null;
}

class ChainFeed extends EventEmitter {
  /** @param {{customRpc?: string, customRpcs?: string[], customWs?: string}} opts */
  constructor(opts = {}) {
    super();
    this.customRpc = opts.customRpc || '';
    // The desk may hold two private nodes now; either one can serve the subscription, and the explicit socket wins.
    this.customRpcs = (opts.customRpcs || []).filter(Boolean);
    this.customWs = opts.customWs || '';
    if (!this.customRpcs.length && this.customRpc) this.customRpcs = [this.customRpc];
    this.ws = null;
    this.want = false;
    this.idx = 0;
    this.lastMsg = 0;
    this.fails = 0;
    this.count = 0;
    this.rate = 0;
    this.connected = false;
    this.url = '';
    this._timer = null;
    this._rateTimer = null;
  }

  endpoints() {
    const list = [];
    // An explicit socket first: a provider's WebSocket is often on another host than its HTTP endpoint, and a URL
    // guessed by swapping the scheme never connects (FluxRPC: `wss://ws.eu.fluxrpc.com`).
    if (this.customWs && /^wss?:\/\//.test(this.customWs)) list.push(this.customWs.trim());
    for (const rpc of this.customRpcs || []) {
      if (rpc && /^https:\/\//.test(rpc)) {
        const derived = rpc.replace(/^https:/, 'wss:');
        if (!list.includes(derived)) list.push(derived);
      }
    }
    if (!list.length && this.customRpc && /^https:\/\//.test(this.customRpc)) list.push(this.customRpc.replace(/^https:/, 'wss:'));
    return list.concat(PUBLIC_WS);
  }

  start() {
    if (this.want) return;
    this.want = true; this.fails = 0;
    this._rateTimer = setInterval(() => { this.rate = this.count; this.count = 0; }, 1000);
    this._timer = setInterval(() => this._watchdog(), 5000);
    this._open();
  }

  stop() {
    this.want = false;
    clearInterval(this._rateTimer); clearInterval(this._timer);
    if (this.ws) { try { this.ws.terminate(); } catch (_) {} this.ws = null; }
    this.connected = false;
  }

  _open() {
    if (!this.want) return;
    const eps = this.endpoints();
    this.url = eps[this.idx % eps.length];
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { return this._retry(); }
    this.ws = ws;
    ws.on('open', () => {
      this.lastMsg = Date.now();
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'processed' }] }));
    });
    ws.on('message', (d) => { this.lastMsg = Date.now(); this._onMessage(d.toString()); });
    ws.on('error', () => {});
    ws.on('close', () => {
      const was = this.connected;
      this.connected = false; this.ws = null;
      this.emit('status', { connected: false, url: this.url });
      if (this.want) { if (!was) this.fails++; this._retry(); }
    });
  }

  _retry() {
    this.idx++;
    if (this.fails >= 4) this.emit('giveup');
    setTimeout(() => this._open(), Math.min(5000, 400 * (this.fails + 1)));
  }

  _watchdog() {
    if (this.want && this.ws && Date.now() - this.lastMsg > STALE_MS) { try { this.ws.terminate(); } catch (_) {} }
  }

  _onMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.id === 1 && m.error) { this.fails = 99; this.emit('error', new Error(m.error.message || 'subscribe failed')); try { this.ws.terminate(); } catch (_) {} return; }
    if (m.id === 1 && typeof m.result === 'number') { this.connected = true; this.fails = 0; this.emit('status', { connected: true, url: this.url }); return; }
    if (m.method !== 'logsNotification') return;
    const v = m.params && m.params.result && m.params.result.value;
    if (!v || v.err || !Array.isArray(v.logs)) return;
    for (const line of v.logs) {
      if (!line.startsWith('Program data: ')) continue;
      const ev = decodeEvent(line.slice(14));
      if (ev) { this.count++; this.emit('event', ev); }
    }
  }
}

module.exports = { ChainFeed, decodeEvent, marketCapSol, b58, PUMP_PROGRAM };
