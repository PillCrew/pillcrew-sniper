const assert = require('assert');
const EventEmitter = require('events');
const { checkSocket, checkRpc, checkAll, explainSocketFailure } = require('../src/diag');

// A fake socket that behaves the way providers actually behave.
function fake({ onOpenSend, reply, error, closeCode, silent = false }) {
  return () => {
    const ws = new EventEmitter();
    ws.terminate = () => {};
    ws.send = (raw) => {
      const msg = JSON.parse(raw);
      if (silent) return;
      if (onOpenSend) return onOpenSend(msg, ws);
      if (error) return ws.emit('error', new Error(error));
      if (closeCode) return ws.emit('close', closeCode, '');
      ws.emit('message', JSON.stringify(reply === undefined ? { jsonrpc: '2.0', id: msg.id, result: 42 } : reply));
    };
    setImmediate(() => ws.emit('open'));
    return ws;
  };
}

(async () => {
  // A good socket subscribes.
  let row = await checkSocket('wss://good.example', { wsFactory: fake({}) });
  assert.strictEqual(row.ok, true, row.detail);
  assert.match(row.detail, /Subscribed to the Pump.fun program logs/);

  // The 401 that cost a week: named, and the fix depends on whether the RPC URL carries a key.
  row = await checkSocket('wss://ws.eu.fluxrpc.com', { wsFactory: fake({ error: 'Unexpected server response: 401' }), hasKeyInRpc: true });
  assert.strictEqual(row.ok, false);
  assert.match(row.detail, /the socket needs it too/);
  row = await checkSocket('wss://ws.example', { wsFactory: fake({ error: 'Unexpected server response: 401' }), hasKeyInRpc: false });
  assert.match(row.detail, /Copy the socket URL together with the key/);

  // A refused subscription, a close, a silent endpoint and an HTTP address each get their own sentence.
  row = await checkSocket('wss://x', { wsFactory: fake({ reply: { jsonrpc: '2.0', id: 1, error: { message: 'Method not found' } } }) });
  assert.strictEqual(row.ok, false); assert.match(row.detail, /Method not found/);
  row = await checkSocket('wss://x', { wsFactory: fake({ closeCode: 1006 }) });
  assert.strictEqual(row.ok, false);
  row = await checkSocket('wss://x', { wsFactory: fake({ silent: true }), timeout: 60 });
  assert.match(row.detail, /No answer in six seconds|no answer/i);
  assert.match(explainSocketFailure(0, 'Unexpected server response: 200'), /not a WebSocket/);
  assert.match(explainSocketFailure(0, 'getaddrinfo ENOTFOUND nope'), /does not resolve/);
  assert.match(explainSocketFailure(429, ''), /Rate limited/);
  assert.match(explainSocketFailure(0, 'boom'), /boom/);

  // The geyser check asks for the transaction stream, and says so.
  row = await checkSocket('wss://geo.example', { wsFactory: fake({}), method: 'transactionSubscribe', params: [{}] });
  assert.match(row.detail, /transaction stream/);

  // Node checks: a healthy answer carries the latency, a 401 and a 429 are different sentences.
  const okFetch = async () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { 'solana-core': '2.1.0' } } });
  row = await checkRpc('https://rpc.example', { fetchJson: okFetch });
  assert.strictEqual(row.ok, true); assert.match(row.detail, /solana-core 2\.1\.0/);
  row = await checkRpc('https://rpc.example', { fetchJson: async () => ({ status: 401, body: {} }) });
  assert.match(row.detail, /without a key/);
  row = await checkRpc('https://rpc.example', { fetchJson: async () => ({ status: 429, body: {} }) });
  assert.match(row.detail, /Rate limited/);
  row = await checkRpc('https://rpc.example', { fetchJson: async () => ({ status: 200, body: { error: { message: 'nope' } } }) });
  assert.match(row.detail, /answered with an error: nope/);
  row = await checkRpc('', { fetchJson: okFetch });
  assert.strictEqual(row.ok, false); assert.match(row.detail, /No address configured/);

  // The panel: an empty configuration is told what it costs, a keyed socket is told the key was used.
  const bare = await checkAll({ rpcUrl: '', rpcWsUrl: '', geyserUrl: '', rpcBackupUrl: '' }, { fetchJson: okFetch, wsFactory: fake({}) });
  assert.strictEqual(bare.rows.length, 4);
  assert.ok(bare.notes.some((n) => /nineteen seconds behind/.test(n)), 'an unconfigured desk hears the measurement');
  const keyed = await checkAll(
    { rpcUrl: 'https://eu.fluxrpc.com?key=ABC', rpcWsUrl: 'wss://ws.eu.fluxrpc.com', geyserUrl: '', rpcBackupUrl: '' },
    { fetchJson: okFetch, wsFactory: fake({}), resolvedWs: 'wss://ws.eu.fluxrpc.com?key=ABC' },
  );
  assert.ok(keyed.notes.some((n) => /adds it automatically/.test(n)), 'and a keyless socket is explained');
  assert.strictEqual(keyed.rows.find((r) => r.label === 'Your socket').ok, true);

  console.log('Connection doctor tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
