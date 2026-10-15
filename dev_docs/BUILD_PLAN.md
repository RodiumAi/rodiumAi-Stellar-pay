# RodiumAI Crypto Pay — Build Plan (Sprints)

Source of truth: `soroban-context.md` (moves to `docs/context.md` in Sprint 0). This plan orders the work; the context file defines it. If they disagree, the context file wins and this plan gets corrected.

Status: **GitHub practice (§1) adopted 2026-10-15. Sprint plan awaiting answers to §5 before Sprint 0 starts.**

---

## 0. How to read this plan

- The build is **layered, not feature-sliced**: each sprint completes one layer (core → security/config → db → contract → stellar → api → worker → checkout → subscriptions → hardening → release). Later sprints depend on earlier ones.
- Every sprint ends with: **all tests green locally → pre-push gate → PR → CI green → merge → tag**. Nothing is pushed to `main` untested.
- What happened, what went wrong and why goes in the **rolling learning log**: `dev_docs/learning01.md`, then `learning02.md`, `learning03.md`, … Each file is capped at 200 lines and is chronological across all sprints, not one file per sprint. Entries are tagged `S<n>` so a stage can be grepped.
- Section references like §7.3 point to `soroban-context.md`.

### Dependency graph

```
S0 foundation
 └─ S1 core ─┬─ S2 config+security ─┬─ S3 db ───────────┐
             │                      │                   ├─ S6 api ─┬─ S7 worker (payments) ─ S8 checkout ─┐
             └─ S4 contract ────────┴─ S5 stellar ──────┘          │                                     ├─ S10 hardening ─ S11 release
                                                                    └──────────── S9 subscriptions ──────┘
```

S4 (Rust contract) has no TypeScript dependency and can run in parallel with S2/S3 if a second person is available.

---

## 1. GitHub workflow (best practice for this project)

### 1.1 The situation

- **This repo is greenfield** (only an initial commit). Nothing here is deployed yet.
- **The main RodiumAI app is already deployed.** It must never be affected by this build until we deliberately switch crypto on. The only touchpoint is the main-app adapter in Sprint 11, shipped dark behind a feature flag (§10.4).
- Because sprints are layers rather than user-facing features, classic "feature branches" don't map cleanly. Use **trunk-based development with short-lived sprint branches**.

### 1.2 Branching

| Branch | Purpose | Lifetime |
|---|---|---|
| `main` | Always green, always releasable. Protected. | permanent |
| `sprint/NN-<slug>` e.g. `sprint/01-core-domain` | All work for one sprint | ≤ 1 sprint |
| `fix/<slug>` | Bug fix found after a sprint merged | hours–days |
| `hotfix/<slug>` | Urgent fix after go-live; branches from latest release tag | hours |

Rules:
- Never commit directly to `main`.
- If a sprint is large, split it into 2–4 **task PRs** into `main` (e.g. `sprint/02-config`, `sprint/02-security`) rather than one giant PR. Smaller PRs = reviewable, bisectable.
- Rebase the sprint branch on `main` before opening/updating the PR (`git pull --rebase origin main`). No merge commits from `main` into sprint branches.

### 1.3 Commits

[Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`.

- Types: `feat`, `fix`, `test`, `refactor`, `chore`, `ci`, `docs`, `build`, `perf`, `security`.
- Scopes match workspace packages: `core`, `security`, `config`, `db`, `stellar`, `api`, `worker`, `signer`, `checkout`, `contract`, `infra`, `devdocs`.
- One logical change per commit. Each commit should build and pass tests on its own (keeps `git bisect` useful).
- Examples: `feat(core): add bigint stroops parse/format`, `test(contract): charge twice in one period fails`.

### 1.4 Pull requests

- Open a **draft PR early** in the sprint so CI runs on every push.
- PR template (added in S0) contains the §21 Definition-of-Done checklist plus: "Learning log updated?" and "§17 facts verified (with sources)?".
- Merge strategy: **squash-merge for small task PRs, rebase-merge for sprint PRs** with clean conventional commits. Either way, `main` stays linear.
- Required to merge: CI green, 1 approving review (self-review checklist if solo), conversations resolved, branch up to date.

### 1.5 Branch protection on `main` (set in S0)

- Require PR, require status checks (`verify`, `contract`, `security-scan`), require linear history, require up-to-date branch.
- Block force-push and deletion.
- Require signed commits (recommended).
- CODEOWNERS on `contracts/`, `packages/security/`, `apps/signer/`, `infra/` — these need a second reviewer once the team has one.

### 1.6 Tags and releases

- After each sprint merges: annotated tag `v0.<sprint>.0` (e.g. `v0.3.0` after Sprint 3) with a short release note listing what landed.
- Release candidate for testnet: `v1.0.0-rc.N`. Mainnet: `v1.0.0`, only after the external contract audit (§14.4).
- Tags give a known-good rollback point per layer.

### 1.7 Protecting the deployed main app

- This service deploys independently (separate repo, separate database, separate infra).
- Main-app changes (Sprint 11) go through **that** repo's normal process, behind a feature flag defaulting **off**, with crypto hidden when `/v1/health/ready` fails (§10.4). MoMo is untouched.
- Rollout: staging → internal users on testnet → small % of prod on mainnet → full. Kill switch = flag off + contract `set_paused` (§16.3).

---

## 2. Testing gate before every push

Every sprint has its own specific tests (listed per sprint). In addition, **every push** must pass the standard gate.

### 2.1 Local gate (`pnpm verify`, wired to a git `pre-push` hook in S0)

```
pnpm format:check        # prettier
pnpm lint                # eslint strict-type-checked, zero warnings
pnpm typecheck           # tsc --noEmit across workspaces
pnpm test                # vitest unit (+ integration where the sprint has them)
pnpm audit --audit-level high
gitleaks protect --staged
# when contracts/ changed:
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

The hook uses `git config core.hooksPath .githooks` — no extra npm dependency (§16.2 keeps deps minimal).

### 2.2 CI gate (GitHub Actions, pinned by commit SHA, minimal `permissions`)

Same as local plus: `pnpm install --frozen-lockfile`, coverage gate (90% on `core` and `security`), `osv-scanner`, Semgrep, CodeQL, `cargo audit`, `cargo deny check`, and from S10 onward Trivy + SBOM. Integration jobs (Supabase local, Redis + `serverless-redis-http`, Stellar Quickstart) are added as their sprints introduce them.

### 2.3 Sprint push checklist

1. Sprint-specific tests written and passing (including failure paths).
2. `pnpm verify` green locally.
3. Learning log entries appended to the current `learningNN.md` (roll to the next file at 200 lines).
4. Push branch → CI green.
5. Self-review the diff against §5 code standards.
6. Merge, tag, update the sprint status table (§4 below).

---

## 3. Sprints

Suggested cadence: **1 week per sprint** for S0–S2, **2 weeks** for the heavier ones (marked). Adjust after reviewing S1's actual pace in the learning log.

---

### Sprint 0 — Foundation & guardrails (1 week)

**Goal:** an empty but fully guarded monorepo where bad code cannot reach `main`.

Scope:
- Move `soroban-context.md` → `docs/context.md`. Add `docs/runbooks/`, `docs/security/`.
- pnpm 10 workspace with layout from §4 (empty packages with `package.json` + `src/index.ts` placeholder test).
- `.npmrc` / `pnpm-workspace.yaml`: `minimumReleaseAge` 14 days, `onlyBuiltDependencies` allowlist, strict peers, exact versions (§16.2).
- Root `tsconfig.base.json` with the §5 flags; per-package project references.
- ESLint (typescript-eslint strict-type-checked, `eslint-plugin-security`), rules banning `any`, default exports, `Math.random`, `rejectUnauthorized: false`; Prettier.
- Rust toolchain file + empty `contracts/subscription` crate with the §14.4 release profile.
- `.gitignore` extended for Node (`node_modules`, `dist`, `coverage`, `.env*`).
- `.githooks/pre-push` running `pnpm verify`.
- GitHub: Actions workflow (`verify`, `contract`, `security-scan`), PR template, CODEOWNERS, Renovate config, branch protection.
- Verify §17: latest stable versions of every §3 dependency (≥14 days old); record sources.

Tests before push:
- `pnpm verify` passes on the skeleton.
- A deliberately bad commit on a throwaway branch (uses `any`, default export, `Math.random`) **fails** lint in CI — proves the guardrails work. Delete the branch after.
- `cargo build --release` and `cargo clippy -D warnings` pass on the empty crate.

Exit: CI green, branch protection on, tag `v0.0.1`.

---

### Sprint 1 — `packages/core`: domain & money (1 week)

**Goal:** pure business rules with no I/O, fully tested.

Scope:
- Branded types: `PaymentId`, `SubscriptionId`, `Stroops`, `StellarAddress`, `Memo` (§5).
- `Result<T, E>` type and helpers.
- Money: `parseAmount` (≤7 decimals, reject otherwise), `formatAmount` (exactly 7 decimals), fiat minor units + ISO 4217, conversion rounding **up** to 0.01 USDC (§5 Money).
- Payment state machine (§6): pending/underpaid/confirmed/expired/late_paid/refunded with accumulation and overpayment rules.
- Subscription state machine (§6) with retry schedule (+1d, +3d, +5d, cancel) and no back-charging.
- Memo generator: `RP` + 12 Crockford base32, normalization (trim + upper-case) (§13.2).
- UUIDv7 generator (app-side IDs, §7.1).
- Lint rule: no `Number`/`parseFloat`/`toFixed` in `packages/core/money`.

Tests before push:
- Property tests (fast-check): `parse(format(x)) == x`; parse rejects >7 decimals, negatives, exponent notation, whitespace tricks; conversion never rounds down.
- Every allowed state transition succeeds; every disallowed one returns an error value; exhaustive `never` checks compile.
- Memo: format, length ≤ 28 bytes, normalization.
- Coverage ≥ 90% lines on `core`.

Exit: tag `v0.1.0`.

---

### Sprint 2 — `packages/config` + `packages/security` (1 week)

**Goal:** every cryptographic and configuration primitive, isolated and tested.

Scope:
- `config`: Zod-validated config loaded once at boot; testnet/mainnet `NetworkConfig` files (§13.5); fail fast on invalid config.
- HMAC request signing + verification: canonical string, ±300s skew, nonce check interface, two active key IDs, `timingSafeEqual` (§9.1).
- Ed25519 webhook signing: `t=…,k=…,s=…` header over `"{t}.{raw_body}"`; reference verifier for the main app (§10.3).
- Envelope encryption: AES-256-GCM, stored format `version||key_id||nonce||ct||tag`, AAD `"{table}.{column}.{row_id}"`, `Kms` interface with a local dev implementation (real KMS adapter chosen in S10) (§12.2).
- Blind index: HMAC-SHA256 with separate key (§12.2).
- Checkout tokens: 32 random bytes base64url, SHA-256 hash storage (§11.2).
- Central pino logger with redact paths (§5 Errors and logging).

Tests before push:
- HMAC: valid passes; replayed nonce, skew >300s, unknown key, revoked key, tampered body/path/method all fail.
- Webhook: sign → verify round-trip; tampered body, old timestamp, wrong key fail.
- Encryption: round-trip; ciphertext moved to a different row ID fails (AAD); tampered tag fails; key rotation reads old version.
- Redaction test: logging an object with secrets/tokens/customer refs emits none of them.
- Config: missing/invalid env rejected with clear error.
- Coverage ≥ 90% on `security`.

Exit: tag `v0.2.0`.

---

### Sprint 3 — `packages/db`: schema, roles, repositories (2 weeks)

**Goal:** Postgres schema exactly as §7, least-privilege roles, typed repositories, proven concurrency behaviour.

Scope:
- Verify §17: Supabase Postgres major version; Supavisor ports, username format, prepared-statement behaviour.
- Forward-only SQL migrations: schema §7.1, roles/grants/RLS policies §7.3. Migration runner using `rp_owner`.
- Kysely types; repositories for payments, subscriptions, charges, receipts, outbox, cursors, audit log.
- Write patterns §7.2: single-transaction receipt+payment+outbox, `ON CONFLICT DO NOTHING`, atomic `amount_received + $n`, conditional transitions (`UPDATE … WHERE status = $expected RETURNING`), `FOR UPDATE SKIP LOCKED` claiming, advisory-lock helper on a session connection.
- Idempotency: same key + same hash → original response; different hash → `idempotency_conflict`.
- `infra/supabase/roles.sql` + `settings.md` checklist (§7.4).
- Local dev: `supabase start` (same Postgres major as prod).

Tests before push (integration, against local Supabase):
- Migrations apply cleanly from zero; re-running is a no-op.
- Role tests: `rp_api` cannot UPDATE `chain_receipts`; nobody can UPDATE/DELETE `chain_receipts`/`audit_log`; `anon`/`authenticated`/`service_role` see nothing.
- Concurrency: two receipts for the same payment in parallel sum correctly; duplicate receipt inserts once; two workers claiming due rows never get the same row; second advisory-lock holder waits.
- Conditional transition affecting 0 rows is a no-op, not an error.
- CHECK constraints reject: non-positive amounts, confirmed without `confirmed_at`, memo > 28 bytes.

Exit: tag `v0.3.0`.

---

### Sprint 4 — Soroban subscription contract (2 weeks, parallelizable)

**Goal:** contract from §14 with every invariant in §14.3 proven by tests.

Scope:
- Verify §17: latest `soroban-sdk`, `stellar-cli`; Circle USDC SAC contract ID on testnet; max entry TTL.
- Functions from §14.1; behaviour §14.2; instance storage for config, persistent for subscriptions, TTL extended on touch.
- Checked arithmetic, events on every state change.
- Deploy script for testnet (local Quickstart first).
- `cargo audit`, `cargo deny check` in CI.

Tests before push (Soroban test env, `mock_auths` with exact invocations — never `mock_all_auths` for security tests):
- Recipient is always the init-time merchant.
- Price never changes after creation even if plan price changes.
- Second `charge` in the same period fails.
- `charge` on canceled / paused subscription fails without transfer.
- `price * periods` overflow aborts.
- Auth: only keeper charges; only subscriber/admin cancels; only admin manages plans/pause/keeper/upgrade.
- Late charge advances to `now + interval` (no back-charging); at most one period per call.
- Deploy + subscribe + charge works on local Quickstart.

Exit: tag `v0.4.0`. Add a learning-log entry noting the external audit is still required before mainnet.

---

### Sprint 5 — `packages/stellar`: adapters & XDR guards (2 weeks)

**Goal:** everything that talks to or reasons about the Stellar network, behind interfaces.

Scope:
- Verify §17: Circle USDC issuer (testnet + mainnet); current SDF guidance Horizon vs RPC — pick the default `LedgerSource`.
- Startup check: configured passphrase must match what RPC reports (§13.5).
- `LedgerSource` interface with Horizon and RPC implementations; receipt parsing for `payment` and path payments (counting amount **received**) (§13.2, §13.4).
- Contract event parsing (`sub_created`, `charged`, `canceled`).
- XDR guards (§13.3): payment guard, subscribe guard, keeper-charge guard (shared with signer in S9).
- SEP-7 `web+stellar:pay` URI builder; transaction builder for `subscribe` with simulation; `live_until_ledger` computed from network TTL at runtime.

Tests before push:
- XDR guard **bypass suite**: wrong network, extra operation, wrong asset (same code different issuer), wrong destination, wrong amount, wrong memo, no time bounds, time bounds > 5 min, fee over cap, wrong contract ID, wrong plan ID, wrong subscriber — each rejected.
- Receipt parser against recorded fixtures: plain payment, path payment (strict send/receive), missing memo, wrong asset, claimable balance → correct matched/unmatched/ignored classification.
- Passphrase mismatch prevents startup.
- Integration against Stellar Quickstart: send a real payment, the adapter sees it.

Exit: tag `v0.5.0`. **Phase A (foundations) complete** — add a `milestone` entry to the learning log summarising Phase A.

---

### Sprint 6 — `apps/api`: internal API (2 weeks)

**Goal:** the authenticated `/v1` API the main app calls.

Scope:
- Fastify 5, `@fastify/helmet`, body limit 16 KB, stable error codes, no stack traces (§9.2).
- HMAC auth plugin with Upstash nonce store (`SET NX EX 600`, **fail closed**) (§8.2).
- `@upstash/ratelimit` per key and per IP, in-process backstop (fail open).
- Idempotency: Redis fast path + Postgres unique constraint as truth.
- Endpoints: `POST/GET /v1/payments`, `POST/GET /v1/subscriptions`, `POST /v1/subscriptions/{id}/cancel`, `/v1/health/ready`, `/health/live`.
- Quote: USD rate = 1; FX provider adapter interface (stub provider until one is chosen).
- `return_url` origin allowlist; `customer_ref` encrypted + blind-indexed, never returned.
- Upstash wrapper that refuses writes without TTL (§8.1).

Tests before push:
- Every endpoint: happy path + validation failures + auth failures.
- Security: replay, skew, bad signature, unknown key, Upstash down → API rejects (fail closed); rate-limit store down → in-process limit still applies.
- Idempotency: same key/same body → same response; same key/different body → 409.
- `return_url` with wrong scheme/host/port rejected.
- Response never contains `customer_ref`; logs never contain it.
- Integration with local Supabase + Redis via `serverless-redis-http`.

Exit: tag `v0.6.0`.

---

### Sprint 7 — `apps/worker`: payments pipeline & webhooks (2 weeks)

**Goal:** money arriving on-chain becomes a confirmed payment and a signed webhook.

Scope:
- In-process scheduler, graceful `SIGTERM` (stop claiming, 25s drain, release locks) (§15).
- Ingest job: advisory-lock leader, cursor persisted in same transaction as receipts (§13.4).
- Matching: memo → payment, accumulation, underpaid, overpayment recorded, unmatched + alert.
- Reconcile job (re-scan last 2,000 ledgers every 15 min, idempotent).
- Expire payments job (every 30 s); late receipts → `late_paid`.
- Outbox dispatcher: Ed25519-signed webhooks, backoff 10s→12h, then `dead`; admin CLI replay.
- Metric `ingest_lag_ledgers`.

Tests before push:
- Kill the ingester mid-batch, restart → no skipped or double-counted receipts.
- Two worker replicas → one ingester leader; jobs never double-claim.
- Underpay then top-up → confirmed with both tx hashes; overpay → confirmed + excess recorded.
- Payment after expiry → `late_paid`.
- Webhook receiver returns 500 → retries on schedule → `dead` after last attempt; replay works.
- Reconcile fills an artificially created gap.
- E2E on Quickstart: create payment via API → send USDC → webhook received with valid signature.

Exit: tag `v0.7.0`.

---

### Sprint 8 — `apps/checkout`: hosted one-time payment page (2 weeks)

**Goal:** a user can pay a one-time payment end to end on **testnet**.

Scope:
- Verify §17: which Stellar Wallets Kit wallets support signing (and Soroban invocations).
- Server routes: `GET /c/{token}` (SSR, amount/asset/destination/memo in plain text, SEP-7 QR as inline SVG), `POST /c/{token}/submit` (XDR guard → submit; tx hash not submitted before), `GET /c/{token}/status` (ETag, 5s Redis cache).
- Vite vanilla TS page; wallet kit lazily loaded on click; Trusted Types; no `innerHTML`.
- Security headers exactly as §11.3, per-request CSP nonce; `/c/*` path redaction in logs.
- Token validity: until final state or 24h.

Tests before push:
- CSP + all §11.3 headers present on every response.
- Initial JS ≤ 30 KB gzipped (CI budget check).
- Submit endpoint rejects every XDR from the S5 bypass suite with `422 invalid_transaction` and logs a security event.
- Expired/unknown token → 404 without leaking existence details.
- Accessibility: keyboard-only pay flow, visible focus, labelled controls, light + dark.
- **Testnet E2E**: payment, underpayment, expiry scripted run.

Exit: tag `v0.8.0`. First demo-able milestone.

---

### Sprint 9 — Subscriptions end to end + signer (2 weeks)

**Goal:** recurring USDC subscriptions work on testnet with an isolated keeper signer.

Scope:
- `apps/signer`: mTLS-only, one operation, keeper-charge XDR guard (from S5), no DB/Redis access, logs every decision; evaluate Node `--permission` here first (§16.3).
- Checkout subscribe flow: server builds + simulates `subscribe`, user signs once.
- Worker jobs: charge subscriptions (simulate first → signer → submit → record), allowance warnings (14 days), TTL extension, keeper balance check.
- Contract event ingestion keeps state in sync, including wallet-side cancels.
- Retry schedule and `past_due` → `canceled`; no back-charging on recovery.

Tests before push:
- Signer refuses: non-charge call, wrong contract, wrong source, fee over cap, long time bounds, multiple ops. Every refusal increments `signer_rejections_total`.
- Simulation failure (insufficient balance/allowance) → failed charge recorded, `past_due`, nothing submitted.
- Retry +1d/+3d/+5d then cancel (time-travel test).
- Cancel from wallet directly → service state becomes `canceled` via event ingestion.
- **Testnet E2E**: subscription create, charge, failed charge, cancel.

Exit: tag `v0.9.0`.

---

### Sprint 10 — Hardening, infra & observability (2 weeks)

**Goal:** production-shaped deployment on staging.

Scope:
- Dockerfiles: distroless/Chainguard, non-root, read-only FS, no shell; weekly rebuild.
- k8s manifests: pod security, default-deny network policies with explicit egress allowlists (§16.3); signer only reachable from worker.
- Real KMS adapter (cloud KMS or Vault Transit) replacing dev KMS; secret store wiring; `docs/runbooks/rotation.md`.
- mTLS (private CA, 30-day rotation); TLS 1.3 + `X25519MLKEM768` on terminator where supported.
- OpenTelemetry traces + all §18 metrics and alerts.
- Supply chain: Trivy, CycloneDX SBOM, SLSA provenance, cosign-signed images, admission policy.
- Backup: PITR on, weekly `age`-encrypted `pg_dump`, first restore drill recorded.
- All §20 runbooks written.
- `infra/upstash/` checklist (§8.1).

Tests before push:
- Trivy: zero high/critical in images and IaC.
- Network-policy test: signer cannot reach Supabase/Upstash/internet; API cannot reach signer.
- Container runs as non-root with read-only FS; no shell present.
- Restore drill succeeds into scratch Supabase project.
- Alerts fire in staging for: ingest lag, unmatched receipt, signer rejection, dead webhook, keeper balance low.

Exit: tag `v0.10.0`, staging environment live on testnet.

---

### Sprint 11 — Main-app integration & release candidate (2 weeks)

**Goal:** RodiumAI app can offer crypto, dark-launched, with mainnet gated on audit.

Scope (two repos):
- **Main app repo** (deployed project — follow its own branch/PR rules): crypto provider adapter next to MoMo, webhook verifier with dedup on `id`, grant access only on confirmed/activated/renewed events, fallback polling, feature flag **default off**, hide option when health fails (§10.4).
- **This repo:** testnet E2E release script (§19), load sanity test, `v1.0.0-rc.1`.
- Verify §17: legal/regulatory requirements per jurisdiction; mainnet USDC issuer/SAC ID; Upstash plan/pricing.
- Commission external contract audit; fix findings; re-tag RC.

Tests before push:
- Main-app adapter: signature verify on raw body, stale timestamp rejected, duplicate event ignored, access not granted on redirect alone.
- Full testnet E2E script passes from the main app's staging environment.
- With flag off, main app behaves exactly as before (MoMo regression tests green).

Exit: `v1.0.0-rc.N` on staging. **Mainnet `v1.0.0` only after**: audit sign-off, legal sign-off, runbooks reviewed, admin multisig + merchant multisig configured, gradual rollout plan approved.

---

## 4. Sprint status tracker

| Sprint | Branch | Status | Tag |
|---|---|---|---|
| S0 Foundation | `sprint/00-foundation` | not started | — |
| S1 Core | `sprint/01-core-domain` | not started | — |
| S2 Config + security | `sprint/02-config-security` | not started | — |
| S3 DB | `sprint/03-db` | not started | — |
| S4 Contract | `sprint/04-contract` | not started | — |
| S5 Stellar | `sprint/05-stellar` | not started | — |
| S6 API | `sprint/06-api` | not started | — |
| S7 Worker | `sprint/07-worker-payments` | not started | — |
| S8 Checkout | `sprint/08-checkout` | not started | — |
| S9 Subscriptions | `sprint/09-subscriptions` | not started | — |
| S10 Hardening | `sprint/10-hardening` | not started | — |
| S11 Release | `sprint/11-release` | not started | — |

---

## 5. Open questions to resolve before Sprint 0

1. **Team size** — solo or multiple engineers? (Decides whether S4 runs in parallel and whether CODEOWNERS second-review is enforceable.)
2. **Sprint length** — 1/2-week split above OK?
3. **Accounts** — Supabase org (dev/staging/prod projects, Pro + PITR), Upstash, GitHub org settings access for branch protection?
4. **Hosting** — which cloud / Kubernetes platform, and which KMS (cloud KMS vs Vault Transit)?
5. **FX provider** — needed for non-USD pricing; USD-only at launch is simplest.
6. **Main app** — repo access and who owns the adapter PR there?
7. **Audit** — budget and preferred auditor for the Soroban contract (book early; lead times are long).
8. **Repo name** — context file calls it `rodium-crypto-pay`; this repo is `rodiumAi-Stellar-pay`. Keep current name?
