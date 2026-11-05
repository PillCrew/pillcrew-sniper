# Changelog

All notable changes to this project are recorded here. The format follows Keep a Changelog and the
project uses semantic versioning.

## [1.0.0] - 2026-11-05

The first public release.

### Simple settings and the buyer ceiling

- **A new switch in Quick setup turns the desk simple.** While it is on, the settings form shows only the
  basic numbers - the market cap band, the buyer floor and ceiling, the amount, the slots, the slippage,
  the target, the stop and the hold time - and only those decide. The score bar, the net flow, the depth,
  the creator bags, the five minute band, the holder bar, the first rung, the trail and the break even are
  off. The safety protections (creator sold, graduated coins, unsupported quotes) never turn off in either
  mode, and the hidden numbers stay in the store untouched, so switching back restores the full desk
  exactly as it was.
- **The buyer ceiling is a new gate for both desks.** `maxBuyers` refuses a coin whose recent buyer count
  is already past the cap: past it the crowd is in, and a small ticket is buying their exit. Zero is off.
  It travels with the shareable settings code like every other entry number.

### Extra entry filters: the holder bar and the market cap band

- **A new switch in Settings opens a panel** with a minimum holder count and the market cap band. While the switch
  is on, a coin with fewer holders than the bar is never bought, and neither is a coin whose holder count cannot be
  read - a filter that silently passes when its data source is down is not a filter.
- **The count is real data**: it is read from the live market at the moment of buying (GeckoTerminal's token page,
  the same number their own UI shows) and remembered for ten minutes, so a buy attempt costs one request at most.
  The evaluator refuses a coin on the cached count with no request at all.
- The one press preset turns the filters on with a bar of **25 holders**, and the bar travels with the shareable
  settings code.

### Speed: waits overlap instead of adding up

- **An entry now builds its order while the pool price is still being read.** The trade door build and the bonding
  curve read start at the same moment; the build waits behind a gate, and a coin the desk refuses is discarded signed
  but never broadcast - the wire is the only place money can leave. That is one network round trip saved on every
  entry, and the refusal (the `Price dropped X% while the coin was being judged` gate) stays exactly as strict.
- **An urgent exit asks both doors at once, every time.** The two-door race used to be reserved for a spike far above
  the target; now every full exit races the primary route and the backup route and the first signed transaction wins.
  Measured before, a refused stop cost 1.2 s of re-quoting while the coin fell - with both doors in the air a stalled
  primary cannot hold a stop any more. The tolerance is still the exit's own: tight 15% while the coin is up, wide
  while it is under water.
- **The slot is reserved before any network wait.** Two coins passing at the same moment could previously both enter
  because the position was only written to the book after the price read; the allowed number of coins is now a promise
  the desk keeps from the first millisecond of an entry.
- **The curve is read at `processed`, the freshest state a node serves.** A price read at `confirmed` is a slot or two
  older than the pool really is; a fork rollback self-corrects on the next 120 ms poll, and the constant-product guard
  still refuses any account that is not a launch curve.
- **A buy no longer waits for the balance read before asking the chain.** The confirm loop and the wallet refresh run
  at once on every entry; neither answer depends on the other.

### A settings code can no longer hand you a broken plan

- **A pasted settings code goes through the same validation as a typed number** (`cleanSettings` in `main.js`). It used
  to be written straight to the store, so the money keys were only clamped on the path a person types into: a stranger's
  code could carry a **5 SOL priority fee on every transaction**, a 900-coin position limit, or a negative stop (which
  turns a stop into a target). No setting may be negative, `sessionLossLimitSol` is now clamped too, and
  `maxHoldSec` cannot be set to 0 - which does not turn the time limit off, it sells every coin the moment it is bought.
- **Codes shared before a setting existed keep working**: the payload is a positional list and new settings are only
  appended, so a shorter list is an older code rather than a damaged one. Every code already posted on X still applies.
- **A closed trade records why the coin was taken** - its score, buyer count and the five-minute picture - beside
  what it did.

