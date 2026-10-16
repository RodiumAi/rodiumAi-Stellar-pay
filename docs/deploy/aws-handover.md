# AWS deployment handover (ECR + ECS Fargate)

For the teammate who runs RodiumAI's AWS account. It lists everything the crypto payment
service needs, in the order to create it. Nothing here needs Kubernetes.

| Fact        | Value                                                               |
| ----------- | ------------------------------------------------------------------- |
| AWS account | `330990434320` (RodiumAi)                                           |
| Region      | `eu-west-1` (Ireland) — same region as the Supabase project         |
| Registry    | Amazon ECR, private, `330990434320.dkr.ecr.eu-west-1.amazonaws.com` |
| Runtime     | Amazon ECS on Fargate (assumed; tell us if the account uses EC2)    |
| Network     | testnet first (staging), mainnet later                              |
| Database    | Supabase project `sovqyegoxvmnqiomlbzq`, already set up             |

## 1. The four services

| Service | Image (ECR repository)        | Runs as                          | Port | Health check                                          |
| ------- | ----------------------------- | -------------------------------- | ---- | ----------------------------------------------------- |
| API     | `rodiumai/stellar-pay-api`    | ECS service, 2 tasks, behind ALB | 8080 | `GET /health/live`; readiness `GET /v1/health/ready`  |
| Worker  | `rodiumai/stellar-pay-worker` | ECS service, 2 tasks             | 9090 | `GET /health/live` (container check)                  |
| Signer  | `rodiumai/stellar-pay-signer` | ECS service, **1 task**          | 9443 | TCP 9443 (mTLS-only; HTTP probes have no client cert) |
| Backup  | `rodiumai/stellar-pay-backup` | Scheduled task, weekly           | —    | exit code                                             |

Sizes to start with (Fargate): API and worker 0.25 vCPU / 512 MB, signer 0.25 vCPU / 512 MB,
backup 0.25 vCPU / 1 GB. All images are linux/amd64, run as user 65532 (backup: 70), and are
built for a **read-only root filesystem** — set `readonlyRootFilesystem: true` on every
container definition. The images have no shell; there is nothing to `exec` into.

## 2. ECR repositories

Create four **private** repositories, matching the existing `rodiumai/*` naming:

```
rodiumai/stellar-pay-api
rodiumai/stellar-pay-worker
rodiumai/stellar-pay-signer
rodiumai/stellar-pay-backup
```

Settings for each: tag immutability **Immutable**, scan on push **on**, encryption AES-256
(default). Lifecycle rule: keep the last 30 images. Images are pushed by GitHub Actions
(`.github/workflows/images.yml`) on every merge to `main` and weekly, tagged
`<commit>-<run number>`, **cosign-signed** with an SBOM attestation (signatures use the OCI
referrers API, so immutability does not block them). **Deploy by digest**, not by tag; each
workflow run prints the digests in its summary.

## 3. GitHub → ECR sign-in (OIDC, no stored keys)

1. IAM → Identity providers → add **OpenID Connect**: provider URL
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com` (skip if the
   account already has it).
2. IAM role `rodium-pay-github-ecr` with this trust policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::330990434320:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
             "token.actions.githubusercontent.com:sub": "repo:RodiumAi@282585446/rodiumAi-Stellar-pay@1420652748:ref:refs/heads/main"
           }
         }
       }
     ]
   }
   ```

   The repository uses GitHub's **immutable subject** format (org and repo IDs), so the `sub`
   must be exactly as above — the name-only form `repo:RodiumAi/rodiumAi-Stellar-pay:…` is
   refused. Check with `gh api repos/RodiumAi/rodiumAi-Stellar-pay/actions/oidc/customization/sub`.

   Permissions: `ecr:GetAuthorizationToken` on `*`, and on the four repositories only:
   `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`,
   `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`.

3. Done on 2026-10-16 (repositories and role created, variable set). For reference: we set the GitHub repository variable
   `AWS_ECR_ROLE_ARN=arn:aws:iam::330990434320:role/rodium-pay-github-ecr`; from then on every
   release also lands in ECR.

## 4. KMS key (field encryption)

The API encrypts personal fields (e.g. the customer reference) with data keys that are wrapped
by one KMS key. The key never leaves KMS; the API can only ask it to wrap/unwrap.

- KMS → Create key: symmetric, encrypt/decrypt, alias **`alias/rp-field-kek`**,
  **automatic yearly rotation on**.
- Key policy: account root as administrator; allow `kms:Encrypt` and `kms:Decrypt` only to the
  API task role (section 5), with the condition
  `"kms:EncryptionContext:purpose": "rp.field-data-key.v1"`.
