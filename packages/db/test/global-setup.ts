import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { bootstrapRoles, migrate, type RolePasswords } from '../src/migrate.js';

const ADMIN_URL =
  process.env['RP_TEST_DB_ADMIN_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const rolesSql = fileURLToPath(
  new URL('../../../infra/supabase/bootstrap-roles.sql', import.meta.url),
);
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

function urlFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrls: { admin: string; owner: string; api: string; worker: string; readonly: string };
  }
}

/** Creates a throwaway database, bootstraps roles, applies migrations; drops it afterwards. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = `rp_test_${randomBytes(6).toString('hex')}`;
  const passwords: RolePasswords = {
    owner: randomBytes(32).toString('hex'),
    api: randomBytes(32).toString('hex'),
    worker: randomBytes(32).toString('hex'),
    readonly: randomBytes(32).toString('hex'),
  };

  const server = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await server.connect();
  } catch (e) {
    throw new Error(
      `Cannot reach the local database at ${new URL(ADMIN_URL).host}. Start it with \`pnpm db:start\`.`,
      { cause: e },
    );
  }
  await server.query(`CREATE DATABASE ${database}`);

  const adminUrl = urlFor(ADMIN_URL, 'postgres', new URL(ADMIN_URL).password, database);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-relative path
  await bootstrapRoles(admin, await readFile(rolesSql, 'utf8'), passwords);
  await admin.end();

  const owner = new pg.Client({
    connectionString: urlFor(ADMIN_URL, 'rp_owner', passwords.owner, database),
  });
  await owner.connect();
  await migrate(owner, migrationsDir);
  await owner.end();

  project.provide('dbUrls', {
    admin: adminUrl,
    owner: urlFor(ADMIN_URL, 'rp_owner', passwords.owner, database),
    api: urlFor(ADMIN_URL, 'rp_api', passwords.api, database),
    worker: urlFor(ADMIN_URL, 'rp_worker', passwords.worker, database),
    readonly: urlFor(ADMIN_URL, 'rp_readonly', passwords.readonly, database),
  });

  return async () => {
    await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await server.end();
  };
}
