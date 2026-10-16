# Learning Log 03

Continuation of `learning02.md`. Same rules and entry format (see top of `learning01.md`). Read the hand-off summary at the bottom of `learning02.md` before adding entries here.

Cap: 200 lines. When full, write a hand-off summary and continue in `learning04.md`.

---

## ▶ RESUME HERE (for a fresh session)

Read in order: this section → hand-off at the bottom of `learning02.md` → `dev_docs/BUILD_PLAN.md` (current sprint) → the `docs/context.md` sections it cites. Or run `/resume`.

**State (2026-10-16):** S0–S9 merged and tagged `v0.0.1`…`v0.9.0`. **Sprint 10 (hardening, infra & observability)** in progress on `sprint/10-hardening`. Then S11 (main-app adapter + RC). AWS hosting is owned by a teammate: this repo provides adapters, manifests and checklists; Supabase cloud credentials come from the user when needed.

**How to work (user preferences):**

- Solo dev, continuous session; the user said "do not wait for permission": open PR → wait for all CI checks → rebase-merge → annotated tag `v0.N.0` → start the next sprint. Never push to `main` directly.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR bodies end with the Claude Code line.
- Explain in plain language; never take secrets in chat; verify credentials with scripts that print nothing secret.

**Environment (this Mac):**

- `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH` before pnpm/node/git push (shell default is Node 22).
- Broken Command Line Tools (no C++ headers): C++ builds (libFuzzer, stellar-cli from source) only in CI.
- Docker via Colima (2 CPU / 2 GB). **Disk is tight (~8 GB free)**: remove big images after use (`stellar/quickstart` 2.3 GB) and run `colima ssh -- sudo fstrim -a`. macOS has no `timeout`.
- Local stack: `pnpm db:start && pnpm db:setup` (dev DB `rodium_pay_dev`); `pnpm build:all`; `pnpm api:start` / worker `node --env-file=.env apps/worker/dist/main.js`; `pnpm api:call METHOD PATH [json]`; `pnpm e2e:testnet` (needs ports 3000/8080/9090 free).
- Tests: `pnpm verify` (pre-push), `pnpm test:int` (DB, serial), `pnpm test:redis` (`pnpm redis:start`), `pnpm stellar:start && pnpm test:stellar && pnpm test:e2e`, contracts via `FORCE_CONTRACTS=1 ./scripts/verify-contracts.sh`.

**`.env`:** complete for local dev + testnet (Upstash, ExchangeRate-API, keys, testnet merchant `rp_testnet_merchant` with USDC trustline). Also holds the S9 subscription settings (`SUBSCRIPTION_CONTRACT_ID` = E2E contract `CCREU5CN…GSFK`, `SUBSCRIPTION_PLANS`, signer/worker mTLS paths in `.mtls/` from `scripts/dev-mtls.sh`, `KEEPER_ADDRESS`, `KEEPER_SECRET`). Missing: Supabase cloud URLs (S10).

**Sprint 10 starting notes:** Komet + optional Sunbeam deferred here from S4. Local-first order: Dockerfiles (distroless, non-root, read-only, no shell) + Trivy; k8s manifests with default-deny network policies (signer reachable only from worker); AWS KMS adapter behind the existing KMS interface + Secrets Manager wiring; OpenTelemetry + §18 metrics/alerts; SBOM/cosign/SLSA in CI; backup scripts (`age` pg_dump) + restore drill (needs Supabase); §20 runbooks; `infra/upstash/` checklist; contract review pass 2. Disk is tight — build images one at a time and prune. Subscription testnet E2E: `pnpm build:all && pnpm e2e:testnet:subscriptions`.

---

## Log

### 2026-10-16 · S8 · release · milestone

