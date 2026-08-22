#!/usr/bin/env node
/**
 * Watch React style sources and re-run the design-system packer.
 *
 * The React CSS Modules / tokens are the single source of truth for the
 * native Blitz renderer. This script polls the input trees for mtime changes
 * and re-invokes `crates/presentation-design-system/scripts/pack_design_system.py`
 * so `generated/product.css` (and the rest of the pack) stays in sync without
 * manual `python ...` runs — the "watch" half of the style-port loop.
 *
 * Usage:
 *   node scripts/watch-design-system.mjs            # pack once, then watch
 *   node scripts/watch-design-system.mjs --once     # pack once and exit (CI)
 *   node scripts/watch-design-system.mjs --dry-run  # print what would run, do not exec
 *   node scripts/watch-design-system.mjs --interval-ms 800 --debounce-ms 500
 *
 * Requires: Python 3 with `fontTools` (pack_design_system.py uses it), and
 * `apps/web/node_modules` populated (Phosphor/Outfit are read from there).
 *
 * Env: DESIGN_PACK_PYTHON — python binary to use (default `python` on win32,
 * otherwise `python3`).
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PACK_SCRIPT = resolve(
  ROOT,
  'crates/presentation-design-system/scripts/pack_design_system.py',
);
const CWD = process.cwd();

export function pythonBinary() {
  return process.env.DESIGN_PACK_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
}

/** Directories (plus the packer itself) whose changes invalidate the pack. */
export function watchRoots() {
  return [
    resolve(ROOT, 'apps/web/src'),
    resolve(ROOT, 'packages/ui/src'),
    resolve(ROOT, 'apps/web/node_modules/@fontsource-variable'),
    resolve(ROOT, 'apps/web/node_modules/@phosphor-icons/react'),
  ].filter(existsSync);
}

/**
 * Fingerprint a file or directory tree as a Map of absolute path → `mtime:size`.
 * Skipping files inside `node_modules`/`.git` keeps the icon/font vendored
 * trees cheap. Including the size guards against coarse-mtime filesystems where
 * two different writes can land on the same mtime tick.
 */
export function signatureOf(root) {
  const sig = new Map();
  const fingerprint = (path) => {
    const st = statSync(path);
    sig.set(path, `${Math.trunc(st.mtimeMs)}:${st.size}`);
  };
  if (!existsSync(root)) return sig;
  const st = statSync(root);
  if (!st.isDirectory()) {
    fingerprint(root);
    return sig;
  }
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          fingerprint(full);
        } catch {
          // File vanished between readdir and stat — not a live input.
        }
      }
    }
  }
  return sig;
}

/** True when the two fingerprints differ (added/removed/changed/mtime change). */
export function haveChanged(prev, next) {
  if (prev.size !== next.size) return true;
  for (const [path, mtime] of next) {
    if (prev.get(path) !== mtime) return true;
  }
  return false;
}

/** Merge per-root signatures into one map (roots must not overlap). */
export function mergedSignature(roots) {
  const merged = new Map();
  for (const root of roots) {
    for (const [path, mtime] of signatureOf(root)) {
      merged.set(path, mtime);
    }
  }
  return merged;
}

/** Debounce: fn runs only after `ms` of quiet, always with the latest args. */
export function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  debounced.flushNow = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      fn();
    }
  };
  return debounced;
}

/** Run `pack_design_system.py`. Resolves with { ok, code, out } on completion. */
export function packDesignSystem({
  python = pythonBinary(),
  script = PACK_SCRIPT,
  dryRun = false,
} = {}) {
  return new Promise((resolvePack) => {
    if (dryRun) {
      console.log(`[design:watch] (dry-run) would run: ${python} ${script}`);
      resolvePack({ ok: true, code: 0, out: '' });
      return;
    }
    const child = spawn(python, [script], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (err) => {
      console.error(`[design:watch] failed to spawn ${python}: ${err.message}`);
      resolvePack({ ok: false, code: -1, out });
    });
    child.on('close', (code) => {
      const ok = code === 0;
      console.log(
        ok ? `[design:watch] pack OK (exit 0)` : `[design:watch] pack FAILED (exit ${code})`,
      );
      resolvePack({ ok, code, out });
    });
  });
}

/**
 * The watch loop. Pack once (unless `skipInitial`), then poll the input trees
 * and re-pack when anything changes (debounced). Returns a stop() controller.
 */
export function runWatch({
  intervalMs = 400,
  debounceMs = 400,
  skipInitial = false,
  onPack = () => packDesignSystem(),
  onError = (err) => console.error(`[design:watch] error: ${err.message}`),
} = {}) {
  const roots = watchRoots();
  let previous = skipInitial ? null : mergedSignature(roots);
  let timer = null;

  const trigger = debounce(async () => {
    try {
      await onPack();
    } catch (err) {
      onError(err);
    }
    trigger.cancel();
  }, debounceMs);

  const tick = () => {
    const current = mergedSignature(roots);
    if (previous !== null && haveChanged(previous, current)) {
      previous = current;
      trigger();
    } else if (previous === null) {
      previous = current;
    }
  };

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    trigger.cancel();
  };

  if (skipInitial) {
    previous = mergedSignature(roots);
  }
  timer = setInterval(tick, intervalMs);
  return { stop, tick, roots };
}

function isMain() {
  return (
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const dryRun = args.includes('--dry-run');
  const quiet = args.includes('--quiet');
  const intervalMs = Number.parseInt(args[args.indexOf('--interval-ms') + 1] ?? '400', 10) || 400;
  const debounceMs = Number.parseInt(args[args.indexOf('--debounce-ms') + 1] ?? '400', 10) || 400;

  const log = quiet ? () => {} : (...parts) => console.log(...parts);

  if (dryRun) {
    log(`[design:watch] dry-run roots:`);
    for (const root of watchRoots()) log(`  ${relative(CWD, root)}`);
  }

  const initial = await packDesignSystem({ dryRun });
  if (!initial.ok) process.exitCode = initial.code === -1 ? 1 : initial.code;
  if (once) return;

  process.stdout.write(
    `[design:watch] watching style inputs (interval ${intervalMs}ms, debounce ${debounceMs}ms); Ctrl+C to stop\n`,
  );
  runWatch({
    intervalMs,
    debounceMs,
    skipInitial: true,
    onPack: () => packDesignSystem({ dryRun }),
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

if (isMain()) {
  await main();
}
