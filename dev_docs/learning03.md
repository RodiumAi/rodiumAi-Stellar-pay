# Learning Log 03

Continuation of `learning02.md`. Same rules and entry format (see top of `learning01.md`). Read the hand-off summary at the bottom of `learning02.md` before adding entries here.

Cap: 200 lines. When full, write a hand-off summary and continue in `learning04.md`.

---

## ▶ RESUME HERE (for a fresh session)

Read in order: this section → hand-off at the bottom of `learning02.md` → `dev_docs/BUILD_PLAN.md` (current sprint) → the `docs/context.md` sections it cites. Or run `/resume`.

**State (2026-10-16):** S0–S10 merged and tagged `v0.0.1`…`v0.10.0`. **Sprint 11** in-repo parts merged without a tag (release E2E `pnpm e2e:release` 7/7, `pnpm load:sanity`, §17 mainnet USDC verified). **Paused before the main-app integration — the user said "not yet" (2026-10-16); do not clone or change the main app until they say so.** Candidates found by code search for MoMo: `RodiumAi/rodiumai_backend_nestjs` (adapter/webhooks) and `RodiumAi/rodiumai_user_nextjs` (UI). External items left: Supabase scratch-project restore drill (needs Supabase access), staging on AWS + alerts firing (teammate), legal sign-off, Upstash plan/pricing, admin/merchant multisig. `v1.0.0-rc.1` waits for staging + the adapter.

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

**When resuming Sprint 11:** ask the user before touching the main app. Re-check soroban-sdk 29 after 2026-10-21 (contract review, plan §6) — any contract change needs a new WASM hash, Scout, 1 h fuzz and the model proptest. Images: `docker build -f infra/docker/Dockerfile --target <app>` (~25 min locally; CI is the gate), `scripts/check-image.sh`; published + signed by `images.yml` on main (first run green 2026-10-16).

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

### 2026-10-16 · S10 · worker · bug

The kill switch would have canceled every subscription

- What: found by the runbook review: while the contract is paused, every `charge` simulation fails with `Paused`, and the job counted it as a payment failure → `past_due` webhooks, then cancel after the retry schedule.
- Fix: after a failed simulation the job asks `is_paused()`; if paused the charge row gets `failure_code = 'paused'`, the subscription is untouched and the 10-minute lease retries it. Regression test includes the post-pause success.
- Prevent: when writing a runbook, trace what each running job does during the procedure.

### 2026-10-16 · S10 · infra · bug

Generic `FOO_FILE` loading swallowed `SSL_CERT_FILE`

- What: the signer image refused to start under `--permission`: "SSL_CERT_FILE: cannot read /etc/ssl/certs/ca-certificates.crt (ERR_ACCESS_DENIED)".
- Why: the base image sets `SSL_CERT_FILE`; `resolveSecretFiles` treated every `*_FILE` as a secret named `*`. Api/worker read the CA bundle into `SSL_CERT` silently.
- Fix: only `SECRET_NAMES` are resolved. `check-image.sh` now also fails on "cannot read" (it had accepted the error as a normal config failure).
- Prevent: never infer meaning from a naming convention other software also uses; allowlist.

### 2026-10-16 · S10 · infra · decision

Images: distroless/cc + the exact Node binary; checks in a script

- `gcr.io/distroless/nodejs24-debian12` shipped Node 24.14.0 (we pin 24.21.0) → runtime is `distroless/cc-debian12:nonroot` with `/usr/local/bin/node` copied from the pinned build image. Non-root 65532, no shell, no package manager, starts on a read-only FS — asserted by `scripts/check-image.sh` (CI and release).
- No buildx locally (Colima, classic builder): no `--mount` in Dockerfiles. A full build takes ~25 min on the 2-CPU VM; CI is the real gate.
- CI tools are release binaries pinned by sha256, cross-checked against GitHub's asset digest (Trivy release tags were hijacked in 2026 — never `trivy-action@tag`).

### 2026-10-16 · S10 · contract · decision

Komet blocked on protocol 28 → model-based proptest instead

- Komet v0.1.89 lacks host functions `m.b`/`m.c` (imported by every soroban-sdk 28 contract that reads a `#[contracttype]` or publishes an event) and its `require_auth` always succeeds. Verified against our WASM's import section and Komet's `host/map.md`.
- Replacement: `random_operations_keep_every_invariant` (128 × ≤ 40 random ops, real auth + SAC, invariants after every step). A removed pause guard is caught. Re-check condition in `contracts/komet/README.md`.

