import { resolveSecretFiles } from '@rp/config/secret-files';
import { ok } from '@rp/core/result';
import { createDb, createPool } from '@rp/db/connection';
import { createLogger } from '@rp/security/logger';
import { loadAdminConfig } from './admin-config.js';
import { createAlbVerifier } from './alb-auth.js';
import { createAdminQueries } from './queries.js';
import { buildServer } from './server.js';
import { createStatusProbes } from './status.js';

const SHUTDOWN_GRACE_MS = 10_000;

function fail(lines: readonly string[]): never {
  process.stderr.write(`Invalid configuration:\n${lines.map((l) => `  - ${l}`).join('\n')}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = resolveSecretFiles(process.env);
  if (!env.ok) fail(env.error);
  const config = loadAdminConfig(env.value);
  if (!config.ok) fail(config.error);
  const c = config.value;
  const logger = createLogger({ level: c.logLevel, service: 'admin' });

  const pool = createPool({ connectionString: c.databaseUrl, max: 3, applicationName: 'rp-admin' });
  const auth = c.auth;
  let authenticate;
  if (auth.mode === 'alb') {
    const verifier = createAlbVerifier({
      albArn: auth.albArn,
      region: auth.region,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    });
    authenticate = (token: string | undefined) => verifier.verify(token);
  } else {
    authenticate = () => Promise.resolve(ok({ email: auth.devEmail }));
  }
  if (auth.mode === 'dev') logger.warn({ admin: auth.devEmail }, 'ADMIN_AUTH=dev: no sign-in');

  const app = buildServer({
    basePath: c.basePath,
    network: c.network,
    treasury: c.merchant,
    allowedEmails: c.allowedEmails,
    logoutUrl: auth.mode === 'alb' ? auth.logoutUrl : null,
    authenticate,
    queries: createAdminQueries(createDb(pool)),
    probes: createStatusProbes({
      horizonUrl: c.horizonUrl,
      merchant: c.merchant,
      usdcIssuer: c.usdcIssuer,
      apiReadyUrl: c.apiReadyUrl,
    }),
    logger,
    now: () => new Date(),
  });

  const shutdown = (): void => {
    logger.info('admin shutting down');
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: '0.0.0.0', port: c.port });
  logger.info({ network: c.network, auth: auth.mode }, 'admin started');
}

void main();
