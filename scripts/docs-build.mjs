#!/usr/bin/env node
/**
 * docs:build — produces a lightweight machine-readable index of the docs tree.
 *
 * NeoTavern keeps documentation as plain markdown (no heavy doc framework).
 * This command validates the docs (reusing docs:check) and emits
 * `docs/.build/index.json` describing every page and its top-level heading so
 * other tools (search, desktop help viewer) can consume it.
 */
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Run docs:check first (same process, via a child node invocation).
try {
  execFileSync(process.execPath, [join(root, 'scripts/docs-check.mjs')], { stdio: 'inherit' });
} catch {
  console.error('[docs:build] docs:check failed — aborting build.');
  process.exit(1);
}

const pages = [];
function collectMd(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === '.build') continue;
      collectMd(abs);
    } else if (name.endsWith('.md')) {
      const text = readFileSync(abs, 'utf8');
      const firstHeading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name;
      pages.push({
        path: relative(root, abs).replace(/\\/g, '/'),
        title: firstHeading,
      });
    }
  }
}
collectMd(join(root, 'docs'));

pages.sort((a, b) => a.path.localeCompare(b.path));

const outDir = join(root, 'docs/.build');
mkdirSync(outDir, { recursive: true });
const index = {
  generatedBy: 'scripts/docs-build.mjs',
  pageCount: pages.length,
  pages,
};
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log(`[docs:build] OK — indexed ${pages.length} page(s) → docs/.build/index.json`);
