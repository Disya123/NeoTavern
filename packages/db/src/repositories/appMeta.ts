/**
 * Application metadata store (ТЗ §10.2 `app_meta`): stable install identity
 * and cross-repository markers such as the active profile. Key/value with
 * upsert semantics.
 */
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../db.js';
import { appMeta } from '../schema/index.js';

export class AppMetaRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.select().from(appMeta).where(eq(appMeta.key, key)).get();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(appMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value } })
      .run();
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.db.delete(appMeta).where(eq(appMeta.key, key)).run();
    return result.changes > 0;
  }

  /**
   * Return the value for `key`, generating and persisting it with `create`
   * when absent. Used for the stable install id (ТЗ §10.2).
   */
  async ensure(key: string, create: () => string): Promise<string> {
    const existing = await this.get(key);
    if (existing !== null) return existing;
    const value = create();
    await this.set(key, value);
    return value;
  }
}
