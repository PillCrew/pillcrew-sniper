/**
 * Jupiter swap client. The Swap API v2 builds an order, the wallet signs it here and the signed bytes go back to
 * Jupiter to execute, so this is a second execution route behind the native Pump.fun door.
 *
 * It answers without an API key (measured 2026-11-04: a real quote in about 120 ms from both hosts), which is what
 * makes it the free fallback that keeps a trade possible when the native route refuses the market.
 */
const HOSTS = ['https://lite-api.jup.ag/swap/v2', 'https://api.jup.ag/swap/v2'];
const WSOL = 'So11111111111111111111111111111111111111112';

class Jupiter {
  constructor() {
    this._host = 0;
  }

  _headers(extra) {
    return { accept: 'application/json', ...extra };
  }

  async _fetch(path, opts = {}, timeout = 6000) {
    let lastErr = null;
    for (let attempt = 0; attempt < HOSTS.length * 2; attempt++) {
      const host = HOSTS[(this._host + attempt) % HOSTS.length];
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(host + path, { ...opts, signal: ctl.signal });
        if (r.status === 401 || r.status === 403) {
          throw Object.assign(new Error('Jupiter refused this request (' + r.status + ').'), { kind: 'auth' });
        }
        if (r.status === 429) { lastErr = Object.assign(new Error('Jupiter rate limit reached.'), { kind: 'rate' }); continue; }
        if (!r.ok) {
          // Jupiter explains a 400 in the body ("no route found", "amount too small", a mint it will not touch).
          // Reading it turns "Jupiter HTTP 400" into a sentence that says what the market did.
          let why = '';
          try { const b = await r.json(); why = b.errorMessage || b.message || b.error || (b.errorCode ? String(b.errorCode) : ''); } catch (_) { /* not json */ }
          lastErr = Object.assign(new Error(`Jupiter has no route (${r.status}${why ? ': ' + String(why).slice(0, 120) : ''})`), { kind: 'http' });
          continue;
        }
        this._host = (this._host + attempt) % HOSTS.length;
        return await r.json();
      } catch (err) {
        if (err.kind === 'auth') throw err;
        lastErr = err.name === 'AbortError' ? Object.assign(new Error('Jupiter timed out.'), { kind: 'timeout' }) : err;
      } finally { clearTimeout(timer); }
    }
    throw lastErr || new Error('Jupiter did not answer.');
  }

  /**
   * Swap through Jupiter (order -> sign -> execute). Returns the signature once Jupiter reports success.
   * `guard` inspects the transaction before it is signed, because the bytes come from a remote service.
   */
  async swap({ keypair, inputMint, outputMint, amountRaw, slippageBps, guard }) {
    const { VersionedTransaction } = require('@solana/web3.js');
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amountRaw), taker: keypair.publicKey.toBase58() });
    if (slippageBps) q.set('slippageBps', String(Math.round(slippageBps)));
    const order = await this._fetch(`/order?${q}`, { headers: this._headers() }, 8000);
    if (!order || !order.transaction) {
      throw new Error('Jupiter has no route: ' + ((order && (order.errorMessage || order.errorCode)) || 'unknown'));
    }
    if (order.inAmount != null && String(order.inAmount) !== String(amountRaw)) {
      throw new Error('Jupiter quoted a different amount than the order and it was refused.');
    }
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    if (typeof guard === 'function') guard(tx, keypair.publicKey.toBase58());
    tx.sign([keypair]);
    const res = await this._fetch('/execute', {
      method: 'POST',
      headers: this._headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), requestId: order.requestId }),
    }, 30000);
    if (!res || res.status !== 'Success') {
      throw new Error('Jupiter swap failed: ' + ((res && (res.error || res.code)) || 'no answer'));
    }
    // A route may take a small platform fee out of the input, so the filled amount is compared with a tolerance:
    // 0.1% off is the fee, 5% off is a partial fill the book must not treat as a full exit.
    const asked = BigInt(amountRaw);
    if (res.inputAmountResult != null && asked > 0n) {
      const filled = BigInt(res.inputAmountResult);
      const shortfallPct = filled >= asked ? 0 : Number(((asked - filled) * 10000n) / asked) / 100;
      if (shortfallPct > 2) {
        throw Object.assign(new Error(`Jupiter filled ${filled} of ${asked} (${shortfallPct.toFixed(2)}% short).`), { partialFill: true });
      }
    }
    return res.signature;
  }
}

module.exports = { Jupiter, WSOL };
