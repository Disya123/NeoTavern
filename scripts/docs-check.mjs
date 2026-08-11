#!/usr/bin/env node
/**
 * docs:check — validates that mandatory documentation entry points exist and
 * that internal relative markdown links resolve to real files.
 *
 * Mandatory entry points are defined in AGENTS.md §28.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const requiredDocs = [
  'docs/README.md',
  'docs/architecture/README.md',
  'docs/api/README.md',
  'docs/plugin-sdk/README.md',
  'docs/theme-sdk/README.md',
  'docs/prompt-pipeline/README.md',
  'docs/data/README.md',
  'docs/desktop/README.md',
  'docs/migrations/README.md',
  'docs/adr/README.md',
  'CHANGELOG.md',
];

let failures = 0;

for (const rel of requiredDocs) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    console.error(`[docs:check] MISSING required doc: ${rel}`);
    failures += 1;
  }
}

// Collect all markdown files under docs/.
const mdFiles = [];
function collectMd(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) collectMd(abs);
    else if (name.endsWith('.md')) mdFiles.push(abs);
  }
}
collectMd(join(root, 'docs'));

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of mdFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1]?.trim();
    if (!target) continue;
    // Only check relative links (skip external, anchors, and absolute links).
    if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
    const clean = target.split('#')[0];
    if (!clean) continue;
    const resolved = resolve(dirname(file), clean);
    if (!existsSync(resolved)) {
      const rel = file.slice(root.length + 1);
      console.error(`[docs:check] BROKEN link in ${rel}: ${target}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`[docs:check] ${failures} problem(s) found.`);
  process.exit(1);
}
console.log('[docs:check] OK — all required docs present, no broken relative links.');
