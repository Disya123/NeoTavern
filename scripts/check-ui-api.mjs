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
 * "plugin-compat" (still listed, no removal milestone). Everything else is
 * "product" code that must migrate.
 *
 * Modes:
 *   (default)            print a summary.
 *   --update             (re)generate docs/architecture/ui-legacy-surface.md.
 *   --check              fail (exit 1) if any current hit is NOT in the
 *                        baseline (a NEW legacy call was introduced); pass if
 *                        the current hits are a subset of the baseline.
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

const DISABLE_COMMENT = '// eslint-disable-next-line @neotavern/no-legacy-api-surface';

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
        cls: rel.startsWith('apps/web/src/plugins/') ? 'plugin-compat' : 'product',
      });
    }
  });
  return hits;
}

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

function readBaselineKeys() {
  const text = readFileSync(BASELINE, 'utf8');
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    // Robust against Prettier's padded/aligned table cells.
    const m = line.match(
      /^\|\s*(apps\/web\/src\/[^|]+?)\s*\|\s*(\d+)\s*\|\s*([a-zA-Z0-9-]+)\s*\|\s*([^|]*?)\s*\|/,
    );
    if (m) keys.add(`${m[1].trim()}:${Number(m[2])}:${m[3]}:${m[4].trim()}`);
  }
  return keys;
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

function renderBaseline(hits) {
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
  lines.push('> Wire client (program milestones M2–M4). `plugin-compat` entries are the plugin');
  lines.push('> sandbox / legacy-compat bridge (ADR-0039) and have no removal milestone.');
  lines.push('');
  const tableRows = hits.map((h) => {
    const removal = h.cls === 'plugin-compat' ? 'n/a (plugin-compat, ADR-0039)' : '';
    return [h.file, String(h.line), h.kind, h.detail, h.cls, removal];
  });
  lines.push(renderTable(['File', 'Line', 'Kind', 'Detail', 'Class', 'Removal issue'], tableRows));
  return `${lines.join('\n')}\n`;
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
  const compat = hits.length - product;

  if (mode === 'summary') {
    console.log(
      `[check-ui-api] ${hits.length} hit(s): ${product} product, ${compat} plugin-compat.`,
    );
    for (const h of hits) console.log(`  ${h.file}:${h.line} [${h.kind}/${h.cls}] ${h.detail}`);
    return;
  }

  if (mode === 'update') {
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, renderBaseline(hits), 'utf8');
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
    try {
      baseline = readBaselineKeys();
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
        '[check-ui-api] Migrate them to the Product Wire client, or (temporarily) add them to the baseline via `--update` with a removal issue.',
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
    console.log(
      `[check-ui-api] OK — ${current.size} current hit(s) all match the ${baseline.size} allowed sites (per-site fingerprint, not a count).`,
    );
  }
}

main();
