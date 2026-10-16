# Ingestion stuck or provider outage

The worker's ingest job reads merchant payments from one `LedgerSource` (`INGEST_SOURCE`, `horizon`
by default, or `rpc`). Only the advisory-lock leader ingests; other replicas wait. Progress is the
cursor row `payments:<source>` in `pay.ingest_cursors`, saved in the same transaction as the
receipts, so restarting or replaying never double-counts (`chain_receipts` is unique on
`(tx_hash, item_index)`).

## When to use

- `ingest_lag_ledgers` above 20 for more than a few minutes.
- Customers paid but payments stay `pending`; the Horizon or RPC provider reports an outage.

## Signals

- `ingest_lag_ledgers` (leader pod only; check `ingest_is_leader 1`), `receipts_applied_total` flat.
- Worker logs `job pass failed` with `job: "ingest"` or `"reconcile"`. **When the provider errors,
  the lag metric is not updated and keeps its last value**, so a flat `receipts_applied_total` with
  repeated `job pass failed` is the real signal.
- `reconcile_filled_total` / `reconcile_filled_gap` alert: reconciliation found missed receipts.

## Before you start

- `kubectl` on `rodium-pay`, `rp_readonly` for reads, `rp_owner` if a cursor must be edited.
- Know the retention: Horizon keeps about a year; **SDF testnet RPC keeps ~2,090 ledgers (~3 h)**.
  An RPC source can only backfill inside its provider's window.

## Steps

1. Look at the cursors and the network tip:
   ```sql
   SELECT source, cursor, ledger, updated_at FROM pay.ingest_cursors ORDER BY source;
   ```
   ```sh
   curl -s "$RP_STELLAR_HORIZON_URL/" | jq '.history_latest_ledger'
   kubectl -n rodium-pay logs deployment/rp-worker --since=15m | grep -E 'job pass failed|ingest leader'
   ```
2. If no pod is leader (`ingest_is_leader 0` everywhere), restart the worker:
   `kubectl -n rodium-pay rollout restart deployment/rp-worker`. The lock is session-scoped and
   is released when the old pod's session closes.
3. **Same source, other provider.** Set `RP_STELLAR_HORIZON_URL` (or `RP_STELLAR_RPC_URL`) to
   another provider in the overlay's `rp-config`, `kubectl apply -k infra/k8s/overlays/<env>`, then
   restart the worker. The cursor stays valid. The RPC URL must serve the configured network
   passphrase or the worker refuses to start; it is also used for contract events and charges.
4. **Switch source** (`horizon` ↔ `rpc`) only when no provider of the current kind works. Each
   source has its own cursor row, so tell the new one where to start:
   - Read `ledger` from the old row (`payments:horizon` or `payments:rpc`).
   - If the new source has **no** row yet, set `INGEST_START_LEDGER=<that ledger>` (required for
     `rpc`) together with `INGEST_SOURCE`:
     ```sh
     kubectl -n rodium-pay set env deployment/rp-worker INGEST_SOURCE=rpc INGEST_START_LEDGER=<ledger>
     ```
     (or the same two keys in the overlay; `INGEST_SOURCE` is not in `rp-config` today).
   - If it **has** an old row, `INGEST_START_LEDGER` is ignored. Move that row to the old ledger,
     as `rp_owner`, with an audit entry:
     ```sql
     BEGIN;
     UPDATE pay.ingest_cursors SET cursor = 'ledger:<ledger>', ledger = <ledger>, updated_at = now()
       WHERE source = 'payments:<new source>';
     INSERT INTO pay.audit_log (id, actor, action, details) VALUES (gen_random_uuid(),
       'admin:<name>', 'ingest.cursor_set', jsonb_build_object('source', 'payments:<new source>',
       'ledger', <ledger>, 'reason', '<incident>'));
     COMMIT;
     ```
   - For `rpc`, `<ledger>` must be inside the provider's retention. If the gap is older, stay on
     Horizon (another provider) or wait for it: switching would skip payments.
5. **Reconcile from the last cursor.** Restarting at a ledger already seen is safe: duplicates are
   no-ops. The reconcile job also re-scans the last 2,000 ledgers before the cursor every 15 min.
6. When the original provider is back, switch back the same way (step 4), starting the old source
   at the new source's `ledger`.

## Verify

- `ingest_lag_ledgers` back under 20 on the leader; `receipts_applied_total` rising.
- `updated_at` of the active cursor row moves forward.
- Payments created during the outage are `confirmed`; customer-reported hashes are in
  `chain_receipts` (`WHERE tx_hash = decode('<hex>', 'hex')`).

## Afterwards

- Remove `INGEST_START_LEDGER` once the new cursor exists (`kubectl set env ... INGEST_START_LEDGER-`).
- Check [unmatched-payment.md](unmatched-payment.md): payments that expired during the outage may
  now be `late_paid` and need a refund or merchant decision.
- Contract events (`contract:<CONTRACT_ID>` cursor) always come from RPC; if RPC was down longer
  than its retention, compare active subscriptions with on-chain `get` before trusting the schedule.
- Postmortem if lag exceeded 30 minutes or payments were late_paid because of it.
