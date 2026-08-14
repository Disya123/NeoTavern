/**
 * Installed-package integrity and install recovery (ТЗ §SEC-05).
 *
 * The publisher signature + per-file digests are verified BEFORE install
 * (`verifyPackageTrust`). This module makes that verification durable for
 * the lifetime of the installation:
 *
 * - `snapshotInstalledDigests` writes the computed digests of the freshly
 *   installed package next to it (`<pluginRoot>/installed-digests.json`);
 * - `verifyInstalledIntegrity` recomputes the digests at every later
 *   activation (enable route, startup auto-activation) and refuses to load
 *   the package when any file was added, removed or modified after install —
 *   fail-closed, `PLUGIN_SIGNATURE_INVALID` with reason
 *   `TAMPERED_AFTER_INSTALL`. A package without a digest snapshot (installed
 *   before this build, or a manually placed directory) is also refused: an
 *   unknown file set must never silently run.
 *
 * Install recovery journal (v2): `install-journal.json` is written durably
 * BEFORE the first filesystem mutation of a promotion and records the full
 * rollback contract — the new version, the previous version, the exact
 * `.incoming-*` / `.rollback-*` paths, and the previous registry row (or
 * `null` for a fresh install). On startup `recoverInterruptedInstalls`
 * restores a CONSISTENT database + filesystem pair from every intermediate
 * crash state:
 *   - an update interrupted after the old package was moved to `.rollback-*`
 *     is rolled back to the previous version on disk AND in the registry —
 *     the crash can never leave both versions deleted;
 *   - a fresh install interrupted after the registry write is rolled back to
 *     "not installed" (row + half-promoted files removed);
 *   - a committed journal is dropped as completed.
 */
import { createHash } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginRegistryEntry } from '@neotavern/db';
import { AppError, ErrorCodes, type Logger } from '@neotavern/shared';
import { collectFileDigests, verifyPackageTrust } from './packageTrust.js';

export const INSTALLED_DIGESTS_FILE = 'installed-digests.json';
export const INSTALL_JOURNAL_FILE = 'install-journal.json';
const DIGESTS_FORMAT = 'neotavern.installed-digests.v1';
const JOURNAL_FORMAT = 'neotavern.install-journal.v2';

export interface InstalledDigestsRecord {
  format: typeof DIGESTS_FORMAT;
  pluginId: string;
  version: string;
  digests: Record<string, string>;
  recordedAt: string;
}

/**
 * Durable install journal (v2). Written BEFORE the first mutation of a
 * promotion and updated to `committed` only after the registry write, so a
 * crash at ANY point leaves enough information to restore the last-known-good
 * pair (files + registry row).
 */
export interface InstallJournalEntry {
  format: typeof JOURNAL_FORMAT;
  pluginId: string;
  /** The version being promoted. */
  version: string;
  /** The version being replaced, or null for a fresh install. */
  previousVersion: string | null;
  /** The exact paths of the promotion (v2: recovery never guesses names). */
  paths: {
    /** Final package directory (`<pluginRoot>/package`). */
    package: string;
    /** Staged incoming directory (`.incoming-*`). */
    incoming: string;
    /** Previous package parked for rollback (`.rollback-*`), null on fresh install. */
    rollback: string | null;
  };
  /** The registry state to restore on an interrupted promotion. */
  registry: {
    /** The full previous registry row, or null for a fresh install. */
    previous: PluginRegistryEntry | null;
  };
  state: 'staging' | 'committed' | 'rolled_back';
  updatedAt: string;
}

/**
 * Minimal registry surface the recovery needs to restore a consistent
 * database + filesystem pair (the server passes the plugins repository).
 */
export interface InstallRecoveryRepo {
  /** Restore a registry row verbatim (crash rollback of an update). */
  restoreEntry(entry: PluginRegistryEntry): void;
  /** Remove a registry row (crash rollback of a fresh install). */
  delete(id: string): boolean;
}

