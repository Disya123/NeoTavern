/**
 * Provider secrets repository — multiple labelled API keys per provider.
 *
 * Since migration 0024 (ТЗ §SEC-01) the database never holds plaintext: the
 * `value_ref` column stores an opaque SecretStore reference and the legacy
 * `value` column exists only as the import source for pre-migration rows.
 * Repositories expose references only — resolving a reference to the actual
 * value is the server layer's job (apps/server/src/lib/secretStore.ts). Never
 * serialize a full row to a response or log.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { maskSecretValue, type ProviderSecret } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { providerSecrets } from '../schema/index.js';

type SecretRow = typeof providerSecrets.$inferSelect;

/** Public projection — the value is masked, never the full secret/ref. */
function toPublic(row: SecretRow): ProviderSecret {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    active: row.active,
    masked: maskSecretValue(row.valueRef ?? row.value ?? ''),
    createdAt: row.createdAt,
  };
}

/** A row still holding pre-migration plaintext (`value` set, no `value_ref`). */
export interface UnmigratedSecretRow {
  id: string;
  providerId: string;
  value: string;
}

export class ProviderSecretRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  /** List a provider's secrets (masked), active first then by creation time. */
  async listByProvider(providerId: string): Promise<ProviderSecret[]> {
    const rows = await this.db
      .select()
      .from(providerSecrets)
      .where(eq(providerSecrets.providerId, providerId))
      .orderBy(desc(providerSecrets.active), asc(providerSecrets.createdAt));
    return rows.map(toPublic);
  }

  /**
   * Store a new secret reference. A non-empty reference becomes the provider's
   * active key and deactivates every sibling; an empty reference is kept
   * inactive (useful as a placeholder for keyless local endpoints). Returns
   * the new secret id. When `id` is given it must equal the record id used to
   * persist the value in the SecretStore (the reference points at it).
   */
  async create(
    providerId: string,
    valueRef: string,
    label: string | null,
    id: string = uuidv7(),
  ): Promise<string> {
    const now = this.clock();
    const makeActive = valueRef.length > 0;
    this.db.transaction((tx) => {
      if (makeActive) {
        tx.update(providerSecrets)
          .set({ active: false })
          .where(eq(providerSecrets.providerId, providerId))
          .run();
      }
      tx.insert(providerSecrets)
        .values({ id, providerId, label, value: '', valueRef, active: makeActive, createdAt: now })
        .run();
    });
    return id;
  }

  /**
   * Update label and/or active state. Activating one secret deactivates its
   * siblings atomically. Returns the updated public projection, or null when
   * the secret does not belong to the provider.
   */
  async update(
    providerId: string,
    secretId: string,
    patch: { label?: string | null; active?: boolean },
  ): Promise<ProviderSecret | null> {
    const row = this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(providerSecrets)
        .where(and(eq(providerSecrets.id, secretId), eq(providerSecrets.providerId, providerId)))
        .get();
      if (!existing) return null;
      const hasValue = (existing.valueRef ?? existing.value ?? '').length > 0;
      const makeActive = patch.active === true && hasValue;
      if (makeActive) {
        tx.update(providerSecrets)
          .set({ active: false })
          .where(eq(providerSecrets.providerId, providerId))
          .run();
      }
      const values: Partial<SecretRow> = {};
      if (patch.label !== undefined) values.label = patch.label;
      if (patch.active !== undefined) values.active = makeActive;
      if (Object.keys(values).length > 0) {
        tx.update(providerSecrets).set(values).where(eq(providerSecrets.id, secretId)).run();
      }
      return tx.select().from(providerSecrets).where(eq(providerSecrets.id, secretId)).get();
    });
    return row ? toPublic(row) : null;
  }

  /**
   * Delete a secret. If the active key is removed, the most recent remaining
   * non-empty secret is reactivated so the provider keeps a usable key.
   */
  async delete(providerId: string, secretId: string): Promise<boolean> {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(providerSecrets)
        .where(and(eq(providerSecrets.id, secretId), eq(providerSecrets.providerId, providerId)))
        .get();
      if (!existing) return false;
      tx.delete(providerSecrets).where(eq(providerSecrets.id, secretId)).run();
      if (existing.active) {
        // Reactivate the most recently inserted remaining key. `rowid` is the
        // stable insertion-order tie-break when timestamps collide (bulk adds).
        const next = tx
          .select()
          .from(providerSecrets)
          .where(eq(providerSecrets.providerId, providerId))
          .orderBy(desc(providerSecrets.createdAt), desc(sql`rowid`))
          .get();
        if (next && (next.valueRef ?? next.value ?? '').length > 0) {
          tx.update(providerSecrets)
            .set({ active: true })
            .where(eq(providerSecrets.id, next.id))
            .run();
        }
      }
      return true;
    });
  }

  /** INTERNAL: full secret row including the opaque reference (reveal route). */
  async getFullById(providerId: string, secretId: string): Promise<SecretRow | null> {
    const row = await this.db
      .select()
      .from(providerSecrets)
      .where(and(eq(providerSecrets.id, secretId), eq(providerSecrets.providerId, providerId)))
      .get();
    return row ?? null;
  }

  /**
   * INTERNAL: the provider's active opaque reference, for the provider runtime.
   * Plaintext is never returned — the caller resolves the reference through
   * the SecretStore.
   */
  async getActiveReference(providerId: string): Promise<string | null> {
    const row = await this.db
      .select()
      .from(providerSecrets)
      .where(and(eq(providerSecrets.providerId, providerId), eq(providerSecrets.active, true)))
      .get();
    return row?.valueRef ?? null;
  }

  /** INTERNAL: deactivate every secret for a provider (clears the active key). */
  async clearActive(providerId: string): Promise<void> {
    await this.db
      .update(providerSecrets)
      .set({ active: false })
      .where(eq(providerSecrets.providerId, providerId));
  }

  /** INTERNAL: whether the provider has a usable (active, non-empty) key. */
  async hasActive(providerId: string): Promise<boolean> {
    const row = await this.db
      .select()
      .from(providerSecrets)
      .where(and(eq(providerSecrets.providerId, providerId), eq(providerSecrets.active, true)))
      .get();
    return row !== undefined && (row.valueRef ?? row.value ?? '').length > 0;
  }

  /**
   * Pre-migration rows still holding plaintext (`value` set, `value_ref` NULL).
   * The bootstrap importer moves them into the SecretStore and rewrites them
   * as references (see lib/secretStore.ts).
   */
  async listUnmigrated(): Promise<UnmigratedSecretRow[]> {
    const rows = await this.db
      .select()
      .from(providerSecrets)
      .where(sql`${providerSecrets.value} IS NOT NULL AND ${providerSecrets.valueRef} IS NULL`);
    return rows.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      value: row.value as string,
    }));
  }

  /** Rewrite an imported row: keep only the opaque reference. */
  async markMigrated(id: string, valueRef: string): Promise<void> {
    await this.db
      .update(providerSecrets)
      .set({ valueRef, value: '' })
      .where(eq(providerSecrets.id, id))
      .run();
  }
}
