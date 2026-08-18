#!/usr/bin/env node
/**
 * Host-side shared-device raster↔compositor adjudicator. Logcat is smoke.
 * RenderDoc XML is the GPU resource chain. Milestone B stays STARTED.
 *
 *   node scripts/shared-device-interop-adjudicate.mjs --stamp=... --control-stamp=...
 *   node scripts/shared-device-interop-adjudicate.mjs ... --write
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkPassOrder,
  checkRoiCopies,
  extractCopyImages,
  extractCreateDeviceIds,
  extractDebugLabels,
  extractNamedResources,
  forbiddenCommands,
  hashIfPresent,
} from './m0-d1a-adjudicate.mjs';
import {
  ACCUMULATOR_LABEL,
  DEFAULT_APK,
  PACKAGE,
  SNAPSHOT_LABEL,
  classifyRenderdocApi,
  latestBoundBundle,
  ROOT,
} from './m0-d1a-capture-host.mjs';
import { CAPTURES_DIR, parseKvLine, statusOf } from './perf-18-20-adjudicate.mjs';

export const ADJUDICATION_SCHEMA = 'shared-device-interop-adjudication/v1';
export const VELLO_LABEL = 'm0-d1a-vello';
export const BLIT_LABEL = 'm0-d1a-blit-pass';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

export function checkNamedRasterAndAccumulator(names) {
  const entries = [...names.entries()];
  const vello = entries.find(([, name]) => name === VELLO_LABEL);
  const acc = entries.find(([, name]) => name === ACCUMULATOR_LABEL);
  const snap = entries.find(([, name]) => name === SNAPSHOT_LABEL);
  const ok = Boolean(vello && acc && snap);
  return {
    ok,
    vello_id: vello?.[0] ?? null,
    accumulator_id: acc?.[0] ?? null,
    snapshot_id: snap?.[0] ?? null,
    reason: ok
      ? 'named vello, accumulator, and glass-roi resources share the capture'
      : 'missing named m0-d1a-vello / accumulator / glass-roi',
  };
}

export function checkBlitSamplesRaster(labels, names) {
  const named = checkNamedRasterAndAccumulator(names);
  const blit = labels.indexOf(BLIT_LABEL);
  const roi = labels.findIndex((name) => String(name).startsWith('m0-d1a-roi-read'));
  const glass = labels.findIndex((name) => String(name).startsWith('m0-d1a-glass'));
  const ok = named.ok && blit >= 0 && roi > blit && glass > roi;
  return {
    ok,
    blit,
    roi,
    glass,
    named,
    reason: ok
      ? 'blit samples raster into accumulator before ROI/glass composite'
      : `raster→sample order failed blit=${blit} roi=${roi} glass=${glass}`,
  };
}

export function checkOneVkDevice(xml, logValues) {
  const ids = extractCreateDeviceIds(xml);
  const devices = num(logValues.devices);
  const ok = devices === 1 && ids.length <= 1;
  return {
    ok,
    devices,
    vk_device_ids: ids,
    reason: ok
      ? 'probe devices=1 and RenderDoc shows at most one VkDevice'
      : `devices=${devices} vkCreateDevice ids=${ids.join(',')}`,
  };
}

export function checkNoDestroyBeforeComposite(xml) {
  const destroy = [...xml.matchAll(/name="vkDestroyImage"/gu)].length;
  const ok = destroy === 0;
  return {
    ok,
    destroy,
    reason: ok
      ? 'no vkDestroyImage before last composite submit (retirement lease held)'
      : `vkDestroyImage count=${destroy}`,
  };
}

export function evaluateInterop({ xml, log, controlLog, provenance }) {
  const checks = [];
  if (!xml || !log) {
    return {
      status: 'BLOCKED',
      ok: false,
      reason: 'missing RenderDoc XML or capture log',
      checks,
    };
  }
  const api = classifyRenderdocApi(xml);
  checks.push({
    id: 'vulkan',
    ok: api.admissible === true && api.api === 'Vulkan',
    api,
  });
  const parsed = parseKvLine(log, 'interop ');
  checks.push(Object.assign({ id: 'one_vk_device' }, checkOneVkDevice(xml, parsed.values)));
  const names = extractNamedResources(xml);
  const labels = extractDebugLabels(xml);
  checks.push(
    Object.assign({ id: 'named_raster_accumulator' }, checkNamedRasterAndAccumulator(names)),
  );
  checks.push(Object.assign({ id: 'raster_then_sample' }, checkBlitSamplesRaster(labels, names)));
  const order = checkPassOrder(labels.filter((name) => String(name).startsWith('m0-d1a-')));
  checks.push({ id: 'd1a_pass_order', ok: order.ok, order });
  const copies = extractCopyImages(xml);
  const roi = checkRoiCopies(copies, names);
  checks.push({ id: 'bounded_same_device_roi', ok: roi.ok, roi });
  const forbidden = forbiddenCommands(xml);
  checks.push({
    id: 'no_map_or_image_to_buffer',
    ok: forbidden.length === 0,
    forbidden,
  });
  checks.push({
    id: 'counters',
    ok:
      num(parsed.values.devices) === 1 &&
      num(parsed.values.readbacks) === 0 &&
      num(parsed.values.xdev) === 0 &&
      num(parsed.values.image_readbacks) === 0 &&
      parsed.values.raster_texture_sampled === 'true' &&
      parsed.values.shared_identity_match === 'true' &&
      parsed.values.backend === 'Vulkan',
    values: parsed.values,
  });
  checks.push(Object.assign({ id: 'lease_until_composite' }, checkNoDestroyBeforeComposite(xml)));
  const ended = /capture_ended=true/.test(log) || /renderdoc_api=end_frame_capture/.test(log);
  checks.push({
    id: 'capture_ended',
    ok: ended && parsed.values.gpu_ran === 'true',
    ended,
  });
  if (controlLog) {
    const control = parseKvLine(controlLog, 'interop ');
    checks.push({
      id: 'control_counters',
      ok:
        num(control.values.devices) === 1 &&
        num(control.values.readbacks) === 0 &&
        num(control.values.xdev) === 0 &&
        control.values.gpu_ran === 'true',
      values: control.values,
    });
  }
  checks.push({
    id: 'provenance',
    ok: provenance?.apk_linkage === 'BOUND' && provenance?.evidence_dirty === false,
    provenance,
  });
  const ok = checks.every((check) => check.ok);
  return {
    status: statusOf(ok),
    ok,
    checks,
    reason: ok ? 'Vulkan shared-device raster texture sampled by compositor/glass' : 'blocked',
  };
}

export function adjudicate(input) {
  const interop = evaluateInterop(input.interop ?? {});
  return {
    schema: ADJUDICATION_SCHEMA,
    interop: interop.status,
    shared_device_interop: interop.status,
    milestone_b: 'STARTED',
    almost_pass: false,
    apk_linkage: input.provenance?.apk_linkage ?? 'UNBOUND',
    evidence_dirty: input.provenance?.evidence_dirty ?? true,
    checks: { interop },
    note: 'Not production JNI, not a MainActivity cutover. Milestone B stays STARTED.',
  };
}

function loadScenario(stamp, kind) {
  if (!stamp) {
    return {};
  }
  const xmlPath = join(CAPTURES_DIR, `${stamp}-${kind}.xml`);
  const logPath = join(CAPTURES_DIR, `${stamp}-${kind}-logcat.txt`);
  return {
    xml: existsSync(xmlPath) ? readFileSync(xmlPath, 'utf8') : null,
    log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : null,
    hashes: {
      xml: hashIfPresent(xmlPath),
      log: hashIfPresent(logPath),
    },
  };
}

function main() {
  const bundle = latestBoundBundle();
  const provenance = {
    apk_linkage: argValue('apk-linkage') ?? bundle?.apk_linkage ?? 'UNBOUND',
    evidence_dirty:
      argValue('evidence-dirty') != null
        ? argValue('evidence-dirty') === 'true'
        : bundle
          ? bundle.evidence_dirty === true
          : true,
  };
  const stamp = argValue('stamp');
  const controlStamp = argValue('control-stamp');
  const capture = loadScenario(stamp, 'interop');
  const control = loadScenario(controlStamp, 'interop');
  const record = adjudicate({
    provenance,
    interop: { ...capture, controlLog: control.log, provenance },
  });
  record.captures = { interop: stamp, control: controlStamp };
  record.apk = hashIfPresent(DEFAULT_APK);
  record.package = PACKAGE;
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (process.argv.includes('--write')) {
    writeFileSync(
      join(ROOT, 'docs', 'rfc', 'shared-device-interop-adjudication.json'),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