### 2026-10-16 · S10 · observability · decision

Traces by hand, no auto-instrumentation; signer exports nothing

- ESM auto-instrumentation needs loader hooks (import-in-the-middle) that fight `node --permission`; spans are created at boundaries instead (API request with route template names, each worker job pass, worker → signer client span with `traceparent`). The signer has no egress, so it logs the `trace_id` from `traceparent`.
- mTLS files are re-read every 60 s (`createTlsFiles`); the signer swaps its secure context (`minVersion` must be passed again — `setSecureContext` replaces the whole context). Tests need `agent: false`: keep-alive sockets skip the new handshake.

### 2026-10-16 · S11 · release · milestone

Release gate and load sanity in place; integration paused

- `pnpm e2e:release`: payment + underpayment/top-up + expiry, then subscription create/charge/failed charge/wallet cancel — 7/7 on testnet in 8 min.
- `pnpm load:sanity`: 100 creations + 100 status polls correct; p95 ≈ 850 ms locally, of which Upstash REST round trips are most (ping p95 ≈ 560 ms from here; each call makes 2). Budget = 300 ms own time + measured Upstash, so the check means the same in-region. The rate limit answers 429, never 5xx.
- First `images.yml` run on main: 4 images pushed to GHCR, cosign-signed, SBOM + SLSA provenance (verified via the attestations API).

### 2026-10-16 · S11 · subscriptions · bug

A slow subscribe confirmation left a paid subscription `incomplete` forever

- What: found while writing the integration guide: if checkout's wait for the subscribe transaction timed out, the API answered `submitted` and relied on the worker — but contract-event sync finds rows by `contract_subscription_id`, which only activation sets. User paid and approved; no `subscription.activated`, no charges.
- Fix: migration 0005 `activation_tx_hash`; checkout records hash + subscriber + allowance before sending; the worker matches `sub_created` by transaction hash (subscriber and plan must match) and activates + emits `subscription.activated`. Regression test (incl. a mismatched wallet); subscription testnet E2E 4/4.
- Prevent: every "the worker will pick it up" comment needs a test that the worker can actually find the row.

### 2026-10-16 · S11 · db · bug

Cloud Supabase: session pooler resets; migrations needed session mode

- What: first `pnpm db:setup:supabase` run: `cannot connect as postgres (ECONNRESET)`. Port 6543 (transaction pooler) works; 5432 (session pooler) completes TLS, then resets after ~20 s with no Postgres error. The direct host is IPv6-only and this Mac has no IPv6. (Also: the pasted URL ended in `/postgresnot` — fixed in place.)
- Why it mattered: the migration runner held a session advisory lock — unsafe through a transaction pooler (lock and unlock can hit different server connections).
- Fix: migrations take `pg_advisory_xact_lock` per file and re-check `schema_migrations` inside that transaction (concurrency test added); setup falls back to 6543 and warns that the worker's `DATABASE_URL_WORKER_SESSION` (ingest leader lock) still needs session mode.
- Open: session pooling on project `sovqyegoxvmnqiomlbzq` must be fixed in the dashboard before the worker runs against it. API verified against the cloud project (ready + a payment created).

### 2026-10-16 · S11 · worker · decision

Ingest leader by lease row instead of a session advisory lock

- Why: the project's session pooler (5432) never answers a startup message (even for an unknown user, with or without TLS), while 6543 answers in ~1 s; the direct host is IPv6-only. Advisory locks need a dedicated session.
- How: migration 0006 `leader_leases`; `tryAcquireLease` is one `INSERT … ON CONFLICT DO UPDATE … WHERE holder = me OR expires_at < now()` using the DB clock; the ingester renews before every page (30 s lease) and releases on shutdown. Matching is idempotent, so a stalled leader overlapping its successor is safe. `DATABASE_URL_WORKER_SESSION` removed everywhere. Verified against the cloud project: leader, lag 0, clean shutdown.
- Also: re-running bootstrap re-sets passwords (new SCRAM salt) and Supavisor briefly rejects them (`28P01`) — setup retries for up to a minute.
