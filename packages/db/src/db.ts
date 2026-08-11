/** Drizzle instance factory and shared DB type. */
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.js';
import type { SqliteConnection } from './connection.js';

/** Drizzle database typed with the full schema. */
export type DrizzleDb = BetterSQLite3Database<typeof schema>;

/** Transaction handle yielded by {@link DrizzleDb.transaction}. */
export type DbTransaction = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** Anything a repository query can run against: the db or a transaction. */
export type DbExecutor = DrizzleDb | DbTransaction;

export function createDrizzle(sqlite: SqliteConnection): DrizzleDb {
  return drizzle(sqlite, { schema });
}

/** Current epoch milliseconds. Injectable in tests. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
