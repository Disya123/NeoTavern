import { describe, expect, it } from 'vitest';
import { REMAINING_BATCH } from './b-exit-physical-capture.mjs';
import {
  adjudicateRemaining,
  evaluatePerf01,
  evaluatePerf16,
  writeRemaining,
} from './remaining-b-physical-adjudicate.mjs';

const bound = { apk_linkage: 'BOUND', evidence_dirty: false };
const product =
  'product_path=true dioxus_shell=true blitz_producer=true wire_messages=10000 direct_display_list_injection=false ran_on_android=true';

describe('remaining B physical batch', () => {
  it('lists one Android batch for the remaining PERF ids', () => {
    expect(REMAINING_BATCH).toEqual([
      'perf01-warm',
      'perf01-cold',
      'perf02',
      'perf03',
      'perf04',
      'perf05',
      'perf11',
      'perf12',
      'perf13',
      'perf14',
      'perf16',
      'perf17',
      'perf21',
    ]);
  });

  it('keeps PERF-01 IMPLEMENTED without physical provenance', () => {
    const result = evaluatePerf01({
      warmLog: `${product} cache=warm compositor_only_frames=7200 travel=12000.0`,
      coldLog: `${product} cache=cold_near_range compositor_only_frames=7200 travel=8000.0`,
    });
    expect(result.perf01).toBe('IMPLEMENTED');
    expect(result.admissible).toBe(false);
    expect(result.milestone_b).toBe('STARTED');
    expect(result.almost_pass).toBe(false);
  });

  it('stamps PERF-01 PASS only for warm+cold product-path BOUND logs', () => {
    const result = evaluatePerf01({
      warmLog: `${product} cache=warm compositor_only_frames=7200 travel=12000.5`,
      coldLog: `${product} cache=cold_near_range compositor_only_frames=7200 travel=9000.2`,
      provenance: bound,
    });
    expect(result.perf01).toBe('PASS');
    expect(result.admissible).toBe(true);
    expect(result.milestone_b).toBe('STARTED');
  });

  it('refuses PERF-16 p99 with fewer than 100 samples', () => {
    const result = evaluatePerf16({
      log: `${product} samples=8 host_p99=none contentful_p99=1 interaction_p99=1`,
      provenance: bound,
    });
    expect(result.perf16).toBe('BLOCKED');
    expect(result.admissible).toBe(false);
  });

  it('stamps PERF-16 PASS for 100 split samples and host_p99=none', () => {
    const result = evaluatePerf16({
      log: `${product} samples=100 host_p99=none contentful_p99=12 interaction_p99=4`,
      provenance: bound,
    });
    expect(result.perf16).toBe('PASS');
    expect(result.milestone_b).toBe('STARTED');
  });

  it('writes remaining JSON independently and never stamps Milestone B', () => {
    const batch = adjudicateRemaining({
      perf14: {
        log: `${product} same_logical_target=true wrong_message=false unacked_delta_px=500`,
        provenance: bound,
      },
    });
    const written = writeRemaining(batch, { write: false, only: 'PERF-14' });
    expect(written).toHaveLength(1);
    expect(batch.perf14.perf14).toBe('PASS');
    expect(batch.perf01.perf01).not.toBe('PASS');
    expect(batch.milestone_b).toBe('STARTED');
    expect(batch.almost_pass).toBe(false);
    expect(batch.production_cutover).toBe('NOT_STARTED');
  });
});
