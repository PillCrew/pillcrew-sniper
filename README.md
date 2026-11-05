# PillCrew Sniper

![PillCrew Sniper](promo/banner.png)

A desktop trading app for Pump.fun with an encrypted local wallet, live market feeds, configurable entries and exits, and a separate Practice Mode.

## What it looks like

| The dashboard | The live feed |
| --- | --- |
| ![Dashboard](screenshots/dashboard.png) | ![Live feed](screenshots/feed.png) |

| The wallet | Settings and presets |
| --- | --- |
| ![Wallet](screenshots/wallet.png) | ![Settings](screenshots/settings.png) |

Every picture is the shipped program in Practice Mode — the real window, the real market data, not a mock-up. The
wallet in the picture was created for the screenshot and thrown away with the profile it lived in.

## Run locally

Use Node.js 22 or later.

```sh
npm ci
npm test
npm start
```

Start in Practice Mode. Back up your wallet key before depositing funds. A strategy preset changes its filters and exit rules; it never increases your ticket size or switches to real money.

## What is included

- Pump.fun program-log WebSocket decoding, PumpPortal and optional PumpDev feeds, with fallback and market discovery.
- Entry scoring, creator-sale detection, wallet concentration checks and configurable position, pace and loss limits.
- Real-money entries require a known creator and fresh wallet-level trades. Mint/freeze authorities are checked on chain before buying. Missing mint data and unreviewed Token-2022 extensions block entries.
- TP/SL, partial profit taking, trailing exits, holding limits and recovery of saved live positions.
- The same signed transaction can be broadcast to several RPCs. Unknown outcomes are retained and checked by signature instead of immediately creating another order.
- Local AES-256-GCM wallet encryption with scrypt, restricted IPC, transaction inspection, fee ceilings and rent recovery.
- Practice fills with depth-sensitive slippage, configurable latency and failures. Cash and realized Practice PnL include exit fees.
- Recorded-signal replay with deterministic results, equity drawdown, win rate and profit factor.
- Opt-in local market recording and experimental order-flow/liquidity exits, off by default.

## Presets and capital

Safe and Balanced retain their existing strategy thresholds. High capital uses a 60% target, 12% stop, two concurrent positions, four entries per minute, a five-second minimum age and an 8% estimated round-trip cost ceiling. Advanced entry checks stay enabled. These are research settings, not an optimized or profitable strategy. The configured ticket is unchanged. Larger trades cause more price impact; a bigger bankroll does not remove liquidity risk.

## Results and accounting

Practice results and real trades have separate books. Trade history labels simulated results, estimated results and measured exits. A measured exit uses the wallet SOL delta of its confirmed sale transaction; entry fees and rent can still be estimates. The live equity panel marks open holdings from available prices, so it is not an audited cash-flow ledger. Check the explorer and wallet when reconciling funds.

An unconfirmed transaction may remain pending until the chain gives a definite answer. Inspect its signature before placing an external replacement. A stop can fail, gap past its threshold or have no liquidity to fill. No preset guarantees an exit or a profit.

## Tests and replay

```sh
npm test
npm run test:ui
npm run backtest -- events.jsonl settings.json
npm run dist:win
```

The UI smoke test opens a hidden window with an isolated mock wallet and network requests blocked. The live dry-run script is separate and requires a wallet password; it is not part of the test suite.

See [backtesting](docs/BACKTESTING.md), [release audit](docs/AUDIT-1.0.1.md), [security](SECURITY.md), [build instructions](docs/BUILD.md) and [settings](docs/SETTINGS.md). Older architecture and settings notes describe earlier behavior; the release audit records changes in 1.0.1.

## Limits

This release does not add Geyser/gRPC, ShredStream, creator-history indexing, wallet clustering or a trained exit model. Those require additional integration, datasets and validation. There is no verified profitability result or latency ranking against competing bots. Recorded-signal replay is not a full historical simulation of live discovery.

## License

MIT. See [LICENSE](LICENSE).
