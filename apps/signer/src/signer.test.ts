import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Account,
  Asset,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSigner } from './signer.js';

const NOW = Math.floor(Date.now() / 1000);
const keeper = Keypair.random();
const contractId = StrKey.encodeContract(randomBytes(32));
const dir = mkdtempSync(join(tmpdir(), 'rp-mtls-'));
const rogue = mkdtempSync(join(tmpdir(), 'rp-mtls-rogue-'));
// eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dirs created above
const file = (d: string, name: string): Buffer => readFileSync(join(d, name));
const logs: string[] = [];

let port = 0;
let signer: ReturnType<typeof createSigner>;

beforeAll(async () => {
  const script = new URL('../../../scripts/dev-mtls.sh', import.meta.url).pathname;
  execFileSync(script, [dir]);
  execFileSync(script, [rogue]);
  // A client cert from the right CA but with the wrong name.
  execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-subj',
      '/CN=rp-api',
      '-keyout',
      join(dir, 'api.key'),
      '-out',
      join(dir, 'api.csr'),
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      join(dir, 'api.csr'),
      '-CA',
      join(dir, 'ca.crt'),
      '-CAkey',
      join(dir, 'ca.key'),
      '-CAcreateserial',
      '-days',
      '1',
      '-out',
      join(dir, 'api.crt'),
    ],
    { stdio: 'ignore' },
  );
  signer = createSigner({
    keeper,
    rules: { networkPassphrase: Networks.TESTNET, maxFeeStroops: 10_000_000n, contractId },
    tls: { key: file(dir, 'signer.key'), cert: file(dir, 'signer.crt'), ca: file(dir, 'ca.crt') },
    logger: {
      info: (o: object) => logs.push(JSON.stringify(o)),
      warn: (o: object) => logs.push(JSON.stringify(o)),
      error: () => undefined,
    } as never,
    nowSeconds: () => NOW,
  });
  await new Promise<void>((r) => signer.server.listen(0, '127.0.0.1', r));
  port = (signer.server.address() as AddressInfo).port;
});

afterAll(() => {
  signer.server.close();
});

interface Client {
  readonly key?: Buffer;
  readonly cert?: Buffer;
  readonly ca: Buffer;
}
const worker = (): Client => ({
  key: file(dir, 'worker.key'),
  cert: file(dir, 'worker.crt'),
  ca: file(dir, 'ca.crt'),
});

function call(
  client: Client,
  body: unknown,
  path = '/v1/sign',
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        servername: 'localhost',
        ...client,
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function keeperTx(
  ops: xdr.Operation[],
  o: { fee?: string; maxTime?: number; source?: string } = {},
): string {
  const b = new TransactionBuilder(new Account(o.source ?? keeper.publicKey(), '10'), {
    fee: o.fee ?? '100000',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: o.maxTime ?? NOW + 120 },
  });
  for (const op of ops) b.addOperation(op);
  return b.build().toXdr();
}
const charge = (fn = 'charge', id = contractId) =>
  new Contract(id).call(fn, nativeToScVal(7n, { type: 'u64' }));

describe('keeper signer (context §14.5)', () => {
  it('signs exactly one charge(sub_id) for the worker certificate', async () => {
    const res = await call(worker(), { xdr: keeperTx([charge()]) });
    expect(res.status).toBe(200);
    const signed = TransactionBuilder.fromXdr(String(res.json['signed_xdr']), Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
    expect(
      keeper.verify(signed.hash(), signed.signatures[0]?.signature.value ?? new Uint8Array()),
    ).toBe(true);
    expect(logs.at(-1)).toContain('"decision":"sign"');
  });

  it.each<[string, () => string]>([
    ['a non-charge call', () => keeperTx([charge('set_keeper')])],
    [
      'the wrong contract',
      () => keeperTx([charge('charge', StrKey.encodeContract(randomBytes(32)))]),
    ],
    ['the wrong source', () => keeperTx([charge()], { source: Keypair.random().publicKey() })],
    ['a fee over the cap', () => keeperTx([charge()], { fee: '10000001' })],
    ['long time bounds', () => keeperTx([charge()], { maxTime: NOW + 3600 })],
    ['multiple operations', () => keeperTx([charge(), charge()])],
    [
      'a payment',
      () =>
        keeperTx([
          Operation.payment({
            destination: Keypair.random().publicKey(),
            asset: Asset.native(),
            amount: '1',
          }),
        ]),
    ],
  ])('refuses %s and counts the rejection', async (_name, make) => {
    const before = signer.stats.rejected;
    const res = await call(worker(), { xdr: make() });
    expect(res.status).toBe(422);
    expect(signer.stats.rejected).toBe(before + 1);
    expect(logs.at(-1)).toContain('"decision":"reject"');
    expect(logs.at(-1)).toContain('"security":true');
  });

  it('rejects malformed requests', async () => {
    expect((await call(worker(), { nope: 1 })).status).toBe(400);
    expect((await call(worker(), {}, '/v1/other')).status).toBe(404);
  });

  it('refuses a client certificate with another name (403)', async () => {
    const res = await call(
      { key: file(dir, 'api.key'), cert: file(dir, 'api.crt'), ca: file(dir, 'ca.crt') },
      { xdr: keeperTx([charge()]) },
    );
    expect(res.status).toBe(403);
  });

  it('refuses clients without a certificate or from another CA at the TLS layer', async () => {
    await expect(
      call({ ca: file(dir, 'ca.crt') }, { xdr: keeperTx([charge()]) }),
    ).rejects.toThrow();
    await expect(
      call(
        {
          key: file(rogue, 'worker.key'),
          cert: file(rogue, 'worker.crt'),
          ca: file(dir, 'ca.crt'),
        },
        { xdr: keeperTx([charge()]) },
      ),
    ).rejects.toThrow();
  });
});
