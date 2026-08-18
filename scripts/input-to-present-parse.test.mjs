import { describe, expect, it } from 'vitest';
import {
  buildFixture,
  clockSnapshotFromRows,
  exclusionForTimeline,
  joinOpportunities,
  JANK,
  parseKv,
  parseLogcat,
  toMonotonic,
} from './input-to-present-parse.mjs';

const log = `
NeoTavernI2P: i2p scenario=warmup phase=start tNs=1000 observedHz=120
NeoTavernI2P: i2p scenario=warmup phase=end tNs=1000001000 observedHz=120
NeoTavernI2P: i2p scenario=continuous_scroll phase=start tNs=1000002000 observedHz=120
NeoTavernI2P: i2p seq=1 eventTime=1000003000 inputCutoff=1000010000 callbackTime=1000002500 targetVsyncId=440 targetPresentDeadline=1000008000 actualPresentTime=pending eligibleForCurrentVsync=true rendererControlled=pending exclusionReason=pending newestEventTime=1000003000 oldestHistoricalEventTime=1000003000 pointer=0 kind=Move enqueueNs=1000003100 callbackVsyncId=440
NeoTavernI2P: i2p present frameId=9 targetVsyncId=440 callbackTime=1000002500 inputCutoff=1000010000 targetPresentDeadline=1000008000 consumeNs=1000003200 gpuSubmit=1000004000 actualPresentTime=pending driver=Vulkan producer=0 layout=0 shaping=0 raster=0 highWater=3 dropE=0 compositorOnly=1 clock=monotonic
NeoTavernI2P: i2p scenario=continuous_scroll phase=end tNs=61000002000 observedHz=120
NeoTavernI2P: i2p scenario=refresh_120 phase=start tNs=500 observedHz=120
NeoTavernI2P: i2p scenario=refresh_120 phase=end tNs=61000003000 observedHz=120
NeoTavernI2P: i2p display requestedHz=120 observedHz=120 modeId=2 reason=higher-refresh scenario=refresh_120
`;

