# RodiumAI Crypto Pay — Engineering Context

This file is the single source of truth for building the RodiumAI crypto payment service. Read it fully before writing code. When this document and an instinct disagree, this document wins; when this document is silent, choose the option that is simpler, more explicit and easier to audit.

---

## 1. What we are building

A standalone payment service that lets RodiumAI accept **USDC on Stellar** for one-time payments and recurring subscriptions, alongside the existing MoMo provider.

The main RodiumAI application never touches blockchain code, wallets or keys. It calls this service through a small authenticated API, redirects the user to a hosted checkout page, and receives signed webhooks when money arrives or a subscription changes state. To the main app, crypto is just another payment provider adapter next to MoMo.

```
RodiumAI app ──HMAC API──▶ Crypto Pay API ──▶ Postgres / Redis
     ▲                         │
     │ Ed25519 webhooks        ├── Hosted checkout (pay.<domain>) ◀── user's wallet
     │                         │
     └──────── Worker ◀────────┴── Stellar network (classic payments + Soroban contract)
                  │
                  └── Signer (isolated) ── keeper key for subscription charges
```

### Non-goals

- No custody of customer funds. Users pay from their own wallets.
- No fiat off-ramp in this service. Treasury handles conversion separately.
- No support for volatile assets at launch. XLM acceptance exists behind a feature flag, disabled by default.
- No back-charging of missed subscription periods.

---

## 2. Key decisions (do not revisit without a written reason)

| Area              | Decision                                                             | Why                                                                                                 |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Asset             | USDC (Circle) on Stellar                                             | Stable value, 7-decimal precision, low fees, wide wallet support                                    |
| One-time payments | Classic Stellar payments matched by memo                             | Works with every wallet and exchange; no contract risk                                              |
| Subscriptions     | Soroban contract using SAC `approve` + `transfer_from`               | Pull payments with on-chain enforcement of price and interval                                       |
| Service boundary  | Separate deployable with its own database                            | Failure, secret and deploy isolation from the main app                                              |
| Checkout          | Hosted by this service                                               | Keeps wallet code and Stellar logic out of the main frontend                                        |
| Main-app auth     | HMAC-SHA256 request signing + mTLS on the private network            | Replay-resistant, no bearer tokens on the wire                                                      |
| Webhook auth      | Ed25519 signatures                                                   | Main app holds only a public key; a leak there cannot forge events                                  |
| Money type        | `bigint` in stroops (1 USDC = 10,000,000 stroops)                    | No floating point anywhere money is represented                                                     |
| Source of truth   | Postgres (Supabase)                                                  | Redis (Upstash) is acceleration only; losing it must never lose money state                         |
| Managed data      | Supabase Postgres used as a plain database; Upstash Redis over HTTPS | No database servers to run or patch; Supabase Auth, Storage, Realtime and the Data API are not used |
| Jobs              | Postgres-backed scheduling (`FOR UPDATE SKIP LOCKED`), no BullMQ     | Every job is already a scan of Postgres state; avoids per-command Redis billing from queue polling  |
| Signing           | Dedicated signer process that validates before signing               | A compromised API or worker cannot make the keeper sign arbitrary transactions                      |

---

## 3. Stack

Use the **latest stable release of each major listed, pinned to an exact version that has been public for at least 14 days** (see §16). Record exact versions in the lockfile; never use ranges.

**Backend (TypeScript)**

- Node.js 24 LTS
- TypeScript 5.x, `strict` plus the flags in §5
- Fastify 5 (HTTP), `@fastify/helmet`, `@fastify/rate-limit`
- Zod for every external input and for configuration
- Kysely with `pg` for SQL (typed queries, no ORM magic, migrations in plain SQL)
- `@upstash/redis` and `@upstash/ratelimit` (HTTPS REST client)
- `@stellar/stellar-sdk` (Horizon + RPC clients, XDR, transaction building)
- pino for logging, OpenTelemetry for traces and metrics
- Vitest, Testcontainers, fast-check (property tests for money math)

**Smart contract**

- Rust stable, `soroban-sdk` latest stable, `stellar-cli` for build and deploy

**Checkout frontend**

- Vite, vanilla TypeScript, no UI framework
- ~~Stellar Wallets Kit~~ → **Freighter via `@stellar/freighter-api`** (2 deps, ~98 KB), loaded lazily only on click, plus the SEP-7 QR / `web+stellar:pay` link for mobile wallets (LOBSTR, xBull, …). Changed in S8: the kit 2.7.0 pulls ~234 packages / 481 MB (WalletConnect/Reown, Ledger, Trezor beta, runtime CSS injection via twind) — at odds with §16.2 minimal dependencies and the §11.3 CSP (`style-src 'self'`, WalletConnect out of scope). More wallets can be added one module at a time.
- QR codes rendered server-side as inline SVG

**Data**

- Supabase Postgres (Pro plan or higher, PITR add-on), accessed through Supavisor
- Upstash Redis, one database, used only for rate limits, nonces, idempotency fast path and short-lived caches

**Package management**

- pnpm 10 workspaces with `minimumReleaseAge` and a build-script allowlist

---

## 4. Repository layout

```
rodiumAi-Stellar-pay/
├── apps/
│   ├── api/            Fastify: internal API, checkout routes, health
│   ├── worker/         ingestion, matching, expiry, renewals, webhook dispatch
│   ├── signer/         isolated signing service (no inbound internet)
│   └── checkout/       Vite frontend for the hosted checkout page
├── packages/
│   ├── core/           domain types, state machines, money, pure business rules
│   ├── db/             SQL migrations, Kysely types, repositories
│   ├── stellar/        network adapters, transaction verification, XDR guards
│   ├── security/       envelope encryption, HMAC auth, webhook signing, tokens
│   └── config/         Zod-validated configuration, loaded once at boot
├── contracts/
│   └── subscription/   Soroban contract (Rust)
├── infra/
│   ├── supabase/       bootstrap-roles.sql, settings checklist, per-environment project refs
│   ├── upstash/        database settings checklist
│   ├── docker/         Dockerfiles (distroless, non-root)
│   └── k8s/            manifests, network policies, pod security
└── docs/
    ├── context.md      this file
    └── runbooks/
```

Dependency direction is strictly inward: `apps → packages/* → packages/core`. `core` imports nothing from the network, database or framework layers.

---

## 5. Code standards

The bar is code a senior reviewer approves without comments of their own.

### Style

