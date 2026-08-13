#!/usr/bin/env node
/**
 * capability-matrix — deterministic generator for the NeoTavern capability /
 * status / host matrix (ARC-10, ТЗ 10/10 rev2 §13.3).
 *
 * Inputs:
 *   - the built wire layer of `@neotavern/contracts`
 *     (`packages/contracts/dist/wire/index.js`), rebuilt first via
 *     `pnpm --filter @neotavern/contracts build` so the tool always consumes
 *     fresh output (mirrors tools/contract-codegen/codegen.mjs).
 *   - `docs/release-manifest.json` — hand-maintained capability → per-host
 *     status manifest. Allowed statuses (ТЗ §19.3): Designed, Implemented,
 *     Integrated, Packaged, Released, Deprecated — plus "Not supported" for
 *     explicitly unsupported capabilities (e.g. standalone browser runtime).
 *
 * Outputs:
 *   - docs/capability-matrix.json — machine-readable rows.
 *   - docs/capability-matrix.md   — Markdown table for docs/README and CI.
 *
 * `--check` regenerates both in memory and byte-compares against disk,
 * exiting 1 on any difference (CI gate) without writing anything.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const WIRE_INDEX = join(REPO_ROOT, 'packages', 'contracts', 'dist', 'wire', 'index.js');
const MANIFEST_PATH = join(REPO_ROOT, 'docs', 'release-manifest.json');
const OUT_JSON = join(REPO_ROOT, 'docs', 'capability-matrix.json');
const OUT_MD = join(REPO_ROOT, 'docs', 'capability-matrix.md');

const HOSTS = ['desktop', 'headless', 'android', 'webClient'];
const ALLOWED_STATUSES = new Set([
  'Designed',
  'Implemented',
  'Integrated',
  'Packaged',
  'Released',
  'Deprecated',
  'Not supported',
]);

/** Recursively sort object keys; throw on wire-unsafe values. */
function sortJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('capability-matrix: non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      out[key] = sortJson(item);
    }
    return out;
  }
  throw new Error(`capability-matrix: unsupported value ${typeof value}`);
}

/**
 * Deterministic JSON: key-sorted, 2-space indent, trailing newline, in the
 * same style as Prettier (short arrays of primitives collapse to one line so
 * `pnpm format:check` stays green on the generated file).
 */
function canonicalJson(value) {
  return `${prettyJson(sortJson(value), 0)}\n`;
}

