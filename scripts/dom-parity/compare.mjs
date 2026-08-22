#!/usr/bin/env node
/**
 * Compare Theme SDK slot skeletons (React DOM dump vs NeoCompositor/Blitz dump).
 *
 * Identity is `data-component` / `data-part` / `data-slot` / `data-role` /
 * `data-action` — never CSS module class names or React fiber paths.
 *
 *   node scripts/dom-parity/compare.mjs --native build/native-dom.json
 *   node scripts/dom-parity/compare.mjs --react build/react-dom.json --native build/native-dom.json
 *   node scripts/dom-parity/compare.mjs --catalog scripts/dom-parity/chat-slots.json --native build/native-dom.json
 *   node scripts/dom-parity/compare.mjs --react a.json --native b.json --fail-on-diff  # CI gate
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function slotIdentity({ component, part, slot, role, action }) {
  const bits = [];
  if (slot) bits.push(`slot:${slot}`);
  if (component) bits.push(`component:${component}`);
  if (part) bits.push(`part:${part}`);
  if (role) bits.push(`role:${role}`);
  if (action) bits.push(`action:${action}`);
  return bits.length === 0 ? 'unknown' : bits.join('+');
}

export function loadSkeleton(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  return {
    source: raw.source ?? 'unknown',
    viewport: raw.viewport ?? { width: 0, height: 0 },
    nodes: nodes.map((node) => ({
      ...node,
      identity: node.identity || slotIdentity(node),
    })),
  };
}

export function loadCatalog(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fieldsOf(entry) {
  return ['component', 'part', 'slot', 'role', 'action'].filter((key) => entry[key]);
}

export function nodeMatches(node, required) {
  for (const key of fieldsOf(required)) {
    if (node[key] !== required[key]) return false;
  }
  return fieldsOf(required).length > 0;
}

export function checkCatalog(skeleton, catalog) {
  const missing = [];
  const counts = {};
  for (const required of catalog.required ?? []) {
    const label = required.id || slotIdentity(required) || JSON.stringify(required);
    const found = skeleton.nodes.filter((node) => nodeMatches(node, required)).length;
    counts[label] = found;
    const min = required.min ?? 1;
    if (found < min) {
      missing.push({ required, found, min, label });
    }
  }
  return { missing, counts };
}

export function diffSkeletons(left, right) {
  const count = (skeleton) => {
    const map = new Map();
    for (const node of skeleton.nodes) {
      map.set(node.identity, (map.get(node.identity) ?? 0) + 1);
    }
    return map;
  };
  const a = count(left);
  const b = count(right);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const onlyLeft = [];
  const onlyRight = [];
  const countMismatch = [];
  for (const key of [...keys].sort()) {
    const leftCount = a.get(key) ?? 0;
    const rightCount = b.get(key) ?? 0;
    if (leftCount === 0) onlyRight.push({ identity: key, count: rightCount });
    else if (rightCount === 0) onlyLeft.push({ identity: key, count: leftCount });
    else if (leftCount !== rightCount) {
      countMismatch.push({ identity: key, left: leftCount, right: rightCount });
    }
  }
  return { onlyLeft, onlyRight, countMismatch };
}

/**
 * Chrome bands whose rendered HEIGHTS must match between React (oracle) and
 * native. These mirror `chrome_metrics()` in
 * crates/presentation-dioxus-shell/src/product_path.rs — the drift class that
 * historically produced an invisible composer and clipped bubbles.
 */
const CHROME_BAND_IDS = ['slot:chat.header', 'slot:chat.composer'];

/**
 * Compare rendered band heights for {@link CHROME_BAND_IDS}. Identities that
 * exist on one side only are already covered by structural diffs; a band with
 * a zero/missing rect is skipped here.
 */
export function bandHeightDiff(left, right, tolerancePx = 1) {
  const firstRect = (skeleton, identity) =>
    skeleton.nodes.find((node) => node.identity === identity)?.rect;
  const checked = [];
  const mismatches = [];
  for (const identity of CHROME_BAND_IDS) {
    const l = firstRect(left, identity);
    const r = firstRect(right, identity);
    const leftH = Math.round(l?.h ?? 0);
    const rightH = Math.round(r?.h ?? 0);
    if (!leftH || !rightH) continue;
    const diff = Math.abs(leftH - rightH);
    checked.push({ identity, reactH: leftH, nativeH: rightH });
    if (diff > tolerancePx) {
      mismatches.push({ identity, reactH: leftH, nativeH: rightH, diff });
    }
  }
  return { tolerancePx, checked, mismatches };
}

