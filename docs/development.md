# Development guide

A standalone payment service that lets the RodiumAI app accept **USDC on Stellar** for one-time
payments and recurring subscriptions, next to the existing MoMo provider. The main app never
touches wallets, keys or blockchain code: it calls a small HMAC-signed API, sends the user to a
hosted checkout page, and receives Ed25519-signed webhooks.

```
RodiumAI app ──HMAC API──▶ API ──▶ Supabase Postgres / Upstash Redis
     ▲                      │
     │ signed webhooks      ├── hosted checkout ◀── user's wallet (Freighter / SEP-7)
     │                      │
     └────── Worker ◀───────┴── Stellar (payments + Soroban subscription contract)
                │
                └── Signer (isolated, mTLS) ── keeper key for subscription charges
```

- **Integrating the main app?** Start with [`docs/integration.md`](integration.md).
- **Specification:** [`docs/context.md`](context.md) — the single source of truth.
- **Operations:** [`docs/runbooks/`](runbooks/README.md) · security: [`docs/security/`](security/README.md).

## Repository layout

| Path                     | What it is                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `apps/api`               | Fastify API: payments, subscriptions, hosted checkout, health                      |
| `apps/worker`            | Ledger ingestion, matching, charges, webhooks (outbox), expiry, maintenance, stats |
| `apps/signer`            | Keeper signer: mTLS-only, signs exactly one `charge` or TTL extension              |
| `apps/checkout`          | Checkout page front end (Vite, vanilla TS, Freighter + SEP-7 QR)                   |
| `packages/core`          | Money, state machines, IDs — pure TypeScript, no I/O                               |
| `packages/config`        | Configuration parsing, network constants, secrets from mounted files               |
| `packages/security`      | HMAC auth, webhook signatures, envelope encryption, KMS adapters, mTLS files       |
| `packages/db`            | Kysely repositories, SQL migrations, role bootstrap                                |
| `packages/stellar`       | Horizon/RPC ledger sources, XDR guards, Soroban helpers                            |
| `packages/telemetry`     | OpenTelemetry tracing helpers                                                      |
| `contracts/subscription` | Soroban subscription contract (Rust)                                               |
| `infra/`                 | Docker images, Kubernetes manifests, alert rules, Supabase/Upstash checklists      |

## Requirements

- Node.js **24.21.0** and pnpm **10.34.6** (`engine-strict` rejects other versions; `.nvmrc` is set)
- Docker (Colima works) for the local database, Redis and Stellar Quickstart
- [Supabase CLI](https://supabase.com/docs/guides/cli) for the local Postgres
- For the contract: Rust 1.98.0 (`contracts/rust-toolchain.toml`) and stellar-cli 28.1.0
- Optional: gitleaks (pre-push secret scan)

## Quick start (local)

```sh
nvm use                       # Node 24.21.0
corepack enable               # pnpm 10.34.6
pnpm install
cp .env.example .env && chmod 600 .env
```

Fill `.env` step by step — the comments in [`.env.example`](../.env.example) explain every value.
Generate keys with the helpers instead of by hand, and never paste secrets into chats or tickets.

```sh
pnpm db:start                 # local Postgres 17 (Supabase stack, DB only) on :54322
pnpm db:setup                 # roles + migrations + DATABASE_URL_* lines in .env
pnpm env:api                  # checkout token key, a field data key, API defaults
pnpm build:all                # typecheck/build everything + the checkout bundle
pnpm api:start                # API on :8080
pnpm worker:start             # worker (ingestion, webhooks, charges)
pnpm signer:start             # signer (only needed for subscriptions; see below)
pnpm api:call GET /v1/health/ready
```

Subscriptions also need the signer's mTLS certificates (`./scripts/dev-mtls.sh` writes them to
`.mtls/`), a deployed contract (`scripts/contract/deploy.sh`) and the keeper settings in `.env`.

## Supabase (cloud project)

Local development uses the Supabase CLI's Postgres. To point the service at a **cloud** Supabase
project (staging or production):

1. **Create the project** in the Supabase dashboard: Postgres 17, region next to where the service
   runs. Follow [`infra/supabase/settings.md`](../infra/supabase/settings.md) (SSL enforcement on, Data
   API not exposing `pay`, unused products off).
