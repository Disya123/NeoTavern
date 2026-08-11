import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ensureDataDirs, resolveDataPaths } from '../src/lib/paths.js';
import { storeAvatar } from '../src/lib/fileStore.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('content-addressed avatar storage', () => {
  it('preserves the original and regenerates a deterministic thumbnail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-files-'));
    temporaryDirectories.push(root);
    const paths = resolveDataPaths(root);
    ensureDataDirs(paths);
    const source = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: '#54726a',
      },
    })
      .png()
      .toBuffer();

    const first = await storeAvatar(source, paths, 128);
    const originalName = first.originalUrl.split('/').at(-1);
    const thumbnailName = first.thumbnailUrl.split('/').at(-1);
    expect(originalName).toBeTruthy();
    expect(thumbnailName).toBeTruthy();
    expect(await readFile(join(paths.avatars, originalName!))).toEqual(source);

    const thumbnailPath = join(paths.thumbnails, thumbnailName!);
    const metadata = await sharp(await readFile(thumbnailPath)).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(128);
    expect(metadata.height).toBe(128);

    await unlink(thumbnailPath);
    const regenerated = await storeAvatar(source, paths, 128);
    expect(regenerated).toEqual(first);
    expect((await sharp(await readFile(thumbnailPath)).metadata()).format).toBe('webp');
  });
});