`v0.8.0` merged and tagged (PR #11, 8/8 green). Learning log rolled to `learning03.md`.

### 2026-10-16 · S9 · contract · decision

E2E-only contract build: `test-short-intervals` (60 s minimum interval)

- Why: real networks cannot fast-forward ledger time; the production minimum is 1 day, so "charge" could not be exercised end to end.
- How: Cargo feature → separate `target/e2e/subscription-test-short-intervals.wasm` (hash `1141eaa3…`); production WASM hash unchanged (`81ea85d4…`); `deploy.sh` refuses the test build on mainnet. DB plans keep real intervals (CHECK ≥ 1 day); the worker follows the contract's `next_charge_at` from events.
- Testnet E2E contract: `CCREU5CNPJQGSQ3W4QN4Z7MXYIYHQJVLEALU5LUL7WGNYZSLWXFHGSFK` (plan 1 = 1 USDC / 120 s), admin `rp_testnet_admin`, keeper `rp_testnet_keeper` (stellar-cli keystore).

### 2026-10-16 · S9 · signer · decision

Signer: mTLS-only, one operation, Node permission model

- `POST /v1/sign` → `guardKeeperTransaction` → sign. TLS 1.3, client cert required and CN must be `rp-worker` (403 otherwise; foreign CA → handshake refused). Every decision logged; `signer_rejections_total` on a separate local metrics port.
- Runs under `node --permission --allow-fs-read=<app>`: no fs writes, reads limited to app + certs (verified with the compiled build). Node 24's model does not restrict network — network policy (S10) does.
- `KEEPER_SECRET` is read once and deleted from `process.env`.

### 2026-10-16 · S9 · worker · bug

A caught unique violation poisoned the whole charge batch

- What: 7 charge tests failed ~40% of runs: "current transaction is aborted, commands ignored until end of transaction block".
- Why: `insertCharge(...).catch()` inside the claim transaction — in Postgres any failed statement aborts the transaction, so every later claim failed. In production a leftover charge row (crash mid-charge) would have blocked all charging permanently.
- Fix: `insertChargeOnce` (`ON CONFLICT DO NOTHING` + read back); leftover rows are retried (the contract refuses a second charge in a period) unless already succeeded. Crash regression test added; 5/5 green runs.
- Prevent: never catch-and-continue a SQL error inside a transaction; use `ON CONFLICT`.

### 2026-10-16 · S9 · subscriptions · decision

Activation by the API, schedule by contract events

- Checkout submit waits for the `subscribe` result and activates with the returned `sub_id` (+ `allowance_expires_ledger` from the signed args; migration 0004 grants that column to `rp_api`), emitting `subscription.activated`.
- Contract events (RPC, cursor `contract:<id>`) set `next_charge_at`, emit `subscription.renewed` on `charged`, and `subscription.canceled` (`canceled_by: subscriber|admin`) on wallet/admin cancels. Simulation failures are checked against on-chain state (`get`): active and not yet due → resync `next_charge_at`, not a payment failure (see the #10 bug below).

### 2026-10-16 · S9 · network · bug

Classic fee cap rejected every Soroban transaction

- What: first testnet E2E: subscribe and charge refused with `fee_too_high`.
- Why: `MAX_FEE_STROOPS` (classic ops) also capped Soroban transactions, whose fee includes the resource fee (~0.1–1 XLM), far above a classic cap.
- Fix: separate `MAX_SOROBAN_FEE_STROOPS` (default 20000000 = 2 XLM), used by the signer guard, the subscription checkout guard and the charge job.
- Prevent: one fee cap per transaction class; test the guard with a real prepared Soroban transaction.

### 2026-10-16 · S9 · worker · bug

`Error(Contract, #10)` is not always our `NotDue`

- What: second testnet E2E: payer with no USDC never went past_due; charge recorded `not_due` and the subscription stayed active forever.
- Why: the charge job string-matched `#10` as the contract's `NotDue`. But the USDC SAC raised its own `Error(Contract, #10)` (insufficient balance) from inside `transfer_from` — contract error codes are per-contract, and the simulation error string does not reliably say which contract raised it.
- Fix: no error-code matching. On any simulation failure the job reads the subscription on-chain (`readSubscription` → `get`); active and `next_charge_at` in the future → resync the schedule; otherwise a real failure (retry schedule → past_due). Regression test with the SAC's #10.
- Prevent: never classify a cross-contract error by code alone; ask the contract for its state.

### 2026-10-16 · S9 · worker · bug

TTL extension sent an empty footprint to the signer

- What: third testnet E2E passed, but the signer refused every TTL extension with `foreign_footprint`.
- Why: the contract bumps its instance and subscription entries to the max TTL (~3.11M ledgers) on every call, so RPC simulation of `extendFootprintTtl` drops them all and returns an empty footprint. The guard correctly refuses an empty footprint (it would pay a fee to extend nothing).
- Fix: `prepareExtendTtl` returns `null` when the simulated footprint is empty; the maintenance job skips it. Unit tests: guard accepts a built extension, empty → `null`.
- Prevent: probe real RPC behaviour for "no-op" operations; a refusal alert in E2E logs is a bug even when the scenarios pass.

### 2026-10-16 · S9 · release · milestone

Subscription testnet E2E green (4/4)

- Subscribe via checkout (one signature) → `subscription.activated`; keeper charge via mTLS signer → `subscription.renewed`; payer sells USDC → failed charge → `subscription.past_due`; wallet-side `cancel` → `subscription.canceled` via event sync. All webhook signatures valid; no signer refusals.
- Contract `CCREU5CN…GSFK` (test-short-intervals build). Run: `pnpm build:all && pnpm e2e:testnet:subscriptions` (~5 min).

### 2026-10-16 · S10 · security · decision

AWS KMS adapter without the SDK in `@rp/security`; secrets as mounted files

- `createAwsKms(api, keyId)` takes any object with `encrypt`/`decrypt` (the SDK's `KMS` class fits), so the security package has no AWS dependency and tests use a fake. Encryption context `{purpose: 'rp.field-data-key.v1'}` and a pinned `KeyId` on decrypt: a blob from another key or purpose is refused.
- Verified with the real SDK against `nsmithuk/local-kms:3` (`AWS_ENDPOINT_URL`): round trip ok; other key and missing context → `InvalidCiphertextException`. `apps/api/scripts/aws-data-key.mjs` creates wrapped data keys (round-trips before printing; never prints the plaintext).
- `@aws-sdk/client-kms` 3.1145.0 (+25 packages): `minimumReleaseAge` in pnpm refused the newest — let pnpm pick instead of pinning by hand.
- Secrets Manager wiring = `FOO_FILE=/path` (`resolveSecretFiles` in `@rp/config`), used by api, worker and signer. Both set → error. The signer's file must sit under `--allow-fs-read`.