### The entry was blind, and that is where the win rate went

- **An entry is now priced at the bonding curve, right now** (`_entryPrice`), in both modes. The board price - what
  every entry rule was judged on - can be a minute old: a scanned coin's row is refreshed in tens of seconds, an
  exchange that is rate limiting answers with an older row than the moment it arrived, and a launch can give back half
  its move in that time. Measured in paper against the live market, entries booked at the board's price showed **-18%
  to -31% on the very first pool reading**, which booked a stop loss **0 to 16 seconds** after the buy on a coin that
  had not fallen that far since the order. The exit rules were not late; the entry was blind. The pool is the number
  the order fills against, so it is the number the position is opened at.
- **A coin whose pool sits more than 8% below the board is not bought** (`BOARD_STALE_FRAC`). That gap means the coin
  is falling right now while the row we judged says it is rising, which is the shape of nearly every losing entry.
  The coin stays on the list with the reason (`Price dropped 34% while the coin was being judged`).
- **A coin running away from a slow row is still bought**, at the pool's price, because that is what it would cost;
  and a pool that is three times the board is treated as a foreign account rather than as a price.
- **No pool to read (a graduated coin, a node that will not answer in 700 ms)**: the board price is used only while
  the coin has been heard about in the last 30 seconds. A row nobody has refreshed is not a price.
- **A FINISHED curve is a fossil, and it is not read as a price.** When a coin graduates, its bonding curve stops
  moving at the graduation figure, so the "curve price" of a graduated coin stays at ~84 SOL for ever while the coin
  trades on PumpSwap at whatever its pool there says. Measured in a paper run on the live market, two coins were
  entered at the fossil and then "ran" **+264% and +308% within a second** - a phantom win of 0.05-0.06 SOL that never
  existed. `readCurveAccount` reported `complete` and nothing looked at it; the entry, the position poll and the price
  panel now all ignore a completed curve, and a graduated coin is priced by its market.
- **A price that jumps UP more than three times in one 120 ms reading has to be seen twice** before it moves a
  position; a fall is taken at once, because a stop must fire on the first reading. Two numbers from two sources are
  not a market move, and a phantom print must never be able to sell anything.

### The exit shape: a winner has to be allowed to be big

- **Seventy percent of the position is banked at the first rung** (+18% net) instead of forty at +22%. Measured over
  several paper sessions on the live market, a coin that reaches +20% comes back more often than it runs: a forty
  percent rung left most of the ticket exposed, and one measured coin **peaked at +84% and closed at -9%** because the
  bid vanished inside a single 120 ms reading. The rung is the win; the 30% that stays is the bonus, trailed by a share
  of its own peak.

- **The trailing stop now gives back a share of the peak, not a fixed number of points** (`_trailGive`): the room a
  runner gets is `max(trailGivePct, 45% of its own peak)`. The old rule gave back a flat 4 points and *tightened* to 5
  after the first rung and to 2 once the move passed three times the target - the exact opposite of what a runner
  needs. Measured in paper against the live market, every profit rule in a session closed between **+6% and +12%**
  while the losses filled at **-21% to -33%**. That is a desk whose winners cannot pay for its losers, and no entry
  rule can rescue it. A coin up 100% wobbles 15-20 points without changing trend.
- **The preset's exit shape was rewritten for that arithmetic**: 70% banked at +18%, the rest a runner closed by the
  proportional trail (arm +12%, floor 8 points) or a +130% moon target, stop 9%, hold 240 s.
- **The entry ceiling came down: skip a coin already up 35% in five minutes** (was 120%, briefly 60%). Four entries
  measured in paper under the old ceiling were all bought near their top and every one of them stopped out; the bars
  are now score 68 and eight buyers, not 64 and six.
- **A closed trade keeps what it was worth at best**: the row carries `heldSec`, `peakPct` (the best net move while
  it was held), `firedPct` (the move that fired the rule) and the price source, and the window prints
  `peaked +41% · held 2m` beside the fill. A trade that peaked at +41% and filled at +8% is an exit that was too
  early, and that fact must not disappear with the position.
