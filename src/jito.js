/**
 * Jito block engine client. A transaction sent as a bundle goes into the block engine's auction instead of a public
 * RPC queue, and a bundle only executes when it lands as a whole - so a tip is paid only when the trade with it
 * lands. That is the one thing an auction genuinely buys a small trader: a better chance of landing in a crowded
 * slot, without paying for the attempts that fail.
 *
 * Public endpoint, no key (measured 2026-11-04: getTipAccounts answered in about 200 ms).
 */
const ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
// Below this the block engine drops the bundle before it is ever considered.
const MIN_TIP_LAMPORTS = 1000n;
const TIPS_TTL_MS = 10 * 60 * 1000;
const CALL = { timeout: 6000 };

class Jito {
  constructor(opts = {}) {
    this.url = opts.url || ENGINE;
    this._tips = null;
    this._tipsAt = 0;
    this.stats = { bundles: 0, refused: 0, errors: 0 };
  }

  async _post(method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CALL.timeout);
    let r;
    try {
      r = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl.signal,
      });
    } catch (e) {
      this.stats.errors++;
      throw new Error(e.name === 'AbortError' ? 'Jito did not answer in time.' : 'Jito is unreachable: ' + e.message);
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 429) { this.stats.errors++; throw new Error('Jito rate limit reached.'); }
    if (!r.ok) { this.stats.errors++; throw new Error(`Jito refused the request (HTTP ${r.status}).`); }
    const body = await r.json().catch(() => null);
    if (!body) { this.stats.errors++; throw new Error('Jito answered with something that is not JSON.'); }
    if (body.error) {
      this.stats.errors++;
      const why = body.error.message || body.error.code || 'unknown error';
      throw new Error('Jito: ' + String(why).slice(0, 140));
    }
    return body.result;
  }

  /** The accounts a tip may be paid to. Jito expects the tip in the bundle, to one of its own addresses. */
  async tipAccounts() {
    if (this._tips && Date.now() - this._tipsAt < TIPS_TTL_MS) return this._tips;
    const list = await this._post('getTipAccounts', []);
    const tips = Array.isArray(list) ? list.filter((a) => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) : [];
    if (!tips.length) throw new Error('Jito did not name a tip account.');
    this._tips = tips;
    this._tipsAt = Date.now();
    return tips;
  }

  /** Send signed transactions as one atomic bundle. Returns the bundle id. */
  async sendBundle(rawTransactions) {
    const list = (rawTransactions || []).map((raw) => Buffer.from(raw).toString('base64'));
    if (list.length < 1) throw new Error('A bundle needs at least one transaction.');
    this.stats.bundles++;
    return this._post('sendBundle', [list, { encoding: 'base64' }]);
  }
}

module.exports = { Jito, ENGINE, MIN_TIP_LAMPORTS };
