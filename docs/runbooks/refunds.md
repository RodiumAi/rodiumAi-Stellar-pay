# Refunds

Refunds are manual. They are paid from the **treasury** account (offline multisig, §13.1), never
from the merchant account and never by any service: no server holds a key that can send USDC.

## When to use

- A confirmed payment must be returned (merchant decision, dispute, duplicate order).
- Overpayment on a confirmed payment (the excess), or money for an `expired`/`late_paid` payment.
- An unmatched receipt that cannot be matched ([unmatched-payment.md](unmatched-payment.md)),
  including wrong-asset receipts (refund in the asset that was received).

## Signals

- Request from the main app support team with the `payment_id` or `merchant_order_id`.
- Payments with `status = 'late_paid'`, or with `amount_received_stroops > amount_due_stroops`.

## Before you start

- Two people: one prepares, one approves. Both must be treasury signers or have one available.
- There is no refund tool or refunds table in the code. The refund is a treasury transaction plus a
  database record made with SQL as `rp_owner` ([README.md](README.md#shared-conventions)).
- **Get the destination from the customer**, confirmed through the main app account. The
  `source_address` of the receipt is often an exchange hot wallet; sending there without the
  exchange's deposit memo loses the money.

## Steps

1. Load the facts:
   ```sql
   SELECT p.id, p.merchant_order_id, p.status, p.amount_due_stroops, p.amount_received_stroops,
          encode(r.tx_hash, 'hex') AS tx, r.source_address, r.amount_stroops
   FROM pay.payments p LEFT JOIN pay.chain_receipts r ON r.payment_id = p.id
   WHERE p.id = '<payment id>';
   ```
2. Agree the amount in writing (incident ticket): full `amount_received_stroops`, or only the excess
   over `amount_due_stroops`. The treasury pays the network fee; do not deduct it.
3. Build the payment from the treasury (amount in stroops; check `stellar tx new payment --help`):
   ```sh
   stellar tx new payment --source <TREASURY_G_ADDRESS> --network <net> --build-only \
     --destination <CUSTOMER_G_ADDRESS> --asset USDC:<USDC issuer> --amount <stroops> \
     [--memo-text <exchange deposit memo>] > refund.xdr
   ```
   Both people check destination, asset, amount and memo in `stellar tx decode < refund.xdr`.
4. Sign with the required treasury signers (hardware wallets), then `stellar tx send`. Note the hash.
5. Record it. A **full refund of a `confirmed` payment** moves it to `refunded` (the only refund
   transition in `packages/core/src/payment.ts`) and tells the main app:
   ```sql
   BEGIN;
   SET LOCAL search_path = pay;
   \set pid '<payment id>'
   UPDATE payments SET status = 'refunded' WHERE id = :'pid' AND status = 'confirmed'; -- expect UPDATE 1
   INSERT INTO outbox_events (id, event_type, aggregate_id, payload)
   SELECT gen_random_uuid(), 'payment.refunded', p.id, jsonb_build_object(
     'payment_id', p.id, 'merchant_order_id', p.merchant_order_id, 'asset', p.asset_code,
     'amount_due', (p.amount_due_stroops::numeric / 1e7)::numeric(38,7)::text,
     'amount_received', (p.amount_received_stroops::numeric / 1e7)::numeric(38,7)::text,
     'tx_hashes', (SELECT jsonb_agg(encode(r.tx_hash, 'hex') ORDER BY r.ledger, r.item_index)
                   FROM chain_receipts r WHERE r.payment_id = p.id))
   FROM payments p WHERE p.id = :'pid';
   INSERT INTO audit_log (id, actor, action, target_id, details) VALUES (gen_random_uuid(),
     'admin:<your name>', 'payment.refund', :'pid', jsonb_build_object(
     'refund_tx_hash', '<hash>', 'amount_stroops', <stroops>, 'destination', '<G...>',
     'kind', 'full', 'approved_by', '<second person>', 'incident', '<ticket link>'));
   COMMIT;   -- after the second person has read every result
   ```
   **Partial refunds and refunds of non-confirmed payments** (excess, `late_paid`, `expired`) leave
   the payment status unchanged: insert only the `audit_log` row with `action = 'payment.refund'`
   and `kind` `'excess'` or `'late'`, and tell the main app support team directly.
   **Unmatched receipts:** insert one `audit_log` row with `action = 'receipt.refunded'` and
   `target_id` = the `chain_receipts.id`; the receipt row itself is append-only and stays `unmatched`.

## Verify

- `curl -s "$RP_STELLAR_HORIZON_URL/transactions/<refund hash>"` shows `"successful": true`.
- `SELECT action, details FROM pay.audit_log WHERE target_id = '<id>' ORDER BY created_at;`
- For full refunds: the `payment.refunded` outbox row reaches `delivered`.

## Afterwards

- Customer and main app support informed with the refund hash.
- Monthly: sum of `payment.refund` amounts in `audit_log` matches treasury outflows.
- A refund caused by a bug gets a postmortem.
