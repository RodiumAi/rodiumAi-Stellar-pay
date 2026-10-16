import type { ObservedPayment } from './observed-payment.js';

export interface PaymentPage {
  readonly payments: readonly ObservedPayment[];
  /** Persist this (with the receipts) to resume after the last item; unchanged when empty. */
  readonly cursor: string;
  /** Latest ledger the provider knows; drives `ingest_lag_ledgers`. */
  readonly latestLedger: number;
}

/**
 * Hides the ingestion provider (context §13.4). Implementations return credits to the
 * merchant in ledger order, starting strictly after `cursor` (or at `startLedger`).
 */
export interface LedgerSource {
  readonly name: string;
  fetchPayments(
    position: { readonly cursor: string } | { readonly startLedger: number },
    limit: number,
  ): Promise<PaymentPage>;
}
