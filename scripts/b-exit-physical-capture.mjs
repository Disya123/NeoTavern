#!/usr/bin/env node
/**
 * Physical Xiaomi batch for B-exit fixtures.
 * Does not rebuild libneotavern_android_jni.so. Does not stamp PASS.
 *
 *   node scripts/b-exit-physical-capture.mjs --fixture=perf22 --serial=8f5c2b7c
 *   node scripts/b-exit-physical-capture.mjs --batch=remaining --serial=8f5c2b7c
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE,
  captureStamp,
  findAdb,
  latestBoundBundle,
  selectPhysicalDevice,
} from './m0-d1a-capture-host.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_CAPTURES = join(ROOT, 'apps', 'android', 'b-exit-captures');

export const FIXTURES = {
  perf15: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf15',
    frames: 48,
    needle: 'perf15 ',
  },
  perf22: {
    activity: 'com.neotavern.mobile.PresentationSurfaceActivity',
    scenario: 'perf22',
    frames: 16,
    needle: 'perf22',
  },
  'perf22-poster': {
    activity: 'com.neotavern.mobile.PresentationSurfaceActivity',
    scenario: 'perf22-poster',
    frames: 8,
    needle: 'perf22',
  },
  'perf22-fullscreen': {
    activity: 'com.neotavern.mobile.PresentationSurfaceActivity',
    scenario: 'perf22-fullscreen',
    frames: 8,
    needle: 'perf22',
  },
  'perf22-error': {
    activity: 'com.neotavern.mobile.PresentationSurfaceActivity',
    scenario: 'perf22-error',
    frames: 8,
    needle: 'perf22',
  },
  recovery: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'recovery',
    frames: 8,
    needle: 'recovery ',
  },
  'recovery-fling': {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'recovery-fling',
    frames: 8,
    needle: 'recovery ',
  },
  'recovery-selection': {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'recovery-selection',
    frames: 8,
    needle: 'recovery ',
  },
  'recovery-surface': {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'recovery-surface',
    frames: 4,
    needle: 'recovery ',
  },
  'recovery-background': {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'recovery-background',
    frames: 4,
    needle: 'recovery ',
  },
  'perf01-warm': {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf01-warm',
    frames: 7200,
    captureFrame: -1,
    needle: 'perf01 ',
    timeoutMs: 300_000,
  },
  'perf01-cold': {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf01-cold',
    frames: 7200,
    captureFrame: -1,
    needle: 'perf01 ',
    timeoutMs: 300_000,
  },
  perf02: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf02',
    frames: 240,
    captureFrame: -1,
    needle: 'perf02 ',
  },
  perf03: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf03',
    frames: 16,
    captureFrame: 2,
    needle: 'perf03 ',
  },
  perf04: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf04',
    frames: 16,
    captureFrame: 2,
    needle: 'perf04 ',
  },
  perf05: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf05',
    frames: 48,
    captureFrame: -1,
    needle: 'perf05 ',
  },
  perf11: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf11',
    frames: 16,
    captureFrame: 2,
    needle: 'perf11 ',
  },
  perf12: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf12',
    frames: 7200,
    captureFrame: -1,
    needle: 'perf12 ',
    timeoutMs: 300_000,
  },
  perf13: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf13',
    frames: 48,
    captureFrame: -1,
    needle: 'perf13 ',
  },
  perf14: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf14',
    frames: 8,
    captureFrame: -1,
    needle: 'perf14 ',
  },
  perf16: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf16',
    frames: 100,
    captureFrame: -1,
    needle: 'perf16 ',
    timeoutMs: 900_000,
  },
  perf17: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf17',
    frames: 8,
    captureFrame: -1,
    needle: 'perf17 ',
  },
  perf21: {
    activity: 'com.neotavern.mobile.PresentationPerfActivity',
    scenario: 'perf21',
    frames: 8,
    captureFrame: -1,
    needle: 'perf21 ',
  },
};

export const REMAINING_BATCH = [
  'perf01-warm',
  'perf01-cold',
  'perf02',
  'perf03',
  'perf04',
  'perf05',
  'perf11',
  'perf12',
  'perf13',
  'perf14',
  'perf16',
  'perf17',
  'perf21',
];

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function adb(adbBin, serial, args, extra = {}) {
  return spawnSync(adbBin, ['-s', serial, ...args], { encoding: 'utf8', ...extra });
}

function dumpsysLayers(adbBin, serial) {
  const result = adb(adbBin, serial, ['shell', 'dumpsys', 'SurfaceFlinger'], { timeout: 30_000 });
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function captureFixture({ adbBin, serial, bundle, stamp, dir, fixtureName }) {
  const fixture = FIXTURES[fixtureName];
  const captureFrame = fixture.captureFrame ?? -1;
  adb(adbBin, serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  adb(adbBin, serial, ['logcat', '-c']);
  adb(adbBin, serial, ['shell', 'am', 'force-stop', PACKAGE]);
  adb(adbBin, serial, [
    'shell',
    'am',
    'start',
    '-S',
    '-n',
    `${PACKAGE}/${fixture.activity.replace(`${PACKAGE}.`, '.')}`,
    '--es',
    `${PACKAGE}.PERF_SCENARIO`,
    fixture.scenario,
    '--es',
    `${PACKAGE}.PERF_FRAMES`,
    String(fixture.frames),
    '--es',
    `${PACKAGE}.PERF_CAPTURE_FRAME`,
    String(captureFrame),
  ]);
  if (fixtureName === 'perf15') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    adb(adbBin, serial, ['shell', 'am', 'send-trim-memory', PACKAGE, 'RUNNING_CRITICAL']);
  }
  const deadline = Date.now() + (fixture.timeoutMs ?? 180_000);
  let log = '';
  while (Date.now() < deadline) {
    const dump = adb(adbBin, serial, ['logcat', '-d', '-s', 'NeoTavern:I']);
    log = `${dump.stdout || ''}\n${dump.stderr || ''}`;
    if (log.includes(fixture.needle)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  const layers = fixtureName.startsWith('perf22') ? dumpsysLayers(adbBin, serial) : '';
  const files = {
    logcat: join(dir, `${stamp}-${fixtureName}-logcat.txt`),
    layers: join(dir, `${stamp}-${fixtureName}-layers.txt`),
    evidence: join(dir, `${stamp}-${fixtureName}-evidence.json`),
  };
  writeFileSync(files.logcat, log);
  if (layers) writeFileSync(files.layers, layers);
  writeFileSync(
    files.evidence,
    `${JSON.stringify(
      {
        stamp,
        fixture: fixtureName,
        serial,
        apk_linkage: bundle?.apk_linkage ?? null,
        evidence_dirty: bundle?.evidence_dirty ?? null,
        production_jni_untouched: true,
      },
      null,
      2,
    )}\n`,
  );
  return { stamp, fixture: fixtureName, files, found: log.includes(fixture.needle) };
}

function main() {
  const batch = argValue('batch');
  const names = batch === 'remaining' ? REMAINING_BATCH : [argValue('fixture') ?? 'perf22'];
  for (const fixtureName of names) {
    if (!FIXTURES[fixtureName]) {
      process.stderr.write(`unknown fixture ${fixtureName}\n`);
      process.exitCode = 1;
      return;
    }
  }
  const adbInfo = findAdb();
  if (!adbInfo.ok) {
    process.stderr.write('adb not found\n');
    process.exitCode = 1;
    return;
  }
  const selected = selectPhysicalDevice(adbInfo.bin);
  const requested = argValue('serial');
  const device =
    (requested && selected.physical.find((row) => row.serial === requested)) ||
    selected.physical[0] ||
    null;
  if (!device) {
    process.stderr.write('no physical Android over USB (emulators excluded)\n');
    process.exitCode = 1;
    return;
  }
  const bundle = latestBoundBundle();
  const stamp = captureStamp();
  const dir = ROOT_CAPTURES;
  mkdirSync(dir, { recursive: true });
  const results = names.map((fixtureName) =>
    captureFixture({
      adbBin: adbInfo.bin,
      serial: device.serial,
      bundle,
      stamp,
      dir,
      fixtureName,
    }),
  );
  const failed = results.filter((row) => !row.found);
  process.stdout.write(
    `${JSON.stringify({ stamp, results, failed: failed.map((row) => row.fixture) }, null, 2)}\n`,
  );
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
