import { parseAmount, type Stroops } from '@rp/core/money/stroops';

/** A credit to the merchant as reported by any ledger source, before classification. */
export interface ObservedPayment {
  /** Source-specific position, persisted as the ingest cursor. */
  readonly cursor: string;
  readonly txHash: string;
  /** Operation index inside the transaction; with txHash it identifies the receipt. */
  readonly itemIndex: number;
  readonly ledger: number;
  readonly ledgerClosedAt: Date;
  readonly successful: boolean;
  readonly from: string;
  readonly to: string;
  /** `null` for native XLM. */
  readonly asset: { readonly code: string; readonly issuer: string } | null;
  /** Amount received by `to`, as a 7-decimal string. For path payments: the delivered amount. */
  readonly amount: string;
  readonly memo: {
    readonly type: 'text' | 'id' | 'hash' | 'return' | 'none';
    readonly value: string | null;
  };
  /** The credit came from a contract call (e.g. subscription `charge`), not a classic payment. */
  readonly viaContract: boolean;
}

export interface MatchingRules {
  readonly merchant: string;
  readonly usdc: { readonly code: string; readonly issuer: string };
}

export type Classification =
  /** USDC to the merchant via a classic payment: try to match its memo. */
  | { readonly kind: 'eligible'; readonly amount: Stroops; readonly memo: string | null }
  /** Credited to the merchant but must never be auto-credited (context §13.2): store + alert. */
  | {
      readonly kind: 'unmatched';
      readonly reason: 'wrong_asset' | 'non_text_memo' | 'unparseable_amount';
      readonly amount: Stroops | null;
    }
  /** Not a receipt for one-time payment matching. */
  | {
      readonly kind: 'ignored';
      readonly reason: 'failed' | 'not_to_merchant' | 'contract_transfer';
    };

/** Context §13.2: only successful USDC (code AND issuer) credits to the merchant count. */
export function classifyPayment(p: ObservedPayment, rules: MatchingRules): Classification {
  if (!p.successful) {
    return { kind: 'ignored', reason: 'failed' };
  }
  if (p.to !== rules.merchant) {
    return { kind: 'ignored', reason: 'not_to_merchant' };
  }
  if (p.viaContract) {
    // Subscription charges arrive via transfer_from; they are tracked through contract events.
    return { kind: 'ignored', reason: 'contract_transfer' };
  }
  const amount = parseAmount(p.amount);
  if (!amount.ok) {
    return { kind: 'unmatched', reason: 'unparseable_amount', amount: null };
  }
  if (p.asset?.code !== rules.usdc.code || p.asset.issuer !== rules.usdc.issuer) {
    return { kind: 'unmatched', reason: 'wrong_asset', amount: amount.value };
  }
  if (p.memo.type !== 'text' && p.memo.type !== 'none') {
    return { kind: 'unmatched', reason: 'non_text_memo', amount: amount.value };
  }
  return { kind: 'eligible', amount: amount.value, memo: p.memo.value };
}
