#!/usr/bin/env node
/**
 * Chat golden gate (M0.5): native legacy raster vs blueprint-rendered chat.
 *
 * The stored goldens are the LEGACY hand-written RSX output of
 * `neocompositor-desktop` at the canonical sizes. `check` re-renders the same
 * frames with the blueprint document (`--blueprint embedded`) and pixel-diffs
 * them вЂ” proving "structure is data" without visual drift, on top of the
 * skeleton parity test. Both sides run the same vello/wgpu pipeline on this
 * machine, so the comparison is deterministic up to glyph AA noise
 * (~0.0005% of pixels, max channel delta 1).
 *
 * This is a LOCAL gate by design: GPU raster is not reproducible across
 * machines/drivers, so it must not run in shared CI.
 *
 * Usage:
 *   pnpm chat:golden         # refresh goldens from the legacy RSX
 *   pnpm chat:golden:check   # diff the blueprint render against them
 *
 * Flags (after the mode):
 *   --max-diff <percent>   fail when percentDifferent exceeds this
 *                          (default 0.01)
 *   --threshold <0..255>   per-channel delta below which a pixel is equal
 *                          (default 2)
 * Environment:
 *   NEOTA_DESKTOP_BIN      path to the desktop host binary; defaults to
 *                          crates/target/release/neocompositor-desktop[.exe]
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from './lib/pngcodec.mjs';
import { buildDiffImage, compareImages } from './style-golden-diff.mjs';

export const GOLDEN_DIR = resolve(
  import.meta.dirname,
  '..',
  'crates',
  'presentation-chat',
  'assets',
  'goldens',
);

/** Canonical verification sizes: the desktop trio plus one COMPACT-height
 * frame (≤240 CSS px) covering the document-driven compact breakpoint
 * (ADR-0056 stage 2). */
export const SIZES = [
  [1100, 760],
  [900, 700],
  [620, 800],
  [900, 220],
];

const MESSAGES = '12';

function desktopBin() {
  const override = process.env.NEOTA_DESKTOP_BIN;
  if (override) {
    return resolve(override);
  }
  const exe = process.platform === 'win32' ? 'neocompositor-desktop.exe' : 'neocompositor-desktop';
  return resolve(import.meta.dirname, '..', 'crates', 'target', 'release', exe);
}

function parseNumber(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const raw = Number.parseFloat(process.argv[index + 1]);
  return Number.isFinite(raw) ? raw : fallback;
}

/** Synchronous sleep so the gate stays a plain sequential script. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs the desktop host for one frame capture. The host intentionally keeps
 * its event loop alive after producing, so we wait until the `--snapshot`
 * file exists and has stopped growing, then terminate the process tree.
 */
function runHost(args) {
  const child = spawn(desktopBin(), args, { stdio: 'ignore' });
  const snapshotAt = args.indexOf('--snapshot');
  const expect = snapshotAt === -1 ? null : args[snapshotAt + 1];
  // When the target already exists (re-capture), its stale mtime/size must
  // not satisfy the stability wait — require a NEWER mtime than spawn time.
  const startedAt =
    expect && existsSync(expect) ? statSync(expect).mtimeMs : Number.NEGATIVE_INFINITY;
  try {
    const deadline = Date.now() + 120_000;
    let stable = -1;
    while (Date.now() < deadline) {
      if (expect && existsSync(expect)) {
        const stats = statSync(expect);
        if (stats.mtimeMs > startedAt && stats.size > 0 && stats.size === stable) {
          break;
        }
        stable = stats.size;
      }
      if (child.exitCode !== null) {
        break;
      }
      sleepSync(150);
    }
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

function main() {
  const mode = process.argv[2] ?? 'check';
  if (mode !== 'capture' && mode !== 'check') {
    console.error(
      'usage: node scripts/chat-golden.mjs <capture|check> [--max-diff p] [--threshold n]',
    );
    process.exit(2);
  }
  const maxDiff = parseNumber('--max-diff', 0.01);
  const threshold = parseNumber('--threshold', 2);
  if (!existsSync(desktopBin())) {
    console.error(
      `[chat-golden] desktop host not found: ${desktopBin()}\n` +
        'build it first:\n' +
        '  cargo build --release -p neotavern-presentation-chat --bin neocompositor-desktop --features desktop-host\n' +
        'or point NEOTA_DESKTOP_BIN at an existing binary.',
    );
    process.exit(2);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'chat-golden-'));
  try {
    let failures = 0;
    for (const [width, height] of SIZES) {
      const goldenPath = join(GOLDEN_DIR, `chat-${width}x${height}.png`);
      const baseArgs = ['--messages', MESSAGES, '--w', String(width), '--h', String(height)];
      if (mode === 'capture') {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        // Since the M4 wave-4 flip (ADR-0056) the desktop host defaults to
        // the embedded blueprint document; goldens must stay the LEGACY RSX
        // raster, so capture opts out explicitly.
        runHost([...baseArgs, '--legacy-chrome', '--snapshot', goldenPath]);
        console.log(`[chat-golden] captured ${goldenPath}`);
        continue;
      }
      if (!existsSync(goldenPath)) {
        console.error(
          `[chat-golden] missing golden ${goldenPath} вЂ” run "pnpm chat:golden" first.`,
        );
        failures += 1;
        continue;
      }
      // The blueprint document drives the chrome; pixels must not move.
      const shot = join(scratch, `shot-${width}x${height}.png`);
      runHost([...baseArgs, '--blueprint', 'embedded', '--snapshot', shot]);
      const golden = decodePng(readFileSync(goldenPath));
      const native = decodePng(readFileSync(shot));
      const metric = compareImages(golden.data, native.data, golden.width, golden.height, {
        threshold,
      });
      const ok = metric.percentDifferent <= maxDiff;
      console.log(
        `[chat-golden] ${width}x${height}: ${metric.percentDifferent.toFixed(4)}% different ` +
          `(max delta ${metric.maxChannelDelta}) ${ok ? 'ok' : `FAIL over ${maxDiff}%`}`,
      );
      if (!ok) {
        failures += 1;
        const diffOut = join(scratch, `diff-${width}x${height}.png`);
        writeFileSync(
          diffOut,
          encodePng({
            width: golden.width,
            height: golden.height,
            data: buildDiffImage(golden.data, native.data, golden.width, golden.height, {
              threshold,
            }),
          }),
        );
        console.error(`[chat-golden] diff image kept at ${diffOut}`);
      }
    }
    if (mode === 'capture') {
      console.log('[chat-golden] goldens refreshed.');
      return;
    }
    if (failures > 0) {
      console.error(`[chat-golden] GATE FAILED: ${failures} size(s) over ${maxDiff}%`);
      process.exit(1);
    }
    console.log(`[chat-golden] gate ok (в‰¤${maxDiff}% for ${SIZES.length} sizes)`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
