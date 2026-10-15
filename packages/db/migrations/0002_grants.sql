-- Context §7.3 table privileges and RLS policies. Privileges decide what each
-- role can do; the policies only open RLS to the service roles.
SET LOCAL search_path = pay;

GRANT SELECT, INSERT ON payments, subscriptions, outbox_events, audit_log TO rp_api;
GRANT SELECT ON chain_receipts, subscription_charges TO rp_api;
GRANT UPDATE (status, subscriber_address, contract_subscription_id, canceled_at) ON subscriptions TO rp_api;
GRANT SELECT, INSERT, UPDATE ON payments, subscriptions, subscription_charges, outbox_events, ingest_cursors TO rp_worker;
GRANT SELECT, INSERT ON chain_receipts, audit_log TO rp_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA pay TO rp_readonly;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments','subscriptions','subscription_charges',
                           'chain_receipts','outbox_events','ingest_cursors','audit_log']
  LOOP
    EXECUTE format('CREATE POLICY service_access ON pay.%I TO rp_api, rp_worker, rp_readonly USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
