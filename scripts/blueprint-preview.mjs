#!/usr/bin/env node
/**
 * Blueprint preview (M4 wave 2): renders one authored chat document through
 * the native desktop host and emits a single self-contained HTML report —
 * screenshot plus an interactive overlay of every Theme SDK hook from the
 * DOM dump. This is the stand-in for browser DevTools while the native UI is
 * driven by documents.
 *
 * Usage:
 *   pnpm blueprint-preview <document.json> [options]
 *
 * Options:
 *   --out <file.html>   report path (default: <document>.preview.html)
 *   --w / --h           viewport size (default 1100x760)
 *   --messages <n>      seeded wire messages (default 12)
 *   --build             build the desktop host first when it is missing
 *                       (otherwise a missing binary is an error)
 * Environment:
 *   NEOTA_DESKTOP_BIN   explicit host binary path
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const validatorScript = resolve(
  repositoryRoot,
  'packages',
  'contracts',
  'tools',
  'validate-document.mjs',
);

function desktopBin() {
  const override = process.env.NEOTA_DESKTOP_BIN;
  if (override) {
    return resolve(override);
  }
  const exe = process.platform === 'win32' ? 'neocompositor-desktop.exe' : 'neocompositor-desktop';
  return resolve(repositoryRoot, 'crates', 'target', 'release', exe);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

/** Escapes text for safe interpolation into the generated HTML/JS. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Spawns the host and waits until every expected artifact exists and has
 * stopped growing (the host keeps its event loop alive after producing).
 */
function runHost(args, expectFiles) {
  const child = spawn(desktopBin(), args, { stdio: 'ignore' });
  const startedAt = expectFiles.map((file) =>
    existsSync(file) ? statSync(file).mtimeMs : Number.NEGATIVE_INFINITY,
  );
  try {
    const deadline = Date.now() + 120_000;
    const stable = expectFiles.map(() => -1);
    outer: while (Date.now() < deadline) {
      for (let i = 0; i < expectFiles.length; i += 1) {
        const file = expectFiles[i];
        if (!existsSync(file)) {
          continue outer;
        }
        const stats = statSync(file);
        if (stats.mtimeMs <= startedAt[i] || stats.size === 0 || stats.size !== stable[i]) {
          stable[i] = stats.size;
          continue outer;
        }
      }
      break;
    }
    // Give the host a beat to finish writing both artifacts after the last
    // observed change.
    sleepSync(400);
  } finally {
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    }
  }
}

const NODE_FIELDS = ['tag', 'component', 'part', 'slot', 'role', 'action', 'state', 'key'];

function nodeLabel(node) {
  return NODE_FIELDS.filter((field) => node[field])
    .map((field) => `${field}:${node[field]}`)
    .join(' ');
}

function nodeDetails(node) {
  return NODE_FIELDS.map((field) => `${field}: ${node[field] ?? '—'}`)
    .concat([
      `path: ${node.path ?? ''}`,
      `rect: ${Math.round(node.rect?.x ?? 0)},${Math.round(node.rect?.y ?? 0)} ${Math.round(node.rect?.w ?? 0)}×${Math.round(node.rect?.h ?? 0)}`,
    ])
    .join('\n');
}

