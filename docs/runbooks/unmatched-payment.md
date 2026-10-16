# Unmatched payment received

Money reached the merchant account but the ingester could not tie it to a payment. It is stored in
`pay.chain_receipts` with `match = 'unmatched'` and is **never** credited automatically (§13.2).

## When to use

- The `unmatched_receipt` log alert or a rise in `receipts_unmatched_total`.
- A customer says "I paid but my order is not confirmed" and gives a transaction hash.

## Signals

- Worker metric `receipts_unmatched_total`; log lines with `alert: 'unmatched_receipt'` carrying a
  `reason` (`no_memo`, `unknown_memo`, `invalid_transition` for a refunded payment, `wrong_asset`,
  `non_text_memo`) or `unparseable_amount`. The reason is **only in the log**, not in the table.
- `unparseable_amount` receipts are logged with `tx_hash` but not stored; look them up on Horizon.

## Before you start

- Read access with `rp_readonly`; write access with `rp_owner` ([README.md](README.md#shared-conventions)).
- A second person to review the match or refund before `COMMIT`. There is no admin CLI for manual
  matching yet; this runbook uses SQL.

## Steps

1. List open unmatched receipts (not yet resolved by an audit entry):
   ```sql
   SELECT r.id, encode(r.tx_hash, 'hex') AS tx, r.item_index, r.ledger_closed_at, r.source_address,
          r.asset_code, r.asset_issuer, r.amount_stroops / 1e7 AS amount, r.memo
   FROM pay.chain_receipts r
   WHERE r.match = 'unmatched'
     AND NOT EXISTS (SELECT 1 FROM pay.audit_log a WHERE a.target_id = r.id
                     AND a.action IN ('receipt.manual_match', 'receipt.refunded'))
   ORDER BY r.created_at;
   ```
2. Look at the transaction: `curl -s "$RP_STELLAR_HORIZON_URL/transactions/<tx>/operations"`.
3. **Identify the sender.** Stellar addresses are pseudonymous; find the customer through payments
   this address already made, then the order in the main app:
   ```sql
   SELECT p.id, p.merchant_order_id, p.memo, p.status, p.created_at
   FROM pay.chain_receipts r JOIN pay.payments p ON p.id = r.payment_id
   WHERE r.source_address = '<G...>' AND r.match = 'matched';
   ```
   A memo with a typo usually lands near the intended one: `SELECT id, memo, status,
amount_due_stroops FROM pay.payments WHERE created_at > now() - interval '2 days' ORDER BY memo;`
4. **Contact path.** Never contact via the chain. Give the main app support team the
   `merchant_order_id`; they contact the customer through the account that placed the order. A
   customer who reached us first must confirm the order, amount and transaction hash.
5. **Decide**, with the second person: manual match (USDC from the right customer for a known,
   unrefunded payment), or refund ([refunds.md](refunds.md)). Wrong-asset receipts (`asset_code`
   not `USDC` or another issuer) can only be refunded.
6. **Manual match.** Work out the new status with the rules in `packages/core/src/payment.ts`:
   `pending`/`underpaid` → `late_paid` if `ledger_closed_at >= expires_at`, else `confirmed` when
   the total covers `amount_due_stroops`, else `underpaid`; `confirmed` stays `confirmed` (excess
   goes to refund review); `expired`/`late_paid` → `late_paid`; `refunded` → do not match.
   ```sql
   BEGIN;
   SET LOCAL search_path = pay;
   \set rid '<receipt id>'
   \set pid '<payment id>'
   SELECT id, match, amount_stroops, ledger_closed_at FROM chain_receipts WHERE id = :'rid' FOR UPDATE;
   SELECT id, status, amount_due_stroops, amount_received_stroops, expires_at FROM payments WHERE id = :'pid' FOR UPDATE;
   UPDATE chain_receipts SET match = 'matched', payment_id = :'pid'
     WHERE id = :'rid' AND match = 'unmatched';                                   -- expect UPDATE 1
   UPDATE payments SET
     amount_received_stroops = amount_received_stroops + (SELECT amount_stroops FROM chain_receipts WHERE id = :'rid'),
     status = '<new status>',
     confirmed_at = CASE WHEN '<new status>' = 'confirmed'
       THEN (SELECT ledger_closed_at FROM chain_receipts WHERE id = :'rid') ELSE confirmed_at END
     WHERE id = :'pid' AND status = '<old status>';                               -- expect UPDATE 1
   -- Only if the status changed to confirmed, underpaid or late_paid: notify the main app.
   INSERT INTO outbox_events (id, event_type, aggregate_id, payload)
   SELECT gen_random_uuid(), 'payment.<new status>', p.id, jsonb_build_object(
     'payment_id', p.id, 'merchant_order_id', p.merchant_order_id, 'asset', p.asset_code,
     'amount_due', (p.amount_due_stroops::numeric / 1e7)::numeric(38,7)::text,
     'amount_received', (p.amount_received_stroops::numeric / 1e7)::numeric(38,7)::text,
     'tx_hashes', (SELECT jsonb_agg(encode(r.tx_hash, 'hex') ORDER BY r.ledger, r.item_index)
                   FROM chain_receipts r WHERE r.payment_id = p.id))
   FROM payments p WHERE p.id = :'pid';
   INSERT INTO audit_log (id, actor, action, target_id, details) VALUES (gen_random_uuid(),
     'admin:<your name>', 'receipt.manual_match', :'rid', jsonb_build_object('payment_id', :'pid',
     'approved_by', '<second person>', 'incident', '<ticket link>', 'reason', '<why>'));
   -- second person reviews every result above, then:
   COMMIT;
   ```
   `gen_random_uuid()` gives a v4 UUID, not the app's v7; both are valid `uuid` values.

## Verify

- The receipt query in step 1 no longer lists it; `GET /v1/payments/<pid>` shows the new status.
- The outbox row is delivered: `SELECT status, attempts, last_error FROM pay.outbox_events WHERE
aggregate_id = '<pid>' ORDER BY created_at DESC LIMIT 1;` → `delivered`.

## Afterwards

- One `audit_log` row per resolved receipt (match, or `receipt.refunded` from [refunds.md](refunds.md)).
- Repeated `no_memo` or typo cases: raise with the checkout/wallet UX owner. Postmortem only if money
  was at risk or a customer waited more than one working day.