describe('input-to-present parser', () => {
  it('parses cookies, presents, and scenario windows', () => {
    const parsed = parseLogcat(log);
    expect(parsed.cookies).toHaveLength(1);
    expect(parsed.presents[0].driver).toBe('Vulkan');
    expect(parsed.cookies[0].callbackVsyncId).toBe(440);
    expect(parseKv('a=1 b=two').b).toBe('two');
  });

  it('converts boottime FrameTimeline onto monotonic', () => {
    const snapshot = clockSnapshotFromRows([
      { clock_name: 'builtin_clock_monotonic', clock_value: 1_000 },
      { clock_name: 'builtin_clock_boottime', clock_value: 4_000 },
    ]);
    expect(snapshot.domain).toBe('boottime');
    expect(toMonotonic(14_000, snapshot)).toBe(11_000);
  });

  it('keeps unknown jank in the renderer-controlled denominator', () => {
    expect(exclusionForTimeline({ jank_type: JANK.UNKNOWN })).toEqual({
      rendererControlled: true,
      exclusionReason: 'unknown',
    });
    expect(exclusionForTimeline({ jank_type: JANK.SF_SCHEDULING }).rendererControlled).toBe(false);
  });

  it('joins sequence → targetVsyncId → FrameTimeline actual present', () => {
    const parsed = parseLogcat(log);
    const ops = joinOpportunities({
      cookies: parsed.cookies,
      presents: parsed.presents,
      timelineRows: [{ ts: 1_000_005_000, dur: 200, display_frame_token: 440, jank_type: JANK.NONE }],
      clock: { domain: 'monotonic', delta_boot_minus_mono: 0, aligned: true },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].seq).toBe(1);
    expect(ops[0].targetVsyncId).toBe(440);
    expect(ops[0].actualPresentTime).toBe(1_000_005_000);
    expect(ops[0].callbackTime).not.toBe(ops[0].actualPresentTime);
    expect(ops[0].gpu_submit_ns).toBeLessThanOrEqual(ops[0].sf_latch_ns);
    expect(ops[0].sf_latch_ns).toBeLessThanOrEqual(ops[0].actualPresentTime);
  });

  it('publishes 60 s continuous-scroll and 120 Hz opportunities', () => {
    const parsed = parseLogcat(log);
    const fixture = buildFixture({
      parsed,
      timelineRows: [{ ts: 1_000_005_000, dur: 200, display_frame_token: 440, jank_type: JANK.NONE }],
      statsRows: [
        { name: 'traced_buf_lost_packets', value: 0 },
        { name: 'traced_buf_bytes_overwritten', value: 0 },
        { name: 'ftrace_cpu_overrun', value: 0 },
      ],
      clockRows: [{ clock_name: 'monotonic', clock_value: 1 }],
      meta: { thermal: { state: 'none', cpu_khz: [1], gpu_khz: [1] } },
    });
    expect(fixture.warmup_ns).toBe(1_000_000_000);
    expect(fixture.continuous_scroll_ns).toBe(60_000_000_000);
    expect(fixture.actual_present_source).toBe('frametimeline');
    expect(fixture.modes.find((mode) => mode.hz === 120).opportunities).toHaveLength(1);
    expect(fixture.trace_lost_packets).toBe(0);
  });

  it('maps FrameTimeline string jank; None is not unknown', () => {
    expect(exclusionForTimeline({ jank_type: 'None' })).toEqual({
      rendererControlled: true,
      exclusionReason: null,
    });
    expect(exclusionForTimeline({ jank_type: 'SurfaceFlinger GPU Deadline Missed' })).toEqual({
      rendererControlled: false,
      exclusionReason: 'sf_gpu_deadline_missed',
    });
    expect(exclusionForTimeline({ jank_type: 'Unknown Jank' }).exclusionReason).toBe('unknown');
    expect(exclusionForTimeline({ jank_type: 'Unknown Jank' }).rendererControlled).toBe(true);
  });

  it('sums overwritten Perfetto buffers as loss', () => {
    const fixture = buildFixture({
      parsed: parseLogcat(log),
      timelineRows: [{ ts: 1_000_005_000, dur: 200, display_frame_token: 440, jank_type: 'None' }],
      statsRows: [
        { name: 'traced_buf_bytes_overwritten', value: 414_797_824 },
        { name: 'traced_buf_bytes_overwritten', value: 0 },
        { name: 'traced_buf_chunks_overwritten', value: 12_922 },
        { name: 'traced_buf_lost_packets', value: 0 },
        { name: 'ftrace_cpu_overrun_delta', value: 0 },
      ],
      clockRows: [{ clock_name: 'monotonic', clock_value: 1 }],
    });
    expect(fixture.trace_buffer_overrun).toBe(1);
  });

  it('joins compositor vsync to SurfaceFlinger actual present when tokens differ', () => {
    const parsed = parseLogcat(`
NeoTavernI2P: i2p seq=1 eventTime=1000 inputCutoff=3000 callbackTime=2000 targetVsyncId=995 targetPresentDeadline=20000 actualPresentTime=pending eligibleForCurrentVsync=true newestEventTime=1000 oldestHistoricalEventTime=1000 enqueueNs=1100 callbackVsyncId=995
NeoTavernI2P: i2p present frameId=9 targetVsyncId=995 callbackTime=2000 inputCutoff=3000 targetPresentDeadline=20000 consumeNs=1200 gpuSubmit=4000 actualPresentTime=pending driver=Vulkan producer=0 layout=0 shaping=0 raster=0 highWater=1 dropE=0 compositorOnly=1 clock=monotonic
`);
    const ops = joinOpportunities({
      cookies: parsed.cookies,
      presents: parsed.presents,
      timelineRows: [
        { ts: 5_000, dur: 200, display_frame_token: 1001, layer_name: null, jank_type: 'None' },
      ],
      clock: { domain: 'monotonic', delta_boot_minus_mono: 0, aligned: true },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].targetVsyncId).toBe(995);
    expect(ops[0].actualPresentTime).toBe(5_000);
    expect(ops[0].callbackTime).not.toBe(ops[0].actualPresentTime);
  });

  it('counts unjoined cookies inside the 120 Hz window', () => {
    const parsed = parseLogcat(`${log}
NeoTavernI2P: i2p seq=2 eventTime=1000004000 inputCutoff=1000010000 callbackTime=1000002500 targetVsyncId=441 targetPresentDeadline=1000008000 actualPresentTime=pending eligibleForCurrentVsync=true rendererControlled=pending exclusionReason=pending newestEventTime=1000004000 oldestHistoricalEventTime=1000004000 pointer=0 kind=Move enqueueNs=1000004100 callbackVsyncId=441
`);
    const fixture = buildFixture({
      parsed,
      timelineRows: [{ ts: 1_000_005_000, dur: 200, display_frame_token: 440, jank_type: 'None' }],
      statsRows: [{ name: 'traced_buf_bytes_overwritten', value: 0 }],
      clockRows: [{ clock_name: 'monotonic', clock_value: 1 }],
    });
    expect(fixture.unjoined_cookies).toBe(1);
    expect(fixture.cookies_in_window).toBe(2);
  });
});
