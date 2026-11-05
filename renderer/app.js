'use strict';
/* PillCrew Sniper - renderer. All dynamic text is inserted with textContent (coin names come from the network and are untrusted). */
(() => {
  const api = window.api;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function icon(name, cls) {
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    const u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#i-' + name); svg.append(u); return svg;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  // skip DOM rebuilds when the data did not change (keeps the UI smooth while the bot runs)
  const memo = new Map();
  const changed = (key, data) => { const j = JSON.stringify(data); if (memo.get(key) === j) return false; memo.set(key, j); return true; };
  // A number that could not be read is drawn as a dash, never as zero: a wallet balance that failed to load must not
  // look like an empty wallet, and an unknown profit must not look like break-even.
  const money = (n) => n != null && Number.isFinite(Number(n));
  const sol = (n, d = 3) => (money(n) ? Number(n).toFixed(d) : '–');
  const signed = (n, d = 3) => (money(n) ? (n >= 0 ? '+' : '') + Number(n).toFixed(d) : '–');
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
  const fmtAge = (s) => {
    if (!Number.isFinite(s) || s < 0) return '–';
    if (s < 90) return Math.round(s) + 's';
    if (s < 5400) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
    if (s < 172800) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd';
  };

  async function call(p) { const r = await p; if (!r || !r.ok) throw new Error((r && r.error) || 'Something went wrong.'); return r.data; }

  let toastTimer;
  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 3200);
  }

  // ───────── modal helper ─────────
  function modal(build) {
    return new Promise((resolve) => {
      const box = clear($('#modalBox')); const root = $('#modal');
      const close = (v) => { root.classList.add('hidden'); resolve(v); };
      build(box, close); root.classList.remove('hidden');
      const f = $('input, button.btn', box); if (f) f.focus();
    });
  }
  function askPassword(title, text, confirmLabel = 'Continue') {
    return modal((box, close) => {
      const pw = h('input', { type: 'password', placeholder: 'Wallet password', autocomplete: 'off' });
      const go = () => close(pw.value || null);
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      box.append(h('h2', {}, title), h('p', {}, text), pw,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn', onclick: go }, confirmLabel)));
    });
  }
  function confirmBox(title, text, okLabel, danger) {
    return modal((box, close) => box.append(h('h2', {}, title), h('p', {}, text),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'),
        h('button', { class: 'btn' + (danger ? ' danger' : ''), onclick: () => close(true) }, okLabel))));
  }

  // ───────── state ─────────
  let S = null;            // latest engine state
  let settings = null;
  let wallet = { exists: false, unlocked: false, address: null };
  let tab = 'dashboard';

  // ───────── navigation ─────────
  function showTab(name) {
    tab = name;
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    if (name === 'feed' && S) { renderFeed.at = 0; renderFeed(S); }
    if (name === 'wallet') renderWallet();
    if (name === 'settings') {
      // The panel shows numbers that came from the main process, so it asks for them again every time it opens.
      // A stale copy is how a "0.004 SOL per coin" line survived a change made anywhere else.
      api.getSettings().then((r) => {
        if (!r || !r.ok || tab !== 'settings') return;
        // Never overwrite a field somebody is already typing in.
        const active = document.activeElement;
        if (active && active.closest && active.closest('#settingsForm')) return;
        settings = r.data;
        renderSettings();
      }).catch(() => {});
      renderSettings();
      fillShareCode();
    }
  }  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

  // ───────── engine state → UI ─────────
  function applyState(s) {
    S = s;
    window.dispatchEvent(new CustomEvent('bot-state', { detail: { running: s.running } }));
    const live = s.mode === 'live';
    $('#sideMode').textContent = live ? 'Real Money' : 'Practice Mode';
    $('#sideMode').classList.toggle('live', live);
    $$('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
    const dot = $('#conn .dot');
    dot.className = 'dot ' + (s.connected ? 'ok' : s.running ? 'warn' : '');
    const fi = s.feedInfo || {};
    const label = fi.label === 'pumpdev' ? 'PumpDev stream' : fi.label === 'pumpportal' ? 'PumpPortal (launches)' : fi.source === 'chain' ? `On-chain · ${fi.rate} ev/s` : '';
    $('#connText').textContent = s.connected ? (label || 'Live feed') : s.running ? 'Connecting…' : 'Offline';
    const cov = s.coverage || {};
    const perMin = s.stats && s.stats.launchesPerMin ? `${s.stats.launchesPerMin}/min` : '0/min';
    $('#sFeed').textContent = s.running
      ? `${perMin} launches · ${cov.trending || 0} trending · ${cov.fresh || 0} live`
      : 'since start';
    if (s.rpc) {
      const cur = s.rpc.nodes.find((n) => n.active);
      $('#rpcText').textContent = 'RPC: ' + (cur ? cur.host : 'auto');
      $('#rpcInfo .dot').className = 'dot ' + (cur && cur.coolingDown ? 'warn' : 'ok');
    }
    const btn = $('#startBtn');
    $('span', btn).textContent = s.running ? 'Stop Bot' : 'Start Bot';
    $('use', btn).setAttribute('href', s.running ? '#i-stop' : '#i-play');
    btn.classList.toggle('stop', s.running);
    $('#heroSub').textContent = s.running
      ? (live ? 'Bot is trading with REAL money. Watch the log below.' : 'Bot is running in Practice Mode. No real money is used.')
      : 'Press Start and the bot hunts new Pump.fun coins for you. Practice Mode uses fake money.';
    const pauseNote = document.getElementById('pauseNote');
    if (pauseNote) {
      if (s.paused) {
        pauseNote.hidden = false;
        // The sentence used to be the whole note, so the only way out of a pause was to wait it out - and the owner
        // asked for a button beside the message. The text lives in its own span now, and the button is untouched by
        // every repaint, so it cannot be swallowed mid-click.
        const text = document.getElementById('pauseText');
        const until = new Date(s.paused.until).toLocaleTimeString();
        if (text) text.textContent = `New entries paused until ${until} (${s.paused.reason}). Open positions still close normally.`;
        else pauseNote.textContent = `New entries paused until ${until} (${s.paused.reason}). Open positions still close normally.`;
      } else {
        pauseNote.hidden = true;
      }
    }

    $('#sBalance').textContent = sol(s.balance);
    // Real money: the honest figure is the wallet, not the sum of trades. It carries every fee and every rejected
    // order, which is exactly what the owner noticed was missing.
    const liveMode = s.mode === 'live';
    // RULE ADDED 2026-11-05: the number and its label must be the same fact. With the bot stopped there is no session
    // to measure, so the card falls back to the book's own profit - and calling that "since Start" was a lie on the
    // very first screen after a restart (-0.053 SOL of closed trades, read as this session's result).
    const hasDelta = liveMode && s.walletDeltaSol != null;
    const shown = hasDelta ? s.walletDeltaSol : s.stats.pnl;
    const pnl = $('#sPnl'); pnl.textContent = signed(shown); pnl.className = shown > 0 ? 'pos' : shown < 0 ? 'neg' : '';
    const sub = $('#sPnlSub');
    if (sub) {
      const fees = Number(s.stats.feeSpentSol || 0);
      const fails = Number(s.stats.orderFails || 0);
      // Where the entry price really came from. A desk that is buying at board prices instead of the pool's is buying
      // blind, and this is the only place that says so: `curve` is the number the order fills at, `board` is a row that
      // may be a minute old.
      const epx = s.stats.entryPx || {};
      const pxNote = Number(epx.curve || 0) + Number(epx.board || 0) + Number(epx.refused || 0) > 0
        ? ` · entries priced at the pool ${Number(epx.curve || 0)}, at the board ${Number(epx.board || 0)}, refused ${Number(epx.refused || 0)}`
        : '';
      sub.textContent = liveMode
        ? `SOL · ${hasDelta ? 'since Start' : 'closed trades'}${fees ? ` · fees ${sol(fees, 4)}` : ''}${fails ? ` · ${fails} refused` : ''}${pxNote}`
        : `SOL · practice${pxNote}`;
    }
    const closed = s.stats.wins + s.stats.losses;
    $('#sWin').textContent = closed ? Math.round((s.stats.wins / closed) * 100) + '%' : '–';
    $('#sWinSub').textContent = closed ? `${s.stats.wins} wins · ${s.stats.losses} losses` : 'no trades yet';
    $('#sBpm').textContent = s.stats.buysPerMin;
    $('#sSeen').textContent = (s.coverage && s.coverage.total) || s.stats.seen;
    $('#sLat').textContent = s.stats.lastLatencyMs == null ? '–' : s.stats.lastLatencyMs;
    $('#sSell').textContent = s.stats.lastSellMs == null ? '–' : s.stats.lastSellMs;
    renderReady(s);

    if (document.hidden) return;                       // nothing to paint while the window is hidden
    if (changed('curve', s.history.map((x) => x.pnlSol))) renderCurve(s);
    if (changed('picks', [s.running, s.feed.filter((t) => t.status !== 'skipped' && t.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map((t) => [t.mint, t.score, t.buyers])])) renderPicks(s);
    // Rebuilt only when the book itself changed; a price that moved is patched in place by paintPositions, so the
    // Sell buttons are never thrown away under the pointer.
    const rows = s.positions || [];
    if (changed('pos-set', rows.map((p) => p.mint).join(','))) renderPositions(s);
    else paintPositions(rows);
    if (changed('hist', s.history.slice(0, 8).map((x) => x.ts))) renderHistory(s);
    if (changed('log', [s.logs.length, s.logs.length ? s.logs[s.logs.length - 1].ts : 0])) renderLog(s.logs);
    renderFeed(s);
    const wb = $('#walBal'); if (wb) wb.textContent = sol(s.walletBalance || 0, 4);
    if (tab === 'settings') renderRpcList();
  }

  // The percentage as the card shows it, in one place so the two drawing paths can never disagree: an unknown price
  // is a dash, never a zero, and a move of a hundredth of a point is "0.0%", never "-0.0%".
  function pctText(pct) {
    if (pct == null) return '—';
    const v = Number(pct);
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) < 0.05) return '0.0%';
    return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  const pctClass = (pct) => (pct == null || !Number.isFinite(Number(pct)) ? '' : Number(pct) >= 0 ? 'pos' : 'neg');
  function positionRow(p) {
    const pct = p.pnlPct == null ? null : Number(p.pnlPct);
    const cls = pctClass(pct);
    return h('div', { class: 'row', 'data-mint': p.mint },
      h('div', {}, h('b', {}, '$' + (p.symbol || '?')), h('small', { 'data-note': '' }, `${sol(p.solIn, 3)} SOL · ${fmtAge(p.heldSec)}${p.paper ? ' · practice' : ''}${p.pending ? ' · confirming…' : ''}${Number(p.pxAgeSec) >= 6 ? ` · no price ${fmtAge(p.pxAgeSec)}` : ''}`)),
      h('div', { class: cls, 'data-px': '' }, h('b', { class: cls }, pctText(pct))),
      h('button', { class: 'btn small ghost', disabled: p.status !== 'open', onclick: () => {
        call(api.botSell(p.mint)).then(() => toast(`Sold ${p.symbol}.`)).catch((e) => toast(e.message, true));
      } }, 'Sell'));
  }
  /**
   * Open positions, updated in place.
   *
   * RULE CHANGED 2026-11-05 (the owner: "całe UI z Open positions skacze"): this used to clear the panel and build every
   * row again whenever the set of mints changed - and the set changes on every refused entry, because the buy path holds
   * a slot while it asks the pool for a price (500 refusals in one paper session). One coin arriving or leaving threw
   * every row away, so the eye saw the whole list jump. Rows now stay put: a coin that left is removed, a coin that
   * arrived is appended, everything else is left alone.
   */
  function renderPositions(s) {
    const box = $('#positions');
    const list = s.positions || [];
    const have = new Map([...box.querySelectorAll('[data-mint]')].map((el) => [el.dataset.mint, el]));
    const want = new Set(list.map((p) => p.mint));
    for (const [mint, el] of have) if (!want.has(mint)) el.remove();
    if (!list.length) {
      box.textContent = 'No open positions. The bot buys when a coin looks strong.';
      box.classList.add('empty');
      return;
    }
    if (box.classList.contains('empty')) { box.textContent = ''; box.classList.remove('empty'); }
    for (const p of list) {
      const existing = have.get(p.mint);
      if (existing && existing.isConnected) continue;
      box.append(positionRow(p));
    }
  }

  /**
   * The fast lane for the open positions: the engine pushes them whenever a price moved, so the percentage on screen
   * follows the market instead of waiting for the next full window update. Only the number and its colour are
   * touched - rebuilding the panel twenty times a second would throw away the Sell buttons under the cursor.
   */
  function paintPositions(list) {
    const box = $('#positions');
    if (!box || !Array.isArray(list) || !list.length) return;
    if (box.classList.contains('empty')) return renderPositions({ positions: list });
    const rows = new Map([...box.querySelectorAll('[data-mint]')].map((el) => [el.dataset.mint, el]));
    if (rows.size !== list.length || list.some((p) => !rows.has(p.mint))) return renderPositions({ positions: list });
    for (const p of list) {
      const row = rows.get(p.mint);
      const cell = row.querySelector('[data-px]');
      const note = row.querySelector('[data-note]');
      if (!cell) continue;
      const pct = p.pnlPct == null ? null : Number(p.pnlPct);
      const cls = pctClass(pct);
      const text = pctText(pct);
      const b = cell.firstElementChild;
      if (b && b.textContent !== text) b.textContent = text;
      if (cell.className !== cls) { cell.className = cls; if (b) b.className = cls; }
      if (note) {
        // A price nobody has refreshed is labelled as such, in words: a still percentage on a moving coin is the one
        // thing that made the owner sell a coin by hand while the card insisted it was up 71%.
        const stale = Number(p.pxAgeSec) >= 6 ? ` · no price ${fmtAge(p.pxAgeSec)}` : '';
        const line = `${sol(p.solIn, 3)} SOL · ${fmtAge(p.heldSec)}${p.paper ? ' · practice' : ''}${p.pending ? ' · confirming…' : ''}${p.closing ? ' · selling…' : ''}${stale}`;
        if (note.textContent !== line) note.textContent = line;
      }
      // The Sell button follows the position's own state: a row is never rebuilt to change that any more.
      const btn = row.querySelector('button');
      if (btn) { const off = p.status !== 'open'; if (btn.disabled !== off) btn.disabled = off; }
    }
  }
  function renderHistory(s) {
    const box = $('#history');
    // Rows are built before the box is touched: a panel that clears itself and then throws is a panel that reads
    // "no trades" while the trades are all still there, and that is what "recent trades disappeared" was.
    let rows;
    try {
      rows = (s.history || []).slice(0, 8).map((t) => {
        const pnl = Number(t.pnlSol) || 0;
        const pct = t.pnlPct == null ? null : Number(t.pnlPct);
        const cls = pnl >= 0 ? 'pos' : 'neg';
        // The peak is the honest footnote of a closed trade: "peaked at +41%" next to a fill at +8% says the exit was
        // early, and a row without it is a row that hides the most useful fact about the trade.
        const peak = t.peakPct == null ? '' : ` · peaked ${pctText(t.peakPct)}`;
        const held = t.heldSec == null ? '' : ` · held ${fmtAge(t.heldSec)}`;
        return h('div', { class: 'row' },
          h('div', {}, h('b', {}, '$' + (t.symbol || '?')), h('small', {}, `${t.reason || 'Sold'} · ${fmtTime(t.ts)}${peak}${held}`)),
          h('div', { class: cls }, h('b', { class: cls }, signed(pnl, 4) + ' SOL'), h('small', { class: pctClass(pct) }, pctText(pct))));
      });
    } catch (e) {
      return;
    }
    clear(box);
    box.classList.toggle('empty', !rows.length);
    if (!rows.length) { box.textContent = 'Closed trades show up here.'; return; }
    for (const r of rows) box.append(r);
  }
  function renderLog(logs) {
    const box = $('#log'); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    clear(box);
    for (const l of logs.slice(-60)) box.append(h('div', { class: l.level }, h('time', {}, fmtTime(l.ts)), l.msg));
    if (!logs.length) box.append(h('div', { class: 'warn' }, 'Nothing yet. Press Start to begin.'));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  function renderFeed(s) {
    if (tab !== 'feed') return;
    // The table is a page of text a person reads, not a ticker. Rebuilding eighty rows every second was the most
    // expensive thing the renderer did; two seconds is invisible to the eye and costs a fraction of the layout work.
    const now = Date.now();
    if (now - (renderFeed.at || 0) < 1800) return;
    renderFeed.at = now;
    const body = clear($('#feedBody'));
    $('#feedEmpty').style.display = s.feed.length ? 'none' : '';
    const cov = s.coverage || {};
    const meta = $('#feedMeta');
    if (meta) {
      const parts = [
        `${s.feed.length} in view`,
        cov.launch ? `${cov.launch} new launches` : '',
        cov.trending ? `${cov.trending} trending` : '',
        cov.callout ? `${cov.callout} boosted` : '',
        cov['new'] ? `${cov['new']} fresh profiles` : '',
        cov.chain ? `${cov.chain} on-chain` : '',
        cov.priced ? `${cov.priced} priced` : '',
        cov.fresh ? `${cov.fresh} live` : '',
      ].filter(Boolean);
      meta.textContent = parts.join(' · ');
    }
    for (const t of s.feed.slice(0, 60)) {
      const link = MINT_RE.test(t.mint)
        ? h('button', { class: 'btn small ghost', onclick: () => call(api.openExternal('https://pump.fun/coin/' + t.mint)).catch((e) => toast(e.message, true)) }, 'View')
        : '';
      const chg = typeof t.change5m === 'number' ? h('span', { class: t.change5m >= 0 ? 'pos' : 'neg' }, (t.change5m >= 0 ? '+' : '') + t.change5m.toFixed(0) + '%') : h('span', { class: 'muted' }, '–');
      body.append(h('tr', { class: t.status === 'bought' ? 'bought' : '' },
        h('td', {}, h('b', {}, '$' + t.symbol), h('small', {}, t.name)),
        h('td', {}, h('span', { class: 'chip src' }, t.source || 'launch')),
        h('td', {}, fmtAge(t.age)),
        h('td', {}, sol(t.mc, 1) + ' SOL'),
        h('td', {}, chg),
        h('td', {}, t.buyers),
        h('td', { class: t.net >= 0 ? 'pos' : 'neg' }, signed(t.net, 2)),
        h('td', {}, h('span', { class: 'bar' }, h('i', { style: `width:${Math.max(0, Math.min(100, t.score))}%` })), t.score),
        h('td', {}, h('span', { class: 'chip ' + t.status }, t.status === 'bought' ? 'Bought' : t.status === 'skipped' ? 'Skipped' : 'Watching'), h('small', {}, t.reason)),
        h('td', {}, link)));
    }
  }

  // ───────── performance curve + top picks ─────────
  function renderCurve(s) {
    const box = clear($('#curve'));
    const trades = s.history.slice().reverse();
    $('#curveNote').textContent = trades.length ? `${trades.length} closed trade${trades.length > 1 ? 's' : ''}` : '';
    if (trades.length < 2) { box.append(h('div', { class: 'empty-note' }, 'Your profit curve appears after the first trades.')); return; }
    const pts = [0]; let acc = 0; for (const t of trades) { acc += t.pnlSol; pts.push(acc); }
    const W = 600, H = 190, pad = 14, lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = (hi - lo) || 1;
    const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2), y = (v) => H - pad - ((v - lo) / span) * (H - pad * 2);
    const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const good = acc >= 0, col = good ? '#35f08c' : '#ff5d6c';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
    const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); return e; };
    const defs = mk('defs', {}); const g = document.createElementNS(NS, 'linearGradient'); g.setAttribute('id', 'cg'); g.setAttribute('x1', '0'); g.setAttribute('y1', '0'); g.setAttribute('x2', '0'); g.setAttribute('y2', '1');
    for (const [o, a] of [['0', '.35'], ['1', '0']]) { const st = document.createElementNS(NS, 'stop'); st.setAttribute('offset', o); st.setAttribute('stop-color', col); st.setAttribute('stop-opacity', a); g.append(st); }
    defs.append(g);
    mk('line', { x1: pad, x2: W - pad, y1: y(0), y2: y(0), stroke: 'rgba(255,255,255,.14)', 'stroke-dasharray': '4 5' });
    mk('path', { d: `${line} L${x(pts.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`, fill: 'url(#cg)' });
    mk('path', { d: line, fill: 'none', stroke: col, 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' });
    box.append(svg);
  }
  function renderPicks(s) {
    const box = clear($('#picks'));
    const top = s.feed.filter((t) => t.status !== 'skipped' && t.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
    box.classList.toggle('empty', !top.length);
    if (!top.length) { box.textContent = s.running ? 'Scanning… strong coins show up here.' : 'Start the bot to see the best-scoring coins live.'; return; }
    for (const t of top) box.append(h('div', { class: 'row pick' },
      h('div', {}, h('b', {}, '$' + t.symbol), h('small', {}, `${sol(t.mc, 1)} SOL cap · ${t.buyers} buyers`)),
      h('div', { class: 'score' }, t.score),
      h('div', { class: 'meter' }, h('i', { style: `width:${Math.min(100, t.score)}%` }))));
  }

  // ───────── readiness checklist ─────────
  function renderReady(s) {
    const box = $('#readyCard'); if (!box) return; clear(box);
    const funded = (s.walletBalance || 0) >= 0.05;
    const item = (done, text, tab) => h('span', { class: 'item' + (done ? ' done' : '') }, icon(done ? 'check' : 'circle'), tab && !done ? h('button', { onclick: () => showTab(tab) }, text) : text);
    box.append(h('b', {}, 'Ready check'),
      item(wallet.exists, 'Create your wallet', 'wallet'),
      item(wallet.exists && funded, 'Deposit a little SOL (0.05+)', 'wallet'),
      item(s.connected, 'Live feed connected'),
      item(s.mode === 'live', s.mode === 'live' ? 'Real Money on' : 'Practice Mode (switch to Real Money when ready)'));
  }

  // external links (only whitelisted https hosts are allowed by the main process)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-link]'); if (!b) return;
    call(api.openExternal(b.dataset.link)).catch((err) => toast(err.message, true));
  });

  // ───────── start / stop / mode ─────────
  $('#startBtn').addEventListener('click', async () => {
    try {
      if (S && S.running) { await call(api.botStop()); return; }
      const r = await api.botStart();
      if (!r.ok) throw new Error(r.error);
    } catch (e) { toast(e.message, true); }
  });
  $('#sellAllBtn').addEventListener('click', () => call(api.botSellAll())
    .then((r) => toast(`Sold ${r && r.sold ? r.sold : 'every'} position${r && r.sold === 1 ? '' : 's'}.`))
    .catch((e) => toast(e.message, true)));
  // The pause after a cold streak (or after selling everything) used to be something to wait out. It is a decision, so
  // it is one press away from being undone - and the button is inside the note, where the reason is read.
  const resumeBtn = document.getElementById('resumeBtn');
  if (resumeBtn) resumeBtn.addEventListener('click', () => call(api.botResume())
    .then(() => toast('Looking for coins again.'))
    .catch((e) => toast(e.message, true)));

  $('#modeSeg').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const mode = b.dataset.mode;
    if (S && S.mode === mode) return;
    try {
      if (mode === 'live') {
        if (!wallet.exists) { toast('Create your wallet first (Wallet tab).', true); showTab('wallet'); return; }
        if (!wallet.unlocked) {
          const pw = await askPassword('Unlock wallet', 'Enter your wallet password to use Real Money mode.', 'Unlock');
          if (!pw) return;
          wallet = await call(api.walletUnlock(pw));
        }
        const ok = await confirmBox('Switch to Real Money?', 'The bot will spend real SOL from your wallet. Meme coins are extremely risky and you can lose everything you deposit. Start with a very small amount.', 'I understand, switch', true);
        if (!ok) return;
      }
      settings = await call(api.setSettings({ mode }));
      toast(mode === 'live' ? 'Real Money mode on.' : 'Practice Mode on.');
    } catch (err) { toast(err.message, true); }
  });

  // ───────── wallet tab ─────────
  async function refreshWallet() { wallet = await call(api.walletStatus()); renderWallet(); }

  function renderWallet() {
    const root = clear($('#walletBody'));
    if (wallet.damaged) {
      // A wallet file that cannot be read is not a missing wallet: creating one here would overwrite a key that may
      // still be holding money, so the screen refuses to offer anything but the way out.
      root.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Wallet file problem'), h('span', { class: 'chip' }, 'Action needed')),
        h('p', { class: 'hint' }, wallet.damaged),
        h('p', { class: 'hint' }, 'The file is ' + 'wallet.json in this app\u2019s data folder. Copy it somewhere safe first, then restore a backup of it, or move it away and create a fresh wallet.'),
        h('div', { class: 'card-foot' }, h('button', { class: 'btn ghost', onclick: () => refreshWallet() }, 'Check again'))));
      return;
    }
    if (!wallet.exists) {
      const pw = h('input', { type: 'password', placeholder: 'Choose a password (min 8 characters)', autocomplete: 'new-password' });
      const pw2 = h('input', { type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password' });
      root.append(h('div', { class: 'card' }, h('h2', {}, 'Create your wallet'),
        h('p', { class: 'hint' }, 'We create a brand-new Solana wallet on this computer. The password encrypts it. If you forget the password and have no backup of the private key, the funds are lost forever.'),
        h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', {}, 'Password'), pw), h('label', { class: 'field' }, h('span', {}, 'Confirm password'), pw2)),
        h('div', { class: 'card-foot' }, h('button', { class: 'btn', onclick: async () => {
          try {
            if (pw.value !== pw2.value) throw new Error('Passwords do not match.');
            wallet = await call(api.walletCreate(pw.value)); renderWallet(); toast('Wallet created. Back up your private key now!');
          } catch (e) { toast(e.message, true); }
        } }, 'Create wallet'))));
      const key = h('textarea', { rows: 3, placeholder: 'Paste private key (base58 or JSON array)', spellcheck: 'false' });
      const ipw = h('input', { type: 'password', placeholder: 'Choose a password for this app', autocomplete: 'new-password' });
      root.append(h('div', { class: 'card' }, h('h2', {}, 'Or import an existing wallet'),
        h('p', { class: 'hint' }, 'Better idea: create a fresh wallet here and only send the amount you want to trade with.'),
        key, h('div', { style: 'height:10px' }), ipw,
        h('div', { class: 'card-foot' }, h('button', { class: 'btn ghost', onclick: async () => {
          try { wallet = await call(api.walletImport(key.value, ipw.value)); key.value = ''; renderWallet(); toast('Wallet imported.'); } catch (e) { toast(e.message, true); }
        } }, 'Import wallet'))));
      return;
    }
    root.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Balance'), h('span', { class: 'chip ' + (wallet.unlocked ? 'bought' : '') }, wallet.unlocked ? 'Unlocked' : 'Locked')),
      h('div', { class: 'big-bal' }, h('span', { id: 'walBal' }, sol(S && S.walletBalance, 4)), h('em', {}, 'SOL'))));
    if (S && S.mode === 'live' && S.reserveSol > 0 && S.walletBalance >= 0.0009) {
      root.append(h('div', { class: 'card' },
        h('h2', {}, 'Fees held back'),
        h('p', { class: 'hint' }, `${sol(S.reserveSol, 4)} SOL is never spent on coins: it pays the network fee and tip for every position the bot holds, so it can always sell everything it bought. ${sol(Math.max(0, S.freeSol || 0), 4)} SOL is free to trade with.`)));
    }
    // A wallet under the rent-exempt floor cannot be debited at all, so no route (PumpPortal, Jupiter, any swap
    // widget) can sell from it - the fee payer is the wallet. Said where the money is, not only in the log, and
    // only when coins are actually stuck: an empty new wallet is told on the deposit card instead.
    if (S && S.walletBalance != null && S.walletBalance < 0.0009 && (S.positions || []).length > 0) {
      root.append(h('div', { class: 'card warn-card' },
        h('h2', {}, 'Send SOL before the bot can trade'),
        h('p', { class: 'hint' }, `The network keeps 0.00089 SOL in every wallet and refuses any transaction that would go under it. This wallet holds ${sol(S.walletBalance, 6)} SOL, so buys, sells and fees are all refused — by every route, including Jupiter. Send at least 0.005 SOL to the address below and the bot closes its open positions by itself.`)));
    }
    root.append(h('div', { class: 'card' }, h('h2', {}, 'Deposit SOL'),
      h('p', { class: 'hint' }, 'Send SOL from any exchange or wallet (Coinbase, Phantom…) to this address. Only send SOL on the Solana network. A small amount is plenty to start.'),
      h('div', { class: 'addr' }, wallet.address),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => { navigator.clipboard.writeText(wallet.address).then(() => toast('Address copied.'), () => toast('Copy failed - select the address manually.', true)); } }, 'Copy address'),
        h('button', { class: 'btn ghost', onclick: () => call(api.openExternal('https://solscan.io/account/' + wallet.address)).catch((e) => toast(e.message, true)) }, 'View on Solscan'))));

    root.append(recoverCard());
    root.append(walletMaintenance());
    const to = h('input', { type: 'text', placeholder: 'Destination Solana address', spellcheck: 'false' });
    const amt = h('input', { type: 'number', min: '0', step: '0.001', placeholder: 'Amount in SOL' });
    root.append(h('div', { class: 'card' }, h('h2', {}, 'Withdraw'),
      h('p', { class: 'hint' }, `Send SOL back to your own wallet or exchange. Network fee is about 0.000005 SOL, and ${sol((S && S.reserveSol) || 0.002, 4)} SOL always stays behind to pay the exit fees of anything the bot still holds.`),
      h('div', { class: 'form-grid' }, h('label', { class: 'field wide' }, h('span', {}, 'To'), to), h('label', { class: 'field' }, h('span', {}, 'Amount (SOL)'), amt)),
      h('div', { class: 'card-foot' }, h('button', { class: 'btn', onclick: async () => {
        try {
          if (!wallet.unlocked) throw new Error('Unlock your wallet first.');
          const pw = await askPassword('Confirm withdrawal', `Send ${amt.value || '?'} SOL to ${to.value.slice(0, 6)}…${to.value.slice(-4)}?`, 'Send');
          if (!pw) return;
          const r = await call(api.walletWithdraw(to.value, amt.value, pw));
          toast(r.pending ? 'Sent - waiting for confirmation.' : 'Withdrawal confirmed.'); to.value = ''; amt.value = '';
        } catch (e) { toast(e.message, true); }
      } }, 'Withdraw'))));

    root.append(h('div', { class: 'card warn' }, h('h2', {}, 'Security'),
      h('p', { class: 'hint' }, 'Your private key controls all funds in this wallet. Anyone who sees it can take your SOL. Never share it or paste it into websites.'),
      h('div', { class: 'actions' },
        wallet.unlocked
          ? h('button', { class: 'btn ghost', onclick: async () => { try { wallet = await call(api.walletLock()); renderWallet(); } catch (e) { toast(e.message, true); } } }, 'Lock wallet')
          : h('button', { class: 'btn', onclick: async () => {
            const pw = await askPassword('Unlock wallet', 'Enter your password.', 'Unlock'); if (!pw) return;
            try { wallet = await call(api.walletUnlock(pw)); renderWallet(); } catch (e) { toast(e.message, true); }
          } }, 'Unlock wallet'),
        h('button', { class: 'btn danger', onclick: revealKey }, 'Show private key'))));
  }

  // Replacing or removing the wallet is the one action here that can strand money on chain, so it lives in its own
  // card, asks for the password, and refuses while the bot is running or a position is open.
  function walletMaintenance() {
    const fresh = async () => {
      const exportFirst = await confirmBox(
        'Back up the current key first?',
        'A new wallet replaces the key on this computer. Any SOL still on the old address needs that private key to move, so copy it out before you replace it.',
        'Show my key',
      );
      if (exportFirst) {
        await revealKey();
        const go = await confirmBox('Replace the wallet now?', 'The old key is removed from this computer. This cannot be undone.', 'Replace it', true);
        if (!go) return;
      } else {
        const go = await confirmBox('Replace the wallet without a backup?', 'The old key is removed and there is no copy. Any SOL on the old address is lost for good.', 'Replace it', true);
        if (!go) return;
      }
      const pw = await askPassword('Password for the new wallet', 'The new key is encrypted with a password you choose now. At least 8 characters.', 'Create wallet');
      if (!pw) return;
      try {
        wallet = await call(api.walletCreate(pw, true));
        renderWallet();
        toast('New wallet created. Copy the address and back up the new key.');
      } catch (e) { toast(e.message, true); }
    };

    const remove = async () => {
      const go = await confirmBox('Remove this wallet?', 'The key file is deleted from this computer. Without a backup of the private key, any SOL on this address is gone for good.', 'Remove it', true);
      if (!go) return;
      const pw = await askPassword('Confirm it is your wallet', 'Enter the current password. It is only used to prove the wallet is yours.', 'Remove wallet');
      if (!pw) return;
      try {
        // Only proof of ownership is needed here, so the key is never sent to the window.
        await call(api.walletVerify(pw));
        wallet = await call(api.walletReset());
        renderWallet();
        toast('Wallet removed from this computer.');
      } catch (e) { toast(e.message, true); }
    };

    return h('div', { class: 'card' },
      h('h2', {}, 'This wallet'),
      h('p', { class: 'hint' }, 'Starting over is normal while you learn. A new wallet is a new address, so send SOL to it again. Removing the wallet deletes the key file only, the chain keeps whatever is on the address.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: fresh }, 'Create a new wallet'),
        h('button', { class: 'btn danger', onclick: remove }, 'Remove this wallet')));
  }

  async function revealKey() {
    const pw = await askPassword('Show private key', 'Make sure nobody is looking at your screen. Enter your password to reveal the key.', 'Reveal');
    if (!pw) return;
    let key;
    try { key = await call(api.walletExport(pw)); } catch (e) { toast(e.message, true); return; }
    await modal((box, close) => {
      let timer;
      const done = () => { clearTimeout(timer); key = null; close(); };
      timer = setTimeout(done, 45000);
      box.append(h('h2', {}, 'Your private key'),
        h('p', {}, 'Save it somewhere safe and offline (password manager or paper). You can import it into Phantom or Solflare. This window closes by itself in 45 seconds.'),
        h('div', { class: 'secret' }, key),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn ghost', onclick: () => navigator.clipboard.writeText(key).then(() => toast('Key copied. Clear your clipboard after saving it.'), () => toast('Copy failed.', true)) }, 'Copy'),
          h('button', { class: 'btn', onclick: done }, 'Done')));
    });
  }


  // ───────── quick setup (auto-saves) ─────────
  async function autoSave(patch, msg) {
    try {
      settings = await call(api.setSettings(patch));
      // Every control on the settings tab is a view of one object. Re-render both halves after a change, so the
      // advanced form can never hold an older ticket than the chips above it and then save it back.
      if (tab === 'settings') renderSettings();
      else renderQuick();
      if (msg) toast(msg);
    } catch (e) { toast(e.message, true); if (tab === 'settings') renderSettings(); else renderQuick(); }
  }
  const AMOUNTS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1];
  const TOGGLES = [
    ['marketScan', 'Market scan', 'Watches trending, boosted, newest and brand-new coins across the whole Pump.fun market.'],
    ['wideDiscovery', 'Every coin source', 'Also hunts the DexScreener search board and GeckoTerminal’s newest and trending pools, where most coins that no launch list carries turn up. Turn it off to watch the launch feeds only.'],
    ['smartFees', 'Smart fees', 'Pays the lowest fee and slippage that still lands.'],
    ['trendMode', 'Trending coins', 'Also buys coins that are already pumping.'],
    ['autoReclaim', 'Auto-recover SOL', 'Closes empty token accounts after every sell, so the ~0.002 SOL of rent behind each coin comes back to the wallet.'],
    ['recoverDust', 'Recover dust too', 'A leftover too small for any market is burned so its account can be closed and its rent returned. Only when the leftover is worth less than half that rent.'],
    ['allowGraduated', 'Graduated coins', 'Also trade coins that finished their curve and moved to PumpSwap. Off by default: the market is different and the route is less reliable.'],
    ['useJito', 'Jito bundle', 'Offers every signed trade to Jito\'s block engine as well, with a tip that is paid only if the bundle lands. A better chance of landing in a crowded slot, at the cost of a small tip on the trades that do land. Your normal route is never given up for it.'],
    ['deepEntry', 'Extra entry filters', 'Requires a minimum number of holders before a coin can be bought, and shows the holder bar and the market cap band in the panel below. Off means only the normal rules apply.'],
    ['simpleMode', 'Simple settings', 'Shows only the basic numbers - the market cap band, buyer floor and ceiling, amount, slots, slippage, target, stop and hold time - and turns every advanced rule off. One switch back and the full desk returns.'],
  ];
  function renderQuick() {
    if (!settings) return;
    $$('#profiles .profile').forEach((p) => p.classList.toggle('active', p.dataset.profile === settings.profile));
    const chips = clear($('#amountChips'));
    for (const v of AMOUNTS) chips.append(h('button', { class: 'chip-btn' + (Math.abs(settings.buyAmountSol - v) < 1e-9 ? ' active' : ''), onclick: () => autoSave({ buyAmountSol: v }) }, v + ' SOL'));
    const custom = $('#amountCustom');
    if (custom && document.activeElement !== custom) {
      custom.value = AMOUNTS.some((v) => Math.abs(v - settings.buyAmountSol) < 1e-9) ? '' : String(settings.buyAmountSol);
    }
    // Money that rounds to 0.00 reads as "free" and it is not: keep three decimals below a tenth of a SOL.
    const inPlay = settings.buyAmountSol * settings.maxPositions;
    const inPlayText = inPlay < 0.1 ? inPlay.toFixed(3) : inPlay.toFixed(2);
    // The tips are fixed and the ticket is not, so at a small size they are most of the round trip. Saying "about 3%"
    // next to a 0.001 SOL ticket was the opposite of the truth: it is over 40%, and no strategy can beat that.
    const trip = 3 + (2 * Number(settings.priorityFeeSol || 0) / Math.max(settings.buyAmountSol, 0.001)) * 100;
    $('#amountHint').textContent = `Each coin costs about ${settings.buyAmountSol} SOL, and a round trip costs about ${trip.toFixed(0)}% of it (3% protocol fees plus the network tip both ways${trip > 8 ? ' — raise the ticket and this share falls' : ''}). With up to ${settings.maxPositions} coins at once, the bot can have ${inPlayText} SOL in play, plus about 0.002 SOL of rent per coin that comes back when it sells.`;
    const box = clear($('#toggles'));
    // In the simple mode the rest of the desk is off, so the rest of the switches are off the screen with it.
    const shown = settings.simpleMode ? TOGGLES.filter(([k]) => k === 'simpleMode') : TOGGLES;
    for (const [k, title, desc] of shown) {
      const input = h('input', { type: 'checkbox', checked: !!settings[k], onchange: async (e) => {
        await autoSave({ [k]: e.target.checked });
        // The settings form changes shape with these two switches, so it is re-rendered with them.
        if (k === 'deepEntry' || k === 'simpleMode') renderSettings();
      } });
      box.append(h('label', { class: 'tgl' }, input, h('span', { class: 'sw' }), h('div', {}, h('b', {}, title), h('small', {}, desc))));
    }
    if (settings.simpleMode) box.append(h('p', { class: 'hint', style: 'margin:10px 0 0' }, 'Every other rule is off while the simple settings are on. Switch them off to see the full desk.'));
    for (const [id, key] of [['#incKey', 'incineratorKey'], ['#pdKey', 'pumpdevKey'], ['#jupKey', 'jupiterKey']]) {
      const el = $(id);
      if (!el) continue;
      el.value = '';
      if (!el.dataset.ph) el.dataset.ph = el.placeholder;
      el.placeholder = settings[key] ? 'Key saved. Paste a new one to replace it.' : el.dataset.ph;
    }
  }
  for (const [btn, input, key, label] of [
    ['#incSave', '#incKey', 'incineratorKey', 'Sol Incinerator'],
    ['#pdSave', '#pdKey', 'pumpdevKey', 'PumpDev'],
    ['#jupSave', '#jupKey', 'jupiterKey', 'Jupiter'],
  ]) {
    $(btn).addEventListener('click', async () => {
      const v = $(input).value.trim();
      if (!v && !settings[key]) { toast('Paste your ' + label + ' key first.', true); return; }
      try {
        settings = await call(api.setSettings({ [key]: v }));
        $('#keyMsg').textContent = v ? label + ' key saved.' : label + ' key removed.';
        setTimeout(() => { $('#keyMsg').textContent = ''; }, 3000); renderQuick();
      } catch (e) { toast(e.message, true); }
    });
  }

  // ───────── recover SOL (wallet tab) ─────────
  function recoverCard() {
    const body = h('div', { class: 'list' });
    const short = (m) => m.slice(0, 4) + '…' + m.slice(-4);
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Coins and rent'), h('span', { class: 'muted' }, settings && settings.autoReclaim ? 'Auto-recover is on' : 'Auto-recover is off')),
      h('p', { class: 'hint' }, 'Selling every coin closes the whole desk in one press and then gives back the rent locked in empty token accounts. Nothing is burned.'),
      h('div', { class: 'actions', style: 'margin:0 0 12px' },
        h('button', { class: 'btn', onclick: sellAll }, icon('send'), 'Sell every coin and recover the rent'),
        h('button', { class: 'btn ghost', onclick: scan }, icon('radar'), 'Scan wallet')), body);
    async function sellAll(e) {
      if (!wallet.unlocked) { toast('Unlock your wallet first.', true); return; }
      const btn = e && e.currentTarget;
      if (!await confirmBox('Sell every coin?', 'Every coin the wallet holds is sold at the market price and the empty accounts are closed to get the rent back. This cannot be undone.', 'Sell everything')) return;
      if (btn) { btn.disabled = true; btn.textContent = 'Selling…'; }
      try {
        const r = await call(api.sellEverything());
        const moved = r.solBefore != null && r.solAfter != null ? r.solAfter - r.solBefore : null;
        toast(`Sold ${r.sold} of ${r.tokens} coin${r.tokens === 1 ? '' : 's'}, closed ${r.closed} account${r.closed === 1 ? '' : 's'}${moved != null ? `, wallet ${moved >= 0 ? '+' : ''}${sol(moved, 5)} SOL` : ''}.`, r.failed.length > 0);
        for (const f of r.failed.slice(0, 2)) toast(f, true);
      } catch (err) { toast(err.message, true); }
      if (btn) { btn.disabled = false; btn.textContent = 'Sell every coin and recover the rent'; }
      scan();
    }
    async function scan() {
      clear(body).append(h('p', { class: 'hint' }, 'Scanning…'));
      try {
        const r = await call(api.scanWallet());
        clear(body);
        body.append(h('div', { class: 'rec-row' },
          h('div', {}, h('b', {}, `${r.emptyCount} empty account${r.emptyCount === 1 ? '' : 's'}`), h('small', {}, `${sol(r.emptyRentSol, 5)} SOL can be recovered, free`)),
          h('button', { class: 'btn small', disabled: !r.emptyCount, onclick: async (e) => {
            if (!wallet.unlocked) { toast('Unlock your wallet first.', true); return; }
            e.target.disabled = true;
            try { const res = await call(api.closeEmpty()); toast(res.closed ? `Recovered ${sol(res.sol, 5)} SOL from ${res.closed} account${res.closed > 1 ? 's' : ''}.` : 'Nothing to close.'); if (res.errors && res.errors.length) toast(res.errors[0], true); scan(); } catch (err) { toast(err.message, true); e.target.disabled = false; }
          } }, 'Recover SOL')));
        if (settings && settings.incineratorKey && r.emptyCount) {
          body.append(h('div', { class: 'rec-row' }, h('div', {}, h('b', {}, 'Clean up with Sol Incinerator'), h('small', {}, 'Uses the API (2% fee on recovered rent)')),
            h('button', { class: 'btn small ghost', onclick: async (e) => { e.target.disabled = true; try { const x = await call(api.incineratorCloseAll()); toast(`Sol Incinerator: ${x.confirmed} of ${x.transactions} confirmed${x.sol ? `, ${sol(x.sol, 5)} SOL back in the wallet` : ''}.`, x.confirmed < x.transactions); scan(); } catch (err) { toast(err.message, true); e.target.disabled = false; } } }, 'Run cleanup')));
        }
        for (const d of r.dust.slice(0, 20)) {
          body.append(h('div', { class: 'rec-row' }, h('div', {}, h('b', {}, short(d.mint)), h('small', {}, `Holding ${d.uiAmount} · rent ${sol(d.rentSol, 5)} SOL`)),
            h('div', { class: 'row-actions' },
              h('button', { class: 'btn small', onclick: async (e) => {
                if (!wallet.unlocked) { toast('Unlock your wallet first.', true); return; }
                e.target.disabled = true;
                try { const x = await call(api.sellHolding(d.mint)); toast(x.left === '0' ? 'Sold the whole balance and the account is closed.' : 'Sold, but some tokens are still there.'); scan(); } catch (err) { toast(err.message, true); e.target.disabled = false; }
              } }, 'Sell'),
              h('button', { class: 'btn small ghost', onclick: async () => {
                if (!settings || !settings.incineratorKey) { toast('Burning needs a Sol Incinerator key (Settings > Integrations).', true); showTab('settings'); return; }
                if (!wallet.unlocked) { toast('Unlock your wallet first.', true); return; }
                if (!await confirmBox('Burn this token?', `The whole balance of ${short(d.mint)} is destroyed for good and its account is closed to recover the rent.`, 'Burn it', true)) return;
                try { const x = await call(api.incineratorBurn(d.mint)); toast(`Burned. Recovered about ${sol(x.sol, 5)} SOL.`); scan(); } catch (err) { toast(err.message, true); }
              } }, 'Burn'))));
        }
        if (r.frozen.length) body.append(h('p', { class: 'hint' }, `${r.frozen.length} frozen token account${r.frozen.length > 1 ? 's' : ''} found. Only the token's creator can unfreeze those, so they cannot be closed or burned by you.`));
        if (!r.emptyCount && !r.dust.length && !r.frozen.length) body.append(h('p', { class: 'hint' }, 'Your wallet is clean. Nothing to recover.'));
      } catch (e) { clear(body); toast(e.message, true); }
    }
    return card;
  }

  // ───────── settings tab ─────────
  const FIELDS = [
    ['minScore', 'Minimum score to buy (0-100)', 1, 'What the bot has to see before it spends. Higher means fewer, stronger entries.'],
    ['minBuyers', 'Buyers needed in the window', 1, 'Distinct wallets. Coins found by the market scan are read over five minutes instead.'],
    ['minNetFlowSol', 'The coin needs net buying of (SOL)', 0.1, 'Buys minus sells on the coin’s own tape, in the last few seconds. This is about the coin, not your ticket: 1 means other people bought a whole SOL more than they sold.'],
    ['minLiqUsd', 'Skip if the pool holds less than ($)', 100, 'A thin pool cannot absorb an exit. Zero turns the check off.'],
    ['watchSec', 'Watch a new coin for (seconds)', 1, 'How long a launch is watched before it may be bought.'],
    ['entryWindowSec', 'A launch counts as trending after (seconds)', 5, 'Past this age a coin is judged as an established mover.'],
    ['buyAmountSol', 'Buy amount per coin (SOL)', 0.001, 'Your ticket. The tip is a fixed cost, so a bigger ticket pays a smaller share of it.'],
    ['maxPositions', 'Max coins held at once', 1, 'Each one needs its own exit fee, which is kept aside and never spent.'],
    ['maxBuysPerMin', 'Max buys per minute', 1, 'Safety cap on trading speed. Type any number you want.'],
    ['takeProfitPct', 'Take profit (%)', 1, 'Sell when the gain reaches this, after fees.'],
    ['stopLossPct', 'Stop loss (%)', 1, 'Sell when the loss reaches this. Confirmed by a second price reading, so one bad quote cannot trigger it.'],
    ['maxHoldSec', 'Max hold time (seconds)', 5, 'Sell if nothing happens by then. Turns dead tickets back into SOL.'],
    ['slippagePct', 'Slippage ceiling (%)', 1, 'Smart fees stays tighter than this when it can.'],
    ['priorityFeeSol', 'Priority fee ceiling (SOL)', 0.0001, 'Smart fees pays less when the network is quiet.'],
    ['sessionLossLimitSol', 'Daily loss limit (SOL)', 0.01, 'New entries stop when reached. Open positions still close.'],
    ['maxDevBuySol', 'Skip if creator bought over (SOL)', 0.5, 'Avoids coins where the creator holds a huge bag.'],
    ['maxDevHoldPct', 'Skip if creator holds over (%, 0 is off)', 1, 'Read from the token audit. A creator holding a third of the supply can end the coin alone.'],
    ['maxTraderSharePct', 'Skip if one wallet is over (%)', 5, 'Avoids fake volume from a single wallet.'],
    ['maxChange5mPct', 'Skip if already up (%) in 5 min, 0 is off', 5, 'Refuses a coin that has already run: buying it is buying somebody else\'s exit.'],
    ['minChange5mPct', 'Only buy if up at least (%) in 5 min, 0 is off', 1, 'The floor of the same band: a launch that has not moved yet is where a move starts. A coin only 2% up with real demand is early; a coin 60% up is late.'],
    // RULE ADDED 2026-11-05: the two clocks a sniping desk is judged on, and the fee gate, are settings now instead of
    // constants in the code - a professional plan has to be reproducible and shareable, and these three decide as much
    // as the band does.
    ['minTokenAgeSec', 'Do not buy a coin younger than (seconds, 0 is off)', 1, 'A launch this young has no tape to judge - the buyers are the dev and his friends. Zero buys the first print.'],
    ['maxTokenAgeSec', 'Do not buy a coin older than (seconds, 0 is off)', 5, 'The whole-life version of the five minute ceiling: past this the move has happened and a small ticket is buying somebody else\'s exit.'],
    ['maxRoundTripPct', 'Refuse a ticket whose round trip costs more than (%)', 1, 'Fees both ways as a share of your ticket. Below this the tips eat the trade - at 0.001 SOL they are 40% of it. 5 is the floor, 20 is the shipped plan.'],
    ['tp1Pct', 'First take profit at (%, 0 is off)', 1, 'The first bite. Sells part of the position early and lets the rest run.'],
    ['tp1SellPct', 'How much to sell at that first target (%)', 5, 'A share of the position, for example 60. The remainder follows the target and the trailing stop.'],
    ['triggerHoldMs', 'A signal must hold for (ms) before it sells', 50, 'The safeguard: a take profit or a stop has to be seen again after this long, on a fresh price, before the bot acts. 400 is a blink; 0 acts on the first reading.'],
    ['trailArmPct', 'Trailing stop arms at (%)', 1, 'Once a coin is up this much, a give-back from the peak closes it.'],
    ['trailGivePct', 'Trailing stop gives back (%)', 0.5, 'How far the price may fall from its peak before the bot sells.'],
    ['breakEvenPct', 'Break even after a peak of (%, 0 is off)', 1, 'Once a coin has been up this much, the bot will not let it turn into a loss.'],
    ['maxLossStreak', 'Pause after losses in a row', 1, 'A cold streak means the market changed. The bot rests instead of bleeding.'],
    ['pauseMinutes', 'Pause length (minutes)', 1, 'New entries wait this long. Open positions still close normally.'],
    ['jitoTipSol', 'Jito tip per trade (SOL)', 0.00001, 'Only used when the Jito bundle is on. Paid only when the bundle lands - a bundle that loses the auction costs nothing.'],
  ];
  // Shown inside the extra filters panel: the holder bar and the market cap band the panel exists for.
  const DEEP_FIELDS = [
    ['minHolders', 'Minimum holders to buy (0 is off)', 1, 'A coin with fewer holders than this is skipped. Read from the live market at the moment of buying; a coin whose holder count cannot be read is skipped too.'],
    ['minMcSol', 'Lowest market cap to buy (SOL)', 5, 'The bottom of the band. Small caps move fastest and die fastest.'],
    ['maxMcSol', 'Highest market cap to buy (SOL)', 10, 'The top of the band. Coins found by the market scan get four times this.'],
  ];
  // The basic numbers the simple mode shows, and the only rules it leaves on.
  const SIMPLE_FIELDS = [
    ['minMcSol', 'Buy from market cap (SOL)', 5, 'The bottom of the band. Below it the coin is too small.'],
    ['maxMcSol', 'Buy up to market cap (SOL)', 10, 'The top of the band. Coins found by the market scan get four times this.'],
    ['minBuyers', 'Minimum buyers', 1, 'Distinct wallets in the window. Below this the coin is not bought.'],
    ['maxBuyers', 'Maximum buyers (0 is off)', 1, 'Past this the crowd is already in, so the coin is not bought. Zero turns the ceiling off.'],
    ['buyAmountSol', 'Buy amount per coin (SOL)', 0.001, 'Your ticket.'],
    ['maxPositions', 'Max coins held at once', 1, 'How many coins may be open at the same time.'],
    ['slippagePct', 'Slippage (%)', 1, 'How far the price may move while the order is in flight.'],
    ['takeProfitPct', 'Take profit (%)', 1, 'Sell when the gain reaches this, after fees.'],
    ['stopLossPct', 'Stop loss (%)', 1, 'Sell when the loss reaches this.'],
    ['maxHoldSec', 'Max hold time (seconds)', 5, 'Sell if nothing happens by then.'],
    // RULE ADDED 2026-11-05: these three decide in the SIMPLE plan as well - the age clocks gate both modes and the fee
    // gate is on every buy - so hiding them here left the shipped plan with three numbers nobody could change.
    ['minTokenAgeSec', 'Do not buy a coin younger than (seconds, 0 is off)', 1, 'A launch this young has no tape to judge. Zero buys the first print.'],
    ['maxTokenAgeSec', 'Do not buy a coin older than (seconds, 0 is off)', 5, 'The whole-life version of the five minute ceiling. Zero turns it off.'],
    ['maxRoundTripPct', 'Refuse a ticket whose round trip costs more than (%)', 1, 'Fees both ways as a share of your ticket. 5 is the floor, 20 is the shipped plan.'],
  ];
  function renderSettings() {
    if (!settings) return;
    $$('#profiles .profile').forEach((p) => p.classList.toggle('active', p.dataset.profile === settings.profile));
    const form = clear($('#settingsForm'));
    // Simple mode: only the basic numbers are shown, and the advanced ones stop deciding. The hidden values stay in
    // the store untouched, so switching back restores the full desk exactly as it was.
    if (settings.simpleMode) {
      form.append(h('div', { class: 'simple-note' }, 'Simple settings are on: only these numbers decide. Switch it off in the quick setup to see the whole desk again.'));
      for (const [k, label, step, hint] of SIMPLE_FIELDS) {
        form.append(h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'number', step, min: '0', 'data-key': k, value: String(settings[k] ?? '') }), hint ? h('span', {}, hint) : null));
      }
    } else {
      for (const [k, label, step, hint] of FIELDS) {
        form.append(h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'number', step, min: '0', 'data-key': k, value: String(settings[k] ?? '') }), hint ? h('span', {}, hint) : null));
      }
    }
    form.append(h('label', { class: 'field' }, h('span', {}, 'Data feed'), h('select', { 'data-key': 'feedSource' },
      ...[
        ['auto', 'Automatic (best available)'],
        ['pumpdev', 'PumpDev (trades + launches)'],
        ['chain', 'Blockchain only (needs good RPC)'],
        ['pumpportal', 'PumpPortal (launches only)'],
      ].map(([v, l]) => h('option', { value: v, selected: settings.feedSource === v }, l))), h('span', {}, 'Automatic picks PumpDev when a key is set, the blockchain when a private RPC is set, PumpPortal otherwise.')));
    // The extra entry filters panel: one switch in the quick setup opens it, and everything in it saves like any
    // other number. The rows stay inside the form even while hidden, so a hidden panel never loses its values.
    // It is not part of the simple mode: the simple mode has no advanced filters.
    if (!settings.simpleMode) {
      const deep = h('div', { id: 'deepPanel', class: 'deep-panel', hidden: !settings.deepEntry },
        h('div', { class: 'deep-head' }, h('b', {}, 'Extra entry filters'), h('small', {}, 'holders and the market cap band')));
      for (const [k, label, step, hint] of DEEP_FIELDS) {
        deep.append(h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'number', step, min: '0', 'data-key': k, value: String(settings[k] ?? '') }), hint ? h('span', {}, hint) : null));
      }
      form.append(deep);
    }
    $('#rpcUrl').value = settings.rpcUrl || '';
    $('#rpcBackupUrl').value = settings.rpcBackupUrl || '';
    $('#rpcWsUrl').value = settings.rpcWsUrl || '';
    const rt = 3 + (2 * settings.priorityFeeSol / Math.max(settings.buyAmountSol, 0.001)) * 100;
    // Which rule closes a position, in the order the engine checks them. The percentages are what is on screen, so a
    // sale at a number that is not the target explains itself. The simple mode reads only its own plan: saying "a
    // trail follows the peak" while the trail is switched off would be the desk lying to its owner.
    const plan = settings.simpleMode
      ? [`everything at +${settings.takeProfitPct}%`, `a stop at -${settings.stopLossPct}%`, 'half of any run past +20% is kept', `and nothing is held longer than ${settings.maxHoldSec} s`].join(', ')
      : [
      settings.tp1Pct > 0 ? `${settings.tp1SellPct}% goes out at +${settings.tp1Pct}%` : '',
      `the rest at +${settings.takeProfitPct}%`,
      `a stop at -${settings.stopLossPct}%`,
      settings.trailArmPct > 0 ? `a trail that follows a +${settings.trailArmPct}% peak and gives back ${settings.trailGivePct}%` : '',
      settings.breakEvenPct > 0 ? `no position that reached +${settings.breakEvenPct}% may close at a loss` : '',
      `and nothing is held longer than ${settings.maxHoldSec} s`,
    ].filter(Boolean).join(', ');
    $('#costNote').textContent = `Worst-case cost per round trip: ~${rt.toFixed(1)}% (3% protocol fees + network tip). Exits: ${plan}.`;
    renderQuick();
    renderRpcList();
    // The share code is a view of these numbers, so it is rewritten whenever they are.
    fillShareCode();
  }
  function renderRpcList() {
    const box = clear($('#rpcList'));
    if (!S || !S.rpc) return;
    for (const n of S.rpc.nodes) box.append(h('span', { class: n.active ? 'active' : '' }, h('i', { class: 'dot ' + (n.coolingDown ? 'warn' : 'ok') }), n.host + (n.active ? ' (active)' : n.coolingDown ? ' (resting)' : '')));
  }
  $('#profiles').addEventListener('click', async (e) => {
    const b = e.target.closest('.profile'); if (!b) return;
    try { settings = await call(api.setProfile(b.dataset.profile)); renderSettings(); toast('Style applied: ' + b.dataset.profile); } catch (err) { toast(err.message, true); }
  });
  $('#saveSettings').addEventListener('click', async () => {
    const patch = {};
    for (const el of $$('#settingsForm [data-key]')) {
      const k = el.dataset.key;
      if (el.type === 'checkbox') patch[k] = el.checked;
      else if (el.tagName === 'SELECT') patch[k] = el.value;
      else { const v = Number(el.value); if (!Number.isFinite(v) || v < 0) { toast('Invalid number in: ' + k, true); return; } patch[k] = v; }
    }
    if (patch.buyAmountSol <= 0) { toast('Buy amount must be above 0.', true); return; }
    patch.rpcUrl = $('#rpcUrl').value.trim();
    patch.rpcBackupUrl = $('#rpcBackupUrl').value.trim();
    patch.rpcWsUrl = $('#rpcWsUrl').value.trim();
    try {
      settings = await call(api.setSettings(patch));
      $('#saveMsg').textContent = 'Saved';
      setTimeout(() => { $('#saveMsg').textContent = ''; }, 2500);
      renderSettings();
    } catch (e) { toast(e.message, true); }
  });
  // ───────── share a settings code ─────────
  async function fillShareCode() {
    try {
      const r = await call(api.shareSettings());
      const code = $('#shareCode');
      if (code) code.value = r.code;
      return r;
    } catch (e) { toast(e.message, true); return null; }
  }
  $('#copyShare').addEventListener('click', async () => {
    const r = await fillShareCode();
    if (!r) return;
    try {
      await navigator.clipboard.writeText(r.code);
      $('#shareMsg').textContent = 'Code copied.';
    } catch (_) {
      $('#shareMsg').textContent = 'Select the code and copy it by hand.';
    }
    setTimeout(() => { $('#shareMsg').textContent = ''; }, 3000);
  });
  $('#postShare').addEventListener('click', async () => {
    const r = await fillShareCode();
    if (!r) return;
    // Short on purpose: the whole post has to fit in 280 characters, and the code already carries the plan - the
    // description line pushed it over the limit (320) as well as being the thing that made X see a link.
    const text = `PillCrew Sniper settings - paste into Settings:\n${r.code}`;
    call(api.openExternal('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text))).catch((e) => toast(e.message, true));
  });
  $('#applyShare').addEventListener('click', async () => {
    const code = String($('#shareInput').value || '').trim();
    if (!code) { toast('Paste a code first.', true); return; }
    try {
      if (S && S.running) throw new Error('Stop the bot first, then apply a code.');
      settings = await call(api.applySharedSettings(code));
      $('#shareApplyMsg').textContent = 'Applied. The numbers are below, and yours to change.';
      setTimeout(() => { $('#shareApplyMsg').textContent = ''; }, 5000);
      renderSettings();
      toast('Settings applied from the code.');
    } catch (e) { toast(e.message, true); }
  });

  $('#resetPractice').addEventListener('click', async () => {
    if (await confirmBox('Reset Practice Mode?', 'Your fake balance goes back to 5 SOL and practice stats are cleared.', 'Reset')) { await call(api.resetPractice()); toast('Practice account reset.'); }
  });
  $('#resetPaperStats').addEventListener('click', async () => {
    if (await confirmBox('Clear practice statistics?', 'Profit and loss, win rate and closed practice trades are cleared. Your 5 SOL practice balance stays where it is and open positions keep running.', 'Clear it', true)) {
      await call(api.resetStats('paper'));
      toast('Practice statistics cleared.');
    }
  });
  $('#resetLiveStats').addEventListener('click', async () => {
    if (await confirmBox('Clear real money statistics?', 'The session profit and loss, the win rate and the closed real trades are cleared. Nothing on chain is touched and open positions keep running.', 'Clear it', true)) {
      await call(api.resetStats('live'));
      toast('Real money statistics cleared.');
    }
  });
  $('#autopilotBtn').addEventListener('click', async () => {
    try {
      const btn = $('#autopilotBtn');
      btn.disabled = true;
      const before = settings && settings.buyAmountSol;
      settings = await call(api.autopilot());
      renderSettings();
      const lowered = before != null && Number(settings.buyAmountSol) < Number(before);
      const cap = Number(settings.sessionLossLimitSol);
      $('#autopilotMsg').textContent = `${lowered
        ? `Applied. The ticket is ${settings.buyAmountSol} SOL now, so one bad coin cannot end the session.`
        : 'Applied.'} The session stops itself at ${cap} SOL, which is eight tickets at this size. Everything below is editable.`;
      toast('Best settings for profit applied.');
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('#autopilotBtn').disabled = false;
    }
  });

  // A free amount, so 0.15 or 0.75 SOL is one click, not a settings hunt.
  $('#amountCustomSave').addEventListener('click', async () => {
    const raw = String($('#amountCustom').value || '').replace(',', '.').trim();
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0.001 || v > 1) { toast('Enter an amount between 0.001 and 1 SOL.', true); return; }
    await autoSave({ buyAmountSol: Math.round(v * 1000) / 1000 }, `Ticket set to ${Math.round(v * 1000) / 1000} SOL per coin.`);
  });
  $('#amountCustom').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#amountCustomSave').click(); });

  // ───────── onboarding ─────────
  const TOUR = [
    ['Welcome to PillCrew Sniper', 'This app watches every new coin on Pump.fun for you, picks the strong ones and trades automatically. No experience needed.'],
    ['Practice first', 'You start in Practice Mode with fake SOL. Press Start on the Dashboard and watch how the bot behaves. Nothing real is at risk.'],
    ['Your own wallet', 'In the Wallet tab you create a wallet that lives only on this computer. Deposit a little SOL and back up your private key.'],
    ['Know the risk', 'Meme coins are very risky and most lose value. Only trade with money you can afford to lose, and begin with the Safe style.'],
  ];
  function tour() {
    let i = 0;
    return modal((box, close) => {
      const draw = () => {
        clear(box);
        box.append(h('div', { class: 'steps' }, TOUR.map((_, n) => h('i', { class: n <= i ? 'on' : '' }))), h('h2', {}, TOUR[i][0]), h('p', {}, TOUR[i][1]),
          h('div', { class: 'modal-actions' },
            i > 0 ? h('button', { class: 'btn ghost', onclick: () => { i--; draw(); } }, 'Back') : h('button', { class: 'btn ghost', onclick: () => close() }, 'Skip'),
            h('button', { class: 'btn', onclick: () => { if (i < TOUR.length - 1) { i++; draw(); } else close(); } }, i < TOUR.length - 1 ? 'Next' : 'Get started')));
      };
      draw();
    });
  }
  $('#replayTour').addEventListener('click', () => tour());

  // ───────── boot ─────────
  api.onState(applyState);
  // The positions arrive on their own channel, twenty times a second while a price moves. A hidden window has nothing
  // to paint, so it is skipped exactly like the rest of the panels.
  if (api.onPositions) api.onPositions((list) => { if (!document.hidden) paintPositions(list); });
  api.onLog(() => {});
  (async () => {
    try {
      settings = await call(api.getSettings());
      wallet = await call(api.walletStatus());
      if (!settings.onboarded) { await tour(); settings = await call(api.setSettings({ onboarded: true })); }
    } catch (e) {
      toast(e.message, true);
    } finally {
      // The button is disabled in the markup so a click during the first second cannot be swallowed while the
      // settings are still loading. It comes alive once the app knows what it is doing.
      const btn = $('#startBtn');
      btn.disabled = false;
      btn.removeAttribute('title');
      if (tab === 'settings') renderSettings();
    }
  })();
})();