- **The styles follow the same shape** - take profit 60/90/150%, first rung 18-30% for 30-50%, stop 6/9/12%, trail
  arms 14/18/22% with floors of 8/12/15 points, hold 150/200/300 s.

### The percentages are net, and the plan follows them

- **Every rule is now measured net of the whole round trip** (`_costPct`): the protocol's 1% each way plus both
  priority tips. On a 0.004 SOL ticket that fixed part is about **13%**, so a take profit at a gross +12% was booked
  at roughly +5%, and a break-even order - armed "after a peak of 6%" - sold the coin at the cost of doing business.
  This is the root cause of the sale that read `Take profit, -5.2%`: the rule that fired was right, the number it
  fired on was gross. A percentage in the window is now the money the trade really made, and a rule fires only when
  the ticket is really that far up or down.
- **No style carries a break-even rule any more** (`breakEvenPct: 0` everywhere). At a net zero the trade has paid
  its costs and earned nothing, the fill lands under the reading that triggered it, and the rule pre-empts the
  trailing stop, which sells at arm minus give - above water by construction. A rule that sells winners early and
  books a small loss is worse than no rule.
- **The styles were rewritten around that cost**: take profit 18-45%, first rung 10-15% for half the position, stop
  7-15%, trail arms 6-12% and gives back 3-6%, hold 60-100 s. The exit ranges working snipers converge on, expressed
  in net numbers.
- **The one press preset is a patient one-slot desk** (the final numbers are in the exit-shape section above and in
  `docs/SETTINGS.md`): score 68+, eight buyers, +2 SOL net buying, pool 2000 USD+, the 4-35% five-minute band,
  70% banked at +18%, the rest to +130% or the proportional trail, stop 9%, hold 240 s, ten buys a minute, an
  eight-minute rest after five losses.
- **The session cap follows the ticket instead of being a fixed number.** A flat 0.35 SOL was eighty-seven trades at
  a 0.004 SOL ticket - a countdown, not a limit. The preset now writes **eight tickets** (clamped to 0.01-0.35 SOL),
  and a ticket bigger than a third of the cap is lowered to that third.

### Speed, and never selling a winner at a loss

- **The coins being held are priced at the bonding curve.** The trade stream (the same number the buy was priced
  at) sets the price; an aggregator quote is only the fallback while the stream is quiet. Measured live, an
  aggregator quote on a fresh coin moved **+135% to -70% within a second**, because our own sale is a large share of a
  pool that small - a take profit at +30% could be followed by a "fill" at -5%. The price is frozen while an exit is
  in flight, and a quote that jumps more than 40% in one tick is not believed.
- **A signal has to hold before the bot sells** (`triggerHoldMs`, 400 ms by default). A take profit or a stop must be
  seen again after that, on a fresh price. A spike that is gone in one tick is not a signal. The creator selling and
  the time limit act at once, because they are not price thresholds.
- **A winner is never closed at a loss.** If a take profit has slipped back to break-even before the order goes out,
  the sale is abandoned and the next tick decides.
- **An exit no longer waits ten seconds on an order that never landed**: its confirmation budget is 2.5 seconds, then
  it is retried. An urgent exit is never tighter than 20% tolerance and a runner far above its target gets 40% and
  both execution doors at once, because taking a worse price on the first order beats a second round trip.
- Positions are polled every 150 ms, the decision loop runs every 50 ms, the window repaints every 400 ms, and a
  signed transaction goes to three RPC nodes at once. Measured on chain: buys land **168 ms** after the decision,
  sells **163-419 ms**.
- **The open positions have a channel of their own.** They are pushed whenever a price moved - twenty times a second
  at most - and the panel patches the number in place instead of rebuilding itself, so the percentages follow the
  market and the Sell buttons are never thrown away under the pointer. Waiting for the whole window made a live
  position look frozen for up to 400 ms.
