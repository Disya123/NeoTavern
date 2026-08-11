/**
 * Minimal 5-field cron parser (rev4 stage 5, `jobs.schedule({cron})`).
 *
 * Fields: minute hour day-of-month month day-of-week. Supported syntax per
 * field: `*`, a number, `a-b` ranges, step forms (`*\/n` and `a-b\/n`), and
 * `a,b` lists. Day-of-week 0–7 (both 0 and 7 are Sunday). Months 1–12,
 * days 1–31 (day-of-month > days-in-month simply never matches that month).
 *
 * Deliberately no external dependency and no DST magic: times are UTC epoch
 * millis computed from UTC wall-clock components.
 */

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function fieldValues(expression: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of expression.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) throw new Error('empty cron field');
    const stepMatch = /^(\*|(\d+)(?:-(\d+))?)\/(\d+)$/u.exec(trimmed);
    if (stepMatch) {
      const step = Number(stepMatch[4]);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: ${trimmed}`);
      let start: number;
      let end: number;
      if (stepMatch[2] === undefined) {
        start = min;
        end = max;
      } else {
        start = Number(stepMatch[2]);
        end = stepMatch[3] === undefined ? max : Number(stepMatch[3]);
      }
      if (start < min || end > max || start > end) throw new Error(`bad cron range: ${trimmed}`);
      for (let value = start; value <= end; value += step) values.add(value);
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/u.exec(trimmed);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < min || end > max || start > end) throw new Error(`bad cron range: ${trimmed}`);
      for (let value = start; value <= end; value += 1) values.add(value);
      continue;
    }
    if (trimmed === '*') {
      for (let value = min; value <= max; value += 1) values.add(value);
      continue;
    }
    const single = Number(trimmed);
    if (!Number.isInteger(single) || single < min || single > max) {
      throw new Error(`bad cron value: ${trimmed}`);
    }
    values.add(single);
  }
  if (values.size === 0) throw new Error('empty cron field');
  return values;
}

/** Parse a 5-field cron expression (throws on invalid input). */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new Error(`cron must have 5 fields, got ${fields.length}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const dow = fieldValues(dayOfWeek!, 0, 7);
  if (dow.has(7)) dow.add(0); // 7 == Sunday
  return {
    minutes: fieldValues(minute!, 0, 59),
    hours: fieldValues(hour!, 0, 23),
    daysOfMonth: fieldValues(dayOfMonth!, 1, 31),
    months: fieldValues(month!, 1, 12),
    daysOfWeek: dow,
  };
}

function matches(parts: Date, cron: CronSchedule): boolean {
  const dow = parts.getUTCDay();
  if (!cron.daysOfWeek.has(dow)) return false;
  if (!cron.daysOfMonth.has(parts.getUTCDate())) return false;
  if (!cron.months.has(parts.getUTCMonth() + 1)) return false;
  if (!cron.hours.has(parts.getUTCHours())) return false;
  if (!cron.minutes.has(parts.getUTCMinutes())) return false;
  return true;
}

/**
 * Next fire time strictly after `from` (UTC). Bounded search: at most 5
 * years ahead, minute-resolution — 2 629 800 iterations worst case.
 */
export function nextCronAfter(from: number, cron: CronSchedule): number {
  const MAX_LOOKAHEAD_MS = 5 * 365 * DAY_MS;
  const start = new Date(from);
  start.setUTCSeconds(0, 0);
  const minute = 60 * 1000;
  const firstCandidate = start.getTime() + minute; // strictly after `from`
  const limit = from + MAX_LOOKAHEAD_MS;
  for (let timestamp = firstCandidate; timestamp <= limit; timestamp += minute) {
    if (matches(new Date(timestamp), cron)) return timestamp;
  }
  throw new Error('cron never fires within 5 years');
}
