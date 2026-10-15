import type { Executor } from './connection.js';

export interface AuditEntry {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly targetId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Append-only: no runtime role may update or delete audit rows (context §7.3). */
export async function appendAudit(db: Executor, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      id: entry.id,
      actor: entry.actor,
      action: entry.action,
      target_id: entry.targetId,
      details: JSON.stringify(entry.details),
    })
    .execute();
}
