import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface TlsMaterial {
  readonly key: Buffer;
  readonly cert: Buffer;
  readonly ca: Buffer;
  /** Expiry of the leaf certificate (unix seconds), exported as a metric (§18). */
  readonly notAfterSeconds: number;
}

export interface TlsFiles {
  /** Current material; files are re-read at most once per `refreshMs`. */
  current(): TlsMaterial;
}

/**
 * mTLS key/cert/CA from mounted files (cert-manager rotates them every 30 days, §12.1).
 * Re-reading keeps a long-running process on the renewed certificate without a restart.
 * A failed re-read (e.g. mid-rotation) keeps the previous material.
 */
export function createTlsFiles(o: {
  /** File path, or the PEM itself (see `read` below). */
  readonly keyPath: string;
  readonly certPath: string;
  readonly caPath: string;
  readonly refreshMs?: number;
  readonly nowMs?: () => number;
  readonly read?: (path: string) => Buffer;
  readonly onReload?: (m: TlsMaterial) => void;
}): TlsFiles {
  // A value that is itself PEM is used as is: ECS injects secrets as environment variables,
  // and a read-only container without a shell cannot write them to files. Inline material
  // only changes on redeploy; files are re-read for rotation.
  const read =
    o.read ??
    ((pathOrPem: string) =>
      pathOrPem.includes('-----BEGIN ')
        ? Buffer.from(pathOrPem.replaceAll('\\n', '\n'))
        : // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured paths
          readFileSync(pathOrPem));
  const nowMs = o.nowMs ?? Date.now;
  const refreshMs = o.refreshMs ?? 60_000;
  const load = (): TlsMaterial => {
    const cert = read(o.certPath);
    return {
      key: read(o.keyPath),
      cert,
      ca: read(o.caPath),
      notAfterSeconds: Math.floor(Date.parse(new X509Certificate(cert).validTo) / 1000),
    };
  };
  let material = load();
  let loadedAt = nowMs();
  return {
    current() {
      if (nowMs() - loadedAt < refreshMs) return material;
      loadedAt = nowMs();
      try {
        const next = load();
        if (!next.cert.equals(material.cert) || !next.key.equals(material.key)) {
          material = next;
          o.onReload?.(material);
        }
      } catch {
        // Keep serving with the previous files; the expiry metric shows if this persists.
      }
      return material;
    },
  };
}
