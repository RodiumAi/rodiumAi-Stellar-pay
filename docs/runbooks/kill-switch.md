# Incident kill switch

Stops new crypto payments and subscription activity within minutes (context §16.3). Money that
customers already sent is still recorded; nothing is lost by pulling the switch.

## When to use

- A security incident in the API, worker, signer, contract or a provider (Stellar, Supabase, KMS).
- Wrong amounts, wrong destinations or double charges are being seen and the cause is unknown.
- Any time the on-call engineer is unsure whether continuing is safe. Pulling it is cheap.

## Signals

- `charges_failed_total` or `signer_rejections_total` jumping; `signer_rejection` log alerts.
- `receipts_unmatched_total` rising quickly, `webhook_dead` alerts, error rate above baseline.
- A report from the main app team, a merchant or a customer.

## Before you start

- Access: the main app's feature-flag console; `kubectl` on the `rodium-pay` namespace; the
  contract admin (testnet: stellar-cli identity; mainnet: the admin multisig signers).
- Open an incident channel. The first two steps can be done by one person; resuming needs two.

## Steps

1. **Hide crypto in the main app.** Turn off the main app's crypto-payments feature flag. This is
   the main switch: it stops new payments and subscriptions being created. The flag lives in the
   main app, not in this repo; this service has no flag of its own.
2. **Optional: stop subscription jobs in the worker.** While the contract is paused the charge job
   asks `is_paused` after a failed simulation and defers the charge (`failure_code = 'paused'`,
   log `alert: contract_paused`) without counting a failure, so subscriptions stay `active` and
   are charged once the pause lifts. Only if you also want no keeper traffic at all (charge,
   contract events, allowance warnings, TTL extension, keeper balance), remove `SIGNER_URL`:
   ```sh
   kubectl -n rodium-pay set env deployment/rp-worker SIGNER_URL-
   kubectl -n rodium-pay rollout status deployment/rp-worker
   ```
3. **Pause the contract** (stops `subscribe` and `charge` on-chain; `cancel` still works):
   ```sh
   stellar contract invoke --id <CONTRACT_ID> --source <admin identity> --network testnet \
     -- set_paused --paused true
   ```
   On mainnet the admin is a multisig account. Build, sign with each required signer, then send
   (check `stellar tx --help` for your CLI version):
   ```sh
   stellar contract invoke --id <CONTRACT_ID> --source <ADMIN_G_ADDRESS> --network mainnet \
     --build-only -- set_paused --paused true > pause.xdr
   stellar tx simulate --network mainnet < pause.xdr > pause.sim.xdr
   stellar tx sign --network mainnet --sign-with-ledger < pause.sim.xdr > pause.s1.xdr   # signer 1
   stellar tx sign --network mainnet --sign-with-ledger < pause.s1.xdr > pause.s2.xdr    # signer 2
   stellar tx send --network mainnet < pause.s2.xdr
   ```
4. **Last resort only:** if the API itself is the problem, scale it to zero. This also takes down
   open checkout pages and `GET` polling:
   ```sh
   kubectl -n rodium-pay scale deployment/rp-api --replicas=0
   ```

## What keeps running

- Ingest and reconcile: payments sent to the merchant are still recorded and confirmed.
- Payment expiry and webhook dispatch: the main app still learns about confirmations.
- On-chain `cancel` by subscribers (their wallet) and by the admin.
- Without `SIGNER_URL`, contract events are not ingested; they are picked up from the
  `contract:<CONTRACT_ID>` cursor when the jobs come back (testnet RPC keeps only ~3 h of events;
  see [ingestion-stuck.md](ingestion-stuck.md) if the pause is longer).

## Verify

```sh
stellar contract invoke --id <CONTRACT_ID> --source <any identity> --network <net> -- is_paused
# expect: true
kubectl -n rodium-pay set env deployment/rp-worker --list | grep SIGNER_URL   # expect: nothing
```

On the worker metrics (see [README.md](README.md#shared-conventions)), `charges_succeeded_total`
and `charges_failed_total` stop changing; `receipts_applied_total` keeps rising with traffic.

## Resume (two people)

1. Agree the cause is fixed and write it in the incident channel.
2. `set_paused --paused false` (same command as step 3); check `is_paused` returns `false`.
3. Restore `SIGNER_URL` by re-applying the overlay: `kubectl apply -k infra/k8s/overlays/<env>`;
   watch `charges_succeeded_total` rise and `charges_failed_total` stay flat.
4. Turn the main app flag back on; create one small test payment end to end.

## Afterwards

- `audit_log` row for each switch (`action` `incident.pause` / `incident.resume`, details with the
  transaction hash and incident link), written as in [README.md](README.md#shared-conventions).
- Check for subscriptions wrongly moved to `past_due` during the incident:
  `SELECT id, status, failed_attempts FROM pay.subscriptions WHERE status = 'past_due' AND updated_at > '<start>';`
- Postmortem within five working days.
