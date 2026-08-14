/**
 * Installed-package integrity and install-recovery tests (ТЗ §SEC-05):
 * digest snapshot + re-verify at activation (fail-closed on tamper after
 * install), the pre-upgrade baseline path, the interrupted-install recovery
 * journal, and the end-to-end route that refuses a tampered package.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

function pluginPackage(id: string, version: string, frontend = 'export default {};'): Promise<Buffer> {
  return zipArchive({
    'plugin.json': JSON.stringify({ id, name: id, version, apiVersion: 2, frontend: 'frontend.js' }),
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

describe('install recovery journal (ТЗ §SEC-05)', () => {
  it('removes a half-promoted package when the journal is not committed', async () => {
    const root = await tempDir();
    const pluginRoot = join(root, 'plugins', 'author.interrupted');
    const packageRoot = join(pluginRoot, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'plugin.json'), '{"id":"x"}');
    await writeInstallJournal(pluginRoot, {
      pluginId: 'author.interrupted',
      version: '2.0.0',
      state: 'staging',
    });

    await recoverInterruptedInstalls(join(root, 'plugins'), logger);

    await expect(readFile(join(packageRoot, 'plugin.json'), 'utf8')).rejects.toThrow();
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

    await recoverInterruptedInstalls(join(root, 'plugins'), logger);

    expect(await readFile(join(packageRoot, 'plugin.json'), 'utf8')).toBe('{"id":"x"}');
    await expect(readFile(join(pluginRoot, INSTALL_JOURNAL_FILE), 'utf8')).rejects.toThrow();
  });

  it('cleans scratch leftovers (.incoming-* / .rollback-*)', async () => {
    const root = await tempDir();
    const pluginsDir = join(root, 'plugins');
    await mkdir(join(pluginsDir, 'author.ok', 'package'), { recursive: true });
    await writeFile(join(pluginsDir, 'author.ok', 'package', 'plugin.json'), '{"id":"x"}');
    await mkdir(join(pluginsDir, '.incoming-abcd'), { recursive: true });
    await mkdir(join(pluginsDir, 'author.ok', '.rollback-efgh'), { recursive: true });

    await recoverInterruptedInstalls(pluginsDir, logger);

    await expect(readFile(join(pluginsDir, 'author.ok', 'package', 'plugin.json'), 'utf8')).resolves.toBe(
      '{"id":"x"}',
    );
    await expect(
      readFile(join(pluginsDir, '.incoming-abcd', 'plugin.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(join(pluginsDir, 'author.ok', '.rollback-efgh', 'plugin.json'), 'utf8'),
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
      ...multipartFile(await pluginPackage(pluginId, '1.0.0'), 'plugin.stplugin', 'application/zip'),
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
    await writeFile(join(paths.plugins, pluginId, 'package', 'frontend.js'), 'export default { hacked: true };');

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
