#!/usr/bin/env node
/**
 * RenderDoc v1.45 Android Remote Context capture for M0-D1a.
 * Not D1a PASS. Not D1b. Does not flip android_gpu_capture.
 *
 *   node scripts/m0-d1a-renderdoc-capture.mjs
 *   node scripts/m0-d1a-renderdoc-capture.mjs --serial=8f5c2b7c
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ACTIVITY,
  PACKAGE,
  bindApkMatches,
  buildEvidenceManifest,
  captureFilenames,
  captureStamp,
  classifyCaptureDump,
  classifyRoiReadOrder,
  deviceGate,
  evaluateHost,
  formatCaptureHelp,
  latestBoundBundle,
  loadRenderdocPin,
  loadRenderdocPreset,
  selectPhysicalDevice,
  writeCaptureManifest,
} from './m0-d1a-capture-host.mjs';

const WAIT_MS = 90_000;
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

function launchProbe(adbBin, serial) {
  adb(adbBin, serial, ['shell', 'am', 'force-stop', PACKAGE]);
  return adb(adbBin, serial, [
    'shell',
    'am',
    'start',
    '-S',
    '-n',
    `${PACKAGE}/${ACTIVITY}`,
    '--es',
    `${PACKAGE}.M0_D1A_FRAMES`,
    '100',
  ]);
}

function logcatDump(adbBin, serial) {
  const result = adb(adbBin, serial, ['logcat', '-d', '-s', 'NeoTavern:I', 'renderdoc:I', 'RenderDoc:I']);
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForProbe(adbBin, serial) {
  const deadline = Date.now() + WAIT_MS;
  let log = '';
  while (Date.now() < deadline) {
    log = logcatDump(adbBin, serial);
    const ended = /renderdoc_api=end_frame_capture/.test(log);
    const gpuRan = /gpu_ran=true/.test(log);
    const absent = /renderdoc_api=absent/.test(log);
    if ((ended && gpuRan) || (gpuRan && absent)) {
      return { log, ended, gpuRan, absent };
    }
    sleep(POLL_MS);
  }
  return {
    log,
    ended: /renderdoc_api=end_frame_capture/.test(log),
    gpuRan: /gpu_ran=true/.test(log),
    absent: /renderdoc_api=absent/.test(log),
    timeout: true,
  };
}

function capturePathFromLog(log) {
  const match = log.match(/renderdoc_api=end_frame_capture saved=(\d+) captures=(\d+) path=(\S*)/u);
  if (!match) return { saved: 0, captures: 0, path: '' };
  return { saved: Number(match[1]), captures: Number(match[2]), path: match[3] || '' };
}

function listCaptureCandidates(adbBin, serial) {
  const found = [];
  const viaRunAs = adb(adbBin, serial, [
    'shell',
    'run-as',
    PACKAGE,
    'sh',
    '-c',
    'ls -1 files/*.rdc cache/*.rdc 2>/dev/null',
  ]);
  for (const line of (viaRunAs.stdout || '').split(/\r?\n/u)) {
    const name = line.trim().replace(/^\.\//u, '');
    if (name.endsWith('.rdc')) found.push(name);
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
  }
  const pulled = adb(adbBin, serial, ['exec-out', 'run-as', PACKAGE, 'cat', rel], {
    timeout: 120_000,
    encoding: 'buffer',
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
    { encoding: 'utf8', timeout: 180_000 },
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
  const host = evaluateHost();
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

  const bundle = latestBoundBundle();
  const bind = bindApkMatches(bundle, host.apk.path);
  if (!bind.ok) {
    printJson({ ok: false, stage: 'apk', reason: bind.reason });
    process.exit(3);
  }

  const pin = loadRenderdocPin();
  const preset = loadRenderdocPreset();
  const stamp = captureStamp();
  const files = captureFilenames(stamp);
  const logcatPath = join(host.traces.dir, files.logcat);
  const devicePath = join(host.traces.dir, files.device);
  const rdcPath = join(host.traces.dir, files.rdc);
  const xmlPath = join(host.traces.dir, files.xml);
  const commandsPath = join(host.traces.dir, files.commands);

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

  const layerSettings = enableGpuDebugLayers(host.adb.bin, device.serial, pin, preset);
  const server = startRenderdocServer(host.adb.bin, device.serial, pin.layer_package);

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
  const launch = launchProbe(host.adb.bin, device.serial);
  const waited = waitForProbe(host.adb.bin, device.serial);
  writeFileSync(logcatPath, waited.log);
  const fromLog = capturePathFromLog(waited.log);
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
  let readback = [];
  if (pulled.ok) {
    converted = convertToXml(host.renderdoc.renderdoccmd, rdcPath, xmlPath);
    if (converted.ok) {
      dump = `${waited.log}\n${readFileSync(xmlPath, 'utf8')}`;
      writeFileSync(commandsPath, dump);
      completeness = classifyCaptureDump(dump);
      order = classifyRoiReadOrder(dump);
      readback = scanReadback(dump);
    } else {
      completeness = {
        ok: false,
        reason: `renderdoccmd convert failed: ${(converted.stderr || converted.stdout || '').trim()}`,
      };
    }
  }

  const readable =
    pulled.ok && converted.ok && completeness.ok && order.ok && waited.ended && !waited.absent;
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
    capture_command: [process.execPath, resolve(process.argv[1]), `--serial=${device.serial}`],
    unblock: readable
      ? 'review Event Browser / resource graph; completeness check is not D1a PASS'
      : 'RenderDoc capture is not a readable pass/resource tree yet; D1a stays BLOCKED; do not start D1b',
  });
  writeFileSync(
    devicePath,
    `${JSON.stringify(
      {
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
        readback_suspects: readback,
        d1a: 'BLOCKED',
        d1b: 'NOT_STARTED',
        android_gpu_capture: false,
      },
      null,
      2,
    )}\n`,
  );
  const written = writeCaptureManifest(host.traces.dir, files, {
    ...manifest,
    completeness,
    order,
    renderdoc_readable_tree: readable,
    android_gpu_capture: false,
    d1a: 'BLOCKED',
    d1b: 'NOT_STARTED',
  });

  printJson({
    ok: pulled.ok,
    readable_tree: readable,
    d1a: 'BLOCKED',
    d1b: 'NOT_STARTED',
    android_gpu_capture: false,
    serial: device.serial,
    renderdoc: host.renderdoc.reason,
    logcat: logcatPath,
    rdc: pulled.ok ? rdcPath : null,
    remote,
    fromLog,
    remotes,
    completeness,
    order,
    convert_ok: converted.ok,
    convert_stderr: (converted.stderr || converted.stdout || '').trim() || null,
    readback_suspects: readback,
    layer_injected: waited.ended && !waited.absent,
    gpu_ran: waited.gpuRan,
    evidence_path: written.evidencePath,
    capture_help: formatCaptureHelp(),
    note: 'not a D1a PASS; Event Browser review still required',
  });
  process.exit(readable ? 0 : 4);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
