# StelPay testnet staging on AWS — what exists

Live at **https://stelpay.forge.rodiumai.io** (docs at `/`, API at `/v1`, checkout at `/c/…`), on
the **Stellar testnet**. Deployed 2026-10-16 into RodiumAI's AWS account `330990434320`,
region `eu-west-1`, next to the existing services — which it shares only the ECS cluster and the
load balancer with. Every resource is tagged `project = rodium-pay`.

## Inventory

| Resource                                  | Name / id                                                                                                | Where to check in the console                 | ≈ per month |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------- |
| ECS service (1 task: api, worker, signer) | `rodium-pay-staging` in `rodiumai-cluster`, **Fargate Spot**, 0.25 vCPU / 1 GB                           | ECS → Clusters → rodiumai-cluster → Services  | $3–4        |
| Public IPv4 of the task                   | assigned per task (no NAT)                                                                               | EC2 → Network interfaces (tag `project`)      | $3.65       |
| Task definition                           | `rodium-pay-staging` (revisions; images pinned by digest)                                                | ECS → Task definitions                        | free        |
| Load balancer rule                        | `rodiumai-alb` · HTTPS:443 · priority **4** · host `stelpay.forge.rodiumai.io`                           | EC2 → Load balancers → Listeners → Rules      | ~$0         |
| Target group                              | `rodium-pay-api-tg` (IP, port 8080, health `/health/live`)                                               | EC2 → Target groups                           | free        |
| Security group                            | `rodium-pay-sg` (`sg-0ed8bbe317a283ecc`): in 8080 from the ALB group only; out 443, 6543                 | EC2 → Security groups                         | free        |
| IAM role                                  | `rodium-pay-ecs` (execution + task): pull our 3 images, read our secret, write our logs, KMS wrap/unwrap | IAM → Roles                                   | free        |
| IAM role                                  | `rodium-pay-github-ecr`: GitHub Actions (main) pushes images                                             | IAM → Roles                                   | free        |
| Secret                                    | `rodium-pay/staging/app` (16 keys)                                                                       | Secrets Manager                               | $0.40       |
| KMS key                                   | `alias/rp-field-kek` (yearly rotation)                                                                   | KMS → Customer managed keys                   | $1          |
| ECR repositories                          | `rodiumai/stellar-pay-{api,worker,signer,backup}` (immutable, keep 30)                                   | ECR → Private repositories                    | cents       |
| Logs                                      | `/ecs/rodium-pay` (7-day retention)                                                                      | CloudWatch → Log groups                       | <$0.10      |
| Alarms + email                            | `rodium-pay-no-running-task`, `rodium-pay-unhealthy-target` → SNS `rodium-pay-alerts`                    | CloudWatch → Alarms; SNS → Topics             | $0.20       |
| **Total**                                 |                                                                                                          | Billing → Cost Explorer, filter tag `project` | **≈ $8–9**  |

The `*.forge.rodiumai.io` rule was moved from priority 4 to 5 (its content is unchanged) so the
StelPay rule is matched first; `stelpay` is therefore a reserved forge subdomain. DNS needs no
record: the existing `*.forge` wildcard already points at the load balancer.

## Inside the task

- **api** (port 8080, the only port the load balancer reaches) — docs, `/v1` API, checkout.
- **worker** — ingests payments from Horizon, matches them, delivers webhooks, charges
  subscriptions; becomes ingest leader through a lease row in Postgres.
- **signer** — listens on `localhost:9443` (mTLS, CN `rp-worker`); never reachable from outside
  the task. Holds the testnet keeper key.
- Database: Supabase project `sovqyegoxvmnqiomlbzq` over the transaction pooler (port 6543), TLS
  verified against the Supabase root CA built into the images. Redis: Upstash (REST).

## Deploy a new version

Merging to `main` builds, scans and signs new images and pushes them to ECR. Then:

```sh
aws login --region eu-west-1
DRY_RUN=1 scripts/deploy/ecs-staging.sh            # shows what would change
scripts/deploy/ecs-staging.sh                       # deploys origin/main (api, worker, signer)
scripts/deploy/ecs-staging.sh <commit> api          # only the API container, a given commit
```

Only `rodium-pay-staging` is redeployed (about 1–3 minutes of downtime for StelPay; nothing else
restarts). To roll back, run it with the previous commit. After a deploy, `pnpm e2e:remote` runs
the full testnet end-to-end check against the live service.

## Placeholders to replace when the main app is ready

| Setting              | Now                                   | Set to                                  |
| -------------------- | ------------------------------------- | --------------------------------------- |
| `WEBHOOK_URL`        | `https://webhooks.invalid/rodium-pay` | the main app's webhook endpoint (https) |
| `RETURN_URL_ORIGINS` | `https://rodiumai.io`                 | the main app's web origin(s)            |

Both are plain environment variables in the task definition: register a revision with the new
values (same procedure as the deploy script) and update the service. Webhook events created
before then are retried and finally kept as dead letters; they can be replayed.

## Remove everything (in this order)

1. ECS: set `rodium-pay-staging` desired count to 0, then delete the service; deregister its task
   definitions.
2. Load balancer: delete rule priority 4 (`stelpay.forge.rodiumai.io`), optionally move
   `*.forge.rodiumai.io` back to priority 4; delete target group `rodium-pay-api-tg`.
3. CloudWatch alarms `rodium-pay-*`, SNS topic `rodium-pay-alerts`, log group `/ecs/rodium-pay`.
4. Security group `rodium-pay-sg`; IAM roles `rodium-pay-ecs`, `rodium-pay-github-ecr`.
5. Secret `rodium-pay/staging/app` (7-day recovery window); KMS key `alias/rp-field-kek`
   (schedule deletion, 7–30 days — data encrypted with it becomes unreadable).
6. ECR repositories `rodiumai/stellar-pay-*`.

None of these steps touches the other services in `rodiumai-cluster`.