/** Builds the self-contained report. Pure function — unit-tested. */
export function buildPreviewHtml({ documentPath, width, height, pngBase64, nodes }) {
  const overlays = nodes
    .map((node, index) => {
      const rect = node.rect ?? {};
      return `<rect data-idx="${index}" x="${Number(rect.x ?? 0)}" y="${Number(rect.y ?? 0)}" width="${Number(rect.w ?? 0)}" height="${Number(rect.h ?? 0)}" fill="transparent" stroke="hsl(${(index * 47) % 360} 70% 55%)" stroke-width="1"/>`;
    })
    .join('\n      ');
  const listing = nodes
    .map(
      (node, index) =>
        `<div class="row" data-idx="${index}"><code>${escapeHtml(nodeLabel(node))}</code><span>${escapeHtml(node.path ?? '')}</span></div>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Blueprint preview — ${escapeHtml(documentPath)}</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #14120f; color: #e8e2da; }
  header { padding: 10px 16px; border-bottom: 1px solid #2a2622; font-size: 13px; }
  main { display: flex; gap: 16px; padding: 16px; align-items: flex-start; flex-wrap: wrap; }
  #stage { position: relative; width: ${width}px; height: ${height}px; max-width: 100%; }
  #shot { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; }
  svg.overlay { position: absolute; inset: 0; width: 100%; height: 100%; }
  svg.overlay rect:hover, svg.overlay rect.hot { stroke-width: 2 !important; fill: rgba(255,255,255,0.08); }
  aside { flex: 1 1 340px; min-width: 300px; }
  #details { white-space: pre-wrap; background: #1c1915; border: 1px solid #2a2622; border-radius: 8px; padding: 10px 12px; font-size: 12px; min-height: 120px; }
  #listing { margin-top: 12px; max-height: 70vh; overflow: auto; border: 1px solid #2a2622; border-radius: 8px; }
  .row { display: grid; grid-template-columns: minmax(200px, 40%) 1fr; gap: 8px; padding: 3px 10px; font-size: 12px; cursor: pointer; border-bottom: 1px solid #201d19; }
  .row:nth-child(odd) { background: #181512; }
  .row:hover, .row.sel { background: #33403a; }
</style>
</head>
<body>
<header>
  <strong>Blueprint preview</strong> · ${escapeHtml(documentPath)} · ${width}×${height} · ${nodes.length} hook nodes
</header>
<main>
  <div id="stage">
    <img id="shot" alt="native snapshot" src="data:image/png;base64,${pngBase64}">
    <svg class="overlay" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      ${overlays}
    </svg>
  </div>
  <aside>
    <div id="details">Hover or click a rect / row.</div>
    <div id="listing">${listing}</div>
  </aside>
</main>
<script>
  // "<" is escaped so authored values can never close this script tag.
  const nodes = ${JSON.stringify(nodes.map((node) => ({ label: nodeLabel(node), details: nodeDetails(node) }))).replaceAll('<', '\\u003c')};
  const rects = [...document.querySelectorAll('svg.overlay rect')];
  const rows = [...document.querySelectorAll('#listing .row')];
  const details = document.getElementById('details');
  function select(index) {
    rects.forEach((r) => r.classList.toggle('hot', r.dataset.idx === String(index)));
    rows.forEach((r) => r.classList.toggle('sel', r.dataset.idx === String(index)));
    const node = nodes[index];
    if (node) details.textContent = node.details;
  }
  rects.forEach((r) => {
    r.addEventListener('mouseenter', () => select(r.dataset.idx));
    r.addEventListener('click', () => select(r.dataset.idx));
  });
  rows.forEach((r) => r.addEventListener('click', () => select(r.dataset.idx)));
</script>
</body>
</html>
`;
}

function main() {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const outArg = parseOption('--out');
  const width = Number.parseInt(parseOption('--w') ?? '1100', 10);
  const height = Number.parseInt(parseOption('--h') ?? '760', 10);
  const messages = parseOption('--messages') ?? '12';
  const build = process.argv.includes('--build');
  if (positional.length === 0 || Number.isNaN(width) || Number.isNaN(height)) {
    console.error(
      'usage: pnpm blueprint-preview <document.json> [--out f.html] [--w n] [--h n] [--messages n] [--build]',
    );
    process.exit(2);
  }
  const documentPath = resolve(positional[0]);
  if (!existsSync(documentPath)) {
    console.error(`[blueprint-preview] document not found: ${documentPath}`);
    process.exit(2);
  }
  const outPath = outArg ? resolve(outArg) : `${documentPath}.preview.html`;

  // Preflight: schema + i18n warnings before spending a GPU frame.
  const validation = spawnSync(process.execPath, [validatorScript, documentPath], {
    encoding: 'utf8',
  });
  process.stdout.write(validation.stdout ?? '');
  if (validation.status !== 0) {
    console.error('[blueprint-preview] fix validation errors first.');
    process.exit(validation.status ?? 1);
  }

  if (!existsSync(desktopBin())) {
    if (!build) {
      console.error(
        `[blueprint-preview] desktop host not found: ${desktopBin()}\n` +
          'build it once:\n' +
          '  cargo build --release -p neotavern-presentation-chat --bin neocompositor-desktop --features desktop-host\n' +
          'or re-run with --build.',
      );
      process.exit(2);
    }
    console.log('[blueprint-preview] building desktop host (release)…');
    const built = spawnSync(
      'cargo',
      [
        'build',
        '--release',
        '--manifest-path',
        join(repositoryRoot, 'crates', 'Cargo.toml'),
        '-p',
        'neotavern-presentation-chat',
        '--bin',
        'neocompositor-desktop',
        '--features',
        'desktop-host',
      ],
      { stdio: 'inherit' },
    );
    if (built.status !== 0) {
      process.exit(built.status ?? 1);
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'blueprint-preview-'));
  try {
    const shot = join(scratch, 'shot.png');
    const dump = join(scratch, 'dump.json');
    runHost(
      [
        '--blueprint',
        documentPath,
        '--snapshot',
        shot,
        '--dom-dump',
        dump,
        '--w',
        String(width),
        '--h',
        String(height),
        '--messages',
        messages,
      ],
      [shot, dump],
    );
    for (const file of [shot, dump]) {
      if (!existsSync(file) || statSync(file).size === 0) {
        console.error(`[blueprint-preview] host did not produce ${file}`);
        process.exit(1);
      }
    }
    const dumpJson = JSON.parse(readFileSync(dump, 'utf8'));
    const pngBase64 = readFileSync(shot).toString('base64');
    const html = buildPreviewHtml({
      documentPath,
      width,
      height,
      pngBase64,
      nodes: Array.isArray(dumpJson.nodes) ? dumpJson.nodes : [],
    });
    const temporary = `${outPath}.tmp-${process.pid}`;
    writeFileSync(temporary, html, 'utf8');
    renameSync(temporary, outPath);
    console.log(`[blueprint-preview] wrote ${outPath} (${dumpJson.nodes?.length ?? 0} nodes)`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
