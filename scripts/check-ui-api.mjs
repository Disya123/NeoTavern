#!/usr/bin/env node
/**
 * check-ui-api — legacy UI surface gate (ARC-02/ARC-03, ТЗ 10/10 rev2 §13.1).
 *
 * Scans production code in `apps/web/src` for direct legacy API usage:
 *   - kind "api-v2":   lines containing the literal `/api/v2`;
 *   - kind "legacyRaw": lines containing the `legacyRaw` identifier.
 *
 * Test/spec files are excluded. Files under `apps/web/src/plugins/**` are the
 * plugin sandbox / legacy-compat bridge (ADR-0039) and are classified
 * "plugin-compat" (still listed, no removal milestone — a long-lived public
 * adapter, ARC-09: stable adapters may live for years as long as they do not
 * violate architectural invariants). The facade transport shims under
 * `apps/web/src/api/{backend,client,events,generate,legacyExtensionSettings,
 * wireBridge}.ts` are classified "legacy-compat": they are the NeoBackend
 * facade's browser/legacy-sidecar transport (ADR-0038/0048), which stays
 * feature-frozen until the legacy server stops serving product data (Этап 6,
 * release-gate expiry) — the same boundary ADR-0048 draws. They carry full
 * removal records (milestone M7, deadline release gate), not n/a, because
 * they are a temporary shim with a deletion condition, unlike the long-lived
 * plugin-compat adapter. Everything else is "product" feature code (React
 * components, pages, hooks) that must migrate.
 *
 * Every non-plugin-compat site in the baseline carries a structured record:
 * `owner`, `removalIssue`, `milestone` and `deadline`. A site with an empty
 * record FAILS `--check`, so `--update` alone can never legitimize a new
 * legacy call: the operator must record who owns it and when it will be
 * removed. `PRODUCT_METADATA` / `LEGACY_COMPAT_META` below are the
 * generator-side registers for the currently allowed sites; a NEW site not
 * covered by them is emitted with empty metadata and the gate fails until
 * the record is filled in.
 *
 * Modes:
 *   (default)            print a summary.
 *   --update             (re)generate docs/architecture/ui-legacy-surface.md
 *                        (metadata is reused from the current baseline for
 *                        unchanged site fingerprints).
 *   --check              fail (exit 1) if any current hit is NOT in the
 *                        baseline (a NEW legacy call was introduced), if a
 *                        baseline site drifted, or if any product site lacks
 *                        its full owner/removalIssue/milestone/deadline
 *                        record; pass otherwise.
 *   --annotate           insert `// eslint-disable-next-line
 *                        @neotavern/no-legacy-api-surface` above each current
 *                        product hit (idempotent; skips test files,
 *                        plugins/**, and the legacy API client itself).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');
const BASELINE = join(ROOT, 'docs', 'architecture', 'ui-legacy-surface.md');
const LEDGER_PATH = join(ROOT, 'docs', 'architecture', 'acceptance-ledger.json');

const DISABLE_COMMENT = '// eslint-disable-next-line @neotavern/no-legacy-api-surface';

const OWNER = 'neotavern/desktop-web';
/** M4 exit target (product convergence removes the last legacy UI call). */
const M4 = { milestone: 'M4', deadline: '2026-12-31' };
/** M7 (ТЗ Этап 6) release-gate removal — legacy server stops serving product data. */
const M7 = { milestone: 'M7', deadline: 'release gate' };

/**
 * Generator-side removal register for the currently allowed PRODUCT sites,
 * keyed by file. `--update` fills the baseline from here; `--check` fails on
 * any product row with empty metadata, so a NEW site must get a record here
 * (or in the baseline row) before the gate passes.
 */
const PRODUCT_METADATA = {
  'apps/web/src/components/AutoConnectSync.tsx': {
    owner: OWNER,
    removalIssue: 'M4: remove sidecar auto-connect (sidecar retired at the stage-6 cleanup)',
    ...M4,
  },
  'apps/web/src/components/CharacterManagementPanel.tsx': {
    owner: OWNER,
    removalIssue: 'M4: avatar and character export via Product Wire ops',
    ...M4,
  },
  'apps/web/src/components/ChatManagementPanel.tsx': {
    owner: OWNER,
    removalIssue: 'M4: chat export via a Product Wire op',
    ...M4,
  },
  'apps/web/src/components/LegacyBridgeSync.tsx': {
    owner: OWNER,
    removalIssue: 'M4: remove the legacy bridge sync',
    ...M4,
  },
  'apps/web/src/components/ThemeSync.tsx': {
    owner: OWNER,
    removalIssue: 'M4: theme sync via a Product Wire op',
    ...M4,
  },
  'apps/web/src/pages/ChatPage.tsx': {
    owner: OWNER,
    removalIssue: 'M4: remove legacyRaw chat routes',
    ...M4,
  },
  'apps/web/src/pages/HomePage.tsx': {
    owner: OWNER,
    removalIssue: 'M4: background assets via a Product Wire op',
    ...M4,
  },
};

