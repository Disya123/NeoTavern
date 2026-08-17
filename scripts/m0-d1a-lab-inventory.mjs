#!/usr/bin/env node
/**
 * Lab inventory for post-GateP:P1 M0-D1a. Does not claim PASS.
 *
 *   node scripts/m0-d1a-lab-inventory.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGI_PIN = JSON.parse(readFileSync(join(ROOT, 'tools', 'agi.pin.json'), 'utf8'));

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function adbBin() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const candidates = [
    home ? join(home, 'platform-tools', 'adb.exe') : null,
    home ? join(home, 'platform-tools', 'adb') : null,
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    'E:\\android_sdk\\platform-tools\\adb.exe',
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return 'adb';
}

function classifyAdb(text) {
  const lines = text.split(/\r?\n/u).filter((line) => line && !line.startsWith('List'));
  const devices = [];
  for (const line of lines) {
    const physical = /\busb:/u.test(line) && !/\bemulator-/u.test(line);
    const emulator = /\bemulator-/u.test(line) || /sdk_gphone/u.test(line);
    devices.push({ line, physical, emulator });
  }
  return {
    devices,
    physical_count: devices.filter((row) => row.physical).length,
    emulator_count: devices.filter((row) => row.emulator).length,
  };
}

const adb = adbBin();
const devices = run(adb, ['devices', '-l']);
const classified = classifyAdb(devices.stdout);
const captureTools = [
  join(AGI_PIN.install_path, 'agi.exe'),
  join(AGI_PIN.install_path, 'gapit.exe'),
  'C:\\Program Files\\RenderDoc\\qrenderdoc.exe',
  'C:\\Program Files\\RenderDoc\\renderdoccmd.exe',
  join(homedir(), 'AppData\\Local\\Google\\AndroidGPUInspector\\agi.exe'),
].filter((path) => existsSync(path));
const gradle = run('gradle', ['-v']);
const cargoNdk = run('cargo', ['ndk', '--version']);

const record = {
  note: 'PRE-GATE inventory; not D1a PASS; not D1b',
  adb,
  adb_status: devices.status,
  adb_out: devices.stdout,
  ...classified,
  capture_tools: captureTools,
  agi_pin: {
    version: AGI_PIN.version,
    build_sha: AGI_PIN.build_sha,
    install_path: AGI_PIN.install_path,
    present: existsSync(join(AGI_PIN.install_path, 'gapit.exe')),
  },
  gradle_available: gradle.status === 0,
  cargo_ndk: cargoNdk.stdout || cargoNdk.stderr,
  android_home: process.env.ANDROID_HOME || null,
  unblock:
    classified.physical_count === 0
      ? 'attach a physical Android over USB (not emulator-5554); capture_host is separate (node scripts/m0-d1a-capture-preflight.mjs --host-only)'
      : 'run node scripts/m0-d1a-capture-preflight.mjs then the printed gapit trace command',
};

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