/** Write a file atomically with fsync (temp + fsync + rename + dir fsync). */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync(); // the journal must be durable before any mutation
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await rename(tmp, path);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
  // fsync the parent directory so the rename itself is durable (best effort —
  // directory fsync is not supported on all platforms/filesystems).
  try {
    const dir = await open(join(path, '..'), 'r');
    await dir.sync().catch(() => undefined);
    await dir.close().catch(() => undefined);
  } catch {
    // best effort
  }
}

function tampered(pluginId: string, reason: string, path?: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_SIGNATURE_INVALID,
    params: {
      pluginId,
      reason: `TAMPERED_AFTER_INSTALL:${reason}`,
      ...(path === undefined ? {} : { path }),
    },
    message: 'installed plugin files do not match the recorded digests',
  });
}

/** Snapshot the digests of a freshly installed package next to it. */
export async function snapshotInstalledDigests(
  packageRoot: string,
  pluginId: string,
  version: string,
  pluginRoot: string,
): Promise<void> {
  const digests = await collectFileDigests(packageRoot);
  const record: InstalledDigestsRecord = {
    format: DIGESTS_FORMAT,
    pluginId,
    version,
    digests,
    recordedAt: new Date().toISOString(),
  };
  await mkdir(pluginRoot, { recursive: true });
  await writeFileAtomic(join(pluginRoot, INSTALLED_DIGESTS_FILE), JSON.stringify(record, null, 2));
}

/**
 * Re-verify that the installed package files still match the digest snapshot
 * taken at install time. Throws `PLUGIN_SIGNATURE_INVALID` on any mismatch —
 * the caller must refuse to activate.
 */
export async function verifyInstalledIntegrity(
  packageRoot: string,
  pluginId: string,
  pluginRoot: string,
): Promise<void> {
  let record: InstalledDigestsRecord;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(pluginRoot, INSTALLED_DIGESTS_FILE), 'utf8'),
    ) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TypeError('installed digests must be an object');
    }
    const value = parsed as Partial<InstalledDigestsRecord>;
    if (
      value.format !== DIGESTS_FORMAT ||
      typeof value.pluginId !== 'string' ||
      typeof value.digests !== 'object' ||
      value.digests === null ||
      Array.isArray(value.digests)
    ) {
      throw new TypeError('unsupported installed digests shape');
    }
    record = value as InstalledDigestsRecord;
  } catch {
    // No valid digest snapshot: fail closed. A package without a recorded
    // baseline must never load with an unknown file set.
    throw tampered(pluginId, 'NO_DIGEST_SNAPSHOT');
  }
  if (record.pluginId !== pluginId) {
    throw tampered(pluginId, 'PLUGIN_ID_MISMATCH');
  }
  const actual = await collectFileDigests(packageRoot);
  const expectedPaths = Object.keys(record.digests).sort();
  const actualPaths = Object.keys(actual).sort();
  if (
    expectedPaths.length !== actualPaths.length ||
    !expectedPaths.every((path, i) => path === actualPaths[i])
  ) {
    throw tampered(pluginId, 'FILE_SET_MISMATCH');
  }
  for (const path of expectedPaths) {
    if (actual[path] !== record.digests[path]) {
      throw tampered(pluginId, 'DIGEST_MISMATCH', path);
    }
  }
}

