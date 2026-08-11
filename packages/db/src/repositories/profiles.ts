/**
 * Profile registry (ТЗ §10.2). Single-profile builds use one auto-created
 * "Default" profile; the stable identity makes portable exports meaningful.
 * The active profile is tracked in `app_meta` so switching survives restarts.
 */
import { asc, eq } from 'drizzle-orm';
import type { Profile } from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { Clock, DrizzleDb } from '../db.js';
import { profiles } from '../schema/index.js';
import type { AppMetaRepository } from './appMeta.js';

const ACTIVE_PROFILE_KEY = 'active_profile_id';

type ProfileRow = typeof profiles.$inferSelect;

function rowToProfile(row: ProfileRow): Profile {
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}

export class ProfileRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
    private readonly appMeta?: AppMetaRepository,
  ) {}

  /** Return all profiles, creating the default one on first use. */
  async list(): Promise<Profile[]> {
    const rows = await this.db.select().from(profiles).orderBy(asc(profiles.createdAt)).all();
    if (rows.length > 0) return rows.map(rowToProfile);
    const created = await this.create('Default');
    return [created];
  }

  /**
   * The active profile: the one marked in `app_meta`, falling back to the
   * oldest (single-profile builds predate the marker).
   */
  async getCurrent(): Promise<Profile> {
    const all = await this.list();
    const activeId = await this.appMeta?.get(ACTIVE_PROFILE_KEY);
    const active = activeId ? all.find((profile) => profile.id === activeId) : undefined;
    return (active ?? all[0]) as Profile;
  }

  /** Mark a profile active. Rejects unknown ids. */
  async setActive(id: string): Promise<Profile | null> {
    const profile = await this.getById(id);
    if (!profile) return null;
    await this.appMeta?.set(ACTIVE_PROFILE_KEY, id);
    return profile;
  }

  async getById(id: string): Promise<Profile | null> {
    const row = await this.db.select().from(profiles).where(eq(profiles.id, id)).get();
    return row ? rowToProfile(row) : null;
  }

  async create(name: string): Promise<Profile> {
    const row = await this.db
      .insert(profiles)
      .values({ id: uuidv7(), name, createdAt: this.clock() })
      .returning()
      .get();
    return rowToProfile(row);
  }

  async rename(id: string, name: string): Promise<Profile | null> {
    const row = await this.db
      .update(profiles)
      .set({ name })
      .where(eq(profiles.id, id))
      .returning()
      .get();
    return row ? rowToProfile(row) : null;
  }

  /**
   * Delete a profile. The active profile cannot be deleted; deleting any
   * other profile leaves the active marker untouched.
   */
  async delete(id: string): Promise<boolean> {
    const current = await this.getCurrent();
    if (current.id === id) return false;
    const result = await this.db.delete(profiles).where(eq(profiles.id, id)).run();
    return result.changes > 0;
  }
}
