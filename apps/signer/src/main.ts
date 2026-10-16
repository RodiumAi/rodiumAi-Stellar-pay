import { createServer } from 'node:http';
import { loadConfig, withoutEmpty } from '@rp/config/app-config';
import { resolveSecretFiles } from '@rp/config/secret-files';
import { createLogger } from '@rp/security/logger';
import { createTlsFiles } from '@rp/security/tls-files';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { createSigner } from './signer.js';

const Env = z.object({
  SIGNER_PORT: z.coerce.number().int().min(1).max(65_535).default(9443),
  SIGNER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9444),
  // 0.0.0.0 in Kubernetes so the scraper can reach it (NetworkPolicy limits who may).
  SIGNER_METRICS_HOST: z.ipv4().default('127.0.0.1'),
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

// KEEPER_SECRET_FILE must sit under a path allowed by --allow-fs-read.
const env = resolveSecretFiles(process.env);
if (!env.ok) fail(env.error);
const app = loadConfig(env.value);
if (!app.ok) fail(app.error.issues);
const parsed = Env.safeParse(withoutEmpty(env.value));
if (!parsed.success) fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
const e = parsed.data;
const logger = createLogger({ level: app.value.logLevel, service: 'signer' });
// The secret is read once and removed from the environment so nothing else can echo it.
const keeper = Keypair.fromSecret(e.KEEPER_SECRET);
delete process.env['KEEPER_SECRET'];

const tlsFiles = createTlsFiles({
  keyPath: e.SIGNER_TLS_KEY,
  certPath: e.SIGNER_TLS_CERT,
  caPath: e.SIGNER_TLS_CA,
  onReload: (m) => {
    signer.reloadTls(m);
    logger.info({ not_after: m.notAfterSeconds }, 'mTLS server certificate reloaded');
  },
});

const signer = createSigner({
  keeper,
  rules: {
    networkPassphrase: app.value.network.passphrase,
    maxFeeStroops: app.value.network.maxSorobanFeeStroops,
    contractId: app.value.network.subscriptionContractId,
  },
  tls: tlsFiles.current(),
  logger,
  nowSeconds: () => Math.floor(Date.now() / 1000),
});
const { server, stats } = signer;
server.listen(e.SIGNER_PORT, '0.0.0.0', () => {
  logger.info({ keeper: keeper.publicKey(), port: e.SIGNER_PORT }, 'signer listening (mTLS)');
});

// Plain-HTTP metrics for the platform scraper on a separate port (no signing here).
createServer((req, res) => {
  if (req.url === '/metrics') {
    res
      .writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      .end(
        [
          `signer_signed_total ${String(stats.signed)}`,
          `signer_rejections_total ${String(stats.rejected)}`,
          `mtls_cert_not_after_timestamp_seconds ${String(tlsFiles.current().notAfterSeconds)}`,
        ].join('\n') + '\n',
      );
  } else res.writeHead(404).end();
}).listen(e.SIGNER_METRICS_PORT, e.SIGNER_METRICS_HOST);
// Pick up rotated certificates (cert-manager, 30 days) without a restart.
setInterval(() => tlsFiles.current(), 60_000).unref();

process.once('SIGTERM', () => {
  server.close(() => process.exit(0));
});
