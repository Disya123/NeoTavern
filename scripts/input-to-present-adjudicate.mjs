#!/usr/bin/env node
/**
 * Host-side input-to-present adjudicator. Choreographer#doFrame is not present.
 * FrameTimeline / SurfaceFlinger actual-present must correlate via vsyncId.
 *
 * RFC §14: 16.67 / 11.11 / 8.33 ms are renderer-controlled frame-opportunity
 * deadlines, not a one-refresh PASS threshold on raw input-to-present.
 *
 *   deadline_miss = rendererControlled && actualPresentTime > targetPresentDeadline
 *   input_to_present = actualPresentTime - eventTime   // reported, not gated
 *
 * Milestone B stays STARTED. No physical stamp → PENDING.
 *
 *   node scripts/input-to-present-adjudicate.mjs
 *   node scripts/input-to-present-adjudicate.mjs --fixture=path.json --write
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestBoundBundle, ROOT } from './m0-d1a-capture-host.mjs';

export const ADJUDICATION_SCHEMA = 'input-to-present-adjudication/v2';
export const RECORD_PATH = join(ROOT, 'docs', 'rfc', 'input-to-present-adjudication.json');

/** RFC §14.1 refresh deadlines. Frame-opportunity budgets, not input-to-present. */
export const REFRESH_DEADLINE_NS = {
  60: 16_666_667,
  90: 11_111_111,
  120: 8_333_333,
};

/** RFC §14.2 application-caused missed presentation deadlines. */
export const MAX_MISSED_FRACTION = 0.01;
export const MIN_ON_TIME_FRACTION = 0.99;
export const MAX_CONSECUTIVE_MISSES = 2;

/** Raw input-to-present must not use a one-refresh PASS threshold without a budget ADR. */
export const INPUT_TO_PRESENT_ONE_REFRESH_GATE = false;

/** Host-test fling contract (same physical velocity under coalescing). */
export const FLING_VELOCITY_REL_EPS = 0.15;

export const QUEUE_CAP = 64;

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function statsOf(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    mean: sorted.length ? sum / sorted.length : null,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

export function refreshDeadlineNs(hz) {
  return REFRESH_DEADLINE_NS[hz] ?? null;
}

export function pick(obj, ...keys) {
  if (obj == null) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      return obj[key];
    }
  }
  return undefined;
}

export function isUnknownExclusion(reason) {
  return reason == null || reason === '' || reason === 'unknown';
}

/**
 * §14: excluding a frame from the renderer-controlled denominator needs a
 * traced OS/driver/external reason. `unknown` is application-caused.
 */
export function rendererControlledForDenominator(declared, exclusionReason) {
  if (declared === false && !isUnknownExclusion(exclusionReason)) {
    return false;
  }
  return true;
}

export function deadlineMiss({ rendererControlled, actualPresentTime, targetPresentDeadline }) {
  return Boolean(rendererControlled) && actualPresentTime > targetPresentDeadline;
}

export function inputToPresentNs({ actualPresentTime, eventTime, newestEventTime }) {
  const sampleTime = newestEventTime ?? eventTime;
  if (actualPresentTime == null || sampleTime == null) return null;
  return actualPresentTime - sampleTime;
}

export function gestureAgeNs({ actualPresentTime, oldestHistoricalEventTime }) {
  if (actualPresentTime == null || oldestHistoricalEventTime == null) return null;
  return actualPresentTime - oldestHistoricalEventTime;
}

export function assignTargetVsync({
  eventTime,
  inputCutoff,
  currentVsyncId,
  currentPresentDeadline,
  nextVsyncId,
  nextPresentDeadline,
}) {
  const eligibleForCurrentVsync = eventTime <= inputCutoff;
  return {
    eligibleForCurrentVsync,
    targetVsyncId: eligibleForCurrentVsync ? currentVsyncId : nextVsyncId,
    targetPresentDeadline: eligibleForCurrentVsync ? currentPresentDeadline : nextPresentDeadline,
  };
}

