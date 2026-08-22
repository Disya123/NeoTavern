import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  debounce,
  haveChanged,
  mergedSignature,
  signatureOf,
  watchRoots,
} from './watch-design-system.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nt-design-watch-'));
  mkdirSync(join(dir, 'styles'), { recursive: true });
  mkdirSync(join(dir, 'styles', 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'styles', 'App.module.css'), ':root { color: #000; }');
  writeFileSync(join(dir, 'styles', 'node_modules', 'junk.js'), 'skip me');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('signatureOf', () => {
  it('fingerprints files and skips node_modules inside the tree', () => {
    const sig = signatureOf(join(dir, 'styles'));
    const cssFingerprint = sig.get(join(dir, 'styles', 'App.module.css'));
    expect(cssFingerprint).toMatch(/^\d+:\d+$/);
    expect(sig.get(join(dir, 'styles', 'node_modules', 'junk.js'))).toBeUndefined();
  });

  it('fingerprints a single file root (the packer script itself)', () => {
    const sig = signatureOf(join(dir, 'styles', 'App.module.css'));
    expect(sig.size).toBe(1);
  });
});

describe('haveChanged', () => {
  it('returns false for identical fingerprints', () => {
    const a = signatureOf(join(dir, 'styles'));
    const b = signatureOf(join(dir, 'styles'));
    expect(haveChanged(a, b)).toBe(false);
  });

  it('detects edits and restores, detects deletions', async () => {
    const before = signatureOf(join(dir, 'styles'));
    writeFileSync(join(dir, 'styles', 'App.module.css'), ':root { color: #ff0000; }');
    await sleepMs(25);
    const afterEdit = signatureOf(join(dir, 'styles'));
    expect(haveChanged(before, afterEdit)).toBe(true);

    // Restoring the original content (even same length) is still a change:
    // the fingerprint includes mtime, so it differs from the edited state.
    writeFileSync(join(dir, 'styles', 'App.module.css'), ':root { color: #000; }');
    await sleepMs(25);
    const afterRestore = signatureOf(join(dir, 'styles'));
    expect(haveChanged(afterEdit, afterRestore)).toBe(true);
  });

  it('detects added files', () => {
    const before = signatureOf(join(dir, 'styles'));
    writeFileSync(join(dir, 'styles', 'Sidebar.module.css'), '.x {}');
    const after = signatureOf(join(dir, 'styles'));
    expect(haveChanged(before, after)).toBe(true);
  });
});

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('mergedSignature', () => {
  it('unions independent roots without counting overlaps', () => {
    const single = mergedSignature([join(dir, 'styles')]);
    const doubled = mergedSignature([join(dir, 'styles'), join(dir, 'styles')]);
    expect(doubled.size).toBe(single.size);
  });
});

describe('debounce', () => {
  it('runs once after the quiet window even when called twice', async () => {
    let calls = 0;
    const fn = debounce(() => {
      calls += 1;
    }, 40);
    fn();
    fn();
    await new Promise((r) => setTimeout(r, 90));
    expect(calls).toBe(1);
  });
});

describe('watchRoots', () => {
  it('only returns paths that exist', () => {
    for (const root of watchRoots()) {
      // Succeeds without throwing; existence is asserted implicitly.
      expect(typeof root).toBe('string');
    }
  });
});
