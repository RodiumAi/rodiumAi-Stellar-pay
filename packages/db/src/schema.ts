import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { PaymentStatus } from '@rp/core/payment';
import type { SubscriptionStatus } from '@rp/core/subscription';

type Timestamp = ColumnType<Date, Date | undefined, Date>;
type DefaultNow = ColumnType<Date, Date | undefined, Date>;

export type ChargeStatus = 'scheduled' | 'submitted' | 'succeeded' | 'failed';
export type ReceiptMatch = 'matched' | 'unmatched' | 'ignored';
export type OutboxStatus = 'pending' | 'delivered' | 'dead';

export interface PaymentsTable {
  id: string;
  idempotency_key: string;
  request_hash: Buffer;
  merchant_order_id: string;
  customer_ref_enc: Buffer;
  customer_ref_bidx: Buffer;
  description: string;
  fiat_currency: string;
  fiat_amount_minor: bigint;
  /** numeric(38,18) as text; parse with `parseFxRate`. */
  fx_rate: string;
  asset_code: string;
  asset_issuer: string;
  destination: string;
  memo: string;
  amount_due_stroops: bigint;
  amount_received_stroops: ColumnType<bigint, bigint | undefined, bigint>;
  status: ColumnType<PaymentStatus, PaymentStatus | undefined, PaymentStatus>;
  checkout_token_hash: Buffer;
  return_url: string;
  expires_at: Date;
  confirmed_at: Timestamp | null;
  created_at: DefaultNow;
  updated_at: DefaultNow;
}

export interface SubscriptionsTable {
  id: string;
  idempotency_key: string;
  request_hash: Buffer;
  merchant_subscription_ref: string;
  customer_ref_enc: Buffer;
  customer_ref_bidx: Buffer;
  plan_code: string;
  contract_plan_id: number;
  price_stroops: ColumnType<bigint, bigint, never>;
  interval_seconds: ColumnType<number, number, never>;
  subscriber_address: string | null;
  contract_subscription_id: bigint | null;
  status: ColumnType<SubscriptionStatus, SubscriptionStatus | undefined, SubscriptionStatus>;
  current_period_end: Date | null;
  next_charge_at: Date | null;
  allowance_expires_ledger: number | null;
  /** Hash of the subscribe transaction recorded at checkout submit (migration 0005). */
  activation_tx_hash: Buffer | null;
  failed_attempts: ColumnType<number, number | undefined, number>;
  checkout_token_hash: Buffer;
  return_url: string;
  canceled_at: Date | null;
  created_at: DefaultNow;
  updated_at: DefaultNow;
}

export interface LeaderLeasesTable {
  name: string;
  holder: string;
  expires_at: Date;
  acquired_at: DefaultNow;
}

export interface SubscriptionChargesTable {
  id: string;
  subscription_id: string;
  period_index: number;
  amount_stroops: bigint;
  status: ColumnType<ChargeStatus, ChargeStatus | undefined, ChargeStatus>;
  attempt: ColumnType<number, number | undefined, never>;
  tx_hash: Buffer | null;
  failure_code: string | null;
  created_at: DefaultNow;
  updated_at: DefaultNow;
}

export interface ChainReceiptsTable {
  id: string;
  tx_hash: Buffer;
  item_index: number;
  ledger: number;
  ledger_closed_at: Date;
  source_address: string;
  destination: string;
  asset_code: string;
  asset_issuer: string;
  amount_stroops: bigint;
  memo: string | null;
  match: ReceiptMatch;
  payment_id: string | null;
  subscription_charge_id: string | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface OutboxEventsTable {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: ColumnType<unknown, string, string>;
  status: ColumnType<OutboxStatus, OutboxStatus | undefined, OutboxStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: DefaultNow;
  last_error: string | null;
  created_at: DefaultNow;
  delivered_at: Date | null;
}

export interface IngestCursorsTable {
  source: string;
  cursor: string;
  ledger: number;
  updated_at: DefaultNow;
}

export interface AuditLogTable {
  id: string;
  actor: string;
  action: string;
  target_id: string | null;
  details: ColumnType<unknown, string | undefined, never>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface Database {
  payments: PaymentsTable;
  subscriptions: SubscriptionsTable;
  leader_leases: LeaderLeasesTable;
  subscription_charges: SubscriptionChargesTable;
  chain_receipts: ChainReceiptsTable;
  outbox_events: OutboxEventsTable;
  ingest_cursors: IngestCursorsTable;
  audit_log: AuditLogTable;
}

export type PaymentRow = Selectable<PaymentsTable>;
export type NewPayment = Insertable<PaymentsTable>;
export type SubscriptionRow = Selectable<SubscriptionsTable>;
export type NewSubscription = Insertable<SubscriptionsTable>;
export type ChargeRow = Selectable<SubscriptionChargesTable>;
export type NewCharge = Insertable<SubscriptionChargesTable>;
export type ReceiptRow = Selectable<ChainReceiptsTable>;
export type NewReceipt = Insertable<ChainReceiptsTable>;
export type OutboxRow = Selectable<OutboxEventsTable>;
export type NewAuditEntry = Insertable<AuditLogTable>;
export type GeneratedId = Generated<string>;
