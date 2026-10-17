# StelPay — USDC payments and subscriptions on Stellar

**StelPay lets an app accept stablecoin payments the way it accepts mobile money.** Built for
RodiumAI, an education platform in Ghana whose users pay with MoMo, StelPay adds **USDC on
Stellar** as a second payment provider: one-time payments for courses and **recurring
subscriptions enforced by a Soroban smart contract** — without the main app ever touching a
wallet, a key or a blockchain library.

> **Live on testnet:** `https://stelpay.forge.rodiumai.io` ·
> [`/v1/health/ready`](https://stelpay.forge.rodiumai.io/v1/health/ready) ·
> subscription contract
> [`CCREU5CN…GSFK` on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCREU5CNPJQGSQ3W4QN4Z7MXYIYHQJVLEALU5LUL7WGNYZSLWXFHGSFK)

## Why

- **Cards and international payments are hard in West Africa;** mobile money is local-only.
  USDC on Stellar settles in ~5 seconds, worldwide, for a fraction of a cent.
- **Subscriptions are the hard part of crypto payments.** Wallets don't "pull" money. StelPay's
  contract holds a bounded allowance the user signs **once**; the contract itself guarantees the
  service can never charge early, twice, more than the price, or to anyone but the merchant.
- **Non-custodial:** money goes straight from the user's wallet to the merchant's account. StelPay
  never holds funds.

## How it works

```
 Main app ──HMAC-signed API──▶  StelPay API ──▶ Postgres (Supabase) · Redis (Upstash)
    ▲                              │
    │ Ed25519-signed webhooks      ├── hosted checkout ◀── user's wallet (Freighter / SEP-7 QR)
    │                              │
    └──────── Worker ◀─────────────┴── Stellar: USDC payments + Soroban subscription contract
                 │
                 └── Signer (isolated, mTLS) ── keeper key, signs only valid charges
```

**One-time payment** — the main app asks for a 50 GHS payment → StelPay converts to USDC at the
live rate and returns a checkout link → the user pays from Freighter or any SEP-7 mobile wallet
(LOBSTR, xBull…) → the worker sees the payment on Stellar, matches it by memo (handles
underpayment and top-ups) → a signed `payment.confirmed` webhook tells the main app to unlock
access.

**Subscription** — the user signs one `subscribe` transaction: it pays the first period and
approves a capped number of future charges. Each period the worker asks the isolated **signer**
to sign a `charge`; the **contract** checks every rule on-chain and moves the funds. Failed
charges retry (+1, +3, +5 days) then cancel; cancelling from the wallet is picked up from
contract events.

## What's inside

| Part                                                | Tech                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Subscription contract (`contracts/subscription`)    | **Rust / Soroban** (soroban-sdk 28)                                                |
| API + hosted checkout (`apps/api`, `apps/checkout`) | TypeScript, Node.js 24, Fastify; checkout in vanilla TS (Vite)                     |
| Worker (`apps/worker`)                              | ledger ingestion (Horizon), matching, outbox webhooks, charges, lease-based leader |
| Signer (`apps/signer`)                              | mTLS-only, one operation, Node permission model, no network egress                 |
| Shared packages (`packages/*`)                      | money math (property-tested), state machines, XDR guards, envelope encryption      |
| Infra (`infra/`)                                    | distroless non-root images, AWS ECS/ECR, KMS, Secrets Manager, Prometheus alerts   |

## Security highlights

- Every API call is **HMAC-signed** (timestamp + nonce, replay-protected); every webhook is
  **Ed25519-signed** and verified on the raw body.
- Transactions are **checked before anything is signed or submitted** (XDR guards): the signer
  refuses anything but one `charge` on our contract from the keeper account.
- **Envelope encryption** of personal data with an AWS KMS key; blind index for lookups.
- Contract invariants covered by unit tests, a **model-based property test** of every invariant,
  **cargo-fuzz** (1 h clean run) and **Scout** static analysis — see
  [`docs/security/contract-review.md`](docs/security/contract-review.md).
- Signed container images (cosign), SBOM and SLSA provenance; Trivy, CodeQL, OSV and Semgrep in
  CI.

## Try it

**On testnet (no real money).** Install [Freighter](https://www.freighter.app/), switch it to
Testnet, fund the account by opening `https://friendbot.stellar.org/?addr=<your G… address>`
and add a USDC trustline. Payments are created by the main app through the signed API; see
[`docs/integration.md`](docs/integration.md) for the full flow, request signing examples and
the webhook verifier.

**Locally:**

```sh
nvm use && corepack enable && pnpm install
cp .env.example .env            # every value is explained inline
pnpm db:start && pnpm db:setup  # local Postgres 17 + roles + migrations
pnpm build:all
pnpm api:start                  # and: pnpm worker:start, pnpm signer:start
pnpm e2e:release                # full scripted testnet run: payments + subscriptions
```

Tests: `pnpm verify` (lint, types, 360+ unit tests, secret scan, DB and contract checks),
`pnpm test:int` (130+ integration tests), contract tests with `cargo test` in `contracts/`.

## Docs

- [`docs/development.md`](docs/development.md) — local setup, Supabase cloud setup, every command, deployment
- [`docs/integration.md`](docs/integration.md) — integrating an app: auth, endpoints, checkout, webhooks
- [`docs/context.md`](docs/context.md) — full specification and design decisions
- [`docs/deploy/staging.md`](docs/deploy/staging.md) — the live testnet deployment: what exists, cost, deploy, remove
- [`docs/deploy/aws-handover.md`](docs/deploy/aws-handover.md) — AWS deployment (ECR + ECS)
- [`docs/runbooks/`](docs/runbooks/README.md) — operations: kill switch, key rotation, restores
- [`docs/security/`](docs/security/README.md) — contract security review and security records

## Status

Running on **Stellar testnet** as a beta. Mainnet requires the contract sign-off in
`docs/security/contract-review.md`, multisig admin and merchant accounts and legal review.

Built by **Joshua Agyemang** ([@Joshua-OA](https://github.com/Joshua-OA)) for RodiumAI.
