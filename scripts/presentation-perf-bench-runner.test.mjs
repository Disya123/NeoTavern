import { describe, expect, it } from 'vitest';
import { execute, HOST_GROUPS, plan, REMAINING } from './presentation-perf-bench-runner.mjs';

describe('presentation PERF bench runner plan', () => {
  it('covers remaining B-exit items without requiring a phone', () => {
    const result = plan();
    expect(result.phone_required).toBe(false);
    expect(result.milestone_b).toBe('STARTED');
    expect(result.almost_pass).toBe(false);
    expect(REMAINING).not.toContain('PERF-15');
    expect(REMAINING).not.toContain('PERF-22');
    expect(result.independent['PERF-15']).toBe('docs/rfc/perf-15-adjudication.json');
    expect(result.independent['PERF-22']).toBe('docs/rfc/perf-22-adjudication.json');
    expect(result.independent['device-loss']).toBe('docs/rfc/device-loss-adjudication.json');
    expect(result.remaining).toHaveLength(REMAINING.length);
  });

  it('maps host corpora without treating them as independent PASS', () => {
    const fake = () => ({ status: 0, stdout: '', stderr: '' });
    const result = execute({ spawn: fake });
    expect(result.almost_pass).toBe(false);
    expect(result.milestone_b).toBe('STARTED');
    expect(HOST_GROUPS.flatMap((group) => group.ids).every((id) => REMAINING.includes(id))).toBe(
      true,
    );
    expect(result.remaining.find((row) => row.id === 'PERF-14').status).toBe('HOST_CORPUS');
    expect(result.remaining.find((row) => row.id === 'PERF-01').status).toBe('HOST_CORPUS');
    expect(result.remaining.find((row) => row.id === 'PERF-02').status).toBe('HOST_CORPUS');
    expect(result.remaining.find((row) => row.id === 'PERF-16').status).toBe('HOST_CORPUS');
    expect(result.remaining.every((row) => row.status !== 'PASS')).toBe(true);
  });
});
