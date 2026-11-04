const assert = require('assert');
const { RPCManager, DEFAULT_ENDPOINTS, classify } = require('../src/rpc');

(async () => {
  // RULE CHANGED: the pool now holds only endpoints that answered a funded-wallet call on 2026-11-04. Four public
  // hosts were removed for refusing service (paid plan, missing key, or 429 without one).
  assert.strictEqual(DEFAULT_ENDPOINTS.length, 5);
  assert.strictEqual(classify(new Error('429 Too Many Requests')).kind, '429');
  assert.strictEqual(classify(new Error('RPC timeout')).kind, 'timeout');
  assert.strictEqual(classify(new Error('fetch failed')).kind, 'network');
  assert.strictEqual(classify(new Error('Transaction simulation failed')).retry, false);
  // A provider that will not serve the method is a node problem, not a verdict on the transaction: leaving it
  // unclassified is what kept a real position unsellable while the pool rotated back to the same dead host.
  assert.strictEqual(classify(new Error('400 Bad Request: chain is not available on free plan, please upgrade to paid plan')).kind, 'plan');
  assert.strictEqual(classify(new Error('Method getBalance is available for paid plans only')).kind, 'plan');
  assert.strictEqual(classify(new Error('The free public RPC now requires an API key')).kind, 'plan');
  assert.strictEqual(classify(new Error('API key is not allowed to access blockchain')).kind, 'plan');
  // A provider that will only answer a narrower shape of the same question is a node problem too: one public host
  // refuses getParsedTokenAccountsByOwner without a mint filter, and taking that as fatal hid every coin in the
  // wallet - which is exactly what "my coins are not showing" looked like.
  assert.strictEqual(classify(new Error('400 Bad Request: {"error":{"code":-32602,"message":"getTokenAccountsByOwner requires a mint filter on this endpoint"}}')).kind, 'plan');
  // A real chain rejection stays fatal: rotating it to another node would only fail again.
  assert.strictEqual(classify(new Error('custom program error: 0x1771')).retry, false);

  // A public host refusing a burst is a short bench, not a ten-minute exile: a 403 that names nothing was what kept
  // the pool at zero live nodes while the network itself was fine.
  assert.strictEqual(classify(new Error('403 Forbidden: {"jsonrpc":"2.0","error":{"code":-32602,"message":"Request blocked"}}')).kind, '403');
  assert.strictEqual(classify(new Error('403 Forbidden: {"error":"invalid api key"}')).kind, 'auth');
  assert.strictEqual(classify(new Error('401 Unauthorized')).kind, 'auth');

  // 429 on node 0, timeout on node 1, network error on node 2, node 3 works
  const behaviour = { 0: '429', 1: 'slow', 2: 'net', 3: 'ok' };
  const switches = [];
  const m = new RPCManager({
    timeoutMs: 100,
    factory: (url) => ({ url, getBalance: async () => {
      const i = DEFAULT_ENDPOINTS.indexOf(url);
      const b = behaviour[i] || 'ok';
      if (b === '429') throw new Error('429 Too Many Requests');
      if (b === 'slow') await new Promise((r) => setTimeout(r, 500));
      if (b === 'net') throw new Error('fetch failed');
      return 42;
    } }),
    onSwitch: (f, t, why) => switches.push(why),
  });
  assert.strictEqual(await m.call((c) => c.getBalance()), 42);
  assert.strictEqual(m.current, DEFAULT_ENDPOINTS[3]);
  assert.deepStrictEqual(switches, ['429', 'timeout', 'network']);
  // cooled-down nodes are skipped later
  assert.ok(m.status().nodes[0].coolingDown);

  // real (non-network) errors are not retried on other nodes
  let calls = 0;
  const m2 = new RPCManager({ factory: () => ({ f: async () => { calls++; throw new Error('custom program error: 0x1771'); } }) });
  await assert.rejects(m2.call((c) => c.f()), /0x1771/);
  assert.strictEqual(calls, 1);

  // all nodes dead -> clear error, tried each node once
  let tries = 0;
  const m3 = new RPCManager({ factory: () => ({ f: async () => { tries++; throw new Error('429'); } }) });
  await assert.rejects(m3.call((c) => c.f()), /All RPC nodes/);
  assert.strictEqual(tries, DEFAULT_ENDPOINTS.length);

  // A pool where every node is cooling down still tries one instead of refusing the caller: a bench is not proof
  // that the node is dead, and an answer to the player of "all busy" while the chain is fine is worse.
  let tries4 = 0;
  const m3b = new RPCManager({ factory: () => ({ f: async () => { tries4++; throw new Error('429'); } }) });
  await assert.rejects(() => m3b.call((c) => c.f(), { attempts: 2, budgetMs: 2000 }), /All RPC nodes/);
  await m3b.call((c) => c.f(), { attempts: 1, budgetMs: 2000 }).catch(() => {});
  assert.strictEqual(tries4, 3, 'a cooldown does not stop the call from being attempted');

  // custom node goes first, and can be removed
  const m4 = new RPCManager({ custom: 'https://my.helius.example/x', factory: (u) => ({ u }) });
  assert.strictEqual(m4.current, 'https://my.helius.example/x');
  m4.setCustom('');
  assert.strictEqual(m4.current, DEFAULT_ENDPOINTS[0]);
  assert.strictEqual(m4.endpoints.length, DEFAULT_ENDPOINTS.length);

  // A call is bounded even when every node hangs: eight nodes timing out at eight seconds each used to hold a
  // sell for a minute while the price it wanted was gone.
  const m5 = new RPCManager({ timeoutMs: 400, factory: () => ({ hang: () => new Promise(() => {}) }) });
  const t5 = Date.now();
  await assert.rejects(m5.call((c) => c.hang(), { timeoutMs: 150, attempts: 3, budgetMs: 500 }), /All RPC nodes/);
  const spent = Date.now() - t5;
  assert.ok(spent < 900, `the whole failover must stay inside its budget, took ${spent} ms`);

  // The broadcast budget the engine uses stops the loop after a couple of tries, not all eight.
  let broadcastTries = 0;
  const m6 = new RPCManager({ factory: () => ({ send: async () => { broadcastTries++; throw new Error('RPC timeout'); } }) });
  await assert.rejects(m6.call((c) => c.send(), { timeoutMs: 200, attempts: 3, budgetMs: 1000 }), /All RPC nodes/);
  assert.strictEqual(broadcastTries, 3, 'a broadcast gets three tries, not eight');
  // The same bytes go out on parallel doors: the first signature wins and the rest are left to fail quietly. A
  // transaction only lands once it reaches a leader, so one door is one chance.
  {
    let sent = 0;
    const m7 = new RPCManager({
      factory: (url) => ({ sendRawTransaction: async () => { sent++; if (url === DEFAULT_ENDPOINTS[2]) return 'SIG'; throw new Error('fetch failed'); } }),
    });
    assert.strictEqual(await m7.broadcast(Buffer.from('x')), 'SIG');
    assert.strictEqual(sent, 3, 'three doors, not one');

    const m8 = new RPCManager({ factory: () => ({ sendRawTransaction: async () => { throw new Error('400 Bad Request'); } }) });
    await assert.rejects(() => m8.broadcast(Buffer.from('x'), { doors: 2 }), /400/);
  }

  console.log('RPCManager tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
