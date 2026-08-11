import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  compileRange,
  isValidRange,
  maxSatisfying,
  parseVersion,
  satisfiesRange,
} from '../src/plugin/semver.js';

describe('parseVersion', () => {
  it('parses full versions with prerelease and build metadata', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('v0.0.1-alpha.1')).toEqual({
      major: 0,
      minor: 0,
      patch: 1,
      prerelease: ['alpha', 1],
    });
    expect(parseVersion('2.0.0-rc.1+build.5')?.prerelease).toEqual(['rc', 1]);
  });

  it('rejects malformed versions', () => {
    for (const bad of ['1', '1.2', '1.2.3.4', 'a.b.c', '1.2.x', '1.2.3-', '01.2.3', '']) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders numeric components and prereleases per the spec', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const lower = parseVersion(ordered[index] ?? '');
      const upper = parseVersion(ordered[index + 1] ?? '');
      expect(lower && upper, ordered[index]).toBeTruthy();
      if (lower && upper) {
        expect(compareVersions(lower, upper), `${ordered[index]} < ${ordered[index + 1]}`).toBe(-1);
        expect(compareVersions(upper, lower)).toBe(1);
      }
    }
  });
});

describe('satisfiesRange', () => {
  const cases: Array<[string, string, boolean]> = [
    // exact and equality
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.3', '=1.2.3', true],
    // wildcards
    ['9.9.9', '*', true],
    ['1.2.3', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.5.9', '1.2.x', false],
    ['1.2.9', '1.2.x', true],
    // bare partials
    ['1.9.9', '1', true],
    ['2.0.0', '1', false],
    ['1.2.9', '1.2', true],
    ['1.3.0', '1.2', false],
    // caret
    ['1.2.3', '^1.2.3', true],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['0.0.9', '^0.0.x', true],
    ['0.1.0', '^0.0.x', false],
    // tilde
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.9', '~1', true],
    ['2.0.0', '~1', false],
    // comparison operators
    ['1.5.0', '>=1.2.3', true],
    ['1.2.2', '>=1.2.3', false],
    ['1.2.3', '<=1.2.3', true],
    ['1.2.4', '<=1.2.3', false],
    ['2.0.0', '>1.2.3', true],
    ['1.0.0', '<1.2.3', true],
    // intersections and unions
    ['1.7.0', '>=1.2.3 <1.9.0', true],
    ['1.9.5', '>=1.2.3 <1.9.0', false],
    ['1.0.0', '^1.0.0 || ^2.0.0', true],
    ['2.5.0', '^1.0.0 || ^2.0.0', true],
    ['3.0.0', '^1.0.0 || ^2.0.0', false],
    // hyphen ranges
    ['1.5.0', '1.2.3 - 2.0.0', true],
    ['2.0.0', '1.2.3 - 2.0.0', true],
    ['2.0.1', '1.2.3 - 2.0.0', false],
    ['1.9.9', '1.2 - 2.0', true],
    ['2.1.0', '1.2 - 2.0', false],
    // prerelease gating
    ['2.0.0-alpha', '>1.0.0', false],
    ['2.0.0-alpha', '^2.0.0', false],
    ['2.0.0-alpha', '^2.0.0-alpha', true],
    ['2.0.0-beta', '^2.0.0-alpha', true],
    ['2.0.0', '^2.0.0-alpha', true],
    ['2.1.0-alpha', '^2.0.0-alpha', false],
    ['1.5.0-beta', '>=1.2.3 <2.0.0', false],
  ];

  for (const [version, range, expected] of cases) {
    it(`${version} ${expected ? 'satisfies' : 'does not satisfy'} "${range}"`, () => {
      expect(satisfiesRange(version, range)).toBe(expected);
    });
  }
});

describe('compileRange / isValidRange', () => {
  it('rejects unsupported grammar', () => {
    expect(compileRange('')).toBeNull();
    expect(compileRange('not-a-range')).toBeNull();
    expect(compileRange('>=1.x')).toBeNull();
    expect(compileRange('1.x.2')).toBeNull();
    expect(isValidRange('git+https://example.com/x.git')).toBe(false);
    expect(isValidRange('>=1.0.0')).toBe(true);
  });
});

describe('maxSatisfying', () => {
  it('picks the highest matching version', () => {
    const versions = ['1.2.0', '1.9.3', '2.0.0', '1.9.10', '0.9.0'];
    expect(maxSatisfying(versions, '^1.2.0')).toBe('1.9.10');
    expect(maxSatisfying(versions, '>=2.0.0')).toBe('2.0.0');
    expect(maxSatisfying(versions, '>=3.0.0')).toBeNull();
  });
});
