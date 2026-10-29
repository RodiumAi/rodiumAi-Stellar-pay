import { withoutEmpty } from '@rp/config/app-config';
import { networkConstants, type NetworkName } from '@rp/config/network';
import { err, ok, type Result } from '@rp/core/result';
import { z } from 'zod';

/**
 * How a request proves who is signed in.
 * - `alb`: the load balancer ran the login (Cognito) and forwards a signed `x-amzn-oidc-data`
 *   token; we verify its signature, signer and expiry, then the email allow-list.
 * - `dev`: everyone is `devEmail`. Refused when NODE_ENV=production.
 */
export type AdminAuth =
  | {
      readonly mode: 'alb';
      readonly albArn: string;
      readonly region: string;
      readonly logoutUrl: string | null;
    }
  | { readonly mode: 'dev'; readonly devEmail: string };

export interface AdminConfig {
  readonly port: number;
  readonly logLevel: string;
  /** Where the dashboard is mounted, e.g. `/admin`; every page lives under it. */
  readonly basePath: string;
  readonly allowedEmails: ReadonlySet<string>;
  readonly auth: AdminAuth;
  /** A read-only database role (`rp_readonly`): the dashboard cannot change data. */
  readonly databaseUrl: string;
  readonly network: NetworkName;
  readonly horizonUrl: string;
  readonly usdcIssuer: string;
  readonly merchant: string;
  /** The API's public readiness URL, shown on the overview. */
  readonly apiReadyUrl: string | null;
}

const emailList = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.email()).min(1));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  ADMIN_BASE_PATH: z.string().regex(/^\/[a-z0-9][a-z0-9-]{0,62}$/, 'must look like /name'),
  ADMIN_ALLOWED_EMAILS: emailList,
  ADMIN_AUTH: z.enum(['alb', 'dev']).default('alb'),
  ADMIN_ALB_ARN: z
    .string()
    .regex(/^arn:aws[a-z-]*:elasticloadbalancing:[a-z0-9-]+:\d{12}:loadbalancer\/app\/[\w-]+\/\w+$/)
    .optional(),
  ADMIN_LOGOUT_URL: z.url({ protocol: /^https$/ }).optional(),
  ADMIN_DEV_EMAIL: z.email().optional(),
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}-[a-z]{4,10}-\d$/)
    .optional(),
  DATABASE_URL_READONLY: z.string().startsWith('postgres'),
  RP_STELLAR_NETWORK: z.enum(['testnet', 'mainnet']),
  RP_STELLAR_HORIZON_URL: z.url({ protocol: /^https?$/ }).optional(),
  MERCHANT_ADDRESS: z.string().regex(/^G[A-Z2-7]{55}$/),
  ADMIN_API_READY_URL: z.url({ protocol: /^https?$/ }).optional(),
});

export function loadAdminConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<AdminConfig, readonly string[]> {
  const parsed = EnvSchema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  let auth: AdminAuth;
  if (e.ADMIN_AUTH === 'alb') {
    if (e.ADMIN_ALB_ARN === undefined) return err(['ADMIN_ALB_ARN: required when ADMIN_AUTH=alb']);
    // The ARN names the region the load balancer signs its tokens in.
    const region = e.AWS_REGION ?? e.ADMIN_ALB_ARN.split(':')[3] ?? '';
    auth = { mode: 'alb', albArn: e.ADMIN_ALB_ARN, region, logoutUrl: e.ADMIN_LOGOUT_URL ?? null };
  } else {
    if (e.NODE_ENV === 'production') return err(['ADMIN_AUTH: dev is not allowed in production']);
    if (e.ADMIN_DEV_EMAIL === undefined)
      return err(['ADMIN_DEV_EMAIL: required when ADMIN_AUTH=dev']);
    auth = { mode: 'dev', devEmail: e.ADMIN_DEV_EMAIL.toLowerCase() };
  }
  const net = networkConstants(e.RP_STELLAR_NETWORK);
  return ok({
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    basePath: e.ADMIN_BASE_PATH,
    allowedEmails: new Set(e.ADMIN_ALLOWED_EMAILS),
    auth,
    databaseUrl: e.DATABASE_URL_READONLY,
    network: e.RP_STELLAR_NETWORK,
    horizonUrl: (e.RP_STELLAR_HORIZON_URL ?? net.defaultHorizonUrl).replace(/\/$/, ''),
    usdcIssuer: net.usdc.issuer,
    merchant: e.MERCHANT_ADDRESS,
    apiReadyUrl: e.ADMIN_API_READY_URL ?? null,
  });
}
