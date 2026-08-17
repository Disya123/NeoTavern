#!/usr/bin/env node
/**
 * Host-side D1b adjudicator schema. The probe cannot set android_gpu_capture.
 * This script does not rewrite D1a evidence. PASS JSON is written only with
 * --write after physical artifacts exist (separate evidence commit).
 *
 *   node scripts/m0-d1b-adjudicate.mjs --stamp=... --control-stamp=...
 *   node scripts/m0-d1b-adjudicate.mjs --stamp=... --control-stamp=... --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  extractCopyImages,
  extractCreateDeviceIds,
  extractCreateImageCount,
  extractDebugLabels,
  extractNamedResources,
  extractQueueSubmitCount,
  forbiddenCommands,
  hashIfPresent,
} from './m0-d1a-adjudicate.mjs';
import {
  ACCUMULATOR_LABEL,
  DEFAULT_APK,
  PINNED_CAPTURE_TOOLING_COMMIT,
  ROOT,
  SNAPSHOT_LABEL,
  classifyRenderdocApi,
  latestBoundBundle,
} from './m0-d1a-capture-host.mjs';

export const ADJUDICATION_SCHEMA = 'm0-d1b-adjudication/v1';
export const CAPTURES_DIR_D1B = join(ROOT, 'apps', 'android', 'm0-d1b-captures');
export const MOVING_LABEL = 'm0-d1b-moving';
export const MOVING_BLIT_G120 = 'm0-d1b-moving-blit:g120';
export const ROI_READ_2 = 'm0-d1b-roi-read:2';
export const GLASS_B_G120 = 'm0-d1b-glass:2:g120';
export const RESTORE_STATIC = 'm0-d1b-restore-static';
export const D1B_GOLDEN_TIMELINE =
  'clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,moving:g0,roi:2,glass:2:g0,raster,blit';
export const D1B_MOTION_TIMELINE_G120 = 'restore,moving:g120,roi:2,glass:2:g120,overlay';
export const ACCUMULATOR_PX = { w: 320, h: 200 };
export const SNAPSHOT_MAX = 256;
export const MOVING_SIZE = 64;
export const EXPECTED_ACC_BYTES = 1_046_528;
export const GOLDEN_D1B_COUNTERS = {
  devices: 1,
  readbacks: 0,
  xdev: 0,
  roi_copies: 1001,
  raster: 4,
  glass: 1001,
  moving_blits: 1000,
  pass_compiles: 1,
  vello_rebuilds: 4,
  layout_rebuilds: 0,
  ui_rebuilds: 0,
  sampled_gen: 999,
  frames: 1000,
  timeline: D1B_GOLDEN_TIMELINE,
  capture_timeline: D1B_MOTION_TIMELINE_G120,
  render_polls: 0,
};

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

export function artifactPaths(stamp, dir = CAPTURES_DIR_D1B) {
  const base = join(dir, `${stamp}-d1b`);
  return {
    rdc: `${base}.rdc`,
    xml: `${base}.xml`,
    logcat: `${base}-logcat.txt`,
    evidence: `${base}-evidence.json`,
    device: `${base}-device.json`,
  };
}

export function parseD1bLogLine(log) {
  const lines = String(log)
    .split(/\r?\n/u)
    .filter((row) => /m0-d1b gpu_ran=/u.test(row));
  const line = lines.at(-1);
  if (!line) {
    return { ok: false, values: null, line: null, reason: 'no m0-d1b gpu_ran line' };
  }
  const num = (name) => {
    const match = line.match(new RegExp(`${name}=(\\d+)`));
    return match ? Number(match[1]) : null;
  };
  const flag = (name) => {
    const match = line.match(new RegExp(`${name}=(true|false)`));
    return match ? match[1] === 'true' : null;
  };
  const timeline = line.match(/(?:^|\s)timeline=([^\s]+)/u)?.[1] ?? '';
  const captureTimeline = line.match(/(?:^|\s)capture_timeline=([^\s]+)/u)?.[1] ?? '';
  const values = {
    devices: num('devices'),
    readbacks: num('readbacks'),
    xdev: num('xdev'),
    roi_copies: num('roi_copies'),
    raster: num('raster'),
    glass: num('glass'),
    moving_blits: num('moving_blits'),
    pass_compiles: num('pass_compiles'),
    vello_rebuilds: num('vello_rebuilds'),
    layout_rebuilds: num('layout_rebuilds'),
    ui_rebuilds: num('ui_rebuilds'),
    sampled_gen: num('sampled_gen'),
    frames: num('frames'),
    render_polls: num('render_polls'),
    capture_polls: num('capture_polls'),
    acc_bytes: num('acc_bytes'),
    capture: flag('capture'),
    timeline,
    capture_timeline: captureTimeline,
  };
  const ok =
    values.devices === GOLDEN_D1B_COUNTERS.devices &&
    values.readbacks === GOLDEN_D1B_COUNTERS.readbacks &&
    values.xdev === GOLDEN_D1B_COUNTERS.xdev &&
    values.roi_copies === GOLDEN_D1B_COUNTERS.roi_copies &&
    values.raster === GOLDEN_D1B_COUNTERS.raster &&
    values.glass === GOLDEN_D1B_COUNTERS.glass &&
    values.moving_blits === GOLDEN_D1B_COUNTERS.moving_blits &&
    values.pass_compiles === GOLDEN_D1B_COUNTERS.pass_compiles &&
    values.vello_rebuilds === GOLDEN_D1B_COUNTERS.vello_rebuilds &&
    values.layout_rebuilds === GOLDEN_D1B_COUNTERS.layout_rebuilds &&
    values.ui_rebuilds === GOLDEN_D1B_COUNTERS.ui_rebuilds &&
    values.sampled_gen === GOLDEN_D1B_COUNTERS.sampled_gen &&
    values.frames === GOLDEN_D1B_COUNTERS.frames &&
    values.timeline === GOLDEN_D1B_COUNTERS.timeline &&
    values.capture_timeline === GOLDEN_D1B_COUNTERS.capture_timeline &&
    values.render_polls === GOLDEN_D1B_COUNTERS.render_polls &&
    values.capture === false &&
    values.acc_bytes === EXPECTED_ACC_BYTES;
  return {
    ok,
    values,
    line,
    reason: ok
      ? 'golden D1b counters/timeline; capture bit false; render_polls=0'
      : 'D1b counters, timeline, capture bit, or render_polls diverged',
  };
}

export function checkD1bPassOrder(labels) {
  const restore = labels.indexOf(RESTORE_STATIC);
  const moving = labels.indexOf(MOVING_BLIT_G120);
  const roi2 = labels.indexOf(ROI_READ_2);
  const glass2 = labels.indexOf(GLASS_B_G120);
  const staleGlass = labels.filter(
    (name) => /^m0-d1b-glass:2:g\d+$/u.test(name) && name !== GLASS_B_G120,
  );
  const ok =
    restore >= 0 && moving > restore && roi2 > moving && glass2 > roi2 && staleGlass.length === 0;
  return {
    ok,
    indices: { restore, moving, roi2, glass2 },
    stale_glass: staleGlass,
    reason: ok
      ? 'moving-blit:g120 → accumulator current generation → roi:2 → glass:2:g120'
      : `D1b motion order failed restore=${restore} moving=${moving} roi2=${roi2} glass2=${glass2} stale=${staleGlass.join(',')}`,
  };
}

export function checkD1bRoiCopies(copies, names) {
  const accId = [...names.entries()].find(([, name]) => name === ACCUMULATOR_LABEL)?.[0];
  const snapId = [...names.entries()].find(([, name]) => name === SNAPSHOT_LABEL)?.[0];
  const movingId = [...names.entries()].find(([, name]) => name === MOVING_LABEL)?.[0];
  const movingBlit = copies.find(
    (row) =>
      row.src === movingId && row.dst === accId && row.w === MOVING_SIZE && row.h === MOVING_SIZE,
  );
  const roiCopies = copies.filter((row) => row.src === accId && row.dst === snapId);
  const roi = roiCopies.at(-1);
  const roiOk =
    !!roi &&
    roi.w * roi.h < ACCUMULATOR_PX.w * ACCUMULATOR_PX.h &&
    roi.w <= SNAPSHOT_MAX &&
    roi.h <= SNAPSHOT_MAX &&
    roi.w > 0 &&
    roi.h > 0;
  return {
    ok: !!movingBlit && roiOk,
    accumulator_id: accId ?? null,
    snapshot_id: snapId ?? null,
    moving_id: movingId ?? null,
    moving_blit: movingBlit ?? null,
    roi: roi ?? null,
    reason:
      !!movingBlit && roiOk
        ? 'moving 64×64 blit into named accumulator; Glass B ROI copy is bounded'
        : 'moving blit or bounded Glass B ROI copy missing',
  };
}

export function checkD1bLifetime(xml, captureLog, controlLog) {
  const capture = parseD1bLogLine(captureLog);
  const control = parseD1bLogLine(controlLog);
  const devices = extractCreateDeviceIds(xml);
  const images = extractCreateImageCount(xml);
  const submits = extractQueueSubmitCount(xml);
  const validation = /VUID-|VALIDATION ERROR|DEVICE_LOST|stale handle/iu.test(
    `${captureLog}\n${xml}`,
  );
  const sameGolden =
    capture.ok &&
    control.ok &&
    capture.values.devices === control.values.devices &&
    capture.values.readbacks === control.values.readbacks &&
    capture.values.xdev === control.values.xdev &&
    capture.values.moving_blits === control.values.moving_blits &&
    capture.values.pass_compiles === control.values.pass_compiles &&
    capture.values.vello_rebuilds === control.values.vello_rebuilds &&
    capture.values.layout_rebuilds === control.values.layout_rebuilds &&
    capture.values.ui_rebuilds === control.values.ui_rebuilds &&
    capture.values.frames === control.values.frames &&
    capture.values.render_polls === 0 &&
    control.values.render_polls === 0 &&
    control.values.capture_polls === 0 &&
    capture.values.acc_bytes === control.values.acc_bytes &&
    capture.values.acc_bytes === EXPECTED_ACC_BYTES;
  const capturePollSplit =
    capture.values?.capture_polls === 1 || capture.values?.capture_polls === 0;
  const ended = /capture_ended=true/.test(captureLog) && /m0-d1b gpu_ran=true/.test(captureLog);
  return {
    ok: sameGolden && ended && !validation && capturePollSplit && devices.length <= 2,
    capture_counters: capture,
    control_counters: control,
    vk_device_ids: devices,
    vk_create_image: images,
    vk_queue_submit: submits,
    validation_errors: validation,
    high_water_stable: capture.values?.acc_bytes === control.values?.acc_bytes,
    capture_poll_not_render_wait:
      capture.values?.render_polls === 0 && control.values?.render_polls === 0,
    reason:
      sameGolden && ended && !validation
        ? '1000-frame golden on both runs; acc_bytes stable; render_polls=0; capture poll is not a production wait'
        : 'D1b lifetime/counter/validation check failed',
  };
}

export function classifyD1bDump(text) {
  const api = classifyRenderdocApi(text);
  const required = [MOVING_BLIT_G120, ROI_READ_2, GLASS_B_G120, ACCUMULATOR_LABEL];
  const missing = required.filter((label) => !text.includes(label));
  return {
    ok: api.ok && api.api === 'Vulkan' && missing.length === 0,
    missing,
    api,
    reason:
      api.ok && missing.length === 0
        ? 'Vulkan dump contains moving-blit:g120, roi:2, glass:2:g120, named accumulator'
        : missing.length
          ? `capture incomplete: missing ${missing.join(',')}`
          : api.reason,
  };
}

export function adjudicate({
  stamp,
  controlStamp,
  apkPath = DEFAULT_APK,
  capturesDir = CAPTURES_DIR_D1B,
} = {}) {
  if (!stamp || !controlStamp) {
    return {
      schema: ADJUDICATION_SCHEMA,
      ok: false,
      d1b_verdict: 'NOT_STARTED',
      android_gpu_capture: false,
      reason: 'stamp and control-stamp are required; this is not D1b PASS',
    };
  }
  const captureFiles = artifactPaths(stamp, capturesDir);
  const controlFiles = artifactPaths(controlStamp, capturesDir);
  const bundle = latestBoundBundle();
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
      (!bundle?.apk_sha256 || hashes.apk.sha256 === bundle.apk_sha256) &&
      hashes.rdc.bytes > 100_000 &&
      hashes.xml.bytes > 100_000,
    hashes,
    expected_apk_sha256: bundle?.apk_sha256 ?? null,
    reason: 'SHA-256 recorded for .rdc, XML, both logs, and bound APK',
  });

  const api = classifyRenderdocApi(xml);
  push('driver', {
    ok: api.ok && api.api === 'Vulkan',
    api,
    reason: api.reason,
  });

  const names = extractNamedResources(xml);
  const labels = extractDebugLabels(xml).filter((name) => name.startsWith('m0-d1b-'));
  const copies = extractCopyImages(xml);
  push('pass_order', checkD1bPassOrder(labels));
  push('roi_identity', checkD1bRoiCopies(copies, names));
  const dump = classifyD1bDump(`${captureLog}\n${xml}`);
  push('dump', dump);
  const forbidden = forbiddenCommands(xml);
  push('no_readback', {
    ok: forbidden.length === 0,
    forbidden,
    reason:
      forbidden.length === 0
        ? 'no vkMapMemory / image-to-buffer in the Event Browser'
        : `forbidden commands: ${forbidden.join(',')}`,
  });
  push('lifetime_and_counters', checkD1bLifetime(xml, captureLog, controlLog));

  const ok = checks.every((row) => row.ok);
  return {
    schema: ADJUDICATION_SCHEMA,
    capture_tooling_commit: PINNED_CAPTURE_TOOLING_COMMIT,
    stamp,
    control_stamp: controlStamp,
    ok,
    android_gpu_capture: ok,
    capture_driver: api.api ?? null,
    capture_admissible: ok,
    d1b_verdict: ok ? 'PASS' : 'FAIL',
    d1a_verdict: 'UNCHANGED',
    track_d_go: 'NOT_GRANTED',
    checks,
    apk_sha256: hashes.apk.sha256,
    rdc_sha256: hashes.rdc.sha256,
    xml_sha256: hashes.xml.sha256,
    note: 'probe log capture=false expected; host admission only; not D1=Track D GO',
  };
}

function main() {
  const stamp = argValue('stamp');
  const controlStamp = argValue('control-stamp');
  const apkPath = argValue('apk') || DEFAULT_APK;
  const write = process.argv.includes('--write');
  const record = adjudicate({ stamp, controlStamp, apkPath });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (write && record.ok) {
    const out = join(ROOT, 'docs', 'rfc', 'm0-d1b-adjudication.json');
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  }
  process.exit(record.ok ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
