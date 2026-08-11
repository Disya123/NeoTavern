/**
 * Rev4 stage 5: cron parser (apps/server/src/lib/cron.ts). Verifies field
 * syntax, UTC next-match computation, day-of-week aliasing and bounds.
 */
import { describe, expect, it } from 'vitest';
import { nextCronAfter, parseCron } from '../src/lib/cron.js';

describe('cron parser', () => {
  it('accepts * and numeric fields', () => {
    const cron = parseCron('* * * * *');
    expect(cron.minutes.size).toBe(60);
    expect(cron.hours.size).toBe(24);
    expect(cron.daysOfMonth.size).toBe(31);
    expect(cron.months.size).toBe(12);
    // 0–7, where 7 is an alias for Sunday (0).
    expect(cron.daysOfWeek.size).toBe(8);
  });

  it('parses ranges, steps, lists and mixed forms', () => {
    const cron = parseCron('0,15,30,45 9-17/2 */5 1,6 1-5');
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([9, 11, 13, 15, 17]);
    expect([...cron.daysOfMonth]).toEqual([1, 6, 11, 16, 21, 26, 31]);
    expect([...cron.months]).toEqual([1, 6]);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('aliases day-of-week 7 to Sunday', () => {
    const cron = parseCron('* * * * 7');
    expect(cron.daysOfWeek.has(0)).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('* 24 * * *')).toThrow();
    expect(() => parseCron('* * 0 * *')).toThrow();
    expect(() => parseCron('* * * 13 *')).toThrow();
    expect(() => parseCron('* * * * 8')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow();
    expect(() => parseCron('5-1 * * * *')).toThrow();
    expect(() => parseCron('junk * * * *')).toThrow();
    expect(() => parseCron('* * * *')).toThrow();
  });
});

describe('nextCronAfter', () => {
  const UTC = (iso: string): number => Date.parse(`${iso}Z`);

  it('finds the next minute for every-minute schedules', () => {
    const cron = parseCron('* * * * *');
    expect(nextCronAfter(UTC('2026-08-07T10:15:30'), cron)).toBe(UTC('2026-08-07T10:16:00'));
  });

  it('respects the minute field', () => {
    const cron = parseCron('0,30 * * * *');
    expect(nextCronAfter(UTC('2026-08-07T10:15:00'), cron)).toBe(UTC('2026-08-07T10:30:00'));
    expect(nextCronAfter(UTC('2026-08-07T10:30:00'), cron)).toBe(UTC('2026-08-07T11:00:00'));
  });

  it('rolls over hours and days', () => {
    const cron = parseCron('0 3 * * *');
    expect(nextCronAfter(UTC('2026-08-07T10:15:00'), cron)).toBe(UTC('2026-08-08T03:00:00'));
  });

  it('honours day-of-month and month', () => {
    const cron = parseCron('0 0 1 1 *');
    expect(nextCronAfter(UTC('2026-08-07T10:15:00'), cron)).toBe(UTC('2027-01-01T00:00:00'));
  });

  it('combines day-of-month and day-of-week (both must match)', () => {
    const cron = parseCron('0 0 13 * 5');
    // 2026-08-13 is a Thursday, so the next match must be a Friday the 13th.
    expect(nextCronAfter(UTC('2026-08-07T00:00:00'), cron)).toBe(UTC('2026-11-13T00:00:00'));
  });

  it('returns strictly after the from timestamp', () => {
    const cron = parseCron('* * * * *');
    const exact = UTC('2026-08-07T10:15:00');
    expect(nextCronAfter(exact, cron)).toBe(exact + 60_000);
  });

  it('bounded search throws for never-firing schedules', () => {
    const cron = parseCron('0 0 30 2 *'); // Feb 30 never exists
    expect(() => nextCronAfter(UTC('2026-08-07T00:00:00'), cron)).toThrow(/5 years/);
  });
});
