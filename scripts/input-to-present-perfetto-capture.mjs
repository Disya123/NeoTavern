#!/usr/bin/env node
/**
 * Physical Xiaomi / Vulkan Perfetto capture for RFC §14 input-to-present.
 * Does not change production MainActivity, default JNI, or WebView rollback.
 *
 *   node scripts/input-to-present-perfetto-capture.mjs --serial=8f5c2b7c
 *
 * Requires a BOUND APK whose source commit is 55a3174 or a clean descendant.
 * Emulator serials are excluded. 60/90 Hz windows are pacing-only; the
 * normative gate is the locked 120 Hz fixture.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PACKAGE,
  bindApkMatches,
  captureStamp,
  DEFAULT_APK,
  findAdb,
  latestBoundBundle,
  ROOT,
  selectPhysicalDevice,
  sha256File,
} from './m0-d1a-capture-host.mjs';
import { MIN_BOUND_COMMIT, gitIsAncestor } from './input-to-present-adjudicate.mjs';
import { CONFIG_REL } from './input-to-present-parse.mjs';

const ACTIVITY = 'com.neotavern.mobile.PresentationInputActivity';
const COMPONENT = `${PACKAGE}/.PresentationInputActivity`;
const CAPTURES_DIR = join(ROOT, 'apps', 'android', 'input-to-present-captures');
const CONFIG_PATH = join(ROOT, CONFIG_REL);
const DEVICE_TRACE = '/data/misc/perfetto-traces/i2p.perfetto-trace';
const DEVICE_CFG = '/data/misc/perfetto-configs/i2p.pbtxt';
const WAIT_MS = 210_000;
const POLL_MS = 2_000;
const TP_URL =
  'https://commondatastorage.googleapis.com/perfetto-luci-artifacts/v56.0/windows-amd64/trace_processor_shell.exe';

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function adb(adbBin, serial, args, extra = {}) {
  return spawnSync(adbBin, ['-s', serial, ...args], {
    encoding: extra.encoding ?? 'utf8',
    maxBuffer: extra.maxBuffer ?? 8 * 1024 * 1024,
    ...extra,
  });
}

function studioHoldingAdb() {
  const listed = spawnSync('tasklist', ['/FI', 'IMAGENAME eq studio64.exe', '/NH'], {
    encoding: 'utf8',
  });
  const text = `${listed.stdout || ''}\n${listed.stderr || ''}`;
  return /studio64\.exe/iu.test(text);
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`], {
    stdio: 'ignore',
  });
}

function dumpThermal(adbBin, serial) {
  const dumpsys = adb(adbBin, serial, ['shell', 'dumpsys', 'thermalservice'], { timeout: 15_000 });
  const gpu =
    adb(adbBin, serial, ['shell', 'cat', '/sys/class/kgsl/kgsl-3d0/gpuclk'], { timeout: 5_000 })
      .stdout || '';
  const cpu =
    adb(adbBin, serial, ['shell', 'cat', '/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'], {
      timeout: 5_000,
    }).stdout || '';
  const text = `${dumpsys.stdout || ''}`;
  let state = 'none';
  if (/SEVERE|EMERGENCY|SHUTDOWN/iu.test(text)) state = 'severe';
  else if (/CRITICAL/iu.test(text)) state = 'critical';
  else if (/MODERATE|LIGHT/iu.test(text)) state = 'moderate';
  const cpuKhz = Number((cpu || '').trim());
  const gpuHz = Number((gpu || '').trim());
  return {
    state,
    cpu_khz: Number.isFinite(cpuKhz) ? [cpuKhz] : [0],
    gpu_khz: Number.isFinite(gpuHz) ? [Math.round(gpuHz / 1000)] : [0],
    raw: text.slice(0, 2000),
  };
}

function runPython(args, extra = {}) {
  const attempts = [
    ['python', ...args],
    ['py', '-3', ...args],
  ];
  let last = null;
  for (const command of attempts) {
    last = spawnSync(command[0], command.slice(1), extra);
    if (last.status === 0) return last;
  }
  return last;
}

function startLogcatStream(adbBin, serial, path) {
  const fd = openSync(path, 'w');
  const child = spawn(
    adbBin,
    ['-s', serial, 'logcat', '-v', 'threadtime', '-s', 'NeoTavernI2P:I'],
    { stdio: ['ignore', fd, 'pipe'], windowsHide: true },
  );
  return { child, fd };
}

function stopLogcatStream(stream) {
  if (!stream) return;
  try {
    stream.child.kill();
  } catch {
    // adb logcat exits with the host process
  }
  try {
    closeSync(stream.fd);
  } catch {
    // already closed
  }
}

function logcatContains(path, needle) {
  if (!path || !existsSync(path)) return false;
  return readFileSync(path, 'utf8').includes(needle);
}

function ensureTraceProcessor(dir) {
  const env = process.env.PERFETTO_TRACE_PROCESSOR;
  if (env && existsSync(env)) return env;
  mkdirSync(dir, { recursive: true });
  const local = join(dir, 'trace_processor_shell.exe');
  if (existsSync(local)) return local;
  const curl = spawnSync(
    'curl',
    ['-L', '--fail', '-o', local, TP_URL],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (curl.status === 0 && existsSync(local)) return local;
  return null;
}

function main() {
  mkdirSync(CAPTURES_DIR, { recursive: true });
  const adbInfo = findAdb();
  if (!adbInfo.ok) {
    printJson({ ok: false, reason: adbInfo.reason ?? 'adb not found' });
    process.exitCode = 1;
    return;
  }
  if (studioHoldingAdb()) {
    printJson({
      ok: false,
      reason: 'Android Studio is holding the debuggable APK; close studio64.exe before capture',
    });
    process.exitCode = 1;
    return;
  }
  const requested = argValue('serial');
  const selected = selectPhysicalDevice(adbInfo.bin);
  const device = requested
    ? selected.physical.find((row) => row.serial === requested)
    : selected.physical[0];
  if (!device || String(device.serial).startsWith('emulator-')) {
    printJson({
      ok: false,
      reason: 'no physical device (emulator excluded)',
      listed: selected.listed,
    });
    process.exitCode = 1;
    return;
  }
  const bundle = latestBoundBundle();
  const apkPath = argValue('apk') ?? (bundle?.apk_path && existsSync(bundle.apk_path) ? bundle.apk_path : DEFAULT_APK);
  const bind = bundle ? bindApkMatches(bundle, apkPath) : { ok: false, reason: 'no BOUND bundle' };
  const sourceCommit = bundle?.base_commit ?? null;
  const boundOk =
    bind.ok &&
    bundle?.apk_linkage === 'BOUND' &&
    bundle?.evidence_dirty === false &&
    sourceCommit &&
    (sourceCommit === MIN_BOUND_COMMIT ||
      sourceCommit.startsWith(MIN_BOUND_COMMIT.slice(0, 7)) ||
      gitIsAncestor(MIN_BOUND_COMMIT, sourceCommit));
  if (!boundOk) {
    printJson({
      ok: false,
      reason: 'APK is not BOUND to 55a3174 or a subsequent clean descendant',
      bind,
      sourceCommit,
    });
    process.exitCode = 1;
    return;
  }
  const stamp = captureStamp();
  const outDir = join(CAPTURES_DIR, stamp);
  mkdirSync(outDir, { recursive: true });
  if (!process.argv.includes('--skip-install')) {
    const install = adb(adbInfo.bin, device.serial, ['install', '-r', '-g', apkPath], {
      timeout: 180_000,
    });
    if (install.status !== 0) {
      printJson({ ok: false, reason: 'apk install failed', stderr: install.stderr });
      process.exitCode = 1;
      return;
    }
  }
  adb(adbInfo.bin, device.serial, ['shell', 'am', 'force-stop', PACKAGE]);
  adb(adbInfo.bin, device.serial, ['logcat', '-c']);
  const logcatPath = join(outDir, `${stamp}-logcat.txt`);
  const logcatStream = startLogcatStream(adbInfo.bin, device.serial, logcatPath);
  adb(adbInfo.bin, device.serial, ['shell', 'rm', '-f', DEVICE_TRACE]);
  const startTrace = spawnSync(
    adbInfo.bin,
    [
      '-s',
      device.serial,
      'shell',
      'perfetto',
      '--txt',
      '-c',
      '-',
      '-o',
      DEVICE_TRACE,
      '--background',
    ],
    { encoding: 'utf8', input: readFileSync(CONFIG_PATH) },
  );
  const traceOut = `${startTrace.stdout || ''}\n${startTrace.stderr || ''}`.trim();
  const pidLine = traceOut
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/u.test(line))
    .at(-1);
  const perfettoPid = pidLine ?? null;
  if (/permission denied|Could not open|FAILED/iu.test(traceOut) && !perfettoPid) {
    stopLogcatStream(logcatStream);
    printJson({ ok: false, reason: 'perfetto failed to start', start_trace: traceOut });
    process.exitCode = 1;
    return;
  }
  sleep(1_500);
  adb(adbInfo.bin, device.serial, [
    'shell',
    'am',
    'start',
    '-n',
    COMPONENT,
    '--es',
    'com.neotavern.mobile.I2P_FIXTURE',
    'all',
    '--ei',
    'com.neotavern.mobile.I2P_HZ',
    '120',
    '--ei',
    'com.neotavern.mobile.I2P_WARMUP_MS',
    '2000',
    '--ei',
    'com.neotavern.mobile.I2P_SCROLL_MS',
    '60000',
  ]);
  const deadline = Date.now() + WAIT_MS;
  let done = false;
  while (Date.now() < deadline) {
    if (logcatContains(logcatPath, 'i2p fixture done')) {
      done = true;
      break;
    }
    sleep(POLL_MS);
  }
  sleep(500);
  stopLogcatStream(logcatStream);
  if (logcatContains(logcatPath, 'i2p fixture done')) {
    done = true;
  }
  adb(adbInfo.bin, device.serial, ['shell', 'kill', '-INT', perfettoPid ?? '']);
  adb(adbInfo.bin, device.serial, ['shell', 'pkill', '-INT', 'perfetto']);
  sleep(2_000);
  const tracePath = join(outDir, `${stamp}.perfetto-trace`);
  let pull = adb(adbInfo.bin, device.serial, ['pull', DEVICE_TRACE, tracePath], {
    timeout: 120_000,
  });
  if (pull.status !== 0 || !existsSync(tracePath)) {
    const fd = openSync(tracePath, 'w');
    pull = spawnSync(
      adbInfo.bin,
      ['-s', device.serial, 'exec-out', 'cat', DEVICE_TRACE],
      { stdio: ['ignore', fd, 'pipe'], timeout: 120_000 },
    );
    closeSync(fd);
  }
  const thermal = dumpThermal(adbInfo.bin, device.serial);
  const meta = {
    stamp,
    device: {
      serial: device.serial,
      model: device.props?.['ro.product.model'] ?? null,
      device: device.props?.['ro.product.device'] ?? null,
      abi: device.props?.['ro.product.cpu.abi'] ?? null,
    },
    apk_sha256: bundle.apk_sha256,
    apk_source_commit: sourceCommit,
    source_commit: sourceCommit,
    perfetto_config_sha256: sha256File(CONFIG_PATH),
    trace_sha256: existsSync(tracePath) ? sha256File(tracePath) : null,
    thermal,
    fling_velocity: { fine: 10_000, coalesced: 10_000 },
    driver: 'Vulkan',
  };
  writeFileSync(join(outDir, `${stamp}-meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  const tp = ensureTraceProcessor(join(CAPTURES_DIR, 'tools'));
  let queried = false;
  let tpOut = '';
  if (tp && existsSync(tracePath)) {
    const py = runPython(
      [join(ROOT, 'scripts', 'input-to-present-tp.py'), tp, tracePath, join(outDir, stamp)],
      { encoding: 'utf8', timeout: 180_000 },
    );
    queried = py.status === 0;
    tpOut = `${py.stdout || ''}\n${py.stderr || ''}`;
    writeFileSync(join(outDir, `${stamp}-tp.txt`), tpOut);
  }
  const parse = spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts', 'input-to-present-parse.mjs'),
      `--logcat=${logcatPath}`,
      `--timeline=${join(outDir, `${stamp}-timeline.json`)}`,
      `--stats=${join(outDir, `${stamp}-stats.json`)}`,
      `--clock=${join(outDir, `${stamp}-clock.json`)}`,
      `--android_logs=${join(outDir, `${stamp}-android_logs.json`)}`,
      `--meta=${join(outDir, `${stamp}-meta.json`)}`,
      `--out=${join(outDir, `${stamp}-fixture.json`)}`,
    ],
    { encoding: 'utf8' },
  );
  const fixturePath = join(outDir, `${stamp}-fixture.json`);
  let fixtureHint = null;
  if (existsSync(fixturePath)) {
    try {
      fixtureHint = JSON.parse(readFileSync(fixturePath, 'utf8'));
    } catch {
      fixtureHint = null;
    }
  }
  const windowsOk =
    (fixtureHint?.warmup_ns ?? 0) >= 1_000_000_000 &&
    (fixtureHint?.continuous_scroll_ns ?? 0) >= 60_000_000_000;
  const captureOk = done && pull.status === 0 && parse.status === 0 && queried && windowsOk;
  printJson({
    ok: captureOk,
    stamp,
    serial: device.serial,
    activity: ACTIVITY,
    bound: boundOk,
    sourceCommit,
    fixture_done: done,
    perfetto_pid: perfettoPid,
    start_trace: traceOut.slice(0, 400),
    pulled: pull.status === 0,
    queried,
    parse_ok: parse.status === 0,
    warmup_ns: fixtureHint?.warmup_ns ?? null,
    continuous_scroll_ns: fixtureHint?.continuous_scroll_ns ?? null,
    unjoined_cookies: fixtureHint?.unjoined_cookies ?? null,
    trace_buffer_overrun: fixtureHint?.trace_buffer_overrun ?? null,
    logcat: logcatPath,
    trace: existsSync(tracePath) ? tracePath : null,
    fixture: fixturePath,
    reason: captureOk
      ? 'physical Perfetto batch captured; adjudicate with --fixture and --write'
      : !done
        ? 'fixture did not finish within the wait window'
        : !queried
          ? 'trace_processor_shell did not query FrameTimeline'
          : !windowsOk
            ? 'logcat missing warm-up or 60 s continuous-scroll window'
            : 'capture incomplete',
  });
  if (!captureOk) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
