/**
 * Regenerable-cache bookkeeping (ТЗ §11.3): thumbnails and other derived
 * artifacts are recorded here so cache clearing is auditable and missing
 * entries can be detected. Never stores user data — everything recorded is
 * regenerable from its source hash.
 */
import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb, Clock } from '../db.js';
import { cacheMetadata } from '../schema/index.js';

export interface CacheRecordInput {
  /** Stable cache key (e.g. the thumbnail file name). */
  key: string;
  /** Path relative to the data directory. */
  relativePath: string;
  sourceHash: string;
  /** Requested target size, when the artifact is sized (thumbnails). */
  targetSize?: number | null;
  algorithmVersion: number;
  mime: string;
  sizeBytes: number;
}

export class CacheMetadataRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  /** Insert or refresh the record for a cache key. */
  async record(input: CacheRecordInput): Promise<void> {
    const now = this.clock();
    await this.db
      .insert(cacheMetadata)
      .values({
        key: input.key,
        relativePath: input.relativePath,
        sourceHash: input.sourceHash,
        targetSize: input.targetSize ?? null,
        algorithmVersion: input.algorithmVersion,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        createdAt: now,
        lastAccessedAt: now,
      })
      .onConflictDoUpdate({
        target: cacheMetadata.key,
        set: {
          relativePath: input.relativePath,
          sourceHash: input.sourceHash,
          targetSize: input.targetSize ?? null,
          algorithmVersion: input.algorithmVersion,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          lastAccessedAt: now,
        },
      })
      .run();
  }

  /** Best-effort last-access touch for cache-eviction diagnostics. */
  async touch(key: string): Promise<void> {
    await this.db
      .update(cacheMetadata)
      .set({ lastAccessedAt: this.clock() })
      .where(eq(cacheMetadata.key, key))
      .run();
  }

  /** Whether a record exists for the source/algorithm pair. */
  async hasForSource(sourceHash: string, algorithmVersion: number): Promise<boolean> {
    const row = await this.db
      .select({ key: cacheMetadata.key })
      .from(cacheMetadata)
      .where(
        sql`${cacheMetadata.sourceHash} = ${sourceHash}
           AND ${cacheMetadata.algorithmVersion} = ${algorithmVersion}`,
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  /** Total bytes of regenerable cache metadata (diagnostic report). */
  async totalSizeBytes(): Promise<number> {
    const row = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${cacheMetadata.sizeBytes}), 0)` })
      .from(cacheMetadata)
      .get();
    return Number(row?.total ?? 0);
  }
}
