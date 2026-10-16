import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadConfig } from '@rp/config/app-config';
import { resolveSecretFiles } from '@rp/config/secret-files';
import { cryptoRandomBytes } from '@rp/core/random';
import { createDb, createPool } from '@rp/db/connection';
import { createLogger } from '@rp/security/logger';
import { createHorizonSource } from '@rp/stellar/horizon-source';
import { verifyNetwork } from '@rp/stellar/network-check';
import { createRpcSource } from '@rp/stellar/rpc-source';
import { rpc } from '@stellar/stellar-sdk';
import { createChargeJob } from './jobs/charge.js';
import { createContractEventsJob } from './jobs/contract-events.js';
import { createDispatchJob } from './jobs/dispatch.js';
import { createExpireJob } from './jobs/expire.js';
import { createIngestJob, createReconcileJob } from './jobs/ingest.js';
import {
  createAllowanceWarningJob,
  createKeeperBalanceJob,
  createTtlExtensionJob,
} from './jobs/maintenance.js';
import { createMetrics } from './metrics.js';
import { startScheduler, type Job } from './scheduler.js';
import { createSignerClient } from './signer-client.js';
import { loadWorkerConfig } from './worker-config.js';

/** Context §15: stop claiming, finish in-flight work within 25 s, release locks. */
const SHUTDOWN_GRACE_MS = 25_000;

function fail(lines: readonly string[]): never {
  process.stderr.write(`Invalid configuration:\n${lines.map((l) => `  - ${l}`).join('\n')}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = resolveSecretFiles(process.env);
  if (!env.ok) fail(env.error);
  const app = loadConfig(env.value);
  if (!app.ok) fail(app.error.issues);
  const cfg = loadWorkerConfig(env.value);
  if (!cfg.ok) fail(cfg.error);
  const { network } = app.value;
  const logger = createLogger({ level: app.value.logLevel, service: 'worker' });
  const metrics = createMetrics();

  const server = new rpc.Server(network.rpcUrl, {
    allowHttp: network.rpcUrl.startsWith('http://'),
  });
  const passphrase = await verifyNetwork(server, network.passphrase);
  if (!passphrase.ok)
    fail([`RP_STELLAR_RPC_URL serves "${passphrase.error.reported}", not the configured network`]);

  const pool = createPool({
    connectionString: cfg.value.databaseUrl,
    max: 5,
    applicationName: 'rp-worker',
  });
  const sessionPool = createPool({
    connectionString: cfg.value.sessionDatabaseUrl,
    max: 1,
    applicationName: 'rp-worker-leader',
  });
  const db = createDb(pool);
  const rules = {
    merchant: network.merchant,
    usdc: { code: network.usdc.code, issuer: network.usdc.issuer },
  };
  const source =
    cfg.value.ingestSource === 'horizon'
      ? createHorizonSource(network.horizonUrl, network.merchant, { fetch })
      : createRpcSource(
          {
            merchant: network.merchant,
            usdcContractId: network.usdc.contractId,
            networkPassphrase: network.passphrase,
          },
          server,
        );

  const ingest = createIngestJob({
    db,
    sessionPool,
    source,
    rules,
    startLedger: cfg.value.ingestStartLedger,
    metrics,
    logger,
  });
  const subscriptionJobs: Job[] = [];
  const subs = cfg.value.subscriptions;
  if (subs !== null) {
    const signer = createSignerClient({
      url: subs.signerUrl,
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured paths
      key: readFileSync(subs.tlsKeyPath),
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured paths
      cert: readFileSync(subs.tlsCertPath),
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured paths
      ca: readFileSync(subs.tlsCaPath),
    });
    const chain = { contractId: network.subscriptionContractId, keeper: subs.keeperAddress };
    subscriptionJobs.push(
      createContractEventsJob({
        db,
        client: server,
        contractId: chain.contractId,
        startLedger: subs.eventsStartLedger,
        metrics,
        logger,
      }),
      createChargeJob({
        db,
        chain: server,
        signer,
        keeper: chain.keeper,
        contractId: chain.contractId,
        networkPassphrase: network.passphrase,
        maxFeeStroops: network.maxSorobanFeeStroops,
        now: () => new Date(),
        randomBytes: cryptoRandomBytes,
        metrics,
        logger,
      }),
      createAllowanceWarningJob({
        db,
        latestLedger: async () => (await server.getLatestLedger()).sequence,
        now: () => new Date(),
        randomBytes: cryptoRandomBytes,
      }),
      createTtlExtensionJob({
        db,
        chain: server,
        signer,
        keeper: chain.keeper,
        contractId: chain.contractId,
        networkPassphrase: network.passphrase,
        extendToLedgers: 3_000_000,
        logger,
      }),
      createKeeperBalanceJob({
        horizonUrl: network.horizonUrl,
        keeper: chain.keeper,
        minBalanceXlm: subs.keeperMinBalanceXlm,
        fetch,
        metrics,
        logger,
      }),
    );
  }

  const scheduler = startScheduler(
    [
      ...subscriptionJobs,
      ingest,
      createReconcileJob({ db, source, rules, logger, metrics }),
      createExpireJob({ db, now: () => new Date(), randomBytes: cryptoRandomBytes }),
      createDispatchJob({
        db,
        url: cfg.value.webhookUrl,
        signer: { keyId: cfg.value.webhookKeyId, privateKey: cfg.value.webhookPrivateKey },
        fetch,
        now: () => new Date(),
        randomBytes: cryptoRandomBytes,
        metrics,
        logger,
      }),
    ],
    logger,
  );

  const http = createServer((req, res) => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    } else if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
    } else {
      res.writeHead(404).end();
    }
  }).listen(cfg.value.port, '0.0.0.0');

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'stopping: no new claims, draining in-flight work');
    void scheduler.stop(SHUTDOWN_GRACE_MS).then(async ({ drained }) => {
      logger.info({ drained }, 'scheduler stopped');
      await ingest.release();
      http.close();
      await Promise.all([pool.end(), sessionPool.end()]);
      process.exit(drained ? 0 : 1);
    });
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  logger.info({ source: source.name, network: network.name }, 'worker started');
}

void main();