2. **Copy the admin connection string:** Dashboard → **Connect** → **Session pooler** → URI. It looks
   like `postgresql://postgres.<project_ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Open `.env` in your editor and set `SUPABASE_DB_URL=` to it, replacing `[YOUR-PASSWORD]` with the
   database password (Dashboard → Database → Settings → Reset password if you don't have it).
3. **Download the CA certificate:** Dashboard → Database → Settings → **SSL Configuration** →
   Download certificate. Save it as `.supabase/prod-ca-2021.crt` (git-ignored); `SUPABASE_CA_CERT`
   already points there.
4. **Run the setup:**
   ```sh
   pnpm db:setup:supabase
   ```
   It connects with TLS verified against that certificate, checks the Postgres major (17),
   creates `rp_owner`, `rp_api`, `rp_worker` and `rp_readonly` with fresh 32-byte passwords,
   applies the migrations as `rp_owner`, backs up `.env`, writes all `DATABASE_URL_*` lines
   (pooler URLs with `sslmode=verify-full` and the pinned CA) and checks each role can connect.
   It prints no passwords. Re-running is safe; `ROTATE=1 pnpm db:setup:supabase` rotates the
   role passwords.
   If the project's session pooler (5432) does not answer, setup uses the transaction pooler
   (6543) automatically — nothing in the service needs session mode.
   For a second project (e.g. production), put its `SUPABASE_DB_URL` and `SUPABASE_CA_CERT`
   in a separate git-ignored file and run `ENV_FILE=.env.production pnpm db:setup:supabase`;
   the passwords and URLs are written to that file, and `.env` is left untouched.
5. Start the services as usual (`pnpm api:start`, …) — they now use the cloud project.

In Kubernetes the URLs come from AWS Secrets Manager (`rodium-pay/*/DATABASE_URL_*`, mounted
under `/run/secrets`) and the CA file must be mounted at the path in `sslrootcert`.

## Commands

| Command                                           | What it does                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                     | Everything the pre-push hook runs: format, lint, types, unit tests, audit, secret scan, DB and contract checks    |
| `pnpm test` / `pnpm test:coverage`                | Unit tests (90% coverage gate on `core` and `security`)                                                           |
| `pnpm test:int`                                   | Integration tests against the local Postgres (serial)                                                             |
| `pnpm test:redis`                                 | Redis tests (`pnpm redis:start` first)                                                                            |
| `pnpm test:stellar`                               | Stellar Quickstart tests (`pnpm stellar:start` first; image is 2.3 GB)                                            |
| `pnpm e2e:release`                                | Full testnet run before a release: payment, underpayment, expiry, subscription create/charge/failed charge/cancel |
| `pnpm load:sanity`                                | Load sanity check of the API (creation, polling, rate limits)                                                     |
| `pnpm api:call METHOD PATH [json]`                | Signed request to the local API                                                                                   |
| `./scripts/backup/drill-local.sh`                 | Encrypted backup → restore drill against the local database                                                       |
| `FORCE_CONTRACTS=1 ./scripts/verify-contracts.sh` | Contract tests, Scout and fuzz smoke run                                                                          |

## Deployment

- **Images:** `infra/docker/Dockerfile` (`--target api|worker|signer`) — distroless, non-root,
  read-only filesystem, no shell. `.github/workflows/images.yml` publishes them to GHCR from `main`
  (and weekly), signed with cosign, with SBOM and SLSA provenance.
- **AWS (ECR + ECS):** images are pushed to Amazon ECR from `main` and deployed to ECS by the
  maintainers.
- **Kubernetes (alternative):** `infra/k8s/base` + `overlays/staging` — restricted Pod Security, default-deny
  network policies (the signer is reachable only from the worker and has no egress), secrets via
  the Secrets Store CSI driver, IRSA for AWS KMS. Admission policy in `infra/k8s/policies`.
- **Observability:** Prometheus alerts in `infra/observability/alerts.yaml`; traces via OTLP when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Contract:** `scripts/contract/deploy.sh`; mainnet requires the sign-off in
  [`docs/security/contract-review.md`](security/contract-review.md).

## Contributing

Conventional Commits, one branch per sprint, PRs into `main` (never push to `main`). CI must be
green: the same checks as `pnpm verify` plus CodeQL, OSV, Semgrep, Trivy, contract fuzzing and
the network-policy test. Dependencies follow the 14-day age rule
([`docs/dependencies.md`](dependencies.md)).