export function normalizeOpportunity(raw) {
  const eventTime = pick(raw, 'eventTime', 'event_time_ns');
  const inputCutoff = pick(raw, 'inputCutoff', 'input_cutoff_ns');
  const callbackTime = pick(raw, 'callbackTime', 'callback_time_ns', 'frame_time_ns');
  const callbackVsyncId = pick(raw, 'callbackVsyncId', 'callback_vsync_id', 'currentVsyncId');
  const targetVsyncId = pick(raw, 'targetVsyncId', 'target_vsync_id', 'vsync_id');
  const targetPresentDeadline = pick(raw, 'targetPresentDeadline', 'target_present_deadline_ns');
  const actualPresentTime = pick(raw, 'actualPresentTime', 'actual_present_ns');
  const newestEventTime = pick(raw, 'newestEventTime', 'newest_event_time_ns') ?? eventTime;
  const oldestHistoricalEventTime = pick(
    raw,
    'oldestHistoricalEventTime',
    'oldest_historical_event_time_ns',
  );
  let eligibleForCurrentVsync = pick(raw, 'eligibleForCurrentVsync', 'eligible_for_current_vsync');
  if (eligibleForCurrentVsync == null && eventTime != null && inputCutoff != null) {
    eligibleForCurrentVsync = eventTime <= inputCutoff;
  }
  const rendererControlledDeclared = pick(raw, 'rendererControlled', 'renderer_controlled');
  const exclusionReason = pick(raw, 'exclusionReason', 'exclusion_reason') ?? null;
  const rendererControlled = rendererControlledForDenominator(
    rendererControlledDeclared,
    exclusionReason,
  );
  return {
    eventTime,
    inputCutoff,
    callbackTime,
    callbackVsyncId,
    targetVsyncId,
    targetPresentDeadline,
    actualPresentTime,
    eligibleForCurrentVsync,
    rendererControlled,
    rendererControlledDeclared: rendererControlledDeclared ?? null,
    exclusionReason,
    newestEventTime,
    oldestHistoricalEventTime,
    seq: pick(raw, 'seq'),
    enqueue_ns: pick(raw, 'enqueue_ns', 'enqueueNs'),
    consume_ns: pick(raw, 'consume_ns', 'consumeNs'),
    frame_id: pick(raw, 'frameId', 'frame_id'),
    gpu_submit_ns: pick(raw, 'gpu_submit_ns', 'gpuSubmitNs'),
    sf_latch_ns: pick(raw, 'sf_latch_ns', 'sfLatchNs'),
    producer: pick(raw, 'producer') ?? 0,
    layout: pick(raw, 'layout') ?? 0,
    shaping: pick(raw, 'shaping') ?? 0,
    raster: pick(raw, 'raster') ?? 0,
    reflectedInFrame: pick(raw, 'reflectedInFrame', 'reflected_in_frame') ?? true,
  };
}

export function cutoffRetargetConsistent(op) {
  if (op.eventTime == null || op.inputCutoff == null) return false;
  const eligible = op.eventTime <= op.inputCutoff;
  if (Boolean(op.eligibleForCurrentVsync) !== eligible) return false;
  if (
    !eligible &&
    op.callbackVsyncId != null &&
    op.targetVsyncId != null &&
    op.targetVsyncId === op.callbackVsyncId
  ) {
    return false;
  }
  if (
    eligible &&
    op.callbackVsyncId != null &&
    op.targetVsyncId != null &&
    op.targetVsyncId !== op.callbackVsyncId
  ) {
    return false;
  }
  return true;
}

function emptyDenom() {
  return {
    n: 0,
    on_time: 0,
    misses: 0,
    miss_fraction: 1,
    on_time_fraction: 0,
    longest_miss_streak: 0,
  };
}