- Comments explain **why**, never **what**. Write one only for a non-obvious invariant, a security decision, a protocol quirk, or a workaround with a link. No banner comments, no commented-out code, no restating the function name in a docblock.
- Names carry meaning; if a block needs a comment to explain what it does, extract a well-named function instead.
- Small modules with one reason to change. Functions do one thing.
- Named exports only. No default exports, no barrel files that re-export everything.
- No classes for plain data. Use `readonly` types and factory functions; classes only where identity and lifecycle matter (clients, pools).
- Dependencies are passed in explicitly (factory functions taking a `deps` object). No global singletons except the config object and the logger root.

### TypeScript

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noPropertyAccessFromIndexSignature": true,
  "noFallthroughCasesInSwitch": true,
  "useUnknownInCatchVariables": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true,
  "module": "NodeNext",
  "target": "ES2024",
}
```

- `any` is banned (lint error). `unknown` plus Zod parsing at every boundary.
- Branded types for identifiers and money: `PaymentId`, `SubscriptionId`, `Stroops`, `StellarAddress`, `Memo`.
- Exhaustive `switch` on discriminated unions with a `never` check.
- Explicit return types on exported functions.
- Expected failures are values (`Result<T, E>` with typed error unions). Exceptions are for bugs and infrastructure failures only.

### Money

- All amounts are `bigint` stroops internally. Strings like `"19.9900000"` exist only at the edges.
- `parseAmount(s)` accepts at most 7 decimal places and rejects anything else; `formatAmount(n)` always emits exactly 7 decimals.
- Fiat amounts are `bigint` minor units plus an ISO 4217 code.
- Conversions round **up** to the nearest 0.01 USDC so the merchant is never short.
- `Number`, `parseFloat`, `toFixed` and floating-point math are banned in money code (lint rule on `packages/core/money`).

### Errors and logging

- Never log secrets, tokens, signatures, full request bodies, customer references or decrypted values. pino `redact` paths are configured centrally and tested.
- Errors returned to clients are stable codes (`payment_not_found`, `idempotency_conflict`) with no stack traces or internal detail.
- Every log line in a request or job carries `trace_id`, and `payment_id` or `subscription_id` where relevant.

### Lint and format

ESLint (typescript-eslint strict-type-checked, `eslint-plugin-security`), Prettier, `clippy -D warnings` for Rust. CI fails on any warning.

---

## 6. Domain model

### Payment (one-time)

```
pending ──(receipts ≥ due)──────────▶ confirmed
   │  └─(0 < receipts < due)─▶ underpaid ──(receipts ≥ due)──▶ confirmed
   │                              └────(expires)──────────▶ expired
   └──(expires_at passes, nothing received)──────────────▶ expired

expired ──(receipt arrives later)──▶ late_paid      (manual review)
confirmed ──(admin refund executed)──▶ refunded
```

Rules:

- Multiple receipts with the same memo accumulate. Confirmation happens when the sum reaches the amount due.
- Overpayment confirms the payment and records the excess for refund review; it never silently disappears.
- A receipt for an unknown memo, a missing memo, or a wrong asset is stored as `unmatched` and raises an alert.
- Transitions are conditional updates (`UPDATE ... WHERE status = $expected RETURNING`). A transition that affects zero rows is a no-op, never an error to retry blindly.

### Subscription

```
incomplete ──(on-chain subscribe confirmed)──▶ active
active ──(charge succeeds)──▶ active (period advances)
active ──(charge fails)──▶ past_due ──(retry succeeds)──▶ active
past_due ──(retries exhausted or grace ends)──▶ canceled
active | past_due ──(user or admin cancels)──▶ canceled
```

Rules:

- The price is locked into the subscription at creation. Plan price changes apply only to new subscriptions.
- No back-charging: a subscription recovering from `past_due` starts a fresh period at the successful charge.
- Retry schedule for failed charges: +1 day, +3 days, +5 days, then cancel. Configurable.
- `subscription.allowance_expiring` is emitted 14 days before the on-chain allowance expires.

### Quote

A payment's USDC amount is quoted at creation and locked until `expires_at` (default 20 minutes). If the fiat currency is USD, the rate is exactly 1. Otherwise an FX provider adapter returns the rate, which is stored on the payment for audit. The provider is ExchangeRate-API (exchangerate-api.com); its rate table is cached in Upstash for the provider's update period, and a non-USD quote is refused if the cached rate is older than the configured maximum age.

---

## 7. PostgreSQL (Supabase)

Supabase is used **only as a managed Postgres**. This service does not use Supabase Auth, Storage, Realtime, Edge Functions or the auto-generated Data API, and never uses the `anon` or `service_role` keys. It connects with its own least-privilege Postgres roles over TLS.

One Supabase project per environment (`dev`, `staging`, `prod`), never shared with the main RodiumAI app's project, so a mistake in one cannot touch the other's data.

### 7.1 Schema

All tables live in a dedicated `pay` schema that is **not** added to the Data API's exposed schemas. Row Level Security is enabled on every table with no policies, so even if the schema were exposed by mistake, the API roles would see nothing.

Primary keys are UUIDv7 generated **in the application**, not by the database. This works on any Postgres version Supabase runs, keeps IDs time-ordered for index locality, and lets the row ID be known before insert, which field encryption needs for its AAD (§12.2).

Migrations are plain, forward-only SQL files in `packages/db/migrations`, applied by the `rp_owner` role in CI/CD before deploy (Supabase CLI `db push` or the migration runner, never the dashboard SQL editor for production). Every migration must be backward compatible with the currently running release (expand, deploy, contract).

```sql
CREATE SCHEMA pay;
SET search_path = pay;

CREATE TYPE payment_status AS ENUM
  ('pending', 'underpaid', 'confirmed', 'expired', 'late_paid', 'refunded');
CREATE TYPE subscription_status AS ENUM
  ('incomplete', 'active', 'past_due', 'canceled');
CREATE TYPE charge_status AS ENUM
  ('scheduled', 'submitted', 'succeeded', 'failed');
CREATE TYPE receipt_match AS ENUM
  ('matched', 'unmatched', 'ignored');
CREATE TYPE outbox_status AS ENUM
  ('pending', 'delivered', 'dead');

CREATE TABLE payments (
  id                       uuid PRIMARY KEY,
  idempotency_key          text        NOT NULL UNIQUE,
  request_hash             bytea       NOT NULL,
  merchant_order_id        text        NOT NULL,
  customer_ref_enc         bytea       NOT NULL,
  customer_ref_bidx        bytea       NOT NULL,
  description              text        NOT NULL CHECK (char_length(description) <= 140),
  fiat_currency            char(3)     NOT NULL,
  fiat_amount_minor        bigint      NOT NULL CHECK (fiat_amount_minor > 0),
  fx_rate                  numeric(38,18) NOT NULL CHECK (fx_rate > 0),
  asset_code               text        NOT NULL,
  asset_issuer             text        NOT NULL,
  destination              text        NOT NULL,
  memo                     text        NOT NULL UNIQUE CHECK (octet_length(memo) <= 28),
  amount_due_stroops       bigint      NOT NULL CHECK (amount_due_stroops > 0),
  amount_received_stroops  bigint      NOT NULL DEFAULT 0 CHECK (amount_received_stroops >= 0),
  status                   payment_status NOT NULL DEFAULT 'pending',
  checkout_token_hash      bytea       NOT NULL UNIQUE,
  return_url               text        NOT NULL,
  expires_at               timestamptz NOT NULL,
  confirmed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);
