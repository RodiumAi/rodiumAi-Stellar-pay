# Learning Log 01

Running, chronological log of the whole build — not tied to one sprint. Read top to bottom to see what happened at each stage, what went wrong and why.

**Rules**

- Cap: **200 lines per file**. When the next entry would push past 200, write the hand-off summary at the bottom, then continue in the next file (`learning02.md`, then `learning03.md`, …). Never edit a full file except to fix a factual error.
- Append only, newest at the bottom.
- Tag every entry with the stage (`S0`–`S11`) and area so entries can be grepped: `grep "S3" dev_docs/learning*.md`.
- Always include the **why** (root cause), not only the symptom. Quote errors exactly.
- Log: failures, surprises, decisions, workarounds, verified §17 facts, sprint start/end markers.
- Keep entries short — a few lines each. Long investigations go in the PR description and are linked here.

**Entry format**

```
### YYYY-MM-DD · S<n> · <area> · <type>
<title>
- What: <what happened; exact error if any>
- Why: <root cause>
- Fix: <what was done / decided>
- Verified: <test, command or source>
- Prevent: <test, lint rule, checklist item added>
- Refs: <commit / PR / tag / URL>
```

Types: `bug` · `test-fail` · `ci-fail` · `decision` · `workaround` · `fact` · `surprise` · `incident` · `milestone`

---

## Log

### 2026-10-15 · S0 · devdocs · decision

Build plan drafted; GitHub practice adopted

- What: Wrote `dev_docs/BUILD_PLAN.md` (12 layered sprints). Adopted trunk-based workflow: protected `main`, short-lived `sprint/NN-slug` branches, Conventional Commits, CI-gated PRs, `v0.N.0` tag per sprint.
- Why: Sprints are layers, not features; main RodiumAI app is already deployed, so this service must stay isolated and reach the main app only behind a feature flag (S11).
- Fix: Learning logs changed from per-sprint files to this rolling 200-line format.
- Refs: `dev_docs/BUILD_PLAN.md` §1

### 2026-10-15 · S0 · devdocs · decision

Open questions answered; paid audit replaced by free tooling

- What: Solo developer, no calendar sprints; AWS hosting (teammate, later) → AWS KMS + Secrets Manager; FX = ExchangeRate-API; repo name stays `rodiumAi-Stellar-pay`; accounts still open.
- Why: No budget for an external Soroban audit; one developer working continuously.
- Fix: BUILD_PLAN §5 rewritten as decisions, new plan §6 (Scout, Komet, cargo-fuzz, optional Sunbeam, self-written `docs/security/contract-review.md`, exposure caps). Context §4, §6 Quote, §12, §14.4, §17 updated to match.
- Verified: `open.er-api.com/v6/latest/USD` returned GHS 11.686603 (2026-10-15). Tool sources: developers.stellar.org/docs/tools/developer-tools/security-tools
- Prevent: mainnet gated on plan §6 sign-off against the exact WASM hash.
- Refs: `dev_docs/BUILD_PLAN.md` §5–§6

### 2026-10-15 · S0 · tooling · fact

Newest Node and pnpm were too fresh for the 14-day rule

- What: Node 24.22.0 (2026-10-14) and pnpm 10.34.7 (2026-10-12) were the latest releases.
- Why: §16.2 requires ≥ 14 days since publish to dodge compromised releases.
- Fix: pinned Node 24.21.0 (`.nvmrc`, `engines`) and pnpm 10.34.6 (`packageManager`). All versions recorded in `docs/dependencies.md`.
- Verified: nodejs.org/dist/index.json, `npm view <pkg> time`.

### 2026-10-15 · S0 · tooling · workaround

`brew install stellar-cli` fails on this Mac

- What: Homebrew refused to build: outdated Command Line Tools, "You should download the Command Line Tools for Xcode 26.3." (Tier 3 config).
- Why: stellar-cli builds from source under Homebrew; the CLT check blocks it.
- Fix: `cargo install --locked stellar-cli` instead (official alternative). Only needed from S4.
- Prevent: if cargo build also fails, update CLT via Software Update.

### 2026-10-15 · S0 · lint · surprise

ESLint 10 config quirks

- What: `@eslint/js` has no v10 release (latest 9.39.5), so no `js.configs.recommended`. Root `vitest.config.ts` linted with "This rule requires the `strictNullChecks` compiler option".
- Why: config files sit outside every package tsconfig, so the project service used default (non-strict) options.
- Fix: rely on typescript-eslint strict/stylistic type-checked configs; `projectService.defaultProject = tsconfig.tools.json` (strict) for root `*.config.ts`, also type-checked in `pnpm typecheck`.
- Verified: a file using `any`, default export, `Math.random`, `rejectUnauthorized: false` produces 7 lint errors.

### 2026-10-15 · S0 · ci · decision

Contract checks run only when `contracts/` changes locally

- What: `scripts/verify-contracts.sh` skips Rust when `contracts/` is unchanged vs `origin/main` (`FORCE_CONTRACTS=1` overrides); CI `contract` job always runs.
- Why: keep TypeScript-only pre-push fast without weakening CI.
- Refs: `.githooks/pre-push`, `.github/workflows/ci.yml`

### 2026-10-15 · S0 · contract · surprise

Scout cannot run on a crate without soroban-sdk

- What: `cargo scout-audit` → "[ERROR] No supported dependency found in Cargo.toml." (supports ink, soroban, substrate-pallets).
- Why: Scout detects the target chain from dependencies; the S0 crate is intentionally empty.
- Fix: local gate and CI skip Scout until `subscription/Cargo.toml` lists `soroban-sdk`; mandatory from S4. Plan S0 test text corrected.
- Verified: cargo-scout-audit 0.3.17 installed locally.