- After the API role exists, we create the wrapped data key with
  `AWS_KMS_KEY_ID=alias/rp-field-kek node apps/api/scripts/aws-data-key.mjs` (run by someone with
  that role or temporary admin access) and store the output in Secrets Manager (section 6).

## 5. IAM roles for the services

ECS uses two kinds of role. The **task execution role** lets ECS pull the image, read the
secrets it injects and write logs. The **task role** is what the running app may do itself.

| Role                     | Kind      | Allows                                                                                                                          |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `rodium-pay-exec-api`    | execution | ECR pull of `stellar-pay-api`; `secretsmanager:GetSecretValue` on `rodium-pay/api/*` and `rodium-pay/shared/*`; CloudWatch Logs |
| `rodium-pay-exec-worker` | execution | ECR pull of `stellar-pay-worker`; secrets `rodium-pay/worker/*`; logs                                                           |
| `rodium-pay-exec-signer` | execution | ECR pull of `stellar-pay-signer`; secrets `rodium-pay/signer/*` **only**; logs                                                  |
| `rodium-pay-exec-backup` | execution | ECR pull of `stellar-pay-backup`; secrets `rodium-pay/backup/*`; logs                                                           |
| `rodium-pay-task-api`    | task      | `kms:Encrypt`, `kms:Decrypt` on `alias/rp-field-kek` (encryption context condition above)                                       |
| `rodium-pay-task-worker` | task      | nothing                                                                                                                         |
| `rodium-pay-task-signer` | task      | nothing                                                                                                                         |
| `rodium-pay-task-backup` | task      | `s3:PutObject` on `arn:aws:s3:::<backup-bucket>/staging/*` only (no read, no delete)                                            |

## 6. Secrets Manager

One secret per value, plain text. ECS injects them as environment variables
(container definition → `secrets`). Never put them in task definition `environment`.

