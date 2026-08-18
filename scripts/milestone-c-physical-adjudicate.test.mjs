import { describe, expect, it } from 'vitest';
import { REQUIRED_SERIAL } from './milestone-c-physical-capture.mjs';
import { adjudicateMilestoneC } from './milestone-c-physical-adjudicate.mjs';

const passing = {
  stamp: '2026-08-18T21-00-00-000Z',
  serial: REQUIRED_SERIAL,
  emulator: false,
  production_cutover: 'NOT_STARTED',
  canary: false,
  production_jni_untouched: true,
  results: [
    { journey: 'flag_off', ok: true },
    { journey: 'live_open', ok: true, messageCount: 0 },
    { journey: 'jni_mapped', ok: true },
    { journey: 'launcher_untouched', ok: true },
    { journey: 'safe_mode', ok: true },
    { journey: 'send', ok: true, after: { title: 'Hazel', count: 1 } },
    { journey: 'reopen', ok: true, after: { title: 'Hazel', count: 1 } },
  ],
};

describe('Milestone C physical journey adjudicator', () => {
  it('never stamps RFC Milestone C PASS or cutover', () => {
    const record = adjudicateMilestoneC(passing, 'live_wire=true production_cutover=false');
    expect(record.milestone_c).toBe('STARTED');
    expect(record.journey_batch).toBe('PASS');
    expect(record.production_cutover).toBe('NOT_STARTED');
    expect(record.canary).toBe(false);
    expect(record.almost_pass).toBe(false);
  });

  it('fails an emulator or the wrong serial', () => {
    const emu = adjudicateMilestoneC({ ...passing, emulator: true, serial: 'emulator-5554' });
    expect(emu.journey_batch).toBe('FAIL');
    expect(emu.physical).toBe(false);
    const other = adjudicateMilestoneC({ ...passing, serial: 'deadbeef' });
    expect(other.journey_batch).toBe('FAIL');
  });

  it('infers JNI from a live route when maps are empty', () => {
    const record = adjudicateMilestoneC({
      ...passing,
      results: passing.results.map((row) =>
        row.journey === 'jni_mapped' ? { ...row, ok: false, inferred_from_live_route: true } : row,
      ),
    });
    expect(record.journey_batch).toBe('PASS');
    expect(record.checks.find((row) => row.id === 'jni_mapped')?.ok).toBe(true);
  });

  it('does not count send unless the message count grew', () => {
    const record = adjudicateMilestoneC({
      ...passing,
      results: [
        ...passing.results.filter((row) => row.journey !== 'send' && row.journey !== 'live_open'),
        { journey: 'live_open', ok: true, messageCount: 0 },
        { journey: 'send', ok: true, after: { title: 'Hazel', count: 0 } },
      ],
    });
    expect(record.checks.find((row) => row.id === 'send')?.ok).toBe(false);
    expect(record.journey_batch).toBe('FAIL');
    expect(record.failed_attempts.some((row) => row.outcome === 'FAILED_ATTEMPT')).toBe(true);
  });

  it('keeps a prior FAILED_ATTEMPT stamp when a later batch passes', () => {
    const previous = {
      failed_attempts: [
        {
          stamp: '2026-08-18T21-55-58-696Z',
          outcome: 'FAILED_ATTEMPT',
          send_round_trip: 'FAIL',
        },
      ],
    };
    const record = adjudicateMilestoneC(
      passing,
      'live_wire=true production_cutover=false',
      previous,
    );
    expect(record.journey_batch).toBe('PASS');
    expect(record.failed_attempts).toEqual(previous.failed_attempts);
  });

  it('fails when live_open is missing', () => {
    const record = adjudicateMilestoneC({
      ...passing,
      results: passing.results.map((row) =>
        row.journey === 'live_open' ? { ...row, ok: false } : row,
      ),
    });
    expect(record.journey_batch).toBe('FAIL');
    expect(record.admissible).toBe(false);
  });
});
