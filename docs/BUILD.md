# Build and verification

Use Node.js 22 or later and npm. Install the versions in the lockfile:

```sh
npm ci
npm test
npm run test:ui
npm start
```

The UI test uses an invisible window, an isolated mock wallet and a stopped trading engine. It does not open the real profile or start trading. The separate live-dryrun script requires wallet credentials and is not part of normal verification.

Electron is pinned to 45.2.1 and electron-builder to 26.18.1. The rpc-websockets 9.3.10 and jayson 5.0.0 overrides avoid the older uuid/stream-json dependency chains while keeping the current web3.js client. Review overrides and run the suites when changing them.

```sh
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Build each installer on its matching OS. Windows output goes to dist/. Publishing is disabled in the distribution commands. Code signing requires a separately configured certificate.

The vendor script copies three.js into renderer/vendor; generated files are ignored by Git. Optional native WebSocket speedups are excluded from the packaged app and rebuilding is disabled. Keep those exclusions unless you add a verified native build pipeline.

See AUDIT-1.0.1.md for checks completed during this update. A successful package build does not establish live-trading correctness or profitability.
