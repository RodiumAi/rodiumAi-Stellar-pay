import { err, ok, type Result } from '@rp/core/result';

export interface IdempotentInsert<T> {
  readonly row: T;
  /** False when the same key and request hash were already stored; `row` is the original. */
  readonly created: boolean;
}

/**
 * Resolves an `INSERT … ON CONFLICT (idempotency_key) DO NOTHING` (context §7.2):
 * same key + same request hash → original row; different hash → conflict.
 */
export function resolveIdempotentInsert<T extends { readonly request_hash: Buffer }>(
  inserted: T | undefined,
  existing: T | undefined,
  requestHash: Buffer,
): Result<IdempotentInsert<T>, 'idempotency_conflict'> {
  if (inserted !== undefined) {
    return ok({ row: inserted, created: true });
  }
  if (existing === undefined) {
    throw new Error('Idempotency key conflicted but no existing row was found');
  }
  return existing.request_hash.equals(requestHash)
    ? ok({ row: existing, created: false })
    : err('idempotency_conflict');
}
