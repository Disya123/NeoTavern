/**
 * Tar.gz package extraction mirroring the ZIP path in `packageArchive.ts`.
 *
 * Used for plugins installed from a Git repository archive. The same safety
 * contract applies: no links, no traversal paths, no unbounded expansion, and
 * every file is written through a temporary sibling with restrictive mode.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomToken, AppError, ErrorCodes } from '@neotavern/shared';
import { Parser, type ReadEntry } from 'tar';
import {
  DEFAULT_PACKAGE_ARCHIVE_LIMITS,
  validatePackageEntryPath,
  type ExtractedPackage,
  type PackageArchiveLimits,
} from './packageArchive.js';

function invalidTarball(reason: string): AppError {
  return new AppError({
    code: ErrorCodes.BAD_REQUEST,
    params: { reason },
    message: `Invalid tarball archive: ${reason}`,
  });
}

async function assertGzipMagic(archivePath: string): Promise<void> {
  const handle = await open(archivePath, 'r');
  try {
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      throw invalidTarball('archive is not gzip-compressed');
    }
  } finally {
    await handle.close();
  }
}

/** Entry types that are regular filesystem content we are willing to extract. */
const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

/**
 * Extract a `.tar.gz` package into a caller-owned empty staging directory.
 * Symbolic/hard links, device nodes and traversal paths are rejected; per-entry
 * and total expansion limits are enforced. Files are written atomically.
 */
export async function extractTarGzArchive(
  archivePath: string,
  destination: string,
  limits: PackageArchiveLimits = DEFAULT_PACKAGE_ARCHIVE_LIMITS,
  signal?: AbortSignal,
): Promise<ExtractedPackage> {
  if (signal?.aborted) throw new AppError({ code: ErrorCodes.ABORTED });

  const info = await stat(archivePath).catch(() => null);
  if (!info?.isFile() || info.size > limits.maxArchiveBytes) {
    throw invalidTarball('archive exceeds the compressed size limit');
  }
  await assertGzipMagic(archivePath);
  await mkdir(destination, { recursive: true });

  let entries = 0;
  let expandedBytes = 0;
  // Serialize per-entry filesystem work; the parser only advances once the
  // current entry stream is fully consumed, so a chained promise keeps the
  // accounting correct even if an entry handler is async.
  let chain: Promise<unknown> = Promise.resolve();
  let firstError: unknown = null;

  const fail = (error: unknown): void => {
    if (firstError === null) firstError = error;
  };

  const parser = new Parser({ strict: true });
  parser.on('error', fail);
  parser.on('entry', (entry: ReadEntry) => {
    // The parser cannot advance past an unconsumed entry body, so every entry
    // is drained on error paths and after the first failure. Errors are folded
    // into `firstError` instead of rejecting `chain`: a rejected chain with no
    // further entries would surface as an unhandled rejection.
    chain = chain.then(async () => {
      if (firstError !== null) {
        await drain(entry);
        return;
      }
      try {
        await handleEntry(entry);
      } catch (error) {
        await drain(entry);
        fail(error);
      }
    });
  });

  const done = new Promise<void>((resolveDone, rejectDone) => {
    parser.on('end', () => {
      void chain.then(() => {
        if (signal?.aborted) rejectDone(new AppError({ code: ErrorCodes.ABORTED }));
        else if (firstError !== null) rejectDone(firstError);
        else resolveDone();
      }, rejectDone);
    });
  });

  /**
   * Consume an entry's body so the parser can advance to the next header.
   * `finished()` from node:stream does not accept the tar ReadEntry type, so
   * the terminal events are awaited directly; drain failures are irrelevant —
   * the overall outcome is already tracked through `firstError`.
   */
  function drain(entry: ReadEntry): Promise<void> {
    // Zero-byte entries may have ended before the handler runs; awaiting the
    // terminal events again would hang the extraction chain forever.
    if (entry.emittedEnd) return Promise.resolve();
    entry.resume();
    return new Promise((resolveDrain) => {
      entry.once('end', resolveDrain);
      entry.once('close', resolveDrain);
      entry.once('error', resolveDrain);
    });
  }

  /**
   * Process a single entry. The entry body is always fully consumed before the
   * returned promise settles, otherwise the tar parser stalls and never emits
   * `end`.
   */
  async function handleEntry(entry: ReadEntry): Promise<void> {
    if (signal?.aborted) throw new AppError({ code: ErrorCodes.ABORTED });
    entries += 1;
    if (entries > limits.maxEntries) throw invalidTarball('archive contains too many entries');

    const type = entry.type;
    if (type === 'Directory') {
      const segments = validatePackageEntryPath(normalizeDirPath(entry.path));
      await mkdir(resolve(destination, ...segments), { recursive: true });
      await drain(entry);
      return;
    }
    if (FILE_TYPES.has(type)) {
      if (entry.size > limits.maxEntryBytes) {
        await drain(entry);
        throw invalidTarball('archive exceeds the expanded size limit');
      }
      expandedBytes += entry.size;
      if (expandedBytes > limits.maxExpandedBytes) {
        await drain(entry);
        throw invalidTarball('archive exceeds the expanded size limit');
      }
      const segments = validatePackageEntryPath(entry.path);
      const target = resolve(destination, ...segments);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.partial-${randomToken(8)}`;
      try {
        const targetStream = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
        await pipeline(entry, targetStream);
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return;
    }
    // SymbolicLink, Link, devices, FIFOs and anything exotic are rejected.
    await drain(entry);
    throw invalidTarball(`unsupported archive entry type: ${type}`);
  }

  try {
    // Await both together so `done` never rejects without a handler attached.
    await Promise.all([pipeline(createReadStream(archivePath), parser), done]);
    return { entries, expandedBytes };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (signal?.aborted) throw new AppError({ code: ErrorCodes.ABORTED });
    throw error instanceof AppError ? error : invalidTarball(String(error));
  }
}

/** Tar directory entries may or may not carry a trailing slash. */
function normalizeDirPath(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}
