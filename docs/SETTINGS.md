# Settings reference

Every setting lives in `settings.json` in the app data folder and is editable in the app. Values are
validated on save, so a typo cannot turn into a ruinous number.

App data folders:

- Windows: `%APPDATA%\PillCrew Sniper`
- macOS: `~/Library/Application Support/PillCrew Sniper`
- Linux: `~/.config/PillCrew Sniper`

## Styles

A style sets a whole plan at once. Choosing a style overwrites the current values.

Every percentage in this table is **net of everything the trade costs** - the 3% protocol fee on both sides
plus both priority tips, which at a 0.004 SOL ticket is about 13% of the ticket and at 0.02 SOL about 5%.
That is the number the cards show and the number the rules act on, so "+12%" means the trade is really 12%
ahead, not 12% before it paid for itself. See [Why the percentages are net](#why-the-percentages-are-net).

| Setting | Safe | Balanced | Aggressive |
| --- | --- | --- | --- |
| Minimum score | 70 | 64 | 50 |
| Buyers needed (20 second window) | 6 | 6 | 4 |
| Net buying needed (SOL) | 2 | 1.5 | 0.8 |
| Market cap band (SOL) | 20 to 80 | 20 to 150 | 15 to 250 |
| Take profit (%) | 60 | 90 | 150 |
| First take profit (%) / how much | 18 / 50 | 22 / 40 | 30 / 30 |
| Stop loss (%) | 6 | 9 | 12 |
| Max hold (seconds) | 150 | 200 | 300 |
| Trailing stop arms at / gives back (%) | 14 / 8 | 18 / 12 | 22 / 15 |
| Break even after a peak of (%) | off | off | off |
| Slippage ceiling (%) | 8 | 10 | 15 |
| Priority fee ceiling (SOL) | 0.0002 | 0.0002 | 0.0006 |

No style carries a break-even rule any more, and that is a correction rather than a simplification. At a net
zero the trade has paid its costs and earned nothing, the fill lands under the reading that triggered it, and
the rule pre-empts the trailing stop, which sells at arm minus give - above water by construction. It also
fought the rule that protects a winner: three plans were run side by side against the live market in paper
mode, and banking part of the position at the first real move gave **44% wins and a positive result** over
seven minutes, where a single distant target with a wide stop gave **0% wins** and a loss over the same
period. Most winners on this market are given back before a distant target is reached.

**The trail gives back a share of the peak, not a fixed number of points.** The number in the table is the
floor: the room a runner gets is `max(trailGivePct, 45% of its own peak)`. Measured in paper with a fixed
give-back (4 points, tightened to 5 after the first rung and to 2 once the move passed three times the
target), every profit rule in the session closed between +6% and +12% while the losses filled at -21% to
-33% - a desk that cannot pay for its own losers, whatever the entry rule does. A coin up 100% wobbles by 15
to 20 points without changing trend, and a flat trail sells it at the first wobble. The floor still protects
a small peak tightly.

## Why the percentages are net

A pump.fun trade costs 1% each way, plus a priority tip on each transaction, plus the pool rent that comes
back when the account is closed. At a 0.004 SOL ticket the fixed part dominates: two tips at 0.0002 SOL are
10% of the ticket on their own. A rule written in gross percentages hides that - a "break even at +6%"
gross is a booked loss once the round trip is paid for, and a take profit that reads +12% before fees is
really +5%. `_costPct` is the fix: the engine subtracts the whole cost from every move before any rule looks
at it, so a stop loss at 10% fires only when the ticket is really 10% down, and a take profit at +12% books a
real 12%.

Coins found by the market scan get a wider market cap ceiling (four times the style value) because they
are already a few minutes old when they are first seen. The entry size and the stop limit the risk, not
the cap.

The slippage ceiling is the promise for **entries**. An urgent exit (stop loss, trailing stop, creator sold,
time limit, manual sell) is never tighter than **20%** and never wider than **40%**, whatever the ceiling
says: measured on chain, a stop refused for tolerance instead of filling cost 1.2 s of re-quoting while the
coin fell, and one more order is always worse than a lower price. The one exception is a runner far above
its target (twice the take profit): there the tolerance is cut to **15%**, because a wide tolerance does not
raise the fill, it removes the floor - measured live, a coin that peaked at +70% was given 40% and filled at
-5%, while the same coin given 15% either filled near the level or was refused and sold by the trailing
stop. A take profit is not urgent: it uses the ceiling, because that order is the one that is worth waiting
a moment for.

## One press preset

The Settings screen has a single button that applies a tuned set of numbers. It is meant for a small wallet
on a busy chain, and every value it writes can still be edited by hand afterwards. It is a one-slot,
patient desk on purpose: a small wallet pays most of its costs in fixed tips, so it trades less, banks a
part of a winner early, and lets the rest run.

| Key | Value | Why |
| --- | --- | --- |
| `minScore` | 68 | Strong enough to act on, not so strong that nothing passes |
| `minBuyers` | 8 | Eight wallets in the window, or sixteen buys over five minutes for a scanned coin |
| `minNetFlowSol` | 2 | Demand has to beat supply by a real amount, not by noise |
| `minMcSol` / `maxMcSol` | 20 / 150 | The band where a small ticket still moves |
| `minLiqUsd` | 2000 | A pool that can absorb an exit without gapping |
| `maxChange5mPct` | 35 | Skip a coin already up 35% in five minutes: that is somebody else's exit. Measured in paper, entries bought under the old ceiling of 120% were all bought near their top and every one of them stopped out |
| `minChange5mPct` | 4 | The floor of the same band: a launch that has not moved yet is where a move starts. A coin only 2% up with real demand is early; a coin 60% up is late |
| `deepEntry` | on | The extra entry filters switch. While on, the holder bar below is enforced and a coin whose holder count cannot be read is skipped too - a filter that silently passes when its data source is down is not a filter |
| `minHolders` | 25 | A coin needs this many holders to be bought. Distribution is the slow signal that separates a coin people are in from a coin only its creator is in |
| `maxDevHoldPct` / `maxDevBuySol` | 30 / 3 | No coin where the creator kept a third of the supply |
| `tp1Pct` / `tp1SellPct` | 18 / 70 | Bank 70% at the first real move. Measured over several sessions, a coin that reaches +20% comes back more often than it runs, and a smaller first rung cannot pay for a ten-point loss |
| `takeProfitPct` | 130 | Only a moon shot is closed on a fixed target; everything else is closed by the trail |
| `trailArmPct` / `trailGivePct` | 12 / 8 | The peak starts being tracked at +12%, and the runner is trailed by **45% of its own peak**, with 8 points as the floor |
| `breakEvenPct` | 0 | Off. It would sell at the cost of the trade, which is a booked loss |
| `stopLossPct` | 9 | Tight enough that a losing ticket costs one ticket, not two |
| `maxHoldSec` | 240 | A runner needs minutes, not seconds; a coin that does nothing still leaves on the trail or the stop |
| `triggerHoldMs` | 400 | A take profit has to hold this long before it sells: a spike that is gone in one tick is not a signal. Stops and trails do not wait for it (see below) |
| `slippagePct` | 12 | A ceiling that still lands on a busy chain |
| `priorityFeeSol` | 0.0002 | The cheapest tip that is not ignored |
| `maxPositions` | 1 | One slot: every ticket gets the whole attention and the fees stay predictable |
| `maxBuysPerMin` | 10 | Ten entries a minute is already faster than the plan can close them |
| `watchSec` / `entryWindowSec` | 3 / 45 | Watch briefly, then treat a coin as trending rather than new |
| `maxLossStreak` / `pauseMinutes` | 5 / 8 | A cold streak is the market telling you something; sit it out |
| `sessionLossLimitSol` | 8 tickets | Not a fixed number: the cap is eight tickets, clamped to 0.01-0.35 SOL |

The ticket size and the mode are never raised by the preset. A ticket larger than a third of the session
cap is lowered to that third, because a ticket that size turns the cap into a one-trade stop. The session
cap itself is rewritten as **eight tickets** (0.032 SOL at a 0.004 SOL ticket, 0.16 at 0.02): the old fixed
0.35 SOL was eighty-seven trades at the bottom of the range, which is not a limit, it is a countdown.

## Statistics

Practice money and real money keep separate books. Profit and loss, win rate and closed trades are
counted per book, and each can be reset on its own in Settings. Resetting clears the numbers and the
closed trades of that book; open positions are left alone and nothing on chain is touched.

## Trading

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `mode` | `paper` | `paper`, `live` | Practice or real money. Cannot change while the bot runs |
| `buyAmountSol` | 0.02 | 0.001 to 5 | SOL per entry, hard capped at 5 |
| `maxPositions` | 4 | 1 to 50 | Open positions at once |
| `maxBuysPerMin` | 20 | any number | Speed cap. Any value you type is accepted |
| `watchSec` | 2 | any number | How long a coin is watched before it may be bought |
| `entryWindowSec` | 40 | any number | Age after which a coin counts as trending rather than new |
| `trendMode` | on | | Allow entries on coins that did not launch while the bot was running |
| `sessionLossLimitSol` | 0.35 | any number | The bot stops itself at this session loss |
| `maxLossStreak` | 4 | any number | Losses in a row before a pause |
| `pauseMinutes` | 5 | any number | Length of the pause. Open positions still close |

Only five numbers are clamped by the app: the ticket (0.001 to 5 SOL), the number of positions (1 to 50),
the slippage ceiling (1 to 90%), the priority fee (0.000001 to 0.05 SOL) and the Jito tip (0.000001 to 0.01
SOL), because those are the values that can empty a wallet. Everything else takes whatever you type.

## Exits

| Key | Meaning |
| --- | --- |
| `takeProfitPct` | Sell when the gain reaches this |
| `tp1Pct` | Sell part of the position when the gain reaches this. Zero turns the rung off |
| `tp1SellPct` | How much of the position leaves at that rung |
| `stopLossPct` | Sell when the loss reaches this |
| `trailArmPct` | Once the gain reaches this, the peak starts being tracked |
| `trailGivePct` | Sell when the price falls this far from the tracked peak |
| `breakEvenPct` | Off by default. Once the gain has reached this at any point, sell when it falls back to zero. Zero turns the rule off, and every style leaves it off: at a net zero the trade has paid its costs and earned nothing, the fill lands under the reading that triggered it, and the rule pre-empts the trailing stop, which sells above water |
| `maxHoldSec` | Sell when the position is older than this |
| `triggerHoldMs` | How long a take profit or a stop has to hold, on fresh prices, before it sells. The safeguard: a spike that is gone in one tick is not a signal. 400 is a blink; 0 acts on the first reading |

Order of checks, first match wins: creator sold, take profit, first rung, stop loss, trailing stop, break
even, time limit. Only the creator selling and the time limit act on the first reading; every price rule
has to hold for `triggerHoldMs`. Take profit, the first rung, the stop and the trail are measured on the net
move, which is the number the cards show. The stop with a 20% setting therefore fires when the ticket is
really 20% down, which at a small ticket's round trip is a price about 29% below the buy; a 12% target books
12%, not the 5% a gross reading would have booked.

The price a position is measured at comes from the bonding curve (the trade stream, the same number the
buy was priced at) while the stream is alive, and from a quote only while it is quiet. A quote that jumps
more than 40% in one tick is not believed, and the price is frozen as soon as an exit is in flight: our own
sale moves a thin pool enough to invent a crash.

The stop is checked before the rules that protect a profit, because a coin can gap straight through them.
A position that was up 12% and then fell 31% in one tick is reported as a stop loss, which is what
happened to the money, not as a break even.

## Simple settings

Quick setup has a **Simple settings** switch. While it is on, the settings form shows only the basic
numbers, and only those numbers decide:

| Key | Meaning |
| --- | --- |
| `minMcSol` / `maxMcSol` | The market cap band the coin must sit in |
| `minBuyers` | The buyer floor: fewer distinct wallets than this, no buy |
| `maxBuyers` | The buyer ceiling: more wallets than this, no buy. `0` is off |
| `buyAmountSol` | The ticket per coin |
| `maxPositions` | How many coins may be open at once |
| `slippagePct` | How far the price may move while the order is in flight |
| `takeProfitPct` | Sell when the gain reaches this |
| `stopLossPct` | Sell when the loss reaches this |
| `maxHoldSec` | Sell if nothing happened by then |

Every advanced rule is off while the mode is on: the score bar, the net flow, the depth, the creator
bags, the five minute band, the holder bar, the first rung, the trail and the break even. The safety
protections never turn off in either mode - a coin whose creator sold is not bought, a graduated coin is
not bought, and a position still has to close.

The numbers the mode hides stay in the store untouched: switching back restores the full desk exactly as
it was.

## Market and data

| Key | Default | Meaning |
| --- | --- | --- |
| `marketScan` | on | Run the rotating discovery doors |
| `feedSource` | `auto` | `auto`, `pumpdev`, `chain`, `pumpportal` |
| `smartFees` | on | Follow the live fee market, style values become ceilings |
| `maxDevBuySol` | 3 | Skip coins where the creator bought more than this at launch |
| `maxDevHoldPct` | 35 | Skip coins where the creator still holds this share of the supply, read from the token audit. `0` turns it off |
| `maxTraderSharePct` | 45 | Skip coins where one wallet is this share of recent buying |
| `maxChange5mPct` | off | Skip a coin that is already up more than this over five minutes. Buying a coin that has run is buying somebody else's exit. The one press preset turns it on at 35 |
| `minChange5mPct` | off | The floor of the same band: skip a coin that has barely moved in five minutes. The preset asks for 4%, so a launch is joined while it is starting rather than after it has run |
| `deepEntry` | off | The extra entry filters switch: a minimum number of holders and the market cap band, in one panel below the number form. While on, a coin under the holder bar is skipped, and so is a coin whose holder count cannot be read |
| `minHolders` | 0 | The holder bar. Read from the live market at the moment of buying, cached for ten minutes |
| `simpleMode` | off | Simple settings: only the basic numbers decide (see below), and every advanced rule is off |
| `maxBuyers` | 0 | The buyer ceiling. A coin with more recent buyers than this is skipped, because past it the crowd is already in and a small ticket is buying their exit. `0` turns it off |
| `minLiqUsd` | 1500 | Skip a coin whose pool is smaller than this in USD. `0` turns it off |

`auto` picks the best door available: PumpDev when a key is set, the on chain feed when a private RPC
is set, PumpPortal otherwise. All three work. The trade stream only changes how fast prices move.

## Integrations

| Key | Meaning |
| --- | --- |
| `pumpdevKey` | Free key from pumpdev.io. Live trade stream, up to 25 coins watched at once on the free plan |
| `incineratorKey` | Sol Incinerator key. Burns leftovers and closes accounts for a fee. Not needed: selling and closing is free here |
| `rpcUrl` | Your own Solana RPC endpoint. Must start with `https://` |
| `autoReclaim` | Sell the leftover after every sale, close the empty account and return its ~0.00204 SOL |
| `recoverDust` | A leftover no market will buy is burned so the account can be closed and the rent returned |
| `useJito` | Off by default. Offers every signed trade to Jito's block engine as a bundle as well |
| `jitoTipSol` | The bundle tip, 0.0001 SOL by default. Only paid when the bundle lands, never counted as a fee when it does not |

Jupiter needs no key: the swap route and the price service the bot falls back to answer without one. The
price service is polled at 150 ms, and only for a coin whose trade stream has gone quiet.

## Sharing a setup

Settings has a **Share your settings** card. It writes a code of about 165 characters, `PCS1.<payload>.<checksum>`,
that carries the `SHARE_KEYS` list from `src/share.js`: the entry bar, the whole exit plan, the size and the pace,
and the cost ceilings. Another field applies a code somebody posted, and one button opens X with the line and the
code filled in.

The payload is `{v, p, n}` - a format version, a style name and the numbers - so a code cannot carry an API key, an
RPC URL, a wallet, the mode, or an open position. The checksum refuses a mistyped or truncated code, applying a code
is refused while the bot runs, and the ticket on your machine is only replaced when the code's is smaller.

## Files

| File | Contents |
| --- | --- |
| `settings.json` | Everything above |
| `wallet.json` | Encrypted key, never leaves the machine |
| `logs/` | Chromium logs, safe to delete |

The app keeps no database. Trade history lives in memory for the session and is shown in the app.
