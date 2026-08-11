/**
 * Portable profile export (ТЗ §10.4): a single archive containing a consistent
 * database snapshot (SQLite online backup API — safe with WAL) and the user's
 * original files. Cache and logs are excluded by design: the archive must
 * remain small and must not carry regenerable or sensitive-by-accumulation
 * data. Plugins/themes are installations, not profile data, and stay out too.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { AppDatabase } from '@neotavern/db';
import { AppError, ErrorCodes } from '@neotavern/shared';
import yazl from 'yazl';
import type { DataPaths } from './paths.js';

export interface ProfileExportInput {
  database: AppDatabase;
  paths: DataPaths;
  profile: { id: string; name: string };
  appVersion: string;
}

export interface ProfileExportArchive {
  /** Stream the archive body from. */
  zip: yazl.ZipFile;
  /** Remove the temporary database snapshot. Call after the response ends. */
  cleanup(): Promise<void>;
}

export async function buildProfileExportArchive(
  input: ProfileExportInput,
): Promise<ProfileExportArchive> {
  const tempDir = await mkdtemp(join(tmpdir(), 'neotavern-profile-export-'));
  const snapshotPath = join(tempDir, 'app.db');
  try {
    await input.database.backup(snapshotPath);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw new AppError({
      code: ErrorCodes.PROFILE_EXPORT_FAILED,
      message: 'Database snapshot failed',
      cause: error,
    });
  }

  const zip = new yazl.ZipFile();
  zip.addFile(snapshotPath, 'app.db');
  zip.addBuffer(
    Buffer.from(
      JSON.stringify(
        {
          app: 'neotavern',
          format: 'neotavern-profile-export',
          version: 1,
          appVersion: input.appVersion,
          exportedAt: new Date().toISOString(),
          profile: input.profile,
        },
        null,
        2,
      ),
    ),
    'manifest.json',
  );

  await addDirectory(zip, input.paths.files, 'files');
  zip.end();

  return {
    zip,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/** Recursively add a directory tree under a zip prefix. Missing dirs are fine. */
async function addDirectory(zip: yazl.ZipFile, dir: string, zipPrefix: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory does not exist yet
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const zipPath = `${zipPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await addDirectory(zip, full, zipPath);
    } else if (entry.isFile()) {
      zip.addFile(full, zipPath.split(sep).join('/'));
    }
  }
}
