/**
 * Content-addressed user-file storage and regenerable thumbnail cache.
 *
 * Originals are written atomically and never modified. Thumbnail keys include
 * the source hash, requested size and algorithm version.
 */
import { createHash } from 'node:crypto';
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import type sharp from 'sharp';
import type { Metadata } from 'sharp';
import { AppError, ErrorCodes, randomToken } from '@neotavern/shared';
import type { DataPaths } from './paths.js';

const THUMBNAIL_VERSION = 1;
const MAX_IMAGE_PIXELS = 40_000_000;
/** Preview size for chat wallpapers (kept < the full-res original). */
export const BACKGROUND_THUMBNAIL_SIZE = 1280;
/** Maximum bytes read when generating a thumbnail for an imported background. */
export const MAX_BACKGROUND_ORIGINAL_BYTES = 64 * 1024 * 1024;

export interface StoredAvatar {
  hash: string;
  originalUrl: string;
  thumbnailUrl: string;
}

/**
 * Bookkeeping sink for generated thumbnails (ТЗ §11.3 cache metadata).
 * Recording failures must not fail the upload — the artifact on disk remains
 * authoritative and regenerable.
 */
export interface CacheRecordSink {
  (record: {
    key: string;
    relativePath: string;
    sourceHash: string;
    targetSize: number;
    algorithmVersion: number;
    mime: string;
    sizeBytes: number;
  }): Promise<void> | void;
}

type SharpFactory = typeof sharp;
let sharpFactory: SharpFactory | null = null;
const runtimeRequire = createRequire(import.meta.url);

