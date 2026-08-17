#!/usr/bin/env node
/**
 * RenderDoc v1.45 Android capture for M0-D1b at generation 120.
 * Not D1b PASS. Does not rewrite D1a evidence. Does not flip the probe capture bit.
 *
 *   node scripts/m0-d1b-renderdoc-capture.mjs --mode=control --serial=8f5c2b7c
 *   node scripts/m0-d1b-renderdoc-capture.mjs --mode=capture --serial=8f5c2b7c
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractDebugLabels } from './m0-d1a-adjudicate.mjs';
import {
  PACKAGE,
  bindApkMatches,
  buildEvidenceManifest,
  captureStamp,
  classifyRenderdocApi,
  deviceGate,
  ensureTraceDir,
  evaluateHost,
  formatCaptureHelp,
  latestBoundBundle,
  loadRenderdocPin,
  loadRenderdocPreset,
  selectPhysicalDevice,
  writeCaptureManifest,
} from './m0-d1a-capture-host.mjs';
import {
  CAPTURES_DIR_D1B,
  checkD1bPassOrder,
  classifyD1bDump,
  parseD1bLogLine,
} from './m0-d1b-adjudicate.mjs';

const ACTIVITY = 'com.neotavern.mobile.M0D1bActivity';
const WAIT_MS = 240_000;
const POLL_MS = 2_000;

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function adb(adbBin, serial, args, extra = {}) {
  return spawnSync(adbBin, ['-s', serial, ...args], { encoding: 'utf8', ...extra });
}

function studioHoldingAdb() {
  const listed = spawnSync('tasklist', ['/FI', 'IMAGENAME eq studio64.exe', '/NH'], {
    encoding: 'utf8',
  });
  const text = `${listed.stdout || ''}\n${listed.stderr || ''}`;
  return /studio64\.exe/iu.test(text);
}

function installRenderdocApk(adbBin, serial, apkPath) {
  return adb(adbBin, serial, ['install', '-r', '-g', apkPath], { timeout: 180_000 });
}

function enableGpuDebugLayers(adbBin, serial, pin, preset) {
  const layerApp = pin.layer_package ?? preset.layer_package;
  const vulkanLayer = pin.vulkan_layer ?? preset.vulkan_layer;
  const gles = pin.gles_library ?? preset.gles_library;
  const puts = [
    ['settings', 'put', 'global', 'enable_gpu_debug_layers', '1'],
    ['settings', 'put', 'global', 'gpu_debug_app', PACKAGE],
    ['settings', 'put', 'global', 'gpu_debug_layer_app', layerApp],
    ['settings', 'put', 'global', 'gpu_debug_layers', vulkanLayer],
    ['settings', 'put', 'global', 'gpu_debug_layers_gles', gles],
    ['shell', 'setprop', 'debug.rdoc.IGNORE_LAYERS', '0'],
    ['shell', 'setprop', 'debug.vulkan.layers', vulkanLayer],
  ];
  const results = [];
  for (const parts of puts) {
    const cmd = parts[0] === 'shell' ? parts : ['shell', ...parts];
    results.push({
      cmd: cmd.join(' '),
      ...adb(adbBin, serial, cmd),
    });
  }
  return results;
}

function disableGpuDebugLayers(adbBin, serial) {
  const puts = [
    ['settings', 'delete', 'global', 'enable_gpu_debug_layers'],
    ['settings', 'delete', 'global', 'gpu_debug_app'],
    ['settings', 'delete', 'global', 'gpu_debug_layer_app'],
    ['settings', 'delete', 'global', 'gpu_debug_layers'],
    ['settings', 'delete', 'global', 'gpu_debug_layers_gles'],
    ['shell', 'setprop', 'debug.vulkan.layers', "''"],
    ['shell', 'setprop', 'debug.rdoc.IGNORE_LAYERS', '1'],
  ];
  const results = [];
  for (const parts of puts) {
    const cmd = parts[0] === 'shell' ? parts : ['shell', ...parts];
    results.push({
      cmd: cmd.join(' '),
      ...adb(adbBin, serial, cmd),
    });
  }
  return results;
}

function startRenderdocServer(adbBin, serial, layerApp) {
  return adb(adbBin, serial, [
    'shell',
    'am',
    'start',
    '-n',
    `${layerApp}/.Loader`,
    '-e',
    'renderdoccmd',
    'remoteserver',
  ]);
}

function captureFilenamesD1b(stamp) {
  const base = `${stamp}-d1b`;
  return {
    stamp,
    rdc: `${base}.rdc`,
    xml: `${base}.xml`,
    commands: `${base}-commands.txt`,
    logcat: `${base}-logcat.txt`,
    device: `${base}-device.json`,
    evidence: `${base}-evidence.json`,
  };
}

function launchProbe(adbBin, serial, captureFrame) {
  adb(adbBin, serial, ['shell', 'am', 'force-stop', PACKAGE]);
  return adb(adbBin, serial, [
    'shell',
    'am',
    'start',
    '-S',
    '-n',
    `${PACKAGE}/${ACTIVITY}`,
    '--es',
    `${PACKAGE}.M0_D1B_FRAMES`,
    '1000',
    '--es',
    `${PACKAGE}.M0_D1B_CAPTURE_FRAME`,
    String(captureFrame),
  ]);
}

function logcatDump(adbBin, serial) {
  const result = adb(adbBin, serial, [
    'logcat',
    '-d',
    '-s',
    'NeoTavern:I',
    'renderdoc:I',
    'RenderDoc:I',
  ]);
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForProbe(adbBin, serial, mode) {
  const deadline = Date.now() + WAIT_MS;
  let log = '';
  while (Date.now() < deadline) {
    log = logcatDump(adbBin, serial);
    const ended = /capture_ended=true/.test(log) || /renderdoc_api=end_frame_capture/.test(log);
    const gpuRan = /m0-d1b gpu_ran=true/.test(log);
    const absent = /renderdoc_api_loaded=false/.test(log) || /renderdoc_api=absent/.test(log);
    if (mode === 'control' && gpuRan) {
      return { log, ended, gpuRan, absent };
    }
    if (mode === 'capture' && ended && gpuRan) {
      return { log, ended, gpuRan, absent };
    }
    sleep(POLL_MS);
  }
  return {
    log,
    ended: /capture_ended=true/.test(log) || /renderdoc_api=end_frame_capture/.test(log),
    gpuRan: /m0-d1b gpu_ran=true/.test(log),
    absent: /renderdoc_api_loaded=false/.test(log) || /renderdoc_api=absent/.test(log),
    timeout: true,
  };
}

function capturePathFromLog(log) {
  const modern = log.match(/capture_ended=true saved=(\d+) captures=(\d+) capture_file=(\S*)/u);
  if (modern) {
    return { saved: Number(modern[1]), captures: Number(modern[2]), path: modern[3] || '' };
  }
  const match = log.match(/renderdoc_api=end_frame_capture saved=(\d+) captures=(\d+) path=(\S*)/u);
  if (!match) return { saved: 0, captures: 0, path: '' };
  return { saved: Number(match[1]), captures: Number(match[2]), path: match[3] || '' };
}

function listCaptureCandidates(adbBin, serial) {
  const found = [];
  const viaRunAs = adb(adbBin, serial, ['shell', 'run-as', PACKAGE, 'sh', '-c', 'ls -1 files']);
  for (const line of (viaRunAs.stdout || '').split(/\r?\n/u)) {
    const name = line.trim().replace(/^\.\//u, '');
    if (name.endsWith('.rdc') && name.includes('m0-d1b')) {
      found.push(name.includes('/') ? name : `files/${name}`);
    } else if (name.endsWith('.rdc')) {
      found.push(name.includes('/') ? name : `files/${name}`);
    }
  }
  const dirs = [
    '/data/data/com.neotavern.mobile/files',
    '/sdcard/Android/data/com.neotavern.mobile/files',
    '/storage/emulated/0/Android/data/com.neotavern.mobile/files',
  ];
  for (const dir of dirs) {
    const listed = adb(adbBin, serial, ['shell', 'ls', '-1', dir]);
    for (const line of (listed.stdout || '').split(/\r?\n/u)) {
      const name = line.trim();
      if (name.endsWith('.rdc')) found.push(`${dir}/${name}`);
    }
  }
  return [...new Set(found)];
}

function pullCapture(adbBin, serial, remote, local) {
  let rel = remote;
  const filesIdx = remote.lastIndexOf('/files/');
  if (filesIdx >= 0) {
    rel = `files/${remote.slice(filesIdx + '/files/'.length)}`;
  } else if (remote.startsWith('/')) {
    rel = `files/${remote.split('/').pop()}`;
  } else if (!rel.startsWith('files/') && rel.endsWith('.rdc')) {
    rel = `files/${rel.split('/').pop()}`;
  }
  const pulled = adb(adbBin, serial, ['exec-out', 'run-as', PACKAGE, 'cat', rel], {
    timeout: 120_000,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (pulled.status === 0 && pulled.stdout && pulled.stdout.length > 0) {
    writeFileSync(local, pulled.stdout);
    return { ok: existsSync(local), status: 0, rel };
  }
  const fallback = adb(adbBin, serial, ['pull', remote, local], { timeout: 120_000 });
  return { ...fallback, ok: fallback.status === 0 && existsSync(local), rel };
}

function convertToXml(renderdoccmd, rdcPath, xmlPath) {
  const converted = spawnSync(
    renderdoccmd,
    ['convert', '-f', rdcPath, '-o', xmlPath, '-c', 'xml'],
    {
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  return { ...converted, ok: converted.status === 0 && existsSync(xmlPath) };
}

function scanReadback(text) {
  const suspects = [];
  const needles = [
    'vkMapMemory',
    'vkCmdCopyImageToBuffer',
    'CopyImageToBuffer',
    'readback',
    'cross-device',
    'vkCmdCopyBufferToHost',
  ];
  for (const needle of needles) {
    if (text.toLowerCase().includes(needle.toLowerCase())) suspects.push(needle);
  }
  return suspects;
}

function main() {
  const mode = argValue('mode') || 'capture';
  if (mode !== 'capture' && mode !== 'control') {
    printJson({ ok: false, stage: 'args', reason: 'mode must be capture or control' });
    process.exit(2);
  }

  const host = evaluateHost({ skipBind: mode === 'control' });
  if (!host.ready) {
    printJson({ ok: false, stage: 'host', ...host });
    process.exit(2);
  }
  if (studioHoldingAdb()) {
    printJson({
      ok: false,
      stage: 'studio',
      reason:
        'Android Studio (studio64.exe) is running; close it or disable ADB integration so it does not steal the debuggable APK',
    });
    process.exit(3);
  }

  const requested = argValue('serial');
  const selected = selectPhysicalDevice(host.adb.bin);
  const device =
    (requested && selected.physical.find((row) => row.serial === requested)) ||
    selected.physical[0] ||
    null;
  if (!device) {
    printJson({
      ok: false,
      stage: 'device',
      physical_device: 'BLOCKED_EXTERNAL',
      reason: 'no physical Android over USB (emulators excluded)',
      listed: selected.listed,
      capture_help: formatCaptureHelp(),
    });
    process.exit(3);
  }
  const gate = deviceGate(device, host.apk.abis);
  if (!gate.ok) {
    printJson({
      ok: false,
      stage: 'device-gate',
      physical_device: 'BLOCKED_DEVICE',
      serial: device.serial,
      reason: gate.reason,
      props: device.props,
    });
    process.exit(3);
  }

  if (mode === 'capture') {
    const bundle = latestBoundBundle();
    const bind = bindApkMatches(bundle, host.apk.path);
    if (!bind.ok) {
      printJson({ ok: false, stage: 'apk', reason: bind.reason });
      process.exit(3);
    }
  }

  const traces = ensureTraceDir(CAPTURES_DIR_D1B);
  const pin = loadRenderdocPin();
  const preset = loadRenderdocPreset();
  const stamp = captureStamp();
  const files = captureFilenamesD1b(stamp);
  const logcatPath = join(traces.dir, files.logcat);
  const devicePath = join(traces.dir, files.device);
  const rdcPath = join(traces.dir, files.rdc);
  const xmlPath = join(traces.dir, files.xml);
  const commandsPath = join(traces.dir, files.commands);
  const captureFrame = mode === 'capture' ? 120 : -1;

  let layerSettings = [];
  let server = { stdout: '' };
  if (mode === 'capture') {
    const installedLayer = installRenderdocApk(
      host.adb.bin,
      device.serial,
      host.renderdoc.android_apk,
    );
    if (installedLayer.status !== 0) {
      printJson({
        ok: false,
        stage: 'install-renderdoc',
        reason: installedLayer.stderr || installedLayer.stdout,
      });
      process.exit(3);
    }
    layerSettings = enableGpuDebugLayers(host.adb.bin, device.serial, pin, preset);
    server = startRenderdocServer(host.adb.bin, device.serial, pin.layer_package);
  } else {
    layerSettings = disableGpuDebugLayers(host.adb.bin, device.serial);
  }

  const installedApp = adb(host.adb.bin, device.serial, ['install', '-r', '-d', host.apk.path], {
    timeout: 180_000,
  });
  if (installedApp.status !== 0) {
    printJson({
      ok: false,
      stage: 'install-app',
      reason: installedApp.stderr || installedApp.stdout,
    });
    process.exit(3);
  }
  adb(host.adb.bin, device.serial, ['logcat', '-c']);
  const launch = launchProbe(host.adb.bin, device.serial, captureFrame);
  const waited = waitForProbe(host.adb.bin, device.serial, mode);
  writeFileSync(logcatPath, waited.log);
  const counters = parseD1bLogLine(waited.log);
  const fromLog = capturePathFromLog(waited.log);

  const commonNote = {
    d1a: 'UNCHANGED',
    d1b: 'STARTED',
    android_gpu_capture: false,
  };

  if (mode === 'control') {
    writeFileSync(
      devicePath,
      `${JSON.stringify(
        {
          mode: 'control',
          serial: device.serial,
          props: device.props,
          gate,
          layerSettings: layerSettings.map((row) => ({
            cmd: row.cmd,
            status: row.status,
            stderr: (row.stderr || '').trim(),
          })),
          launch: (launch.stdout || '').trim(),
          waited: {
            ended: waited.ended,
            gpuRan: waited.gpuRan,
            absent: waited.absent,
            timeout: waited.timeout === true,
          },
          counters,
          ...commonNote,
        },
        null,
        2,
      )}\n`,
    );
    const written = writeCaptureManifest(traces.dir, files, {
      physical_device: 'CAPTURE_ATTEMPTED',
      capture_host: 'READY',
      mode: 'control',
      counters,
      renderdoc_readable_tree: false,
      ...commonNote,
    });
    printJson({
      ok: counters.ok && waited.gpuRan,
      mode: 'control',
      readable_tree: false,
      ...commonNote,
      serial: device.serial,
      logcat: logcatPath,
      counters,
      gpu_ran: waited.gpuRan,
      evidence_path: written.evidencePath,
      note: 'control 1000-frame D1b; RenderDoc extra=-1; not a D1b PASS',
    });
    process.exit(counters.ok && waited.gpuRan ? 0 : 4);
  }

  const remotes = listCaptureCandidates(host.adb.bin, device.serial);
  const remote =
    (fromLog.path && fromLog.path.endsWith('.rdc') ? fromLog.path : null) || remotes.at(-1) || null;
  let pulled = { ok: false, reason: 'no .rdc on device' };
  if (remote) {
    pulled = pullCapture(host.adb.bin, device.serial, remote, rdcPath);
  }

  let converted = { ok: false };
  let dump = '';
  let completeness = { ok: false, reason: 'no XML dump' };
  let order = { ok: false };
  let api = { ok: false, status: 'UNKNOWN_API' };
  let readback = [];
  if (pulled.ok) {
    converted = convertToXml(host.renderdoc.renderdoccmd, rdcPath, xmlPath);
    if (converted.ok) {
      dump = `${waited.log}\n${readFileSync(xmlPath, 'utf8')}`;
      writeFileSync(commandsPath, dump);
      completeness = classifyD1bDump(dump);
      const labels = extractDebugLabels(readFileSync(xmlPath, 'utf8')).filter((name) =>
        name.startsWith('m0-d1b-'),
      );
      order = checkD1bPassOrder(labels);
      api = completeness.api || classifyRenderdocApi(dump);
      readback = scanReadback(dump);
    } else {
      completeness = {
        ok: false,
        reason: `renderdoccmd convert failed: ${(converted.stderr || converted.stdout || '').trim()}`,
      };
    }
  }

  const readable =
    pulled.ok &&
    converted.ok &&
    completeness.ok &&
    order.ok &&
    api.ok &&
    api.api === 'Vulkan' &&
    waited.ended &&
    counters.ok;
  const manifest = buildEvidenceManifest({
    physical_device: 'CAPTURE_ATTEMPTED',
    capture_host: 'READY',
    apk_source_commit: host.provenance.apk_source_commit,
    apk_sha256: host.provenance.apk_sha256,
    capture_tooling_commit: host.provenance.capture_tooling_commit,
    capture_tool: 'RenderDoc',
    renderdoc: {
      version: host.renderdoc.version,
      build_sha: host.renderdoc.build_sha,
      path: host.renderdoc.install_path,
    },
    agi: {
      version: host.agi.version,
      status: 'CAPTURED_BUT_NOT_REPLAYABLE',
    },
    apk: host.apk,
    files: {
      ...files,
      rdc: rdcPath,
      xml: xmlPath,
      commands: commandsPath,
      logcat: logcatPath,
      device: devicePath,
    },
    capture_command: [
      process.execPath,
      resolve(process.argv[1]),
      `--serial=${device.serial}`,
      '--mode=capture',
    ],
    unblock: readable
      ? 'review Event Browser; completeness check is not D1b PASS'
      : 'RenderDoc capture is not a readable Vulkan generation-120 tree yet; D1b stays STARTED',
  });
  writeFileSync(
    devicePath,
    `${JSON.stringify(
      {
        mode: 'capture',
        serial: device.serial,
        props: device.props,
        gate,
        layerSettings: layerSettings.map((row) => ({
          cmd: row.cmd,
          status: row.status,
          stderr: (row.stderr || '').trim(),
        })),
        server: (server.stdout || '').trim(),
        launch: (launch.stdout || '').trim(),
        waited: {
          ended: waited.ended,
          gpuRan: waited.gpuRan,
          absent: waited.absent,
          timeout: waited.timeout === true,
        },
        fromLog,
        remotes,
        pulled_ok: pulled.ok,
        converted_ok: converted.ok,
        completeness,
        order,
        api,
        counters,
        readback_suspects: readback,
        ...commonNote,
      },
      null,
      2,
    )}\n`,
  );
  const written = writeCaptureManifest(traces.dir, files, {
    ...manifest,
    completeness,
    order,
    api,
    counters,
    renderdoc_readable_tree: readable,
    ...commonNote,
  });

  printJson({
    ok: readable,
    mode: 'capture',
    readable_tree: readable,
    ...commonNote,
    serial: device.serial,
    renderdoc: host.renderdoc.reason,
    logcat: logcatPath,
    rdc: pulled.ok ? rdcPath : null,
    remote,
    fromLog,
    remotes,
    completeness,
    order,
    api,
    counters,
    convert_ok: converted.ok,
    convert_stderr: (converted.stderr || converted.stdout || '').trim() || null,
    readback_suspects: readback,
    capture_started: /capture_started=true/.test(waited.log),
    capture_ended: waited.ended,
    gpu_ran: waited.gpuRan,
    evidence_path: written.evidencePath,
    capture_help: formatCaptureHelp(),
    note: 'generation-120 capture is not PASS; host adjudicator is a later evidence commit',
  });
  process.exit(readable ? 0 : 4);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
