import { describe, expect, it } from 'vitest';
import { plan, REMAINING } from './presentation-perf-bench-runner.mjs';

describe('presentation PERF bench runner plan', () => {
  it('covers remaining B-exit items without requiring a phone', () => {
    const result = plan();
    expect(result.phone_required).toBe(false);
    expect(result.milestone_b).toBe('STARTED');
    expect(result.almost_pass).toBe(false);
    expect(REMAINING).not.toContain('PERF-15');
    expect(REMAINING).not.toContain('PERF-22');
    expect(result.independent['PERF-22']).toBe('docs/rfc/perf-22-adjudication.json');
    expect(result.independent['device-loss']).toBe('docs/rfc/device-loss-adjudication.json');
    expect(result.remaining).toHaveLength(REMAINING.length);
  });
});
