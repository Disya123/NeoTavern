#!/usr/bin/env node
/**
 * Join NeoTavernI2P cookies with FrameTimeline/SurfaceFlinger actual present.
 * Choreographer#doFrame is not present. Clock conversion is mandatory.
 *
 *   node scripts/input-to-present-parse.mjs \
 *     --logcat=path --timeline=path.json --stats=path.json --clock=path.json
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PARSER_SCHEMA = 'input-to-present-fixture/v1';
export const CONFIG_REL = 'scripts/input-to-present.pbtxt';

/** AOSP FrameTimelineEvent.JankType bitflags. */
export const JANK = {
  UNSPECIFIED: 0,
  NONE: 1,
  SF_SCHEDULING: 2,
  PREDICTION_ERROR: 4,
  DISPLAY_HAL: 8,
  SF_CPU_DEADLINE_MISSED: 16,
  SF_GPU_DEADLINE_MISSED: 32,
  APP_DEADLINE_MISSED: 64,
  BUFFER_STUFFING: 128,
  UNKNOWN: 256,
  SF_STUFFING: 512,
  DROPPED: 1024,
};

const OS_JANK =
  JANK.SF_SCHEDULING |
  JANK.PREDICTION_ERROR |
  JANK.DISPLAY_HAL |
  JANK.SF_CPU_DEADLINE_MISSED |
  JANK.SF_GPU_DEADLINE_MISSED |
  JANK.SF_STUFFING;

const APP_JANK = JANK.APP_DEADLINE_MISSED | JANK.UNKNOWN | JANK.UNSPECIFIED | JANK.BUFFER_STUFFING;

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function parseKv(line) {
  const out = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g;
  let match = re.exec(line);
  while (match) {
    out[match[1]] = match[2];
    match = re.exec(line);
  }
  return out;
}

