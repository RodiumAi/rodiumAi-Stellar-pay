-- Context §7.1. Applied by rp_owner; the schema itself is created by infra/supabase/roles.sql.
SET LOCAL search_path = pay;

CREATE TYPE payment_status AS ENUM
  ('pending', 'underpaid', 'confirmed', 'expired', 'late_paid', 'refunded');
CREATE TYPE subscription_status AS ENUM
  ('incomplete', 'active', 'past_due', 'canceled');
CREATE TYPE charge_status AS ENUM
  ('scheduled', 'submitted', 'succeeded', 'failed');
CREATE TYPE receipt_match AS ENUM
  ('matched', 'unmatched', 'ignored');
CREATE TYPE outbox_status AS ENUM
  ('pending', 'delivered', 'dead');

CREATE TABLE payments (
  id                       uuid PRIMARY KEY,
  idempotency_key          text        NOT NULL UNIQUE,
  request_hash             bytea       NOT NULL,
  merchant_order_id        text        NOT NULL,
  customer_ref_enc         bytea       NOT NULL,
  customer_ref_bidx        bytea       NOT NULL,
  description              text        NOT NULL CHECK (char_length(description) <= 140),
  fiat_currency            char(3)     NOT NULL,
  fiat_amount_minor        bigint      NOT NULL CHECK (fiat_amount_minor > 0),
  fx_rate                  numeric(38,18) NOT NULL CHECK (fx_rate > 0),
  asset_code               text        NOT NULL,
  asset_issuer             text        NOT NULL,
  destination              text        NOT NULL,
  memo                     text        NOT NULL UNIQUE CHECK (octet_length(memo) <= 28),
  amount_due_stroops       bigint      NOT NULL CHECK (amount_due_stroops > 0),
  amount_received_stroops  bigint      NOT NULL DEFAULT 0 CHECK (amount_received_stroops >= 0),
  status                   payment_status NOT NULL DEFAULT 'pending',
  checkout_token_hash      bytea       NOT NULL UNIQUE,
  return_url               text        NOT NULL,
  expires_at               timestamptz NOT NULL,
  confirmed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);
CREATE INDEX payments_merchant_order_idx ON payments (merchant_order_id);
CREATE INDEX payments_customer_bidx_idx  ON payments (customer_ref_bidx);
CREATE INDEX payments_expiry_idx ON payments (expires_at)
  WHERE status IN ('pending', 'underpaid');

CREATE TABLE subscriptions (
  id                        uuid PRIMARY KEY,
  idempotency_key           text        NOT NULL UNIQUE,
  request_hash              bytea       NOT NULL,
  merchant_subscription_ref text        NOT NULL,
  customer_ref_enc          bytea       NOT NULL,
  customer_ref_bidx         bytea       NOT NULL,
  plan_code                 text        NOT NULL,
  contract_plan_id          integer     NOT NULL,
  price_stroops             bigint      NOT NULL CHECK (price_stroops > 0),
  interval_seconds          integer     NOT NULL CHECK (interval_seconds >= 86400),
  subscriber_address        text,
  contract_subscription_id  bigint      UNIQUE,
  status                    subscription_status NOT NULL DEFAULT 'incomplete',
  current_period_end        timestamptz,
  next_charge_at            timestamptz,
  allowance_expires_ledger  integer,
  failed_attempts           smallint    NOT NULL DEFAULT 0,
  checkout_token_hash       bytea       NOT NULL UNIQUE,
  return_url                text        NOT NULL,
  canceled_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'incomplete' OR (subscriber_address IS NOT NULL AND contract_subscription_id IS NOT NULL))
);
CREATE INDEX subscriptions_due_idx ON subscriptions (next_charge_at)
  WHERE status IN ('active', 'past_due');
CREATE INDEX subscriptions_customer_bidx_idx ON subscriptions (customer_ref_bidx);

CREATE TABLE subscription_charges (
  id               uuid PRIMARY KEY,
  subscription_id  uuid        NOT NULL REFERENCES subscriptions(id),
  period_index     integer     NOT NULL CHECK (period_index >= 0),
  amount_stroops   bigint      NOT NULL CHECK (amount_stroops > 0),
  status           charge_status NOT NULL DEFAULT 'scheduled',
  attempt          smallint    NOT NULL DEFAULT 1,
  tx_hash          bytea       CHECK (tx_hash IS NULL OR octet_length(tx_hash) = 32),
  failure_code     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_index, attempt)
);

CREATE TABLE chain_receipts (
  id                      uuid PRIMARY KEY,
  tx_hash                 bytea       NOT NULL CHECK (octet_length(tx_hash) = 32),
  item_index              integer     NOT NULL,
  ledger                  integer     NOT NULL,
  ledger_closed_at        timestamptz NOT NULL,
  source_address          text        NOT NULL,
  destination             text        NOT NULL,
  asset_code              text        NOT NULL,
  asset_issuer            text        NOT NULL,
  amount_stroops          bigint      NOT NULL CHECK (amount_stroops > 0),
  memo                    text,
  match                   receipt_match NOT NULL,
  payment_id              uuid REFERENCES payments(id),
  subscription_charge_id  uuid REFERENCES subscription_charges(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, item_index),
  CHECK (match <> 'matched' OR num_nonnulls(payment_id, subscription_charge_id) = 1)
);
CREATE INDEX chain_receipts_unmatched_idx ON chain_receipts (created_at) WHERE match = 'unmatched';

CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY,
  event_type       text        NOT NULL,
  aggregate_id     uuid        NOT NULL,
  payload          jsonb       NOT NULL,
  status           outbox_status NOT NULL DEFAULT 'pending',
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX outbox_due_idx ON outbox_events (next_attempt_at) WHERE status = 'pending';

CREATE TABLE ingest_cursors (
  source      text PRIMARY KEY,
  cursor      text        NOT NULL,
  ledger      integer     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY,
  actor       text        NOT NULL,
  action      text        NOT NULL,
  target_id   uuid,
  details     jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER charges_touch BEFORE UPDATE ON subscription_charges
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain_receipts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_cursors       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;
