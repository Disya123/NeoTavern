/** Persona (user identity) repository. */
import { asc, eq } from 'drizzle-orm';
import type { Persona, PersonaCreate, PersonaUpdate } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { personas } from '../schema/index.js';

type PersonaRow = typeof personas.$inferSelect;

function rowToPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    avatar: row.avatar,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PersonaRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async create(input: PersonaCreate): Promise<Persona> {
    const now = this.clock();
    const id = uuidv7();
    const isDefault = input.isDefault ?? false;
    if (isDefault) await this.clearDefault();
    const row = await this.db
      .insert(personas)
      .values({
        id,
        name: input.name,
        description: input.description ?? '',
        avatar: input.avatar ?? null,
        isDefault,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return rowToPersona(row);
  }

  async getById(id: string): Promise<Persona | null> {
    const row = await this.db.select().from(personas).where(eq(personas.id, id)).get();
    return row ? rowToPersona(row) : null;
  }

  async getDefault(): Promise<Persona | null> {
    const row = await this.db.select().from(personas).where(eq(personas.isDefault, true)).get();
    return row ? rowToPersona(row) : null;
  }

  /**
   * The single "active persona" rule (ARCH-13): chat-level override → app-wide
   * active persona → the persona flagged default. Used by generation and the
   * prompt preview alike so both build identical prompts; a stale reference at
   * either level falls through instead of failing the request.
   */
  async resolveActive(
    chatPersonaId: string | null | undefined,
    appPersonaId: string | null | undefined,
  ): Promise<Persona | null> {
    if (chatPersonaId) {
      const chatPersona = await this.getById(chatPersonaId);
      if (chatPersona) return chatPersona;
    }
    if (appPersonaId) {
      const appPersona = await this.getById(appPersonaId);
      if (appPersona) return appPersona;
    }
    return this.getDefault();
  }

  async list(): Promise<Persona[]> {
    const rows = await this.db.select().from(personas).orderBy(asc(personas.createdAt));
    return rows.map(rowToPersona);
  }

  async update(id: string, patch: PersonaUpdate): Promise<Persona | null> {
    const values: Partial<PersonaRow> = { updatedAt: this.clock() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.avatar !== undefined) values.avatar = patch.avatar;
    if (patch.isDefault === true) await this.clearDefault();
    if (patch.isDefault !== undefined) values.isDefault = patch.isDefault;
    const row = await this.db
      .update(personas)
      .set(values)
      .where(eq(personas.id, id))
      .returning()
      .get();
    return row ? rowToPersona(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(personas).where(eq(personas.id, id)).run();
    return result.changes > 0;
  }

  private async clearDefault(): Promise<void> {
    await this.db
      .update(personas)
      .set({ isDefault: false })
      .where(eq(personas.isDefault, true))
      .run();
  }
}
