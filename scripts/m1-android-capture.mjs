#!/usr/bin/env node
/**
 * M-1 BaselineReport capture helper (NeoUI v4 RFC, not a compositor).
 *
 * Pulls logcat `NeoTavern` lines and `dumpsys gfxinfo` from a connected
 * device after launching a track. Does not invent device numbers: if adb is
 * missing the command fails closed.
 *
 *   node scripts/m1-android-capture.mjs --track a --phase cold
 *   node scripts/m1-android-capture.mjs --parse-logcat capture.log --parse-gfxinfo gfx.txt
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = 'com.neotavern.mobile';
const ACTIVITY = `${PACKAGE_NAME}/.MainActivity`;
const DEFAULT_WAIT_MS = 50_000;
const DEFAULT_OUT = join(ROOT, 'apps', 'android', 'm1-captures');

const TRACKS = {
  a: {
    extras: ['-e', `${PACKAGE_NAME}.MEASUREMENT_FRAMES`, 'on'],
  },
  a0: {
    extras: [
      '-e',
      `${PACKAGE_NAME}.MEASUREMENT_GLASS`,
      'off',
      '-e',
      `${PACKAGE_NAME}.MEASUREMENT_FRAMES`,
      'on',
    ],
  },
  b: {
    extras: [
      '-e',
      `${PACKAGE_NAME}.MEASUREMENT_ORIGIN`,
      'asset-loader',
      '-e',
      `${PACKAGE_NAME}.MEASUREMENT_FRAMES`,
      'on',
    ],
  },
};

const M1_LINE = /\bm1-(refresh|origin|glass|env|memory|thermal|frames|choreographer|startup)\b/u;

export function parseM1Logcat(text) {
  const last = {};
  const lines = [];
  for (const raw of text.split(/\r?\n/u)) {
    if (!M1_LINE.test(raw)) continue;
    lines.push(raw);
    const kind = raw.match(M1_LINE)?.[1];
    if (!kind) continue;
    if ((kind === 'frames' || kind === 'choreographer') && last[kind] && !raw.includes('{')) {
      continue;
    }
    last[kind] = raw;
  }
  return { last, lines };
}

export function parseGfxinfo(text) {
  const pick = (re) => {
    const match = text.match(re);
    return match?.[1] ?? null;
  };
  return {
    totalFrames: pick(/Total frames rendered:\s*(\d+)/u),
    jankyFrames: pick(/Janky frames:\s*(\d+\s*\([^)]+\))/u),
    missedVsync: pick(/Number Missed Vsync:\s*(\d+)/u),
    percentile90: pick(/90th percentile:\s*(\S+)/u),
    percentile95: pick(/95th percentile:\s*(\S+)/u),
    percentile99: pick(/99th percentile:\s*(\S+)/u),
  };
}

export function summarizeCapture(logcatText, gfxinfoText) {
  const logcat = parseM1Logcat(logcatText);
  const gfxinfo = parseGfxinfo(gfxinfoText);
  return { logcat: logcat.last, gfxinfo, lineCount: logcat.lines.length };
}

function adbBin() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (home) {
    const candidate = join(
      home,
      'platform-tools',
      process.platform === 'win32' ? 'adb.exe' : 'adb',
    );
    if (existsSync(candidate)) return candidate;
  }
  return 'adb';
}

function adb(args, options = {}) {
  const bin = adbBin();
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new Error(`adb failed to start (${bin}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `adb ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout ?? '';
}

function parseArgs(argv) {
  const out = {
    track: null,
    phase: 'cold',
    waitMs: DEFAULT_WAIT_MS,
    outDir: DEFAULT_OUT,
    parseLogcat: null,
    parseGfxinfo: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--track' && next) {
      out.track = next.toLowerCase();
      i += 1;
    } else if (arg === '--phase' && next) {
      out.phase = next.toLowerCase();
      i += 1;
    } else if (arg === '--wait-ms' && next) {
      out.waitMs = Number(next);
      i += 1;
    } else if (arg === '--out' && next) {
      out.outDir = resolve(next);
      i += 1;
    } else if (arg === '--parse-logcat' && next) {
      out.parseLogcat = resolve(next);
      i += 1;
    } else if (arg === '--parse-gfxinfo' && next) {
      out.parseGfxinfo = resolve(next);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

function usage() {
  return `M-1 Android capture (NeoUI v4 RFC). Production default is Track A.

  node scripts/m1-android-capture.mjs --track a|a0|b --phase cold|warm
  node scripts/m1-android-capture.mjs --parse-logcat log.txt --parse-gfxinfo gfx.txt

Writes apps/android/m1-captures/<stamp>-<track>-<phase>/ (gitignored).
Does not start a compositor. Wait ${DEFAULT_WAIT_MS} ms by default for m1-frames.`;
}

function sleep(ms) {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, ms);
}

function waitWithScroll(ms) {
  const step = 2_000;
  let elapsed = 0;
  let up = true;
  while (elapsed < ms) {
    const chunk = Math.min(step, ms - elapsed);
    sleep(chunk);
    elapsed += chunk;
    try {
      if (up) {
        adb(['shell', 'input', 'swipe', '540', '1800', '540', '700', '400']);
      } else {
        adb(['shell', 'input', 'swipe', '540', '700', '540', '1800', '400']);
      }
    } catch {
      // Gestures are best-effort; HostConnect may ignore them.
    }
    up = !up;
  }
}

function runDeviceCapture(opts) {
  if (!opts.track || !TRACKS[opts.track]) {
    throw new Error('`--track` must be a, a0, or b');
  }
  if (opts.phase !== 'cold' && opts.phase !== 'warm') {
    throw new Error('`--phase` must be cold or warm');
  }
  if (!Number.isFinite(opts.waitMs) || opts.waitMs < 0) {
    throw new Error('`--wait-ms` must be a non-negative number');
  }
  adb(['get-state']);
  if (opts.phase === 'cold') {
    adb(['shell', 'am', 'force-stop', PACKAGE_NAME]);
    sleep(1000);
  }
  adb(['logcat', '-c']);
  adb(['shell', 'am', 'start', '-n', ACTIVITY, ...TRACKS[opts.track].extras]);
  waitWithScroll(opts.waitMs);
  const logcat = adb(['logcat', '-d', '-s', 'NeoTavern:I']);
  const gfxinfo = adb(['shell', 'dumpsys', 'gfxinfo', PACKAGE_NAME]);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const dir = join(opts.outDir, `${stamp}-${opts.track}-${opts.phase}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'logcat.txt'), logcat);
  writeFileSync(join(dir, 'gfxinfo.txt'), gfxinfo);
  const summary = summarizeCapture(logcat, gfxinfo);
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return dir;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (opts.parseLogcat || opts.parseGfxinfo) {
    const logcat = opts.parseLogcat ? readFileSync(opts.parseLogcat, 'utf8') : '';
    const gfxinfo = opts.parseGfxinfo ? readFileSync(opts.parseGfxinfo, 'utf8') : '';
    const summary = summarizeCapture(logcat, gfxinfo);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const dir = runDeviceCapture(opts);
  console.log(`[m1-capture] wrote ${dir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(`[m1-capture] ${err.message}`);
    process.exit(1);
  }
}
