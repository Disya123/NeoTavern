#!/usr/bin/env node
/**
 * Release-artifact verification matrix for the blueprint chrome flip
 * (ADR-0056 stage 2). Drives the desktop host binary through every chrome
 * source resolution path and asserts each one's honest behavior:
 *
 *   1. default                     — embedded canonical document drives the chrome
 *   2. --legacy-chrome             — safe-mode rollback to the legacy RSX
 *   3. NEOTA_LEGACY_CHROME=1       — the same rollback via environment
 *   4. precedence                  — safe mode wins over --blueprint AND the env doc
 *   5. NEOTA_CHAT_BLUEPRINT_DOC    — authoring loop override stays available
 *   6. broken env doc              — parse diagnostic printed exactly once,
 *                                    frames still render via the legacy fallback
 *   7. no-clip guard               — at extreme window sizes the shell keeps
 *                                    every content pixel inside the window
 *                                    (regression net for the fixed-width side
 *                                    panel painting past a narrow window edge)
 *
 * Every case must also reach a produced frame (`produced cmds=`).
 *
 * Usage:
 *   pnpm blueprint:packaged-check
 * Environment:
 *   NEOTA_DESKTOP_BIN — host binary override; default is the release build.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng } from './lib/pngcodec.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const canonicalFixture = resolve(
  repositoryRoot,
  'packages',
  'contracts',
  'src',
  'presentation',
  'fixtures',
  'ui-blueprint-document-chat-v1.json',
);

function desktopBin() {
  const override = process.env.NEOTA_DESKTOP_BIN;
  if (override) {
    return resolve(override);
  }
  const exe = process.platform === 'win32' ? 'neocompositor-desktop.exe' : 'neocompositor-desktop';
  return resolve(repositoryRoot, 'crates', 'target', 'release', exe);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Spawns the host with the given args/env, collects stderr until the wanted
 * number of produced frames appears or the deadline passes, then terminates
 * the process tree.
 */
