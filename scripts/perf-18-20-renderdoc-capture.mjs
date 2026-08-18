#!/usr/bin/env node
/**
 * Physical Xiaomi / Vulkan capture for PERF-18/19/20.
 *
 *   node scripts/perf-18-20-renderdoc-capture.mjs --mode=control --scenario=perf18 --serial=8f5c2b7c
 *   node scripts/perf-18-20-renderdoc-capture.mjs --mode=capture --scenario=perf18 --serial=8f5c2b7c
 *
 * PERF-20 continuity is the multi-frame `perf20-frame` logcat trace, not a
 * single RenderDoc snapshot. Capture mode still pulls one .rdc for Vulkan
 * `devices=1`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { CAPTURES_DIR } from './perf-18-20-adjudicate.mjs';

const ACTIVITY = 'com.neotavern.mobile.PresentationPerfActivity';
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

function scenarioFrames(scenario) {
  if (scenario === 'perf20') return { frames: 48, capture: 7 };
  if (scenario === 'perf19') return { frames: 16, capture: 4 };
  return { frames: 16, capture: 2 };
}

function captureFilenames(stamp, scenario) {
  return {
    stamp,
    rdc: `${stamp}-${scenario}.rdc`,
    xml: `${stamp}-${scenario}.xml`,
    commands: `${stamp}-${scenario}-commands.txt`,
    logcat: `${stamp}-${scenario}-logcat.txt`,
    device: `${stamp}-${scenario}-device.json`,
    evidence: `${stamp}-${scenario}-evidence.json`,
  };
}

function launch(adbBin, serial, scenario, captureFrame, frames) {
  adb(adbBin, serial, ['shell', 'am', 'force-stop', PACKAGE]);
  return adb(adbBin, serial, [
    'shell',
    'am',
    'start',
    '-S',
    '-n',
    `${PACKAGE}/${ACTIVITY}`,
    '--es',
    `${PACKAGE}.PERF_SCENARIO`,
    scenario,
    '--es',
    `${PACKAGE}.PERF_FRAMES`,
    String(frames),
    '--es',
    `${PACKAGE}.PERF_CAPTURE_FRAME`,
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

function waitFor(adbBin, serial, scenario, mode) {
  const deadline = Date.now() + WAIT_MS;
  let log = '';
  const gpuRe = new RegExp(`${scenario} gpu_ran=`, 'u');
  while (Date.now() < deadline) {
    log = logcatDump(adbBin, serial);
    const gpuRan = gpuRe.test(log);
    const ended = /capture_ended=true/.test(log) || /renderdoc_api=end_frame_capture/.test(log);
    const absent = /renderdoc_api_loaded=false/.test(log) || /renderdoc_api=absent/.test(log);
    if (mode === 'control' && gpuRan) {
      return { log, gpuRan, ended, absent, timeout: false };
    }
    if (mode === 'capture' && gpuRan && ended) {
      return { log, gpuRan, ended, absent, timeout: false };
    }
    sleep(POLL_MS);
  }
  return {
    log,
    gpuRan: gpuRe.test(log),
    ended: /capture_ended=true/.test(log) || /renderdoc_api=end_frame_capture/.test(log),
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
  const viaRunAs = adb(adbBin, serial, [
    'shell',
    'run-as',
    PACKAGE,
    'sh',
    '-c',
    'ls -1 files files/perf-18-20 2>/dev/null',
  ]);
  for (const line of (viaRunAs.stdout || '').split(/\r?\n/u)) {
    const name = line.trim().replace(/^\.\//u, '');
    if (!name.endsWith('.rdc')) continue;
    if (name.includes('/')) found.push(name.startsWith('files/') ? name : `files/${name}`);
    else found.push(`files/${name}`);
  }
  const dirs = [
    '/data/data/com.neotavern.mobile/files/perf-18-20',
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

function main() {
  const mode = argValue('mode') || 'capture';
  const scenario = (argValue('scenario') ?? 'perf18').toLowerCase();
  if (mode !== 'capture' && mode !== 'control') {
    printJson({ ok: false, stage: 'args', reason: 'mode must be capture or control' });
    process.exit(2);
  }
  if (!['perf18', 'perf19', 'perf20'].includes(scenario)) {
    printJson({ ok: false, stage: 'args', reason: 'scenario must be perf18, perf19, or perf20' });
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
    if (!bind.ok || bundle?.evidence_dirty) {
      printJson({
        ok: false,
        stage: 'apk',
        reason: bind.ok ? 'evidence_dirty=true' : bind.reason,
        evidence_dirty: bundle?.evidence_dirty ?? true,
      });
      process.exit(3);
    }
  }

  const traces = ensureTraceDir(CAPTURES_DIR);
  const pin = loadRenderdocPin();
  const preset = loadRenderdocPreset();
  const stamp = captureStamp();
  const files = captureFilenames(stamp, scenario);
  const logcatPath = join(traces.dir, files.logcat);
  const devicePath = join(traces.dir, files.device);
  const rdcPath = join(traces.dir, files.rdc);
  const xmlPath = join(traces.dir, files.xml);
  const commandsPath = join(traces.dir, files.commands);
  const { frames, capture } = scenarioFrames(scenario);
  const captureFrame = mode === 'capture' ? capture : -1;

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
  const launched = launch(host.adb.bin, device.serial, scenario, captureFrame, frames);
  const waited = waitFor(host.adb.bin, device.serial, scenario, mode);
  writeFileSync(logcatPath, waited.log);
  const fromLog = capturePathFromLog(waited.log);
  const commonNote = {
    milestone_b: 'STARTED',
    [scenario]: 'CAPTURE_ATTEMPTED',
  };

  if (mode === 'control') {
    writeFileSync(
      devicePath,
      `${JSON.stringify(
        {
          mode: 'control',
          scenario,
          serial: device.serial,
          props: device.props,
          gate,
          layerSettings: layerSettings.map((row) => ({
            cmd: row.cmd,
            status: row.status,
            stderr: (row.stderr || '').trim(),
          })),
          launch: (launched.stdout || '').trim(),
          waited: {
            gpuRan: waited.gpuRan,
            ended: waited.ended,
            absent: waited.absent,
            timeout: waited.timeout === true,
          },
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
      scenario,
      renderdoc_readable_tree: false,
      ...commonNote,
    });
    printJson({
      ok: waited.gpuRan,
      mode: 'control',
      scenario,
      stamp,
      serial: device.serial,
      logcat: logcatPath,
      gpu_ran: waited.gpuRan,
      evidence_path: written.evidencePath,
      note: `${scenario} control; RenderDoc extra=-1; not PASS`,
    });
    process.exit(waited.gpuRan ? 0 : 4);
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
  let api = { ok: false, status: 'UNKNOWN_API' };
  if (pulled.ok) {
    converted = convertToXml(host.renderdoc.renderdoccmd, rdcPath, xmlPath);
    if (converted.ok) {
      dump = `${waited.log}\n${readFileSync(xmlPath, 'utf8')}`;
      writeFileSync(commandsPath, dump);
      api = classifyRenderdocApi(dump);
    }
  }

  const readable =
    pulled.ok && converted.ok && api.ok && api.api === 'Vulkan' && waited.gpuRan && waited.ended;
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
      status: 'NOT_USED',
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
      `--scenario=${scenario}`,
      '--mode=capture',
    ],
    unblock: readable
      ? 'host adjudicator stamps PASS|BLOCKED independently; Milestone B stays STARTED'
      : 'RenderDoc capture is not a readable Vulkan tree yet',
  });
  writeFileSync(
    devicePath,
    `${JSON.stringify(
      {
        mode: 'capture',
        scenario,
        serial: device.serial,
        props: device.props,
        gate,
        layerSettings: layerSettings.map((row) => ({
          cmd: row.cmd,
          status: row.status,
          stderr: (row.stderr || '').trim(),
        })),
        server: (server.stdout || '').trim(),
        launch: (launched.stdout || '').trim(),
        waited: {
          gpuRan: waited.gpuRan,
          ended: waited.ended,
          absent: waited.absent,
          timeout: waited.timeout === true,
        },
        fromLog,
        remotes,
        pulled_ok: pulled.ok,
        converted_ok: converted.ok,
        api,
        ...commonNote,
      },
      null,
      2,
    )}\n`,
  );
  const written = writeCaptureManifest(traces.dir, files, {
    ...manifest,
    api,
    scenario,
    renderdoc_readable_tree: readable,
    ...commonNote,
  });

  printJson({
    ok: readable,
    mode: 'capture',
    scenario,
    stamp,
    readable_tree: readable,
    ...commonNote,
    serial: device.serial,
    logcat: logcatPath,
    rdc: pulled.ok ? rdcPath : null,
    xml: converted.ok ? xmlPath : null,
    remote,
    fromLog,
    remotes,
    api,
    convert_ok: converted.ok,
    convert_stderr: (converted.stderr || converted.stdout || '').trim() || null,
    capture_started: /capture_started=true/.test(waited.log),
    capture_ended: waited.ended,
    gpu_ran: waited.gpuRan,
    evidence_path: written.evidencePath,
    capture_help: formatCaptureHelp(),
    note: `${scenario} capture is not PASS; host adjudicator is a later evidence commit`,
  });
  process.exit(readable ? 0 : 4);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
