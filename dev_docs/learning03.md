# Learning Log 03

Continuation of `learning02.md`. Same rules and entry format (see top of `learning01.md`). Read the hand-off summary at the bottom of `learning02.md` before adding entries here.

Cap: 200 lines. When full, write a hand-off summary and continue in `learning04.md`.

---

## ▶ RESUME HERE (for a fresh session)

Read in order: this section → hand-off at the bottom of `learning02.md` → `dev_docs/BUILD_PLAN.md` (current sprint) → the `docs/context.md` sections it cites. Or run `/resume`.

**State (2026-10-16):** S0–S8 merged and tagged `v0.0.1`…`v0.8.0`. **Sprint 9 (subscriptions end to end + signer)** in progress on `sprint/09-subscriptions`. Then S10 (hardening/infra — teammate owns AWS; Supabase credentials needed), S11 (main-app adapter + RC).

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

**`.env`:** complete for local dev + testnet (Upstash, ExchangeRate-API, keys, testnet merchant `rp_testnet_merchant` with USDC trustline). Missing: `SUBSCRIPTION_CONTRACT_ID` (S9 testnet deploy) and Supabase cloud URLs (S10).

**Sprint 9 starting notes:** signer = mTLS-only, one operation, reuses `guardKeeperTransaction` (S5); evaluate Node `--permission`. Checkout subscribe flow reuses `buildSubscribeTransaction` + `guardSubscribeTransaction`. Worker jobs: charge (simulate → signer → submit → record), allowance warnings (14 d), TTL extension, keeper balance; contract events via RPC (`parseSubscriptionEvent`). Core state machine `transitionSubscription` already handles retries/no back-charging. Deploy the contract to testnet with `scripts/contract/deploy.sh` and fill `SUBSCRIPTION_CONTRACT_ID`.

---

## Log
