/**
 * Installed-package integrity and install-recovery tests (ТЗ §SEC-05):
 * digest snapshot + re-verify at activation (fail-closed on tamper after
 * install), the pre-upgrade baseline path, the interrupted-install recovery
 * journal, and the end-to-end route that refuses a tampered package.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, isAppError } from '@neotavern/shared';
import { createTestApp, multipartFile } from './helpers.js';
import {
  INSTALL_JOURNAL_FILE,
  ensureInstalledIntegrity,
  recoverInterruptedInstalls,
  snapshotInstalledDigests,
  verifyInstalledIntegrity,
  writeInstallJournal,
} from '../src/lib/packageIntegrity.js';
import yazl from 'yazl';

const logger = createLogger({ level: 'error' });
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'neotavern-integrity-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function zipArchive(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [path, contents] of Object.entries(entries)) {
    zip.addBuffer(Buffer.from(contents), path);
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function pluginPackage(
  id: string,
  version: string,
  frontend = 'export default {};',
): Promise<Buffer> {
  return zipArchive({
    'plugin.json': JSON.stringify({
      id,
      name: id,
      version,
      apiVersion: 2,
      frontend: 'frontend.js',
    }),
    'frontend.js': frontend,
  });
}

describe('installed-package integrity (ТЗ §SEC-05)', () => {
  it('accepts a package whose files still match the digest snapshot', async () => {
    const root = await tempDir();
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x"}');
    await writeFile(join(packageRoot, 'frontend.js'), 'export default {};');

    await snapshotInstalledDigests(packageRoot, 'author.tamper-test', '1.0.0', root);
    await expect(
      verifyInstalledIntegrity(packageRoot, 'author.tamper-test', root),
    ).resolves.toBeUndefined();
  });

  it('refuses a modified file after install (DIGEST_MISMATCH)', async () => {
    const root = await tempDir();
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x"}');
    await writeFile(join(packageRoot, 'frontend.js'), 'export default {};');
    await snapshotInstalledDigests(packageRoot, 'author.tamper-test', '1.0.0', root);

    await writeFile(join(packageRoot, 'frontend.js'), 'export default { hacked: true };');
    const error = await verifyInstalledIntegrity(packageRoot, 'author.tamper-test', root).catch(
      (caught: unknown) => caught,
    );
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe('PLUGIN_SIGNATURE_INVALID');
      expect(error.params).toMatchObject({
        reason: 'TAMPERED_AFTER_INSTALL:DIGEST_MISMATCH',
        path: 'frontend.js',
      });
    }
  });

  it('refuses an extra file added after install (FILE_SET_MISMATCH)', async () => {
    const root = await tempDir();
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x"}');
    await snapshotInstalledDigests(packageRoot, 'author.tamper-test', '1.0.0', root);

    await writeFile(join(packageRoot, 'sneaky.js'), 'evil');
    const error = await verifyInstalledIntegrity(packageRoot, 'author.tamper-test', root).catch(
      (caught: unknown) => caught,
    );
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe('PLUGIN_SIGNATURE_INVALID');
      expect(error.params).toMatchObject({ reason: 'TAMPERED_AFTER_INSTALL:FILE_SET_MISMATCH' });
    }
  });

  it('refuses a package with no digest snapshot (fail-closed)', async () => {
    const root = await tempDir();
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x"}');
    const error = await verifyInstalledIntegrity(packageRoot, 'author.tamper-test', root).catch(
      (caught: unknown) => caught,
    );
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe('PLUGIN_SIGNATURE_INVALID');
      expect(error.params).toMatchObject({ reason: 'TAMPERED_AFTER_INSTALL:NO_DIGEST_SNAPSHOT' });
    }
  });

  it('creates a baseline snapshot for a pre-upgrade unsigned install, then catches tamper', async () => {
    const root = await tempDir();
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x"}');
    await writeFile(join(packageRoot, 'frontend.js'), 'export default {};');

    // No snapshot yet — ensureInstalledIntegrity verifies (unsigned passes)
    // and records the baseline.
    await ensureInstalledIntegrity(packageRoot, 'author.tamper-test', '1.0.0', root, []);
    await expect(
      verifyInstalledIntegrity(packageRoot, 'author.tamper-test', root),
    ).resolves.toBeUndefined();

    // Now a tamper after the baseline is caught on the next activation.
    await writeFile(join(packageRoot, 'frontend.js'), 'export default { hacked: true };');
    await expect(
      verifyInstalledIntegrity(packageRoot, 'author.tamper-test', root),
    ).rejects.toMatchObject({
      code: 'PLUGIN_SIGNATURE_INVALID',
      params: expect.objectContaining({ reason: 'TAMPERED_AFTER_INSTALL:DIGEST_MISMATCH' }),
    });
  });
});

describe('install recovery journal (ТЗ §SEC-05, v2)', () => {
  const fakeRepo = () => ({
    restoreEntry: vi.fn<(entry: unknown) => void>(),
    delete: vi.fn<(id: string) => boolean>(() => true),
  });

  it('rolls an interrupted UPDATE back to the previous version — files AND registry (never both deleted)', async () => {
    const root = await tempDir();
    const pluginsDir = join(root, 'plugins');
    const pluginRoot = join(pluginsDir, 'author.updated');
    const packageRoot = join(pluginRoot, 'package');
    const incomingPath = join(pluginRoot, '.incoming-1');
    const rollbackPath = join(pluginRoot, '.rollback-2');
    // Crash state: the old package was parked in .rollback-2, the new one was
    // half-promoted into package, the registry write may or may not have
    // happened — the journal carries the previous row either way.
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x","version":"2.0.0"}');
    await mkdir(rollbackPath, { recursive: true });
    await writeFile(join(rollbackPath, 'plugin.json'), '{"id":"x","version":"1.0.0"}');
    await mkdir(incomingPath, { recursive: true });
    await writeFile(join(incomingPath, 'plugin.json'), '{"id":"x","version":"2.0.0"}');
    const previous = {
      id: 'author.updated',
      name: 'Updated',
      version: '1.0.0',
      enabled: true,
      manifest: { id: 'author.updated' },
      requestedPermissions: [] as string[],
      grantedPermissions: [] as string[],
      installedAt: 1,
      updatedAt: 2,
      lastErrorCode: null,
      source: null,
      dependencies: null,
      trust: 'locally-trusted',
      publisherKeyId: null,
    };
    await writeInstallJournal(pluginRoot, {
      pluginId: 'author.updated',
      version: '2.0.0',
      previousVersion: '1.0.0',
      state: 'staging',
      paths: { package: packageRoot, incoming: incomingPath, rollback: rollbackPath },
      registry: { previous },
    });
    const repo = fakeRepo();

    await recoverInterruptedInstalls(pluginsDir, repo, logger);

    // The previous version is back on disk — recovery did NOT delete both.
    expect(await readFile(join(packageRoot, 'plugin.json'), 'utf8')).toBe(
      '{"id":"x","version":"1.0.0"}',
    );
    await expect(readFile(join(rollbackPath, 'plugin.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(incomingPath, 'plugin.json'), 'utf8')).rejects.toThrow();
    expect(repo.restoreEntry).toHaveBeenCalledWith(previous);
    expect(repo.delete).not.toHaveBeenCalled();
    await expect(readFile(join(pluginRoot, INSTALL_JOURNAL_FILE), 'utf8')).rejects.toThrow();
  });

  it('keeps the previous version when an UPDATE crashed before the old copy was parked — files AND registry row survive', async () => {
    const root = await tempDir();
    const pluginsDir = join(root, 'plugins');
    const pluginRoot = join(pluginsDir, 'author.between');
    const packageRoot = join(pluginRoot, 'package');
    const incomingPath = join(pluginRoot, '.incoming-4');
    const rollbackPath = join(pluginRoot, '.rollback-5');
    // Crash state: the NEW package was staged into .incoming-4 but the OLD
    // version was never parked (still at `package`) — the rollback path is
    // declared in the journal but absent on disk. Recovery must NOT classify
    // this as a fresh install (that would delete the previous version).
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x","version":"1.0.0"}');
    await mkdir(incomingPath, { recursive: true });
    await writeFile(join(incomingPath, 'plugin.json'), '{"id":"x","version":"2.0.0"}');
    const previous = {
      id: 'author.between',
      name: 'Between',
      version: '1.0.0',
      enabled: true,
      manifest: { id: 'author.between' },
      requestedPermissions: [] as string[],
      grantedPermissions: [] as string[],
      installedAt: 1,
      updatedAt: 2,
      lastErrorCode: null,
      source: null,
      dependencies: null,
      trust: 'locally-trusted',
      publisherKeyId: null,
    };
    await writeInstallJournal(pluginRoot, {
      pluginId: 'author.between',
      version: '2.0.0',
      previousVersion: '1.0.0',
      state: 'staging',
      paths: { package: packageRoot, incoming: incomingPath, rollback: rollbackPath },
      registry: { previous },
    });
    const repo = fakeRepo();

    await recoverInterruptedInstalls(pluginsDir, repo, logger);

    // The PREVIOUS version is still on disk, the registry row is restored,
    // and the half-promoted new package was dropped — both versions never
    // deleted.
    expect(await readFile(join(packageRoot, 'plugin.json'), 'utf8')).toBe(
      '{"id":"x","version":"1.0.0"}',
    );
    await expect(readFile(join(incomingPath, 'plugin.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(rollbackPath, 'plugin.json'), 'utf8')).rejects.toThrow();
    expect(repo.restoreEntry).toHaveBeenCalledWith(previous);
    expect(repo.delete).not.toHaveBeenCalled();
    await expect(readFile(join(pluginRoot, INSTALL_JOURNAL_FILE), 'utf8')).rejects.toThrow();
  });

  it('rolls an interrupted FRESH install back to "not installed" (row + half-promoted files)', async () => {
    const root = await tempDir();
    const pluginsDir = join(root, 'plugins');
    const pluginRoot = join(pluginsDir, 'author.fresh');
    const packageRoot = join(pluginRoot, 'package');
    const incomingPath = join(pluginRoot, '.incoming-3');
    // Crash after the registry write: the row exists and points at files that
    // must be removed.
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x","version":"1.0.0"}');
    await mkdir(incomingPath, { recursive: true });
    await writeFile(join(incomingPath, 'plugin.json'), '{"id":"x","version":"1.0.0"}');
    await writeInstallJournal(pluginRoot, {
      pluginId: 'author.fresh',
      version: '1.0.0',
      previousVersion: null,
      state: 'staging',
      paths: { package: packageRoot, incoming: incomingPath, rollback: null },
      registry: { previous: null },
    });
    const repo = fakeRepo();

    await recoverInterruptedInstalls(pluginsDir, repo, logger);

    await expect(readFile(join(packageRoot, 'plugin.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(incomingPath, 'plugin.json'), 'utf8')).rejects.toThrow();
    expect(repo.delete).toHaveBeenCalledWith('author.fresh');
    expect(repo.restoreEntry).not.toHaveBeenCalled();
    await expect(readFile(join(pluginRoot, INSTALL_JOURNAL_FILE), 'utf8')).rejects.toThrow();
  });

  it('leaves the previous install untouched when the crash hit before any mutation', async () => {
    const root = await tempDir();
    const pluginsDir = join(root, 'plugins');
    const pluginRoot = join(pluginsDir, 'author.early');
    const packageRoot = join(pluginRoot, 'package');
    // Only the journal exists: neither the incoming rename nor the rollback
    // move happened, so the old package is still the last-known-good state.
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x","version":"1.0.0"}');
    await writeInstallJournal(pluginRoot, {
      pluginId: 'author.early',
      version: '2.0.0',
      previousVersion: '1.0.0',
      state: 'staging',
      paths: {
        package: packageRoot,
        incoming: join(pluginRoot, '.incoming-4'),
        rollback: join(pluginRoot, '.rollback-5'),
      },
      registry: { previous: null },
    });
    const repo = fakeRepo();

    await recoverInterruptedInstalls(pluginsDir, repo, logger);

    expect(await readFile(join(packageRoot, 'plugin.json'), 'utf8')).toBe(
      '{"id":"x","version":"1.0.0"}',
    );
    expect(repo.restoreEntry).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
    await expect(readFile(join(pluginRoot, INSTALL_JOURNAL_FILE), 'utf8')).rejects.toThrow();
  });

  it('keeps a committed package and drops the journal marker', async () => {
    const root = await tempDir();
    const pluginRoot = join(root, 'plugins', 'author.finished');
    const packageRoot = join(pluginRoot, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x"}');
    await writeInstallJournal(pluginRoot, {
      pluginId: 'author.finished',
      version: '1.0.0',
      state: 'committed',
    });
    const repo = fakeRepo();

    await recoverInterruptedInstalls(join(root, 'plugins'), repo, logger);

    expect(await readFile(join(packageRoot, 'plugin.json'), 'utf8')).toBe('{"id":"x"}');
    expect(repo.delete).not.toHaveBeenCalled();
    await expect(readFile(join(pluginRoot, INSTALL_JOURNAL_FILE), 'utf8')).rejects.toThrow();
  });

  it('removes dir-level scratch leftovers and never deletes a journal-less rollback', async () => {
    const root = await tempDir();
    const pluginsDir = join(root, 'plugins');
    await mkdir(join(pluginsDir, 'author.ok', 'package'), { recursive: true });
    await writeFile(join(pluginsDir, 'author.ok', 'package', 'plugin.json'), '{"id":"x"}');
    // A stray rollback WITH a package present has no journal to prove intent —
    // deleting it could remove the only copy of the previous version.
    await mkdir(join(pluginsDir, 'author.ok', '.rollback-efgh'), { recursive: true });
    await writeFile(join(pluginsDir, 'author.ok', '.rollback-efgh', 'plugin.json'), '{"id":"x"}');
    await mkdir(join(pluginsDir, '.incoming-abcd'), { recursive: true });
    await mkdir(join(pluginsDir, '.remove-xyzw'), { recursive: true });
    const repo = fakeRepo();

    await recoverInterruptedInstalls(pluginsDir, repo, logger);

    await expect(
      readFile(join(pluginsDir, 'author.ok', 'package', 'plugin.json'), 'utf8'),
    ).resolves.toBe('{"id":"x"}');
    // The stray rollback is KEPT (restored semantics: never delete both).
    expect(
      await readFile(join(pluginsDir, 'author.ok', '.rollback-efgh', 'plugin.json'), 'utf8'),
    ).toBe('{"id":"x"}');
    await expect(
      readFile(join(pluginsDir, '.incoming-abcd', 'plugin.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(join(pluginsDir, '.remove-xyzw', 'plugin.json'), 'utf8'),
    ).rejects.toThrow();
    expect(repo.restoreEntry).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('restores a journal-less rollback to package when the package is missing', async () => {
    const root = await tempDir();
    const pluginsDir = join(root, 'plugins');
    const pluginRoot = join(pluginsDir, 'author.orphan');
    await mkdir(join(pluginRoot, '.rollback-99'), { recursive: true });
    await writeFile(join(pluginRoot, '.rollback-99', 'plugin.json'), '{"id":"x"}');
    const repo = fakeRepo();

    await recoverInterruptedInstalls(pluginsDir, repo, logger);

    expect(await readFile(join(pluginRoot, 'package', 'plugin.json'), 'utf8')).toBe('{"id":"x"}');
    await expect(
      readFile(join(pluginRoot, '.rollback-99', 'plugin.json'), 'utf8'),
    ).rejects.toThrow();
  });
});

describe('tamper-after-install refused at activation (ТЗ §SEC-05, end-to-end)', () => {
  it('snapshots digests at install and refuses a tampered package on activate', async () => {
    const { app, paths } = await createTestApp();
    const pluginId = 'author.tamper-e2e';

    const installed = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(
        await pluginPackage(pluginId, '1.0.0'),
        'plugin.stplugin',
        'application/zip',
      ),
    });
    expect(installed.statusCode, installed.payload).toBe(200);

    // The digest snapshot was written next to the installed package.
    const snapshotPath = join(paths.plugins, pluginId, 'installed-digests.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      format: string;
      digests: Record<string, string>;
    };
    expect(snapshot.format).toBe('neotavern.installed-digests.v1');
    expect(Object.keys(snapshot.digests).sort()).toEqual(['frontend.js', 'plugin.json']);

    // Tamper with a file after install.
    await writeFile(
      join(paths.plugins, pluginId, 'package', 'frontend.js'),
      'export default { hacked: true };',
    );

    const activate = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: [] },
    });
    expect(activate.statusCode, activate.payload).toBe(422);
    expect(activate.json()).toMatchObject({
      code: 'PLUGIN_SIGNATURE_INVALID',
      params: { pluginId, reason: 'TAMPERED_AFTER_INSTALL:DIGEST_MISMATCH', path: 'frontend.js' },
    });
  });
});
