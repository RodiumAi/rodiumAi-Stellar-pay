import type { PaymentStatus } from '@rp/core/payment';
import type { Db } from '@rp/db/connection';
import type { OutboxStatus, ReceiptMatch } from '@rp/db/schema';
import { sql } from 'kysely';

/** Everything the dashboard reads. Read-only by construction: it runs as `rp_readonly`. */
export interface AdminQueries {
  overview(): Promise<Overview>;
  payments(filter: PaymentFilter): Promise<readonly PaymentRow[]>;
  payment(id: string): Promise<PaymentDetail | null>;
  receipts(match: ReceiptMatch, before: Cursor | null): Promise<readonly ReceiptRow[]>;
  webhooks(status: OutboxStatus, before: Cursor | null): Promise<readonly WebhookRow[]>;
}

export const PAGE_SIZE = 50;

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'pending',
  'underpaid',
  'confirmed',
  'expired',
  'late_paid',
  'refunded',
];

/**
 * Keyset pagination: rows with a smaller id. Ids are UUIDv7 (time-ordered) everywhere the
 * services insert, so id order is creation order; JS Dates would drop Postgres microseconds.
 */
export type Cursor = string;

export interface PaymentFilter {
  readonly status: PaymentStatus | null;
  /** Exact payment id, merchant order id or memo. */
  readonly search: string | null;
  readonly before: Cursor | null;
}

export interface PaymentRow {
  readonly id: string;
  readonly merchantOrderId: string;
  readonly description: string;
  readonly status: PaymentStatus;
  readonly fiatCurrency: string;
  readonly fiatAmountMinor: bigint;
  readonly amountDue: bigint;
  readonly amountReceived: bigint;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
}

export interface PaymentDetail extends PaymentRow {
  readonly memo: string;
  readonly destination: string;
  readonly fxRate: string;
  readonly returnUrl: string;
  readonly expiresAt: Date;
  readonly updatedAt: Date;
  readonly receipts: readonly ReceiptRow[];
  readonly webhooks: readonly WebhookRow[];
  readonly audit: readonly AuditRow[];
}

export interface ReceiptRow {
  readonly id: string;
  readonly txHash: string;
  readonly ledger: number;
  readonly closedAt: Date;
  readonly source: string;
  readonly assetCode: string;
  readonly assetIssuer: string;
  readonly amount: bigint;
  readonly memo: string | null;
  readonly match: ReceiptMatch;
  readonly paymentId: string | null;
  readonly createdAt: Date;
}

export interface WebhookRow {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
}

export interface AuditRow {
  readonly actor: string;
  readonly action: string;
  readonly details: unknown;
  readonly createdAt: Date;
}

export interface WindowStats {
  readonly created: number;
  readonly confirmed: number;
  readonly confirmedVolume: bigint;
}

