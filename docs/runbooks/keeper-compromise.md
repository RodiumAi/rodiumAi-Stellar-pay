# Suspected keeper compromise

The keeper is the only hot key (§13.1). The contract lets it do one thing: `charge` subscriptions
that are due, at their locked price, to the fixed merchant. A thief can also burn the keeper's XLM
on fees. Replacing the key is cheap; do it on any suspicion.

## When to use

- The keeper account (`KEEPER_ADDRESS`) shows transactions the worker did not request.
- `KEEPER_SECRET` may have been exposed (logs, laptop, leaked backup, departing staff with access).
- Planned 180-day rotation (§12.4) — same steps, without the incident parts.

## Signals

- `keeper_balance_xlm` dropping faster than charges explain; `keeper_balance_low` alert.
- `signer_rejections_total` rising or `signer_rejection` alerts (someone probing the signer).
- Horizon history of the keeper account with unknown transactions.

## Before you start

- Contract admin: testnet stellar-cli identity; mainnet the admin multisig signers.
- AWS access to put `rodium-pay/signer/KEEPER_SECRET`; `kubectl` on `rodium-pay`.
- A second person for the `set_keeper` transaction and the review.

## Steps

1. **Stop charging first.** The signer refuses transactions whose source is not its own key, so
   while the worker and signer disagree on the keeper every charge would fail and push
   subscriptions to `past_due`. Follow [kill-switch.md](kill-switch.md) step 2 (remove
   `SIGNER_URL`). Pausing the contract is not required: after step 3 the old key cannot charge.
2. **Create and fund the new keeper**, on a trusted machine:
   ```sh
   stellar keys generate rp_<env>_keeper_<yyyymm> --network <net>   # testnet: add --fund
   stellar keys address rp_<env>_keeper_<yyyymm>
   ```
   On mainnet send it a small XLM balance from treasury (above `KEEPER_MIN_BALANCE_XLM`, default 50).
3. **Point the contract at it** (admin only; `set_keeper(keeper: Address)`):
   ```sh
   stellar contract invoke --id <CONTRACT_ID> --source <admin identity> --network testnet \
     -- set_keeper --keeper <NEW_KEEPER_G_ADDRESS>
   ```
   On mainnet use the multisig build/sign/send flow in [kill-switch.md](kill-switch.md) step 3.
4. **Revoke the old key in the signer** by replacing the secret, then restart. The value is the
   `S...` seed; write it from a file in a private temp dir, never on the command line:
   ```sh
   umask 077; stellar keys show rp_<env>_keeper_<yyyymm> > "$TMPDIR/keeper"
   aws secretsmanager put-secret-value --secret-id rodium-pay/signer/KEEPER_SECRET \
     --secret-string "file://$TMPDIR/keeper"
   rm -P "$TMPDIR/keeper"
   kubectl -n rodium-pay rollout restart deployment/rp-signer
   kubectl -n rodium-pay logs deployment/rp-signer | grep 'signer listening'   # shows new keeper
   ```
   Remove the key from the local keystore once it is in Secrets Manager (`stellar keys rm`).
5. **Update the worker:** set `KEEPER_ADDRESS` to the new `G...` address in the overlay's
   `rp-config`, then `kubectl apply -k infra/k8s/overlays/<env>` (this also restores `SIGNER_URL`)
   and `kubectl -n rodium-pay rollout restart deployment/rp-worker`.
6. **Drain the old account:** merge it into treasury so the stolen key holds nothing
   (`stellar tx new account-merge --source <OLD_KEEPER> --account <TREASURY_G_ADDRESS>`), signed with
   the old key from a trusted machine.
7. **Review recent charges** since the earliest possible exposure:
   ```sql
   SELECT c.id, s.contract_subscription_id, c.period_index, c.status, encode(c.tx_hash, 'hex') AS tx,
          c.failure_code, c.updated_at
   FROM pay.subscription_charges c JOIN pay.subscriptions s ON s.id = c.subscription_id
   WHERE c.updated_at > '<exposure start>' ORDER BY c.updated_at;
   ```
   Compare with the old keeper's history:
   `curl -s "$RP_STELLAR_HORIZON_URL/accounts/<OLD_KEEPER>/transactions?order=desc&limit=200"`.
   Every successful `charge` tx should appear in the table. Extra ones were still due charges at the
   locked price (the contract allows nothing else), so the harm is early timing; anything else is a
   contract bug — pause ([kill-switch.md](kill-switch.md)) and escalate.

## Verify

- `stellar contract invoke ... -- get --sub_id <n>` on an active subscription still works, and the
  next due charge succeeds: `charges_succeeded_total` rises, `signer_rejections_total` stays flat.
- `keeper_balance_xlm` reports the new account's balance.

## Afterwards

- `audit_log` row `action = 'keeper.rotate'` with old/new address, `set_keeper` tx hash, approver.
- Postmortem for a real compromise: how the key leaked, and whether Secrets Manager access logs
  (CloudTrail `GetSecretValue` on `rodium-pay/signer/KEEPER_SECRET`) show other readers.
