# Learning Log 02

Continuation of `learning01.md`. Same rules and entry format (see top of `learning01.md`). Read the hand-off summary at the bottom of `learning01.md` before adding entries here.

Cap: 200 lines. When full, write a hand-off summary and continue in `learning03.md`.

---

## Log

### 2026-10-15 · S4 · contract · decision

Subscription contract built; constructor instead of `init`

- What: `contracts/subscription` per context §14 on soroban-sdk 28.0.0 (29.x is < 14 days old). WASM 11.6 KB.
- Why: a separate `init` can be front-run between deploy and init (anyone could set themselves admin). `__constructor` runs atomically with deployment. Context §14.1 updated with this reason.
- Also: functions return `Result<_, Error>` (typed `contracterror`) so tests assert exact failures; events via `#[contractevent]` (SDK 28 deprecates `events().publish`); `stellar contract build` required (plain `cargo build --target wasm32v1-none` refused by SDK 28).
- Verified: 22 tests (every §14.3 invariant, exact `mock_auths`, proptest call sequences); clippy clean.

### 2026-10-15 · S4 · tooling · incident

Disk full broke Scout ("ld: write() failed, errno=28")

- What: 133 MB free of 233 GB; even tool output files failed with ENOSPC.
- Fix: user asked to remove all Docker containers/images; then `colima ssh -- sudo fstrim -av` returned the VM's freed blocks to macOS (deleting images alone frees nothing on the host). Deleted a 1.2 GB failed `cargo install` dir. → 16 GB free.
- Prevent: check `df -h` before heavy builds; Scout detectors + Rust targets need several GB.

### 2026-10-15 · S4 · security · fact

Free-tool results on the contract (plan §6)

- Scout 0.3.17: critical 0, medium 0, minor 0, enhancement 7 — 6× `storage_change_events` are false positives (Scout does not recognise `#[contractevent]`), 1× `soroban_version` accepted (14-day rule). Gate: `scripts/scout-gate.py` blocks critical/medium/minor.
- `cargo deny`: RUSTSEC-2024-0436 (`paste` unmaintained) ignored with reason — host-only proc-macro via soroban-env-host, not in the WASM.
- cargo-fuzz target `charge_sequence` runs in CI (libFuzzer cannot build locally); its body was compiled and run on 300 random inputs locally without libFuzzer.
- Komet deferred to S10: install requires Nix via `kup` (multi-GB, system-wide) — not done on this machine; run in CI in S10.
- Details: `docs/security/contract-review.md`.

### 2026-10-15 · S4 · tooling · bug

stellar-cli reads the repo `.env`; our `STELLAR_*` names collided

- What: every `stellar` command inside the repo failed: "rpc-url is used but network passphrase is missing".
- Why: stellar-cli loads `.env` (dotenv, searching parent dirs) and owns `STELLAR_NETWORK`/`STELLAR_RPC_URL`; our empty `STELLAR_RPC_URL=` was read as a set RPC URL.
- Fix: config vars renamed to `RP_STELLAR_NETWORK`, `RP_STELLAR_RPC_URL`, `RP_STELLAR_HORIZON_URL` (code, `.env.example`, user's `.env` keys only).
- Prevent: never use `STELLAR_` for our own variables.

### 2026-10-15 · S4 · contract · test-fail

Local Quickstart e2e: friendbot needs Horizon; key aliases need `--overwrite`

- What: funding loop timed out (friendbot HTTP 502) with `--enable core,rpc`; reruns hit "identity … already exists" (`keys rm` did not clear it).
- Fix: Quickstart started with `core,rpc,horizon`; `keys generate --overwrite`; funding via friendbot with retries. First run's failure was hidden by piping to `tail` — always capture the exit code.
- Verified: `scripts/contract/e2e-local.sh` → "E2E OK": subscribe (one signature: transfer + approve 3 periods), early and non-keeper charges refused, cancel; events `sub_created`, `canceled`.

### 2026-10-15 · S4 · ci · ci-fail

cargo-fuzz built for musl; OSV flagged `paste`

- What: "sanitizer is incompatible with statically linked libc"; OSV: RUSTSEC-2024-0436 (2 lockfiles).
- Why: the prebuilt cargo-fuzz binary defaults to its own musl target; OSV has no knowledge of the `cargo deny` ignore.
- Fix: `--target x86_64-unknown-linux-gnu`; `contracts/osv-scanner.toml` + `contracts/fuzz/osv-scanner.toml` ignore with the same reason as `deny.toml`.

### 2026-10-15 · S4 · release · milestone

Sprint 4 merged (`v0.4.0`); local `.env` completed

- What: PR #6 green on all 7 jobs (incl. 120 s fuzz). User added ExchangeRate-API + Upstash keys (both verified without printing: GHS rate returned, PING → PONG). Generated role passwords, HMAC/blind-index/KMS/webhook keys and a funded testnet merchant; `.env` chmod 600.
- `pnpm db:setup` creates `rodium_pay_dev` with the `.env` role passwords and fills `DATABASE_URL_*`; integration tests now reuse those passwords (roles are cluster-wide — random test passwords would lock the dev DB out).
- Long fuzz: nightly 1 h workflow instead of "before each tag" (tags follow merges; nightly on `main` covers it).
- Disk: ~10 GB free after removing the Quickstart image (re-pulled by `e2e-local.sh`).

### 2026-10-15 · S5 · stellar · decision

Horizon default for payments; RPC maintained; contract events via RPC

- What: `LedgerSource` with Horizon (`/accounts/{merchant}/payments?join=transactions`) and RPC (CAP-67 `transfer` events on the USDC SAC + `getTransaction` for memo) implementations, shared `classifyPayment`.
- Why: SDF points to RPC and its testnet RPC emits classic events, but retention is ~3 h (Horizon ~1 y). Losing payments in a long outage is the worse failure. Recorded in context §13.4.
- Verified: Quickstart integration — a real 19.99 USDC payment with memo is seen and classified `eligible` by **both** sources; passphrase check passes/fails correctly.

### 2026-10-15 · S5 · stellar · surprise

stellar-sdk 17 rewrote the XDR layer

- What: `.toXDR()`/`fromXDR` deprecated (`toXdr`/`fromXdr`); XDR unions are classes discriminated by `type` with properties (`env.v1.tx.ext.sorobanData`) instead of `switch()`/method calls; `tx.hash()` returns `Uint8Array`; operations typed as `OperationRecord`.
- Fix: guards written against the new API; read generated `.d.ts` under `lib/esm/xdr/generated` rather than relying on pre-17 knowledge.

### 2026-10-15 · S5 · security · decision

XDR guards (context §13.3) + keeper footprint restriction

- Payment/subscribe guards require a valid source-account signature over the hash for _our_ passphrase — that is how "network matches" is enforced (the passphrase is not in the envelope). Fee bumps rejected.
- Keeper guard additionally restricts `extendFootprintTtl` to read-only keys of our contract (+ code), otherwise a compromised worker could make the keeper pay to extend arbitrary entries.
- Verified: bypass suite — 53 cases incl. wrong network, unsigned, extra op, same-code-other-issuer, ±1 stroop, memo case, time bounds 301 s, fee +1, fee bump, foreign footprint.

### 2026-10-15 · S5 · test · test-fail

Quickstart Horizon lags core after start

- What: "Service Unavailable" then "Not Found" from `loadAccount` right after start, although RPC and friendbot were up.
- Why: Horizon ingests behind core (history_latest_ledger stayed 0 for a while on the 2 GB VM).
- Fix: start script waits for `history_latest_ledger ≥ 1`; test retries account loads (90 s). Two consecutive green reruns.
