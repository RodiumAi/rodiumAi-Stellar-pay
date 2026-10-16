import { createPrivateKey, type KeyObject } from 'node:crypto';
import { withoutEmpty } from '@rp/config/app-config';
import { err, ok, type Result } from '@rp/core/result';
import { z } from 'zod';

export interface WorkerConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly sessionDatabaseUrl: string;
  readonly webhookUrl: string;
  readonly webhookKeyId: string;
  readonly webhookPrivateKey: KeyObject;
  readonly ingestSource: 'horizon' | 'rpc';
  readonly ingestStartLedger: number | null;
}

const EnvSchema = z.object({
  WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(9090),
  DATABASE_URL_WORKER: z.string().startsWith('postgres'),
  DATABASE_URL_WORKER_SESSION: z.string().startsWith('postgres'),
  WEBHOOK_URL: z.url({ protocol: /^https?$/ }),
  WEBHOOK_SIGNING_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  WEBHOOK_SIGNING_KEY_PEM: z.string().includes('PRIVATE KEY'),
  INGEST_SOURCE: z.enum(['horizon', 'rpc']).default('horizon'),
  INGEST_START_LEDGER: z.coerce.number().int().positive().optional(),
  NODE_ENV: z.string().default('development'),
});

export function loadWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<WorkerConfig, readonly string[]> {
  const parsed = EnvSchema.safeParse(withoutEmpty(env));
  if (!parsed.success)
    return err(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && !e.WEBHOOK_URL.startsWith('https://')) {
    return err(['WEBHOOK_URL: must be https in production']);
  }
  if (e.INGEST_SOURCE === 'rpc' && e.INGEST_START_LEDGER === undefined) {
    return err(['INGEST_START_LEDGER: required for the rpc source (no "now" cursor)']);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(e.WEBHOOK_SIGNING_KEY_PEM.replaceAll('\\n', '\n'));
  } catch {
    return err(['WEBHOOK_SIGNING_KEY_PEM: not a valid PEM private key']);
  }
  if (key.asymmetricKeyType !== 'ed25519')
    return err(['WEBHOOK_SIGNING_KEY_PEM: must be an Ed25519 key']);
  return ok({
    port: e.WORKER_PORT,
    databaseUrl: e.DATABASE_URL_WORKER,
    sessionDatabaseUrl: e.DATABASE_URL_WORKER_SESSION,
    webhookUrl: e.WEBHOOK_URL,
    webhookKeyId: e.WEBHOOK_SIGNING_KEY_ID,
    webhookPrivateKey: key,
    ingestSource: e.INGEST_SOURCE,
    ingestStartLedger: e.INGEST_START_LEDGER ?? null,
  });
}
