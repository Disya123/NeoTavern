/** Preset repository: saved kind-partitioned configurations (ТЗ §10.2). */
import { and, asc, eq } from 'drizzle-orm';
import type { Preset, PresetCreate, PresetUpdate } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { Clock, DrizzleDb } from '../db.js';
import { presets } from '../schema/index.js';
import { parseJson, toJson } from '../json.js';

type PresetRow = typeof presets.$inferSelect;

function rowToPreset(row: PresetRow): Preset {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PresetRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async list(kind?: string): Promise<Preset[]> {
    const rows = await this.db
      .select()
      .from(presets)
      .where(kind ? eq(presets.kind, kind) : undefined)
      .orderBy(asc(presets.kind), asc(presets.name))
      .all();
    return rows.map(rowToPreset);
  }

  async create(input: PresetCreate): Promise<Preset> {
    const now = this.clock();
    const row = await this.db
      .insert(presets)
      .values({
        id: uuidv7(),
        kind: input.kind,
        name: input.name,
        data: toJson(input.data ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return rowToPreset(row);
  }

  async getById(id: string): Promise<Preset | null> {
    const row = await this.db.select().from(presets).where(eq(presets.id, id)).get();
    return row ? rowToPreset(row) : null;
  }

  async update(id: string, patch: PresetUpdate): Promise<Preset | null> {
    const values: Partial<PresetRow> = { updatedAt: this.clock() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.data !== undefined) values.data = toJson(patch.data);
    const row = await this.db
      .update(presets)
      .set(values)
      .where(and(eq(presets.id, id)))
      .returning()
      .get();
    return row ? rowToPreset(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(presets).where(eq(presets.id, id)).run();
    return result.changes > 0;
  }
}
