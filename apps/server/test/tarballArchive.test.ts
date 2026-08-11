import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { create } from 'tar';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@neotavern/shared';
import { extractTarGzArchive } from '../src/lib/tarballArchive.js';

/** Pack a set of in-memory files (relative names) into a gzip tarball. */
async function writeTarGz(
  path: string,
  entries: Array<{ name: string; content: string }>,
): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), 'neotavern-tar-src-'));
  const fileNames: string[] = [];
  try {
    for (const entry of entries) {
      const target = join(stage, ...entry.name.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, entry.content);
      fileNames.push(entry.name);
    }
    const pack = create({ cwd: stage, gzip: true, portable: true }, fileNames);
    await pipeline(pack, createWriteStream(path));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

describe('tar.gz package extraction', () => {
  it('extracts regular files and directories into the staging directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-tarball-'));
    const archive = join(root, 'repo.tar.gz');
    const destination = join(root, 'stage');
    await writeTarGz(archive, [
      { name: 'plugin.json', content: '{"id":"author.example"}' },
      { name: 'dist/index.js', content: 'export default {}' },
    ]);

    const result = await extractTarGzArchive(archive, destination);

    expect(result.entries).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(destination, 'plugin.json'), 'utf8')).toBe(
      '{"id":"author.example"}',
    );
    expect(await readFile(join(destination, 'dist/index.js'), 'utf8')).toBe('export default {}');
  });

  it('rejects archives that are not gzip-compressed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-tarball-nogz-'));
    const archive = join(root, 'plain.bin');
    await writeFile(archive, 'this is not gzip data');

    await expect(extractTarGzArchive(archive, join(root, 'stage'))).rejects.toThrow(
      'not gzip-compressed',
    );
  });

  it('enforces expanded file and total size limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-tarball-limits-'));
    const archive = join(root, 'large.tar.gz');
    await writeTarGz(archive, [{ name: 'large.txt', content: '1234567890' }]);

    await expect(
      extractTarGzArchive(archive, join(root, 'stage'), {
        maxArchiveBytes: 1_000_000,
        maxEntries: 10,
        maxEntryBytes: 5,
        maxExpandedBytes: 5,
      }),
    ).rejects.toThrow('expanded size limit');
  });

  it('rejects archives above the compressed size limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-tarball-archlimit-'));
    const archive = join(root, 'pkg.tar.gz');
    await writeTarGz(archive, [{ name: 'data.txt', content: 'data' }]);

    await expect(
      extractTarGzArchive(archive, join(root, 'stage'), {
        maxArchiveBytes: 1,
        maxEntries: 10,
        maxEntryBytes: 1_000,
        maxExpandedBytes: 1_000,
      }),
    ).rejects.toThrow('compressed size limit');
  });

  it('rejects symbolic link entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-tarball-symlink-'));
    const stage = await mkdtemp(join(tmpdir(), 'neotavern-tar-symlink-src-'));
    const archive = join(root, 'link.tar.gz');
    try {
      await writeFile(join(stage, 'target.txt'), 'target');
      try {
        await symlink('target.txt', join(stage, 'link.txt'));
      } catch {
        // Platforms that refuse symlink creation cannot exercise this path.
        return;
      }
      const pack = create({ cwd: stage, gzip: true, portable: true }, ['target.txt', 'link.txt']);
      await pipeline(pack, createWriteStream(archive));

      let error: unknown;
      try {
        await extractTarGzArchive(archive, join(root, 'stage'));
      } catch (caught) {
        error = caught;
      }
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) expect(error.params['reason']).toContain('unsupported');
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it('honors an AbortSignal before extraction starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-tarball-abort-'));
    const archive = join(root, 'pkg.tar.gz');
    await writeTarGz(archive, [{ name: 'data.txt', content: 'data' }]);
    const controller = new AbortController();
    controller.abort();

    let error: unknown;
    try {
      await extractTarGzArchive(archive, join(root, 'stage'), undefined, controller.signal);
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe('ABORTED');
  });
});
