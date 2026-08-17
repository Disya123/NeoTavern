#!/usr/bin/env node
/**
 * One-command M0-D1a capture preflight. Not D1a PASS. Not D1b.
 *
 * Host-only (default when no physical USB device):
 *   node scripts/m0-d1a-capture-preflight.mjs --host-only
 *
 * With a physical phone attached:
 *   node scripts/m0-d1a-capture-preflight.mjs
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ACTIVITY,
  PACKAGE,
  bindApkMatches,
  buildEvidenceManifest,
  buildGapitTraceCommand,
  captureFilenames,
  captureStamp,
  deviceGate,
  evaluateHost,
  formatCaptureHelp,
  latestBoundBundle,
  loadPreset,
  selectPhysicalDevice,
  writeCaptureManifest,
} from './m0-d1a-capture-host.mjs';

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function adb(adbBin, serial, args, extra = {}) {
  return spawnSync(adbBin, ['-s', serial, ...args], { encoding: 'utf8', ...extra });
}

function runDevicePreflight(host) {
  const selected = selectPhysicalDevice(host.adb.bin);
  if (selected.physical.length === 0) {
    return {
      physical_device: 'BLOCKED_EXTERNAL',
      capture_host: host.capture_host,
      reason: 'no physical Android over USB (emulators excluded)',
      listed: selected.listed.map((row) => ({ serial: row.serial, emulator: row.emulator })),
      capture_help: formatCaptureHelp(
        buildGapitTraceCommand({
          gapit: host.agi.gapit,
          serial: '<PHYSICAL_SERIAL>',
          out: join(host.traces.dir, captureFilenames(captureStamp()).gfxtrace),
        }),
      ),
      unblock: 'plug in a physical Android phone over USB and re-run this command',
    };
  }
  const device = selected.physical[0];
  const gate = deviceGate(device, host.apk.abis);
  if (!gate.ok) {
    return {
      physical_device: 'BLOCKED_DEVICE',
      capture_host: host.capture_host,
      serial: device.serial,
      reason: gate.reason,
      props: device.props,
    };
  }
  const bundle = latestBoundBundle();
  const bind = bindApkMatches(bundle, host.apk.path);
  if (!bind.ok) {
    return { physical_device: 'BLOCKED_APK', capture_host: host.capture_host, reason: bind.reason };
  }
  const stamp = captureStamp();
  const files = captureFilenames(stamp);
  const logcatPath = join(host.traces.dir, files.logcat);
  const devicePath = join(host.traces.dir, files.device);
  const evidencePath = join(host.traces.dir, files.evidence);
  const gfxtracePath = join(host.traces.dir, files.gfxtrace);

  adb(host.adb.bin, device.serial, ['logcat', '-c']);
  const install = adb(host.adb.bin, device.serial, ['install', '-r', '-d', host.apk.path], {
    timeout: 180_000,
  });
  if (install.status !== 0) {
    return {
      physical_device: 'INSTALL_FAILED',
      capture_host: host.capture_host,
      reason: install.stderr || install.stdout,
    };
  }
  const remote = `/data/local/tmp/neotavern-m0-d1a-${stamp}.apk`;
  adb(host.adb.bin, device.serial, ['push', host.apk.path, remote], { timeout: 180_000 });
  const remoteHash = adb(host.adb.bin, device.serial, ['shell', 'sha256sum', remote]);
  const remoteSha = (remoteHash.stdout || '').trim().split(/\s+/u)[0];
  adb(host.adb.bin, device.serial, ['shell', 'rm', '-f', remote]);
  if (remoteSha !== host.apk.sha256) {
    return {
      physical_device: 'HASH_MISMATCH',
      capture_host: host.capture_host,
      expected: host.apk.sha256,
      remote: remoteSha,
    };
  }

  const launch = adb(host.adb.bin, device.serial, [
    'shell',
    'am',
    'start',
    '-n',
    `${PACKAGE}/${ACTIVITY}`,
    '--ei',
    `${PACKAGE}.M0_D1A_FRAMES`,
    '100',
  ]);
  const logcat = adb(host.adb.bin, device.serial, ['logcat', '-d', '-t', '400']);
  writeFileSync(logcatPath, `${logcat.stdout || ''}\n${logcat.stderr || ''}`);
  writeFileSync(
    devicePath,
    `${JSON.stringify({ serial: device.serial, props: device.props, gate, install: install.stdout }, null, 2)}\n`,
  );
  adb(host.adb.bin, device.serial, ['shell', 'am', 'force-stop', PACKAGE]);

  const captureCommand = buildGapitTraceCommand({
    gapit: host.agi.gapit,
    serial: device.serial,
    out: gfxtracePath,
  });
  const manifest = buildEvidenceManifest({
    physical_device: 'READY_FOR_CAPTURE',
    capture_host: 'READY',
    apk_source_commit: host.provenance?.apk_source_commit,
    apk_sha256: host.provenance?.apk_sha256,
    capture_tooling_commit: host.provenance?.capture_tooling_commit,
    agi: { version: host.agi.version, build_sha: host.agi.build_sha, path: host.agi.install_path },
    apk: host.apk,
    files: {
      ...files,
      gfxtrace: gfxtracePath,
      logcat: logcatPath,
      device: devicePath,
      evidence: evidencePath,
    },
    capture_command: captureCommand,
    unblock: 'run the printed gapit trace command, then m0-d1a-capture-check.mjs',
  });
  writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    physical_device: 'READY_FOR_CAPTURE',
    capture_host: 'READY',
    serial: device.serial,
    remote_sha256: remoteSha,
    launch: (launch.stdout || '').trim(),
    files: {
      logcat: logcatPath,
      device: devicePath,
      evidence: evidencePath,
      gfxtrace: gfxtracePath,
    },
    capture_command: captureCommand,
    capture_help: formatCaptureHelp(captureCommand),
    manifest,
  };
}

function main() {
  const hostOnly = process.argv.includes('--host-only');
  const host = evaluateHost();
  if (!host.ready) {
    printJson({ ok: false, ...host });
    process.exit(2);
  }
  if (hostOnly) {
    const stamp = captureStamp();
    const files = captureFilenames(stamp);
    const captureCommand = buildGapitTraceCommand({
      gapit: host.agi.gapit,
      serial: '<PHYSICAL_SERIAL>',
      out: join(host.traces.dir, files.gfxtrace),
    });
    const manifest = buildEvidenceManifest({
      physical_device: 'BLOCKED_EXTERNAL',
      capture_host: 'READY',
      apk_source_commit: host.provenance.apk_source_commit,
      apk_sha256: host.provenance.apk_sha256,
      capture_tooling_commit: host.provenance.capture_tooling_commit,
      agi: {
        version: host.agi.version,
        build_sha: host.agi.build_sha,
        path: host.agi.install_path,
        ready: host.agi.ready,
      },
      apk: host.apk,
      files,
      capture_command: captureCommand,
      unblock:
        'plug in a physical Android phone over USB (not emulator) and re-run without --host-only',
    });
    const written = writeCaptureManifest(host.traces.dir, files, manifest);
    printJson({
      ok: true,
      capture_host: 'READY',
      physical_device: 'BLOCKED_EXTERNAL',
      apk_source_commit: host.provenance.apk_source_commit,
      apk_sha256: host.provenance.apk_sha256,
      capture_tooling_commit: host.provenance.capture_tooling_commit,
      agi: host.agi,
      java: host.java,
      adb: host.adb,
      apk: host.apk,
      vulkan_source: host.vulkan_source,
      provenance: host.provenance,
      bundle: host.bundle,
      files,
      evidence_path: written.evidencePath,
      ready_pointer: written.pointerPath,
      preset: loadPreset(),
      capture_command: captureCommand,
      capture_help: formatCaptureHelp(captureCommand),
      unblock:
        'plug in a physical Android phone over USB (not emulator) and re-run without --host-only',
    });
    process.exit(0);
  }
  const result = runDevicePreflight(host);
  const ok =
    result.physical_device === 'READY_FOR_CAPTURE' || result.physical_device === 'BLOCKED_EXTERNAL';
  printJson({ ...host, ...result, ok });
  process.exit(ok ? 0 : 3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
