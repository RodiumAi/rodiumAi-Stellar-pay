import type { Executor } from './connection.js';
import type { NewReceipt, ReceiptRow } from './schema.js';

/** True when inserted; false when (tx_hash, item_index) was already recorded. */
export async function insertReceipt(db: Executor, receipt: NewReceipt): Promise<boolean> {
  const row = await db
    .insertInto('chain_receipts')
    .values(receipt)
    .onConflict((oc) => oc.columns(['tx_hash', 'item_index']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function receiptsForPayment(db: Executor, paymentId: string): Promise<ReceiptRow[]> {
  return db
    .selectFrom('chain_receipts')
    .selectAll()
    .where('payment_id', '=', paymentId)
    .orderBy('ledger')
    .orderBy('item_index')
    .execute();
}