function prettyJson(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const allPrimitive = value.every(
      (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item),
    );
    if (allPrimitive) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (pad.length + inline.length <= 80) return inline;
    }
    const items = value.map((item) => `${pad}  ${prettyJson(item, indent + 2)}`).join(',\n');
    return `[\n${items}\n${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return '{}';
    const items = keys
      .map((key) => `${pad}  ${JSON.stringify(key)}: ${prettyJson(value[key], indent + 2)}`)
      .join(',\n');
    return `{\n${items}\n${pad}}`;
  }
  return JSON.stringify(value);
}

function nowIso() {
  return new Date().toISOString();
}

async function loadRegistry() {
  // Rebuild the contracts package so the wire registry is always fresh
  // (same contract as tools/contract-codegen/codegen.mjs). CI's dedicated
  // `pnpm capability:matrix:check` performs the rebuild; docs:check sets
  // CAPABILITY_MATRIX_SKIP_BUILD=1 to keep it fast (contracts:check already
  // guarantees the built dist is fresh in CI).
  if (!process.env.CAPABILITY_MATRIX_SKIP_BUILD) {
    execSync('pnpm --filter @neotavern/contracts build', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      windowsHide: true,
    });
  }
  const mod = await import(pathToFileURL(WIRE_INDEX).href);
  if (typeof mod.buildProductWireRegistry !== 'function') {
    throw new Error('capability-matrix: buildProductWireRegistry not exported by wire layer');
  }
  const { operations } = mod.buildProductWireRegistry();
  return operations;
}

function readManifest() {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (raw.formatVersion !== 1 || !Array.isArray(raw.capabilities)) {
    throw new Error(
      'capability-matrix: docs/release-manifest.json must have formatVersion 1 and a capabilities array',
    );
  }
  return raw.capabilities;
}

function validate(capabilities, registryOps) {
  const opIds = new Set(registryOps.map((op) => op.operationId));
  const seen = new Set();
  const errors = [];
  const referenced = new Map(); // opId -> capability id
  for (const cap of capabilities) {
    if (!cap.id || seen.has(cap.id))
      errors.push(`duplicate or missing capability id: ${cap.id ?? '(none)'}`);
    seen.add(cap.id);
    if (!Array.isArray(cap.wireOps)) errors.push(`${cap.id}: wireOps must be an array`);
    for (const op of cap.wireOps ?? []) {
      if (!opIds.has(op)) errors.push(`${cap.id}: unknown wire op '${op}'`);
      const owner = referenced.get(op);
      if (owner !== undefined) {
        errors.push(
          `wire op '${op}' is referenced by BOTH '${owner}' and '${cap.id}' — every Product Wire operation must belong to exactly one capability (ARC-10)`,
        );
      } else {
        referenced.set(op, cap.id);
      }
    }
    for (const host of HOSTS) {
      const status = cap.hosts?.[host];
      if (status === undefined) errors.push(`${cap.id}: missing host '${host}'`);
      else if (!ALLOWED_STATUSES.has(status)) {
        errors.push(
          `${cap.id}: invalid status '${status}' for host '${host}' (allowed: ${[...ALLOWED_STATUSES].join(', ')})`,
        );
      }
    }
    const extraHosts = Object.keys(cap.hosts ?? {}).filter((h) => !HOSTS.includes(h));
    for (const h of extraHosts) errors.push(`${cap.id}: unknown host '${h}'`);
  }
  // Every Product Wire operation must be claimed by exactly one capability;
  // an unreferenced operation fails the generator (no silent auto-rows).
  for (const op of [...opIds].sort()) {
    if (!referenced.has(op)) {
      errors.push(
        `wire op '${op}' is not referenced by any capability in docs/release-manifest.json`,
      );
    }
  }
  if (errors.length) {
    throw new Error(
      `capability-matrix: ${errors.length} validation error(s):\n  - ${errors.join('\n  - ')}`,
    );
  }
}

function buildRows(capabilities) {
  const rows = capabilities.map((cap) => ({
    id: cap.id,
    title: cap.title ?? cap.id,
    wireOps: [...(cap.wireOps ?? [])].sort(),
    hosts: { ...cap.hosts },
    notes: cap.notes ?? '',
    milestone: cap.milestone ?? '',
  }));
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

/** Prettier-compatible markdown table (padded columns, aligned separators). */
function renderTable(headers, rows) {
  const widths = headers.map((_, j) =>
    Math.max(headers[j].length, ...rows.map((row) => row[j].length)),
  );
  const line = (cells) => `| ${cells.map((c, j) => c.padEnd(widths[j])).join(' | ')} |`;
  const sep = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

function renderMarkdown(rows) {
  const lines = [];
  lines.push('# Capability matrix');
  lines.push('');
  lines.push('> GENERATED by `tools/capability-matrix/generate.mjs` — do not edit by hand.');
  lines.push(
    '> Statuses (ТЗ 10/10 rev2 §19.3): **Designed** — decision described; **Implemented** — code exists with component tests; **Integrated** — used by a real application flow; **Packaged** — present in the shipped artifact; **Released** — available to users and covered by release acceptance; **Deprecated** — has a migration/removal policy; **Not supported** — explicitly unsupported (e.g. standalone browser runtime, ARC-12).',
  );
  lines.push('> A capability is NOT ready on the strength of `Implemented` alone (ARC-10).');
  lines.push('');
  const tableRows = rows.map((row) => {
    const ops = row.wireOps.length ? row.wireOps.join(', ') : '—';
    return [
      `\`${row.id}\``,
      ops,
      row.hosts.desktop,
      row.hosts.headless,
      row.hosts.android,
      row.hosts.webClient,
      row.milestone || '—',
      row.notes,
    ].map((c) => c.replaceAll('|', '\\|').replaceAll('\n', ' '));
  });
  lines.push(
    renderTable(
      [
        'Capability',
        'Wire ops',
        'Desktop',
        'Headless',
        'Android',
        'Web Client',
        'Milestone',
        'Notes',
      ],
      tableRows,
    ),
  );
  return `${lines.join('\n')}\n`;
}

function renderJson(rows, generatedAt) {
  return canonicalJson({ formatVersion: 1, generatedAt, rows });
}

async function main() {
  const check = process.argv.includes('--check');
  const operations = await loadRegistry();
  const capabilities = readManifest();
  validate(capabilities, operations);
  const rows = buildRows(capabilities);
  // In check mode reuse the committed generatedAt so a time-stamp change alone
  // never fails the gate.
  let generatedAt = nowIso();
  if (check) {
    try {
      const existing = JSON.parse(readFileSync(OUT_JSON, 'utf8'));
      if (typeof existing.generatedAt === 'string') generatedAt = existing.generatedAt;
    } catch {
      // missing/corrupt file → compare with a fresh stamp (will fail loudly).
    }
  }
  const md = renderMarkdown(rows);
  const json = renderJson(rows, generatedAt);

  if (check) {
    let failures = 0;
    for (const [path, content] of [
      [OUT_JSON, json],
      [OUT_MD, md],
    ]) {
      let existing;
      try {
        existing = readFileSync(path, 'utf8');
      } catch {
        existing = null;
      }
      if (existing !== content) {
        console.error(`[capability-matrix] DIFF ${path}`);
        failures += 1;
      } else {
        console.log(`[capability-matrix] OK ${path}`);
      }
    }
    if (failures > 0) {
      console.error(
        `[capability-matrix] FAIL — ${failures} generated file(s) differ; run 'node tools/capability-matrix/generate.mjs' and commit the output.`,
      );
      process.exit(1);
    }
    console.log(`[capability-matrix] OK — ${rows.length} rows, matrix is up to date.`);
    return;
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, json, 'utf8');
  writeFileSync(OUT_MD, md, 'utf8');
  console.log(`[capability-matrix] wrote ${OUT_JSON}`);
  console.log(`[capability-matrix] wrote ${OUT_MD}`);
  console.log(`[capability-matrix] ${rows.length} rows`);
}

main().catch((err) => {
  console.error(`[capability-matrix] ${err.message}`);
  process.exit(1);
});
