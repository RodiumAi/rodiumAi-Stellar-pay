import { z } from 'zod';
import type { LedgerSource, PaymentPage } from './ledger-source.js';
import type { ObservedPayment } from './observed-payment.js';

const Memo = z.object({
  memo_type: z.enum(['none', 'text', 'id', 'hash', 'return']),
  memo: z.string().optional(),
  ledger: z.number().int(),
  successful: z.boolean(),
});

const Base = z.object({
  id: z.string(),
  paging_token: z.string(),
  transaction_hash: z.string().regex(/^[0-9a-f]{64}$/),
  transaction_successful: z.boolean(),
  created_at: z.string(),
  transaction: Memo,
});

const AssetFields = {
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
};

const Payment = Base.extend({
  type: z.enum(['payment', 'path_payment_strict_receive', 'path_payment_strict_send']),
  from: z.string(),
  to: z.string(),
  amount: z.string(),
  ...AssetFields,
});

const CreateAccount = Base.extend({
  type: z.literal('create_account'),
  funder: z.string(),
  account: z.string(),
  starting_balance: z.string(),
});

const InvokeHostFunction = Base.extend({
  type: z.literal('invoke_host_function'),
  asset_balance_changes: z
    .array(
      z.object({
        type: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        amount: z.string(),
        ...AssetFields,
      }),
    )
    .optional(),
});

const Other = Base.extend({ type: z.string() });

const Page = z.object({
  _embedded: z.object({ records: z.array(z.unknown()) }),
});

const Root = z.object({ history_latest_ledger: z.number().int() });

export interface HorizonDeps {
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

/** Operation ids are TOIDs; the low 12 bits are the 1-based operation index. */
function operationIndex(id: string): number {
  return Number(BigInt(id) & 0xfffn) - 1;
}

function assetOf(r: {
  asset_type: string;
  asset_code?: string | undefined;
  asset_issuer?: string | undefined;
}) {
  return r.asset_type === 'native' || r.asset_code === undefined || r.asset_issuer === undefined
    ? null
    : { code: r.asset_code, issuer: r.asset_issuer };
}

function memoOf(t: z.infer<typeof Memo>): ObservedPayment['memo'] {
  return { type: t.memo_type, value: t.memo ?? null };
}

/** Maps one Horizon `/payments` record to the credits it represents (usually one, or none). */
export function fromHorizonRecord(raw: unknown, merchant: string): ObservedPayment[] {
  const base = Base.parse(raw);
  const common = {
    cursor: base.paging_token,
    txHash: base.transaction_hash,
    itemIndex: operationIndex(base.id),
    ledger: base.transaction.ledger,
    ledgerClosedAt: new Date(base.created_at),
    successful: base.transaction_successful && base.transaction.successful,
    memo: memoOf(base.transaction),
  };
  const payment = Payment.safeParse(raw);
  if (payment.success) {
    const r = payment.data;
    return [
      {
        ...common,
        from: r.from,
        to: r.to,
        asset: assetOf(r),
        amount: r.amount,
        viaContract: false,
      },
    ];
  }
  const created = CreateAccount.safeParse(raw);
  if (created.success) {
    const r = created.data;
    return [
      {
        ...common,
        from: r.funder,
        to: r.account,
        asset: null,
        amount: r.starting_balance,
        viaContract: false,
      },
    ];
  }
  const invoke = InvokeHostFunction.safeParse(raw);
  if (invoke.success) {
    return (invoke.data.asset_balance_changes ?? [])
      .filter((c) => c.to === merchant)
      .map((c) => ({
        ...common,
        from: c.from ?? '',
        to: merchant,
        asset: assetOf(c),
        amount: c.amount,
        viaContract: true,
      }));
  }
  Other.parse(raw);
  // account_merge and future types: not credits we can attribute; they stay in Horizon history.
  return [];
}

/**
 * Default ingestion source: Horizon `/accounts/{merchant}/payments` with the transaction
 * joined in (for the memo), ascending from the cursor.
 */
export function createHorizonSource(
  horizonUrl: string,
  merchant: string,
  deps: HorizonDeps,
): LedgerSource {
  const base = horizonUrl.replace(/\/+$/, '');
  const get = async (url: string): Promise<unknown> => {
    const res = await deps.fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      throw new Error(`Horizon ${new URL(url).pathname} → HTTP ${String(res.status)}`);
    }
    return res.json();
  };

  return {
    name: 'horizon',
    async fetchPayments(position, limit): Promise<PaymentPage> {
      const cursor =
        'cursor' in position ? position.cursor : (BigInt(position.startLedger) << 32n).toString();
      const url = new URL(`${base}/accounts/${encodeURIComponent(merchant)}/payments`);
      url.search = new URLSearchParams({
        cursor,
        order: 'asc',
        limit: String(Math.min(Math.max(limit, 1), 200)),
        join: 'transactions',
        include_failed: 'false',
      }).toString();
      const [page, root] = await Promise.all([get(url.toString()), get(`${base}/`)]);
      const records = Page.parse(page)._embedded.records;
      const payments = records.flatMap((r) => fromHorizonRecord(r, merchant));
      const last = records.at(-1);
      return {
        payments,
        cursor: last === undefined ? cursor : Base.parse(last).paging_token,
        latestLedger: Root.parse(root).history_latest_ledger,
      };
    },
  };
}