const PLUGIN_COMPAT_META = { owner: 'n/a', removalIssue: 'n/a', milestone: 'n/a', deadline: 'n/a' };

/**
 * Generator-side removal register for the facade legacy transport shims.
 * These files are the NeoBackend facade's browser/legacy-sidecar transport
 * (ADR-0038/0048): feature-frozen, they carry the Web Client and the
 * legacy-sidecar desktop default until the legacy server stops serving
 * product data (Этап 6, release-gate expiry). Class "legacy-compat" — full
 * removal records (M7/release gate), NOT n/a: they are a temporary shim with
 * a deletion condition (ARC-09), unlike the long-lived plugin-compat adapter.
 */
const LEGACY_COMPAT_META = {
  owner: OWNER,
  removalIssue:
    'M7: retire the facade legacy transport with the legacy server (ADR-0038/0048, stage-6 cleanup)',
  ...M7,
};

/**
 * Files the ESLint rule never flags:
 *  - the legacy API client shim (api/{client,backend,events,generate}.ts) and
 *    the plugin sandbox bridge (plugins/**) — legacy-compat plane, ADR-0039;
 *  - AutoConnectSync.tsx / LegacyBridgeSync.tsx / pages/ChatPage.tsx — their
 *    committed blobs are CRLF while gitattributes mandates LF (`*.ts text
 *    eol=lf`), so any edit renormalizes the whole file in the diff. They are
 *    exempt from the rule (no per-line disable comments) but REMAIN tracked
 *    here: the --check gate still fails on NEW /api/v2 / legacyRaw hits in
 *    them. This exemption is registered as ARC-09 exception
 *    `M1-crlf-blob-eslint-exemption` in docs/architecture/exceptions.json;
 *    re-exempt (remove) it once the CRLF blobs are renormalized.
 */
const RULE_EXEMPT = (rel) =>
  rel.startsWith('apps/web/src/plugins/') ||
  [
    'apps/web/src/api/client.ts',
    'apps/web/src/api/backend.ts',
    'apps/web/src/api/events.ts',
    'apps/web/src/api/generate.ts',
    'apps/web/src/components/AutoConnectSync.tsx',
    'apps/web/src/components/LegacyBridgeSync.tsx',
    'apps/web/src/pages/ChatPage.tsx',
  ].includes(rel);

function collectFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (['node_modules', 'dist', 'public', 'generated'].includes(name)) continue;
      collectFiles(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function detectHits(file) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const hits = [];
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    let kind = null;
    let detail = '';
    if (/\/api\/v2/.test(line)) {
      kind = 'api-v2';
      const m = line.match(/\/api\/v2([^\s'"`)]*)/);
      detail = m ? m[1] : '/api/v2';
    } else if (/legacyRaw/.test(line)) {
      kind = 'legacyRaw';
      const method = line.match(/\.(request|sseUrl)\(\s*'([^']+)'/);
      detail = method ? `${method[1]} ${method[2]}` : 'legacyRaw';
    }
    if (kind) {
      hits.push({
        file: rel,
        line: lineNo,
        kind,
        detail: detail || kind,
        cls: classify(rel),
      });
    }
  });
  return hits;
}

/**
 * Site classification:
 *  - "plugin-compat": apps/web/src/plugins/** — plugin sandbox / legacy-compat
 *    bridge (ADR-0039), long-lived public adapter, n/a records;
 *  - "legacy-compat": the facade transport shims (api/{backend,client,events,
 *    generate,legacyExtensionSettings,wireBridge}.ts) — browser/legacy-sidecar
 *    transport of the NeoBackend facade, feature-frozen until Этап 6
 *    (ADR-0038/0048), full M7/release-gate removal records;
 *  - "product": everything else (React feature code) that must migrate.
 */
function classify(rel) {
  if (rel.startsWith('apps/web/src/plugins/')) return 'plugin-compat';
  if (LEGACY_COMPAT_FILES.includes(rel)) return 'legacy-compat';
  return 'product';
}

const LEGACY_COMPAT_FILES = [
  'apps/web/src/api/backend.ts',
  'apps/web/src/api/client.ts',
  'apps/web/src/api/events.ts',
  'apps/web/src/api/generate.ts',
  'apps/web/src/api/legacyExtensionSettings.ts',
  'apps/web/src/api/wireBridge.ts',
];

function scanAll() {
  const files = collectFiles(WEB_SRC);
  const hits = [];
  for (const f of files) hits.push(...detectHits(f));
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return hits;
}

/**
 * Stable site fingerprint: the baseline matches ALLOWED SITES by
 * (file, line, kind, detail), never by a bare count. The `--check` gate fails
 * when a current hit is not an allowed site; it also fails when an allowed
 * site drifts in kind or detail at the same line (a changed call is a NEW
 * call, ARC-02/ARC-03).
 */
function siteKey(hit) {
  return `${hit.file}:${hit.line}:${hit.kind}:${hit.detail}`;
}

function baselineKeys(hits) {
  return new Set(hits.map(siteKey));
}

/** Parse every data row of the baseline: siteKey + class + removal record. */
function readBaselineRows() {
  const text = readFileSync(BASELINE, 'utf8');
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    // Robust against Prettier's padded/aligned table cells. Columns:
    // File | Line | Kind | Detail | Class | Owner | Removal issue |
    // Milestone | Deadline.
    const m = line.match(
      /^\|\s*(apps\/web\/src\/[^|]+?)\s*\|\s*(\d+)\s*\|\s*([a-zA-Z0-9-]+)\s*\|\s*([^|]*?)\s*\|\s*([a-z-]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/,
    );
    if (m) {
      rows.set(`${m[1].trim()}:${Number(m[2])}:${m[3]}:${m[4].trim()}`, {
        cls: m[5].trim(),
        owner: m[6].trim(),
        removalIssue: m[7].trim(),
        milestone: m[8].trim(),
        deadline: m[9].trim(),
      });
    }
  }
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

/**
 * Removal record for one hit: the generator register for known product files,
 * else the existing baseline row for the SAME fingerprint (hand-maintained
 * overrides survive `--update`), else empty for product sites (the gate fails
 * until a record is provided) and `n/a` for plugin-compat sites.
 */
function metadataFor(hit, existingRows) {
  if (hit.cls === 'plugin-compat') return PLUGIN_COMPAT_META;
  if (hit.cls === 'legacy-compat') return LEGACY_COMPAT_META;
  const registered = PRODUCT_METADATA[hit.file];
  if (registered) return registered;
  const existing = existingRows.get(siteKey(hit));
  if (existing && existing.cls === 'product') {
    return {
      owner: existing.owner,
      removalIssue: existing.removalIssue,
      milestone: existing.milestone,
      deadline: existing.deadline,
    };
  }
  return { owner: '', removalIssue: '', milestone: '', deadline: '' };
}

function renderBaseline(hits, existingRows) {
  const lines = [];
  lines.push('# Legacy UI surface — baseline inventory (ARC-02/ARC-03)');
  lines.push('');
  lines.push('> GENERATED by `node scripts/check-ui-api.mjs --update` — do not edit by hand.');
  lines.push(
    '> Direct `/api/v2` and `legacyRaw()` usage in production UI is forbidden for NEW code',
  );
  lines.push(
    '> (ESLint rule `@neotavern/no-legacy-api-surface`). Existing sites are listed here and',
  );
  lines.push(
    '> carry an `eslint-disable-next-line` comment until they are migrated to the Product',
  );
  lines.push('> Wire client (program milestones M2–M4). Every PRODUCT site carries a structured');
  lines.push('> record: `Owner`, `Removal issue`, `Milestone`, `Deadline`. `--check` FAILS on any');
  lines.push(
    '> product or legacy-compat row with an empty field, so `--update` alone cannot legitimize',
  );
  lines.push('> a new legacy call: the owner and the removal work item must be recorded first.');
  lines.push(
    '> `legacy-compat` = the facade transport shims (api/{backend,client,events,generate,',
  );
  lines.push(
    '> legacyExtensionSettings,wireBridge}.ts) — the browser/legacy-sidecar transport of the',
  );
  lines.push(
    '> NeoBackend facade, feature-frozen until Этап 6 (ADR-0038/0048) — full M7/release-gate',
  );
  lines.push('> removal records, not n/a. `plugin-compat`');
  lines.push('> entries are the plugin sandbox / legacy-compat bridge (ADR-0039) — a long-lived');
  lines.push('> public adapter — and carry `n/a`. Deadline = M4 product-convergence target.');
  lines.push('');
  const tableRows = hits.map((h) => {
    const meta = metadataFor(h, existingRows);
    return [
      h.file,
      String(h.line),
      h.kind,
      h.detail,
      h.cls,
      meta.owner,
      meta.removalIssue,
      meta.milestone,
      meta.deadline,
    ];
  });
  lines.push(
    renderTable(
      [
        'File',
        'Line',
        'Kind',
        'Detail',
        'Class',
        'Owner',
        'Removal issue',
        'Milestone',
        'Deadline',
      ],
      tableRows,
    ),
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Validate the committed baseline's removal records: every product and
 * legacy-compat row must carry owner, removalIssue, milestone and deadline
 * (legacy-compat is a temporary shim with a deletion condition, ARC-09);
 * plugin-compat rows must not be empty (n/a expected). Removal `milestone`
 * values must exist in the acceptance ledger (short token `M7` or full id).
 */
/** Short tokens (`M7`) plus full ledger ids currently recorded. */
function ledgerMilestoneTokens() {
  try {
    const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    const tokens = new Set();
    for (const milestone of ledger.milestones ?? []) {
      if (typeof milestone.id !== 'string' || milestone.id.length === 0) continue;
      tokens.add(milestone.id);
      const short = milestone.id.split('-')[0];
      if (short) tokens.add(short);
    }
    return tokens;
  } catch {
    return null;
  }
}

function validateMetadata(rows) {
  const problems = [];
  const tokens = ledgerMilestoneTokens();
  if (tokens === null) {
    problems.push(
      'acceptance ledger unreadable — cannot verify ui:api milestone identities against docs/architecture/acceptance-ledger.json',
    );
  }
  for (const [key, row] of rows) {
    const fields = ['owner', 'removalIssue', 'milestone', 'deadline'];
    const missing = fields.filter((f) => row[f] === '');
    if ((row.cls === 'product' || row.cls === 'legacy-compat') && missing.length > 0) {
      problems.push(
        `${key} [${row.cls}] missing ${missing.join(', ')} — record who owns the removal and when`,
      );
    } else if (row.cls === 'plugin-compat' && missing.length > 0) {
      problems.push(
        `${key} [plugin-compat] missing ${missing.join(', ')} — use n/a for the long-lived adapter`,
      );
    }
    if (
      tokens &&
      (row.cls === 'product' || row.cls === 'legacy-compat') &&
      row.milestone &&
      row.milestone !== 'n/a' &&
      !tokens.has(row.milestone)
    ) {
      problems.push(
        `${key} [${row.cls}] milestone '${row.milestone}' is not a ledger milestone id or prefix — ui:api must not name a stage the acceptance ledger does not record`,
      );
    }
  }
  return problems;
}

function annotate(hits) {
  const byFile = new Map();
  for (const h of hits) {
    if (h.cls !== 'product' || RULE_EXEMPT(h.file)) continue;
    if (!byFile.has(h.file)) byFile.set(h.file, new Set());
    byFile.get(h.file).add(h.line);
  }
  let inserted = 0;
  for (const [rel, lines] of byFile) {
    const abs = join(ROOT, rel);
    const raw = readFileSync(abs, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const text = raw.split(/\r?\n/);
    const target = [...lines].sort((a, b) => b - a); // insert bottom-up
    for (const lineNo of target) {
      const prev = text[lineNo - 2];
      if (prev !== undefined && prev.includes('no-legacy-api-surface')) continue;
      const hitLine = text[lineNo - 1] ?? '';
      const indent = /^(\s*)/.exec(hitLine)?.[1] ?? '';
      const content = hitLine.slice(indent.length);
      const inJsx =
        /^</.test(content) ||
        /=`[^`]*\/api\/v2/.test(content) ||
        /<[A-Za-z][^>]*$/.test(prev ?? '');
      if (content.startsWith('?')) {
        // Prettier's ternary layout: directive right after `?`, value on the
        // next line at indent+2. Rewrite both lines.
        text[lineNo - 1] = `${indent}? ${DISABLE_COMMENT}`;
        text.splice(lineNo, 0, `${indent}  ${content.replace(/^\?\s*/, '')}`);
      } else {
        const comment = inJsx
          ? `${indent}{/* eslint-disable-next-line @neotavern/no-legacy-api-surface */}`
          : `${indent}${DISABLE_COMMENT}`;
        text.splice(lineNo - 1, 0, comment);
      }
      inserted += 1;
    }
    writeFileSync(abs, text.join(eol), 'utf8');
  }
  return inserted;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--check')
    ? 'check'
    : args.includes('--update')
      ? 'update'
      : args.includes('--annotate')
        ? 'annotate'
        : 'summary';

  const hits = scanAll();
  const product = hits.filter((h) => h.cls === 'product').length;
  const legacyCompat = hits.filter((h) => h.cls === 'legacy-compat').length;
  const compat = hits.length - product - legacyCompat;

  if (mode === 'summary') {
    console.log(
      `[check-ui-api] ${hits.length} hit(s): ${product} product, ${legacyCompat} legacy-compat, ${compat} plugin-compat.`,
    );
    for (const h of hits) console.log(`  ${h.file}:${h.line} [${h.kind}/${h.cls}] ${h.detail}`);
    return;
  }

  if (mode === 'update') {
    const existing = (() => {
      try {
        return readBaselineRows();
      } catch {
        return new Map();
      }
    })();
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, renderBaseline(hits, existing), 'utf8');
    const unrecorded = hits.filter(
      (h) =>
        (h.cls === 'product' || h.cls === 'legacy-compat') &&
        !PRODUCT_METADATA[h.file] &&
        !LEGACY_COMPAT_FILES.includes(h.file) &&
        !existing.has(siteKey(h)),
    );
    if (unrecorded.length > 0) {
      console.warn(
        `[check-ui-api] WARNING — ${unrecorded.length} NEW product/legacy-compat site(s) have no removal record (owner/removalIssue/milestone/deadline); the --check gate will FAIL until one is filled in:`,
      );
      for (const h of unrecorded) console.warn(`  ${siteKey(h)}`);
    }
    console.log(`[check-ui-api] wrote ${BASELINE} (${hits.length} hits).`);
    return;
  }

  if (mode === 'annotate') {
    const inserted = annotate(hits);
    console.log(`[check-ui-api] inserted ${inserted} eslint-disable comment(s).`);
    return;
  }

  if (mode === 'check') {
    let baseline;
    let metadataProblems = [];
    try {
      const rows = readBaselineRows();
      baseline = new Set(rows.keys());
      metadataProblems = validateMetadata(rows);
    } catch {
      console.error(
        '[check-ui-api] FAIL — baseline docs/architecture/ui-legacy-surface.md missing; run `node scripts/check-ui-api.mjs --update`.',
      );
      process.exit(1);
    }
    const current = baselineKeys(hits);
    const added = [...current].filter((k) => !baseline.has(k));
    // Also fail when a baseline site changed shape (kind/detail) at the same
    // line, or when the baseline contains stale sites that no longer exist —
    // a drift means the allowed-site fingerprint set is out of date.
    const removed = [...baseline].filter((k) => !current.has(k));
    if (added.length > 0) {
      console.error(
        `[check-ui-api] FAIL — ${added.length} NEW legacy call(s) outside the ${baseline.size} allowed sites (ARC-02/ARC-03):`,
      );
      for (const k of added.sort()) console.error(`  ${k}`);
      console.error(
        '[check-ui-api] Migrate them to the Product Wire client, or add them to the baseline via `--update` AND record owner/removalIssue/milestone/deadline (the gate fails until a removal issue exists).',
      );
      process.exit(1);
    }
    if (removed.length > 0) {
      console.error(
        `[check-ui-api] FAIL — ${removed.length} baseline site(s) no longer match the scan (drift):`,
      );
      for (const k of removed.sort()) console.error(`  ${k}`);
      console.error(
        '[check-ui-api] Re-run `--update` only if the drift is an intentional migration (each removal must be justified by a milestone).',
      );
      process.exit(1);
    }
    if (metadataProblems.length > 0) {
      console.error(
        `[check-ui-api] FAIL — ${metadataProblems.length} baseline site(s) have an incomplete removal record:`,
      );
      for (const p of metadataProblems.sort()) console.error(`  ${p}`);
      console.error(
        '[check-ui-api] Fill Owner / Removal issue / Milestone / Deadline for product and legacy-compat sites (or n/a for plugin-compat) in the baseline, then commit.',
      );
      process.exit(1);
    }
    console.log(
      `[check-ui-api] OK — ${current.size} current hit(s) all match the ${baseline.size} allowed sites (per-site fingerprint, not a count); every product/legacy-compat record carries owner/removalIssue/milestone/deadline.`,
    );
  }
}

main();
