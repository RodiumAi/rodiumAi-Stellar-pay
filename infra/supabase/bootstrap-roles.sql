-- Bootstrap for context §7.3. Deliberately NOT named `roles.sql`: the Supabase CLI
-- auto-runs that file on `supabase start` without the password settings below.
-- Run as the Supabase `postgres` role, once per
-- project and again whenever passwords rotate. Idempotent.
--
-- Passwords are read from session settings so they never appear in this file
-- or in shell history:
--   SELECT set_config('rp.owner_pw', '<32+ random bytes>', false); -- likewise api, worker, readonly
-- `pnpm db:bootstrap` does this from environment variables.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('rp_owner', 'rp.owner_pw'),
      ('rp_api', 'rp.api_pw'),
      ('rp_worker', 'rp.worker_pw'),
      ('rp_readonly', 'rp.readonly_pw')) AS t(role_name, setting)
  LOOP
    IF coalesce(length(current_setting(r.setting, true)), 0) < 32 THEN
      RAISE EXCEPTION 'setting % must hold a password of at least 32 characters', r.setting;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role_name) THEN
      EXECUTE format('ALTER ROLE %I WITH LOGIN NOBYPASSRLS PASSWORD %L',
                     r.role_name, current_setting(r.setting));
    ELSE
      EXECUTE format('CREATE ROLE %I WITH LOGIN NOBYPASSRLS PASSWORD %L',
                     r.role_name, current_setting(r.setting));
    END IF;
  END LOOP;
END $$;

-- Lets the bootstrap role create the schema on rp_owner's behalf (PG16+ role membership rules).
-- Spelled via format(): a literal `GRANT … TO current_user` segfaults the Supabase
-- Postgres image (17.6.1.134) inside its role hook.
DO $$ BEGIN EXECUTE format('GRANT rp_owner TO %I', current_user); END $$;

CREATE SCHEMA IF NOT EXISTS pay AUTHORIZATION rp_owner;
ALTER SCHEMA pay OWNER TO rp_owner;
REVOKE ALL ON SCHEMA pay FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE rp_owner IN SCHEMA pay REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE rp_owner IN SCHEMA pay REVOKE ALL ON FUNCTIONS FROM PUBLIC;

ALTER ROLE rp_owner    SET search_path = pay;
ALTER ROLE rp_api      SET search_path = pay;
ALTER ROLE rp_worker   SET search_path = pay;
ALTER ROLE rp_readonly SET search_path = pay;
ALTER ROLE rp_api      SET statement_timeout = '5s';
ALTER ROLE rp_worker   SET statement_timeout = '30s';
ALTER ROLE rp_readonly SET statement_timeout = '60s';
ALTER ROLE rp_readonly SET default_transaction_read_only = on;
ALTER ROLE rp_api      SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE rp_worker   SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE rp_api      SET lock_timeout = '3s';
ALTER ROLE rp_worker   SET lock_timeout = '3s';

GRANT USAGE ON SCHEMA pay TO rp_api, rp_worker, rp_readonly;
