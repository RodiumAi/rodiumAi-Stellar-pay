// Local development database: bootstraps roles with the RP_*_PASSWORD values from
// .env, applies migrations, and fills placeholder DATABASE_URL_* lines in .env with
// local URLs. Never prints passwords. Run: pnpm db:setup (after pnpm db:start).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { bootstrapRoles, migrate } from '../src/migrate.ts';

// Paths below are relative to the repository root.
process.chdir(new URL('../../../', import.meta.url).pathname);

const HOST = '127.0.0.1:54322';
const DATABASE = 'rodium_pay_dev';
const SUPERUSER_URL = `postgresql://postgres:postgres@${HOST}/postgres`;

if (!existsSync('.env')) throw new Error('No .env — run `cp .env.example .env` first');
process.loadEnvFile('.env');
const passwords = {
  owner: process.env.RP_OWNER_PASSWORD ?? '',
  api: process.env.RP_API_PASSWORD ?? '',
  worker: process.env.RP_WORKER_PASSWORD ?? '',
  readonly: process.env.RP_READONLY_PASSWORD ?? '',
};
for (const [role, pw] of Object.entries(passwords)) {
  if (pw.length < 32) throw new Error(`RP_${role.toUpperCase()}_PASSWORD must be set (32+ chars)`);
}

const server = new pg.Client({ connectionString: SUPERUSER_URL });
await server.connect();
const exists = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
if (exists.rowCount === 0) await server.query(`CREATE DATABASE ${DATABASE}`);
await server.end();

const url = (user, password) =>
  `postgresql://${user}:${encodeURIComponent(password)}@${HOST}/${DATABASE}`;

const admin = new pg.Client({ connectionString: url('postgres', 'postgres') });
await admin.connect();
await bootstrapRoles(admin, readFileSync('infra/supabase/bootstrap-roles.sql', 'utf8'), passwords);
await admin.end();

const owner = new pg.Client({ connectionString: url('rp_owner', passwords.owner) });
await owner.connect();
const result = await migrate(owner, 'packages/db/migrations');
await owner.end();
console.log(
  `migrations applied: ${result.applied.join(', ') || 'none'}; already applied: ${result.skipped.length}`,
);

const local = {
  DATABASE_URL_API: url('rp_api', passwords.api),
  DATABASE_URL_WORKER: url('rp_worker', passwords.worker),
  DATABASE_URL_READONLY: url('rp_readonly', passwords.readonly),
  DATABASE_URL_OWNER: url('rp_owner', passwords.owner),
  DATABASE_URL_ADMIN: url('postgres', 'postgres'),
};
const filled = [];
const env = readFileSync('.env', 'utf8')
  .split('\n')
  .map((line) => {
    const m = /^(DATABASE_URL_[A-Z_]+)=(.*)$/.exec(line);
    if (!m || !(m[1] in local) || !(m[2] === '' || m[2].includes('<'))) return line;
    filled.push(m[1]);
    return `${m[1]}=${local[m[1]]}`;
  })
  .join('\n');
writeFileSync('.env', env, { mode: 0o600 });
console.log(`.env DATABASE_URL_* filled: ${filled.join(', ') || 'none (already set)'}`);

for (const [name, role] of [
  ['DATABASE_URL_API', 'api'],
  ['DATABASE_URL_WORKER', 'worker'],
  ['DATABASE_URL_READONLY', 'readonly'],
]) {
  const c = new pg.Client({ connectionString: local[name] });
  await c.connect();
  const { rows } = await c.query(
    'SELECT current_user, count(*)::int AS payments FROM pay.payments',
  );
  await c.end();
  console.log(`${name}: connects as ${rows[0].current_user} (${role}) ✓`);
}
