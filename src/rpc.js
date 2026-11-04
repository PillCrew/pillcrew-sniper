// Measured on 2026-11-04 against a funded wallet: drpc.org answers "chain is not available on free plan",
// rpc.ankr.com 403s without a key, onfinality 429s without a key and tatum sells getBalance as a paid feature.
// Those four were half the pool and every sell that landed on one of them looked like a failed sell.
const DEFAULT_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.publicnode.com',
  'https://solana.api.pocket.network/',
  'https://public.rpc.solanavibestation.com/',
];

const RATE_LIMIT_COOLDOWN_MS = 30000;   // after HTTP 429
const ERROR_COOLDOWN_MS = 15000;        // after timeout / network / 5xx
const AUTH_COOLDOWN_MS = 10 * 60000;    // a node that says it needs a key or a paid plan, not a bad minute

/** Classify an error so we know whether (and how long) to rotate away from a node. */
function classify(err) {
  const msg = String((err && (err.message || err)) || '').toLowerCase();
  const code = err && (err.code || (err.cause && err.cause.code));
  if (/\b429\b|too many requests|rate.?limit/.test(msg)) return { retry: true, cooldown: RATE_LIMIT_COOLDOWN_MS, kind: '429' };
  // A node refusing to serve this method is a node problem, never a verdict on the transaction. Several public
  // providers answer 400 or 200 with one of these sentences, and treating them as fatal left a position that
  // could not be sold while the pool kept rotating back to the same dead host.
  if (/paid plan|free plan|upgrade|not available for|requires an api key|api key is not allowed|api key required|subscription|not supported|method .* not found|disabled for|requires a mint filter|does not support|unsupported/.test(msg)) {
    return { retry: true, cooldown: AUTH_COOLDOWN_MS, kind: 'plan' };
  }
  // A plain 403 or 401 out of a public host is almost always a burst limiter wearing a refusal, so it gets the
  // short bench. Only a refusal that names a key or a plan is worth ten minutes away from that node.
  if (/\b40[13]\b|unauthorized|forbidden/.test(msg)) {
    const keyish = /api.?key|unauthorized|invalid key|token is not|credential/.test(msg);
    return { retry: true, cooldown: keyish ? AUTH_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS, kind: keyish ? 'auth' : '403' };
  }
  if (/timeout|timed out|aborted/.test(msg) || code === 'ETIMEDOUT') return { retry: true, cooldown: ERROR_COOLDOWN_MS, kind: 'timeout' };
  if (/\b5\d\d\b|bad gateway|unavailable|fetch failed|network|econn|enotfound|eai_again|socket|certificate/.test(msg)
      || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return { retry: true, cooldown: ERROR_COOLDOWN_MS, kind: 'network' };
  }
  return { retry: false, cooldown: 0, kind: 'other' }; // real chain/logic errors are NOT retried on another node
}

