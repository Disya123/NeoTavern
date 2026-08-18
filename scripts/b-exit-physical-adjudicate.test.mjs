import { describe, expect, it } from 'vitest';
import {
  adjudicateIndependent,
  evaluateDeviceLoss,
  evaluatePerf15,
  evaluatePerf22,
  writeIndependent,
} from './b-exit-physical-adjudicate.mjs';

const bound = { apk_linkage: 'BOUND', evidence_dirty: false };

describe('B-exit physical adjudicators', () => {
  it('keeps PERF-15 IMPLEMENTED without VisualSurface even when other gates pass', () => {
    const log =
      'perf15 visual_surface=missing product_wire_surface=false fling_items=10000 live_glass=true image_decode=true image_upload=true viewport_kept=true protected_kept=true lkg_kept=true oom_loops=0 blank_px=0 ran_on_android=true';
    const result = evaluatePerf15({ log, provenance: bound });
    expect(result.perf15).toBe('IMPLEMENTED');
    expect(result.admissible).toBe(false);
    expect(result.milestone_b).toBe('STARTED');
    expect(result.almost_pass).toBe(false);
    expect(result.reason).toMatch(/VisualSurface/);
  });

  it('refuses PERF-15 PASS for a colored synthetic VisualSurface substitute', () => {
    const log =
      'perf15 visual_surface=synthetic_texture fling_items=10000 live_glass=true image_decode=true image_upload=true viewport_kept=true protected_kept=true lkg_kept=true oom_loops=0 blank_px=0 ran_on_android=true';
    expect(evaluatePerf15({ log, provenance: bound }).perf15).toBe('IMPLEMENTED');
  });

  it('stamps PERF-22 independently of a blocked device-loss record', () => {
    const batch = adjudicateIndependent({
      perf15: { log: 'visual_surface=missing', provenance: bound },
      perf22: {
        log: 'perf22 capability_before_passes=true webview_hits=0 surface_hits=0 image_readbacks=0 xdev=0 same_epoch_rejected=true labels=perf22-fallback ran_on_android=true',
        platformLog:
          'perf22-platform webview=android.webkit.WebView secure_surface=true tap_hit=fallback fallback_visible=true',
        xml: 'perf22-fallback',
        provenance: bound,
      },
      deviceLoss: { log: 'wgpu_destroyed=false ran_on_android=true', provenance: bound },
    });
    expect(batch.perf22.perf22).toBe('PASS');
    expect(batch.deviceLoss.device_loss).toBe('CPU_INJECTION');
    expect(batch.perf15.perf15).toBe('IMPLEMENTED');
    expect(batch.milestone_b).toBe('STARTED');
    expect(batch.almost_pass).toBe(false);
  });

  it('does not treat CPU on_device_lost as physical device-loss', () => {
    const result = evaluateDeviceLoss({
      log: 'recovery wgpu_destroyed=false wgpu_recreated=false device_epoch_bumps=1 stale_handle_rejected=true live_wgpu_devices=1 catch_up_burst=0 mixed_epoch=false ran_on_android=false',
      provenance: bound,
    });
    expect(result.physical).toBe(false);
    expect(result.device_loss).toBe('CPU_INJECTION');
    expect(result.admissible).toBe(false);
  });

  it('writes each JSON even when another criterion is blocked', () => {
    const batch = adjudicateIndependent({
      perf15: {},
      perf22: {},
      deviceLoss: {
        log: 'wgpu_destroyed=true wgpu_recreated=true device_epoch_bumps=1 stale_handle_rejected=true live_wgpu_devices=1 catch_up_burst=0 mixed_epoch=false ran_on_android=true',
        provenance: bound,
      },
    });
    const written = writeIndependent(batch, { write: false });
    expect(written).toHaveLength(3);
    expect(written.every((row) => row.ok)).toBe(true);
    expect(batch.perf15.perf15).not.toBe('PASS');
    expect(batch.perf22.perf22).not.toBe('PASS');
    expect(batch.deviceLoss.device_loss).toBe('PASS');
  });

  it('requires a real WebView platform log for PERF-22 PASS', () => {
    const hostOnly = evaluatePerf22({
      log: 'perf22 capability_before_passes=true webview_hits=0 surface_hits=0 image_readbacks=0 xdev=0 same_epoch_rejected=true',
      provenance: bound,
    });
    expect(hostOnly.perf22).toBe('IMPLEMENTED');
  });
});
