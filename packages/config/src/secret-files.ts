import { readFileSync } from 'node:fs';
import { err, ok, type Result } from '@rp/core/result';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The only names that may come from files. An explicit list, because other `*_FILE`
 * variables already exist with their own meaning (`SSL_CERT_FILE` in the base image,
 * `NODE_EXTRA_CA_CERTS`-style settings) and must not be swallowed as secrets.
 */
export const SECRET_NAMES = [
  'API_HMAC_KEYS',
  'BLIND_INDEX_KEY',
  'CHECKOUT_TOKEN_KEY',
  'DATABASE_URL_API',
  'DATABASE_URL_WORKER',
  'EXCHANGERATE_API_KEY',
  'FIELD_DATA_KEYS',
  'KEEPER_SECRET',
  'LOCAL_DEV_KMS_MASTER_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  'WEBHOOK_SIGNING_KEY_PEM',
] as const;

/**
 * Secrets are mounted as files by the platform (AWS Secrets Manager via the CSI driver,
 * context §12.4), not passed as plain environment variables. `FOO_FILE=/path` sets `FOO`
 * (for FOO in SECRET_NAMES)
 * to the file's contents (one trailing newline removed). Setting both is an error, so a
 * stale value can never shadow the mounted secret.
 */
export function resolveSecretFiles(
  env: Env,
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured paths
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Result<Record<string, string | undefined>, readonly string[]> {
  const out = new Map(Object.entries(env));
  const errors: string[] = [];
  for (const name of SECRET_NAMES) {
    const key = `${name}_FILE`;
    const path = out.get(key);
    if (path === undefined || path.trim() === '') continue;
    out.delete(key);
    if ((out.get(name) ?? '').trim() !== '') {
      errors.push(`${name}: set both directly and via ${key}; use one`);
      continue;
    }
    try {
      out.set(name, read(path).replace(/\r?\n$/, ''));
    } catch (e) {
      // Only the code: a message could include file contents on some platforms.
      const code = (e as NodeJS.ErrnoException).code ?? 'unreadable';
      errors.push(`${key}: cannot read ${path} (${code})`);
    }
  }
  return errors.length > 0 ? err(errors) : ok(Object.fromEntries(out));
}
