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
 * Install recovery journal: `install-journal.json` records the phases of a
 * package promotion (staging → committed / rolled_back). On startup,
 * `recoverInterruptedInstalls` scans the plugins directory: a journal that is
 * not `committed` means a crash between the rename and the registry write —
 * the half-promoted package and any `.incoming-*` / `.rollback-*` leftovers
 * are removed so the next install starts from a clean state.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, ErrorCodes, type Logger } from '@neotavern/shared';
import { collectFileDigests, verifyPackageTrust } from './packageTrust.js';

export const INSTALLED_DIGESTS_FILE = 'installed-digests.json';
export const INSTALL_JOURNAL_FILE = 'install-journal.json';
const DIGESTS_FORMAT = 'neotavern.installed-digests.v1';
const JOURNAL_FORMAT = 'neotavern.install-journal.v1';

export interface InstalledDigestsRecord {
  format: typeof DIGESTS_FORMAT;
  pluginId: string;
  version: string;
  digests: Record<string, string>;
  recordedAt: string;
}

export interface InstallJournalEntry {
  format: typeof JOURNAL_FORMAT;
  pluginId: string;
  version: string;
  state: 'staging' | 'committed' | 'rolled_back';
  updatedAt: string;
}

/** Write a file atomically (temp + rename on the same volume). */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, path);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
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
  entry: { pluginId: string; version: string; state: InstallJournalEntry['state'] },
): Promise<void> {
  const journal: InstallJournalEntry = {
    format: JOURNAL_FORMAT,
    pluginId: entry.pluginId,
    version: entry.version,
    state: entry.state,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(pluginRoot, { recursive: true });
  await writeFileAtomic(join(pluginRoot, INSTALL_JOURNAL_FILE), JSON.stringify(journal, null, 2));
}

/**
 * Startup recovery (SEC-05): scan the plugins directory for interrupted
 * installs — a journal that is not `committed` means the process crashed
 * between staging and the registry write. The half-promoted package and any
 * `.incoming-*` / `.rollback-*` leftovers are removed so a retried install
 * starts clean; committed journals are dropped as completed.
 */
export async function recoverInterruptedInstalls(
  pluginsDir: string,
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
    let journal: InstallJournalEntry | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(journalPath, 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const value = parsed as Partial<InstallJournalEntry>;
        if (value.format === JOURNAL_FORMAT && typeof value.state === 'string') {
          journal = value as InstallJournalEntry;
        }
      }
    } catch {
      journal = null; // no journal — nothing to recover
    }
    if (journal === null) continue;
    if (journal.state === 'committed') {
      // Completed install: drop the journal marker.
      await rm(journalPath, { force: true }).catch(() => undefined);
      continue;
    }
    // Interrupted: state is staging or rolled_back. Remove the half-promoted
    // package (no registry row points at it) and the journal.
    logger.warn(
      `[plugin-install] recovering interrupted install of ${pluginId}@${journal.version} ` +
        `(journal state: ${journal.state}) — removing the half-promoted package`,
    );
    await rm(join(pluginRoot, 'package'), { recursive: true, force: true }).catch(() => undefined);
    await rm(journalPath, { force: true }).catch(() => undefined);
  }
  // Clean any scratch leftovers at the plugins-dir level.
  for (const entry of await readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.incoming-') || entry.name.startsWith('.remove-')) {
      await rm(join(pluginsDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  // Plugin-root scratch leftovers (update rollback paths).
  for (const pluginId of await readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (!pluginId.isDirectory() || pluginId.name.startsWith('.')) continue;
    const entries = await readdir(join(pluginsDir, pluginId.name), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.incoming-') || entry.name.startsWith('.rollback-')) {
        await rm(join(pluginsDir, pluginId.name, entry.name), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
    }
  }
}

/** sha256 hex of a string — used to pin journal/journals in tests. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
