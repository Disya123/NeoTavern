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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestBoundBundle, ROOT } from './m0-d1a-capture-host.mjs';

export const ADJUDICATION_SCHEMA = 'input-to-present-adjudication/v3';
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

/** Staging commit that split deadline_miss from raw input-to-present. */
export const MIN_BOUND_COMMIT = '55a31747e0151ed085be2d5107beb9e149e131e2';

/** RFC §14.2 120-Hz fixture: warm-up then 60 s continuous scroll. */
export const MIN_WARMUP_NS = 1_000_000_000;
export const MIN_CONTINUOUS_SCROLL_NS = 60_000_000_000;
export const GATE_HZ = 120;
export const GATE_HZ_TOLERANCE = 1.5;

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

export function gitIsAncestor(ancestor, commit, cwd = ROOT) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, commit], {
    cwd,
    encoding: 'utf8',
  });
  return result.status === 0;
}

export function commitIsBoundEligible(commit, { ancestor } = {}) {
  if (!commit) {
    return { ok: false, reason: 'missing apk_source_commit' };
  }
  const full = String(commit);
  if (full === MIN_BOUND_COMMIT || full.startsWith(MIN_BOUND_COMMIT.slice(0, 7))) {
    return { ok: true, reason: 'BOUND to 55a3174' };
  }
  const check = ancestor ?? gitIsAncestor;
  if (check(MIN_BOUND_COMMIT, full)) {
    return { ok: true, reason: 'BOUND to a descendant of 55a3174' };
  }
  return {
    ok: false,
    reason: 'APK source commit is not 55a3174 or a subsequent clean descendant',
  };
}

export function isNormativeGateMode(mode) {
  return mode?.normative_gate === true || Number(mode?.hz) === GATE_HZ;
}

export function observedHzMatchesGate(hz) {
  return Number.isFinite(hz) && Math.abs(hz - GATE_HZ) <= GATE_HZ_TOLERANCE;
}

export function uniqueCausalChain(links) {
  const seqs = new Set();
  const vsyncPresent = new Map();
  if (!links.length) {
    return { ok: false, reason: 'empty causal chain' };
  }
  for (const raw of links) {
    const op = normalizeOpportunity(raw);
    if (op.seq == null || op.targetVsyncId == null || op.actualPresentTime == null) {
      return {
        ok: false,
        reason: 'incomplete sequence → targetVsyncId → actual present',
      };
    }
    if (seqs.has(op.seq)) {
      return { ok: false, reason: `duplicate sequence ${op.seq}` };
    }
    seqs.add(op.seq);
    const key = String(op.targetVsyncId);
    const prev = vsyncPresent.get(key);
    if (prev != null && prev !== op.actualPresentTime) {
      return {
        ok: false,
        reason: `targetVsyncId ${op.targetVsyncId} maps to multiple actual presents`,
      };
    }
    vsyncPresent.set(key, op.actualPresentTime);
  }
  return {
    ok: true,
    sequences: seqs.size,
    vsyncs: vsyncPresent.size,
    reason: 'unique sequence → targetVsyncId → actual present',
  };
}

export function clockDomainOk(fixture) {
  const domain = fixture.clock_domain;
  const aligned = fixture.clock_domain_aligned === true;
  if (domain !== 'monotonic' && domain !== 'boottime') {
    return {
      ok: false,
      reason: 'MotionEvent/Choreographer/present timestamps lack a single clock domain',
    };
  }
  if (!aligned) {
    return {
      ok: false,
      reason: 'clocks were not converted onto one domain',
    };
  }
  return { ok: true, domain, reason: `single clock domain ${domain}` };
}

export function actualPresentSourceOk(fixture) {
  const src = fixture.actual_present_source;
  const ok = src === 'frametimeline' || src === 'surfaceflinger';
  return {
    ok,
    source: src ?? null,
    reason: ok
      ? `actualPresentTime from ${src}`
      : 'actualPresentTime is not FrameTimeline/SurfaceFlinger',
  };
}

