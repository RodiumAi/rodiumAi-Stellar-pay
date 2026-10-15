import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

const parseInt8 = (value: string): bigint => BigInt(value);

// Per-pool type parsers (not the global pg.types) so int8 never becomes a lossy JS number.
const types: pg.CustomTypesConfig = {
  getTypeParser: (id, format) =>
    id === pg.types.builtins.INT8 ? parseInt8 : (pg.types.getTypeParser(id, format) as unknown),
};

export interface PoolOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly applicationName: string;
}

export function createPool(options: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    types,
  });
}

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
/** Repositories accept either, so callers decide the transaction boundary. */
export type Executor = Db | Tx;

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
