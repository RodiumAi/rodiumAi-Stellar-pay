-- A subscription the user never completed on-chain can still be canceled by the
-- merchant: it then has no subscriber address or contract id. Only active and
-- past_due subscriptions must reference the chain.
SET LOCAL search_path = pay;

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_onchain_check
  CHECK (status IN ('incomplete', 'canceled')
         OR (subscriber_address IS NOT NULL AND contract_subscription_id IS NOT NULL));