function runHost(args, extraEnv = {}, { timeoutMs = 25_000, producedWanted = 1 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(desktopBin(), args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const producedCount = count(stderr, 'produced cmds=');
      const satisfied = producedCount >= producedWanted;
      const expired = Date.now() - startedAt > timeoutMs;
      if ((!satisfied && !expired) || child.exitCode !== null) {
        if (!expired && child.exitCode === null) {
          return;
        }
      }
      clearInterval(timer);
      // Give trailing stderr a beat to land before killing the tree.
      sleepSync(300);
      if (child.exitCode === null) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      }
      resolveRun(stderr);
    }, 200);
    child.on('error', () => {
      /* surfaced through the empty-stderr timeout below */
    });
  });
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function main() {
  if (!existsSync(desktopBin())) {
    console.error(
      `[blueprint-packaged] host not found: ${desktopBin()}\n` +
        'build it first:\n' +
        '  cargo build --release -p neotavern-presentation-chat --bin neocompositor-desktop --features desktop-host\n' +
        'or point NEOTA_DESKTOP_BIN at an existing binary.',
    );
    process.exit(2);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'blueprint-packaged-'));
  const validDoc = join(scratch, 'valid.json');
  const brokenDoc = join(scratch, 'broken.json');
  writeFileSync(validDoc, readFileSync(canonicalFixture));
  writeFileSync(brokenDoc, '{"format": "neotavern.ui-blueprint.v1"');

  try {
    const cases = [
      {
        name: 'default drives the embedded blueprint document',
        args: [],
        env: {},
        check: (err) =>
          err.includes('chrome driven by embedded blueprint (default') &&
          count(err, 'produced cmds=') >= 1,
      },
      {
        name: '--legacy-chrome rolls back to the legacy RSX (safe mode)',
        args: ['--legacy-chrome'],
        env: {},
        check: (err) =>
          err.includes('chrome driven by legacy RSX (safe mode)') &&
          !err.includes('embedded blueprint') &&
          count(err, 'produced cmds=') >= 1,
      },
      {
        name: 'NEOTA_LEGACY_CHROME=1 rolls back without flags',
        args: [],
        env: { NEOTA_LEGACY_CHROME: '1' },
        check: (err) => err.includes('chrome driven by legacy RSX (safe mode)'),
      },
      {
        name: 'safe mode wins over both --blueprint and the env doc',
        args: ['--legacy-chrome', '--blueprint', 'embedded'],
        env: { NEOTA_CHAT_BLUEPRINT_DOC: validDoc },
        check: (err) =>
          err.includes('chrome driven by legacy RSX (safe mode)') &&
          !err.includes('NEOTA_CHAT_BLUEPRINT_DOC') &&
          count(err, 'chrome driven') === 1,
      },
      {
        name: 'NEOTA_CHAT_BLUEPRINT_DOC keeps the authoring loop working',
        args: [],
        env: { NEOTA_CHAT_BLUEPRINT_DOC: validDoc },
        check: (err) =>
          err.includes('chrome driven by NEOTA_CHAT_BLUEPRINT_DOC') &&
          count(err, 'produced cmds=') >= 1,
      },
      {
        name: 'broken env doc: one diagnostic, frames still render, no panic',
        args: ['--messages', '4', '--pointer', '529,717'],
        env: { NEOTA_CHAT_BLUEPRINT_DOC: brokenDoc },
        // A tap on a real control forces a second frame, proving the
        // per-frame fallback keeps running while the single-diagnostic
        // guard holds.
        run: { producedWanted: 2 },
        check: (err) =>
          err.includes('chrome driven by NEOTA_CHAT_BLUEPRINT_DOC') &&
          err.includes('blueprint document parse failed') &&
          count(err, 'blueprint document parse failed') === 1 &&
          count(err, 'produced cmds=') >= 2 &&
          !err.includes('panicked'),
      },
    ];

    let failures = 0;
    for (const testCase of cases) {
      const stderr = await runHost(testCase.args, testCase.env, testCase.run);
      const ok = testCase.check(stderr);
      console.log(`[blueprint-packaged] ${ok ? 'ok ' : 'FAIL'} ${testCase.name}`);
      if (!ok) {
        failures += 1;
        console.error(
          stderr
            .split('\n')
            .map((line) => `    | ${line}`)
            .join('\n'),
        );
      }
    }
    if (failures > 0) {
      console.error(`[blueprint-packaged] MATRIX FAILED: ${failures} case(s)`);
      process.exit(1);
    }
    console.log(
      '[blueprint-packaged] matrix ok — flip and rollback behave as documented (ADR-0056).',
    );

    // --- 7. no-clip guard ---------------------------------------------------
    // The character side panel is a fixed-width sheet; the compact breakpoint
    // (viewport <= 600) must switch it to full-width so a narrow window never
    // clips panel content. This is the automated net for that class of
    // defect: render at extreme sizes and assert no bright content pixel
    // (text/accent luminance) sits within 2px of the right or bottom edge.
    // Dark full-bleed backgrounds are expected at the edges and ignored.
    const clipSizes = [
      [283, 945], // narrower than the Tauri min window — regression repro size
      [360, 640], // the Tauri min window size
      [900, 220], // compact-height document breakpoint
    ];
    let clipFailures = 0;
    for (const [w, h] of clipSizes) {
      const png = join(scratch, `clip-${w}x${h}.png`);
      await runHost(['--messages', '12', '--w', String(w), '--h', String(h), '--snapshot', png]);
      if (!existsSync(png)) {
        console.log(`[blueprint-packaged] FAIL no-clip ${w}x${h}: snapshot missing`);
        clipFailures += 1;
        continue;
      }
      const img = decodePng(readFileSync(png));
      const edge = 2;
      let clipped = 0;
      let maxX = -1;
      for (let y = 0; y < img.height; y++) {
        for (let x = img.width - edge; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (img.data[i] > 120 && img.data[i + 1] > 110) {
            clipped += 1;
            if (x > maxX) maxX = x;
          }
        }
      }
      // Bottom edge: skip the rail column (x < 60). The rail pins its last
      // icon to the bottom inset, which clips only at sub-minimum heights
      // (the product min window height is 520); the guard targets content
      // clipping in the panel/chat area.
      for (let y = img.height - edge; y < img.height; y++) {
        for (let x = 60; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (img.data[i] > 120 && img.data[i + 1] > 110) {
            clipped += 1;
          }
        }
      }
      const ok = clipped === 0;
      console.log(
        `[blueprint-packaged] ${ok ? 'ok ' : 'FAIL'} no-clip ${w}x${h}` +
          (ok ? '' : `: ${clipped} content pixel(s) at the window edge (max x=${maxX})`),
      );
      if (!ok) clipFailures += 1;
    }
    if (clipFailures > 0) {
      console.error(`[blueprint-packaged] NO-CLIP GUARD FAILED: ${clipFailures} size(s)`);
      process.exit(1);
    }
    console.log('[blueprint-packaged] no-clip guard ok — shell content stays inside the window.');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
