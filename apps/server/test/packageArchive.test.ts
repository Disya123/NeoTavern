import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { isAppError } from '@neotavern/shared';
import { extractPackageArchive, validatePackageEntryPath } from '../src/lib/packageArchive.js';

async function writeZip(
  path: string,
  entries: Array<{ name: string; content: string }>,
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.content), entry.name);
  zip.end();
  const output = createWriteStream(path);
  zip.outputStream.pipe(output);
  await finished(output);
}

describe('package archive extraction', () => {
  it('extracts regular files into the staging directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-package-'));
    const archive = join(root, 'plugin.zip');
    const destination = join(root, 'stage');
    await writeZip(archive, [
      { name: 'plugin.json', content: '{"id":"author.example"}' },
      { name: 'dist/index.js', content: 'export default {}' },
    ]);

    const result = await extractPackageArchive(archive, destination);

    expect(result.entries).toBe(2);
    expect(await readFile(join(destination, 'dist/index.js'), 'utf8')).toBe('export default {}');
  });

  it('rejects traversal, absolute and backslash paths', () => {
    for (const path of ['../outside', 'dir/../../outside', '/absolute', 'C:/drive', 'a\\b']) {
      expect(() => validatePackageEntryPath(path), path).toThrow();
    }
  });

  it('enforces expanded file and entry limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-package-limits-'));
    const archive = join(root, 'large.zip');
    await writeZip(archive, [{ name: 'large.txt', content: '1234567890' }]);

    await expect(
      extractPackageArchive(archive, join(root, 'stage'), {
        maxArchiveBytes: 1_000,
        maxEntries: 1,
        maxEntryBytes: 5,
        maxExpandedBytes: 5,
      }),
    ).rejects.toThrow('expanded size limit');
  });

  it('honors an AbortSignal before extraction starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-package-abort-'));
    const archive = join(root, 'package.zip');
    await writeZip(archive, [{ name: 'data.txt', content: 'data' }]);
    const controller = new AbortController();
    controller.abort();

    let error: unknown;
    try {
      await extractPackageArchive(archive, join(root, 'stage'), undefined, controller.signal);
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe('ABORTED');
  });
});