async function loadSharp(): Promise<SharpFactory> {
  if (sharpFactory) return sharpFactory;
  const externalPath = process.env['NEOTA_SHARP_MODULE'];
  const loaded: unknown = externalPath
    ? runtimeRequire(externalPath.replaceAll('\\', '/'))
    : await import('sharp');
  const candidate =
    typeof loaded === 'function'
      ? loaded
      : typeof loaded === 'object' && loaded !== null && 'default' in loaded
        ? loaded.default
        : null;
  if (typeof candidate !== 'function') {
    throw new AppError({
      code: ErrorCodes.INTERNAL,
      params: { component: 'sharp-runtime' },
    });
  }
  sharpFactory = candidate as SharpFactory;
  return sharpFactory;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(target: string, bytes: Buffer): Promise<void> {
  if (await exists(target)) return;
  const temporary = `${target}.${process.pid}.${randomToken(6)}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (cause) {
      if (!(await exists(target))) throw cause;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function extensionFor(format: string | undefined): string {
  if (format === 'jpeg') return '.jpg';
  if (format === 'png') return '.png';
  if (format === 'webp') return '.webp';
  if (format === 'gif') return '.gif';
  throw new AppError({
    code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
    params: { detectedFormat: format ?? 'unknown' },
  });
}

export async function storeAvatar(
  bytes: Buffer,
  paths: DataPaths,
  thumbnailSize = 256,
  recordCache?: CacheRecordSink,
): Promise<StoredAvatar> {
  const sharp = await loadSharp();
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
    }).metadata();
  } catch (cause) {
    throw new AppError({
      code: ErrorCodes.CHARACTER_CARD_INVALID,
      params: { reason: 'INVALID_AVATAR_IMAGE' },
      cause,
    });
  }

  const extension = extensionFor(metadata.format);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const originalName = `${hash}${extension}`;
  const thumbnailName = `${hash}-${thumbnailSize}-v${THUMBNAIL_VERSION}.webp`;
  const originalPath = resolve(paths.avatars, originalName);
  const thumbnailPath = resolve(paths.thumbnails, thumbnailName);

  await atomicWrite(originalPath, bytes);
  if (!(await exists(thumbnailPath))) {
    const thumbnail = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
    })
      .rotate()
      .resize(thumbnailSize, thumbnailSize, {
        fit: 'cover',
        position: 'attention',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();
    await atomicWrite(thumbnailPath, thumbnail);
    if (recordCache) {
      try {
        await recordCache({
          key: thumbnailName,
          relativePath: `thumbnails/${thumbnailName}`,
          sourceHash: hash,
          targetSize: thumbnailSize,
          algorithmVersion: THUMBNAIL_VERSION,
          mime: 'image/webp',
          sizeBytes: thumbnail.byteLength,
        });
      } catch {
        // Bookkeeping only: the thumbnail on disk is authoritative.
      }
    }
  }

  return {
    hash,
    originalUrl: `/api/v2/assets/avatars/${originalName}`,
    thumbnailUrl: `/api/v2/assets/thumbnails/${thumbnailName}`,
  };
}

export interface StoredBackground {
  /** Stored original filename (content hash + extension). */
  filename: string;
  originalUrl: string;
  thumbnailUrl: string;
}

async function writeThumbnail(
  bytes: Buffer,
  thumbnailPath: string,
  size: number,
  recordCache?: CacheRecordSink,
  cacheKey?: string,
): Promise<void> {
  if (await exists(thumbnailPath)) return;
  const sharp = await loadSharp();
  const thumbnail = await sharp(bytes, {
    failOn: 'error',
    limitInputPixels: MAX_IMAGE_PIXELS,
    animated: false,
  })
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  await atomicWrite(thumbnailPath, thumbnail);
  if (recordCache && cacheKey) {
    try {
      await recordCache({
        key: cacheKey,
        relativePath: `thumbnails/${cacheKey}`,
        sourceHash: cacheKey.replace(/-\d+-v\d+\.webp$/u, ''),
        targetSize: size,
        algorithmVersion: THUMBNAIL_VERSION,
        mime: 'image/webp',
        sizeBytes: thumbnail.byteLength,
      });
    } catch {
      // Bookkeeping only: the thumbnail on disk is authoritative.
    }
  }
}

function backgroundThumbnailName(key: string): string {
  return `${key}-${BACKGROUND_THUMBNAIL_SIZE}-v${THUMBNAIL_VERSION}.webp`;
}

/**
 * Stores an uploaded chat wallpaper content-addressed: the original lands in
 * `data/files/backgrounds/{hash}{ext}` and a preview thumbnail (aspect kept,
 * max 1280 px) in the regenerable thumbnail cache. Originals are never
 * modified; re-uploading identical bytes dedupes to the same filename.
 */
export async function storeBackground(
  bytes: Buffer,
  paths: DataPaths,
  recordCache?: CacheRecordSink,
): Promise<StoredBackground> {
  const sharp = await loadSharp();
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
    }).metadata();
  } catch (cause) {
    throw new AppError({
      code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
      params: { detectedFormat: 'unknown' },
      cause,
    });
  }

  const extension = extensionFor(metadata.format);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const filename = `${hash}${extension}`;
  await atomicWrite(resolve(paths.backgrounds, filename), bytes);
  // Thumbnail key derives from the stored filename (not the content hash) so
  // uploads, smooth listing and delete cleanup agree on the same key
  // (backgroundThumbnailFilename / ensureBackgroundThumbnail).
  const thumbnailName = backgroundThumbnailName(
    createHash('sha256').update(filename).digest('hex'),
  );
  await writeThumbnail(
    bytes,
    resolve(paths.thumbnails, thumbnailName),
    BACKGROUND_THUMBNAIL_SIZE,
    recordCache,
    thumbnailName,
  );

  return {
    filename,
    originalUrl: `/api/v2/assets/backgrounds/${filename}`,
    thumbnailUrl: `/api/v2/assets/thumbnails/${thumbnailName}`,
  };
}

/**
 * Ensures a preview thumbnail exists for a background file already on disk
 * (e.g. ST1-imported originals with arbitrary basenames). The thumbnail key is
 * derived from the filename (stable per stored name, cheap to compute), so the
 * existing `/api/v2/assets/thumbnails` route can serve it. Returns the
 * thumbnail URL, or `null` when the file is missing or not a decodable image.
 */
export async function ensureBackgroundThumbnail(
  filename: string,
  paths: DataPaths,
  recordCache?: CacheRecordSink,
): Promise<string | null> {
  const original = resolve(paths.backgrounds, filename);
  const thumbnailName = backgroundThumbnailName(
    createHash('sha256').update(filename).digest('hex'),
  );
  if (await exists(resolve(paths.thumbnails, thumbnailName))) {
    return `/api/v2/assets/thumbnails/${thumbnailName}`;
  }
  try {
    const bytes = await readFile(original);
    if (bytes.byteLength > MAX_BACKGROUND_ORIGINAL_BYTES) return null;
    await writeThumbnail(
      bytes,
      resolve(paths.thumbnails, thumbnailName),
      BACKGROUND_THUMBNAIL_SIZE,
      recordCache,
      thumbnailName,
    );
    return `/api/v2/assets/thumbnails/${thumbnailName}`;
  } catch {
    return null;
  }
}

/** Preview thumbnail filename for a stored background (cache cleanup). */
export function backgroundThumbnailFilename(filename: string): string {
  return backgroundThumbnailName(createHash('sha256').update(filename).digest('hex'));
}

/**
 * Validates a background filename for direct filesystem access: no path
 * separators, no hidden/relative entries, a supported image extension and a
 * sane length. Imported originals may carry non-ASCII basenames.
 */
export function safeBackgroundPath(
  base: string,
  filename: string,
  allowedExtensions: ReadonlySet<string>,
): string | null {
  if (
    filename.length === 0 ||
    filename.length > 255 ||
    filename.startsWith('.') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    return null;
  }
  if (!allowedExtensions.has(extname(filename).toLowerCase())) return null;
  const target = resolve(base, filename);
  return target.startsWith(`${resolve(base)}\\`) || target.startsWith(`${resolve(base)}/`)
    ? target
    : null;
}

/**
 * Normalizes a stored avatar to a plain PNG before character-card metadata is
 * embedded. A transparent portrait canvas is used when the character has no
 * local avatar, so PNG export remains available without a network dependency.
 */
export async function renderAvatarPng(bytes: Buffer | null): Promise<Buffer> {
  const sharp = await loadSharp();
  const source = bytes
    ? sharp(bytes, {
        failOn: 'error',
        limitInputPixels: MAX_IMAGE_PIXELS,
        animated: false,
      }).rotate()
    : sharp({
        create: {
          width: 512,
          height: 768,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      });
  return source.png().toBuffer();
}

export function safeAssetPath(
  base: string,
  filename: string,
  allowedExtensions: ReadonlySet<string>,
): string | null {
  if (!/^[a-f0-9]{64}(?:-\d+-v\d+)?\.[a-z0-9]+$/.test(filename)) return null;
  if (!allowedExtensions.has(extname(filename))) return null;
  const target = resolve(base, filename);
  return target.startsWith(`${resolve(base)}\\`) || target.startsWith(`${resolve(base)}/`)
    ? target
    : null;
}
