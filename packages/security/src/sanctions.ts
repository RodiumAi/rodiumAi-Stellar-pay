import { randomInt } from 'node:crypto';

/** A Stellar account id (G…, 56 characters, base32). */
export const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;

/** OFAC's published SDN list (CSV); redirects to a short-lived download URL. */
export const OFAC_SDN_CSV_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV';

/**
 * Stellar accounts named in an OFAC SDN CSV. Crypto addresses appear in the remarks column as
 * "Digital Currency Address - <TYPE> <address>;". Only Stellar-format addresses are kept,
 * whatever TYPE OFAC files them under (XLM, USDC, …).
 */
export function parseOfacStellarAddresses(csv: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const m of csv.matchAll(/Digital Currency Address - [A-Za-z0-9]+ ([A-Za-z0-9]+)/g)) {
    const address = m[1];
    if (address !== undefined && STELLAR_ACCOUNT.test(address)) found.add(address);
  }
  return found;
}

export interface ScreenLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface SanctionsScreen {
  /** True when the account is on the loaded OFAC list or the operator's block list. */
  isBlocked(address: string): boolean;
  /** Downloads the list now; on failure keeps the previous one. */
  refresh(): Promise<void>;
  /** Loads the list, then refreshes it every `refreshMs` (±10 %). Returns a stop function. */
  start(): () => void;
}

/**
 * Wallet screening against the OFAC SDN list plus `blocked` (operator-supplied addresses).
 * Fail-open by design: if the list has never loaded (OFAC unreachable at start-up), only
 * `blocked` applies and an error is logged, so payments keep working; a stale list is kept
 * and logged as a warning. `source: 'off'` disables the download (tests, local development).
 */
export function createSanctionsScreen(o: {
  readonly source: 'ofac' | 'off';
  readonly blocked: readonly string[];
  readonly logger: ScreenLogger;
  readonly fetch?: typeof fetch;
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly refreshMs?: number;
  readonly random?: () => number;
}): SanctionsScreen {
  const blocked = new Set(o.blocked);
  let listed: ReadonlySet<string> = new Set();
  let loaded = false;
  let reportedNeverLoaded = false;
  const doFetch = o.fetch ?? fetch;
  const refreshMs = o.refreshMs ?? 24 * 3600 * 1000;
  // Jitter only (not security-sensitive), but the repo bans Math.random: use the CSPRNG.
  const random = o.random ?? (() => randomInt(0, 1_000_000) / 1_000_000);

  const refresh = async (): Promise<void> => {
    if (o.source === 'off') return;
    try {
      const res = await doFetch(o.url ?? OFAC_SDN_CSV_URL, {
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const text = await res.text();
      // A real list has thousands of rows; a short body is an error page, not an empty list.
      if (!text.includes('Digital Currency Address')) throw new Error('unexpected list format');
      listed = parseOfacStellarAddresses(text);
      loaded = true;
      o.logger.info({ stellar_addresses: listed.size }, 'sanctions list loaded');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (loaded) {
        o.logger.warn({ alert: 'sanctions_list_stale', reason }, 'sanctions list refresh failed');
      } else if (!reportedNeverLoaded) {
        reportedNeverLoaded = true;
        o.logger.error(
          { alert: 'sanctions_list_unavailable', reason },
          'sanctions list not loaded; screening only the configured block list',
        );
      }
    }
  };

  return {
    isBlocked: (address) => blocked.has(address) || listed.has(address),
    refresh,
    start() {
      if (o.source === 'off') return () => undefined;
      let timer: NodeJS.Timeout | undefined;
      let stopped = false;
      const schedule = (): void => {
        const delay = Math.round(refreshMs * (0.9 + 0.2 * random()));
        timer = setTimeout(() => {
          void refresh().finally(() => {
            if (!stopped) schedule();
          });
        }, delay);
        timer.unref();
      };
      void refresh().finally(() => {
        if (!stopped) schedule();
      });
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}
