import { parseAmount, type Stroops } from '@rp/core/money/stroops';
import { err, ok, type Result } from '@rp/core/result';
import { withoutEmpty } from '@rp/config/app-config';
import { z } from 'zod';

export interface Plan {
  readonly code: string;
  readonly contractPlanId: number;
  readonly price: Stroops;
  readonly intervalSeconds: number;
}

/** API-only settings and secrets; shared settings come from `@rp/config/app-config`. */
export interface ApiConfig {
  readonly port: number;
  readonly checkoutBaseUrl: string;
  /** Exact `scheme://host[:port]` origins allowed for `return_url` (context §9.2). */
  readonly returnUrlOrigins: readonly string[];
  readonly paymentTtlSeconds: number;
  readonly plans: readonly Plan[];
  readonly hmacKeys: ReadonlyMap<string, Uint8Array>;
  readonly checkoutTokenKey: Uint8Array;
  readonly blindIndexKey: Uint8Array;
  readonly exchangeRateApiKey: string;
  readonly upstash: { readonly url: string; readonly token: string };
  readonly databaseUrl: string;
  readonly dataKeys: {
    readonly current: string;
    readonly stored: readonly { readonly id: string; readonly wrapped: string }[];
  };
  readonly localDevKmsMasterKey: Uint8Array | null;
}

const b64urlKey = (min: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((v) => Buffer.from(v, 'base64url'))
    .refine((b) => b.length >= min, `must decode to at least ${String(min)} bytes`);

const origin = z
  .url({ protocol: /^https?$/ })
  .refine((u) => new URL(u).origin === u.replace(/\/$/, ''), {
    message: 'must be a bare origin (scheme://host[:port])',
  });

const PlanSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]{1,64}$/),
  contractPlanId: z.number().int().min(0).max(4_294_967_295),
  price: z.string(),
  intervalSeconds: z.number().int().min(86_400),
});

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  CHECKOUT_BASE_URL: z.url({ protocol: /^https?$/ }),
  RETURN_URL_ORIGINS: z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(origin).min(1)),
  PAYMENT_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(1200),
  SUBSCRIPTION_PLANS: z
    .string()
    .default('[]')
    .transform((v, ctx) => {
      try {
        return JSON.parse(v) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be JSON' });
        return z.NEVER;
      }
    })
    .pipe(z.array(PlanSchema)),
  API_HMAC_KEYS: z
    .string()
    .transform((v) => v.split(',').map((pair) => pair.trim().split(':')))
    .pipe(
      z
        .array(z.tuple([z.string().regex(/^ak_[a-z0-9_]{1,32}$/), b64urlKey(32)]))
        .min(1)
        .max(2),
    ),
  CHECKOUT_TOKEN_KEY: b64urlKey(32),
  BLIND_INDEX_KEY: b64urlKey(32),
  EXCHANGERATE_API_KEY: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
  UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https?$/ }),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(20),
  DATABASE_URL_API: z.string().startsWith('postgres'),
  FIELD_DATA_KEYS: z
    .string()
    .transform((v) => v.split(',').map((pair) => pair.trim().split(':')))
    .pipe(
      z
        .array(z.tuple([z.string().regex(/^[0-9a-f]{32}$/), z.string().regex(/^[A-Za-z0-9_-]+$/)]))
        .min(1),
    ),
  FIELD_DATA_KEY_CURRENT: z.string().regex(/^[0-9a-f]{32}$/),
  LOCAL_DEV_KMS_MASTER_KEY: b64urlKey(32).optional(),
});

export function loadApiConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<ApiConfig, readonly string[]> {
  const parsed = EnvSchema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  const plans: Plan[] = [];
  for (const p of e.SUBSCRIPTION_PLANS) {
    const price = parseAmount(p.price);
    if (!price.ok || price.value === 0n)
      return err([`SUBSCRIPTION_PLANS: plan ${p.code} has an invalid price`]);
    plans.push({
      code: p.code,
      contractPlanId: p.contractPlanId,
      price: price.value,
      intervalSeconds: p.intervalSeconds,
    });
  }
  if (!e.FIELD_DATA_KEYS.some(([id]) => id === e.FIELD_DATA_KEY_CURRENT)) {
    return err(['FIELD_DATA_KEY_CURRENT: not among FIELD_DATA_KEYS']);
  }
  return ok({
    port: e.PORT,
    checkoutBaseUrl: e.CHECKOUT_BASE_URL.replace(/\/$/, ''),
    returnUrlOrigins: e.RETURN_URL_ORIGINS,
    paymentTtlSeconds: e.PAYMENT_TTL_SECONDS,
    plans,
    hmacKeys: new Map(e.API_HMAC_KEYS),
    checkoutTokenKey: e.CHECKOUT_TOKEN_KEY,
    blindIndexKey: e.BLIND_INDEX_KEY,
    exchangeRateApiKey: e.EXCHANGERATE_API_KEY,
    upstash: { url: e.UPSTASH_REDIS_REST_URL, token: e.UPSTASH_REDIS_REST_TOKEN },
    databaseUrl: e.DATABASE_URL_API,
    dataKeys: {
      current: e.FIELD_DATA_KEY_CURRENT,
      stored: e.FIELD_DATA_KEYS.map(([id, wrapped]) => ({ id, wrapped })),
    },
    localDevKmsMasterKey: e.LOCAL_DEV_KMS_MASTER_KEY ?? null,
  });
}