| Secret name                                  | Env var                    | Who    | How to produce                                                         |
| -------------------------------------------- | -------------------------- | ------ | ---------------------------------------------------------------------- |
| `rodium-pay/api/API_HMAC_KEYS`               | `API_HMAC_KEYS`            | API    | `ak_<yyyy_mm>:<32 random bytes base64url>`; share with the main app    |
| `rodium-pay/api/CHECKOUT_TOKEN_KEY`          | `CHECKOUT_TOKEN_KEY`       | API    | 32 random bytes, base64url                                             |
| `rodium-pay/api/EXCHANGERATE_API_KEY`        | `EXCHANGERATE_API_KEY`     | API    | from exchangerate-api.com                                              |
| `rodium-pay/api/DATABASE_URL_API`            | `DATABASE_URL_API`         | API    | from `.env` after `pnpm db:setup:supabase` (see note on `sslrootcert`) |
| `rodium-pay/shared/BLIND_INDEX_KEY`          | `BLIND_INDEX_KEY`          | API    | 32 random bytes, base64url                                             |
| `rodium-pay/shared/FIELD_DATA_KEYS`          | `FIELD_DATA_KEYS`          | API    | output of `aws-data-key.mjs` (wrapped — not the plain key)             |
| `rodium-pay/shared/UPSTASH_REDIS_REST_TOKEN` | `UPSTASH_REDIS_REST_TOKEN` | API    | Upstash console                                                        |
| `rodium-pay/worker/DATABASE_URL_WORKER`      | `DATABASE_URL_WORKER`      | worker | from `.env` after setup                                                |
| `rodium-pay/worker/WEBHOOK_SIGNING_KEY_PEM`  | `WEBHOOK_SIGNING_KEY_PEM`  | worker | Ed25519 private key (PKCS#8 PEM); public key goes to the main app      |
| `rodium-pay/worker/WORKER_TLS_KEY`           | `WORKER_TLS_KEY`           | worker | mTLS, section 7                                                        |
| `rodium-pay/worker/WORKER_TLS_CERT`          | `WORKER_TLS_CERT`          | worker | mTLS                                                                   |
| `rodium-pay/worker/WORKER_TLS_CA`            | `WORKER_TLS_CA`            | worker | mTLS (CA certificate only, not its key)                                |
| `rodium-pay/signer/KEEPER_SECRET`            | `KEEPER_SECRET`            | signer | the keeper Stellar secret key (`S…`)                                   |
| `rodium-pay/signer/SIGNER_TLS_KEY`           | `SIGNER_TLS_KEY`           | signer | mTLS                                                                   |
| `rodium-pay/signer/SIGNER_TLS_CERT`          | `SIGNER_TLS_CERT`          | signer | mTLS                                                                   |
| `rodium-pay/signer/SIGNER_TLS_CA`            | `SIGNER_TLS_CA`            | signer | mTLS (CA certificate only)                                             |
| `rodium-pay/backup/DATABASE_URL_BACKUP`      | `DATABASE_URL`             | backup | `rp_readonly` URL from `.env` (`DATABASE_URL_READONLY`)                |

- The `*_TLS_*` settings accept the PEM text itself (or a file path), so they work as injected
  environment variables.
- Database URLs from `.env` end in `sslrootcert=<path on your laptop>`. In Secrets Manager use
  the path inside the image instead: `sslrootcert=%2Fapp%2Fcerts%2Fsupabase-root-2021-ca.crt`
  (backup image: `%2Fetc%2Fssl%2Fsupabase-root-2021-ca.crt`). The public Supabase root CA is
  built into the images.
- The `rodium-pay/signer/*` secrets must be readable by the signer's execution role and nothing
  else.

## 7. mTLS between worker and signer

The signer only accepts the worker's client certificate (CN `rp-worker`). Without cert-manager,
use the repo script with a long-lived CA and 30-day certificates:

```sh
SIGNER_DNS=signer.rodium-pay.local CA_DAYS=365 ./scripts/dev-mtls.sh ./mtls-staging
# monthly: new leaf certificates from the same CA
REUSE_CA=1 SIGNER_DNS=signer.rodium-pay.local ./scripts/dev-mtls.sh ./mtls-staging
```

Put `signer.key`/`signer.crt`/`ca.crt` into the signer secrets and `worker.key`/`worker.crt`/
`ca.crt` into the worker secrets, then redeploy both. Keep `ca.key` offline (a password
manager vault), never in AWS. Both services export `mtls_cert_not_after_timestamp_seconds`;
alert below 14 days.

## 8. Network

- VPC with **private subnets** for all tasks (no public IPs) and a **public ALB** for the API.
  NAT gateway for outbound traffic.
- **Cloud Map** private namespace `rodium-pay.local`; register the signer service as
  `signer` so the worker uses `SIGNER_URL=https://signer.rodium-pay.local:9443`.
- Security groups (these replace the Kubernetes network policies):

| Group          | Inbound                                       | Outbound                                                           |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `sg-alb`       | 443 from the internet                         | 8080 to `sg-api`                                                   |
| `sg-api`       | 8080 from `sg-alb`                            | 443 and 6543 to the internet (Supabase, Upstash, Stellar, FX, KMS) |
| `sg-worker`    | 9090 from the metrics collector only          | 9443 to `sg-signer`; 443 and 6543 to the internet                  |
| `sg-signer`    | 9443 from `sg-worker` only; 9444 from metrics | 443 to `sg-endpoints` only (no internet)                           |
| `sg-backup`    | none                                          | 6543 and 443 to the internet                                       |
| `sg-endpoints` | 443 from the groups above                     | —                                                                  |

- The signer must have **no internet access**. Fargate still needs to pull its image, read
  secrets and write logs, so add **VPC interface endpoints** (`ecr.api`, `ecr.dkr`,
  `secretsmanager`, `logs`) plus the **S3 gateway endpoint** (ECR layers), and put the signer
  in a subnet whose route table has no NAT route.
- TLS on the ALB: certificate from ACM, policy `ELBSecurityPolicy-TLS13-1-2-2021-06` or newer
  (TLS 1.3, with the post-quantum hybrid policy when your region offers it), HTTP → HTTPS
  redirect. Health check path `/health/live`.
- Two hostnames: the API (main app → service) and the checkout (`CHECKOUT_BASE_URL`, users'
  browsers). Both point at the API service; the checkout page is served by the API under `/c/`.

## 9. Configuration (plain environment variables)

Non-secret settings go in the task definition `environment`. Values for staging (testnet):

| Variable                                          | API | Worker | Signer | Example / note                                      |
| ------------------------------------------------- | --- | ------ | ------ | --------------------------------------------------- |
| `NODE_ENV`                                        | ✓   | ✓      | ✓      | `production`                                        |
| `LOG_LEVEL`                                       | ✓   | ✓      | ✓      | `info`                                              |
| `RP_STELLAR_NETWORK`                              | ✓   | ✓      | ✓      | `testnet`                                           |
| `RP_STELLAR_RPC_URL`, `RP_STELLAR_HORIZON_URL`    | ✓   | ✓      |        | SDF testnet defaults; a provider URL on mainnet     |
| `MERCHANT_ADDRESS`                                | ✓   | ✓      | ✓      | merchant Stellar account (`G…`)                     |
| `SUBSCRIPTION_CONTRACT_ID`                        | ✓   | ✓      | ✓      | deployed contract (`C…`)                            |
| `MAX_FEE_STROOPS`, `MAX_SOROBAN_FEE_STROOPS`      | ✓   | ✓      | ✓      | `100000`, `20000000`                                |
| `MAX_PAYMENT_USDC`, `MAX_SUBSCRIPTION_PRICE_USDC` | ✓   | ✓      | ✓      | exposure caps, e.g. `500`, `100`                    |
| `SUBSCRIPTION_APPROVE_PERIODS`                    | ✓   | ✓      |        | `3`                                                 |
| `FX_SUPPORTED_FIAT`, `FX_MAX_RATE_AGE_SECONDS`    | ✓   |        |        | `USD,GHS`, `93600`                                  |
| `PORT`, `CHECKOUT_BASE_URL`, `RETURN_URL_ORIGINS` | ✓   |        |        | `8080`, `https://pay.<domain>`, main app origin(s)  |
| `PAYMENT_TTL_SECONDS`, `SUBSCRIPTION_PLANS`       | ✓   |        |        | `1200`, JSON plan list (see `.env.example`)         |
| `UPSTASH_REDIS_REST_URL`                          | ✓   |        |        | `https://<db>.upstash.io`                           |
| `AWS_KMS_KEY_ID`, `FIELD_DATA_KEY_CURRENT`        | ✓   |        |        | `alias/rp-field-kek`, data key id (hex)             |
| `WEBHOOK_URL`, `WEBHOOK_SIGNING_KEY_ID`           |     | ✓      |        | main app webhook endpoint (https), key id           |
| `SIGNER_URL`, `KEEPER_ADDRESS`                    |     | ✓      |        | `https://signer.rodium-pay.local:9443`, keeper `G…` |
| `SIGNER_METRICS_HOST`                             |     |        | ✓      | `0.0.0.0` (security group limits who reaches 9444)  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                     | ✓   | ✓      |        | optional: ADOT/collector for traces                 |

Full descriptions: `.env.example`. Every service validates its settings at start and exits with
a clear "Invalid configuration" list if something is missing.

## 10. Backups and scheduled work

- S3 bucket for backups in `eu-west-1`: versioning on, **Object Lock** (compliance, 35 days),
  block public access, lifecycle to Glacier after 30 days.
- EventBridge Scheduler → ECS RunTask of `stellar-pay-backup` weekly (Sunday 03:23 UTC) with
  `AGE_RECIPIENTS=age1…` (public key; the private key stays offline) and
  `BACKUP_S3_URI=s3://<backup-bucket>/staging/` and `OUT_DIR=/scratch`, with an ephemeral
  volume mounted at `/scratch` (the root filesystem is read-only; only the encrypted file is
  written there, uploaded and deleted).
- Monthly: restore drill (`docs/runbooks/database-restore.md`).

## 11. Monitoring

- Logs: CloudWatch Logs, one log group per service, 30-day retention. Logs are JSON; secrets are
  redacted by the app.
- Metrics: the services expose Prometheus text at `:9090/metrics` (worker), `:9444/metrics`
  (signer). Scrape them with the CloudWatch agent (Prometheus mode) or an ADOT collector into
  Amazon Managed Prometheus; the alert rules are in `infra/observability/alerts.yaml` (load the
  `spec.groups` part into AMP, or translate the expressions to CloudWatch alarms).
- Minimum alarms: no ingest leader, ingest lag, any unmatched receipt, any signer rejection,
  webhook dead letters, keeper balance low, API 5xx rate, certificate expiry < 14 days.

## 12. First deploy checklist

1. ECR repositories, OIDC role → send us the role ARN; we enable the push.
2. KMS key + `rodium-pay-task-api` role → we create the wrapped data key.
3. Secrets (section 6), VPC/security groups/endpoints (section 8), Cloud Map namespace.
4. Task definitions (read-only root FS, the roles above, health checks, image **digests**).
5. Deploy signer → worker → API. Check: API `/v1/health/ready` is `ready`; worker log
   `became ingest leader`; signer log `signer listening (mTLS)`.
6. Run `pnpm e2e:release` against staging, then tell the main-app team the API base URL, the
   HMAC key and the webhook public key.

Questions about the service: see `README.md` and `docs/integration.md`.
