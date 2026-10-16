import { request } from 'node:https';
import { err, ok, type Result } from '@rp/core/result';

export interface SignerClient {
  sign(xdr: string): Promise<Result<string, string>>;
}

/** mTLS client for the keeper signer (context §14.5): the worker's certificate is its identity. */
export function createSignerClient(o: {
  readonly url: string;
  readonly key: Buffer;
  readonly cert: Buffer;
  readonly ca: Buffer;
}): SignerClient {
  const target = new URL('/v1/sign', o.url);
  return {
    sign(xdr) {
      return new Promise((resolve) => {
        const req = request(
          target,
          {
            method: 'POST',
            key: o.key,
            cert: o.cert,
            ca: o.ca,
            minVersion: 'TLSv1.3',
            timeout: 10_000,
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                  signed_xdr?: string;
                  error?: string;
                };
                resolve(
                  res.statusCode === 200 && typeof body.signed_xdr === 'string'
                    ? ok(body.signed_xdr)
                    : err(body.error ?? `HTTP ${String(res.statusCode)}`),
                );
              } catch {
                resolve(err('signer_bad_response'));
              }
            });
          },
        );
        req.on('timeout', () => req.destroy(new Error('signer timeout')));
        req.on('error', (e) => {
          resolve(err(`signer_unreachable: ${e.message}`));
        });
        req.end(JSON.stringify({ xdr }));
      });
    },
  };
}
