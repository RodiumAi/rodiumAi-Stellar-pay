import { cryptoRandomBytes } from '@rp/core/random';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import type { Db } from '@rp/db/connection';
import { getCursor, saveCursor } from '@rp/db/cursors';
import { INGESTER_LEASE, releaseLease, tryAcquireLease } from '@rp/db/leader-lease';
import {
  applyPaymentReceipt,
  storeUnmatchedReceipt,
  type ReceiptCandidate,
} from '@rp/db/payment-receipts';
import type { LedgerSource } from '@rp/stellar/ledger-source';
import {
  classifyPayment,
  type MatchingRules,
  type ObservedPayment,
} from '@rp/stellar/observed-payment';
import type { Metrics } from '../metrics.js';
import type { Job, JobLogger } from '../scheduler.js';

const newId = (): string => uuidV7(instant(Date.now()), cryptoRandomBytes);

function candidate(p: ObservedPayment, amount: bigint, memo: string | null): ReceiptCandidate {
  return {
    id: newId(),
    txHash: Buffer.from(p.txHash, 'hex'),
    itemIndex: p.itemIndex,
    ledger: p.ledger,
    ledgerClosedAt: p.ledgerClosedAt,
    sourceAddress: p.from,
    destination: p.to,
    assetCode: p.asset?.code ?? 'XLM',
    assetIssuer: p.asset?.issuer ?? 'native',
    amount,
    memo,
  };
}

/** Cursor value meaning "start at this ledger" before the provider has issued a cursor. */
const LEDGER_PREFIX = 'ledger:';

function positionOf(
  cursor: string,
): { readonly cursor: string } | { readonly startLedger: number } {
  return cursor.startsWith(LEDGER_PREFIX)
    ? { startLedger: Number(cursor.slice(LEDGER_PREFIX.length)) }
    : { cursor };
}

export interface PageStats {
  readonly applied: number;
  readonly unmatched: number;
  readonly duplicates: number;
  readonly ignored: number;
  readonly cursor: string;
  readonly lastLedger: number | null;
  readonly latestLedger: number;
  readonly empty: boolean;
}

/**
 * Fetches one page (network, outside any transaction) and writes every receipt plus the
 * new cursor in ONE transaction, so a crash can neither skip nor double-count (§13.4).
 * `cursorName: null` re-scans without moving the ingest cursor (reconciliation).
 */
export async function processPage(
  db: Db,
  source: LedgerSource,
  rules: MatchingRules,
  position: { readonly cursor: string } | { readonly startLedger: number },
  limit: number,
  cursorName: string | null,
  logger: JobLogger,
): Promise<PageStats> {
  const page = await source.fetchPayments(position, limit);
  const stats = { applied: 0, unmatched: 0, duplicates: 0, ignored: 0 };
  let lastLedger: number | null = null;
  await db.transaction().execute(async (tx) => {
    for (const p of page.payments) {
      lastLedger = Math.max(lastLedger ?? 0, p.ledger);
      const c = classifyPayment(p, rules);
      if (c.kind === 'ignored') {
        stats.ignored += 1;
        continue;
      }
      if (c.kind === 'unmatched') {
        if (c.amount === null) {
          logger.warn(
            { alert: 'unmatched_receipt', reason: c.reason, tx_hash: p.txHash },
            'unparseable receipt',
          );
          stats.unmatched += 1;
          continue;
        }
        const stored = await storeUnmatchedReceipt(tx, candidate(p, c.amount, p.memo.value));
        if (stored) stats.unmatched += 1;
        else stats.duplicates += 1;
        continue;
      }
      const outcome = await applyPaymentReceipt(tx, candidate(p, c.amount, c.memo), newId);
      if (outcome.kind === 'duplicate') stats.duplicates += 1;
      else if (outcome.kind === 'unmatched') stats.unmatched += 1;
      else stats.applied += 1;
    }
    const inputCursor = 'cursor' in position ? position.cursor : null;
    // Persist on any progress: receipts, or a provider cursor that advanced over empty ledgers.
    if (cursorName !== null && (page.payments.length > 0 || page.cursor !== inputCursor)) {
      const previous = await getCursor(tx, cursorName);
      await saveCursor(tx, cursorName, {
        cursor: page.cursor,
        ledger: lastLedger ?? previous?.ledger ?? 0,
      });
    }
  });
  if (stats.unmatched > 0) {
    // Context §13.2: unmatched money is never auto-credited and always alerts.
    logger.warn(
      { alert: 'unmatched_receipt', count: stats.unmatched },
      'unmatched receipts stored for review',
    );
  }
  return {
    ...stats,
    cursor: page.cursor,
    lastLedger,
    latestLedger: page.latestLedger,
    empty: page.payments.length === 0,
  };
}

