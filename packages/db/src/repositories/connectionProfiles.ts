/**
 * Connection profiles repository — named bundles of connection settings layered
 * over provider configs.
 *
 * `name` and `mode` are first-class columns (for listing/filtering); every
 * other bundle field lives in the versioned `payload` JSON. Updates merge over
 * the stored payload so unknown fields survive round-trips (AGENTS.md §11) and
 * a partial PATCH only touches the fields it names.
 */
import { asc, eq } from 'drizzle-orm';
import type {
  ConnectionProfile,
  ConnectionProfileCreate,
  ConnectionProfileUpdate,
} from '@neotavern/contracts';
import { maskSecretValue } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { connectionProfiles } from '../schema/index.js';
import { parseJson, toJson } from '../json.js';

type ProfileRow = typeof connectionProfiles.$inferSelect;

/** Bundle fields stored inside `payload` (everything but the columns). */
const PAYLOAD_FIELDS = [
  'providerConfigId',
  'source',
  'baseUrl',
  'model',
  'secretId',
  'presetId',
  'promptPostProcessing',
  'includeBody',
  'excludeBody',
  'includeHeaders',
  'stopStrings',
  'startReplyWith',
  'exclude',
] as const;

/** Pick the payload portion out of a create/update input (drops name/mode). */
function toPayload(input: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of PAYLOAD_FIELDS) {
    if (input[field] !== undefined) payload[field] = input[field];
  }
  return payload;
}

/** Reconstruct the public profile: payload first, columns authoritative. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Headers can hold credentials, so profile reads use the same write-only
 * projection as provider configs. The raw value remains available only to the
 * apply path inside the server process. */
function maskHeaders(payload: Record<string, unknown>): Record<string, unknown> {
  const headers = payload['includeHeaders'];
  if (!isRecord(headers)) return payload;
  return {
    ...payload,
    includeHeaders: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        typeof value === 'string' ? maskSecretValue(value) : value,
      ]),
    ),
  };
}

function preserveMaskedHeaders(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const next = incoming['includeHeaders'];
  const previous = existing['includeHeaders'];
  if (!isRecord(next) || !isRecord(previous)) return incoming;
  const headers = { ...next };
  for (const [name, value] of Object.entries(headers)) {
    const raw = previous[name];
    if (typeof value === 'string' && typeof raw === 'string' && value === maskSecretValue(raw)) {
      headers[name] = raw;
    }
  }
  return { ...incoming, includeHeaders: headers };
}

function toProfile(row: ProfileRow, maskHeaderValues: boolean): ConnectionProfile {
  const payload = parseJson<Record<string, unknown>>(row.payload, {});
  return {
    ...(maskHeaderValues ? maskHeaders(payload) : payload),
    id: row.id,
    name: row.name,
    mode: row.mode,
    exclude: Array.isArray(payload['exclude']) ? (payload['exclude'] as string[]) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as ConnectionProfile;
}

export class ConnectionProfileRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<ConnectionProfile[]> {
    const rows = await this.db
      .select()
      .from(connectionProfiles)
      .orderBy(asc(connectionProfiles.name), asc(connectionProfiles.createdAt));
    return rows.map((row) => toProfile(row, true));
  }

  async getById(id: string): Promise<ConnectionProfile | null> {
    const row = await this.db
      .select()
      .from(connectionProfiles)
      .where(eq(connectionProfiles.id, id))
      .get();
    return row ? toProfile(row, true) : null;
  }

  /** INTERNAL: unmasked record for transactional apply. Never serialize it. */
  async getFullById(id: string): Promise<ConnectionProfile | null> {
    const row = await this.db
      .select()
      .from(connectionProfiles)
      .where(eq(connectionProfiles.id, id))
      .get();
    return row ? toProfile(row, false) : null;
  }

  async create(input: ConnectionProfileCreate): Promise<ConnectionProfile> {
    const now = this.clock();
    const row = await this.db
      .insert(connectionProfiles)
      .values({
        id: uuidv7(),
        name: input.name,
        mode: input.mode,
        payload: toJson({
          ...toPayload(input as Record<string, unknown>),
          exclude: input.exclude ?? [],
        }),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toProfile(row, true);
  }

  async update(id: string, patch: ConnectionProfileUpdate): Promise<ConnectionProfile | null> {
    const existing = await this.db
      .select()
      .from(connectionProfiles)
      .where(eq(connectionProfiles.id, id))
      .get();
    if (!existing) return null;

    const values: Partial<ProfileRow> = { updatedAt: this.clock() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.mode !== undefined) values.mode = patch.mode;

    // Merge provided payload fields over the stored payload, preserving unknown
    // fields. `exclude` replaces wholesale (it is a coherent list, not a map).
    const patchPayload = toPayload(patch as Record<string, unknown>);
    if (Object.keys(patchPayload).length > 0) {
      const previousPayload = parseJson<Record<string, unknown>>(existing.payload, {});
      const merged = {
        ...previousPayload,
        ...preserveMaskedHeaders(patchPayload, previousPayload),
      };
      values.payload = toJson(merged);
    }

    const row = await this.db
      .update(connectionProfiles)
      .set(values)
      .where(eq(connectionProfiles.id, id))
      .returning()
      .get();
    return row ? toProfile(row, true) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(connectionProfiles)
      .where(eq(connectionProfiles.id, id))
      .run();
    return result.changes > 0;
  }
}
