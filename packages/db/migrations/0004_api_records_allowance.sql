-- The API activates a subscription right after the user's subscribe transaction lands
-- and records when the on-chain allowance expires (it chose live_until_ledger).
SET LOCAL search_path = pay;

GRANT UPDATE (allowance_expires_ledger) ON subscriptions TO rp_api;