export function classifyOpportunities(opportunities) {
  const normalized = opportunities.map(normalizeOpportunity);
  const all = emptyDenom();
  const rendererControlled = emptyDenom();
  const exclusions = {};
  let cutoffMismatches = 0;
  let incomplete = 0;
  const inputToPresent = [];
  const gestureAges = [];
  let allStreak = 0;
  let rcStreak = 0;

  for (const op of normalized) {
    if (!cutoffRetargetConsistent(op)) cutoffMismatches += 1;
    const complete =
      op.actualPresentTime != null &&
      op.targetPresentDeadline != null &&
      op.targetVsyncId != null &&
      op.targetVsyncId !== 0;
    if (!complete) {
      incomplete += 1;
      continue;
    }
    const presentedLate = op.actualPresentTime > op.targetPresentDeadline;
    const miss = deadlineMiss(op);
    all.n += 1;
    if (presentedLate) {
      all.misses += 1;
      allStreak += 1;
      all.longest_miss_streak = Math.max(all.longest_miss_streak, allStreak);
    } else {
      all.on_time += 1;
      allStreak = 0;
    }
    if (op.rendererControlled) {
      rendererControlled.n += 1;
      if (miss) {
        rendererControlled.misses += 1;
        rcStreak += 1;
        rendererControlled.longest_miss_streak = Math.max(
          rendererControlled.longest_miss_streak,
          rcStreak,
        );
      } else {
        rendererControlled.on_time += 1;
        rcStreak = 0;
      }
    } else {
      const reason = op.exclusionReason ?? 'unspecified';
      exclusions[reason] = (exclusions[reason] ?? 0) + 1;
      rcStreak = 0;
    }
    if (op.reflectedInFrame) {
      const latency = inputToPresentNs(op);
      if (latency != null) inputToPresent.push(latency);
    }
    const age = gestureAgeNs(op);
    if (age != null) gestureAges.push(age);
  }

  const finalize = (row) => {
    row.miss_fraction = row.n > 0 ? row.misses / row.n : 1;
    row.on_time_fraction = row.n > 0 ? row.on_time / row.n : 0;
    return row;
  };
  finalize(all);
  finalize(rendererControlled);

  const gateOk =
    cutoffMismatches === 0 &&
    incomplete === 0 &&
    rendererControlled.n > 0 &&
    rendererControlled.on_time_fraction >= MIN_ON_TIME_FRACTION &&
    rendererControlled.miss_fraction < MAX_MISSED_FRACTION &&
    rendererControlled.longest_miss_streak <= MAX_CONSECUTIVE_MISSES;

  return {
    all_frame: all,
    renderer_controlled: rendererControlled,
    exclusions,
    cutoff_mismatches: cutoffMismatches,
    incomplete,
    input_to_present: statsOf(inputToPresent),
    gesture_age: statsOf(gestureAges),
    gate_ok: gateOk,
  };
}

function classifyFromLegacyCounts(mode) {
  const latencies = mode.input_to_present_ns ?? [];
  const frames = mode.frames ?? latencies.length;
  const missed = mode.missed_deadlines ?? 0;
  const streak = mode.longest_miss_streak ?? 0;
  const missFraction = frames > 0 ? missed / frames : 1;
  const onTime = frames - missed;
  const onTimeFraction = frames > 0 ? onTime / frames : 0;
  const denom = {
    n: frames,
    on_time: onTime,
    misses: missed,
    miss_fraction: missFraction,
    on_time_fraction: onTimeFraction,
    longest_miss_streak: streak,
  };
  return {
    all_frame: { ...denom },
    renderer_controlled: { ...denom },
    exclusions: {},
    cutoff_mismatches: 0,
    incomplete: 0,
    input_to_present: statsOf(latencies),
    gesture_age: statsOf([]),
    gate_ok:
      frames > 0 &&
      onTimeFraction >= MIN_ON_TIME_FRACTION &&
      missFraction < MAX_MISSED_FRACTION &&
      streak <= MAX_CONSECUTIVE_MISSES,
  };
}

