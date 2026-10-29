/** Live facts from outside the database, each failing soft (the page still renders). */
export interface StatusProbes {
  /** Treasury balances from Horizon, as decimal strings; null when Horizon is unreachable. */
  treasury(): Promise<TreasuryBalances | null>;
  /** The API's readiness checks; null when the URL is not configured or unreachable. */
  apiReady(): Promise<ApiReady | null>;
}

export interface TreasuryBalances {
  readonly usdc: string | null;
  readonly xlm: string;
}

export interface ApiReady {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
}

const TIMEOUT_MS = 4000;
const CACHE_MS = 30_000;

/** Caches a slow lookup for `ms`, so reloading the overview does not hammer Horizon. */
function cached<T>(ms: number, now: () => number, load: () => Promise<T>): () => Promise<T> {
  let value: { at: number; data: T } | null = null;
  return async () => {
    if (value !== null && now() - value.at < ms) return value.data;
    const data = await load();
    value = { at: now(), data };
    return data;
  };
}

export function createStatusProbes(o: {
  readonly horizonUrl: string;
  readonly merchant: string;
  readonly usdcIssuer: string;
  readonly apiReadyUrl: string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): StatusProbes {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  return {
    treasury: cached(CACHE_MS, now, async () => {
      try {
        const res = await doFetch(`${o.horizonUrl}/accounts/${o.merchant}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const account = (await res.json()) as {
          balances?: {
            asset_type: string;
            asset_code?: string;
            asset_issuer?: string;
            balance: string;
          }[];
        };
        const balances = account.balances ?? [];
        const usdc = balances.find(
          (b) => b.asset_code === 'USDC' && b.asset_issuer === o.usdcIssuer,
        );
        const xlm = balances.find((b) => b.asset_type === 'native');
        return { usdc: usdc?.balance ?? null, xlm: xlm?.balance ?? '0' };
      } catch {
        return null;
      }
    }),
    apiReady: async () => {
      const url = o.apiReadyUrl;
      if (url === null) return null;
      try {
        const res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const body = (await res.json()) as { checks?: Record<string, unknown> };
        const checks = Object.fromEntries(
          Object.entries(body.checks ?? {}).map(([k, v]) => [k, v === true]),
        );
        return { ready: res.ok, checks };
      } catch {
        return null;
      }
    },
  };
}