- **Nothing in the network sits in front of a decision.** A trade on a held coin prices it the moment it arrives, and
  the poll that closes a position now reads the curve before it asks any quote. It used to await a quote request
  first, so a move the stream had already delivered was acted on hundreds of milliseconds late. A quote is also only
  asked for a coin whose curve has gone quiet - the request itself was spending the rate limit the whole app shares.
- **Every sale line names the rule, the move that fired it and the move that filled** when the two differ:
  `Sold UNICORN (Take profit at +70.1%, filled at -5.2%)`.

### Money, shown honestly

- **Profit / Loss is the wallet.** In Real Money mode the figure is what the wallet really did since Start - every
  transaction, every tip, every rejected order - plus the coins it still holds at the price they trade at. The fees
  paid are printed under it (`fees 0.0020 SOL`, and how many orders were refused). A book that adds up trades can
  never show a tip that bought nothing.
- **The P&L of a sale comes from the transaction itself** (`meta.preBalances`/`postBalances`). Reading the wallet
  twice was wrong: two RPC nodes sit at different blocks, so the difference carried the previous trade and a real
  profit was reported as a loss of the whole ticket.
- **Two accounting bugs are gone**: rent returned by a closing transaction was counted as profit, and a partial sale
  charged the entry tip twice (a remainder sold at +14% was booked as a small loss).
- **A holding the book never bought is never given a made-up cost.** A coin found in the wallet used to be booked at
  the ticket size with an entry price of 1 when no price was known - which invented an entry nobody paid, a loss the
  moment it sold, and an instant "take profit at +3900%". The exchange rate is now fetched before anything is valued;
  a holding with a price is booked at its own market value, and one with no price anywhere is sold as a leftover
  instead of being called a position. A position with no reference price reads as 0% until its first real price, and
  that price becomes the reference.
- **The rent of a sale can no longer be counted twice or lost in a race.** Whether the token account was closed by
  the sale is now returned with the balance read itself, instead of a field another balance read could overwrite
  between the answer and its use.
### Sending, and landing in a crowded slot

- **Jito bundles, optional and off by default.** Every signed trade is also offered to Jito's block engine as a
  bundle - the trade plus one tip transfer - while the same bytes still go to the normal RPC doors. A bundle lands
  whole or not at all, so the tip is paid **only when the trade with it lands**; a lost auction costs nothing, and
  the fee counter never claims a tip that was not paid. The tip is a setting (0.0001 SOL by default), raised to the
  block engine's own floor if it is typed lower, and the tip transaction is checked instruction by instruction before
  it is signed. The client, the lane and the guards are covered by a tenth test suite.
- **The fee line counts the tips the wallet really paid.** A swap through the backup route pays no priority fee of
  ours - it takes its cut inside the fill - so charging the tip to the counter made the fee total a number that could
  not be reconciled with the wallet.
- **A number that could not be read is drawn as a dash, not as zero.** A balance the RPC did not answer used to
  appear as `0.0000 SOL`, which reads as an emptied wallet, and an unknown profit as `+0.000`.
- **The bot can no longer spend its own exit fees.** A reserve - the rent-exempt floor plus a fee and a tip for every
  open position - is never spent on an entry, an order in flight is counted against the wallet, and a withdrawal may
  not take it. Measured live: the wallet once sat at 0.00066 SOL with coins that no longer had a way out.

### Selling everything, and getting the rent back

- **Every sale ends with the coin's account closed and its rent returned.** The trade door keeps a cut of the tokens,
  so even a 100% sell leaves a remainder that holds ~0.00204 SOL of rent. The remainder goes out through the trade
  door first (the backup route has no quote for an amount that small - that is why leftovers sat in the wallet for
  ever), and only a leftover worth less than its own rent is burned so the account can be closed. Verified on chain:
  **0 token accounts left, 0.00799 SOL back in the wallet**.
- **The Sell buttons answer.** A press of Sell and of Sell all used to fire the trade in the background and return
  nothing, so with no SOL for the fee the button looked dead. Both now wait and say what happened, in plain words.
