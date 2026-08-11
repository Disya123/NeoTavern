/**
 * Parser unit tests for the cgroup v2 / /proc helpers (ТЗ RES-02, ADR-0026).
 * These are pure functions, so the whole suite runs on any OS — the Linux
 * integration (real cgroup files) is exercised in CI only.
 */
import { describe, expect, it } from 'vitest';
import {
  parseMemoryBytes,
  parseMemoryMax,
  parseProcSelfCgroup,
  parseProcStat,
  parseVmRss,
} from '../src/plugin/cgroup.js';

describe('parseProcSelfCgroup', () => {
  it('extracts the v2 controller path from the 0:: line', () => {
    const content = [
      '12:pids:/user.slice/user-1000.slice/session-1.scope',
      '0::/user.slice/user-1000.slice/user@1000.service/app.scope',
    ].join('\n');
    expect(parseProcSelfCgroup(content)).toBe(
      '/user.slice/user-1000.slice/user@1000.service/app.scope',
    );
  });

  it('treats a bare root path as "/"', () => {
    expect(parseProcSelfCgroup('0::/\n')).toBe('/');
  });

  it('normalizes a path without a leading slash', () => {
    expect(parseProcSelfCgroup('0::user.slice')).toBe('/user.slice');
  });

  it('returns null for v1-only lines', () => {
    expect(parseProcSelfCgroup('2:memory:/foo\n1:cpu:/bar')).toBeNull();
  });

  it('returns null for empty or garbage input', () => {
    expect(parseProcSelfCgroup('')).toBeNull();
    expect(parseProcSelfCgroup('not a cgroup file')).toBeNull();
  });
});

describe('parseMemoryBytes / parseMemoryMax', () => {
  it('parses plain byte values', () => {
    expect(parseMemoryBytes('123456\n')).toBe(123456);
    expect(parseMemoryBytes('0')).toBe(0);
  });

  it('returns null for empty values', () => {
    expect(parseMemoryBytes('')).toBeNull();
    expect(parseMemoryBytes('\n')).toBeNull();
  });

  it('treats "max" as no limit', () => {
    expect(parseMemoryMax('max')).toBeNull();
    expect(parseMemoryMax('')).toBeNull();
    expect(parseMemoryMax('not-a-number')).toBeNull();
  });

  it('parses a numeric memory.max', () => {
    expect(parseMemoryMax('2818572288')).toBe(2818572288);
  });
});

describe('parseVmRss', () => {
  it('parses the VmRSS line in kB', () => {
    const status = [
      'Name:\tnode',
      'State:\tR (running)',
      'VmRSS:\t    65536 kB',
      'VmSize:\t1048576 kB',
    ].join('\n');
    expect(parseVmRss(status)).toBe(65536 * 1024);
  });

  it('returns null when VmRSS is missing or malformed', () => {
    expect(parseVmRss('Name:\tnode\n')).toBeNull();
    expect(parseVmRss('VmRSS:\tunknown kB\n')).toBeNull();
  });
});

describe('parseProcStat', () => {
  it('parses utime+stime with a comm containing spaces and parentheses', () => {
    // (node (worker)) is a legal comm; fields after ')' are space-separated.
    // rest[0] is field 3 (state); utime is field 14 → rest[11], stime is
    // field 15 → rest[12]. Both 100 ticks → 2 s total.
    const stat = '123 (node (worker)) S 1 2 3 4 5 6 7 8 9 10 100 100 13 14 15';
    expect(parseProcStat(stat)).toBe(2000);
  });

  it('returns null for a missing closing paren', () => {
    expect(parseProcStat('123 node S 1 2')).toBeNull();
  });

  it('returns null when the tick fields are not numeric', () => {
    expect(parseProcStat('1 (a) S 1 2 3 4 5 6 7 8 9 10 x y 13')).toBeNull();
  });
});