export function traceLossOk(fixture) {
  const lost = fixture.trace_lost_packets ?? 1;
  const overrun = fixture.trace_buffer_overrun ?? 1;
  const ftrace = fixture.ftrace_lost_events ?? 1;
  const ok = lost === 0 && overrun === 0 && ftrace === 0;
  return {
    ok,
    lost_packets: lost,
    buffer_overrun: overrun,
    ftrace_lost_events: ftrace,
    reason: ok ? 'no trace packet/buffer loss' : 'trace packets or buffers were lost',
  };
}

export function continuousScrollOk(fixture) {
  const warmup = fixture.warmup_ns ?? 0;
  const scroll = fixture.continuous_scroll_ns ?? 0;
  const ok = warmup >= MIN_WARMUP_NS && scroll >= MIN_CONTINUOUS_SCROLL_NS;
  return {
    ok,
    warmup_ns: warmup,
    continuous_scroll_ns: scroll,
    reason: ok
      ? 'warm-up and 60 s continuous scroll'
      : 'missing warm-up or 60 s continuous-scroll window',
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
  const requestedHz = fixture.requested_frame_rate ?? fixture.requested_hz ?? null;
  const observedHz = fixture.observed_display_hz ?? fixture.observed_hz ?? null;
  if (
    fixture.environment_blocked ||
    fixture.environment === 'ENVIRONMENT_BLOCKED' ||
    (requestedHz != null &&
      Number(requestedHz) >= GATE_HZ - GATE_HZ_TOLERANCE &&
      observedHz != null &&
      !observedHzMatchesGate(Number(observedHz)))
  ) {
    return {
      status: 'ENVIRONMENT_BLOCKED',
      ok: false,
      reason: 'OS held the session below the requested refresh after a correct high-Hz request',
    };
  }
  const boundCommit = commitIsBoundEligible(
    provenance.apk_source_commit ?? fixture.apk_source_commit,
    { ancestor: provenance.ancestor },
  );
  const bound =
    provenance.apk_linkage === 'BOUND' &&
    provenance.evidence_dirty === false &&
    boundCommit.ok;
  const vulkan = fixture.driver === 'Vulkan';
  const links = fixture.chain ?? [];
  const chain = links.map(chainComplete);
  const chainOk = chain.length > 0 && chain.every((item) => item.ok);
  const unique = uniqueCausalChain(links);
  const presentSource = actualPresentSourceOk(fixture);
  const clocks = clockDomainOk(fixture);
  const loss = traceLossOk(fixture);
  const scrollWindow = continuousScrollOk(fixture);
  const hzOk = observedHzMatchesGate(Number(observedHz));
  const modes = (fixture.modes ?? []).map((mode) => ({
    ...modeBudget(mode),
    normative_gate: isNormativeGateMode(mode),
    pacing_only: !isNormativeGateMode(mode),
  }));
  const gateModes = modes.filter((mode) => mode.normative_gate);
  const modesOk = gateModes.length > 0 && gateModes.every((item) => item.ok);
  const exclusionsListed = Array.isArray(fixture.exclusion_reasons);
  const unknownAsApp = fixture.unknown_exclusion === 'application-caused';
  const fastPath =
    links.every((link) => (normalizeOpportunity(link).producer ?? 0) === 0) &&
    links.every((link) => (normalizeOpportunity(link).layout ?? 0) === 0) &&
    links.every((link) => (normalizeOpportunity(link).shaping ?? 0) === 0) &&
    links.every((link) => (normalizeOpportunity(link).raster ?? 0) === 0);
  const droppedEdges = fixture.dropped_edges ?? 1;
  const highWater = fixture.queue_high_water ?? Number.POSITIVE_INFINITY;
  const productWireHigh = fixture.product_wire_high_water ?? 0;
  const compositorHigh =
    fixture.compositor_queue_high_water ?? fixture.queue_high_water ?? Number.POSITIVE_INFINITY;
  const queuesOk =
    highWater <= QUEUE_CAP && productWireHigh <= QUEUE_CAP && compositorHigh <= QUEUE_CAP;
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
  const i2pPublished = gateModes.every(
    (mode) =>
      mode.p50 != null && mode.p95 != null && mode.p99 != null && mode.input_to_present?.n > 0,
  );
  const ok =
    bound &&
    vulkan &&
    chainOk &&
    unique.ok &&
    presentSource.ok &&
    clocks.ok &&
    loss.ok &&
    scrollWindow.ok &&
    hzOk &&
    modesOk &&
    exclusionsListed &&
    unknownAsApp &&
    fastPath &&
    droppedEdges === 0 &&
    queuesOk &&
    flingOk &&
    epochOk &&
    deltaOk &&
    stallsOk &&
    thermalOk &&
    scenariosOk &&
    i2pPublished;
  return {
    status: ok ? 'PASS' : 'BLOCKED',
    ok,
    bound,
    bound_commit: boundCommit,
    vulkan,
    chainOk,
    unique_chain: unique,
    actual_present_source: presentSource,
    clock_domain: clocks,
    trace_loss: loss,
    continuous_scroll: scrollWindow,
    observed_display_hz: observedHz,
    requested_frame_rate: requestedHz,
    hzOk,
    modesOk,
    exclusions_listed: exclusionsListed,
    unknown_as_application_caused: unknownAsApp,
    fastPath,
    droppedEdges,
    highWater,
    queuesOk,
    flingOk,
    epochOk,
    deltaOk,
    stallsOk,
    thermalOk,
    scenariosOk,
    i2p_percentiles_published: i2pPublished,
    chain,
    modes,
    reason: ok
      ? 'physical 120 Hz input-to-present fixture meets RFC §14 renderer-controlled gate'
      : 'physical input-to-present evidence incomplete or over RFC §14 120 Hz gate',
  };
}

export function evidenceFromFixture(fixture, provenance = {}, denominators = null) {
  if (!fixture) return null;
  return {
    trace_sha256: fixture.trace_sha256 ?? null,
    apk_sha256: fixture.apk_sha256 ?? provenance.apk_sha256 ?? null,
    apk_source_commit: provenance.apk_source_commit ?? fixture.apk_source_commit ?? null,
    perfetto_config_sha256: fixture.perfetto_config_sha256 ?? null,
    source_commit: fixture.source_commit ?? provenance.apk_source_commit ?? null,
    device: fixture.device ?? null,
    display_mode: fixture.display_mode ?? null,
    denominators: denominators ?? {
      all_frame: null,
      renderer_controlled: null,
    },
    exclusions: fixture.exclusion_reasons ?? [],
    unknown_exclusion: fixture.unknown_exclusion ?? 'application-caused',
    trace_loss: {
      lost_packets: fixture.trace_lost_packets ?? null,
      buffer_overrun: fixture.trace_buffer_overrun ?? null,
      ftrace_lost_events: fixture.ftrace_lost_events ?? null,
    },
  };
}

export function adjudicate({ fixture = null, provenance = {} } = {}) {
  const evaluated = evaluateFixture(fixture, provenance);
  const pending = evaluated.status === 'PENDING';
  const hz120 = evaluated.modes?.find((mode) => mode.hz === GATE_HZ);
  return {
    schema: ADJUDICATION_SCHEMA,
    platform_gesture_adapter: pending ? 'IMPLEMENTED' : evaluated.ok ? 'PASS' : 'IMPLEMENTED',
    perfetto: pending ? 'PENDING' : evaluated.status,
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    apk_linkage: provenance.apk_linkage ?? null,
    evidence_dirty: provenance.evidence_dirty ?? null,
    apk_source_commit: provenance.apk_source_commit ?? null,
    budgets: REFRESH_DEADLINE_NS,
    deadline_miss: 'rendererControlled && actualPresentTime > targetPresentDeadline',
    input_to_present: 'actualPresentTime - eventTime',
    input_to_present_one_refresh_gate: INPUT_TO_PRESENT_ONE_REFRESH_GATE,
    unknown_exclusion: 'application-caused',
    evidence: evidenceFromFixture(
      fixture,
      provenance,
      hz120
        ? { all_frame: hz120.all_frame, renderer_controlled: hz120.renderer_controlled }
        : null,
    ),
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
    apk_sha256: bundle?.apk_sha256 ?? null,
    apk_source_commit: bundle?.base_commit ?? bundle?.apk_source_commit ?? null,
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