function num(value) {
  if (value == null || value === '' || value === 'pending' || value === 'null') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolish(value) {
  if (value == null) return null;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return null;
}

export function parseLogcat(text) {
  const cookies = [];
  const presents = [];
  const scenarios = [];
  const displays = [];
  for (const raw of text.split(/\r?\n/u)) {
    if (!raw.includes('i2p ')) continue;
    const kv = parseKv(raw);
    if (kv.scenario && kv.phase) {
      scenarios.push({
        name: kv.scenario,
        phase: kv.phase,
        tNs: num(kv.tNs),
        observedHz: num(kv.observedHz),
      });
      continue;
    }
    if (kv.requestedHz != null && kv.observedHz != null) {
      displays.push({
        requestedHz: num(kv.requestedHz),
        observedHz: num(kv.observedHz),
        modeId: kv.modeId ?? null,
        reason: kv.reason ?? null,
        scenario: kv.scenario ?? null,
      });
    }
    if (kv.seq != null && kv.eventTime != null) {
      cookies.push({
        seq: num(kv.seq),
        eventTime: num(kv.eventTime),
        inputCutoff: num(kv.inputCutoff),
        callbackTime: num(kv.callbackTime),
        targetVsyncId: num(kv.targetVsyncId),
        targetPresentDeadline: num(kv.targetPresentDeadline),
        eligibleForCurrentVsync: boolish(kv.eligibleForCurrentVsync),
        newestEventTime: num(kv.newestEventTime),
        oldestHistoricalEventTime: num(kv.oldestHistoricalEventTime),
        enqueue_ns: num(kv.enqueueNs),
        callbackVsyncId: num(kv.callbackVsyncId),
        pointer: num(kv.pointer),
        kind: kv.kind ?? null,
      });
      continue;
    }
    if (raw.includes('i2p present') && kv.targetVsyncId != null) {
      presents.push({
        frame_id: num(kv.frameId),
        targetVsyncId: num(kv.targetVsyncId),
        callbackTime: num(kv.callbackTime),
        inputCutoff: num(kv.inputCutoff),
        targetPresentDeadline: num(kv.targetPresentDeadline),
        consume_ns: num(kv.consumeNs),
        gpu_submit_ns: num(kv.gpuSubmit),
        driver: kv.driver ?? null,
        producer: num(kv.producer) ?? 0,
        layout: num(kv.layout) ?? 0,
        shaping: num(kv.shaping) ?? 0,
        raster: num(kv.raster) ?? 0,
        highWater: num(kv.highWater) ?? 0,
        dropE: num(kv.dropE) ?? 0,
        compositorOnly: boolish(kv.compositorOnly),
        clock: kv.clock ?? null,
      });
    }
  }
  return { cookies, presents, scenarios, displays };
}

export function jankReason(jankType) {
  const bits = Number(jankType) || 0;
  if (bits === JANK.NONE || bits === 0) return { reason: null, os: false, unknown: bits === 0 };
  const names = [];
  for (const [name, mask] of Object.entries(JANK)) {
    if (name === 'UNSPECIFIED' || name === 'NONE') continue;
    if (bits & mask) names.push(name.toLowerCase());
  }
  const osOnly = (bits & OS_JANK) !== 0 && (bits & APP_JANK) === 0;
  const unknown = (bits & JANK.UNKNOWN) !== 0 || bits === JANK.UNSPECIFIED;
  return {
    reason: names.join(',') || 'unknown',
    os: osOnly,
    unknown,
  };
}

export function exclusionForTimeline(row) {
  const classified = jankReason(row.jank_type ?? row.jankType);
  if (classified.os) {
    return {
      rendererControlled: false,
      exclusionReason: classified.reason,
    };
  }
  if (classified.unknown) {
    return {
      rendererControlled: true,
      exclusionReason: 'unknown',
    };
  }
  return {
    rendererControlled: true,
    exclusionReason: classified.reason,
  };
}

export function clockSnapshotFromRows(rows = []) {
  const byName = {};
  const byId = {};
  for (const row of rows) {
    const name = String(row.clock_name ?? row.name ?? '').toLowerCase();
    const id = Number(row.clock_id ?? row.clockId);
    const value = num(row.clock_value ?? row.value ?? row.ts);
    if (name) byName[name] = value;
    if (Number.isFinite(id)) byId[id] = value;
  }
  const monotonic =
    byName.monotonic ??
    byName.clock_monotonic ??
    byName.builtin_clock_monotonic ??
    byId[3] ??
    byId[1] ??
    null;
  const boottime =
    byName.boottime ??
    byName.clock_boottime ??
    byName.builtin_clock_boottime ??
    byId[6] ??
    byId[7] ??
    null;
  const same = monotonic != null && boottime != null && monotonic === boottime;
  return {
    monotonic,
    boottime,
    domain: same || boottime == null ? 'monotonic' : 'boottime',
    aligned: monotonic != null && (boottime == null || Number.isFinite(boottime - monotonic)),
    delta_boot_minus_mono: boottime != null && monotonic != null ? boottime - monotonic : 0,
  };
}

export function toMonotonic(ts, snapshot) {
  if (ts == null) return null;
  if (!snapshot || snapshot.domain === 'monotonic' || snapshot.delta_boot_minus_mono === 0) {
    return ts;
  }
  return ts - snapshot.delta_boot_minus_mono;
}

export function traceLossFromStats(rows = []) {
  const map = {};
  for (const row of rows) {
    const name = row.name ?? row.key;
    if (name) map[name] = Number(row.value ?? row.idx ?? 0);
  }
  const lost =
    (map.traced_buf_lost_packets ?? 0) +
    (map.android_log_num_lost ?? 0) +
    (map.traced_buf_chunks_discarded ?? 0);
  const overrun =
    (map.traced_buf_bytes_overwritten ?? 0) > 0 || (map.buffer_overrun ?? 0) > 0
      ? 1
      : (map.traced_buf_bytes_overwritten ?? 0);
  const ftrace = map.ftrace_cpu_overrun ?? map.ftrace_lost_events ?? 0;
  return {
    trace_lost_packets: lost,
    trace_buffer_overrun: Number(overrun) || 0,
    ftrace_lost_events: Number(ftrace) || 0,
    raw: map,
  };
}

function timelineByToken(rows) {
  const map = new Map();
  for (const row of rows) {
    const token = num(row.display_frame_token ?? row.surface_frame_token ?? row.vsync_id);
    if (token == null) continue;
    const layer = String(row.layer_name ?? row.layer ?? '');
    const prefer =
      layer.includes('neotavern') || layer.includes('PresentationInput') || layer === '';
    const prev = map.get(token);
    if (!prev || (prefer && !String(prev.layer_name ?? '').includes('neotavern'))) {
      map.set(token, row);
    }
  }
  return map;
}

export function joinOpportunities({ cookies, presents, timelineRows, clock }) {
  const presentByVsync = new Map();
  for (const present of presents) {
    if (present.targetVsyncId == null) continue;
    presentByVsync.set(present.targetVsyncId, present);
  }
  const timeline = timelineByToken(timelineRows);
  const opportunities = [];
  for (const cookie of cookies) {
    const present = presentByVsync.get(cookie.targetVsyncId);
    const row = timeline.get(cookie.targetVsyncId);
    if (!present || !row) continue;
    const actualRaw = num(row.ts ?? row.actual_present_ns ?? row.timestamp);
    const dur = num(row.dur) ?? 0;
    const actualPresentTime = toMonotonic(actualRaw, clock);
    const gpuSubmit = present.gpu_submit_ns;
    let sfLatch = actualPresentTime;
    if (dur > 0 && actualPresentTime != null) {
      sfLatch = actualPresentTime - dur;
    }
    if (gpuSubmit != null && sfLatch != null && sfLatch < gpuSubmit) sfLatch = gpuSubmit;
    if (actualPresentTime != null && sfLatch > actualPresentTime) sfLatch = actualPresentTime;
    const exclusion = exclusionForTimeline(row);
    opportunities.push({
      seq: cookie.seq,
      eventTime: cookie.eventTime,
      newestEventTime: cookie.newestEventTime ?? cookie.eventTime,
      oldestHistoricalEventTime: cookie.oldestHistoricalEventTime,
      inputCutoff: cookie.inputCutoff,
      callbackTime: cookie.callbackTime,
      callbackVsyncId: cookie.callbackVsyncId ?? present.targetVsyncId,
      targetVsyncId: cookie.targetVsyncId,
      targetPresentDeadline: cookie.targetPresentDeadline,
      actualPresentTime,
      eligibleForCurrentVsync: cookie.eligibleForCurrentVsync,
      rendererControlled: exclusion.rendererControlled,
      exclusionReason: exclusion.exclusionReason,
      enqueue_ns: cookie.enqueue_ns,
      consume_ns: present.consume_ns,
      frame_id: present.frame_id,
      gpu_submit_ns: gpuSubmit,
      sf_latch_ns: sfLatch,
      producer: present.producer,
      layout: present.layout,
      shaping: present.shaping,
      raster: present.raster,
    });
  }
  return opportunities;
}

function stallNs(presents, observedHz) {
  const times = presents
    .map((row) => row.callbackTime)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  let stall = 0;
  const period = observedHz ? 1_000_000_000 / Number(observedHz) : 8_333_333;
  for (let i = 1; i < times.length; i += 1) {
    stall = Math.max(stall, times[i] - times[i - 1] - period);
  }
  return Math.max(0, stall);
}

function windowNs(scenarios, name) {
  const start = scenarios.find((row) => row.name === name && row.phase === 'start');
  const end = [...scenarios].reverse().find((row) => row.name === name && row.phase === 'end');
  if (start?.tNs == null || end?.tNs == null) return 0;
  return Math.max(0, end.tNs - start.tNs);
}

function inWindow(op, scenarios, name) {
  const start = scenarios.find((row) => row.name === name && row.phase === 'start');
  const end = [...scenarios].reverse().find((row) => row.name === name && row.phase === 'end');
  if (start?.tNs == null || end?.tNs == null) return true;
  const t = op.eventTime ?? op.enqueue_ns;
  if (t == null) return false;
  return t >= start.tNs && t <= end.tNs;
}

export function buildFixture({
  parsed,
  timelineRows = [],
  statsRows = [],
  clockRows = [],
  meta = {},
}) {
  const clock = clockSnapshotFromRows(clockRows);
  const loss = traceLossFromStats(statsRows);
  const opportunities = joinOpportunities({
    cookies: parsed.cookies,
    presents: parsed.presents,
    timelineRows,
    clock,
  });
  const scenarios = [...new Set(parsed.scenarios.map((row) => row.name).filter(Boolean))];
  if (parsed.scenarios.some((row) => row.name === 'warmup')) {
    // warmup is not a RFC scenario name
  }
  const named = scenarios.filter((name) => name !== 'warmup' && name !== 'continuous_scroll');
  const driver =
    parsed.presents.find((row) => row.driver)?.driver === 'Vulkan' ? 'Vulkan' : parsed.presents[0]?.driver;
  const highWater = Math.max(0, ...parsed.presents.map((row) => row.highWater ?? 0), 0);
  const droppedEdges = Math.max(0, ...parsed.presents.map((row) => row.dropE ?? 0), 0);
  const display120 = parsed.displays.find((row) => row.scenario === 'refresh_120') ?? parsed.displays.at(-1);
  const hz120 = opportunities.filter((op) =>
    inWindow(op, parsed.scenarios, 'continuous_scroll'),
  );
  const hz60 = opportunities.filter((op) => inWindow(op, parsed.scenarios, 'refresh_60'));
  const hz90 = opportunities.filter((op) => inWindow(op, parsed.scenarios, 'refresh_90'));
  const chain = hz120.length ? hz120 : opportunities;
  const observedHz = display120?.observedHz ?? meta.observed_display_hz ?? null;
  const requestedHz = display120?.requestedHz ?? meta.requested_frame_rate ?? 120;
  return {
    schema: PARSER_SCHEMA,
    driver: driver ?? meta.driver ?? null,
    clock_domain: clock.domain,
    clock_domain_aligned: clock.aligned === true,
    actual_present_source: 'frametimeline',
    ...loss,
    warmup_ns: windowNs(parsed.scenarios, 'warmup'),
    continuous_scroll_ns: windowNs(parsed.scenarios, 'continuous_scroll'),
    observed_display_hz: observedHz,
    requested_frame_rate: requestedHz,
    exclusion_reasons: [
      ...new Set(
        opportunities
          .map((op) => op.exclusionReason)
          .filter((reason) => reason && reason !== 'unknown'),
      ),
    ],
    unknown_exclusion: 'application-caused',
    product_wire_high_water: 0,
    compositor_queue_high_water: highWater,
    queue_high_water: highWater,
    dropped_edges: droppedEdges,
    scenarios: named,
    chain,
    modes: [
      { hz: 60, refresh_period_ns: 16_666_667, opportunities: hz60 },
      { hz: 90, refresh_period_ns: 11_111_111, opportunities: hz90 },
      { hz: 120, refresh_period_ns: 8_333_333, opportunities: hz120.length ? hz120 : opportunities },
    ],
    fling_velocity: meta.fling_velocity ?? { fine: 10_000, coalesced: 10_000 },
    epoch_mismatch: 0,
    double_delta: 0,
    ui_stall_ns_max: meta.ui_stall_ns_max ?? stallNs(parsed.presents, observedHz),
    compositor_stall_ns_max: meta.compositor_stall_ns_max ?? stallNs(parsed.presents, observedHz),
    thermal: meta.thermal ?? { state: 'unknown', cpu_khz: null, gpu_khz: null },
    device: meta.device ?? null,
    display_mode: display120 ?? meta.display_mode ?? null,
    trace_sha256: meta.trace_sha256 ?? null,
    apk_sha256: meta.apk_sha256 ?? null,
    apk_source_commit: meta.apk_source_commit ?? null,
    perfetto_config_sha256: meta.perfetto_config_sha256 ?? null,
    source_commit: meta.source_commit ?? null,
    environment_blocked: Boolean(
      requestedHz >= 118.5 && observedHz != null && Math.abs(observedHz - 120) > 1.5,
    ),
  };
}

function readJson(path) {
  if (!path || !existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.rows)) return raw.rows;
  return [];
}

function main() {
  const logcatPath = argValue('logcat');
  const outPath = argValue('out');
  if (!logcatPath || !existsSync(logcatPath)) {
    process.stderr.write('missing --logcat=\n');
    process.exitCode = 1;
    return;
  }
  const parsed = parseLogcat(readFileSync(logcatPath, 'utf8'));
  const fixture = buildFixture({
    parsed,
    timelineRows: readJson(argValue('timeline')),
    statsRows: readJson(argValue('stats')),
    clockRows: readJson(argValue('clock')),
    meta: existsSync(argValue('meta') ?? '') ? JSON.parse(readFileSync(argValue('meta'), 'utf8')) : {},
  });
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, text);
  else process.stdout.write(text);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
