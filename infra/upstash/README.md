# Upstash Redis — per-environment checklist (context §8.1)

Upstash has no infrastructure-as-code here; whoever creates or reviews a database ticks
this list and records the result in the environment's change log. One database per
environment (`rodium-pay-staging`, `rodium-pay-production`).

## Create

- [ ] **Region** matches the service compute and the Supabase project (e.g. AWS `eu-west-1`).
      A cross-region hop adds latency to every API call (nonce check is on the hot path).
- [ ] **TLS**: Upstash REST is HTTPS only. Use the **REST URL** (`https://…upstash.io`), never
      the `redis://` endpoint; the service only speaks REST (`@upstash/redis`).
- [ ] **Eviction enabled** (Configuration → Eviction). Every key has a TTL (§8.2) and the
      `KvStore` wrapper refuses writes without one, so eviction can only drop harmless entries.
- [ ] **Plan**: fixed-price plan for production, so a rate-limit burst cannot cause a surprise
      bill. Pay-as-you-go is fine for staging.
- [ ] **Budget alert** configured on the account (both plans), sent to the on-call channel.
- [ ] **Read-only token**: not created; the service uses only the standard token.

## Wire up

- [ ] `UPSTASH_REDIS_REST_URL` in the overlay's `rp-config` (not secret).
- [ ] Standard token in AWS Secrets Manager as `rodium-pay/shared/UPSTASH_REDIS_REST_TOKEN`
      (mounted for `rp-api`, read via `UPSTASH_REDIS_REST_TOKEN_FILE`). Never in git, never
      in a plain environment variable.
- [ ] Egress: the Upstash host is in the environment's FQDN allowlist
      (`infra/k8s/base/cilium-fqdn.yaml.example`) where the CNI supports it.
- [ ] Verify from a running API pod: `GET /v1/health/ready` reports Upstash `ok`.

## Access

- [ ] Console access limited to the same people as the Supabase production project.
- [ ] MFA enforced for every member of the Upstash team.
- [ ] Token rotation every 90 days, per [rotation.md](../../docs/runbooks/rotation.md).

## What lives in Redis (for reviewers)

Only short-lived keys, all with TTLs (§8.2): `rp:rl:api:{keyId}` and `rp:rl:ip:{ip}` (60 s),
`rp:nonce:{keyId}:{nonce}` (600 s, fail closed), `rp:status:{paymentId}` (5 s) and
`rp:fx:usd` (until the provider's next update). Postgres stays authoritative; losing the
whole database costs a few seconds of rate-limit history and cache warmth.
