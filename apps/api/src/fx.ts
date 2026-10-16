import { parseFxRate, USD_RATE, type FxRate } from '@rp/core/money/fx-rate';
import { err, ok, type Result } from '@rp/core/result';
import { z } from 'zod';
import type { KvStore } from './kv.js';

export interface Quote {
  /** Fiat units per 1 USDC (USDC is treated as exactly 1 USD). */
  readonly rate: FxRate;
  readonly asOf: Date;
}

export type FxError = 'fx_unavailable' | 'unsupported_currency';

export interface FxProvider {
  rateFor(currency: string): Promise<Result<Quote, FxError>>;
}

const CACHE_KEY = 'rp:fx:usd';

const Response = z.object({
  result: z.literal('success'),
  base_code: z.literal('USD'),
  time_last_update_unix: z.number().int(),
  time_next_update_unix: z.number().int(),
  conversion_rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()),
});
type Rates = z.infer<typeof Response>;

/** JSON numbers → exact decimal strings (shortest round-trip form, never exponent). */
function decimal(n: number): string {
  const s = n.toString();
  return s.includes('e') ? n.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') : s;
}

export interface ExchangeRateApiDeps {
  readonly apiKey: string;
  readonly kv: KvStore;
  readonly fetch: typeof fetch;
  readonly nowMs: () => number;
  readonly maxRateAgeSeconds: number;
  readonly onCacheError: (error: unknown) => void;
}

/**
 * ExchangeRate-API (context §6 Quote): one provider call per update period, cached in
 * Upstash until the provider's next scheduled update. Non-USD quotes fail closed when
 * the rate is older than `maxRateAgeSeconds`; USD never needs the provider.
 */
export function createExchangeRateApi(deps: ExchangeRateApiDeps): FxProvider {
  const fetchRates = async (): Promise<Rates> => {
    const res = await deps.fetch(
      `https://v6.exchangerate-api.com/v6/${encodeURIComponent(deps.apiKey)}/latest/USD`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) throw new Error(`ExchangeRate-API HTTP ${String(res.status)}`);
    return Response.parse(await res.json());
  };

  const loadRates = async (): Promise<Rates> => {
    try {
      const cached = await deps.kv.get(CACHE_KEY);
      if (cached !== null) return Response.parse(JSON.parse(cached));
    } catch (error) {
      deps.onCacheError(error);
    }
    const rates = await fetchRates();
    const ttl = Math.min(
      86_400,
      Math.max(60, rates.time_next_update_unix - Math.floor(deps.nowMs() / 1000)),
    );
    try {
      await deps.kv.set(CACHE_KEY, JSON.stringify(rates), ttl);
    } catch (error) {
      deps.onCacheError(error);
    }
    return rates;
  };

  return {
    async rateFor(currency) {
      if (currency === 'USD') return ok({ rate: USD_RATE, asOf: new Date(deps.nowMs()) });
      let rates: Rates;
      try {
        rates = await loadRates();
      } catch {
        return err('fx_unavailable');
      }
      const ageSeconds = deps.nowMs() / 1000 - rates.time_last_update_unix;
      if (ageSeconds > deps.maxRateAgeSeconds) return err('fx_unavailable');
      const raw = new Map(Object.entries(rates.conversion_rates)).get(currency);
      if (raw === undefined) return err('unsupported_currency');
      const rate = parseFxRate(decimal(raw));
      return rate.ok
        ? ok({ rate: rate.value, asOf: new Date(rates.time_last_update_unix * 1000) })
        : err('fx_unavailable');
    },
  };
}
