-- Leader election by lease instead of a session advisory lock (found in S11: the
-- project's session pooler was unusable). A lease row works through Supavisor's
-- transaction pooler: acquire, renew and release are single statements, and expiry uses
-- the database clock so replicas never disagree about time.
SET LOCAL search_path = pay;

CREATE TABLE leader_leases (
  name        text PRIMARY KEY,
  holder      text        NOT NULL CHECK (char_length(holder) BETWEEN 1 AND 200),
  expires_at  timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE leader_leases ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON leader_leases TO rp_worker;
GRANT SELECT ON leader_leases TO rp_readonly;
CREATE POLICY service_access ON leader_leases TO rp_worker, rp_readonly USING (true) WITH CHECK (true);
