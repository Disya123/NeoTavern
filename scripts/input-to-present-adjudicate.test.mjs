import { describe, expect, it } from 'vitest';
import {
  adjudicate,
  assignTargetVsync,
  chainComplete,
  classifyOpportunities,
  deadlineMiss,
  evaluateFixture,
  INPUT_TO_PRESENT_ONE_REFRESH_GATE,
  MAX_MISSED_FRACTION,
  MIN_BOUND_COMMIT,
  MIN_ON_TIME_FRACTION,
  modeBudget,
  REFRESH_DEADLINE_NS,
  rendererControlledForDenominator,
} from './input-to-present-adjudicate.mjs';

const provenance = {
  apk_linkage: 'BOUND',
  evidence_dirty: false,
  apk_source_commit: MIN_BOUND_COMMIT,
};

function opportunity(overrides = {}) {
  return {
    seq: 1,
    eventTime: 1_000,
    inputCutoff: 2_000,
    callbackTime: 1_500,
    callbackVsyncId: 440,
    targetVsyncId: 440,
    targetPresentDeadline: 8_000,
    actualPresentTime: 7_000,
    eligibleForCurrentVsync: true,
    rendererControlled: true,
    exclusionReason: null,
    newestEventTime: 1_000,
    enqueue_ns: 1_100,
    consume_ns: 1_200,
    frame_id: 9,
    gpu_submit_ns: 3_000,
    sf_latch_ns: 4_000,
    producer: 0,
    layout: 0,
    shaping: 0,
    raster: 0,
    ...overrides,
  };
}

function passingFixture(overrides = {}) {
  const period120 = REFRESH_DEADLINE_NS[120];
  const lateButNextVsync = opportunity({
    eventTime: 1_000_000,
    newestEventTime: 1_000_000,
    inputCutoff: 500_000,
    callbackTime: 400_000,
    callbackVsyncId: 440,
    eligibleForCurrentVsync: false,
    targetVsyncId: 441,
    targetPresentDeadline: 16_666_667,
    actualPresentTime: 13_000_000,
    gpu_submit_ns: 3_000_000,
    sf_latch_ns: 4_000_000,
    enqueue_ns: 1_100_000,
    consume_ns: 1_200_000,
  });
  return {
    driver: 'Vulkan',
    clock_domain: 'monotonic',
    clock_domain_aligned: true,
    actual_present_source: 'frametimeline',
    trace_lost_packets: 0,
    trace_buffer_overrun: 0,
    ftrace_lost_events: 0,
    warmup_ns: 1_000_000_000,
    continuous_scroll_ns: 60_000_000_000,
    observed_display_hz: 120,
    requested_frame_rate: 120,
    exclusion_reasons: [],
    unknown_exclusion: 'application-caused',
    product_wire_high_water: 0,
    compositor_queue_high_water: 8,
    scenarios: [
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
    ],
    chain: [lateButNextVsync],
    modes: [
      {
        hz: 60,
        refresh_period_ns: REFRESH_DEADLINE_NS[60],
        opportunities: [
          opportunity({
            targetPresentDeadline: REFRESH_DEADLINE_NS[60],
            actualPresentTime: 10_000_000,
            gpu_submit_ns: 3_000_000,
            sf_latch_ns: 4_000_000,
          }),
        ],
      },
      {
        hz: 90,
        refresh_period_ns: REFRESH_DEADLINE_NS[90],
        opportunities: [
          opportunity({
            targetPresentDeadline: REFRESH_DEADLINE_NS[90],
            actualPresentTime: 8_000_000,
            gpu_submit_ns: 3_000_000,
            sf_latch_ns: 4_000_000,
          }),
        ],
      },
      {
        hz: 120,
        refresh_period_ns: period120,
        opportunities: [lateButNextVsync],
      },
    ],
    dropped_edges: 0,
    queue_high_water: 8,
    fling_velocity: { fine: 10_000, coalesced: 9_800 },
    epoch_mismatch: 0,
    double_delta: 0,
    ui_stall_ns_max: 1_000_000,
    compositor_stall_ns_max: 2_000_000,
    thermal: { state: 'none', cpu_khz: [1800000], gpu_khz: [500000] },
    ...overrides,
  };
}