### 2026-10-15 · S0 · ci · ci-fail

CodeQL and OSV failed: org has no GitHub Code Security

- What: "Code Security must be enabled for this repository to use code scanning." CodeQL also: "Resource not accessible by integration" (get-a-workflow-run).
- Why: both jobs uploaded SARIF to code scanning, which private org repos only get with Code Security; CodeQL also lacked `actions: read`.
- Fix: OSV runs as a pinned, checksum-verified binary in `security-scan` and fails on findings; CodeQL uses `upload: never` and `scripts/sarif-gate.py` blocks on security-severity ≥ 7.0.
- Verified: guardrail PR #2 (bad code) failed `verify` with 6 lint errors, then closed and deleted.
- Prevent: if the org enables Code Security later, re-enable uploads for the GitHub UI view.

### 2026-10-15 · S0 · release · milestone

Sprint 0 merged and tagged

- What: PR #1 rebase-merged after all 5 checks passed; tag `v0.0.1`. First tag push failed: "ERR_PNPM_UNSUPPORTED_ENGINE … Expected version: 24.21.0 Got: v22.16.0".
- Why: the pre-push hook runs in the shell's default Node (22); `engine-strict` rejects it.
- Fix: run git push with Node 24.21.0 on PATH (`nvm use` in the repo).
- Prevent: `.nvmrc` exists; set the shell default to 24.21.0 or use an nvm auto-switch hook.

### 2026-10-15 · S4 · tooling · workaround

stellar-cli source builds fail; using the prebuilt binary

- What: `cargo install stellar-cli` → cxx build "fatal error: 'algorithm' file not found".
- Why: macOS Command Line Tools are broken/outdated (no C++ standard headers), same root cause as the Homebrew failure.
- Fix: installed `stellar-cli-28.1.0-x86_64-apple-darwin.tar.gz` from the GitHub release after matching its sha256 digest; `stellar 28.1.0`.
- Prevent: reinstall CLT (`xcode-select --install`) before anything else needs a C++ toolchain.

### 2026-10-15 · S1 · core · decision

Money, IDs and state machines in `packages/core`

- What: bigint stroops parse/format, fiat minor units (ISO 4217 table: USD EUR GBP GHS NGN KES ZAR XOF), 18-decimal `FxRate` (fiat per USDC, matches `numeric(38,18)`), conversion rounding up to 0.01 USDC; memo `RP`+12 Crockford; UUIDv7; payment + subscription state machines.
- Why: §5, §6, §13.2. Late receipts use ledger close time: a receipt at/after `expires_at` on pending/underpaid goes to `late_paid` even if the expiry job has not run yet.
- Decision: retry delays are applied after each consecutive failure (+1d, +3d, +5d → retries on day 1, 4, 9; 4th failure cancels). Configurable via `RetryPolicy`.
- Decision: decimal parsing is hand-written (`money/decimal.ts`) because `eslint-plugin-security` flags the equivalent regexes as unsafe.
- Verified: 149 tests (fast-check properties: round-trip, never rounds down, accumulation keeps every stroop); core lines 97%.
- Prevent: lint bans `Number`, `parseFloat`, `parseInt`, `.toFixed` and float literals in `packages/core/src/money`.

### 2026-10-15 · S0 · release · milestone

Sprint 0 merged and tagged

- What: PR #1 rebase-merged after all 5 checks passed; tag `v0.0.1`. First tag push failed: "ERR_PNPM_UNSUPPORTED_ENGINE … Expected version: 24.21.0 Got: v22.16.0".
- Why: the pre-push hook runs in the shell's default Node (22); `engine-strict` rejects it.
- Fix: run git push with Node 24.21.0 on PATH (`nvm use` in the repo).
- Prevent: `.nvmrc` exists; set the shell default to 24.21.0 or use an nvm auto-switch hook.

### 2026-10-15 · S4 · tooling · workaround

stellar-cli source builds fail; using the prebuilt binary

- What: `cargo install stellar-cli` → cxx build "fatal error: 'algorithm' file not found".
- Why: macOS Command Line Tools are broken/outdated (no C++ standard headers), same root cause as the Homebrew failure.
- Fix: installed `stellar-cli-28.1.0-x86_64-apple-darwin.tar.gz` from the GitHub release after matching its sha256 digest; `stellar 28.1.0`.
- Prevent: reinstall CLT (`xcode-select --install`) before anything else needs a C++ toolchain.

### 2026-10-15 · S1 · core · decision

Money, IDs and state machines in `packages/core`

- What: bigint stroops parse/format, fiat minor units (ISO 4217 table: USD EUR GBP GHS NGN KES ZAR XOF), 18-decimal `FxRate` (fiat per USDC, matches `numeric(38,18)`), conversion rounding up to 0.01 USDC; memo `RP`+12 Crockford; UUIDv7; payment + subscription state machines.
- Why: context §5, §6, §13.2. Late receipts use ledger close time: a receipt at/after `expires_at` on pending/underpaid goes to `late_paid` even if the expiry job has not run yet.
- Decision: retry delays apply after each consecutive failure (+1d, +3d, +5d → retries on day 1, 4, 9; 4th failure cancels). Configurable via `RetryPolicy`.
- Decision: decimal parsing is hand-written (`money/decimal.ts`) because `eslint-plugin-security` flags the equivalent regexes as unsafe.
- Verified: 149 tests (fast-check: round-trip, never rounds down, accumulation keeps every stroop); core lines 97%.
- Prevent: lint bans `Number`, `parseFloat`, `parseInt`, `.toFixed` and float literals in `packages/core/src/money`.
