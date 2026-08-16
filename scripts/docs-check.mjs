#!/usr/bin/env node
/**
 * docs:check — validates that mandatory documentation entry points exist,
 * that internal relative markdown links resolve to real files, that the
 * capability matrix is up to date (ARC-10), that no architectural exception
 * has expired (ARC-09), and that no doc makes a misleading standalone/offline
 * Web Client claim (ARC-12).
 *
 * Mandatory entry points are defined in AGENTS.md §28.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
  'docs/capability-matrix.md',
  'docs/release-manifest.json',
  'docs/architecture/exceptions.json',
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

// Capability matrix freshness (ARC-10). The dedicated CI job
// (`pnpm capability:matrix:check`) rebuilds contracts; here we skip the
// rebuild so docs:check stays fast — contracts:check already guarantees a
// fresh dist in CI.
try {
  execFileSync(process.execPath, [join(root, 'tools/capability-matrix/generate.mjs'), '--check'], {
    stdio: 'inherit',
    env: { ...process.env, CAPABILITY_MATRIX_SKIP_BUILD: '1' },
  });
} catch {
  failures += 1;
}

// Product Wire ↔ Kernel dispatch parity (ARC-01/ARC-07): every registered
// operation must have a kernel dispatch arm, and every arm must be a
// registered operation.
try {
  execFileSync(process.execPath, [join(root, 'scripts/check-kernel-dispatch.mjs')], {
    stdio: 'inherit',
  });
} catch {
  failures += 1;
}

// Architectural exception expiry (ARC-09).
try {
  const exceptions = JSON.parse(
    readFileSync(join(root, 'docs/architecture/exceptions.json'), 'utf8'),
  );
  if (exceptions.formatVersion !== 1) {
    console.error('[docs:check] exceptions.json: formatVersion must be 1');
    failures += 1;
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const ex of exceptions.exceptions ?? []) {
    if (typeof ex.deadline === 'string' && ex.deadline < today) {
      console.error(
        `[docs:check] EXPIRED exception ${ex.id ?? '(no id)'} (deadline ${ex.deadline} < ${today}). Renew or close it.`,
      );
      failures += 1;
    }
  }
} catch (err) {
  console.error(`[docs:check] exceptions.json unreadable: ${err.message}`);
  failures += 1;
}

// Misleading standalone/offline Web Client claims (ARC-12). CHANGELOG.md is a
// historical record and is exempt; the generated matrix documents "Not
// supported" explicitly and is exempt.
const claimPattern =
  /\bstandalone PWA\b|\boffline PWA\b|\bPWA[^\n]*\b(?:offline|standalone)\b|\bworks fully offline\b|\bworks offline\b|\bno connection required\b/gi;
for (const file of mdFiles) {
  const rel = file.slice(root.length + 1);
  if (rel === 'CHANGELOG.md' || rel === 'docs/capability-matrix.md') continue;
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(claimPattern)) {
    console.error(
      `[docs:check] MISLEADING Web Client claim in ${rel}: "${match[0].trim()}" (ARC-12: remote-only, no standalone offline runtime)`,
    );
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`[docs:check] ${failures} problem(s) found.`);
  process.exit(1);
}
console.log(
  '[docs:check] OK — required docs present, links resolve, matrix fresh, no expired exceptions, no misleading claims.',
);