export interface IngestDeps {
  readonly db: Db;
  /** This process's identity for the ingest lease (unique per replica). */
  readonly holder: string;
  /** Lease length; renewed every pass and before every page (default 30 s). */
  readonly leaseSeconds?: number;
  readonly source: LedgerSource;
  readonly rules: MatchingRules;
  readonly startLedger: number | null;
  readonly metrics: Metrics;
  readonly logger: JobLogger;
  readonly pageSize?: number;
  readonly maxPagesPerPass?: number;
}

/**
 * Ingest job: only the lease holder runs; other replicas are hot standbys and take over
 * when the lease expires (a crashed leader) or is released (graceful shutdown). Matching
 * is idempotent, so a stalled leader overlapping with its successor cannot double-count.
 */
export function createIngestJob(
  deps: IngestDeps,
  intervalMs = 2000,
): Job & { release(): Promise<void> } {
  let leader = false;
  const cursorName = `payments:${deps.source.name}`;
  const leaseSeconds = deps.leaseSeconds ?? 30;

  const ensureLeader = async (): Promise<boolean> => {
    const held = await tryAcquireLease(deps.db, INGESTER_LEASE, deps.holder, leaseSeconds);
    if (held && !leader) deps.logger.info({ source: deps.source.name }, 'became ingest leader');
    if (!held && leader) deps.logger.warn({ source: deps.source.name }, 'lost the ingest lease');
    leader = held;
    deps.metrics.set('ingest_is_leader', held ? 1 : 0);
    return held;
  };

  /**
   * First run: pin the starting point and persist it immediately. Re-asking the provider
   * for "now" on every pass would skip payments that land between two passes.
   */
  const startingPosition = async (): Promise<void> => {
    const start =
      deps.startLedger ?? (await deps.source.fetchPayments({ cursor: 'now' }, 1)).latestLedger;
    await saveCursor(deps.db, cursorName, {
      cursor: `${LEDGER_PREFIX}${String(start)}`,
      ledger: start,
    });
    deps.logger.info({ start_ledger: start }, 'ingest cursor initialised');
  };

  return {
    name: 'ingest',
    intervalMs,
    async run(signal) {
      for (let i = 0; i < (deps.maxPagesPerPass ?? 20) && !signal.aborted; i++) {
        // Renew before every page: a pass never outlives the lease it started with.
        if (!(await ensureLeader())) return;
        let saved = await getCursor(deps.db, cursorName);
        if (saved === undefined) {
          await startingPosition();
          saved = await getCursor(deps.db, cursorName);
          if (saved === undefined) return;
        }
        const position = positionOf(saved.cursor);
        const stats = await processPage(
          deps.db,
          deps.source,
          deps.rules,
          position,
          deps.pageSize ?? 200,
          cursorName,
          deps.logger,
        );
        const processed = stats.lastLedger ?? saved.ledger;
        deps.metrics.set('ingest_lag_ledgers', Math.max(0, stats.latestLedger - processed));
        deps.metrics.inc('receipts_applied_total', stats.applied);
        deps.metrics.inc('receipts_unmatched_total', stats.unmatched);
        if (stats.empty) {
          // Nothing new; we are caught up, so lag is zero relative to the provider.
          deps.metrics.set('ingest_lag_ledgers', 0);
          return;
        }
      }
    },
    async release() {
      if (leader) await releaseLease(deps.db, INGESTER_LEASE, deps.holder);
      leader = false;
    },
  };
}

export interface ReconcileDeps {
  readonly db: Db;
  readonly source: LedgerSource;
  readonly rules: MatchingRules;
  readonly logger: JobLogger;
  readonly metrics: Metrics;
  /** Context §13.4: re-scan the last 2,000 ledgers. */
  readonly windowLedgers?: number;
}

/** Re-scans recent ledgers and applies anything missed; idempotent via receipt uniqueness. */
export function createReconcileJob(deps: ReconcileDeps, intervalMs = 15 * 60_000): Job {
  return {
    name: 'reconcile',
    intervalMs,
    async run(signal) {
      const cursor = await getCursor(deps.db, `payments:${deps.source.name}`);
      if (cursor === undefined) return;
      let position: { cursor: string } | { startLedger: number } = {
        startLedger: Math.max(1, cursor.ledger - (deps.windowLedgers ?? 2000)),
      };
      let filled = 0;
      for (let i = 0; i < 100 && !signal.aborted; i++) {
        const stats = await processPage(
          deps.db,
          deps.source,
          deps.rules,
          position,
          200,
          null,
          deps.logger,
        );
        filled += stats.applied + stats.unmatched;
        if (stats.empty || (stats.lastLedger !== null && stats.lastLedger >= cursor.ledger)) break;
        position = { cursor: stats.cursor };
      }
      if (filled > 0) {
        deps.metrics.inc('reconcile_filled_total', filled);
        deps.logger.warn(
          { alert: 'reconcile_filled_gap', filled },
          'reconciliation applied missed receipts',
        );
      }
    },
  };
}
