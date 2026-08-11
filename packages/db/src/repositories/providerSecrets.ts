/**
 * Provider secrets repository — multiple labelled API keys per provider.
 *
 * Values are stored locally (local-first SQLite) but are write-only at the API
 * boundary: {@link toPublic} masks them, and the plaintext accessors
 * ({@link getFullById}, {@link getActiveValue}) are used only by the provider
 * runtime and the gated reveal route (AGENTS.md §4, §11). Never serialize a
 * full row to a response or log.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { maskSecretValue, type ProviderSecret } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { providerSecrets } from '../schema/index.js';

type SecretRow = typeof providerSecrets.$inferSelect;

/** Public projection — the value is masked, never the full secret. */
function toPublic(row: SecretRow): ProviderSecret {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    active: row.active,
    masked: maskSecretValue(row.value),
    createdAt: row.createdAt,
  };
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
   * Store a new secret. A non-empty value becomes the provider's active key and
   * deactivates every sibling; an empty value is kept inactive (useful as a
   * placeholder for keyless local endpoints). Returns the new secret id.
   */
  async create(providerId: string, value: string, label: string | null): Promise<string> {
    const id = uuidv7();
    const now = this.clock();
    const makeActive = value.length > 0;
    this.db.transaction((tx) => {
      if (makeActive) {
        tx.update(providerSecrets)
          .set({ active: false })
          .where(eq(providerSecrets.providerId, providerId))
          .run();
      }
      tx.insert(providerSecrets)
        .values({ id, providerId, label, value, active: makeActive, createdAt: now })
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
      const makeActive = patch.active === true && existing.value.length > 0;
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
        if (next && next.value.length > 0) {
          tx.update(providerSecrets)
            .set({ active: true })
            .where(eq(providerSecrets.id, next.id))
            .run();
        }
      }
      return true;
    });
  }

  /** INTERNAL: full secret row including the plaintext value (reveal route). */
  async getFullById(providerId: string, secretId: string): Promise<SecretRow | null> {
    const row = await this.db
      .select()
      .from(providerSecrets)
      .where(and(eq(providerSecrets.id, secretId), eq(providerSecrets.providerId, providerId)))
      .get();
    return row ?? null;
  }

  /** INTERNAL: the provider's active secret value, for the provider runtime. */
  async getActiveValue(providerId: string): Promise<string | null> {
    const row = await this.db
      .select()
      .from(providerSecrets)
      .where(and(eq(providerSecrets.providerId, providerId), eq(providerSecrets.active, true)))
      .get();
    return row ? row.value : null;
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
      .select({ value: providerSecrets.value })
      .from(providerSecrets)
      .where(and(eq(providerSecrets.providerId, providerId), eq(providerSecrets.active, true)))
      .get();
    return row !== undefined && row.value.length > 0;
  }
}
