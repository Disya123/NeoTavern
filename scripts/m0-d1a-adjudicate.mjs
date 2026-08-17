#!/usr/bin/env node
/**
 * Host-side D1a adjudicator. The probe cannot set android_gpu_capture;
 * this script hashes artifacts, checks the RenderDoc Event Browser tree,
 * and writes the evidence-admission record.
 *
 *   node scripts/m0-d1a-adjudicate.mjs
 *   node scripts/m0-d1a-adjudicate.mjs --stamp=2026-08-17T17-18-59-431Z
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ACCUMULATOR_LABEL,
  CAPTURES_DIR,
  DEFAULT_APK,
  GOLDEN_D1A_COUNTERS,
  PINNED_CAPTURE_TOOLING_COMMIT,
  ROOT,
  SNAPSHOT_LABEL,
  classifyRenderdocApi,
  parseProbeLogLine,
  sha256File,
} from './m0-d1a-capture-host.mjs';

export const ADJUDICATION_SCHEMA = 'm0-d1a-adjudication/v1';
export const DEFAULT_STAMP = '2026-08-17T17-18-59-431Z';
export const CONTROL_STAMP = '2026-08-17T17-17-50-237Z';
export const BOUND_APK_COMMIT = '2d72a3cd5ab6684824f411be62173250e9d23398';
export const EXPECTED_APK_SHA256 =
  '478a4593fa4ea58402ba3e17a3a357e2a5d8481146ad20ede34eb2cb2ef99f7c';
export const ACCUMULATOR_PX = { w: 320, h: 200 };
export const EXPECTED_ROI = {
  1: { x: 24, y: 40, w: 140, h: 80 },
  2: { x: 80, y: 70, w: 140, h: 80 },
};
export const SNAPSHOT_MAX = 256;

const FORBIDDEN_CMDS = [
  'vkMapMemory',
  'vkMapMemory2',
  'vkMapMemory2KHR',
  'vkCmdCopyImageToBuffer',
  'vkCmdCopyImageToBuffer2',
  'vkCmdCopyBufferToHost',
];

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function artifactPaths(stamp, dir = CAPTURES_DIR) {
  const base = join(dir, `${stamp}-d1a`);
  return {
    rdc: `${base}.rdc`,
    xml: `${base}.xml`,
    logcat: `${base}-logcat.txt`,
    evidence: `${base}-evidence.json`,
    device: `${base}-device.json`,
  };
}

export function hashIfPresent(path, root = ROOT) {
  if (!path || !existsSync(path)) return { path, present: false, sha256: null, bytes: 0 };
  const rel = path.startsWith(root) ? path.slice(root.length + 1).replaceAll('\\', '/') : path;
  return {
    path: rel,
    present: true,
    sha256: sha256File(path),
    bytes: statSync(path).size,
  };
}

export function extractNamedResources(xml) {
  const names = new Map();
  const re =
    /<ResourceId name="Object"[^>]*>(\d+)<\/ResourceId>\s*<string name="ObjectName"[^>]*>([^<]+)<\/string>/gu;
  for (const match of xml.matchAll(re)) {
    names.set(match[1], match[2]);
  }
  return names;
}

export function extractDebugLabels(xml) {
  const labels = [];
  const re = /<chunk [^>]*name="vkCmdBeginDebugUtilsLabelEXT"[^>]*>[\s\S]*?<string name="pLabelName"[^>]*>([^<]+)<\/string>/gu;
  for (const match of xml.matchAll(re)) {
    labels.push(match[1]);
  }
  return labels;
}

export function extractCopyImages(xml) {
  const copies = [];
  const re =
    /<chunk [^>]*name="vkCmdCopyImage"[^>]*>[\s\S]*?<ResourceId name="srcImage"[^>]*>(\d+)<\/ResourceId>[\s\S]*?<ResourceId name="destImage"[^>]*>(\d+)<\/ResourceId>[\s\S]*?<struct name="srcOffset"[\s\S]*?<int name="x"[^>]*>(\d+)<\/int>\s*<int name="y"[^>]*>(\d+)<\/int>[\s\S]*?<struct name="extent"[\s\S]*?<uint name="width"[^>]*>(\d+)<\/uint>\s*<uint name="height"[^>]*>(\d+)<\/uint>/gu;
  for (const match of xml.matchAll(re)) {
    copies.push({
      src: match[1],
      dst: match[2],
      x: Number(match[3]),
      y: Number(match[4]),
      w: Number(match[5]),
      h: Number(match[6]),
    });
  }
  return copies;
}

export function extractQueueSubmitCount(xml) {
  return [...xml.matchAll(/name="vkQueueSubmit"/gu)].length;
}

export function extractCreateImageCount(xml) {
  return [...xml.matchAll(/name="vkCreateImage"/gu)].length;
}

export function extractCreateDeviceIds(xml) {
  const ids = new Set();
  const re = /<chunk [^>]*name="vkCreateDevice"[\s\S]*?<ResourceId name="Device"[^>]*>(\d+)<\/ResourceId>/gu;
  for (const match of xml.matchAll(re)) ids.add(match[1]);
  if (ids.size === 0) {
    const fallback = xml.matchAll(/<ResourceId name="device" typename="VkDevice"[^>]*>(\d+)<\/ResourceId>/gu);
    for (const match of fallback) ids.add(match[1]);
  }
  return [...ids];
}

export function forbiddenCommands(xml) {
  return FORBIDDEN_CMDS.filter((name) => xml.includes(`name="${name}"`) || xml.includes(`>${name}<`));
}

export function checkPassOrder(labels) {
  const roi1 = labels.indexOf('m0-d1a-roi-read:1');
  const glass1 = labels.indexOf('m0-d1a-glass:1');
  const roi2 = labels.indexOf('m0-d1a-roi-read:2');
  const glass2 = labels.indexOf('m0-d1a-glass:2');
  const blitBetween = labels.filter(
    (name, i) => name === 'm0-d1a-blit-pass' && i > glass1 && i < roi2,
  ).length;
  const ok =
    roi1 >= 0 && glass1 > roi1 && roi2 > glass1 && glass2 > roi2 && blitBetween >= 1;
  return {
    ok,
    indices: { roi1, glass1, roi2, glass2 },
    blit_mutations_between_glasses: blitBetween,
    reason: ok
      ? 'ROI-1 → glass-1 → raster/blit mutations → ROI-2 → glass-2'
      : `pass order failed roi1=${roi1} glass1=${glass1} blit_between=${blitBetween} roi2=${roi2} glass2=${glass2}`,
  };
}

export function checkRoiCopies(copies, names) {
  const accId = [...names.entries()].find(([, name]) => name === ACCUMULATOR_LABEL)?.[0];
  const snapId = [...names.entries()].find(([, name]) => name === SNAPSHOT_LABEL)?.[0];
  const roiCopies = copies.filter((row) => row.src === accId && row.dst === snapId);
  const expected = [EXPECTED_ROI[1], EXPECTED_ROI[2]];
  const matches = expected.map((want, i) => {
    const got = roiCopies[i];
    const ok =
      !!got &&
      got.x === want.x &&
      got.y === want.y &&
      got.w === want.w &&
      got.h === want.h &&
      got.w * got.h < ACCUMULATOR_PX.w * ACCUMULATOR_PX.h &&
      got.w <= SNAPSHOT_MAX &&
      got.h <= SNAPSHOT_MAX;
    return { want, got: got ?? null, ok };
  });
  return {
    ok: matches.every((row) => row.ok) && roiCopies.length >= 2,
    accumulator_id: accId ?? null,
    snapshot_id: snapId ?? null,
    copies: roiCopies,
    matches,
    reason: matches.every((row) => row.ok)
      ? 'both ROIs copy named accumulator → glass-roi at 140×80, smaller than 320×200'
      : 'ROI copy identity or size failed',
  };
}

export function checkNoFlatten(labels, copies, names) {
  const accId = [...names.entries()].find(([, name]) => name === ACCUMULATOR_LABEL)?.[0];
  const fullCopies = copies.filter(
    (row) =>
      row.src === accId && row.x === 0 && row.y === 0 && row.w >= ACCUMULATOR_PX.w && row.h >= ACCUMULATOR_PX.h,
  );
  const blitCount = labels.filter((name) => name === 'm0-d1a-blit-pass').length;
  const rasterCount = labels.filter((name) => name === 'm0-d1a-vello' || name.includes('vello')).length;
  const ok = blitCount >= 4 && fullCopies.length === 0;
  return {
    ok,
    blit_passes: blitCount,
    vello_labels: rasterCount,
    full_accumulator_copies: fullCopies.length,
    reason: ok
      ? 'four blit passes; no full-target flatten copy of the accumulator'
      : `flatten suspected blit=${blitCount} full_copies=${fullCopies.length}`,
  };
}

export function checkLifetime(xml, captureLog, controlLog) {
  const capture = parseProbeLogLine(captureLog);
  const control = parseProbeLogLine(controlLog);
  const devices = extractCreateDeviceIds(xml);
  const images = extractCreateImageCount(xml);
  const submits = extractQueueSubmitCount(xml);
  const validation = /VUID-|VALIDATION ERROR|DEVICE_LOST|vkGetDeviceProcAddr failed/iu.test(
    captureLog,
  );
  const countersMatch =
    capture.ok &&
    control.ok &&
    capture.values.devices === GOLDEN_D1A_COUNTERS.devices &&
    capture.values.readbacks === GOLDEN_D1A_COUNTERS.readbacks &&
    capture.values.xdev === GOLDEN_D1A_COUNTERS.xdev &&
    capture.values.roi_copies === GOLDEN_D1A_COUNTERS.roi_copies &&
    capture.values.glass === GOLDEN_D1A_COUNTERS.glass &&
    capture.values.raster === GOLDEN_D1A_COUNTERS.raster &&
    capture.values.frames === GOLDEN_D1A_COUNTERS.frames &&
    capture.values.timeline === GOLDEN_D1A_COUNTERS.timeline &&
    JSON.stringify(capture.values) === JSON.stringify(control.values);
  const ended = /capture_ended=true/.test(captureLog) && /gpu_ran=true/.test(captureLog);
  const accBytes = (log) => {
    const match = String(log).match(/acc_bytes=(\d+)/u);
    return match ? Number(match[1]) : 0;
  };
  const captureAcc = accBytes(capture.line ?? '');
  const controlAcc = accBytes(control.line ?? '');
  const highWaterStable = captureAcc > 0 && captureAcc === controlAcc;
  return {
    ok:
      countersMatch &&
      ended &&
      !validation &&
      highWaterStable &&
      capture.values.devices === 1 &&
      devices.length <= 2 &&
      images > 0 &&
      submits > 0,
    capture_counters: capture,
    control_counters: control,
    vk_device_ids: devices,
    vk_create_image: images,
    vk_queue_submit: submits,
    validation_errors: validation,
    fences_completed: ended,
    acc_bytes: { capture: captureAcc, control: controlAcc },
    high_water_stable: highWaterStable,
    reason: countersMatch && ended && !validation && highWaterStable
      ? '100-frame counters golden on both runs; acc_bytes high-water unchanged; capture ended after poll; no validation hits'
      : 'lifetime/counter/validation check failed',
  };
}

export function adjudicate({
  stamp = DEFAULT_STAMP,
  controlStamp = CONTROL_STAMP,
  apkPath = DEFAULT_APK,
  capturesDir = CAPTURES_DIR,
} = {}) {
  const captureFiles = artifactPaths(stamp, capturesDir);
  const controlFiles = artifactPaths(controlStamp, capturesDir);
  const hashes = {
    rdc: hashIfPresent(captureFiles.rdc),
    xml: hashIfPresent(captureFiles.xml),
    capture_log: hashIfPresent(captureFiles.logcat),
    control_log: hashIfPresent(controlFiles.logcat),
    apk: hashIfPresent(apkPath),
  };
  const xml = hashes.xml.present ? readFileSync(captureFiles.xml, 'utf8') : '';
  const captureLog = hashes.capture_log.present ? readFileSync(captureFiles.logcat, 'utf8') : '';
  const controlLog = hashes.control_log.present ? readFileSync(controlFiles.logcat, 'utf8') : '';

  const checks = [];
  const push = (id, result) => {
    checks.push({ id, ...result });
  };

  push('hashes', {
    ok:
      hashes.rdc.present &&
      hashes.xml.present &&
      hashes.capture_log.present &&
      hashes.control_log.present &&
      hashes.apk.present &&
      hashes.apk.sha256 === EXPECTED_APK_SHA256 &&
      hashes.rdc.bytes > 100_000 &&
      hashes.xml.bytes > 100_000,
    hashes,
    expected_apk_sha256: EXPECTED_APK_SHA256,
    reason:
      hashes.apk.sha256 === EXPECTED_APK_SHA256
        ? 'SHA-256 recorded for .rdc, XML, both logs, and bound APK'
        : 'artifact hash or APK mismatch',
  });

  const api = classifyRenderdocApi(xml);
  push('driver', {
    ok: api.ok && api.api === 'Vulkan',
    api,
    reason: api.reason,
  });

  const names = extractNamedResources(xml);
  const labels = extractDebugLabels(xml).filter((name) => name.startsWith('m0-d1a-'));
  const copies = extractCopyImages(xml);
  push('pass_order', checkPassOrder(labels));
  push('roi_identity', checkRoiCopies(copies, names));
  push('no_flatten', checkNoFlatten(labels, copies, names));
  const forbidden = forbiddenCommands(xml);
  push('no_readback', {
    ok: forbidden.length === 0,
    forbidden,
    reason:
      forbidden.length === 0
        ? 'no vkMapMemory / image-to-buffer in the Event Browser'
        : `forbidden commands: ${forbidden.join(',')}`,
  });
  push('lifetime_and_counters', checkLifetime(xml, captureLog, controlLog));

  const failed = checks.filter((row) => !row.ok);
  const pass = failed.length === 0;
  return {
    schema: ADJUDICATION_SCHEMA,
    status: pass ? 'PASS' : 'PENDING_ADJUDICATION',
    d1a_verdict: pass ? 'PASS' : 'PENDING_ADJUDICATION',
    d1a_program: pass ? 'PASS' : 'PENDING_ADJUDICATION',
    android_gpu_capture: pass,
    capture_driver: api.api === 'Vulkan' ? 'Vulkan' : api.api,
    capture_admissible: pass,
    d1b: 'NOT_STARTED',
    environment_blocked: false,
    stamp,
    control_stamp: controlStamp,
    apk_source_commit: BOUND_APK_COMMIT,
    capture_tooling_commit: PINNED_CAPTURE_TOOLING_COMMIT,
    checks,
    failed: failed.map((row) => row.id),
    labels,
    named_resources: Object.fromEntries(
      [...names.entries()].filter(([, name]) => String(name).startsWith('m0-d1a-')),
    ),
    note: pass
      ? 'host-side admission; probe log capture=false is expected; D1=Track D GO is not granted'
      : `failed: ${failed.map((row) => row.id).join(',')}`,
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const xmlPath = artifactPaths(argValue('stamp') || DEFAULT_STAMP).xml;
  if (!existsSync(xmlPath)) {
    printJson({
      ok: false,
      stage: 'artifacts',
      reason: `missing ${xmlPath}; lab-only adjudicator does not rewrite the committed PASS record`,
    });
    process.exit(2);
  }
  const result = adjudicate({
    stamp: argValue('stamp') || DEFAULT_STAMP,
    controlStamp: argValue('control-stamp') || CONTROL_STAMP,
  });
  const out = join(ROOT, 'docs', 'rfc', 'm0-d1a-adjudication.json');
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const captureFiles = artifactPaths(result.stamp);
  if (existsSync(captureFiles.evidence)) {
    const evidence = JSON.parse(readFileSync(captureFiles.evidence, 'utf8'));
    writeFileSync(
      captureFiles.evidence,
      `${JSON.stringify(
        {
          ...evidence,
          android_gpu_capture: result.android_gpu_capture,
          capture_driver: result.capture_driver,
          capture_admissible: result.capture_admissible,
          d1a_verdict: result.d1a_verdict,
          d1a: result.d1a_verdict,
          adjudication: out,
        },
        null,
        2,
      )}\n`,
    );
  }
  printJson({ ...result, written: out });
  process.exit(result.d1a_verdict === 'PASS' ? 0 : 4);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
