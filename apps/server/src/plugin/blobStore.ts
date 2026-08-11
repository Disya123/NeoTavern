/**
 * Per-plugin content-addressed blob storage (rev4 storage slice, contract §2/§4).
 *
 * Layout: `<root>/<pluginId>/<blobId>.bin` holds the bytes and
 * `<root>/<pluginId>/<blobId>.json` the metadata sidecar. The blob id is the
 * sha256 hex digest of the content, so identical bytes deduplicate. Writes go
 * through a temp file + rename on the same volume so a crash never leaves a
 * half-visible blob (data file first, sidecar last — the blob only becomes
 * visible once the sidecar lands).
 */
import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, ErrorCodes, randomToken } from '@neotavern/shared';

/** rev4 storage limit: one blob may carry at most 8 MiB. */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** rev4 storage limit: a plugin keeps at most 64 blobs. */
export const MAX_BLOBS_PER_PLUGIN = 64;

const SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BLOB_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface BlobMeta {
  blobId: string;
  hash: string;
  size: number;
  name: string;
  contentType: string;
  createdAt: number;
}

/** Reject ids that could escape the per-plugin directory. */
function assertBlobId(blobId: string): void {
  if (!BLOB_ID_PATTERN.test(blobId)) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'INVALID_BLOB_ID', blobId },
    });
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export class PluginBlobStore {
  constructor(private readonly root: string) {}

  private dirFor(pluginId: string): string {
    if (pluginId.length === 0 || pluginId.length > 128 || !SEGMENT_PATTERN.test(pluginId)) {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'INVALID_PLUGIN_ID', pluginId },
      });
    }
    return join(this.root, pluginId);
  }

  /**
   * Store bytes under their content hash. Re-putting identical bytes
   * refreshes the sidecar (name / contentType) without counting twice.
   */
  async put(
    pluginId: string,
    bytes: Uint8Array,
    name: string,
    contentType: string,
  ): Promise<BlobMeta> {
    if (bytes.byteLength > MAX_BLOB_BYTES) {
      throw new AppError({
        code: ErrorCodes.FILE_TOO_LARGE,
        params: { sizeBytes: bytes.byteLength, limitBytes: MAX_BLOB_BYTES },
      });
    }
    const blobId = createHash('sha256').update(bytes).digest('hex');
    const dir = this.dirFor(pluginId);
    await mkdir(dir, { recursive: true });

    const meta: BlobMeta = {
      blobId,
      hash: blobId,
      size: bytes.byteLength,
      name: name.length > 0 ? name.slice(0, 255) : 'blob',
      contentType: contentType.length > 0 ? contentType.slice(0, 255) : 'application/octet-stream',
      createdAt: Date.now(),
    };

    if ((await this.readMeta(dir, blobId)) === null) {
      const count = (
        await readdir(dir).catch((error: unknown) => {
          if (isNotFound(error)) return [] as string[];
          throw error;
        })
      ).filter((entry) => entry.endsWith('.json')).length;
      if (count >= MAX_BLOBS_PER_PLUGIN) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'BLOB_LIMIT_REACHED', limit: MAX_BLOBS_PER_PLUGIN },
        });
      }
    }

    // Data first, sidecar last; each lands atomically via rename.
    const dataTmp = join(dir, `${blobId}.bin.tmp-${randomToken(10)}`);
    await writeFile(dataTmp, bytes);
    await rename(dataTmp, join(dir, `${blobId}.bin`));
    const metaTmp = join(dir, `${blobId}.json.tmp-${randomToken(10)}`);
    await writeFile(metaTmp, JSON.stringify(meta));
    await rename(metaTmp, join(dir, `${blobId}.json`));
    return meta;
  }

  /** Read one blob fully into memory; `null` when absent. */
  async get(pluginId: string, blobId: string): Promise<{ meta: BlobMeta; bytes: Buffer } | null> {
    assertBlobId(blobId);
    const dir = this.dirFor(pluginId);
    const meta = await this.readMeta(dir, blobId);
    if (!meta) return null;
    try {
      const bytes = await readFile(join(dir, `${blobId}.bin`));
      return { meta, bytes };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Stream a blob from disk; `null` when absent. */
  async getStream(
    pluginId: string,
    blobId: string,
  ): Promise<{ meta: BlobMeta; stream: ReadStream } | null> {
    assertBlobId(blobId);
    const dir = this.dirFor(pluginId);
    const meta = await this.readMeta(dir, blobId);
    if (!meta) return null;
    return { meta, stream: createReadStream(join(dir, `${blobId}.bin`)) };
  }

  /** List blob metadata, newest first (stable: createdAt desc, then id). */
  async list(pluginId: string): Promise<BlobMeta[]> {
    const dir = this.dirFor(pluginId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const items: BlobMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const meta = await this.readMeta(dir, entry.slice(0, -'.json'.length));
      if (meta) items.push(meta);
    }
    items.sort((a, b) => b.createdAt - a.createdAt || a.blobId.localeCompare(b.blobId));
    return items;
  }

  /** Remove a blob (data + sidecar). Returns whether anything was removed. */
  async delete(pluginId: string, blobId: string): Promise<boolean> {
    assertBlobId(blobId);
    const dir = this.dirFor(pluginId);
    const meta = await this.readMeta(dir, blobId);
    await rm(join(dir, `${blobId}.bin`), { force: true });
    await rm(join(dir, `${blobId}.json`), { force: true });
    return meta !== null;
  }

  private async readMeta(dir: string, blobId: string): Promise<BlobMeta | null> {
    try {
      const raw = await readFile(join(dir, `${blobId}.json`), 'utf8');
      const parsed = JSON.parse(raw) as Partial<BlobMeta>;
      if (
        typeof parsed.blobId !== 'string' ||
        typeof parsed.size !== 'number' ||
        typeof parsed.name !== 'string' ||
        typeof parsed.contentType !== 'string' ||
        typeof parsed.createdAt !== 'number'
      ) {
        return null;
      }
      return {
        blobId: parsed.blobId,
        hash: parsed.blobId,
        size: parsed.size,
        name: parsed.name,
        contentType: parsed.contentType,
        createdAt: parsed.createdAt,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error instanceof SyntaxError) return null; // corrupt sidecar → treat as absent
      throw error;
    }
  }
}