export function chainComplete(link) {
  const op = normalizeOpportunity(link);
  const presentIsDoFrame =
    op.actualPresentTime != null &&
    op.callbackTime != null &&
    op.actualPresentTime === op.callbackTime;
  const ids =
    op.seq != null &&
    op.eventTime != null &&
    op.enqueue_ns != null &&
    op.consume_ns != null &&
    op.frame_id != null &&
    op.targetVsyncId != null &&
    op.gpu_submit_ns != null &&
    op.sf_latch_ns != null &&
    op.actualPresentTime != null &&
    op.inputCutoff != null &&
    op.targetPresentDeadline != null;
  const order =
    ids &&
    op.eventTime <= op.enqueue_ns &&
    op.enqueue_ns <= op.consume_ns &&
    op.consume_ns <= op.gpu_submit_ns &&
    op.gpu_submit_ns <= op.sf_latch_ns &&
    op.sf_latch_ns <= op.actualPresentTime;
  const cutoffOk = cutoffRetargetConsistent(op);
  return {
    ok: Boolean(ids && order && cutoffOk && !presentIsDoFrame && op.targetVsyncId !== 0),
    present_is_do_frame: presentIsDoFrame,
    reason: presentIsDoFrame
      ? 'actualPresentTime equals Choreographer callbackTime; doFrame is not present'
      : ids && order && cutoffOk
        ? 'MotionEvent→enqueue→consume→SampledFrame→GPU→SF latch→actual present'
        : 'incomplete, unordered, or cutoff/targetVsync mismatch',
  };
}

export function modeBudget(mode) {
  const hz = mode.hz;
  const deadline = mode.refresh_period_ns ?? refreshDeadlineNs(hz);
  const opportunities = mode.opportunities ?? mode.samples ?? [];
  const classified =
    opportunities.length > 0
      ? classifyOpportunities(opportunities)
      : classifyFromLegacyCounts(mode);
  const summary = classified.input_to_present;
  const meanHidesTail =
    summary.mean != null &&
    summary.p95 != null &&
    deadline != null &&
    summary.mean <= deadline &&
    summary.p95 > deadline;
  const ok = classified.gate_ok && deadline != null;
  return {
    ok,
    hz,
    deadline_ns: deadline,
    deadline_is_frame_opportunity: true,
    input_to_present_one_refresh_gate: INPUT_TO_PRESENT_ONE_REFRESH_GATE,
    mean_hides_tail: meanHidesTail,
    mean_hides_tail_gates_pass: false,
    missed: classified.renderer_controlled.misses,
    missed_fraction: classified.renderer_controlled.miss_fraction,
    longest_miss_streak: classified.renderer_controlled.longest_miss_streak,
    ...classified,
    ...summary,
    reason: ok
      ? `RFC §14 ${hz} Hz renderer-controlled opportunities on time (p95/p99 input-to-present reported, not gated)`
      : `RFC §14 ${hz} Hz renderer-controlled gate missed (on_time=${classified.renderer_controlled.on_time_fraction} misses=${classified.renderer_controlled.miss_fraction} streak=${classified.renderer_controlled.longest_miss_streak})`,
  };
}