describe('input-to-present host adjudicator', () => {
  it('stays PENDING without a physical Perfetto fixture', () => {
    const record = adjudicate();
    expect(record.platform_gesture_adapter).toBe('IMPLEMENTED');
    expect(record.perfetto).toBe('PENDING');
    expect(record.milestone_b).toBe('STARTED');
    expect(record.almost_pass).toBe(false);
    expect(record.production_cutover).toBe('NOT_STARTED');
    expect(record.input_to_present_one_refresh_gate).toBe(false);
    expect(record.unknown_exclusion).toBe('application-caused');
  });

  it('rejects Choreographer doFrame as actual present', () => {
    expect(chainComplete(opportunity({ callbackTime: 5_000, actualPresentTime: 5_000 })).ok).toBe(
      false,
    );
  });

  it('does not apply a one-refresh PASS threshold to raw input-to-present', () => {
    expect(INPUT_TO_PRESENT_ONE_REFRESH_GATE).toBe(false);
    const budget = modeBudget({
      hz: 120,
      refresh_period_ns: REFRESH_DEADLINE_NS[120],
      opportunities: [
        opportunity({
          eventTime: 0,
          newestEventTime: 0,
          inputCutoff: 1_000_000,
          actualPresentTime: 20_000_000,
          targetPresentDeadline: 24_000_000,
          gpu_submit_ns: 3_000_000,
          sf_latch_ns: 4_000_000,
        }),
        opportunity({
          seq: 2,
          eventTime: 1_000,
          newestEventTime: 1_000,
          actualPresentTime: 1_000_000,
          targetPresentDeadline: 8_000_000,
        }),
        opportunity({
          seq: 3,
          eventTime: 2_000,
          newestEventTime: 2_000,
          inputCutoff: 2_000,
          actualPresentTime: 2_000_000,
          targetPresentDeadline: 8_000_000,
        }),
      ],
    });
    expect(budget.input_to_present_one_refresh_gate).toBe(false);
    expect(budget.mean_hides_tail).toBe(true);
    expect(budget.mean_hides_tail_gates_pass).toBe(false);
    expect(budget.p95).toBeGreaterThan(REFRESH_DEADLINE_NS[120]);
    expect(budget.mean).toBeLessThan(REFRESH_DEADLINE_NS[120]);
    expect(budget.ok).toBe(true);
  });

  it('passes when after-cutoff input lands on the next vsync on time', () => {
    const evaluated = evaluateFixture(passingFixture(), provenance);
    expect(evaluated.status).toBe('PASS');
    expect(evaluated.ok).toBe(true);
    const hz120 = evaluated.modes.find((mode) => mode.hz === 120);
    expect(hz120.input_to_present.max).toBeGreaterThan(REFRESH_DEADLINE_NS[120]);
    expect(hz120.renderer_controlled.misses).toBe(0);
    const record = adjudicate({ fixture: passingFixture(), provenance });
    expect(record.platform_gesture_adapter).toBe('PASS');
    expect(record.perfetto).toBe('PASS');
    expect(record.milestone_b).toBe('STARTED');
    expect(record.almost_pass).toBe(false);
  });

  it('blocks missing SurfaceFlinger present even when deadlines look fine', () => {
    const fixture = passingFixture({
      chain: [opportunity({ actualPresentTime: null })],
    });
    expect(evaluateFixture(fixture, provenance).status).toBe('BLOCKED');
  });

  it('uses RFC missed-deadline fraction, not an invented mean budget', () => {
    expect(MAX_MISSED_FRACTION).toBe(0.01);
    expect(MIN_ON_TIME_FRACTION).toBe(0.99);
    const over = passingFixture({
      modes: [
        {
          hz: 120,
          refresh_period_ns: REFRESH_DEADLINE_NS[120],
          opportunities: [
            opportunity(),
            opportunity({ seq: 2 }),
            opportunity({ seq: 3 }),
            opportunity({
              seq: 4,
              actualPresentTime: 20_000_000,
              targetPresentDeadline: 8_000_000,
              gpu_submit_ns: 3_000_000,
              sf_latch_ns: 4_000_000,
            }),
          ],
        },
      ],
    });
    expect(evaluateFixture(over, provenance).status).toBe('BLOCKED');
  });

  it('counts deadline_miss only for renderer-controlled late presents', () => {
    expect(
      deadlineMiss({
        rendererControlled: true,
        actualPresentTime: 9_000,
        targetPresentDeadline: 8_000,
      }),
    ).toBe(true);
    expect(
      deadlineMiss({
        rendererControlled: false,
        actualPresentTime: 9_000,
        targetPresentDeadline: 8_000,
      }),
    ).toBe(false);
    expect(
      deadlineMiss({
        rendererControlled: true,
        actualPresentTime: 7_000,
        targetPresentDeadline: 8_000,
      }),
    ).toBe(false);
  });

  it('treats unknown exclusion as application-caused', () => {
    expect(rendererControlledForDenominator(false, 'unknown')).toBe(true);
    expect(rendererControlledForDenominator(false, null)).toBe(true);
    expect(rendererControlledForDenominator(false, 'os_stall')).toBe(false);
    const classified = classifyOpportunities([
      opportunity({
        rendererControlled: false,
        exclusionReason: 'unknown',
        actualPresentTime: 20_000_000,
        targetPresentDeadline: 8_000_000,
        gpu_submit_ns: 3_000_000,
        sf_latch_ns: 4_000_000,
      }),
    ]);
    expect(classified.renderer_controlled.n).toBe(1);
    expect(classified.renderer_controlled.misses).toBe(1);
    expect(classified.gate_ok).toBe(false);
  });

  it('publishes all-frame and renderer-controlled denominators', () => {
    const classified = classifyOpportunities([
      opportunity(),
      opportunity({
        seq: 2,
        rendererControlled: false,
        exclusionReason: 'driver_stall',
        actualPresentTime: 20_000_000,
        targetPresentDeadline: 8_000_000,
        gpu_submit_ns: 3_000_000,
        sf_latch_ns: 4_000_000,
      }),
    ]);
    expect(classified.all_frame.n).toBe(2);
    expect(classified.all_frame.misses).toBe(1);
    expect(classified.renderer_controlled.n).toBe(1);
    expect(classified.renderer_controlled.misses).toBe(0);
    expect(classified.exclusions.driver_stall).toBe(1);
    expect(classified.gate_ok).toBe(true);
  });

  it('uses newest reflected sample for primary latency and oldest as gesture age', () => {
    const classified = classifyOpportunities([
      opportunity({
        eventTime: 30,
        newestEventTime: 30,
        oldestHistoricalEventTime: 10,
        actualPresentTime: 1_000,
        targetPresentDeadline: 2_000,
      }),
    ]);
    expect(classified.input_to_present.n).toBe(1);
    expect(classified.input_to_present.max).toBe(970);
    expect(classified.gesture_age.max).toBe(990);
  });

  it('assigns the next targetVsyncId after cutoff', () => {
    const assigned = assignTargetVsync({
      eventTime: 3_000,
      inputCutoff: 2_000,
      currentVsyncId: 440,
      currentPresentDeadline: 8_333_333,
      nextVsyncId: 441,
      nextPresentDeadline: 16_666_666,
    });
    expect(assigned.eligibleForCurrentVsync).toBe(false);
    expect(assigned.targetVsyncId).toBe(441);
    expect(assigned.targetPresentDeadline).toBe(16_666_666);
  });

  it('fails a short input-to-present that still missed the present deadline', () => {
    const budget = modeBudget({
      hz: 120,
      refresh_period_ns: REFRESH_DEADLINE_NS[120],
      opportunities: [
        opportunity({
          eventTime: 7_500,
          newestEventTime: 7_500,
          inputCutoff: 8_000,
          eligibleForCurrentVsync: true,
          actualPresentTime: 9_000,
          targetPresentDeadline: 8_000,
        }),
      ],
    });
    expect(budget.input_to_present.max).toBeLessThan(REFRESH_DEADLINE_NS[120]);
    expect(budget.renderer_controlled.misses).toBe(1);
    expect(budget.ok).toBe(false);
  });

  it('gates only the locked 120 Hz fixture, not 60/90 pacing modes', () => {
    const fixture = passingFixture({
      modes: [
        {
          hz: 60,
          refresh_period_ns: REFRESH_DEADLINE_NS[60],
          opportunities: [
            opportunity({
              seq: 9,
              actualPresentTime: 40_000_000,
              targetPresentDeadline: 8_000_000,
              gpu_submit_ns: 3_000_000,
              sf_latch_ns: 4_000_000,
            }),
          ],
        },
        passingFixture().modes.find((mode) => mode.hz === 120),
      ],
    });
    const evaluated = evaluateFixture(fixture, provenance);
    expect(evaluated.ok).toBe(true);
    expect(evaluated.modes.find((mode) => mode.hz === 60).pacing_only).toBe(true);
    expect(evaluated.modes.find((mode) => mode.hz === 120).normative_gate).toBe(true);
  });

  it('blocks when clocks are not converted onto one domain', () => {
    const fixture = passingFixture({ clock_domain_aligned: false });
    expect(evaluateFixture(fixture, provenance).status).toBe('BLOCKED');
  });

  it('blocks lost Perfetto packets', () => {
    const fixture = passingFixture({ trace_lost_packets: 3 });
    expect(evaluateFixture(fixture, provenance).status).toBe('BLOCKED');
  });

  it('marks ENVIRONMENT_BLOCKED when 120 Hz was requested but the panel stayed at 60', () => {
    const fixture = passingFixture({
      requested_frame_rate: 120,
      observed_display_hz: 60,
    });
    expect(evaluateFixture(fixture, provenance).status).toBe('ENVIRONMENT_BLOCKED');
  });

  it('requires every continuous-scroll cookie to join FrameTimeline', () => {
    const fixture = passingFixture({ unjoined_cookies: 12 });
    expect(evaluateFixture(fixture, provenance).status).toBe('BLOCKED');
    expect(evaluateFixture(fixture, provenance).joinOk).toBe(false);
  });

  it('requires APK BOUND to 55a3174 or a descendant', () => {
    const fixture = passingFixture();
    expect(
      evaluateFixture(fixture, {
        apk_linkage: 'BOUND',
        evidence_dirty: false,
        apk_source_commit: 'deadbeef',
        ancestor: () => false,
      }).status,
    ).toBe('BLOCKED');
    expect(evaluateFixture(fixture, provenance).ok).toBe(true);
  });
});
