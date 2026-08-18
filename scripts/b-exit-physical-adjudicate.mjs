#!/usr/bin/env node
/**
 * Independent host adjudicators for PERF-15, PERF-22, and device-loss.
 * Failure of one criterion never blocks writing the other two records.
 * None of these scripts stamp Milestone B PASS. PERF-15 cannot PASS without
 * a real VisualSurface path (`visual_surface=present`).
 *
 *   node scripts/b-exit-physical-adjudicate.mjs
 *   node scripts/b-exit-physical-adjudicate.mjs --write
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { parseKvLine } from './perf-18-20-adjudicate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PERF15_RECORD = join(ROOT, 'docs', 'rfc', 'perf-15-adjudication.json');
export const PERF22_RECORD = join(ROOT, 'docs', 'rfc', 'perf-22-adjudication.json');
export const DEVICE_LOSS_RECORD = join(ROOT, 'docs', 'rfc', 'device-loss-adjudication.json');
export const PERF15_SCHEMA = 'perf-15-adjudication/v1';
export const PERF22_SCHEMA = 'perf-22-adjudication/v1';
export const DEVICE_LOSS_SCHEMA = 'device-loss-adjudication/v1';

function flag(line, key, expected) {
  const parsed = parseKvLine(line || '', '');
  const body = String(line || '');
  const hit = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, 'u').exec(body);
  const value = hit ? hit[1] : parsed.values[key];
  return {
    id: key,
    ok: expected === undefined ? Boolean(value) : String(value) === String(expected),
    value: value ?? null,
  };
}

function allOk(checks) {
  return checks.every((row) => row.ok);
}

export function evaluatePerf15({ log = '', platformLog = '', provenance = {} } = {}) {
  const checks = [
    flag(log, 'visual_surface', 'present'),
    flag(log, 'fling_items', '10000'),
    flag(log, 'live_glass', 'true'),
    flag(log, 'image_decode', 'true'),
    flag(log, 'image_upload', 'true'),
    flag(log, 'viewport_kept', 'true'),
    flag(log, 'protected_kept', 'true'),
    flag(log, 'lkg_kept', 'true'),
    flag(log, 'oom_loops', '0'),
    flag(log, 'blank_px', '0'),
  ];
  const visual = checks[0];
  const physical =
    provenance.apk_linkage === 'BOUND' &&
    provenance.evidence_dirty === false &&
    /ran_on_android=true/u.test(log);
  const otherOk = checks.slice(1).every((row) => row.ok);
  let status = 'IMPLEMENTED';
  if (visual.ok && otherOk && physical) status = 'PASS';
  else if (!visual.ok) status = 'IMPLEMENTED';
  else if (!physical) status = 'IMPLEMENTED';
  else status = 'BLOCKED';
  return {
    schema: PERF15_SCHEMA,
    perf15: status,
    visual_surface: visual.value ?? 'missing',
    physical: Boolean(physical && visual.ok),
    admissible: status === 'PASS',
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    reason: visual.ok
      ? status === 'PASS'
        ? 'physical pressure fixture with VisualSurface'
        : 'VisualSurface present but other PERF-15 gates failed'
      : 'PERF-15 stays IMPLEMENTED: no real VisualSurface path (not a synthetic substitute)',
    checks,
    platform: Boolean(platformLog),
  };
}

export function evaluatePerf22({ log = '', platformLog = '', xml = '', provenance = {} } = {}) {
  const checks = [
    flag(log, 'capability_before_passes', 'true'),
    flag(log, 'webview_hits', '0'),
    flag(log, 'surface_hits', '0'),
    flag(log, 'image_readbacks', '0'),
    flag(log, 'xdev', '0'),
    flag(log, 'same_epoch_rejected', 'true'),
    flag(platformLog, 'webview', 'android.webkit.WebView'),
    flag(platformLog, 'secure_surface', 'true'),
    flag(platformLog, 'tap_hit', 'fallback'),
    flag(platformLog, 'fallback_visible', 'true'),
    {
      id: 'renderdoc_or_host_labels',
      ok:
        String(xml).includes('perf22') ||
        String(log).includes('perf22-fallback') ||
        String(log).includes('labels='),
    },
  ];
  const physical =
    provenance.apk_linkage === 'BOUND' &&
    provenance.evidence_dirty === false &&
    Boolean(platformLog);
  const status = physical && allOk(checks) ? 'PASS' : physical ? 'BLOCKED' : 'IMPLEMENTED';
  return {
    schema: PERF22_SCHEMA,
    perf22: status,
    physical: Boolean(physical && status === 'PASS'),
    admissible: status === 'PASS',
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    reason:
      status === 'PASS'
        ? 'Android WebView + secure SurfaceView fallback fixture'
        : physical
          ? 'platform fixture present but a PERF-22 check failed'
          : 'PERF-22 stays IMPLEMENTED until the Android platform-surface fixture is captured',
    checks,
  };
}

export function evaluateDeviceLoss({ log = '', provenance = {} } = {}) {
  const destroyed = flag(log, 'wgpu_destroyed', 'true');
  const recreated = flag(log, 'wgpu_recreated', 'true');
  const android = /ran_on_android=true/u.test(log);
  const checks = [
    destroyed,
    recreated,
    flag(log, 'device_epoch_bumps', '1'),
    flag(log, 'stale_handle_rejected', 'true'),
    flag(log, 'live_wgpu_devices', '1'),
    flag(log, 'catch_up_burst', '0'),
    flag(log, 'mixed_epoch', 'false'),
    {
      id: 'ran_on_android',
      ok: android,
      value: android,
    },
  ];
  const physical =
    provenance.apk_linkage === 'BOUND' &&
    provenance.evidence_dirty === false &&
    destroyed.ok &&
    recreated.ok &&
    android;
  const status =
    physical && allOk(checks)
      ? 'PASS'
      : destroyed.ok && !android
        ? 'CPU_INJECTION'
        : 'CPU_INJECTION';
  return {
    schema: DEVICE_LOSS_SCHEMA,
    device_loss: physical && allOk(checks) ? 'PASS' : 'CPU_INJECTION',
    physical: Boolean(physical && allOk(checks)),
    admissible: physical && allOk(checks),
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    reason:
      physical && allOk(checks)
        ? 'shared wgpu device destroyed and recreated on device'
        : 'device-loss stays CPU_INJECTION until a physical wgpu destroy/recreate is captured',
    checks,
    status,
  };
}

export function adjudicateIndependent(input = {}) {
  const perf15 = evaluatePerf15(input.perf15 ?? {});
  const perf22 = evaluatePerf22(input.perf22 ?? {});
  const deviceLoss = evaluateDeviceLoss(input.deviceLoss ?? {});
  return {
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    perf15,
    perf22,
    deviceLoss,
  };
}

export function writeIndependent(result, { write = false } = {}) {
  const files = [
    { path: PERF15_RECORD, body: result.perf15 },
    { path: PERF22_RECORD, body: result.perf22 },
    { path: DEVICE_LOSS_RECORD, body: result.deviceLoss },
  ];
  const written = [];
  for (const file of files) {
    try {
      if (write) {
        writeFileSync(file.path, `${JSON.stringify(file.body, null, 2)}\n`);
      }
      written.push({
        path: file.path,
        status: file.body.perf15 ?? file.body.perf22 ?? file.body.device_loss,
        ok: true,
      });
    } catch (err) {
      written.push({ path: file.path, ok: false, error: String(err) });
    }
  }
  return written;
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function readIf(path) {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function main() {
  const write = process.argv.includes('--write');
  const provenance = {
    apk_linkage: argValue('apk-linkage') ?? 'UNBOUND',
    evidence_dirty: argValue('evidence-dirty') === 'true',
  };
  if (argValue('evidence-dirty') === 'false') provenance.evidence_dirty = false;
  const result = adjudicateIndependent({
    perf15: {
      log: readIf(argValue('perf15-log')),
      platformLog: readIf(argValue('perf15-platform')),
      provenance,
    },
    perf22: {
      log: readIf(argValue('perf22-log')),
      platformLog: readIf(argValue('perf22-platform')),
      xml: readIf(argValue('perf22-xml')),
      provenance,
    },
    deviceLoss: {
      log: readIf(argValue('device-loss-log')),
      provenance,
    },
  });
  const written = writeIndependent(result, { write });
  process.stdout.write(`${JSON.stringify({ result, written }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