class RPCManager {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.endpoints]   list of HTTP RPC URLs
   * @param {number}   [opts.timeoutMs]   per-request timeout
   * @param {string}   [opts.commitment]
   * @param {(url:string)=>Connection} [opts.factory] custom Connection factory (tests)
   * @param {string}   [opts.custom]      optional user node, tried first
   * @param {(from:string,to:string,why:string)=>void} [opts.onSwitch]
   */
  constructor(opts = {}) {
    this.endpoints = (opts.endpoints && opts.endpoints.length ? opts.endpoints : DEFAULT_ENDPOINTS).slice();
    this.timeoutMs = opts.timeoutMs || 8000;
    this.commitment = opts.commitment || 'confirmed';
    this.factory = opts.factory || ((url) => new (require('@solana/web3.js').Connection)(url, { commitment: this.commitment, disableRetryOnRateLimit: true }));
    this.onSwitch = opts.onSwitch || (() => {});
    this.index = 0;
    this.conns = new Map();
    this.health = new Map(this.endpoints.map((u) => [u, { until: 0, fails: 0, ok: 0, lastError: '' }]));
    // Hosts that answer "requires a mint filter" to a full token-account listing. Everything else still works on
    // them, so they are remembered instead of being dropped from the pool.
    this._noList = new Set();
    this.custom = '';
    this.setCustom(opts.custom);
  }

  get current() { return this.endpoints[this.index]; }

  /** Optional user node (e.g. a private Helius URL). Empty string = automatic public pool only. */
  setCustom(url) {
    url = url && /^https:\/\//.test(url) ? url.trim() : '';
    if (url === this.custom) return;
    const base = this.endpoints.filter((u) => u !== this.custom);
    this.custom = url;
    if (url && !this.health.has(url)) this.health.set(url, { until: 0, fails: 0, ok: 0, lastError: '' });
    this.endpoints = url ? [url, ...base.filter((u) => u !== url)] : base;
    this.index = 0;
  }

  _conn(url) {
    let c = this.conns.get(url);
    if (!c) { c = this.factory(url); this.conns.set(url, c); }
    return c;
  }

  /** Current connection (for code that just needs one, e.g. read-only helpers). */
  connection() { return this._conn(this.current); }

  _available(url) { return this.health.get(url).until <= Date.now(); }

  _rotate(reason) {
    const n = this.endpoints.length;
    const from = this.current;
    for (let i = 1; i <= n; i++) {
      const j = (this.index + i) % n;
      if (this._available(this.endpoints[j])) {
        this.index = j;
        this.onSwitch(from, this.endpoints[j], reason);
        return true;
      }
    }
    // everything is cooling down: pick the node whose cooldown ends first
    let best = 0, soon = Infinity;
    this.endpoints.forEach((u, k) => { const t = this.health.get(u).until; if (t < soon) { soon = t; best = k; } });
    this.index = best;
    return false;
  }

  _withTimeout(p, ms = this.timeoutMs) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('RPC timeout')), ms); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  /**
   * Run `fn(connection)` (engine: rpc.call) with automatic failover. Retries across all nodes at most once each.
   * Only 429 / timeout / network / 5xx / auth errors rotate; genuine errors are thrown immediately.
   *
   * `opts` bounds the whole loop. Without it eight nodes timing out at eight seconds each held a sell for a
   * minute while the price it wanted was long gone, so every call now has a total budget: `timeoutMs` per
   * attempt, `attempts` nodes at most, `budgetMs` for all of them together.
   */
  async call(fn, opts = {}) {
    const perTry = Math.max(200, Number(opts.timeoutMs) || this.timeoutMs);
    const max = Math.max(1, Math.min(Number(opts.attempts) || this.endpoints.length, this.endpoints.length));
    const stopAt = Date.now() + (Number(opts.budgetMs) || perTry * 3);
    let lastErr;
    for (let attempt = 0; attempt < max; attempt++) {
      const left = stopAt - Date.now();
      if (attempt > 0 && left < 200) break;
      // A node that refuses to list every token account at once still serves balances and sends transactions, so it
      // is only skipped for the calls that need the whole list. Measured: three of the five public hosts answer
      // "requires a mint filter" to the program-id form and one of them also 403s it.
      if (opts.listAccounts && this._noList.has(this.current)) {
        // Walk to the next host without announcing a switch: the node is fine, it just cannot answer this call.
        const n = this.endpoints.length;
        for (let i = 1; i <= n; i++) {
          const j = (this.index + i) % n;
          if (!this._noList.has(this.endpoints[j]) && this._available(this.endpoints[j])) { this.index = j; break; }
        }
        if (this._noList.has(this.current)) this._noList.clear();   // every host refused; stop guessing
      }
      // A node on its cooldown is still better than no node at all: if nothing is available the least cooled one
      // is used rather than answering the player with "all nodes are busy" while the network is fine.
      if (!this._available(this.current)) this._rotate('cooling');
      const url = this.current;
      const h = this.health.get(url);
      try {
        const out = await this._withTimeout(Promise.resolve(fn(this._conn(url), url)), left > 0 ? Math.min(perTry, left) : perTry);
        h.ok++; h.fails = 0; h.until = 0;
        return out;
      } catch (err) {
        const c = classify(err);
        if (!c.retry) throw err;
        if (/mint filter|not supported|unsupported|method .* not found/i.test(String(err && err.message))) this._noList.add(url);
        lastErr = err;
        h.fails++; h.lastError = c.kind;
        h.until = Date.now() + c.cooldown * Math.min(h.fails, 2);
        this._rotate(c.kind);
      }
    }
    throw new Error('All RPC nodes are busy or unreachable right now. ' + (lastErr ? `(${lastErr.message})` : ''));
  }

  /**
   * Send the same signed bytes to several different nodes at once and take the first signature that answers.
   * A transaction only lands once it reaches a leader, so parallel doors are the difference between a stop that
   * fills at the price it saw and one that fills 400 ms later on a coin that is already gone. The bytes are
   * identical, so no door can execute it twice.
   */
  async broadcast(raw, opts = {}) {
    const n = Math.max(1, Math.min(Number(opts.doors) || 3, this.endpoints.length));
    const urls = [];
    for (let i = 0; i < this.endpoints.length && urls.length < n; i++) urls.push(this.endpoints[(this.index + i) % this.endpoints.length]);
    const sendOpts = opts.send || { skipPreflight: true, maxRetries: 0 };
    const one = (url) => this._withTimeout(Promise.resolve(this._conn(url).sendRawTransaction(raw, sendOpts)), Number(opts.timeoutMs) || 2500);
    try {
      return await Promise.any(urls.map(one));
    } catch (e) {
      throw (e && e.errors && e.errors[0]) || e;
    }
  }

  // Convenience wrappers used by the app
  getBalance(pubkey) { return this.call((c) => c.getBalance(pubkey)); }
  getSignatureStatuses(sigs) { return this.call((c) => c.getSignatureStatuses(sigs)); }
  getLatestBlockhash() { return this.call((c) => c.getLatestBlockhash()); }
  sendRawTransaction(raw, opts) { return this.call((c) => c.sendRawTransaction(raw, opts)); }

  /** For the UI: which node is active and how each one is doing. */
  status() {
    const now = Date.now();
    return {
      current: this.current,
      nodes: this.endpoints.map((u) => {
        const h = this.health.get(u);
        return { url: u, host: host(u), active: u === this.current, coolingDown: h.until > now, ok: h.ok, fails: h.fails, lastError: h.lastError };
      }),
    };
  }
}

function host(u) { try { return new URL(u).hostname; } catch (_) { return u; } }

module.exports = { RPCManager, DEFAULT_ENDPOINTS, classify };
