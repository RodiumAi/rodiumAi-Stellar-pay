import type { Executor } from './connection.js';

export interface IngestCursor {
  readonly cursor: string;
  readonly ledger: number;
}

export async function getCursor(db: Executor, source: string): Promise<IngestCursor | undefined> {
  return db
    .selectFrom('ingest_cursors')
    .select(['cursor', 'ledger'])
    .where('source', '=', source)
    .executeTakeFirst();
}

/** Call inside the transaction that stores the receipts up to this cursor (context §13.4). */
export async function saveCursor(db: Executor, source: string, value: IngestCursor): Promise<void> {
  await db
    .insertInto('ingest_cursors')
    .values({ source, cursor: value.cursor, ledger: value.ledger })
    .onConflict((oc) =>
      oc
        .column('source')
        .doUpdateSet({ cursor: value.cursor, ledger: value.ledger, updated_at: new Date() }),
    )
    .execute();
}
