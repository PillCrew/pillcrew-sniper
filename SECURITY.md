# Security policy

## Scope

This application holds a Solana private key and signs transactions. Security reports are welcome and
taken seriously.

## Reporting

Open a private security advisory on the repository, or contact the maintainers directly. Please do not
publish a working exploit before a fix is available.

Include:

- What an attacker can do with the issue
- Steps to reproduce, or a proof of concept
- The version and operating system

## What is already in place

- The key is stored with AES-256-GCM. The key material is derived with scrypt from the user's password,
  with a random salt and a random nonce for every write.
- The key is only decrypted while a signing operation is in flight, and the plaintext never reaches the
  renderer.
- The renderer runs with `contextIsolation` on, `nodeIntegration` off and `sandbox` on. It talks to the
  main process through a small allow list in `preload.js`.
- External links are opened with `shell.openExternal` only for an allow list of hostnames.
- Window navigation is blocked. New windows are denied.
- Every transaction built by the trade API is inspected before it is signed. A transaction that moves
  more SOL out through plain transfers than the trade needs is refused.
- The same is true of the two optional services that build transactions for us. A Sol Incinerator
  transaction may only close the user's own empty token accounts and burn the token that was selected;
  it may not move a token, grant an approval, change an authority, pay the rent somewhere else, or ask
  for any signature but ours. A Jupiter swap may not approve, may not change an authority, may not move
  more SOL than the ticket, and is refused when the quoted or filled amount is not the amount ordered.
  A transaction whose program cannot be resolved is refused rather than skipped.
- Settings coming from the renderer are validated and clamped in the main process.
- A password check that only needs proof of ownership (removing the wallet) runs in the main process and
  never returns the key, so the secret crosses the bridge only when the user asks to see it.
- A transfer out of the wallet is built and signed once, outside anything that can be retried, so a node
  failure can only re-broadcast the same bytes and never a second transfer.
- The wallet is never replaced, removed, locked or drained while the bot is running with real money or
  while a position is still open, and the mode cannot be switched mid-run.
- A wallet file that exists but cannot be read is reported as damage instead of "no wallet", so the
  create screen can never write a new key over one that still holds funds. The file is written to a
  temporary file and renamed, so a crash cannot leave half a key.
- No telemetry, no analytics, no remote logging. The only network calls are to the services the user
  asked for.

## Known trade offs

- API keys for PumpDev, Jupiter and Sol Incinerator are stored in clear text in `settings.json`. They
  are not wallet keys and they cannot move funds. Anyone with file access to the profile folder can read
  them.
- An attacker who already runs code as the user can read the wallet file and attack the password
  offline. The password is the real protection, so it has to be strong and unique.
- A compromised RPC endpoint can lie about balances and confirmations. Prefer a provider you trust, and
  keep the RPC URL to `https://`.

## Supported versions

The latest release receives fixes. Older releases are not patched.
