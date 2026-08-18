#!/usr/bin/env node
/**
 * Physical Xiaomi batch for PERF-15 / PERF-22 / device-loss.
 * Writes three independent evidence folders. Does not rebuild
 * libneotavern_android_jni.so. Does not stamp PASS.
 *
 *   node scripts/b-exit-physical-capture.mjs --mode=control --fixture=perf22 --serial=8f5c2b7c
 *   node scripts/b-exit-physical-capture.mjs --mode=control --fixture=perf15 --serial=8f5c2b7c
 *   node scripts/b-exit-physical-capture.mjs --mode=control --fixture=recovery --serial=8f5c2b7c
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE,
  captureStamp,
  latestBoundBundle,
  selectPhysicalDevice,
} from './m0-d1a-capture-host.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_CAPTURES = join(ROOT, 'apps', 'android', 'b-exit-captures');

const FIXTURES = {
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
};

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

function main() {
  const fixtureName = argValue('fixture') ?? 'perf22';
  const fixture = FIXTURES[fixtureName];
  if (!fixture) {
    process.stderr.write(`unknown fixture ${fixtureName}\n`);
    process.exitCode = 1;
    return;
  }
  const selected = selectPhysicalDevice(argValue('serial'));
  const bundle = latestBoundBundle();
  const stamp = captureStamp();
  const dir = ROOT_CAPTURES;
  mkdirSync(dir, { recursive: true });
  const adbBin = selected.adb ?? 'adb';
  const serial = selected.serial;
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
    '-1',
  ]);
  const deadline = Date.now() + 180_000;
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
  process.stdout.write(`${JSON.stringify({ stamp, fixture: fixtureName, files, found: log.includes(fixture.needle) }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
