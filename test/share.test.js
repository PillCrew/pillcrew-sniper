const assert = require('assert');
const Share = require('../src/share');
const { DEFAULTS, AUTOPILOT } = require('../src/engine');

const settings = { ...DEFAULTS, ...AUTOPILOT, buyAmountSol: 0.02, rpcUrl: 'https://my-secret-node.example', pumpdevKey: 'KEY-123' };
const code = Share.encode(settings);

// A code is a tweet-sized string, and it carries the policy and nothing else.
assert.ok(code.startsWith('PCS1.'), 'the code names its format');
assert.ok(code.length < 280, `a code has to fit in a post, got ${code.length}`);
const back = Share.decode(code);
for (const k of Share.SHARE_KEYS) {
  assert.ok(Math.abs(Number(back.values[k]) - Number(settings[k])) < 1e-9, `${k} survives the round trip`);
}
assert.strictEqual(back.profile, 'balanced');

// Secrets and machine state are not in the payload at all: not hidden, absent.
const payload = JSON.parse(Buffer.from(code.slice(5).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
assert.deepStrictEqual(Object.keys(payload).sort(), ['n', 'p', 'v'], 'the payload is a version, a profile and a list of numbers');
assert.deepStrictEqual(Object.keys(back.values).sort(), [...Share.SHARE_KEYS].sort(), 'and decodes to the shared keys only');
assert.ok(!Share.SHARE_KEYS.includes('rpcUrl'), 'an RPC URL from a stranger is never applied');
assert.ok(!Share.SHARE_KEYS.includes('pumpdevKey') && !Share.SHARE_KEYS.includes('incineratorKey'), 'no API keys');
assert.ok(!Share.SHARE_KEYS.includes('mode') && !Share.SHARE_KEYS.includes('openPositions'), 'no mode and no positions');

// Damage is refused instead of half applied.
const broken = code.slice(0, -1) + (code.endsWith('a') ? 'b' : 'a');
assert.throws(() => Share.decode(broken), /damaged/, 'a changed character is caught by the checksum');
assert.throws(() => Share.decode(code.slice(0, 40)), /truncated|damaged|read/, 'a truncated code is refused');
assert.throws(() => Share.decode('hello'), /not a PillCrew settings code/, 'anything else is refused');
assert.throws(() => Share.decode(''), /not a PillCrew settings code/, 'an empty code is refused');

// The description is the line someone posts next to the code.
const line = Share.describe(settings);
assert.match(line, /\d+% target/, 'the description names the target');
assert.match(line, /first rung/, 'and the first rung');

// A code shared BEFORE a setting existed still works. The list is positional, so a shorter list is an older code, not a
// damaged one - and every code already posted on X has to keep working for ever.
{
  // A code from before the five-minute floor, the holder bar, the extra-filters switch and the simple settings existed.
  const shorter = { ...settings };
  const added = ['minChange5mPct', 'minHolders', 'deepEntry', 'maxBuyers', 'simpleMode'];
  for (const k of added) delete shorter[k];
  const keys = Share.SHARE_KEYS.filter((k) => !added.includes(k));
  const values = keys.map((k) => Number(shorter[k]));
  const body = Buffer.from(JSON.stringify({ v: 1, p: 'balanced', n: values })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let h = 0x811c9dc5;
  for (const ch of body) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  const oldCode = Share.PREFIX + body + '.' + (h >>> 0).toString(36).slice(-2).padStart(2, '0');
  const old = Share.decode(oldCode);
  assert.strictEqual(old.values.minHolders, undefined, 'an older code simply does not carry the newer holder bar');
  assert.strictEqual(old.values.maxBuyers, undefined, 'nor the newer buyer ceiling');
  assert.strictEqual(old.values.simpleMode, undefined, 'nor the simple settings switch');
  assert.strictEqual(old.values.minChange5mPct, undefined, 'nor the newer five minute floor');
  assert.strictEqual(old.values.maxChange5mPct, settings.maxChange5mPct, 'and carries everything it did carry');
}

console.log('Share tests passed');
