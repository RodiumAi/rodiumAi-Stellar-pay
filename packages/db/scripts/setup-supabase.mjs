// Cloud Supabase project setup (context §7.3–§7.4): creates the service roles with fresh
// passwords, applies migrations as rp_owner, and writes the DATABASE_URL_* lines to .env.
// Never prints a password or a full connection string. Run: pnpm db:setup:supabase
//
// Needs in .env (see README → "Supabase"):
//   SUPABASE_DB_URL      the project's *Session pooler* URI for the `postgres` user, with
//                        its database password filled in (Dashboard → Connect → Session pooler)
//   SUPABASE_CA_CERT     path to the project's CA certificate
//                        (Dashboard → Database → Settings → SSL Configuration → Download)
// Idempotent: re-running keeps the generated passwords (RP_SUPABASE_*_PASSWORD in .env)
// unless ROTATE=1 is set, in which case new passwords are generated and applied.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { bootstrapRoles, migrate } from '../src/migrate.ts';

process.chdir(new URL('../../../', import.meta.url).pathname);
if (!existsSync('.env')) throw new Error('No .env — run `cp .env.example .env` first');
process.loadEnvFile('.env');
const env = process.env;

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
if (!env.SUPABASE_DB_URL) fail('SUPABASE_DB_URL is not set in .env (see README → Supabase)');
if (!env.SUPABASE_CA_CERT) fail('SUPABASE_CA_CERT is not set in .env (see README → Supabase)');
const caPath = resolve(env.SUPABASE_CA_CERT);
if (!existsSync(caPath)) fail(`SUPABASE_CA_CERT: no file at ${env.SUPABASE_CA_CERT}`);

let admin;
try {
  admin = new URL(env.SUPABASE_DB_URL);
} catch {
  fail('SUPABASE_DB_URL is not a valid URL');
}
if (admin.password === '' || admin.password.includes('YOUR-PASSWORD'))
  fail('SUPABASE_DB_URL: put the database password in place of [YOUR-PASSWORD]');
const [adminUser, ref] = decodeURIComponent(admin.username).split('.');
if (adminUser !== 'postgres' || !ref)
  fail('SUPABASE_DB_URL: expected the pooler user `postgres.<project_ref>`');
if (!admin.hostname.endsWith('.pooler.supabase.com'))
  fail('SUPABASE_DB_URL: expected a *.pooler.supabase.com host (Session pooler URI)');
const host = admin.hostname;
const ca = readFileSync(caPath, 'utf8');
const ssl = { ca, rejectUnauthorized: true, servername: host };

// Fresh 32-byte passwords, kept in .env so a re-run is a no-op.
const names = ['owner', 'api', 'worker', 'readonly'];
const key = (n) => `RP_SUPABASE_${n.toUpperCase()}_PASSWORD`;
const rotate = env.ROTATE === '1';
const passwords = Object.fromEntries(
  names.map((n) => [
    n,
    !rotate && (env[key(n)] ?? '').length >= 32
      ? env[key(n)]
      : randomBytes(32).toString('base64url'),
  ]),
);

const client = (user, password, port) =>
  new pg.Client({ host, port, user: `${user}.${ref}`, password, database: 'postgres', ssl });

// 1. Admin connection: TLS verified against the pinned CA, Postgres major must match local.
const a = client('postgres', decodeURIComponent(admin.password), 5432);
try {
  await a.connect();
} catch (e) {
  fail(`cannot connect as postgres (${e.code ?? e.message.split('\n')[0]})`);
}
const { rows } = await a.query("SELECT current_setting('server_version_num')::int AS v");
const major = Math.floor(rows[0].v / 10000);
if (major !== 17) fail(`Postgres major is ${major}; local development uses 17 (context §7.4)`);
console.log(`✓ connected to project ${ref} (${host}), Postgres ${major}, TLS verified`);

// 2. Roles.
await bootstrapRoles(a, readFileSync('infra/supabase/bootstrap-roles.sql', 'utf8'), passwords);
await a.end();
console.log(`✓ roles rp_owner, rp_api, rp_worker, rp_readonly ${rotate ? 'rotated' : 'ready'}`);

// 3. Migrations as rp_owner over the session pooler (5432).
const o = client('rp_owner', passwords.owner, 5432);
await o.connect();
const result = await migrate(o, 'packages/db/migrations');
await o.end();
console.log(
  `✓ migrations applied: ${result.applied.join(', ') || 'none'}; already applied: ${result.skipped.length}`,
);

// 4. URLs: transaction pooler (6543) for request work, session pooler (5432) for the
// worker's leader lock and for migrations. verify-full + the pinned CA everywhere.
const url = (user, password, port) =>
  `postgresql://${user}.${ref}:${encodeURIComponent(password)}@${host}:${port}/postgres` +
  `?sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`;
const urls = {
  DATABASE_URL_API: url('rp_api', passwords.api, 6543),
  DATABASE_URL_WORKER: url('rp_worker', passwords.worker, 6543),
  DATABASE_URL_WORKER_SESSION: url('rp_worker', passwords.worker, 5432),
  DATABASE_URL_READONLY: url('rp_readonly', passwords.readonly, 6543),
  DATABASE_URL_OWNER: url('rp_owner', passwords.owner, 5432),
};
const values = { ...urls, ...Object.fromEntries(names.map((n) => [key(n), passwords[n]])) };

const backup = `.env.bak-${new Date().toISOString().replace(/[:.]/g, '')}`;
copyFileSync('.env', backup);
writeFileSync(backup, readFileSync(backup), { mode: 0o600 });
const seen = new Set();
const lines = readFileSync('.env', 'utf8')
  .split('\n')
  .map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (!m || !(m[1] in values)) return line;
    seen.add(m[1]);
    return `${m[1]}=${values[m[1]]}`;
  });
const missing = Object.keys(values).filter((k) => !seen.has(k));
if (missing.length > 0)
  lines.push('', '# Supabase (pnpm db:setup:supabase)', ...missing.map((k) => `${k}=${values[k]}`));
writeFileSync('.env', lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
console.log(`✓ .env updated (previous version saved as ${backup}, mode 600)`);

// 5. Each service role connects through its pooler and sees the schema.
for (const [name, role] of [
  ['DATABASE_URL_API', 'rp_api'],
  ['DATABASE_URL_WORKER', 'rp_worker'],
  ['DATABASE_URL_WORKER_SESSION', 'rp_worker'],
  ['DATABASE_URL_READONLY', 'rp_readonly'],
]) {
  const c = new pg.Client({ connectionString: urls[name] });
  await c.connect();
  const r = await c.query('SELECT current_user AS u, count(*)::int AS n FROM pay.payments');
  await c.end();
  if (r.rows[0].u !== role) fail(`${name} connected as ${r.rows[0].u}, expected ${role}`);
  console.log(`✓ ${name}: connects as ${role}`);
}
console.log('Done. Next: pnpm build:all && pnpm api:start (it now uses the Supabase project).');