CREATE INDEX payments_merchant_order_idx ON payments (merchant_order_id);
CREATE INDEX payments_customer_bidx_idx  ON payments (customer_ref_bidx);
CREATE INDEX payments_expiry_idx ON payments (expires_at)
  WHERE status IN ('pending', 'underpaid');

CREATE TABLE subscriptions (
  id                        uuid PRIMARY KEY,
  idempotency_key           text        NOT NULL UNIQUE,
  request_hash              bytea       NOT NULL,
  merchant_subscription_ref text        NOT NULL,
  customer_ref_enc          bytea       NOT NULL,
  customer_ref_bidx         bytea       NOT NULL,
  plan_code                 text        NOT NULL,
  contract_plan_id          integer     NOT NULL,
  price_stroops             bigint      NOT NULL CHECK (price_stroops > 0),
  interval_seconds          integer     NOT NULL CHECK (interval_seconds >= 86400),
  subscriber_address        text,
  contract_subscription_id  bigint      UNIQUE,
  status                    subscription_status NOT NULL DEFAULT 'incomplete',
  current_period_end        timestamptz,
  next_charge_at            timestamptz,
  allowance_expires_ledger  integer,
  failed_attempts           smallint    NOT NULL DEFAULT 0,
  checkout_token_hash       bytea       NOT NULL UNIQUE,
  return_url                text        NOT NULL,
  canceled_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- Migration 0003 (S6): canceled without on-chain ids is allowed (merchant cancels before the user subscribed).
  CHECK (status IN ('incomplete', 'canceled') OR (subscriber_address IS NOT NULL AND contract_subscription_id IS NOT NULL))
);
CREATE INDEX subscriptions_due_idx ON subscriptions (next_charge_at)
  WHERE status IN ('active', 'past_due');
CREATE INDEX subscriptions_customer_bidx_idx ON subscriptions (customer_ref_bidx);

CREATE TABLE subscription_charges (
  id               uuid PRIMARY KEY,
  subscription_id  uuid        NOT NULL REFERENCES subscriptions(id),
  period_index     integer     NOT NULL CHECK (period_index >= 0),
  amount_stroops   bigint      NOT NULL CHECK (amount_stroops > 0),
  status           charge_status NOT NULL DEFAULT 'scheduled',
  attempt          smallint    NOT NULL DEFAULT 1,
  tx_hash          bytea       CHECK (tx_hash IS NULL OR octet_length(tx_hash) = 32),
  failure_code     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_index, attempt)
);

CREATE TABLE chain_receipts (
  id                      uuid PRIMARY KEY,
  tx_hash                 bytea       NOT NULL CHECK (octet_length(tx_hash) = 32),
  item_index              integer     NOT NULL,
  ledger                  integer     NOT NULL,
  ledger_closed_at        timestamptz NOT NULL,
  source_address          text        NOT NULL,
  destination             text        NOT NULL,
  asset_code              text        NOT NULL,
  asset_issuer            text        NOT NULL,
  amount_stroops          bigint      NOT NULL CHECK (amount_stroops > 0),
  memo                    text,
  match                   receipt_match NOT NULL,
  payment_id              uuid REFERENCES payments(id),
  subscription_charge_id  uuid REFERENCES subscription_charges(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, item_index),
  CHECK (match <> 'matched' OR num_nonnulls(payment_id, subscription_charge_id) = 1)
);
CREATE INDEX chain_receipts_unmatched_idx ON chain_receipts (created_at) WHERE match = 'unmatched';

CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY,
  event_type       text        NOT NULL,
  aggregate_id     uuid        NOT NULL,
  payload          jsonb       NOT NULL,
  status           outbox_status NOT NULL DEFAULT 'pending',
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX outbox_due_idx ON outbox_events (next_attempt_at) WHERE status = 'pending';

