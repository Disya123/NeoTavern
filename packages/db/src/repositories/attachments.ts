/**
 * Attachment metadata repository (ТЗ §10.2, §10.3): the database keeps
 * hash/mime/size/name/path bookkeeping while payloads live under
 * `data/files/`. Content is deduplicated by hash per owner.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, Clock } from '../db.js';
import { attachments } from '../schema/index.js';

type AttachmentRow = typeof attachments.$inferSelect;

export interface AttachmentRecord {
  id: string;
  ownerType: string;
  ownerId: string;
  logicalName: string;
  relativePath: string;
  contentHash: string;
  mime: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AttachmentInput {
  ownerType: string;
  ownerId: string;
  logicalName: string;
  relativePath: string;
  contentHash: string;
  mime: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
}

function rowToRecord(row: AttachmentRow): AttachmentRecord {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    // Corrupt metadata must not make the record unreadable.
  }
  return { ...row, metadata };
}

export class AttachmentRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  /**
   * Record a stored file, deduplicating by (owner, content hash): re-storing
   * the same bytes for the same owner refreshes the existing record instead
   * of duplicating it (ТЗ §10.3 content dedupe).
   */
  async record(input: AttachmentInput): Promise<AttachmentRecord> {
    const existing = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.ownerType, input.ownerType),
          eq(attachments.ownerId, input.ownerId),
          eq(attachments.contentHash, input.contentHash),
        ),
      )
      .get();
    if (existing) return rowToRecord(existing);
    const row = await this.db
      .insert(attachments)
      .values({
        id: uuidv7(),
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        logicalName: input.logicalName,
        relativePath: input.relativePath,
        contentHash: input.contentHash,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        metadata: JSON.stringify(input.metadata ?? {}),
        createdAt: this.clock(),
      })
      .returning()
      .get();
    return rowToRecord(row);
  }

  async listForOwner(ownerType: string, ownerId: string): Promise<AttachmentRecord[]> {
    const rows = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.ownerType, ownerType), eq(attachments.ownerId, ownerId)))
      .orderBy(asc(attachments.createdAt))
      .all();
    return rows.map(rowToRecord);
  }

  async findByHash(contentHash: string): Promise<AttachmentRecord | null> {
    const row = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.contentHash, contentHash))
      .limit(1)
      .get();
    return row ? rowToRecord(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(attachments).where(eq(attachments.id, id)).run();
    return result.changes > 0;
  }

  async deleteForOwner(ownerType: string, ownerId: string): Promise<number> {
    const result = await this.db
      .delete(attachments)
      .where(and(eq(attachments.ownerType, ownerType), eq(attachments.ownerId, ownerId)))
      .run();
    return result.changes;
  }

  async count(): Promise<number> {
    const row = await this.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(attachments)
      .get();
    return Number(row?.total ?? 0);
  }
}
