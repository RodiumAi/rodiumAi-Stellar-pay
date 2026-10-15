import { parseMemo } from '@rp/core/memo';
import { formatAmount, type Stroops } from '@rp/core/money/stroops';
import { transitionPayment, type PaymentStatus } from '@rp/core/payment';
import { instant } from '@rp/core/time';
import type { Db, Tx } from './connection.js';
import { enqueueEvent } from './outbox.js';
import { addReceivedAmount, lockPaymentByMemo } from './payments.js';
import { insertReceipt, receiptsForPayment } from './receipts.js';
import type { PaymentRow } from './schema.js';

/** A payment to the merchant in USDC, already classified as eligible by the ingester. */
export interface ReceiptCandidate {
  readonly id: string;
  readonly txHash: Buffer;
  readonly itemIndex: number;
  readonly ledger: number;
  readonly ledgerClosedAt: Date;
  readonly sourceAddress: string;
  readonly destination: string;
  readonly assetCode: string;
  readonly assetIssuer: string;
  readonly amount: bigint;
  readonly memo: string | null;
}

export type ReceiptOutcome =
  | { readonly kind: 'duplicate' }
  | {
      readonly kind: 'unmatched';
      readonly reason: 'no_memo' | 'unknown_memo' | 'invalid_transition';
    }
  | {
      readonly kind: 'applied';
      readonly payment: PaymentRow;
      readonly excess: bigint;
      readonly eventType: string | null;
    };

function eventForStatus(status: PaymentStatus): string | null {
  switch (status) {
    case 'confirmed':
    case 'underpaid':
    case 'late_paid':
      return `payment.${status}`;
    case 'pending':
    case 'expired':
    case 'refunded':
      return null;
  }
}

/**
 * Stores the receipt, updates the payment and writes the outbox event in one
 * transaction (context §7.2). A receipt already stored is a no-op. The payment
 * row is locked first, so concurrent receipts for one memo apply one at a time.
 */
export async function recordPaymentReceipt(
  db: Db,
  receipt: ReceiptCandidate,
  newEventId: () => string,
): Promise<ReceiptOutcome> {
  return db.transaction().execute(async (tx) => {
    const memo = receipt.memo === null ? null : parseMemo(receipt.memo);
    if (!memo?.ok) {
      return storeUnmatched(tx, receipt, memo === null ? 'no_memo' : 'unknown_memo');
    }
    const payment = await lockPaymentByMemo(tx, memo.value);
    if (payment === undefined) {
      return storeUnmatched(tx, receipt, 'unknown_memo');
    }
    const transition = transitionPayment(
      {
        status: payment.status,
        amountDue: payment.amount_due_stroops as Stroops,
        amountReceived: payment.amount_received_stroops as Stroops,
        expiresAt: instant(payment.expires_at.getTime()),
      },
      {
        type: 'receipt',
        amount: receipt.amount as Stroops,
        ledgerClosedAt: instant(receipt.ledgerClosedAt.getTime()),
      },
    );
    if (!transition.ok) {
      // e.g. money for an already refunded payment: keep it visible for manual review.
      return storeUnmatched(tx, receipt, 'invalid_transition');
    }
    const inserted = await insertReceipt(tx, {
      ...receiptColumns(receipt),
      match: 'matched',
      payment_id: payment.id,
    });
    if (!inserted) {
      return { kind: 'duplicate' };
    }
    const newStatus = transition.value.state.status;
    const updated = await addReceivedAmount(tx, {
      id: payment.id,
      expectedStatus: payment.status,
      amount: receipt.amount,
      newStatus,
      at: receipt.ledgerClosedAt,
    });
    if (updated === undefined) {
      throw new Error('Locked payment changed status inside its own transaction');
    }
    const eventType = newStatus === payment.status ? null : eventForStatus(newStatus);
    if (eventType !== null) {
      await enqueueEvent(tx, {
        id: newEventId(),
        type: eventType,
        aggregateId: updated.id,
        payload: await paymentEventData(tx, updated),
      });
    }
    return { kind: 'applied', payment: updated, excess: transition.value.excess, eventType };
  });
}

async function storeUnmatched(
  tx: Tx,
  receipt: ReceiptCandidate,
  reason: 'no_memo' | 'unknown_memo' | 'invalid_transition',
): Promise<ReceiptOutcome> {
  const inserted = await insertReceipt(tx, { ...receiptColumns(receipt), match: 'unmatched' });
  return inserted ? { kind: 'unmatched', reason } : { kind: 'duplicate' };
}

function receiptColumns(r: ReceiptCandidate) {
  return {
    id: r.id,
    tx_hash: r.txHash,
    item_index: r.itemIndex,
    ledger: r.ledger,
    ledger_closed_at: r.ledgerClosedAt,
    source_address: r.sourceAddress,
    destination: r.destination,
    asset_code: r.assetCode,
    asset_issuer: r.assetIssuer,
    amount_stroops: r.amount,
    memo: r.memo,
  };
}

async function paymentEventData(tx: Tx, payment: PaymentRow) {
  const receipts = await receiptsForPayment(tx, payment.id);
  return {
    payment_id: payment.id,
    merchant_order_id: payment.merchant_order_id,
    asset: payment.asset_code,
    amount_due: formatAmount(payment.amount_due_stroops as Stroops),
    amount_received: formatAmount(payment.amount_received_stroops as Stroops),
    tx_hashes: receipts.map((r) => r.tx_hash.toString('hex')),
  };
}
