import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { guardKeeperTransaction, type KeeperRules } from '@rp/stellar/xdr-guards';
import type { Keypair } from '@stellar/stellar-sdk';
import type { Logger } from 'pino';
import { z } from 'zod';

/** Context §14.5: the only client allowed to ask for signatures. */
export const ALLOWED_CLIENT_CN = 'rp-worker';
const BODY_LIMIT_BYTES = 16 * 1024;

export interface SignerOptions {
  readonly keeper: Keypair;
  readonly rules: Omit<KeeperRules, 'nowSeconds' | 'keeper'>;
  readonly tls: { readonly key: Buffer; readonly cert: Buffer; readonly ca: Buffer };
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly nowSeconds: () => number;
}

export interface SignerStats {
  signed: number;
  rejected: number;
}

const SignRequest = z.object({ xdr: z.string().min(1).max(10_000) });

function send(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify(body));
}

/**
 * The keeper signer (context §14.5): mTLS on the private network, one operation, signs
 * only what `guardKeeperTransaction` accepts, logs every decision. Holds the only hot key.
 */
export function createSigner(o: SignerOptions): { server: Server; stats: SignerStats } {
  const stats: SignerStats = { signed: 0, rejected: 0 };
  const keeperAddress = o.keeper.publicKey();
  const server = createServer(
    {
      key: o.tls.key,
      cert: o.tls.cert,
      ca: o.tls.ca,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    },
    (req, res) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      if (peer.subject.CN !== ALLOWED_CLIENT_CN) {
        o.logger.warn(
          { security: true, cn: peer.subject.CN },
          'signer: client certificate not allowed',
        );
        send(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method === 'GET' && req.url === '/health/live') {
        send(res, 200, { status: 'ok', keeper: keeperAddress });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/sign') {
        send(res, 404, { error: 'not_found' });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > BODY_LIMIT_BYTES) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        let parsed: z.infer<typeof SignRequest>;
        try {
          parsed = SignRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          stats.rejected += 1;
          o.logger.warn(
            { security: true, decision: 'reject', reason: 'malformed_request' },
            'signer decision',
          );
          send(res, 400, { error: 'malformed_request' });
          return;
        }
        const guard = guardKeeperTransaction(parsed.xdr, {
          ...o.rules,
          keeper: keeperAddress,
          nowSeconds: o.nowSeconds(),
        });
        if (!guard.ok) {
          stats.rejected += 1;
          o.logger.warn(
            { security: true, decision: 'reject', reason: guard.error },
            'signer decision',
          );
          send(res, 422, { error: guard.error });
          return;
        }
        guard.value.transaction.sign(o.keeper);
        stats.signed += 1;
        o.logger.info({ decision: 'sign', tx_hash: guard.value.hash }, 'signer decision');
        send(res, 200, { signed_xdr: guard.value.transaction.toXdr(), hash: guard.value.hash });
      });
    },
  );
  return { server, stats };
}
