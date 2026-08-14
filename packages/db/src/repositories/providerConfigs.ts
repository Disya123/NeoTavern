/**
 * Provider configuration repository.
 *
 * Live API keys are stored in {@link ProviderSecretRepository}; the legacy
 * `api_key` column is a migration fallback only. Secrets are NEVER exposed
 * through {@link toPublicConfig} — only `hasApiKey`. Internal methods
 * ({@link getFullConfig}) are used solely by the provider runtime on the
 * server and must never be serialized to an API response or log.
 */
import { asc, eq } from 'drizzle-orm';
import type {
  ProviderConfig,
  ProviderConfigCreate,
  ProviderConfigUpdate,
} from '@neotavern/contracts';
import { maskSecretValue } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { providerConfigs } from '../schema/index.js';
import { parseJson, toJson } from '../json.js';
import type { ProviderSecretRepository } from './providerSecrets.js';

type ProviderRow = typeof providerConfigs.$inferSelect;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Custom request headers are write-only secrets (a standard way to attach an
 * Azure `api-key` header): the public projection shows a masked preview,
 * never the raw value. Anything not shaped like a header map passes through.
 */
function maskHeaderSecrets(settings: Record<string, unknown>): Record<string, unknown> {
  const headers = settings['customIncludeHeaders'];
  if (!isRecord(headers)) return settings;
  const masked: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    masked[name] = typeof value === 'string' ? maskSecretValue(value) : value;
  }
  return { ...settings, customIncludeHeaders: masked };
}

/**
 * Header values returned by the API are masks; a client that saves a form
 * untouched would otherwise corrupt the stored secret. An incoming value equal
 * to the mask of the stored value counts as "unchanged" and keeps the secret.
 */
function preserveMaskedHeaders(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing, ...incoming };
  const incomingHeaders = incoming['customIncludeHeaders'];
  const existingHeaders = existing['customIncludeHeaders'];
  if (!isRecord(incomingHeaders) || !isRecord(existingHeaders)) return merged;
  const safe: Record<string, unknown> = { ...incomingHeaders };
  for (const [name, value] of Object.entries(safe)) {
    const stored = existingHeaders[name];
    if (
      typeof value === 'string' &&
      typeof stored === 'string' &&
      value === maskSecretValue(stored)
    ) {
      safe[name] = stored;
    }
  }
  merged['customIncludeHeaders'] = safe;
  return merged;
}

/** Public projection — strips the secret, exposes only `hasApiKey`. */
function toPublicConfig(row: ProviderRow, hasApiKey: boolean): ProviderConfig {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: row.enabled,
    hasApiKey,
    settings: maskHeaderSecrets(parseJson<Record<string, unknown>>(row.settings, {})),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Internal full config including the secret — for the provider runtime only. */
export interface ProviderSecretConfig {
  id: string;
  kind: string;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  settings: Record<string, unknown>;
  enabled: boolean;
  /** Revision stamp; used to version cache keys (ТЗ §11.2). */
  updatedAt: number;
}

export class ProviderConfigRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
    private readonly secrets: ProviderSecretRepository,
    private readonly secretResolver?: (ref: string) => Promise<string | null>,
  ) {}

  async create(input: ProviderConfigCreate, id: string = uuidv7()): Promise<ProviderConfig> {
    const now = this.clock();
    const row = await this.db
      .insert(providerConfigs)
      .values({
        id,
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl ?? null,
        model: input.model ?? null,
        apiKey: null,
        enabled: input.enabled ?? true,
        settings: toJson(input.settings ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    // Keys now live in the SecretStore; `input.apiKey` is an opaque reference
    // prepared by the server layer (an empty string is ignored so it never
    // masks a later key).
    if (input.apiKey && input.apiKey.length > 0) {
      await this.secrets.create(row.id, input.apiKey, null);
    }
    return toPublicConfig(row, input.apiKey != null && input.apiKey.length > 0);
  }

  async getById(id: string): Promise<ProviderConfig | null> {
    const row = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .get();
    return row ? toPublicConfig(row, await this.hasApiKey(row)) : null;
  }

  async list(): Promise<ProviderConfig[]> {
    const rows = await this.db
      .select()
      .from(providerConfigs)
      .orderBy(asc(providerConfigs.createdAt));
    return Promise.all(rows.map(async (row) => toPublicConfig(row, await this.hasApiKey(row))));
  }

  async update(id: string, patch: ProviderConfigUpdate): Promise<ProviderConfig | null> {
    const values: Partial<ProviderRow> = { updatedAt: this.clock() };
    if (patch.kind !== undefined) values.kind = patch.kind;
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.baseUrl !== undefined) values.baseUrl = patch.baseUrl;
    if (patch.model !== undefined) values.model = patch.model;
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    // Keys are managed in the secrets store, not the legacy column: null
    // clears the active secret, a non-empty value becomes the new active one.
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null) {
        await this.secrets.clearActive(id);
      } else if (patch.apiKey.length > 0) {
        await this.secrets.create(id, patch.apiKey, null);
      }
    }
    if (patch.settings !== undefined) {
      const existing = await this.db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.id, id))
        .get();
      const merged = preserveMaskedHeaders(
        patch.settings,
        parseJson<Record<string, unknown>>(existing?.settings ?? '{}', {}),
      );
      values.settings = toJson(merged);
    }
    const row = await this.db
      .update(providerConfigs)
      .set(values)
      .where(eq(providerConfigs.id, id))
      .returning()
      .get();
    return row ? toPublicConfig(row, await this.hasApiKey(row)) : null;
  }

  /** True when the provider has a usable key (active secret or legacy column). */
  private async hasApiKey(row: ProviderRow): Promise<boolean> {
    if (await this.secrets.hasActive(row.id)) return true;
    return row.apiKey != null && row.apiKey.length > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(providerConfigs).where(eq(providerConfigs.id, id)).run();
    return result.changes > 0;
  }

  /** INTERNAL: fetch the secret config for the provider runtime. */
  async getFullConfig(id: string): Promise<ProviderSecretConfig | null> {
    const row = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .get();
    if (!row) return null;
    // Prefer the active secret (an opaque reference resolved through the
    // SecretStore — ТЗ §SEC-01); fall back to the legacy column for databases
    // whose key has not been migrated yet.
    let apiKey: string | null = null;
    const ref = await this.secrets.getActiveReference(id);
    if (ref) {
      apiKey = this.secretResolver ? await this.secretResolver(ref) : null;
    }
    if (apiKey === null) apiKey = row.apiKey;
    return {
      id: row.id,
      kind: row.kind,
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey,
      settings: parseJson<Record<string, unknown>>(row.settings, {}),
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    };
  }
}
