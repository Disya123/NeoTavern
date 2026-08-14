/**
 * docs-sync gate tests (single source tree, ТЗ 10/10 rev2 §19.1).
 *
 * The mirror is a closed tree: a page smuggled into
 * `apps/docs/docs/architecture/` must fail `--check` even though it is
 * absent from the committed manifest, and a plain sync must delete stale
 * generated files. Both scenarios run against a throwaway temp tree.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMirror, checkMirror, collectMarkdown, manifest, writeMirror } from './docs-sync.mjs';

let tempRoot;
let sourceRoot;
let targetRoot;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'neota-docs-sync-test-'));
  sourceRoot = join(tempRoot, 'docs');
  targetRoot = join(tempRoot, 'apps', 'docs', 'docs', 'architecture');
  await mkdir(join(sourceRoot, 'sub'), { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await writeFile(
    join(sourceRoot, 'README.md'),
    '# Root index\n\nSee [ADR](../adr/0001-x.md).\n',
    'utf8',
  );
  await writeFile(join(sourceRoot, 'sub', 'page.md'), '## Sub page\n', 'utf8');
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('docs-sync closed-tree mirror', () => {
  it('collectMarkdown walks the canonical tree deterministically', async () => {
    const files = await collectMarkdown(sourceRoot);
    expect(files).toEqual(['README.md', 'sub/page.md']);
  });

  it('writeMirror produces entries, manifest and no extra files', async () => {
    const entries = await buildMirror(sourceRoot);
    await writeMirror(entries, targetRoot);
    // Mirror pages keep the same relative layout; the two support files
    // (_category_.json, .sync-manifest.json) are the only non-md files.
    expect(await collectMarkdown(targetRoot)).toEqual(['README.md', 'sub/page.md']);
    const all = (await readdir(targetRoot, { recursive: true })).map((f) =>
      String(f).split('\\').join('/'),
    );
    expect(all.sort()).toEqual([
      '.sync-manifest.json',
      'README.md',
      '_category_.json',
      'sub',
      'sub/page.md',
    ]);
    expect(
      JSON.parse(await readFile(join(targetRoot, '.sync-manifest.json'), 'utf8')),
    ).toMatchObject({
      formatVersion: 1,
      source: 'docs',
    });
  });

  it('a plain sync deletes stale generated files (rogue page removed)', async () => {
    const entries = await buildMirror(sourceRoot);
    await writeMirror(entries, targetRoot);
    const rogue = join(targetRoot, '__review_rogue_page.md');
    await writeFile(rogue, '# Rogue\n', 'utf8');
    expect(await checkMirror(entries, targetRoot)).toContain(
      '__review_rogue_page.md (not produced by a fresh sync — delete it or move it to docs/)',
    );
    await writeMirror(entries, targetRoot);
    await expect(readFile(rogue, 'utf8')).rejects.toThrow();
  });

  it('--check equivalent fails on a rogue page not present in the manifest', async () => {
    const entries = await buildMirror(sourceRoot);
    await writeMirror(entries, targetRoot);
    // The manifest is untouched; only the directory gains an extra file.
    await writeFile(join(targetRoot, '__review_rogue_page.md'), '# Rogue\n', 'utf8');
    const diffs = await checkMirror(entries, targetRoot);
    expect(diffs.some((d) => d.includes('__review_rogue_page.md'))).toBe(true);
  });

  it('is byte-deterministic across two syncs (no timestamp noise)', async () => {
    const entries = await buildMirror(sourceRoot);
    await writeMirror(entries, targetRoot);
    const first = await readFile(join(targetRoot, '.sync-manifest.json'), 'utf8');
    await writeMirror(entries, targetRoot);
    const second = await readFile(join(targetRoot, '.sync-manifest.json'), 'utf8');
    expect(first).toBe(second);
    expect(manifest(entries)).toBe(first);
  });

  it('reports changed or missing committed files', async () => {
    const entries = await buildMirror(sourceRoot);
    await writeMirror(entries, targetRoot);
    await writeFile(join(sourceRoot, 'README.md'), '# CHANGED\n', 'utf8');
    const diffs = await checkMirror(await buildMirror(sourceRoot), targetRoot);
    expect(diffs).toContain('README.md');
    await rm(join(targetRoot, 'sub', 'page.md'));
    const diffs2 = await checkMirror(await buildMirror(sourceRoot), targetRoot);
    expect(diffs2).toContain('sub/page.md');
  });

  it('passes on a clean mirror', async () => {
    const entries = await buildMirror(sourceRoot);
    await writeMirror(entries, targetRoot);
    expect(await checkMirror(entries, targetRoot)).toEqual([]);
  });
});
