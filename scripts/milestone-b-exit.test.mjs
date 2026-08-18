import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  evaluateFile,
  P99_NS,
  P99_ROLE,
  RECORD_PATH,
  REQUIRED_PERF,
  SCHEMA,
} from './milestone-b-exit.mjs';

function load() {
  return JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
}

describe('milestone B-exit registry', () => {
  it('keeps the committed registry STARTED and refuses can_pass', () => {
    const registry = load();
    const result = evaluate(registry);
    expect(registry.schema).toBe(SCHEMA);
    expect(registry.milestone_b).toBe('STARTED');
    expect(registry.almost_pass).toBe(false);
    expect(registry.production_cutover).toBe('NOT_STARTED');
    expect(registry.perf22).toBe('PASS');
    expect(registry.perf15).toBe('PASS');
    expect(registry.input_to_present_p99_ns).toBe(P99_NS);
    expect(registry.input_to_present_p99_ms).toBe(20.65);
    expect(registry.input_to_present_p99_role).toBe(P99_ROLE);
    expect(registry.release_budget_calibration_adr).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.can_pass).toBe(false);
    expect(result.milestone_b).toBe('STARTED');
    expect(result.failures.some((row) => row.startsWith('PERF-01'))).toBe(true);
    expect(result.failures.some((row) => row.includes('prettier-mass-drift'))).toBe(true);
  });

  it('requires every PERF-01…05 and PERF-11…22 slot', () => {
    expect(REQUIRED_PERF).toEqual([
      'PERF-01',
      'PERF-02',
      'PERF-03',
      'PERF-04',
      'PERF-05',
      'PERF-11',
      'PERF-12',
      'PERF-13',
      'PERF-14',
      'PERF-15',
      'PERF-16',
      'PERF-17',
      'PERF-18',
      'PERF-19',
      'PERF-20',
      'PERF-21',
      'PERF-22',
    ]);
    const registry = load();
    for (const id of REQUIRED_PERF) {
      expect(registry.required_perf).toContain(id);
      expect(registry.criteria[id]).toBeTruthy();
    }
  });

  it('cross-checks PERF-15 PASS against the independent adjudication record', () => {
    const registry = load();
    expect(registry.criteria['PERF-15'].status).toBe('PASS');
    expect(registry.criteria['PERF-15'].admissible).toBe(true);
    expect(registry.criteria['PERF-15'].pass_requires).toBeUndefined();
    const stamp = JSON.parse(
      readFileSync(new URL('../docs/rfc/perf-15-adjudication.json', import.meta.url), 'utf8'),
    );
    expect(stamp.perf15).toBe('PASS');
    expect(stamp.visual_surface).toBe('present');
    expect(stamp.milestone_b).toBe('STARTED');
    expect(stamp.almost_pass).toBe(false);
  });

  it('cross-checks PERF-22 PASS against the independent adjudication record', () => {
    const registry = load();
    expect(registry.criteria['PERF-22'].status).toBe('PASS');
    expect(registry.criteria['PERF-22'].admissible).toBe(true);
    expect(registry.criteria['PERF-22'].pass_requires).toBeUndefined();
    const stamp = JSON.parse(
      readFileSync(new URL('../docs/rfc/perf-22-adjudication.json', import.meta.url), 'utf8'),
    );
    expect(stamp.perf22).toBe('PASS');
    expect(stamp.milestone_b).toBe('STARTED');
    const forged = structuredClone(registry);
    forged.criteria['PERF-22'].status = 'PASS';
    forged.criteria['PERF-22'].independent = true;
    forged.criteria['PERF-22'].admissible = true;
    forged.criteria['PERF-22'].pass_requires = 'android_platform_surface_fixture';
    forged.milestone_b = 'PASS';
    const result = evaluate(forged);
    expect(result.ok).toBe(false);
    expect(result.can_pass).toBe(false);
    expect(result.failures.some((row) => row.includes('PERF-22'))).toBe(true);
  });

  it('forbids Milestone B = PASS while evidence is incomplete', () => {
    const forged = structuredClone(load());
    forged.milestone_b = 'PASS';
    const result = evaluate(forged);
    expect(result.ok).toBe(false);
    expect(result.milestone_b).toBe('STARTED');
    expect(result.failures[0]).toMatch(/Milestone B = PASS is forbidden/);
  });

  it('cross-checks PERF-18/19/20 against the independent adjudication record', () => {
    const registry = load();
    const stamp = JSON.parse(
      readFileSync(new URL('../docs/rfc/perf-18-20-adjudication.json', import.meta.url), 'utf8'),
    );
    expect(stamp.perf18).toBe('PASS');
    expect(stamp.perf19).toBe('PASS');
    expect(stamp.perf20).toBe('PASS');
    expect(stamp.milestone_b).toBe('STARTED');
    expect(registry.criteria['PERF-18'].status).toBe('PASS');
    expect(registry.criteria['PERF-19'].status).toBe('PASS');
    expect(registry.criteria['PERF-20'].status).toBe('PASS');
    const forged = structuredClone(registry);
    forged.criteria['PERF-18'].record = 'docs/rfc/missing-adjudication.json';
    expect(evaluate(forged).failures.some((row) => row.includes('PERF-18'))).toBe(true);
  });

  it('requires physical device-loss injection and explicit baseline waivers for B PASS', () => {
    const registry = load();
    expect(registry.device_loss_injection.physical).toBe(true);
    expect(registry.device_loss_injection.status).toBe('PASS');
    expect(registry.known_baseline_failures.every((row) => row.status === 'OPEN')).toBe(true);
    const forged = structuredClone(registry);
    forged.device_loss_injection.physical = true;
    forged.known_baseline_failures = forged.known_baseline_failures.map((row) => ({
      ...row,
      status: 'FIXED',
    }));
    const stillBlocked = evaluate(forged);
    expect(stillBlocked.can_pass).toBe(false);
    expect(stillBlocked.failures.some((row) => row.startsWith('PERF-01'))).toBe(true);
  });

  it('does not treat raw i2p p99 as a release budget', () => {
    const forged = structuredClone(load());
    forged.input_to_present_p99_role = 'release-budget';
    const result = evaluate(forged);
    expect(result.failures.some((row) => row.includes('release budget'))).toBe(true);
  });

  it('evaluateFile reads the committed registry', () => {
    const result = evaluateFile();
    expect(result.ok).toBe(true);
    expect(result.can_pass).toBe(false);
    expect(result.perf22).toBe('PASS');
    expect(result.perf15).toBe('PASS');
  });
});