export function evaluateFixture(fixture, provenance = {}) {
  if (!fixture) {
    return {
      status: 'PENDING',
      ok: false,
      reason: 'physical Perfetto batch not captured',
    };
  }
  if (fixture.environment_blocked || fixture.environment === 'ENVIRONMENT_BLOCKED') {
    return {
      status: 'ENVIRONMENT_BLOCKED',
      ok: false,
      reason: 'OS held the session below the requested refresh after a correct high-Hz request',
    };
  }
  const bound = provenance.apk_linkage === 'BOUND' && provenance.evidence_dirty === false;
  const vulkan = fixture.driver === 'Vulkan';
  const links = fixture.chain ?? [];
  const chain = links.map(chainComplete);
  const chainOk = chain.length > 0 && chain.every((item) => item.ok);
  const modes = (fixture.modes ?? []).map(modeBudget);
  const modesOk = modes.length > 0 && modes.every((item) => item.ok);
  const fastPath =
    links.every((link) => (normalizeOpportunity(link).producer ?? 0) === 0) &&
    links.every((link) => (normalizeOpportunity(link).layout ?? 0) === 0) &&
    links.every((link) => (normalizeOpportunity(link).shaping ?? 0) === 0) &&
    links.every((link) => (normalizeOpportunity(link).raster ?? 0) === 0);
  const droppedEdges = fixture.dropped_edges ?? 1;
  const highWater = fixture.queue_high_water ?? Number.POSITIVE_INFINITY;
  const fling = fixture.fling_velocity ?? {};
  const fine = Number(fling.fine);
  const coalesced = Number(fling.coalesced);
  const flingOk =
    Number.isFinite(fine) &&
    Number.isFinite(coalesced) &&
    fine > 0 &&
    Math.abs(fine - coalesced) / Math.max(fine, coalesced) <= FLING_VELOCITY_REL_EPS;
  const epochOk = (fixture.epoch_mismatch ?? 1) === 0;
  const deltaOk = (fixture.double_delta ?? 1) === 0;
  const stallDeadline = Math.max(...Object.values(REFRESH_DEADLINE_NS));
  const stallsOk =
    (fixture.ui_stall_ns_max ?? stallDeadline + 1) <= stallDeadline &&
    (fixture.compositor_stall_ns_max ?? stallDeadline + 1) <= stallDeadline;
  const thermal = fixture.thermal ?? {};
  const thermalOk = Boolean(thermal.state) && thermal.cpu_khz != null && thermal.gpu_khz != null;
  const scenarios = new Set(fixture.scenarios ?? []);
  const required = [
    'scroll_fling',
    'nested_handoff',
    'sticky_fixed',
    'selection_autoscroll',
    'coalesced_move',
    'focus_cancel',
    'refresh_60',
    'refresh_90',
    'refresh_120',
    'refresh_transition',
  ];
  const scenariosOk = required.every((name) => scenarios.has(name));
  const ok =
    bound &&
    vulkan &&
    chainOk &&
    modesOk &&
    fastPath &&
    droppedEdges === 0 &&
    highWater <= QUEUE_CAP &&
    flingOk &&
    epochOk &&
    deltaOk &&
    stallsOk &&
    thermalOk &&
    scenariosOk;
  return {
    status: ok ? 'PASS' : 'BLOCKED',
    ok,
    bound,
    vulkan,
    chainOk,
    modesOk,
    fastPath,
    droppedEdges,
    highWater,
    flingOk,
    epochOk,
    deltaOk,
    stallsOk,
    thermalOk,
    scenariosOk,
    chain,
    modes,
    reason: ok
      ? 'physical input-to-present chain meets RFC §14 renderer-controlled opportunity gate'
      : 'physical input-to-present evidence incomplete or over RFC §14 renderer-controlled gate',
  };
}

export function adjudicate({ fixture = null, provenance = {} } = {}) {
  const evaluated = evaluateFixture(fixture, provenance);
  const pending = evaluated.status === 'PENDING';
  return {
    schema: ADJUDICATION_SCHEMA,
    platform_gesture_adapter: pending ? 'IMPLEMENTED' : evaluated.ok ? 'PASS' : 'IMPLEMENTED',
    perfetto: pending ? 'PENDING' : evaluated.status,
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    apk_linkage: provenance.apk_linkage ?? null,
    evidence_dirty: provenance.evidence_dirty ?? null,
    budgets: REFRESH_DEADLINE_NS,
    deadline_miss: 'rendererControlled && actualPresentTime > targetPresentDeadline',
    input_to_present: 'actualPresentTime - eventTime',
    input_to_present_one_refresh_gate: INPUT_TO_PRESENT_ONE_REFRESH_GATE,
    unknown_exclusion: 'application-caused',
    checks: evaluated,
    reason: evaluated.reason,
  };
}

function loadFixture(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeRecord(record, dest = RECORD_PATH) {
  writeFileSync(dest, `${JSON.stringify(record, null, 2)}\n`);
  return dest;
}

function main() {
  const write = process.argv.includes('--write');
  const fixturePath = argValue('fixture');
  const bundle = latestBoundBundle();
  const provenance = {
    apk_linkage: bundle?.apk_linkage ?? null,
    evidence_dirty: bundle?.evidence_dirty ?? null,
  };
  const record = adjudicate({
    fixture: loadFixture(fixturePath),
    provenance: fixturePath ? provenance : {},
  });
  if (write) writeRecord(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (record.perfetto === 'PASS' && record.almost_pass) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
