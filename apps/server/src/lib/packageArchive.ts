import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomToken, AppError, ErrorCodes } from '@neotavern/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export interface PackageArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
}

export const DEFAULT_PACKAGE_ARCHIVE_LIMITS: PackageArchiveLimits = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxEntries: 2_000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024,
};

export interface ExtractedPackage {
  entries: number;
  expandedBytes: number;
}

function invalidArchive(reason: string): AppError {
  return new AppError({
    code: ErrorCodes.BAD_REQUEST,
    params: { reason },
    message: `Invalid package archive: ${reason}`,
  });
}

/** Validate a ZIP entry name before resolving it against a destination. */
export function validatePackageEntryPath(fileName: string): string[] {
  if (
    fileName.length === 0 ||
    fileName.length > 1024 ||
    fileName.includes('\0') ||
    fileName.includes('\\') ||
    fileName.startsWith('/') ||
    /^[a-z]:/iu.test(fileName)
  ) {
    throw invalidArchive('unsafe entry path');
  }

  const directory = fileName.endsWith('/');
  const segments = fileName.split('/');
  if (directory) segments.pop();
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalidArchive('unsafe entry path');
  }
  return segments;
}

function unixFileType(entry: Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0o170000;
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(
      path,
      {
        lazyEntries: true,
        autoClose: true,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error) reject(invalidArchive(error.message));
        else if (!zip) reject(invalidArchive('archive could not be opened'));
        else resolveOpen(zip);
      },
    );
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(invalidArchive(error.message));
      else if (!stream) reject(invalidArchive('entry stream could not be opened'));
      else resolveStream(stream);
    });
  });
}

/**
 * Extract a ZIP package into a caller-owned empty staging directory.
 * No links, encrypted entries, traversal paths or unbounded expansion are
 * accepted. Individual files are written through a temporary sibling.
 */
export async function extractPackageArchive(
  archivePath: string,
  destination: string,
  limits: PackageArchiveLimits = DEFAULT_PACKAGE_ARCHIVE_LIMITS,
  signal?: AbortSignal,
): Promise<ExtractedPackage> {
  checkArchiveAbort(signal);
  const archive = await stat(archivePath);
  if (!archive.isFile() || archive.size > limits.maxArchiveBytes) {
    throw invalidArchive('archive exceeds the compressed size limit');
  }

  await mkdir(destination, { recursive: true });
  const zip = await openZip(archivePath);
  let entries = 0;
  let expandedBytes = 0;
  // ТЗ §SEC-05: duplicate normalized paths are rejected — a later entry must
  // never silently overwrite an earlier one. Directories may repeat (harmless
  // idempotent mkdir), but a file colliding with an earlier file or with a
  // directory of the same name is refused.
  const seenPaths = new Set<string>();

  try {
    return await new Promise<ExtractedPackage>((resolveExtraction, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(
          signal?.aborted
            ? new AppError({ code: ErrorCodes.ABORTED })
            : error instanceof AppError
              ? error
              : invalidArchive(String(error)),
        );
      };

      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolveExtraction({ entries, expandedBytes });
      });
      zip.on('entry', (entry) => {
        void (async () => {
          checkArchiveAbort(signal);
          entries += 1;
          if (entries > limits.maxEntries)
            throw invalidArchive('archive contains too many entries');
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw invalidArchive('encrypted entries are not supported');
          }
          if (unixFileType(entry) === 0o120000) {
            throw invalidArchive('symbolic links are not allowed');
          }

          const segments = validatePackageEntryPath(entry.fileName);
          if (entry.fileName.endsWith('/')) {
            if (seenPaths.has(entry.fileName.slice(0, -1))) {
              throw invalidArchive('duplicate entry path');
            }
            seenPaths.add(entry.fileName);
          } else {
            if (seenPaths.has(entry.fileName) || seenPaths.has(`${entry.fileName}/`)) {
              throw invalidArchive('duplicate entry path');
            }
            seenPaths.add(entry.fileName);
          }
          expandedBytes += entry.uncompressedSize;
          if (
            entry.uncompressedSize > limits.maxEntryBytes ||
            expandedBytes > limits.maxExpandedBytes
          ) {
            throw invalidArchive('archive exceeds the expanded size limit');
          }

          const target = resolve(destination, ...segments);
          if (entry.fileName.endsWith('/')) {
            await mkdir(target, { recursive: true });
          } else {
            await mkdir(dirname(target), { recursive: true });
            const temporary = `${target}.partial-${randomToken(8)}`;
            try {
              const source = await openEntryStream(zip, entry);
              const targetStream = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
              if (signal) await pipeline(source, targetStream, { signal });
              else await pipeline(source, targetStream);
              await rename(temporary, target);
            } catch (error) {
              await rm(temporary, { force: true });
              throw error;
            }
          }
          zip.readEntry();
        })().catch(fail);
      });

      zip.readEntry();
    });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function checkArchiveAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AppError({ code: ErrorCodes.ABORTED });
  }
}
