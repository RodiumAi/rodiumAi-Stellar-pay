-- A subscribe transaction can still be pending when checkout's wait times out. The API
-- records its hash (and the signed subscriber/allowance) before sending; the worker then
-- matches the contract's `sub_created` event by transaction hash and activates the row,
-- so a paid subscription can never stay `incomplete` (found in S11).
SET LOCAL search_path = pay;

ALTER TABLE subscriptions
  ADD COLUMN activation_tx_hash bytea UNIQUE
    CHECK (activation_tx_hash IS NULL OR octet_length(activation_tx_hash) = 32);

GRANT UPDATE (activation_tx_hash) ON subscriptions TO rp_api;