export interface Overview {
  readonly day: WindowStats;
  readonly week: WindowStats;
  readonly openPayments: number;
  readonly receiptsUnmatched: number;
  readonly webhooksPending: number;
  readonly webhooksDead: number;
  /** The worker renews its leader lease continuously; null when no lease row exists yet. */
  readonly workerLeaseExpiresAt: Date | null;
  readonly lastIngestedLedger: number | null;
  readonly recent: readonly PaymentRow[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

const paymentColumns = [
  'id',
  'merchant_order_id',
  'description',
  'status',
  'fiat_currency',
  'fiat_amount_minor',
  'amount_due_stroops',
  'amount_received_stroops',
  'created_at',
  'confirmed_at',
] as const;

interface PaymentSelect {
  id: string;
  merchant_order_id: string;
  description: string;
  status: PaymentStatus;
  fiat_currency: string;
  fiat_amount_minor: bigint;
  amount_due_stroops: bigint;
  amount_received_stroops: bigint;
  created_at: Date;
  confirmed_at: Date | null;
}

const toPaymentRow = (r: PaymentSelect): PaymentRow => ({
  id: r.id,
  merchantOrderId: r.merchant_order_id,
  description: r.description,
  status: r.status,
  fiatCurrency: r.fiat_currency,
  fiatAmountMinor: r.fiat_amount_minor,
  amountDue: r.amount_due_stroops,
  amountReceived: r.amount_received_stroops,
  createdAt: r.created_at,
  confirmedAt: r.confirmed_at,
});

export function createAdminQueries(db: Db): AdminQueries {
  const receiptsQuery = () =>
    db
      .selectFrom('chain_receipts')
      .select([
        'id',
        'tx_hash',
        'ledger',
        'ledger_closed_at',
        'source_address',
        'asset_code',
        'asset_issuer',
        'amount_stroops',
        'memo',
        'match',
        'payment_id',
        'created_at',
      ]);
  type ReceiptSelect = Awaited<ReturnType<ReturnType<typeof receiptsQuery>['execute']>>[number];
  const toReceipt = (r: ReceiptSelect): ReceiptRow => ({
    id: r.id,
    txHash: r.tx_hash.toString('hex'),
    ledger: r.ledger,
    closedAt: r.ledger_closed_at,
    source: r.source_address,
    assetCode: r.asset_code,
    assetIssuer: r.asset_issuer,
    amount: r.amount_stroops,
    memo: r.memo,
    match: r.match,
    paymentId: r.payment_id,
    createdAt: r.created_at,
  });

  const webhooksQuery = () =>
    db
      .selectFrom('outbox_events')
      .select([
        'id',
        'event_type',
        'aggregate_id',
        'status',
        'attempts',
        'next_attempt_at',
        'last_error',
        'created_at',
        'delivered_at',
      ]);
  type WebhookSelect = Awaited<ReturnType<ReturnType<typeof webhooksQuery>['execute']>>[number];
  const toWebhook = (r: WebhookSelect): WebhookRow => ({
    id: r.id,
    eventType: r.event_type,
    aggregateId: r.aggregate_id,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  });

  const windowStats = async (since: string): Promise<WindowStats> => {
    const { rows } = await sql<{ created: number; confirmed: number; volume: string }>`
      SELECT count(*)::int AS created,
             (count(*) FILTER (WHERE status = 'confirmed'))::int AS confirmed,
             (coalesce(sum(amount_received_stroops) FILTER (WHERE status = 'confirmed'), 0))::text AS volume
      FROM payments WHERE created_at > now() - ${since}::interval
    `.execute(db);
    const r = rows[0];
    return {
      created: r?.created ?? 0,
      confirmed: r?.confirmed ?? 0,
      confirmedVolume: BigInt(r?.volume ?? '0'),
    };
  };

  return {
    async overview() {
      const [day, week, counts, lease, cursor, recent] = await Promise.all([
        windowStats('24 hours'),
        windowStats('7 days'),
        sql<{ open: number; unmatched: number; pending: number; dead: number }>`
          SELECT
            (SELECT count(*) FROM payments WHERE status IN ('pending', 'underpaid'))::int AS open,
            (SELECT count(*) FROM chain_receipts WHERE match = 'unmatched')::int AS unmatched,
            (SELECT count(*) FROM outbox_events WHERE status = 'pending')::int AS pending,
            (SELECT count(*) FROM outbox_events WHERE status = 'dead')::int AS dead
        `.execute(db),
        db
          .selectFrom('leader_leases')
          .select(sql<Date>`max(expires_at)`.as('expires_at'))
          .executeTakeFirst(),
        db
          .selectFrom('ingest_cursors')
          .select(sql<number | null>`max(ledger)`.as('ledger'))
          .executeTakeFirst(),
        db.selectFrom('payments').select(paymentColumns).orderBy('id', 'desc').limit(10).execute(),
      ]);
      const c = counts.rows[0];
      return {
        day,
        week,
        openPayments: c?.open ?? 0,
        receiptsUnmatched: c?.unmatched ?? 0,
        webhooksPending: c?.pending ?? 0,
        webhooksDead: c?.dead ?? 0,
        workerLeaseExpiresAt: lease?.expires_at ?? null,
        lastIngestedLedger: cursor?.ledger ?? null,
        recent: recent.map(toPaymentRow),
      };
    },

    async payments(filter) {
      let q = db.selectFrom('payments').select(paymentColumns);
      if (filter.status !== null) q = q.where('status', '=', filter.status);
      const search = filter.search;
      if (search !== null) {
        q = q.where((eb) =>
          eb.or([
            ...(isUuid(search) ? [eb('id', '=', search.toLowerCase())] : []),
            eb('merchant_order_id', '=', search),
            eb('memo', '=', search),
          ]),
        );
      }
      if (filter.before !== null) q = q.where('id', '<', filter.before);
      const rows = await q.orderBy('id', 'desc').limit(PAGE_SIZE).execute();
      return rows.map(toPaymentRow);
    },

    async payment(id) {
      if (!isUuid(id)) return null;
      const p = await db
        .selectFrom('payments')
        .select([...paymentColumns, 'memo', 'destination', 'fx_rate', 'return_url', 'expires_at'])
        .select('updated_at')
        .where('id', '=', id.toLowerCase())
        .executeTakeFirst();
      if (p === undefined) return null;
      const [receipts, webhooks, audit] = await Promise.all([
        receiptsQuery()
          .where('payment_id', '=', p.id)
          .orderBy('ledger')
          .orderBy('item_index')
          .execute(),
        webhooksQuery().where('aggregate_id', '=', p.id).orderBy('created_at').execute(),
        db
          .selectFrom('audit_log')
          .select(['actor', 'action', 'details', 'created_at'])
          .where('target_id', '=', p.id)
          .orderBy('created_at')
          .execute(),
      ]);
      return {
        ...toPaymentRow(p),
        memo: p.memo,
        destination: p.destination,
        fxRate: p.fx_rate,
        returnUrl: p.return_url,
        expiresAt: p.expires_at,
        updatedAt: p.updated_at,
        receipts: receipts.map(toReceipt),
        webhooks: webhooks.map(toWebhook),
        audit: audit.map((a) => ({
          actor: a.actor,
          action: a.action,
          details: a.details,
          createdAt: a.created_at,
        })),
      };
    },

    async receipts(match, before) {
      let q = receiptsQuery().where('match', '=', match);
      if (before !== null) q = q.where('id', '<', before);
      const rows = await q.orderBy('id', 'desc').limit(PAGE_SIZE).execute();
      return rows.map(toReceipt);
    },

    async webhooks(status, before) {
      let q = webhooksQuery().where('status', '=', status);
      if (before !== null) q = q.where('id', '<', before);
      const rows = await q.orderBy('id', 'desc').limit(PAGE_SIZE).execute();
      return rows.map(toWebhook);
    },
  };
}
