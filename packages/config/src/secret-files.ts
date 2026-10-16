import { readFileSync } from 'node:fs';
import { err, ok, type Result } from '@rp/core/result';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Secrets are mounted as files by the platform (AWS Secrets Manager via the CSI driver,
 * context §12.4), not passed as plain environment variables. `FOO_FILE=/path` sets `FOO`
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
  for (const [key, path] of Object.entries(env)) {
    if (!key.endsWith('_FILE') || path === undefined || path.trim() === '') continue;
    const name = key.slice(0, -'_FILE'.length);
    if (name === '') continue;
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