CREATE TABLE ingest_cursors (
  source      text PRIMARY KEY,
  cursor      text        NOT NULL,
  ledger      integer     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY,
  actor       text        NOT NULL,
  action      text        NOT NULL,
  target_id   uuid,
  details     jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER charges_touch BEFORE UPDATE ON subscription_charges
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain_receipts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_cursors       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;
```

The service's own roles get access through explicit policies in §7.3. `anon`, `authenticated` and `service_role` get no policies and no grants, and no role has `BYPASSRLS`.

### 7.2 Write patterns

- Ingesting a receipt, updating the payment, and inserting the outbox event happen in **one transaction**. Receipts use `INSERT ... ON CONFLICT (tx_hash, item_index) DO NOTHING`; a conflict means the work is already done.
- Payment totals are updated with `amount_received_stroops = amount_received_stroops + $n` inside that transaction, never read-modify-write in application code.
- Workers claim rows with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` (due subscriptions, due outbox events, expiring payments).
- Only one ingester runs at a time, enforced with `pg_try_advisory_lock` on a fixed key. A second replica waits as a hot standby.
- Idempotent API: the same `Idempotency-Key` with the same `request_hash` returns the original response; with a different hash it returns `409 idempotency_conflict`.

### 7.3 Roles and privileges

Run as the Supabase `postgres` role via a migration. Passwords are 32+ random bytes from the secret store.

```sql
REVOKE ALL ON SCHEMA pay FROM PUBLIC, anon, authenticated, service_role;

CREATE ROLE rp_owner    LOGIN PASSWORD :'owner_pw';
CREATE ROLE rp_api      LOGIN PASSWORD :'api_pw';
CREATE ROLE rp_worker   LOGIN PASSWORD :'worker_pw';
CREATE ROLE rp_readonly LOGIN PASSWORD :'readonly_pw';

ALTER SCHEMA pay OWNER TO rp_owner;

ALTER ROLE rp_api      SET search_path = pay;
ALTER ROLE rp_worker   SET search_path = pay;
ALTER ROLE rp_readonly SET search_path = pay;
ALTER ROLE rp_api      SET statement_timeout = '5s';
ALTER ROLE rp_worker   SET statement_timeout = '30s';
ALTER ROLE rp_readonly SET statement_timeout = '60s';
ALTER ROLE rp_readonly SET default_transaction_read_only = on;
ALTER ROLE rp_api      SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE rp_worker   SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE rp_api      SET lock_timeout = '3s';
ALTER ROLE rp_worker   SET lock_timeout = '3s';

GRANT USAGE ON SCHEMA pay TO rp_api, rp_worker, rp_readonly;
GRANT SELECT, INSERT ON payments, subscriptions, outbox_events, audit_log TO rp_api;
GRANT SELECT ON chain_receipts, subscription_charges TO rp_api;
GRANT UPDATE (status, subscriber_address, contract_subscription_id, canceled_at) ON subscriptions TO rp_api;
GRANT SELECT, INSERT, UPDATE ON payments, subscriptions, subscription_charges, outbox_events, ingest_cursors TO rp_worker;
GRANT SELECT, INSERT ON chain_receipts, audit_log TO rp_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA pay TO rp_readonly;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments','subscriptions','subscription_charges',
                           'chain_receipts','outbox_events','ingest_cursors','audit_log']
  LOOP
    EXECUTE format('CREATE POLICY service_access ON pay.%I TO rp_api, rp_worker, rp_readonly USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
```

Table privileges, not policies, decide what each role can do; the policies only open RLS to the service roles and nobody else.

`chain_receipts` and `audit_log` are append-only for every runtime role: no `UPDATE` or `DELETE` is granted. `rp_readonly` can read encrypted columns only as ciphertext. Support tooling that needs a decrypted value goes through an audited admin endpoint.

### 7.4 Supabase project settings (checklist in `infra/supabase/settings.md`)

- **SSL enforcement on.** Clients use `sslmode=verify-full` with Supabase's CA certificate pinned in the image.
- **Network restrictions on:** only the egress IPs of the API and worker (and CI for migrations) may connect.
- **Data API:** `pay` is not in the exposed schemas. If nothing else in the project uses the Data API, disable it.
- Auth, Storage, Realtime and Edge Functions unused and left unconfigured.
- **Organization security:** SSO or MFA enforced for every member, minimal members on the production project, audit logs reviewed.
- `pg_stat_statements` enabled; slow-query monitoring through Supabase's query performance view.
- Compute size chosen so the connection limit covers the pools in §7.5 with headroom.
- Region in the same cloud region as the service's compute.

### 7.5 Connections (Supavisor)

| Process              | Connection                                                  | Why                                                                          |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| API                  | Supavisor **transaction mode** (port 6543)                  | Short queries, many processes                                                |
| Worker (jobs)        | Supavisor **transaction mode**                              | Same                                                                         |
| Ingester leader lock | Supavisor **session mode** (port 5432) or direct connection | `pg_try_advisory_lock` is session-scoped and must survive between statements |
| Migrations           | Direct or session mode                                      | DDL and session settings                                                     |

- Transaction mode does not support named prepared statements. Use plain parameterized queries (the default in `pg` with Kysely) and never enable statement naming.
- Pooler usernames have the form `rp_api.<project_ref>`.
- Client pool sizes: 10 per API process, 5 per worker process, 1 dedicated session connection for the leader lock.
- Session-level `SET` is forbidden in transaction mode; use `SET LOCAL` inside a transaction or per-role defaults (§7.3).

### 7.6 Backup and recovery

- **Point-in-time recovery add-on enabled** on production, on top of Supabase's daily backups.
- A weekly logical export (`pg_dump` of the `pay` schema) is encrypted with `age` using a key held outside Supabase and stored in separate object storage, so recovery does not depend on one vendor account.
- A restore drill into a scratch Supabase project runs monthly and is recorded in `docs/runbooks/database-restore.md`.

---

## 8. Redis (Upstash)

One Upstash Redis database per environment, accessed over HTTPS with `@upstash/redis`. Redis holds nothing that cannot be lost: Postgres stays authoritative for idempotency, payment state and jobs. If Upstash is unavailable, the API fails closed on HMAC nonce checks (rejects requests) and fails open on caching (reads Postgres directly).

### 8.1 Database settings

- Region matching the service compute and Supabase region.
- TLS is always on; the REST URL and token come from the secret store.
- **Eviction enabled**, because every key has a TTL and losing a cache entry is harmless. All writes go through a small wrapper that requires a TTL; there is no other way to write.
- A separate **read-only token** is not needed by this service; use only the standard token and rotate it on the schedule in §12.4.
- Fixed-price plan for production so bursts of rate-limit traffic cannot cause surprise bills; budget alert configured either way.
- Upstash console access restricted to the same people as the Supabase production project, with MFA.

### 8.2 Usage

| Key                        | Purpose                                               | TTL  | Failure behaviour                                    |
| -------------------------- | ----------------------------------------------------- | ---- | ---------------------------------------------------- |
| `rp:rl:api:{keyId}`        | API rate limit (`@upstash/ratelimit`, sliding window) | 60s  | fail open, with a lower in-process limit as backstop |
| `rp:rl:ip:{ip}`            | checkout rate limit per IP                            | 60s  | fail open, in-process backstop                       |
| `rp:nonce:{keyId}:{nonce}` | HMAC replay protection (`SET NX EX`)                  | 600s | **fail closed**                                      |
| `rp:status:{paymentId}`    | checkout status cache for polling                     | 5s   | read Postgres                                        |

Idempotency uses Postgres only (S6): the unique `idempotency_key` + `request_hash` check is one indexed query, and a Redis copy of the response would put live checkout URLs into Upstash. `rp:fx:usd` caches the ExchangeRate-API table until the provider's next update (fail open: read the provider).

### 8.3 Why there is no Redis queue

Every background job is a scan of Postgres state (due subscriptions, due outbox events, expiring payments), claimed with `FOR UPDATE SKIP LOCKED`. A Redis queue would duplicate that state, add a second source of truth, and generate constant polling commands that Upstash bills per request. If job volume later justifies a queue, add `graphile-worker` (Postgres-backed) before reintroducing Redis queues.

---

## 9. Internal API (main app → service)

Base path `/v1`. Reachable only from the main app's network over mTLS. Every request is also HMAC-signed so that a network-level misconfiguration alone cannot expose the API.

### 9.1 Request signing

Headers:

```
X-RP-Key-Id:     ak_2026_10
X-RP-Timestamp:  1760438400
X-RP-Nonce:      <22+ chars base64url, 128-bit random>
X-RP-Signature:  <base64url HMAC-SHA256>
Idempotency-Key: <client-generated, required on POST>
```

Canonical string, joined by `\n`:

```
METHOD
PATH_WITH_QUERY
TIMESTAMP
NONCE
hex(SHA-256(raw body))
```

The server rejects requests with clock skew over 300 seconds, a reused nonce, an unknown or revoked key ID, or a signature mismatch (compared with `crypto.timingSafeEqual`). Two key IDs can be active at once to allow rotation without downtime. Secrets are 32 random bytes.

### 9.2 Endpoints

```
POST /v1/payments
GET  /v1/payments/{id}
POST /v1/subscriptions
GET  /v1/subscriptions/{id}
POST /v1/subscriptions/{id}/cancel
GET  /v1/health/ready
```

`POST /v1/payments`

```json
{
  "merchant_order_id": "ord_8f2c",
  "customer_ref": "usr_19ab",
  "description": "RodiumAI Pro credits",
  "amount": { "currency": "USD", "value_minor": 1999 },
  "return_url": "https://app.rodiumai.example/billing/return"
}
```

`201 Created`

```json
{
  "id": "01929f3a-...",
  "status": "pending",
  "checkout_url": "https://pay.rodiumai.example/c/<token>",
  "amount_due": { "asset": "USDC", "value": "19.9900000" },
  "expires_at": "2026-10-14T12:20:00Z"
}
```

`POST /v1/subscriptions` takes `merchant_subscription_ref`, `customer_ref`, `plan_code` and `return_url`, and returns the same shape with `status: "incomplete"`.

Rules:

- `return_url` must match a configured origin allowlist exactly (scheme, host, port).
- `customer_ref` is encrypted before storage (§12) and is never returned in full.
- Error responses: `{ "error": { "code": "validation_failed", "message": "..." } }` with no internal detail.

---

## 10. Webhooks (service → main app)

### 10.1 Delivery

- Events are written to `outbox_events` in the same transaction as the state change, then dispatched by the worker.
- Retries with exponential backoff and jitter: 10s, 1m, 5m, 30m, 2h, 6h, 12h, then `dead` with an alert. A `dead` event can be replayed from the admin CLI.
- A `2xx` response marks delivery. Anything else, or a 10-second timeout, schedules a retry.
- Delivery is at-least-once. The main app must deduplicate on `id`.
- Claiming uses a lease (S7): one statement moves `next_attempt_at` 30 s ahead for the batch, and delivery runs outside any transaction, so a slow receiver never holds row locks. A crashed worker's events become due again when the lease ends.

### 10.2 Events

`payment.confirmed`, `payment.underpaid`, `payment.expired`, `payment.late_paid`, `payment.refunded`, `subscription.activated`, `subscription.renewed`, `subscription.past_due`, `subscription.canceled`, `subscription.allowance_expiring`.

```json
{
  "id": "01929f3b-...",
  "type": "payment.confirmed",
  "created_at": "2026-10-14T12:03:11Z",
  "data": {
    "payment_id": "01929f3a-...",
    "merchant_order_id": "ord_8f2c",
    "asset": "USDC",
    "amount_due": "19.9900000",
    "amount_received": "19.9900000",
    "tx_hashes": ["a1b2..."]
  }
}
```

### 10.3 Signature

```
RP-Signature: t=1760443391,k=whk_2026_10,s=<base64url Ed25519 signature>
```

The signature covers `"{t}.{raw_body}"`. The main app holds only the Ed25519 public keys (by `k`), rejects timestamps older than 5 minutes, verifies against the raw body bytes before parsing JSON, and deduplicates on `id`. The private key lives in the secret store and rotates quarterly with an overlap window.

### 10.4 Main app adapter checklist

- Store `payment_id` / `subscription_id` against the order or plan, exactly like a MoMo reference.
- Grant access only on `payment.confirmed`, `subscription.activated` and `subscription.renewed`, never on the browser return redirect.
- Fall back to `GET /v1/payments/{id}` if a webhook has not arrived within a few minutes of the user returning.
- Hide the crypto option when `/v1/health/ready` fails or the feature flag is off; MoMo continues unaffected.

---

## 11. Hosted checkout frontend

Served at `pay.<domain>` by the API process from a static Vite build. The page is intentionally small: no framework, no third-party scripts, no analytics, no fonts from external hosts.

### 11.1 Flow

One-time payment:

1. `GET /c/{token}` renders the page server-side with amount, memo, a SEP-7 `web+stellar:pay` URI and its QR code as inline SVG.
2. "Pay with Freighter" lazily imports the Freighter module; the user connects, the server builds the exact payment for that address (`POST /c/{token}/prepare`, sequence from Horizon), and the user signs. Mobile wallets pay from the QR / SEP-7 link instead; the ingester matches them by memo.
3. The browser posts the signed XDR to `POST /c/{token}/submit`. The server validates it (§13.3) and submits it to the network. The browser never talks to Stellar infrastructure directly.
4. The page polls `GET /c/{token}/status` (ETag, backoff from 3s to 15s) and redirects to `return_url` on a final state.

Subscription:

1. The server builds and simulates a `subscribe` invocation for the connected address and returns the unsigned XDR.
2. The user signs once. That signature authorizes `subscribe`, the nested `approve`, and the first period's transfer.
3. Same submit and polling path as above.

### 11.2 Checkout token

- 32 bytes, base64url, scoped to exactly one payment or subscription: `HMAC-SHA256(CHECKOUT_TOKEN_KEY, "rp.checkout.v1:{payment|subscription}:{id}")`. Indistinguishable from random without the key, and reproducible, so an idempotent replay of `POST /v1/payments` returns the original `checkout_url` although only the hash is stored (changed in S6; the API role cannot update payment rows, so a fresh random token could not be re-issued).
- Only its SHA-256 hash is stored. Lookup is by hash.
- Valid until the payment reaches a final state or 24 hours after creation, whichever is first.
- `Referrer-Policy: no-referrer` and log redaction of the `/c/*` path prevent token leakage.

### 11.3 Security headers

```
Content-Security-Policy:
  default-src 'none';
  script-src 'nonce-{per-request}' 'strict-dynamic';
  style-src 'self';
  img-src 'self' data:;
  connect-src 'self';
  form-action 'none';
  frame-ancestors 'none';
  base-uri 'none';
  require-trusted-types-for 'script';
  trusted-types default;
  upgrade-insecure-requests
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cache-Control: no-store
```

If a wallet module requires a CSP relaxation, add the narrowest possible exception, document why in `docs/security/csp.md`, and never add `'unsafe-inline'` or `'unsafe-eval'` to `script-src`. WalletConnect-based wallets are out of scope at launch because they require third-party network access.

### 11.4 Frontend rules

- Initial JS budget: 30 KB gzipped. The wallet kit chunk loads only on interaction.
- No `innerHTML` with dynamic data; build DOM with `textContent` and element APIs. Trusted Types enforce this.
- Nothing sensitive in `localStorage`, `sessionStorage` or cookies. The page needs no cookies at all.
- The page displays the amount, asset, destination and memo in plain text so the user can verify them in their wallet before signing.
- Accessible: keyboard navigable, visible focus, labelled controls, works with system light and dark themes.

---

## 12. Encryption and key management

### 12.1 In transit

- Public endpoints: TLS 1.3 only, HSTS preload, OCSP stapling. Enable the hybrid post-quantum key exchange `X25519MLKEM768` on the TLS terminator where supported, with `X25519` as fallback.
- Main app ↔ service: mTLS with a private CA, certificates rotated every 30 days by the platform (cert-manager or equivalent).
- Service ↔ Supabase: TLS with `sslmode=verify-full` and the pinned Supabase CA. Service ↔ Upstash: HTTPS only. Service ↔ signer: mTLS.
- Outbound to Stellar RPC/Horizon providers and the FX provider: TLS with certificate verification; no `rejectUnauthorized: false` anywhere (lint rule).

### 12.2 At rest

- Volumes and snapshots encrypted by the platform (AES-256).
- **Field-level envelope encryption** for personal or linkable data (`customer_ref_enc` and any future PII):
  - AES-256-GCM with a random 96-bit nonce per value.
  - Data keys are generated and wrapped by the KMS (AWS KMS). The KEK never leaves the KMS.
  - Stored format: `version(1) || key_id(16) || nonce(12) || ciphertext || tag(16)`.
  - AAD binds the ciphertext to its location: `"{table}.{column}.{row_id}"`. A ciphertext copied to another row fails to decrypt.
  - Rotation: new writes use the current key ID; a background job re-encrypts old rows; old keys are retired only after the job reports zero rows remaining.
- **Blind index** for lookups on encrypted fields: `HMAC-SHA256(bidx_key, normalized_value)`, with a key separate from the encryption keys.
- Supabase encrypts data and backups at rest (AES-256). The weekly logical export is additionally encrypted with `age` under a key held outside Supabase.

### 12.3 Hashing and tokens

- Checkout tokens, API nonces and idempotency keys are compared via SHA-256 hashes or constant-time comparison only.
- All randomness comes from `crypto.randomBytes` / `crypto.getRandomValues`. `Math.random` is banned (lint rule).

### 12.4 Secrets

- Stored in the platform secret store (AWS Secrets Manager), mounted at runtime, never baked into images, never in git, never in plain environment variables visible to other processes where avoidable.
- Every secret has an owner, a rotation period and a documented rotation procedure in `docs/runbooks/rotation.md`.

| Secret                                 | Holder        | Rotation                              |
| -------------------------------------- | ------------- | ------------------------------------- |
| API HMAC keys                          | API, main app | 90 days, overlapping                  |
| Webhook Ed25519 private key            | worker        | 90 days, overlapping                  |
| Field-encryption KEK                   | KMS only      | yearly, automatic                     |
| Blind-index key                        | API, worker   | only with full re-index               |
| Checkout token key                     | API, checkout | yearly; old tokens expire within 24 h |
| Field data keys (KMS-wrapped)          | API, worker   | with KEK rotation; re-encrypt job     |
| Keeper signing key                     | signer only   | 180 days or on any suspicion          |
| FX provider API key (ExchangeRate-API) | API           | yearly or on suspicion                |
| Supabase role passwords                | per service   | 90 days                               |
| Upstash REST token                     | API, worker   | 90 days                               |

---

## 13. Stellar integration

### 13.1 Accounts and roles

| Account              | Purpose                                              | Key custody                                                             |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Merchant (receiving) | Receives all USDC; has the USDC trustline            | No key on any server. Multisig 2-of-3 hardware wallets, master weight 0 |
| Treasury (cold)      | Periodic sweeps from merchant                        | Offline multisig                                                        |
| Keeper               | Pays fees and is the only caller allowed to `charge` | Signer service only; holds minimal XLM; balance alert                   |
| Contract admin       | Plans, pause, upgrade                                | Multisig account, offline signers                                       |

The receiving side needs only public keys. The only hot key in the system is the keeper, and its power is limited by the contract to charging subscriptions that are due, at their locked price, to the fixed merchant address.

### 13.2 One-time payment matching

- Destination is the merchant account. Asset is USDC identified by **code and issuer**, both read from configuration per network.
- Memo is `MEMO_TEXT`, format `RP` + 12 Crockford base32 characters (generated randomly, uniqueness enforced by the database). Matching normalizes by trimming and upper-casing.
- A payment counts if: the transaction succeeded, the operation is `payment` or `path_payment_strict_receive`/`path_payment_strict_send` to the merchant, the received asset is the configured USDC, and the memo matches. For path payments, the counted amount is the amount **received** by the merchant.
- Anything else to the merchant account (claimable balances, other assets, missing memo) is recorded as `unmatched` or `ignored` and alerted, never auto-credited.
- Stellar finality is final on ledger close; no confirmation depth is needed.

### 13.3 Validating XDR before submission

`POST /c/{token}/submit` must never become a free relay. Before submitting, the server decodes the envelope and checks:

- Network passphrase matches the configured network.
- For payments: exactly one operation, a `payment` of the exact USDC asset to the merchant, amount equal to the remaining due, memo equal to the payment memo, no other operations.
- For subscriptions: exactly one `invokeHostFunction` calling `subscribe` on the configured contract ID with the expected plan ID and the connected subscriber address.
- Time bounds present and no more than 5 minutes ahead; fee within the configured maximum.
- The transaction hash has not been submitted before.

Anything else returns `422 invalid_transaction` and is logged as a security event.

### 13.4 Ingestion

- An ingestion adapter interface (`LedgerSource`) hides the provider. The default implementation streams payments for the merchant account from a Horizon provider; an RPC-based implementation (`getTransactions` / `getEvents`) is maintained alongside it. Check SDF's current guidance on Horizon versus RPC at build time and make the preferred one the default (§17).
  - Decision (2026-10-15, S5): **Horizon stays the default for payments.** SDF's direction is RPC (Horizon → RPC migration guide; CAP-67 asset `transfer` events cover classic payments), and SDF testnet RPC does emit classic events, but its retention is ~2,090 ledgers (~3 h) versus ~1 year on Horizon. An outage longer than the RPC window would lose payments that only Horizon could backfill. The RPC source (`getEvents` on the USDC SAC + `getTransaction` for the memo) is maintained and tested against Quickstart; switch when a provider with ≥ 7 days retention and classic events is confirmed. Contract events (`sub_created`, `charged`, `canceled`) always come from RPC — Horizon does not serve them.
- The cursor is persisted in `ingest_cursors` in the same transaction as the receipts it covers, so restarts never skip or double-count.
- A reconciliation job re-scans the last 2,000 ledgers every 15 minutes and fixes any gaps idempotently.
- Contract events (`sub_created`, `charged`, `canceled`) are ingested the same way to keep subscription state in sync with the chain, including cancellations made directly from a user's wallet.
- Metric `ingest_lag_ledgers` alerts above 20.

### 13.5 Network configuration

```ts
type NetworkConfig = {
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly horizonUrl: string;
  readonly usdc: {
    readonly code: 'USDC';
    readonly issuer: StellarAddress;
    readonly contractId: string;
  };
  readonly merchant: StellarAddress;
  readonly subscriptionContractId: string;
  readonly maxFeeStroops: bigint;
  /** Soroban transactions (fee includes the resource fee); changed in S9. */
  readonly maxSorobanFeeStroops: bigint;
};
```

Testnet and mainnet configs live in separate files. The service refuses to start if the configured network passphrase does not match what the RPC endpoint reports.

---

## 14. Soroban subscription contract

### 14.1 Interface

```rust
pub fn __constructor(env: Env, admin: Address, token: Address, merchant: Address, keeper: Address);
pub fn set_plan(env: Env, plan_id: u32, price: i128, interval_secs: u64, active: bool) -> Result<(), Error>;
pub fn subscribe(env: Env, subscriber: Address, plan_id: u32, periods: u32, live_until_ledger: u32) -> Result<u64, Error>;
pub fn charge(env: Env, sub_id: u64) -> Result<ChargeOutcome, Error>;
pub fn cancel(env: Env, caller: Address, sub_id: u64) -> Result<(), Error>;
pub fn set_paused(env: Env, paused: bool);
pub fn set_keeper(env: Env, keeper: Address);
pub fn upgrade(env: Env, wasm_hash: BytesN<32>);
pub fn get(env: Env, sub_id: u64) -> Result<Subscription, Error>;
pub fn plan(env: Env, plan_id: u32) -> Result<Plan, Error>;
pub fn merchant(env: Env) -> Address;
pub fn is_paused(env: Env) -> bool;
```

Changed 2026-10-15 (S4), with reason: a separate `init` could be front-run between deployment and initialisation, letting anyone make themselves admin. The constructor runs atomically with deployment. Fallible functions return typed errors instead of panicking.

### 14.2 Behaviour

- `subscribe`: requires `subscriber.require_auth()`. Locks the plan's current price into the subscription, transfers the first period from subscriber to merchant, and calls `approve(subscriber, contract, price * periods, live_until_ledger)` on the USDC token contract. One user signature covers the whole call tree.
- `charge`: requires `keeper.require_auth()`. Fails unless the contract is unpaused, the subscription is active, and `ledger.timestamp() >= next_charge_at`. Calls `transfer_from(contract, subscriber, merchant, price)`. Advances `next_charge_at` by one interval, or to `now + interval` if the charge is more than one interval late (no back-charging). At most one period per call.
- `cancel`: callable by the subscriber or the admin. Marks the subscription canceled; the user may also revoke the allowance in their wallet.
- `set_plan`, `set_paused`, `set_keeper`, `upgrade`: admin only.
- Every state change emits an event with the subscription ID.

### 14.3 Invariants (each has a test)

- The recipient of every transfer is the merchant address set at `init`; there is no function to change it without an upgrade.
- A subscription's price never changes after creation.
- Two `charge` calls in the same period: the second fails.
- `charge` on a canceled or paused subscription fails without transferring.
- Arithmetic is checked; `price * periods` overflow aborts.
- Only the keeper can charge; only subscriber or admin can cancel; only admin can manage plans, pause and upgrade.

### 14.4 Engineering rules

- Instance storage for config, persistent storage for subscriptions. TTL is extended on every touch, and the worker extends TTLs of active subscriptions before they approach archival.
- `live_until_ledger` is computed by the backend from the current ledger and the network's maximum entry TTL, read from the network at runtime, never hardcoded.
- Release profile: `overflow-checks = true`, `panic = "abort"`, `opt-level = "z"`, `lto = true`, `codegen-units = 1`.
- `cargo clippy -D warnings`, `cargo audit`, `cargo deny check` in CI.
- Unit tests with the Soroban test environment, including auth tests (`mock_auths` with exact expected invocations, never `mock_all_auths` in security-relevant tests).
- No paid external audit (budget decision, 2026-10-15). Before mainnet the contract passes a self-run security review with free tooling: Scout (static analysis), Komet (property tests and proofs), `cargo-fuzz`/`proptest`, optionally Certora Sunbeam, plus a manual checklist — recorded in `docs/security/contract-review.md` against the exact WASM hash deployed. Mainnet runs with exposure caps (short allowances, per-payment and per-subscription price caps, gradual rollout). Upgrades go through the admin multisig after the same review.

### 14.5 Signer service

The signer exposes one operation over mTLS on the private network: sign a keeper transaction. It decodes the XDR and refuses to sign unless it is exactly one `invokeHostFunction` calling `charge` (or a TTL-extension operation) on the configured contract ID, with the keeper as source, a fee under the cap and time bounds under 5 minutes. It has no inbound internet access, no database access, and logs every signature request with its decision.

---

## 15. Workers and jobs

| Job                  | Trigger                            | Notes                                                            |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Ingest               | long-running, advisory-lock leader | §13.4                                                            |
| Reconcile            | every 15 min                       | idempotent re-scan                                               |
| Expire payments      | every 30 s                         | `SKIP LOCKED` batch on `payments_expiry_idx`                     |
| Charge subscriptions | every 60 s                         | claims due rows, simulates, asks signer, submits, records charge |
| Allowance warnings   | hourly                             | emits `subscription.allowance_expiring`                          |
| Extend contract TTLs | daily                              | for active subscriptions nearing archival                        |
| Dispatch webhooks    | every 5 s                          | from `outbox_events`                                             |
| Keeper balance check | every 5 min                        | alert below threshold                                            |

Charging always simulates first. A simulation failure (insufficient balance or allowance) records a failed charge with a code and moves the subscription to `past_due` without submitting. Before counting it, the worker reads the subscription on-chain (`get`): if it is active and not yet due, the failure is a schedule mismatch and `next_charge_at` is resynced instead (S9: contract error codes are per contract — the USDC SAC's insufficient-balance error is also `Error(Contract, #10)`, the same number as our `NotDue`).

Jobs run as in-process schedulers inside the worker; each claims rows with `FOR UPDATE SKIP LOCKED` in short transactions, so several worker replicas can run safely. All jobs are idempotent and safe to run twice. Graceful shutdown on `SIGTERM`: stop claiming, finish in-flight work within 25 seconds, release locks.

---

## 16. Vulnerability management (CVEs and zero-days)

No document or codebase can guarantee freedom from CVEs or zero-days; new vulnerabilities are discovered in existing software every day. The goal is to keep the known-vulnerability count at zero at release time, patch quickly, and limit the damage any unknown flaw can do.

### 16.1 Known vulnerabilities

- CI blocks merges on any **high or critical** finding from: `pnpm audit`, `osv-scanner`, Trivy (images and IaC), `cargo audit`, `cargo deny`, Semgrep and CodeQL (SAST), and gitleaks (secrets).
- A scheduled daily scan of `main` and of running images opens an issue for any new finding.
- Patch deadlines from disclosure: critical 48 hours, high 7 days, medium 30 days. Exceptions require a written risk acceptance with an expiry date.

### 16.2 Supply chain

- `pnpm` settings: `minimumReleaseAge` of 14 days (blocks freshly published, possibly malicious versions), lifecycle scripts disabled except an explicit `onlyBuiltDependencies` allowlist, `strict-peer-dependencies`, exact versions only.
- Installs in CI use `pnpm install --frozen-lockfile`. Lockfile changes require review.
- Renovate opens grouped update PRs respecting the 14-day age rule; security fixes for actively exploited issues may bypass the age rule after manual review of the release.
- Keep runtime dependencies minimal. Adding a dependency needs a justification in the PR: maintenance status, download count, transitive tree size, and whether 50 lines of our own code would do.
- Build produces a CycloneDX SBOM and SLSA provenance. Images are signed with cosign, and the cluster admission policy rejects unsigned images.
- GitHub Actions pinned by commit SHA, minimal `permissions`, OIDC for cloud access, no long-lived cloud keys in CI.

### 16.3 Limiting zero-day impact

- Distroless or Chainguard base images, rebuilt weekly even without code changes, non-root UID, read-only root filesystem, all Linux capabilities dropped, `seccomp: RuntimeDefault`, no shell in production images.
- Node flags: `--disallow-code-generation-from-strings`; evaluate the Node permission model (`--permission` with explicit allow lists) for the signer first, where the dependency tree is smallest.
- Kubernetes network policies: default deny; explicit egress allowlists (Supabase pooler host, Upstash REST host, Stellar providers, FX provider, main app webhook URL, KMS); the signer accepts traffic only from the worker and has no Supabase or Upstash access.
- WAF and per-IP rate limits in front of `pay.<domain>`; body size limit 16 KB on all endpoints.
- Separate processes for API, worker and signer so a compromise of one does not grant the others' privileges.
- Feature flag and contract `set_paused` provide a kill switch within one minute.

---

## 17. Facts to verify at build time

Things that change over time. Verify each against official sources when implementing and record the source in the PR:

- Circle's USDC issuer and SAC contract ID for testnet and mainnet — S11 (2026-10-16): mainnet issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` is listed in `circle.com/.well-known/stellar.toml` and the account's `home_domain` is `circle.com`; its SAC id `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` re-derived with `stellar contract id asset`; both match `packages/config/src/network.ts`.
- Current SDF guidance on Horizon versus RPC for payment ingestion, and the chosen provider's retention window.
- The network's current maximum entry TTL and fee settings.
- Which wallets support signing (and Soroban invocations) — S8: Freighter (extension; `signTransaction`, Soroban-capable) at launch; SEP-7 for mobile wallets. Re-check before adding more.
- Latest stable versions of every dependency in §3, respecting the 14-day age rule.
- The Postgres major version of each Supabase project, and that local development uses the same major.
- Supavisor's current ports, username format and prepared-statement support in transaction mode.
- Upstash's current eviction, ACL and pricing options for the chosen plan.
- ExchangeRate-API plan limits (requests, update frequency), response fields and supported currencies.
- Current versions and Soroban SDK compatibility of Scout, Komet and (if used) Certora Sunbeam — S10: Komet v0.1.89 does not support soroban-sdk 28 (`contracts/komet/README.md`); Scout 0.3.17 works.
- Legal and regulatory requirements for accepting digital-asset payments in each jurisdiction where RodiumAI operates.

---

## 18. Observability

- Structured JSON logs (pino) with central redaction; OpenTelemetry traces across API, worker and signer.
- Key metrics: `payments_created_total`, `payments_confirmed_total`, `receipts_unmatched_total`, `ingest_lag_ledgers`, `webhook_delivery_failures_total`, `outbox_pending`, `charges_failed_total`, `keeper_balance_xlm`, `signer_rejections_total`.
- Alerts: ingest lag, any unmatched receipt, any signer rejection, webhook dead letters, keeper balance low, error rate above baseline, certificate expiry within 14 days.
- Health: `/health/live` (process up) and `/health/ready` (Supabase, Upstash and ledger source reachable).

---

## 19. Testing

- **Unit**: all of `packages/core`, including property tests for money parsing, formatting, conversion and rounding.
- **Integration**: repositories and workers against a local Supabase stack (`supabase start`, same Postgres major as production) and a Redis container fronted by `serverless-redis-http` so the Upstash REST client runs unchanged; transaction and idempotency behaviour under concurrency.
- **Stellar local**: the Stellar Quickstart container for end-to-end payment and contract flows in CI.
- **Contract**: Rust tests for every invariant in §14.3, including auth failures.
- **Security tests**: HMAC replay, clock skew, bad signatures, XDR guard bypass attempts, CSP present on every response, log redaction.
- **Testnet E2E**: before every release, a scripted run of one-time payment, underpayment, expiry, subscription create, charge, failed charge and cancel.
- Coverage gate: 90% lines on `packages/core` and `packages/security`; coverage elsewhere is reviewed, not gated.

---

## 20. Runbooks (each in `docs/runbooks/`)

- Unmatched payment received: identify sender, contact path, refund or manual match with two-person approval and audit log entry.
- Refunds: manual, from treasury, two-person approval, recorded against the payment.
- Key rotation for every secret in §12.4.
- Suspected keeper compromise: `set_keeper` to a new key via admin multisig, revoke old key in signer, review recent charges.
- Incident kill switch: disable feature flag (main app hides crypto) and `set_paused` on the contract.
- Ingestion stuck or provider outage: switch `LedgerSource` provider, reconcile from last cursor.
- Database restore from Supabase PITR, and from the encrypted logical export if the Supabase account itself is unavailable.

---

## 21. Definition of done (every PR)

- Types strict, lint clean, no new comments that restate code.
- Tests added for new behaviour, including failure paths.
- No new dependency without the justification in §16.2.
- Security scans green.
- Migrations backward compatible.
- Any new secret, external host or capability recorded in §12.4, §16.3 network policy, and `docs/security/`.
- This file updated if a decision in §2 or a contract in §9–§10 changed.