function parseArgs(argv) {
  const out = { json: false, rectTolerance: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--native') out.native = argv[++i];
    else if (arg === '--react') out.react = argv[++i];
    else if (arg === '--catalog') out.catalog = argv[++i];
    else if (arg === '--json') out.json = true;
    // CI gate: any identity present in only one skeleton, or with a different
    // count, fails the run. Requires --react.
    else if (arg === '--fail-on-diff') out.failOnDiff = true;
    // Max |Δh| (CSS px) for chrome band heights (chat.header / chat.composer).
    else if (arg === '--rect-tolerance') out.rectTolerance = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

/** Identity rows that make a strict (--fail-on-diff) run fail. */
export function strictFailures(report) {
  if (!report.vsReact) return [];
  return [
    ...report.vsReact.onlyLeft.map((row) => ({ ...row, kind: 'only-in-react' })),
    ...report.vsReact.onlyRight.map((row) => ({ ...row, kind: 'only-in-native' })),
    ...report.vsReact.countMismatch.map((row) => ({
      ...row,
      kind: 'count-mismatch',
    })),
    ...(report.bandHeights?.mismatches ?? []).map((row) => ({
      ...row,
      kind: 'band-height',
    })),
  ];
}

export function runCli(argv = process.argv.slice(2), log = console.log) {
  const write = typeof log === 'function' ? log : log.log.bind(log);
  const args = parseArgs(argv);
  if (args.help || !args.native) {
    write(`Usage:
  node scripts/dom-parity/compare.mjs --native <json> [--react <json>] [--catalog <json>] [--fail-on-diff] [--json]`);
    return args.native ? 0 : 2;
  }
  const native = loadSkeleton(resolve(args.native));
  const report = {
    nativeNodes: native.nodes.length,
    catalogMissing: [],
    vsReact: null,
  };
  if (args.catalog) {
    const catalog = loadCatalog(resolve(args.catalog));
    const checked = checkCatalog(native, catalog);
    report.catalogMissing = checked.missing;
    report.catalogCounts = checked.counts;
  }
  if (args.react) {
    const react = loadSkeleton(resolve(args.react));
    report.reactNodes = react.nodes.length;
    report.vsReact = diffSkeletons(react, native);
    report.bandHeights = bandHeightDiff(react, native, args.rectTolerance);
  }
  if (args.react || args.failOnDiff) {
    report.strictFailures = strictFailures(report);
  }
  if (args.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    write(
      `native ${native.source} ${native.nodes.length} nodes  viewport ${native.viewport.width}×${native.viewport.height}`,
    );
    if (report.catalogMissing?.length) {
      write(`catalog missing (${report.catalogMissing.length})`);
      for (const row of report.catalogMissing) {
        write(`  ${row.label} (have ${row.found}, need ${row.min})`);
      }
    } else if (args.catalog) {
      write('catalog: all required chat slots present');
    }
    if (report.vsReact) {
      write(`only in React (${report.vsReact.onlyLeft.length})`);
      for (const row of report.vsReact.onlyLeft.slice(0, 80)) {
        write(`  ${row.identity} ×${row.count}`);
      }
      write(`only in native (${report.vsReact.onlyRight.length})`);
      for (const row of report.vsReact.onlyRight.slice(0, 80)) {
        write(`  ${row.identity} ×${row.count}`);
      }
      const bands = report.bandHeights;
      if (bands) {
        for (const row of bands.checked) {
          write(`band ${row.identity}: react ${row.reactH}px / native ${row.nativeH}px`);
        }
        if (bands.mismatches.length > 0) {
          write(`band heights differ beyond ±${bands.tolerancePx}px (${bands.mismatches.length})`);
        }
      }
      if (args.failOnDiff) {
        const failures = report.strictFailures ?? [];
        if (failures.length > 0) {
          write(`strict parity FAILED (${failures.length} rows; React is the oracle)`);
          for (const row of failures.slice(0, 80)) {
            if (row.kind === 'count-mismatch') {
              write(`  count-mismatch ${row.identity}: react ×${row.left} native ×${row.right}`);
            } else if (row.kind === 'band-height') {
              write(
                `  band-height ${row.identity}: react ${row.reactH}px native ${row.nativeH}px (Δ${row.diff})`,
              );
            } else {
              write(`  ${row.kind} ${row.identity} ×${row.count}`);
            }
          }
        } else {
          write('strict parity: React and native skeletons match');
        }
      }
    }
  }
  let exit = report.catalogMissing.length > 0 ? 1 : 0;
  if (exit === 0 && args.failOnDiff && args.react && (report.strictFailures?.length ?? 0) > 0) {
    exit = 1;
  }
  return exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