- **Sell all pauses new entries for two minutes**: the press is an instruction about the market, not only about the
  coins.
- **Recent trades can no longer disappear**: rows are built before the panel is swapped, so one bad value cannot
  leave an empty box that never re-renders.

### The whole market, and a plan that was measured

- **Ten discovery doors**, including the DexScreener search board (its query walks the words memecoin symbols are
  made of) and GeckoTerminal's newest pools. 150-220 coins tracked in a normal session, with a switch
  (**Every coin source**) to watch the launch feeds only.
- **A coin that is falling right now is never bought**, and a coin that is dumping hard is refused outright.
- **A plan that had been measured, not guessed.** Three plans ran side by side against the live market in paper mode
  on one slot: banking 60% at +15% and letting the rest run to +30% gave **44% wins and a positive result** where a
  single 45% target with an 18% stop gave **0% wins**. That shape - bank part early, let the rest run - is what the
  styles still carry; the numbers themselves were superseded by the net plan above, where the same rung is 50% at
  +12% and the target is +28%, because a gross +15% was only worth about +7% after the round trip.

### Share your settings

- **A code for X.** Settings has a **Share your settings** card: it writes a code of about 165 characters
  (`PCS1.…`) carrying the entry bar, the whole exit plan, the size and pace, and the cost ceilings. Another field
  takes someone else's code and applies it, and one button opens X with the line and the code filled in.
