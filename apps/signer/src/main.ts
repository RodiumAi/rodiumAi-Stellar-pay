import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadConfig, withoutEmpty } from '@rp/config/app-config';
import { createLogger } from '@rp/security/logger';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { createSigner } from './signer.js';

const Env = z.object({
  SIGNER_PORT: z.coerce.number().int().min(1).max(65_535).default(9443),
  SIGNER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9444),
  SIGNER_TLS_KEY: z.string().min(1),
  SIGNER_TLS_CERT: z.string().min(1),
  SIGNER_TLS_CA: z.string().min(1),
  KEEPER_SECRET: z
    .string()
    .refine((s) => StrKey.isValidEd25519SecretSeed(s), 'must be a Stellar secret seed'),
});

function fail(lines: readonly string[]): never {
  process.stderr.write(`Invalid configuration:\n${lines.map((l) => `  - ${l}`).join('\n')}\n`);
  process.exit(1);
}

const app = loadConfig(process.env);
if (!app.ok) fail(app.error.issues);
const parsed = Env.safeParse(withoutEmpty(process.env));
if (!parsed.success) fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
const e = parsed.data;
const logger = createLogger({ level: app.value.logLevel, service: 'signer' });
// The secret is read once and removed from the environment so nothing else can echo it.
const keeper = Keypair.fromSecret(e.KEEPER_SECRET);
delete process.env['KEEPER_SECRET'];

const { server, stats } = createSigner({
  keeper,
  rules: {
    networkPassphrase: app.value.network.passphrase,
    maxFeeStroops: app.value.network.maxSorobanFeeStroops,
    contractId: app.value.network.subscriptionContractId,
  },
  tls: {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured paths
    key: readFileSync(e.SIGNER_TLS_KEY),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured paths
    cert: readFileSync(e.SIGNER_TLS_CERT),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured paths
    ca: readFileSync(e.SIGNER_TLS_CA),
  },
  logger,
  nowSeconds: () => Math.floor(Date.now() / 1000),
});
server.listen(e.SIGNER_PORT, '0.0.0.0', () => {
  logger.info({ keeper: keeper.publicKey(), port: e.SIGNER_PORT }, 'signer listening (mTLS)');
});

// Plain-HTTP metrics for the platform scraper on a separate port (no signing here).
createServer((req, res) => {
  if (req.url === '/metrics') {
    res
      .writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      .end(
        `signer_signed_total ${String(stats.signed)}\nsigner_rejections_total ${String(stats.rejected)}\n`,
      );
  } else res.writeHead(404).end();
}).listen(e.SIGNER_METRICS_PORT, '127.0.0.1');

process.once('SIGTERM', () => {
  server.close(() => process.exit(0));
});
