#!/usr/bin/env node
/**
 * Host-side PERF-18/19/20 adjudicator. Each criterion is PASS or BLOCKED
 * independently. There is no combined «almost PASS». Milestone B stays STARTED.
 *
 *   node scripts/perf-18-20-adjudicate.mjs --perf18-stamp=... --perf19-stamp=... --perf20-stamp=...
 *   node scripts/perf-18-20-adjudicate.mjs ... --write
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  extractCopyImages,
  extractDebugLabels,
  forbiddenCommands,
  hashIfPresent,
} from './m0-d1a-adjudicate.mjs';
import {
  DEFAULT_APK,
  PACKAGE,
  classifyRenderdocApi,
  latestBoundBundle,
  ROOT,
} from './m0-d1a-capture-host.mjs';

export const ADJUDICATION_SCHEMA = 'perf-18-20-adjudication/v1';
export const CAPTURES_DIR = join(ROOT, 'apps', 'android', 'perf-18-20-captures');
export const PERF18_LABELS = [
  'perf18-effect-opacity',
  'perf18-transform',
  'perf18-rounded-clip',
  'perf18-backdrop-barrier',
  'perf18-glass',
  'perf18-group-target',
];
export const PERF19_LABELS = ['perf19-selection-underlay', 'perf19-glyphs', 'perf19-background'];

export function statusOf(ok) {
  return ok ? 'PASS' : 'BLOCKED';
}

export function parseKvLine(line, prefix) {
  const idx = line.indexOf(prefix);
  if (idx < 0) {
    return { ok: false, values: {} };
  }
  const body = line.slice(idx + prefix.length).trim();
  const values = {};
  for (const part of body.split(/\s+/u)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    values[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { ok: true, values };
}

export function parsePerf20Frames(log) {
  const frames = [];
  for (const raw of String(log || '').split(/\r?\n/u)) {
    if (!raw.includes('perf20-frame ')) continue;
    const parsed = parseKvLine(raw, 'perf20-frame ');
    if (!parsed.ok) continue;
    frames.push({
      frame_id: Number(parsed.values.frame_id),
      scene_epoch: Number(parsed.values.scene_epoch),
      geometry_epoch: Number(parsed.values.geometry_epoch),
      scroll_sequence: Number(parsed.values.scroll_sequence),
      delta_token: Number(parsed.values.delta_token),
      visual_offset: Number(parsed.values.visual_offset),
      anchor_screen_position: Number(parsed.values.anchor_screen_position),
      velocity_before: Number(parsed.values.velocity_before),
      velocity_after: Number(parsed.values.velocity_after),
      geometry_debt: Number(parsed.values.geometry_debt),
      hard_clamp: parsed.values.hard_clamp === 'true',
      layout_rebuilds: Number(parsed.values.layout_rebuilds),
      paint_rebuilds: Number(parsed.values.paint_rebuilds),
      raster_invalidations: Number(parsed.values.raster_invalidations),
      mixed_epoch: parsed.values.mixed_epoch === 'true',
      blank_px: Number(parsed.values.blank_px ?? 0),
    });
  }
  return frames;
}

export function parsePerf20Commits(log) {
  const commits = [];
  for (const raw of String(log || '').split(/\r?\n/u)) {
    if (!raw.includes('perf20-commit ')) continue;
    const parsed = parseKvLine(raw, 'perf20-commit ');
    if (!parsed.ok) continue;
    commits.push({
      token: Number(parsed.values.token),
      velocity_before: Number(parsed.values.velocity_before),
      velocity_after: Number(parsed.values.velocity_after),
      anchor_before: Number(parsed.values.anchor_before),
      anchor_after: Number(parsed.values.anchor_after),
      hard_clamp: parsed.values.hard_clamp === 'true',
      applied: parsed.values.applied === 'true',
      deferred: parsed.values.deferred === 'true',
      exact_delta: Number(parsed.values.exact_delta),
      fling_px_s: Number(parsed.values.fling_px_s),
    });
  }
  return commits;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

export function evaluatePerf18({ xml, log, provenance }) {
  const checks = [];
  if (!xml) {
    return { status: 'BLOCKED', ok: false, reason: 'missing RenderDoc XML', checks };
  }
  const api = classifyRenderdocApi(xml);
  checks.push({ id: 'vulkan', ok: api.admissible === true && api.api === 'Vulkan', api });
  const labels = extractDebugLabels(xml);
  const joined = labels.join('\n');
  for (const label of PERF18_LABELS) {
    const ok = joined.includes(label);
    checks.push({ id: `label:${label}`, ok, reason: ok ? 'present' : 'missing' });
  }
  const forbidden = forbiddenCommands(xml);
  checks.push({
    id: 'no_readback_xdev',
    ok: forbidden.length === 0,
    forbidden,
  });
  const copies = extractCopyImages(xml);
  const fullscreen = copies.some((copy) => copy.w >= 1080 && copy.h >= 2400);
  checks.push({
    id: 'bounded_group_target_roi',
    ok: copies.length === 0 || !fullscreen,
    copies: copies.length,
    fullscreen,
  });
  const order = checkPerf18LabelOrder(labels);
  checks.push({ id: 'ancestor_effect_order', ok: order.ok, order });
  const parsed = parseKvLine(log || '', 'perf18 ');
  const devices = num(parsed.values.devices);
  const readbacks = num(parsed.values.readbacks);
  const xdev = num(parsed.values.xdev);
  checks.push({
    id: 'counters',
    ok: devices === 1 && readbacks === 0 && xdev === 0,
    devices,
    readbacks,
    xdev,
  });
  checks.push({
    id: 'provenance',
    ok: provenance?.apk_linkage === 'BOUND' && provenance?.evidence_dirty === false,
    provenance,
  });
  checks.push({
    id: 'glass_in_effect_scope',
    ok: parsed.values.glass_in_opacity !== 'false',
    values: parsed.values,
  });
  const ok = checks.every((check) => check.ok);
  return {
    status: statusOf(ok),
    ok,
    checks,
    reason: ok ? 'Vulkan effect-scope capture' : 'blocked',
  };
}

export function checkPerf18LabelOrder(labels) {
  const indexOf = (prefix) => labels.findIndex((name) => String(name).startsWith(prefix));
  const opacity = indexOf('perf18-effect-opacity');
  const transform = indexOf('perf18-transform');
  const rounded = indexOf('perf18-rounded-clip');
  const group = indexOf('perf18-group-target');
  const barrier = indexOf('perf18-backdrop-barrier');
  const glass = indexOf('perf18-glass');
  const ok =
    opacity >= 0 &&
    transform > opacity &&
    rounded > transform &&
    group > rounded &&
    barrier > group &&
    glass > barrier;
  return { ok, opacity, transform, rounded, group, barrier, glass };
}

export function evaluatePerf19({ xml, log, provenance }) {
  const checks = [];
  if (!xml || !log) {
    return { status: 'BLOCKED', ok: false, reason: 'missing RenderDoc XML or log', checks };
  }
  const api = classifyRenderdocApi(xml);
  checks.push({ id: 'vulkan', ok: api.admissible === true && api.api === 'Vulkan', api });
  const labels = extractDebugLabels(xml);
  const joined = labels.join('\n');
  checks.push({
    id: 'selection_not_in_bg_or_glyph',
    ok:
      joined.includes('perf19-selection-underlay') &&
      joined.includes('perf19-glyphs') &&
      joined.includes('perf19-background'),
    labels,
  });
  const parsed = parseKvLine(log, 'perf19 ');
  checks.push({
    id: 'drag_counters',
    ok:
      parsed.values.shape_calls_after_commit === '0' &&
      parsed.values.layout_rebuilds_during_drag === '0' &&
      parsed.values.glyph_rasters_during_drag === '0',
    values: parsed.values,
  });
  checks.push({
    id: 'tiles',
    ok: num(parsed.values.tiles) >= 3,
    tiles: num(parsed.values.tiles),
  });
  checks.push({
    id: 'autoscroll_and_glass_roi',
    ok: parsed.values.autoscroll === 'true' && num(parsed.values.glass_roi) >= 1,
    values: parsed.values,
  });
  checks.push({
    id: 'counters',
    ok:
      num(parsed.values.devices) === 1 &&
      num(parsed.values.readbacks) === 0 &&
      num(parsed.values.xdev) === 0,
    values: parsed.values,
  });
  const forbidden = forbiddenCommands(xml);
  checks.push({ id: 'no_readback_xdev_xml', ok: forbidden.length === 0, forbidden });
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
    reason: ok ? 'selection underlay capture' : 'blocked',
  };
}

export function evaluatePerf20({ log, xml, provenance }) {
  const checks = [];
  const frames = parsePerf20Frames(log);
  if (frames.length < 8) {
    return {
      status: 'BLOCKED',
      ok: false,
      reason: `need a multi-frame trace, got ${frames.length}`,
      checks,
      frames: frames.length,
    };
  }
  const required = [
    'frame_id',
    'scene_epoch',
    'geometry_epoch',
    'scroll_sequence',
    'delta_token',
    'visual_offset',
    'anchor_screen_position',
    'velocity_before',
    'velocity_after',
    'geometry_debt',
    'hard_clamp',
    'layout_rebuilds',
    'paint_rebuilds',
    'raster_invalidations',
  ];
  const sample = frames[0];
  checks.push({
    id: 'frame_fields',
    ok: required.every((key) => sample[key] !== undefined && !Number.isNaN(sample[key])),
  });
  const commits = parsePerf20Commits(log);
  const commit = commits[0] ?? null;
  checks.push({
    id: 'one_delta_token_commit',
    ok: commits.length === 1 && commit?.applied === true && commit?.deferred === false,
    commits: commits.length,
    commit,
  });
  checks.push({
    id: 'exact_plus_350_fling',
    ok: commit?.exact_delta === 350 && commit?.fling_px_s === 10_000,
    commit,
  });
  const c0 =
    commit != null &&
    (commit.hard_clamp || Math.abs(commit.anchor_after - commit.anchor_before) < 1e-3);
  checks.push({ id: 'c0_anchor', ok: c0, commit });
  const c1Frames = frames.every((frame) => {
    if (frame.hard_clamp) return true;
    return Math.abs(frame.velocity_after - frame.velocity_before) < 1e-6;
  });
  const c1Commit =
    commit == null
      ? false
      : commit.hard_clamp || Math.abs(commit.velocity_after - commit.velocity_before) < 1e-6;
  checks.push({ id: 'c1_velocity', ok: c1Frames && c1Commit });
  const mixed = frames.some((frame) => frame.mixed_epoch || frame.blank_px > 1e-6);
  checks.push({ id: 'no_blank_or_mixed_epoch', ok: !mixed });
  const rebuilds = frames.every(
    (frame) =>
      frame.layout_rebuilds === 0 && frame.paint_rebuilds === 0 && frame.raster_invalidations === 0,
  );
  checks.push({ id: 'no_shape_layout_raster', ok: rebuilds });
  const tokens = [...new Set(frames.map((frame) => frame.delta_token))];
  checks.push({
    id: 'delta_token_not_double_applied',
    ok: tokens.length >= 1 && tokens.length <= 2,
    tokens,
  });
  const gpu = parseKvLine(log || '', 'perf20 ');
  checks.push({
    id: 'counters',
    ok:
      num(gpu.values.devices) === 1 &&
      num(gpu.values.readbacks) === 0 &&
      num(gpu.values.xdev) === 0,
    values: gpu.values,
  });
  if (xml) {
    const api = classifyRenderdocApi(xml);
    checks.push({ id: 'vulkan', ok: api.admissible === true && api.api === 'Vulkan', api });
    const forbidden = forbiddenCommands(xml);
    checks.push({ id: 'no_readback_xdev_xml', ok: forbidden.length === 0, forbidden });
  } else {
    checks.push({ id: 'vulkan', ok: false, reason: 'PERF-20 still needs a Vulkan device capture' });
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
    frames: frames.length,
    commit,
    reason: ok ? 'multi-frame fling trace' : 'blocked',
  };
}

export function adjudicate(input) {
  const perf18 = evaluatePerf18(input.perf18 ?? {});
  const perf19 = evaluatePerf19(input.perf19 ?? {});
  const perf20 = evaluatePerf20(input.perf20 ?? {});
  return {
    schema: ADJUDICATION_SCHEMA,
    perf18: perf18.status,
    perf19: perf19.status,
    perf20: perf20.status,
    milestone_b: 'STARTED',
    almost_pass: false,
    apk_linkage: input.provenance?.apk_linkage ?? 'UNBOUND',
    evidence_dirty: input.provenance?.evidence_dirty ?? true,
    checks: { perf18, perf19, perf20 },
  };
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
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
  const record = adjudicate({
    provenance,
    perf18: { ...loadScenario(argValue('perf18-stamp'), 'perf18'), provenance },
    perf19: { ...loadScenario(argValue('perf19-stamp'), 'perf19'), provenance },
    perf20: { ...loadScenario(argValue('perf20-stamp'), 'perf20'), provenance },
  });
  record.apk = hashIfPresent(DEFAULT_APK);
  record.package = PACKAGE;
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (process.argv.includes('--write')) {
    writeFileSync(
      join(ROOT, 'docs', 'rfc', 'perf-18-20-adjudication.json'),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