- **What a code can never carry**: no API keys, no RPC URL (a stranger's endpoint would see every transaction), no
  wallet, no mode, no open positions. The payload is a version, a profile name and a list of numbers, and a test
  asserts exactly that.
- **Damage is refused, not half applied**: a two-character checksum catches a mistyped or truncated code, and the
  ticket stays at the user's own value unless the code's is smaller.

### Fixed

- **Every refused sell skipped its rescue.** The re-quote path in `_sell` referenced an undeclared `s`, so a
  `6002`/`6005` on an exit threw `s is not defined` and the backup route was never asked. Found live and now covered
  by a test that asserts the sell ladder.
- **The same coin could be bought twice while its exit was landing.** The one-entry-per-coin and cooldown checks lived
  only in the decision path; both are checked again inside the buy now.
- **A leftover was booked as a position.** Adoption priced every token account at the ticket size, so dust entered
  the books as a full position, invented profit and was sold over and over. A holding is valued first now.
- **A refused exit is re-quoted at the exit's own tolerance**, not at the entry ceiling.
- **The guards around foreign transactions are stricter**: a burn is only signed for the token that was selected, and
  a `CreateAccount` that funds a new account counts against the SOL ceiling like a plain transfer does.
- **Public RPC reality**: the pool is the five hosts that answered a funded wallet, a host that refuses a full
  token-account listing is remembered instead of retried, market data is paced so three pollers cannot trip a rate
  limit, and a chain refusal reads as a sentence (`the price moved before the order landed`) instead of raw JSON.
  `6063` - a coin quoted in another token - retires the coin instead of paying for it again.
- **The price service has its own budget.** A rate limit on Jupiter's token index used to bench the price service with
  it, so a coin being held could lose its quote for eight seconds for a reason that had nothing to do with prices.
- **The DexScreener budget is spent by everything that talks to it**, not only by the slow sweep: a burst of
  discovery followed by three price calls was tripping a 429 that then benched the host. An exit never depends on
  that host, so nothing urgent is held back by it.
- **The settings file is written atomically, and damage is reported.** It used to be rewritten in place, so a crash,
  a full disk or a sync client could leave it half-written - and the app then read that as a first run and carried on
  with the defaults: a different ticket, a different plan, and a book of open positions that no longer existed. It is
  now written beside the real file and renamed over it like the wallet, a damaged file is kept as
  `settings.json.broken`, and the log says what happened before anybody presses Start.
- **One token programme refusing a scan no longer throws the scan away.** A host that does not index Token-2022 used
  to cost the wallet the rent of every account it could still close; only two failures together are a failure now.
- **Two coins closing in the same second both get their rent back.** The settle that sells the leftover and closes the
  account was guarded by a single flag and simply returned when another one was running, so on a sell-all only the
  first coin left the wallet clean and every other leftover stayed behind with its ~0.00204 SOL. Each settle now waits
  in a queue, and an account close that arrives while a cleanup is in flight waits for it instead of throwing the rent
  away.
- **The Jupiter API key setting is gone**: the route and the price service need no key, so the field was an option
  that changed nothing.

## Pre-release development

Notes written while the build that became [1.0.0] was in progress. The release itself is documented at
the top; where an early note below says something the release changed, the top wins.

### Trading

- Market scanner with seven discovery sources: newest tokens on the market, trending, top traded, boosted,
  fresh profiles, every pump-fun pool and the trending pools on GeckoTerminal. New launches are polled on
  every cycle because that list only spans about a minute.
- Two speed pricing. Open positions and the best candidates refresh about once a second, the whole token
  table every three.
- Score from 0 to 100 per coin, with the reason it was refused written next to it.
- Entries gated by market cap band, buyers, net flow, price movement, creator behaviour, pool depth,
  wallet concentration and token flags.
- Exits: take profit, trailing stop after the coin runs, stop loss, creator sold, time limit, and an
  optional first partial take profit that sells part of the position and lets the rest run.
- An optional break even rule that was later turned off everywhere before the release: at a net zero the
  rule sells at the round trip's own cost, and the trailing stop protects a winner better.
- Smart fees follow the live fee market and widen slippage when an exit must land.
- A refused order is answered by the backup route, not by the same door again. Measured on chain, the
  chain refuses a fresh buy with `6002` when the price ran between the quote and the landing, and the
  backup route quotes fresh and puts the tolerance on the tokens, so the ticket stands.
- A coin whose curve is quoted in another token is retired after one attempt. `6063` is
  `UnsupportedQuoteMint`, read off the program log of simulated orders: nothing on that curve can fill a
  SOL order, so a second attempt would only spend time.
- A coin that finished its curve mid order is marked graduated and followed to the new pool, or left
  alone when graduated coins are switched off. Both are remembered, so neither is asked twice.
- Pause after a losing streak, session loss limit, buys per minute cap, positions cap. The pause names the
  streak that caused it and lasts minutes, not a quarter of an hour.
- Practice Mode with the same rules and a fees aware fill model.

### Speed to the first trade

Measured on the live market with the default settings: the first coin is bought **4 to 10 seconds** after
Start, and three to eight entries are made in the first minute. Getting there needed three things:

- Coins found by the market scan are judged on a five minute window, so their buyer bar is scaled to that
  window instead of demanding a stream sized crowd. Measured before the change: 28 of 60 coins were
  refused on the buyer count alone.
- The score bar and the market cap band in the Balanced style, which is what a fresh install runs, are
  set for a coin that is still moving rather than for a coin that already proved itself.
- The watch time before an entry and the losing streak pause are short: two seconds and three minutes.

### Safety

- A position is open from the moment it is broadcast, so its stop, target and time limit work while the
  chain is still confirming the entry.
- Confirmation separates a rejection from a missing answer. Only an order the chain actually rejected is
  treated as "never landed", so a busy RPC can never buy the same coin twice.
- An open position follows the market board when the trade stream for its coin goes quiet, anchored at
  the last stream price, so a graduated coin can still hit its stop.
- Real positions are written to disk on every change and restored when the bot starts again, checked
  against the wallet: coins that are there are adopted, coins that are not are dropped.
- Every sale is booked from the wallet balance, not from the request. A fill that sells half of what was
  asked leaves the other half as a position and books exactly what left.
- A position the RPC could not vouch for, and which the wallet then proves never existed, is dropped
  instead of being booked as a sale, so the real result never carries a trade that did not happen.
- Every transaction built by a third party is inspected before it is signed: the Sol Incinerator route
  may only close our own empty accounts or burn the selected token, and the Jupiter route may not
  approve, change an authority or move more SOL than the ticket.
- A withdrawal is signed once and confirmed by signature, so a node failure cannot pay it twice.
- The wallet cannot be locked, replaced, removed or drained while positions are open, and the mode cannot
  be switched while the bot runs. Closing the window with real positions open asks first.
- A damaged wallet file is reported as damage, not as an empty slot, and is never overwritten by accident.

### Data and plumbing

- Works with no API keys. PumpDev is optional and only makes prices faster. The Jupiter swap route is
  keyless as well, so the backup door works on a fresh install.
- RPC pool with health scoring, cooling down and rotation on refusal. Every call carries a total budget,
  and a transaction broadcast gets a short one, so a slow node cannot hold an exit while the price moves.
  The public nodes in the pool were measured against a funded wallet, and the four that answered a paid
  plan or nothing at all were removed.
- On chain Pump.fun decoder as an alternative feed with a private RPC.
- Subscription budget, so a free trade stream plan is never exceeded: twenty coins batched into one
  subscribe and one unsubscribe per cycle.
- Market cap in SOL read from the native price, so the dollar price of SOL is never needed.

### Wallet

- Encrypted wallet with AES-256-GCM and a scrypt derived key.
- Create, import, unlock, lock, export with a password, withdraw.
- Every trade transaction is inspected before signing. Unexpected SOL transfers are refused.

### Recovery

- Automatic close of empty token accounts after a sell, about 0.00204 SOL each.
- Sol Incinerator integration for leftovers, optional.
- Wallet scan that shows what can be recovered before anything is touched.

### Interface

- One window, six tabs, no page reloads.
- One press preset that applies a tuned set of numbers for a small wallet.
- Practice and real money keep separate statistics, each resettable on its own.
- Live coverage line: how many launches arrived this minute, how many coins came from each door, how many
  are priced and how many are live.
- Every settings change re-renders the whole settings view, so the quick chips and the advanced form can
  never disagree.
- Custom ticket size from 0.001 to 1 SOL with one click, hard capped at 5 SOL in the engine.
- Wallet maintenance: create a new wallet or remove this one, both behind the password and both blocked
  while the bot is trading.

### Safety fixes in this release

- A buy whose transaction may already be on chain is never re-sent through the backup route, which used to
  risk buying the same coin twice.
- Slippage is a real ceiling for every order, exits included.
- A coin that fell hard over five minutes is refused even when a fresh trade makes it tick up.
- A market dominated by sellers is refused.
- The Start button waits for the settings to load, so an early press cannot be swallowed.
- A failing on chain feed reports once a minute instead of ten times a second.

### Data corrections in this release

- Jupiter reports `stats5m.priceChange` as a percentage, and the scanner was multiplying it by a hundred a
  second time. A coin down half a percent read as a fifty percent dump, so Jupiter-sourced coins were
  refused as "Dumping hard" while a real mover looked a hundred times stronger than it was.
- The two safety flags the scanner read from Jupiter (`isSus` and a top-level `freezeAuthority`) are not in
  the response at all, so the "flagged risky" and "can be frozen" rules could never fire. They now read the
  audit block the API really publishes, and a new `maxDevHoldPct` rule refuses a creator who still holds a
  third of the supply.
- A pair with an empty five minute bucket inherited the hour's trade counts, which made a pool that had
  stopped trading look like it was being bought.
- The reason shown next to a scanned coin said "buys" and compared a count of wallets. It says buyers, which
  is what the number is.
- Removing the wallet used to pull the full private key into the window just to check the password. The
  check now runs in the main process and the key never leaves it.
- The rent recovery path had no time budget on its RPC calls, so one slow node could hold the cleanup for a
  minute. It now has the same budgets as the trade path.
- A retired setting is dropped from the settings file on start instead of being carried forever.
- The exit that fired is reported in the order the money cares about. A coin that gapped from +12% to -31%
  in one tick used to be logged as "Break even" while it had actually blown through the stop; the stop is
  now checked first, so the card and the log describe what happened.