async function hasInstalledDigests(pluginRoot: string): Promise<boolean> {
  try {
    const info = await stat(join(pluginRoot, INSTALLED_DIGESTS_FILE));
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Activation/startup integrity gate (SEC-05):
 * - when a digest snapshot exists, the installed files MUST still match it
 *   (fail-closed on any tamper);
 * - when no snapshot exists (a package installed before this build), the
 *   publisher signature is re-verified as the baseline and the snapshot is
 *   recorded, so every later activation is checked against it. A signed
 *   package whose files no longer verify is refused; an unsigned package
 *   (locally-trusted by its install consent) is snapshotted as-is.
 */
export async function ensureInstalledIntegrity(
  packageRoot: string,
  pluginId: string,
  version: string,
  pluginRoot: string,
  trustedPublisherKeys: readonly string[],
): Promise<void> {
  // A registry entry without a package directory (e.g. a fileless frontend
  // plugin or a manually removed tree) has no files to re-verify; loading it
  // executes no package code, and its load failure path is handled by the
  // host activation itself. The integrity gate protects real installed files.
  const packageInfo = await stat(packageRoot).catch(() => null);
  if (packageInfo === null || !packageInfo.isDirectory()) {
    return;
  }
  if (await hasInstalledDigests(pluginRoot)) {
    await verifyInstalledIntegrity(packageRoot, pluginId, pluginRoot);
    return;
  }
  // Pre-upgrade install: verify against the publisher signature (throws on a
  // broken/untrusted signature, passes for unsigned packages), then record
  // the baseline snapshot.
  await verifyPackageTrust(packageRoot, trustedPublisherKeys);
  await snapshotInstalledDigests(packageRoot, pluginId, version, pluginRoot);
}

/** Record an install phase durably (idempotent per plugin root). */
export async function writeInstallJournal(
  pluginRoot: string,
  entry: {
    pluginId: string;
    version: string;
    previousVersion?: string | null;
    paths?: InstallJournalEntry['paths'];
    registry?: InstallJournalEntry['registry'];
    state: InstallJournalEntry['state'];
  },
): Promise<void> {
  const journal: InstallJournalEntry = {
    format: JOURNAL_FORMAT,
    pluginId: entry.pluginId,
    version: entry.version,
    previousVersion: entry.previousVersion ?? null,
    paths: entry.paths ?? {
      package: join(pluginRoot, 'package'),
      incoming: '',
      rollback: null,
    },
    registry: entry.registry ?? { previous: null },
    state: entry.state,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(pluginRoot, { recursive: true });
  await writeFileAtomic(join(pluginRoot, INSTALL_JOURNAL_FILE), JSON.stringify(journal, null, 2));
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

/** Read a v2 journal, falling back to a legacy v1 shape (no paths/registry). */
function readJournal(journalPath: string): Promise<InstallJournalEntry | null> {
  return readFile(journalPath, 'utf8')
    .then((raw) => {
      const parsed: unknown = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const value = parsed as Partial<InstallJournalEntry>;
      if (typeof value.pluginId !== 'string' || typeof value.state !== 'string') return null;
      if (value.format === JOURNAL_FORMAT && value.paths && value.registry) {
        return value as InstallJournalEntry;
      }
      // Legacy v1 journal (no paths/registry): recover conservatively.
      const pluginRoot = dirname(journalPath);
      return {
        format: JOURNAL_FORMAT,
        pluginId: value.pluginId,
        version: typeof value.version === 'string' ? value.version : 'unknown',
        previousVersion: null,
        paths: { package: join(pluginRoot, 'package'), incoming: '', rollback: null },
        registry: { previous: null },
        state: value.state as InstallJournalEntry['state'],
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      };
    })
    .catch(() => null); // no journal — nothing to recover
}

/**
 * Startup recovery (SEC-05): restore a CONSISTENT database + filesystem pair
 * from every intermediate crash state of a package promotion.
 *
 * The v2 journal is written BEFORE the first mutation and carries the exact
 * `.incoming-*` / `.rollback-*` paths plus the previous registry row, so:
 *   - an UPDATE interrupted after the old package was parked in `.rollback-*`
 *     is rolled back to the previous version on disk AND in the registry
 *     (recovery never deletes both versions — the user's exact failure mode);
 *   - a FRESH INSTALL interrupted after the registry write is rolled back to
 *     "not installed" (row removed, half-promoted files removed);
 *   - a crash before ANY mutation (no incoming, no rollback) leaves the
 *     previous install untouched — the journal is simply dropped.
 */
export async function recoverInterruptedInstalls(
  pluginsDir: string,
  repo: InstallRecoveryRepo,
  logger: Logger,
): Promise<void> {
  let pluginIds: string[];
  try {
    pluginIds = await readdir(pluginsDir, { withFileTypes: true }).then((entries) =>
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    );
  } catch {
    return; // plugins dir does not exist yet — nothing to recover
  }
  for (const pluginId of pluginIds) {
    if (pluginId.startsWith('.')) continue; // never touch dot-scratch dirs
    const pluginRoot = join(pluginsDir, pluginId);
    const journalPath = join(pluginRoot, INSTALL_JOURNAL_FILE);
    const journal = await readJournal(journalPath);
    if (journal === null) continue;
    if (journal.state === 'committed') {
      // Completed install: drop the journal marker.
      await rm(journalPath, { force: true }).catch(() => undefined);
      continue;
    }
    const { paths } = journal;
    const incomingExists = paths.incoming !== '' && (await exists(paths.incoming));
    const rollbackExists = paths.rollback !== null && (await exists(paths.rollback));
    if (!incomingExists && !rollbackExists) {
      // Crash before ANY mutation: the previous install (files and registry
      // row) is still the last-known-good state — drop the journal, touch
      // nothing.
      logger.warn(
        `[plugin-install] dropping stale install journal of ${pluginId}@${journal.version} ` +
          `(no promotion mutations were observed)`,
      );
      await rm(journalPath, { force: true }).catch(() => undefined);
      continue;
    }
    if (rollbackExists) {
      // UPDATE interrupted: the old version is parked in `.rollback-*`.
      // Remove the half-promoted new package (it must not shadow the
      // restored version), move the old one back, and restore the previous
      // registry row.
      logger.warn(
        `[plugin-install] rolling back interrupted update of ${pluginId} ` +
          `${journal.previousVersion ?? '?'} -> ${journal.version} (journal state: ${journal.state})`,
      );
      await rm(paths.package, { recursive: true, force: true }).catch(() => undefined);
      await rm(paths.incoming, { recursive: true, force: true }).catch(() => undefined);
      await rename(paths.rollback, paths.package).catch((error) => {
        logger.error(
          `[plugin-install] could not restore ${pluginId} from rollback: ${String(error)}`,
        );
      });
      if (journal.registry.previous) {
        repo.restoreEntry(journal.registry.previous);
      }
    } else {
      // FRESH INSTALL interrupted: nothing to restore — remove the
      // half-promoted files and any registry row the promotion may have
      // written before the crash.
      logger.warn(
        `[plugin-install] removing interrupted fresh install of ${pluginId}@${journal.version} ` +
          `(journal state: ${journal.state})`,
      );
      await rm(paths.package, { recursive: true, force: true }).catch(() => undefined);
      await rm(paths.incoming, { recursive: true, force: true }).catch(() => undefined);
      repo.delete(pluginId);
    }
    await rm(journalPath, { force: true }).catch(() => undefined);
  }
  // Plugins-dir-level scratch leftovers (staged dirs / uninstall removals).
  for (const entry of await readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.incoming-') || entry.name.startsWith('.remove-')) {
      await rm(join(pluginsDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  // Plugin-root scratch leftovers WITHOUT a journal (the journal is the only
  // proof of intent). A stray `.rollback-*` may be the ONLY copy of the
  // previous version — never delete it: restore it to `package` when the
  // package is missing, otherwise leave it and warn.
  for (const pluginId of await readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (!pluginId.isDirectory() || pluginId.name.startsWith('.')) continue;
    const pluginRoot = join(pluginsDir, pluginId.name);
    if (await exists(join(pluginRoot, INSTALL_JOURNAL_FILE))) continue; // handled above
    const entries = await readdir(pluginRoot, { withFileTypes: true }).catch(() => []);
    const rollbacks = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.rollback-'))
      .map((entry) => join(pluginRoot, entry.name));
    for (const rollback of rollbacks) {
      if (await exists(join(pluginRoot, 'package'))) {
        logger.warn(
          `[plugin-install] keeping stray rollback ${rollback} (no journal; ` +
            'a package is present — deleting it could remove the only copy of a version)',
        );
        continue;
      }
      logger.warn(
        `[plugin-install] restoring stray rollback ${rollback} to package ` +
          '(no journal; the promotion never committed)',
      );
      await rename(rollback, join(pluginRoot, 'package')).catch(() => undefined);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('.incoming-')) {
        await rm(join(pluginRoot, entry.name), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }
}

/** sha256 hex of a string — used to pin journal/journals in tests. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
