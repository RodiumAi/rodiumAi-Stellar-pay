import { parseCurrency } from '@rp/core/money/fiat';
import { parseAmount, type Stroops } from '@rp/core/money/stroops';
import { err, ok, type Result } from '@rp/core/result';
import { parseStellarAddress } from '@rp/core/stellar-address';
import { z } from 'zod';
import { networkConstants, type NetworkConfig } from './network.js';

export interface AppConfig {
  readonly env: 'development' | 'test' | 'staging' | 'production';
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly network: NetworkConfig;
  readonly limits: {
    readonly maxPayment: Stroops;
    readonly maxSubscriptionPrice: Stroops;
    readonly subscriptionApprovePeriods: number;
  };
  readonly fx: {
    readonly supportedFiat: readonly string[];
    readonly maxRateAgeSeconds: number;
  };
}

export interface ConfigError {
  readonly code: 'invalid_config';
  /** Variable names and reasons only; never values, which may be secrets. */
  readonly issues: readonly string[];
}

const strkey = (prefix: 'G' | 'C') =>
  z.string().refine((v) => v.startsWith(prefix) && parseStellarAddress(v).ok, {
    message: `must be a ${prefix}... Stellar strkey`,
  });

const usdcAmount = z.string().transform((v, ctx) => {
  const parsed = parseAmount(v);
  if (!parsed.ok || parsed.value === 0n) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive USDC amount (≤ 7 decimals)' });
    return z.NEVER;
  }
  return parsed.value;
});

const httpsUrl = z.url({ protocol: /^https$/ });

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    RP_STELLAR_NETWORK: z.enum(['testnet', 'mainnet']),
    RP_STELLAR_RPC_URL: httpsUrl.optional(),
    RP_STELLAR_HORIZON_URL: httpsUrl.optional(),
    MERCHANT_ADDRESS: strkey('G'),
    SUBSCRIPTION_CONTRACT_ID: strkey('C'),
    MAX_FEE_STROOPS: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      .transform(BigInt),
    MAX_SOROBAN_FEE_STROOPS: z
      .string()
      .regex(/^[1-9][0-9]{0,10}$/)
      .default('20000000')
      .transform(BigInt),
    MAX_PAYMENT_USDC: usdcAmount,
    MAX_SUBSCRIPTION_PRICE_USDC: usdcAmount,
    SUBSCRIPTION_APPROVE_PERIODS: z.coerce.number().int().min(1).max(12).default(3),
    FX_SUPPORTED_FIAT: z
      .string()
      .default('USD')
      .transform((v) => v.split(',').map((c) => c.trim()))
      .pipe(z.array(z.string().refine((c) => parseCurrency(c).ok, 'unsupported currency')).min(1)),
    FX_MAX_RATE_AGE_SECONDS: z.coerce.number().int().min(60).max(172_800).default(93_600),
  })
  .superRefine((env, ctx) => {
    if (env.RP_STELLAR_NETWORK === 'mainnet' && env.RP_STELLAR_RPC_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['RP_STELLAR_RPC_URL'],
        message: 'required on mainnet (no public SDF RPC)',
      });
    }
  });

/** `KEY=` in an env file means "not set", so optional settings fall back to defaults. */
/** Comma-separated Stellar accounts the operator refuses as payers (wallet screening). */
export const blockedAddressList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^G[A-Z2-7]{55}$/, 'must be Stellar account ids (G…)')));

export function withoutEmpty(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined && e[1].trim() !== '',
    ),
  );
}

/** Parses configuration once at boot. Callers exit the process on error (fail fast). */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigError> {
  const parsed = EnvSchema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    return err({
      code: 'invalid_config',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }
  const e = parsed.data;
  const constants = networkConstants(e.RP_STELLAR_NETWORK);
  const rpcUrl = e.RP_STELLAR_RPC_URL ?? constants.defaultRpcUrl;
  if (rpcUrl === null) {
    return err({ code: 'invalid_config', issues: ['RP_STELLAR_RPC_URL: required'] });
  }
  return ok({
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    network: {
      name: constants.name,
      passphrase: constants.passphrase,
      rpcUrl,
      horizonUrl: e.RP_STELLAR_HORIZON_URL ?? constants.defaultHorizonUrl,
      usdc: constants.usdc,
      merchant: e.MERCHANT_ADDRESS as NetworkConfig['merchant'],
      subscriptionContractId: e.SUBSCRIPTION_CONTRACT_ID,
      maxFeeStroops: e.MAX_FEE_STROOPS,
      maxSorobanFeeStroops: e.MAX_SOROBAN_FEE_STROOPS,
    },
    limits: {
      maxPayment: e.MAX_PAYMENT_USDC,
      maxSubscriptionPrice: e.MAX_SUBSCRIPTION_PRICE_USDC,
      subscriptionApprovePeriods: e.SUBSCRIPTION_APPROVE_PERIODS,
    },
    fx: {
      supportedFiat: e.FX_SUPPORTED_FIAT,
      maxRateAgeSeconds: e.FX_MAX_RATE_AGE_SECONDS,
    },
  });
}
