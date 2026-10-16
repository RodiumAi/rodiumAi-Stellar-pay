import { formatAmount, stroops } from '@rp/core/money/stroops';
import {
  Address,
  FeeBumpTransaction,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  rpc,
  type Transaction,
} from '@stellar/stellar-sdk';
import type { LedgerSource, PaymentPage } from './ledger-source.js';
import type { ObservedPayment } from './observed-payment.js';

/** The subset of `rpc.Server` this source needs, so tests can stub it. */
export interface RpcClient {
  getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface RpcSourceConfig {
  readonly merchant: string;
  readonly usdcContractId: string;
  readonly networkPassphrase: string;
}

function memoOf(tx: Transaction): ObservedPayment['memo'] {
  const m = tx.memo;
  switch (m.type) {
    case 'none':
      return { type: 'none', value: null };
    case 'text':
      return {
        type: 'text',
        value:
          m.value instanceof Uint8Array ? Buffer.from(m.value).toString('utf8') : String(m.value),
      };
    case 'id':
      return { type: 'id', value: String(m.value) };
    case 'hash':
    case 'return':
      return {
        type: m.type,
        value:
          m.value instanceof Uint8Array ? Buffer.from(m.value).toString('hex') : String(m.value),
      };
  }
}

/** CAP-67 transfer data is a bare i128, or a map with `amount` when a muxed id is present. */
function amountOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'object' && value !== null && 'amount' in value) {
    const { amount } = value;
    return typeof amount === 'bigint' ? amount : null;
  }
  return null;
}

/**
 * RPC ingestion (context §13.4, SDF's direction of travel): CAP-67 `transfer` events
 * into the merchant from the USDC SAC, joined with `getTransaction` for the memo.
 * Requires a provider that emits classic events (`EMIT_CLASSIC_EVENTS=true`).
 */
export function createRpcSource(config: RpcSourceConfig, client: RpcClient): LedgerSource {
  const filters: rpc.Api.EventFilter[] = [
    {
      type: 'contract',
      contractIds: [config.usdcContractId],
      topics: [
        [
          nativeToScVal('transfer', { type: 'symbol' }).toXdr('base64'),
          '*',
          new Address(config.merchant).toScVal().toXdr('base64'),
          '*',
        ],
      ],
    },
  ];

  const transactions = new Map<string, Promise<Transaction | null>>();
  const loadTransaction = (hash: string): Promise<Transaction | null> => {
    let pending = transactions.get(hash);
    if (pending === undefined) {
      pending = client.getTransaction(hash).then((res) => {
        if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) return null;
        const parsed = TransactionBuilder.fromXdr(res.envelopeXdr, config.networkPassphrase);
        return parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
      });
      transactions.set(hash, pending);
    }
    return pending;
  };

  return {
    name: 'rpc',
    async fetchPayments(position, limit): Promise<PaymentPage> {
      const request: rpc.Api.GetEventsRequest =
        'cursor' in position
          ? { cursor: position.cursor, filters, limit }
          : { startLedger: position.startLedger, filters, limit };
      const res = await client.getEvents(request);
      transactions.clear();
      const payments: ObservedPayment[] = [];
      for (const event of res.events) {
        const raw = amountOf(scValToNative(event.value));
        const amount = raw === null ? null : stroops(raw);
        const tx = await loadTransaction(event.txHash);
        const [, fromVal, , assetVal] = event.topic;
        const asset = assetVal === undefined ? '' : String(scValToNative(assetVal));
        const [code, issuer] = asset.split(':');
        payments.push({
          cursor: event.id,
          txHash: event.txHash,
          itemIndex: event.operationIndex,
          ledger: event.ledger,
          ledgerClosedAt: new Date(event.ledgerClosedAt),
          successful: event.inSuccessfulContractCall && tx !== null,
          from: fromVal === undefined ? '' : String(scValToNative(fromVal)),
          to: config.merchant,
          asset:
            asset === 'native' || code === undefined || issuer === undefined
              ? null
              : { code, issuer },
          amount: amount?.ok === true ? formatAmount(amount.value) : 'invalid',
          memo: tx === null ? { type: 'none', value: null } : memoOf(tx),
          viaContract: tx?.operations.some((op) => op.type === 'invokeHostFunction') ?? false,
        });
      }
      return { payments, cursor: res.cursor, latestLedger: res.latestLedger };
    },
  };
}
