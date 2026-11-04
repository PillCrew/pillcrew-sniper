const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58 = require('bs58');

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

/**
 * Local, non-custodial wallet. The secret key is encrypted with AES-256-GCM
 * (key derived from the user's password with scrypt) and never leaves the machine.
 */
class WalletManager {
  constructor(dir) {
    this.file = path.join(dir, 'wallet.json');
    this.keypair = null;
    this.damaged = null;
    this.meta = this._load();
  }

  /**
   * A wallet file that exists but cannot be read is NOT "no wallet": reporting it that way sent the user to the
   * create screen, which then overwrote a key that was still holding money. Only a missing file is `null`.
   */
  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      this.damaged = `The wallet file could not be read (${(err && (err.code || err.message)) || 'unknown error'}). Restore it from a backup or move it away, then create a new one.`;
      return null;
    }
    try {
      const meta = JSON.parse(text);
      const enc = (meta && meta.enc) || {};
      if (!meta || typeof meta.address !== 'string' || !meta.address) throw new Error('missing address');
      for (const k of ['salt', 'iv', 'tag', 'data']) {
        if (typeof enc[k] !== 'string' || !enc[k] || !/^[0-9a-f]+$/i.test(enc[k])) throw new Error('bad ' + k);
      }
      return meta;
    } catch (err) {
      this.damaged = `The wallet file is damaged (${err.message}). It is not a password problem: restore it from a backup or move it away instead of creating a new wallet over it.`;
      return null;
    }
  }

  _writable() { if (this.damaged) throw new Error(this.damaged); }

  exists() { return !!this.meta; }
  address() { return this.meta ? this.meta.address : null; }
  isUnlocked() { return !!this.keypair; }

  _encrypt(secret, password) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(password, salt, 32, SCRYPT);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
    return {
      salt: salt.toString('hex'), iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex'),
    };
  }

  _decrypt(blob, password) {
    try {
      const key = crypto.scryptSync(password, Buffer.from(blob.salt, 'hex'), 32, SCRYPT);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(blob.data, 'hex')), decipher.final()]);
    } catch (_) {
      throw new Error('Wrong password.');
    }
  }

  _save(kp, password) {
    const meta = { version: 1, address: kp.publicKey.toBase58(), enc: this._encrypt(kp.secretKey, password) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Written beside the real file and renamed over it, so a crash or a sync client cannot leave half a key.
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.meta = meta;
    this.keypair = kp;
  }

  _checkPassword(password) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
  }

  create(password, options = {}) {
    this._writable();
    if (this.exists() && !options.replace) throw new Error('A wallet already exists. Remove it first or unlock it.');
    this._checkPassword(password);
    this._save(Keypair.generate(), password);
    return { address: this.address() };
  }

  /**
   * Deletes the wallet file from this computer. The key is gone with it, so the caller must have confirmed
   * twice and preferably exported the key first. Funds stay on chain and are only reachable with that key.
   */
  reset() {
    this._writable();
    this.keypair = null;
    this.meta = null;
    try { fs.rmSync(this.file, { force: true }); } catch (_) { /* already gone */ }
    return { removed: true };
  }

  importKey(secret, password, options = {}) {
    this._writable();
    if (this.exists() && !options.replace) throw new Error('A wallet already exists. Back up and remove it before importing another.');
    this._checkPassword(password);
    let bytes;
    const text = String(secret || '').trim();
    try {
      bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text);
    } catch (_) {
      throw new Error('That does not look like a valid private key.');
    }
    if (bytes.length !== 64) throw new Error('Private key must be a 64-byte Solana secret key (base58 or JSON array).');
    this._save(Keypair.fromSecretKey(bytes), password);
    return { address: this.address() };
  }

  unlock(password) {
    if (!this.exists()) throw new Error('No wallet found.');
    const secret = this._decrypt(this.meta.enc, password);
    const kp = Keypair.fromSecretKey(new Uint8Array(secret));
    if (kp.publicKey.toBase58() !== this.meta.address) throw new Error('Wallet file is corrupted.');
    this.keypair = kp;
    return { address: this.address() };
  }

  lock() { this.keypair = null; }

  verify(password) {
    if (!this.exists()) throw new Error('No wallet found.');
    this._decrypt(this.meta.enc, password);
    return true;
  }

  /** Returns the private key in base58 (importable in Phantom / Solflare). */
  exportPrivateKey(password) {
    if (!this.exists()) throw new Error('No wallet found.');
    return bs58.encode(this._decrypt(this.meta.enc, password));
  }

  async withdraw(rpcCall, to, amountSol, password) {
    if (!this.keypair) throw new Error('Unlock your wallet first.');
    this.verify(password);
    let dest;
    try { dest = new PublicKey(String(to).trim()); } catch (_) { throw new Error('Invalid destination address.'); }
    const amount = Number(amountSol);
    if (!(amount > 0)) throw new Error('Enter an amount greater than 0.');
    const lamports = Math.round(amount * LAMPORTS_PER_SOL);
    const balance = await rpcCall((c) => c.getBalance(this.keypair.publicKey));
    if (lamports + 10000 > balance) throw new Error('Not enough SOL (network fee included).');
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: this.keypair.publicKey, toPubkey: dest, lamports,
    }));
    // The transfer is built and signed ONCE, outside anything that can be retried. A failover retry that fetched
    // a fresh blockhash and signed again would produce a second, different transaction, and if the first one was
    // only slow both would land: the same withdrawal paid twice. Re-broadcasting the same bytes is idempotent.
    const { blockhash } = await rpcCall((c) => c.getLatestBlockhash('confirmed'));
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.keypair.publicKey;
    tx.sign(this.keypair);
    const raw = tx.serialize();
    const signature = await rpcCall((c) => c.sendRawTransaction(raw), { timeoutMs: 1500, attempts: 3, budgetMs: 5000 });
    // Polled by signature rather than by `confirmTransaction`, which gives up at blockhash expiry and would have
    // reported a transfer that landed as a failure.
    let status = null;
    for (let i = 0; i < 20 && !status; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await rpcCall((c) => c.getSignatureStatuses([signature]), { timeoutMs: 3000, attempts: 2, budgetMs: 6000 }).catch(() => null);
      const st = r && r.value && r.value[0];
      if (st) status = st;
    }
    if (status && status.err) throw new Error('The transfer was rejected on chain. Nothing left the wallet.');
    if (!status || (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized')) {
      throw new Error(`The transfer was sent but not confirmed in time. Check it on Solscan before doing anything else: ${signature}`);
    }
    return { signature };
  }
}

module.exports = { WalletManager };
