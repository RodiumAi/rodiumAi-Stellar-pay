# Runbooks

One file per runbook listed in `docs/context.md` §20, plus key rotation for every secret in §12.4.

| Runbook                                      | Use it when                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [unmatched-payment.md](unmatched-payment.md) | `receipts_unmatched_total` rises or an `unmatched_receipt` alert fires: money arrived that no payment claimed. |
| [refunds.md](refunds.md)                     | Money has to go back to a payer (overpayment, late payment, unmatched receipt, merchant decision).             |
| [rotation.md](rotation.md)                   | A secret reaches its rotation date (§12.4), a person with access leaves, or a secret may have leaked.          |
| [keeper-compromise.md](keeper-compromise.md) | The keeper key may be exposed, or the keeper account sends transactions the worker did not ask for.            |
| [kill-switch.md](kill-switch.md)             | Something is wrong enough that new crypto payments and subscription charges must stop now.                     |
| [ingestion-stuck.md](ingestion-stuck.md)     | `ingest_lag_ledgers` is above 20, or the Horizon/RPC provider is down or returning errors.                     |
| [database-restore.md](database-restore.md)   | Data in Supabase is lost or corrupted, or the Supabase account is unavailable; also the monthly restore drill. |

## Shared conventions

Everything runs in the Kubernetes namespace `rodium-pay` (deployments `rp-api`, `rp-worker`,
`rp-signer`). Secrets live in AWS Secrets Manager under `rodium-pay/<app>/<NAME>` and are mounted
as files under `/run/secrets`; each app reads them once at start-up via `NAME_FILE`, so **a secret
change only takes effect after a restart**:

```sh
kubectl -n rodium-pay rollout restart deployment/rp-api
kubectl -n rodium-pay rollout status deployment/rp-api --timeout=5m
```

Non-secret settings are in the ConfigMaps `rp-config` and `rp-signer-config`. Change them in the
environment's overlay (`infra/k8s/overlays/<env>/kustomization.yaml`) and apply with
`kubectl apply -k infra/k8s/overlays/<env>`, never with `kubectl edit` (the next apply would undo
it). Only a `staging` overlay exists today.

Worker metrics: `kubectl -n rodium-pay port-forward deployment/rp-worker 9090:9090`, then
`curl -s localhost:9090/metrics`. Ingest metrics are only meaningful on the pod where
`ingest_is_leader 1`; port-forward to each pod (`pod/<name>`) if needed. Signer metrics listen on
port 9444 (`SIGNER_METRICS_HOST=0.0.0.0` in Kubernetes; only the monitoring namespace may reach it):
`kubectl -n rodium-pay port-forward deployment/rp-signer 9444:9444`.

Database: read with `rp_readonly` (read-only, 60 s statement timeout). Manual writes use `rp_owner`
(any pooler mode; wrap the work in one transaction), because `chain_receipts` and `audit_log` are
append-only for the runtime roles and `rp_worker` sessions are killed after 15 s idle in a
transaction. Let `psql` prompt for the password so it never lands in shell history:

```sh
psql "host=<pooler host> port=5432 dbname=postgres user=rp_owner.<project_ref> sslmode=verify-full sslrootcert=supabase-ca.crt"
```

Every manual write is done by one person inside `BEGIN … COMMIT`, with a second person reading the
output before `COMMIT`, and includes an `audit_log` row with `actor = 'admin:<name>'` (the same
convention as the webhook replay CLI, `apps/worker/src/replay.ts`).

Contract calls use stellar-cli. On testnet the admin identity is a local key; on mainnet the admin
is a multisig account, so build the transaction with `--build-only`, have each signer sign it, then
send it (see [kill-switch.md](kill-switch.md)).
