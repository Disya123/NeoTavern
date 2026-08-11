#!/usr/bin/env node
/**
 * clean — removes build artifacts (dist/, *.tsbuildinfo, Vite cache) without
 * touching user data in data/.
 */
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function removeArtifact(abs) {
  try {
    rmSync(abs, { recursive: true, force: true });
    console.log(`[clean] removed ${abs.slice(root.length + 1)}`);
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'EPERM') {
      console.warn(
        `[clean] could not remove ${abs.slice(root.length + 1)} (${error.code}) — ` +
          'stop the dev server / file watchers and re-run clean.',
      );
      return;
    }
    throw error;
  }
}

function cleanDir(dir) {
  if (!existsSync(dir)) return;
  // withFileTypes avoids following symlinks: a broken link would crash
  // statSync and a junction cycle (Windows) would recurse forever.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === 'node_modules' || name === 'data' || name === '.git') continue;
    if (entry.isSymbolicLink()) continue;
    const abs = join(dir, name);
    if (entry.isDirectory()) {
      if (name === 'dist' || name === '.vite' || name === '.turbo') {
        removeArtifact(abs);
      } else {
        cleanDir(abs);
      }
    } else if (entry.isFile() && name.endsWith('.tsbuildinfo')) {
      removeArtifact(abs);
    }
  }
}

cleanDir(join(root, 'apps'));
cleanDir(join(root, 'packages'));
for (const f of ['tsconfig.build.tsbuildinfo']) {
  const abs = join(root, f);
  if (existsSync(abs)) {
    rmSync(abs, { force: true });
    console.log(`[clean] removed ${f}`);
  }
}
console.log('[clean] done.');
