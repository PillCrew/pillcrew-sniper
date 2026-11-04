# Build notes

Three installers come out of one code base. Each one has to be built on its own operating system, or in
CI, because Electron cannot cross compile a signed installer.

## Requirements

- Node.js 20 or newer
- npm 10 or newer

## The dependency pin

`@solana/web3.js` pulls `rpc-websockets`, which at version 9.3 and above requires an ESM only `uuid`.
Electron loads the main process as CommonJS, so the app dies at start with:

```
Error [ERR_REQUIRE_ESM]: require() of ES Module ... uuid/dist-node/index.js
```

`package.json` pins `rpc-websockets` back to 9.1.1, which uses a CommonJS `uuid`. Do not remove the
`overrides` block. If a future `web3.js` release fixes this upstream, the pin can go.

## Run from source

```
npm install
npm start
```

`prestart` copies three.js out of `node_modules` into the renderer so the 3D header works offline.

## Build

```
npm run dist:win      # Windows, NSIS installer, x64
npm run dist:mac      # macOS, DMG, needs macOS and an Apple developer certificate to sign
npm run dist:linux    # Linux, AppImage and deb
```

Artifacts land in `dist/`, named `PillCrew-Sniper-<version>-<os>-<arch>.<ext>`.

Windows and Linux packaging are verified from this repository: `electron-builder --win --dir` and
`--linux --dir` produce a working app, and the NSIS installer builds with no warning other than the
missing signing certificate. The macOS DMG has to be built on macOS.

Four details in `package.json` are load-bearing, not decoration:
- **`author` carries an email**, and `build.linux.maintainer` repeats it. The `deb` target refuses to
  build without one ("Please specify author 'email'"), which is the whole of `dist:linux` lost.
- **`build/icon.png` is 512x512**, derived from the app's own logo. Electron Builder converts it to the
  `.ico` and `.icns` the platform needs; a smaller source is refused, and without any source the build
  logs "default Electron icon is used" and ships the Electron logo.
- **`build.files` excludes `node_modules/three`**: the renderer loads the copy `scripts/vendor.js`
  writes to `renderer/vendor/three.js`, so packaging the npm package would add ~8 MB of dead weight.
  Anything that starts to `require('three')` from the main process needs that line removed first.
- **`npmRebuild` is off and the two optional native modules are excluded.** `ws` asks for
  `utf-8-validate` and `bufferutil` as a speedup and works without them; rebuilding them for Electron
  needs Python's `distutils`, which the macOS runner no longer ships, and that alone failed the DMG.
- **Every `dist:` script ends in `--publish never`.** On a CI runner Electron Builder otherwise tries to
  publish to a GitHub release, fails on the missing token, and takes a successful build with it.

## CI

`.github/workflows/ci.yml` runs the suites on Windows and Ubuntu for every push, and the `package` job
(on demand, `workflow_dispatch`) builds all three installers and uploads them as artifacts. That job is
the proof the cross-platform promise is real: Windows NSIS installer, macOS DMG and Linux AppImage + deb
are all built there, and `if-no-files-found: error` makes a build that produces nothing fail out loud
instead of passing quietly.

## Code signing

Windows: an unsigned NSIS installer shows a SmartScreen warning. A code signing certificate removes it.
Set `CSC_LINK` and `CSC_KEY_PASSWORD` before building.

macOS: the app must be signed and notarised or Gatekeeper refuses to open it. Set `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.

Linux: no signing. AppImage needs `chmod +x` after download. The `deb` target is built with `fpm`, which
Electron Builder only provides on Linux and macOS - build Linux installers on Linux or in CI, not from a
Windows checkout.

## Release checklist

1. `npm test` passes.
2. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
3. Build each platform.
4. Start the built app, create a wallet in Practice Mode, run one session.
5. There is no GitHub Release while the project stays private: the installers live as artifacts of the
   `package` job (Actions -> CI -> Run workflow), and the repository itself is the download.
6. When the owner opens the repository, the release notes come from the changelog with the risk statement
   at the top.

## Data folders

Development and the installed app share the same folder, because both use `productName` from
`package.json`:

- Windows: `%APPDATA%\PillCrew Sniper`
- macOS: `~/Library/Application Support/PillCrew Sniper`
- Linux: `~/.config/PillCrew Sniper`

Two checkouts of this repository therefore share one wallet. Give a second checkout its own `productName`
if you need them separate.

## Troubleshooting

**The window opens blank.** A renderer exception. Start with `--remote-debugging-port=9222`, open
`http://127.0.0.1:9222/json` in a browser and read the console.

**`Unable to move the cache: Access denied`.** Another instance of the app is still running. Close it.

**No prices.** The market endpoints need plain HTTPS access to `api.dexscreener.com` and `api.jup.ag`.
A firewall or a VPN with strict rules can block them; the log says `Market data: ...` when that happens.

**Trades are refused with 6002 or 6005.** Slippage. Raise the ceiling, or the coin moved faster than the
transaction could land.

**`CONNECTION_LIMIT` from PumpDev.** The free plan allows one connection per IP. One window only, and
close other tools using the same key.
