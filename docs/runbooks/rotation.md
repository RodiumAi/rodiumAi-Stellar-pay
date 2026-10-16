# Key rotation

Covers every secret in context §12.4 (and `docs/security/secrets.md`), plus the mTLS certificates.

## When to use

- A rotation date is due (period per secret below), a person with access leaves, or a secret may
  have leaked (then rotate now, and treat it as an incident).

## Signals

- The rotation calendar; a gitleaks finding; CloudTrail showing an unexpected `GetSecretValue`.
- Certificate expiry within 14 days (§18; from cert-manager's own metrics, this service has none).

## Before you start

- AWS access to `secretsmanager:PutSecretValue` on the entry, `kubectl` on `rodium-pay`, and the
  provider console where relevant. A second person for production.
- Never paste a secret into chat, a ticket or a command line. Write values to a private temp dir
  and upload with `file://`; the apps strip one trailing newline:
  ```sh
  umask 077; d="$(mktemp -d)"
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" > "$d/new"
  aws secretsmanager put-secret-value --secret-id <name> --secret-string "file://$d/new"
  rm -rf "$d"
  ```
- Apps read secrets once at start-up: restart the holder after every change
  (`kubectl -n rodium-pay rollout restart deployment/<app>` + `rollout status`).

## API HMAC keys — `rodium-pay/api/API_HMAC_KEYS` — 90 days, overlapping

Format `id:secret,id:secret`, at most two entries, ids match `ak_[a-z0-9_]{1,32}` (e.g.
`ak_2027_01`), secrets are 32 random bytes base64url. Holders: `rp-api` and the main app.

1. If two keys are already active, first remove the older one (step 5) once it is unused.
2. Generate the new secret into `$d/new`, fetch the current value into `$d/current`
   (`aws secretsmanager get-secret-value --secret-id rodium-pay/api/API_HMAC_KEYS --query SecretString --output text > "$d/current"`),
   then write both: `printf '%s,%s:%s' "$(cat "$d/current")" ak_<yyyy_mm> "$(cat "$d/new")" > "$d/both"`
   and `put-secret-value ... "file://$d/both"`. Restart `rp-api`.
3. Hand the new id and secret to the main app team through their secret store; they switch to it.
4. Wait until the old id is unused. The API does not log key ids per request; the only trace is the
   Upstash rate-limit key containing `rp:rl:api:<old id>`, which disappears a minute after the last
   use (Upstash console → Data Browser).
5. Write only the new `id:secret` pair, restart `rp-api`. Verify: a request signed with the old id
   gets `401`.

## Webhook Ed25519 key — `rodium-pay/worker/WEBHOOK_SIGNING_KEY_PEM` + `WEBHOOK_SIGNING_KEY_ID` — 90 days, overlapping

The worker signs with one key (`RP-Signature: t=…,k=<id>,s=…`); the overlap is on the main app,
which accepts public keys by `k`.

1. `openssl genpkey -algorithm ed25519 -out "$d/whk.pem"` and
   `openssl pkey -in "$d/whk.pem" -pubout -out whk_<yyyy_mm>.pub.pem` (the public key is not secret).
2. Main app adds `whk_<yyyy_mm>` → public key, keeping the old one. Confirm with them.
3. Upload the private PEM to `rodium-pay/worker/WEBHOOK_SIGNING_KEY_PEM`, set
   `WEBHOOK_SIGNING_KEY_ID=whk_<yyyy_mm>` in the overlay's `rp-config`, apply, restart `rp-worker`.
   Retries are re-signed on each attempt, so all deliveries now use the new key.
4. Verify `webhooks_delivered_total` rising and `webhook_delivery_failures_total` flat; after a day the main
   app removes the old public key.

## Field-encryption KEK — AWS KMS `alias/rp-field-kek` (`AWS_KMS_KEY_ID`) — yearly, automatic

```sh
KEY=$(aws kms describe-key --key-id alias/rp-field-kek --query KeyMetadata.KeyId --output text)
aws kms enable-key-rotation --key-id "$KEY" --rotation-period-in-days 365
aws kms get-key-rotation-status --key-id "$KEY"        # KeyRotationEnabled: true
```

KMS keeps old key material, so data keys wrapped before a rotation still unwrap; no restart. On
suspicion, `aws kms rotate-key-on-demand --key-id "$KEY"` and rotate the data keys below. This does
not revoke old material: a truly compromised KEK needs a new KMS key and every data key re-wrapped,
for which no tool exists yet.

## Field data keys — `rodium-pay/shared/FIELD_DATA_KEYS` + `FIELD_DATA_KEY_CURRENT` — with KEK rotation

`FIELD_DATA_KEYS` is `hexid:wrapped,hexid:wrapped`; `FIELD_DATA_KEY_CURRENT` (in `rp-config`) picks
the key for new writes. Holder in the manifests: `rp-api` only.

1. From a repo checkout with dependencies installed and AWS credentials for the KEK:
   `AWS_REGION=<region> AWS_KMS_KEY_ID=alias/rp-field-kek node apps/api/scripts/aws-data-key.mjs`.
   It round-trips the key and prints only the wrapped value and its id.
2. Append the printed `id:wrapped` to `FIELD_DATA_KEYS` (fetch, append with a comma, put), restart
   `rp-api`. Every instance can now decrypt the new key.
3. Set `FIELD_DATA_KEY_CURRENT=<id>` in the overlay, apply, restart `rp-api`. The API refuses to
   start if the current id is not in `FIELD_DATA_KEYS`.
4. **Never remove old ids.** The re-encrypt job of §12.2 does not exist yet (only
   `needsReencryption` in `packages/security/src/envelope.ts`), so old rows still need old keys.

## Blind-index key — `rodium-pay/shared/BLIND_INDEX_KEY` — only with full re-index

Every `customer_ref_bidx` is `HMAC(key, normalized customer_ref)`; a new key breaks every lookup
until all rows are recomputed from the decrypted `customer_ref_enc`. No re-index tool exists. Do
not rotate on a schedule; on compromise, write and review a one-off job that recomputes
`payments.customer_ref_bidx` and `subscriptions.customer_ref_bidx` under the new key, and switch all
`rp-api` pods at once during a maintenance window.

## Checkout token key — `rodium-pay/api/CHECKOUT_TOKEN_KEY` — yearly

Single 32-byte key; no overlap. Put a new value and restart `rp-api`. Existing checkout links keep
working (only the token hash is stored). An idempotent replay of a create request made before the
switch re-derives a link with the new key that will not open; tell the main app to keep the
original `checkout_url`. Links expire with the payment (`PAYMENT_TTL_SECONDS`, default 20 min).

## Keeper signing key — `rodium-pay/signer/KEEPER_SECRET` — 180 days or on suspicion

Follow [keeper-compromise.md](keeper-compromise.md); the planned rotation uses the same steps.

## ExchangeRate-API key — `rodium-pay/api/EXCHANGERATE_API_KEY` — yearly or on suspicion

Generate a new key in the ExchangeRate-API dashboard (letters and digits, 8–64 chars), put it,
restart `rp-api`, then revoke the old key in the dashboard. Verify one payment can be created in
the environment (it needs a fresh rate). The `rp:fx:usd` cache bridges the restart.

## Supabase role passwords — `DATABASE_URL_*` entries — 90 days

| Role          | Where the password lives                                                                    |
| ------------- | ------------------------------------------------------------------------------------------- |
| `rp_api`      | `rodium-pay/api/DATABASE_URL_API`                                                           |
| `rp_worker`   | `rodium-pay/worker/DATABASE_URL_WORKER` and `rodium-pay/worker/DATABASE_URL_WORKER_SESSION` |
| `rp_owner`    | the migration pipeline's secret (not defined in `infra/k8s`)                                |
| `rp_readonly` | the support team's secret store                                                             |

One role at a time, in a quiet window (Postgres has one password per role, so there is no overlap):

1. As `postgres` in `psql`: `\password rp_api` (prompts; sends only a hash).
2. Immediately put the new URL(s) for that role (password URL-encoded) and restart the holder.
   Open connections survive; new ones fail until the restart.
3. Verify `/v1/health/ready` (API) or worker logs without `job pass failed`.

`infra/supabase/bootstrap-roles.sql` can also reset all four at once (needs all four settings).

## Upstash REST token — `rodium-pay/shared/UPSTASH_REDIS_REST_TOKEN` — 90 days

Holder in the manifests: `rp-api` only. Reset the token in the Upstash console, put it, restart
`rp-api` at once. Until the restart, HMAC nonce checks fail closed and signed API calls are
rejected, so do it in a quiet window and warn the main app. Verify one signed API call succeeds.

## mTLS certificates — `rp-worker-mtls`, `rp-signer-mtls` — 30 days, cert-manager

cert-manager renews them from the private CA. The worker and signer re-read their certificate
files every 60 s and switch to a renewed certificate without a restart (log line "mTLS … certificate
reloaded"). Both export `mtls_cert_not_after_timestamp_seconds`; the alert fires below 14 days,
which means renewal or reload is stuck. Check:

```sh
kubectl -n rodium-pay get secret rp-worker-mtls -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -noout -subject -enddate     # CN must stay rp-worker
```

The `Certificate`/`Issuer` objects and the main app ↔ API mTLS are not in this repo yet.

## Afterwards

- One `audit_log` row per rotation (`action = 'secret.rotate'`, `details` with the secret name and
  approver, never the value); update the rotation calendar. A leak gets a postmortem.
