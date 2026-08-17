/**
 * Style-contract tests (AGENTS.md §14, §23, §27).
 *
 * Locks the styling rules of the built-in UI:
 *  1. Standard control geometry is expressed through `var(--st-*)` tokens —
 *     raw px literals for control sizes, font weights, px font sizes,
 *     raw radii and numeric z-index values are forbidden.
 *  2. `!important` is forbidden except in the a11y override stylesheet
 *     (`preferences.css`) and the M-1 measurement user-layer stylesheet
 *     (`measurement.css`, AGENTS.md §14 user layer).
 *  3. Every viewport and container breakpoint used by the built-in CSS is
 *     registered in the theme-sdk breakpoint registry.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extname, basename, resolve } from 'node:path';
import { VIEWPORT_BREAKPOINTS, CONTAINER_BREAKPOINTS, DEFAULT_LIGHT_TOKENS } from '../src/index.js';
import { SCAN_DIRS, collectSourceFiles, repoRoot } from './helpers.js';

/** Files exempt from the `!important` ban: a11y override and M-1 user layer. */
const IMPORTANT_EXEMPT = new Set(['preferences.css', 'measurement.css']);

/**
 * Token definition file: the canonical source of literal token values.
 * Literal geometry is allowed here by definition — every other file must
 * reference `var(--st-*)`.
 */
const LITERAL_EXEMPT = new Set(['tokens.css']);

const COMMENT = /\/\*[\s\S]*?\*\//gu;

function readCssWithoutComments(file: string): string {
  return readFileSync(file, 'utf8').replace(COMMENT, '');
}

/** Raw literals that must be expressed through tokens. */
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /font-weight:\s*(?:100|200|300|400|500|520|600|650|700|800|900|normal|medium|semibold|bold)\s*;/gu,
    label: 'numeric/named font-weight (use --st-font-weight-*)',
  },
  { re: /font-size:\s*\d+px\s*;/gu, label: 'px font-size (use --st-font-size-*)' },
  { re: /z-index:\s*-?\d+\s*;/gu, label: 'numeric z-index (use --st-layer-*)' },
  { re: /border-radius:\s*\d+px\s*;/gu, label: 'raw px border-radius (use --st-radius-*)' },
  {
    re: /(?:width|height):\s*(?:40|44|52)px\s*;/gu,
    label: 'control size literal (use --st-control-height-*)',
  },
  {
    re: /(?:height|min-height):\s*(?:32|36)px\s*;/gu,
    label: 'control size literal (use --st-control-height-*)',
  },
  { re: /min-height:\s*52px\s*;/gu, label: 'control size literal (use --st-control-height-large)' },
];

const isCssFile = (fileName: string): boolean => extname(fileName) === '.css';

const cssFiles = SCAN_DIRS.flatMap((dir) => collectSourceFiles(dir, isCssFile));

describe('style contract: tokenized literals', () => {
  for (const { re, label } of FORBIDDEN_PATTERNS) {
    it(`forbids ${label}`, () => {
      const violations: string[] = [];
      for (const file of cssFiles) {
        if (LITERAL_EXEMPT.has(basename(file))) continue;
        const css = readCssWithoutComments(file);
        for (const match of css.matchAll(re)) {
          const line = css.slice(0, match.index).split('\n').length;
          violations.push(`${file.replace(repoRoot + '/', '')}:${line}: ${match[0].trim()}`);
        }
      }
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }

  it('forbids !important outside the a11y override stylesheet', () => {
    const violations: string[] = [];
    for (const file of cssFiles) {
      if (IMPORTANT_EXEMPT.has(basename(file))) continue;
      const css = readCssWithoutComments(file);
      for (const match of css.matchAll(/!important/gu)) {
        const line = css.slice(0, match.index).split('\n').length;
        violations.push(`${file.replace(repoRoot + '/', '')}:${line}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('style contract: M-1 measurement user layer', () => {
  it('keeps the glass-off stylesheet in the user cascade layer', () => {
    const css = readFileSync(resolve(repoRoot, 'packages/ui/src/styles/measurement.css'), 'utf8');
    const index = readFileSync(resolve(repoRoot, 'packages/ui/src/index.css'), 'utf8');
    expect(css).toContain('@layer user');
    expect(css).toContain("[data-nt-measurement-glass='off']");
    expect(index).toContain('./styles/measurement.css');
  });
});

describe('style contract: overlay layers', () => {
  it('keeps portalled dropdowns above modal panels and below notifications', () => {
    const dropdown = Number(DEFAULT_LIGHT_TOKENS['layer-dropdown']);
    const modal = Number(DEFAULT_LIGHT_TOKENS['layer-modal']);
    const notification = Number(DEFAULT_LIGHT_TOKENS['layer-notification']);

    expect(dropdown).toBeGreaterThan(modal);
    expect(dropdown).toBeLessThan(notification);
  });
});

describe('style contract: breakpoint registry', () => {
  it('only uses registered viewport breakpoints', () => {
    const violations: string[] = [];
    for (const file of cssFiles) {
      const css = readFileSync(file, 'utf8');
      const re = /@media\s+\((?<prop>min|max)-width:\s*(?<value>\d+)(?<unit>px|rem)\)/gu;
      for (const match of css.matchAll(re)) {
        const { prop, value, unit } = match.groups as { prop: string; value: string; unit: string };
        const number = Number(value);
        const line = css.slice(0, match.index).split('\n').length;
        if (unit === 'px' && prop === 'max' && !VIEWPORT_BREAKPOINTS.includes(number)) {
          violations.push(
            `${file.replace(repoRoot + '/', '')}:${line}: unregistered viewport breakpoint ${number}px`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('only uses registered container breakpoints in rem', () => {
    const violations: string[] = [];
    for (const file of cssFiles) {
      const css = readFileSync(file, 'utf8');
      const re = /@container[^(]*\((?<prop>min|max)-width:\s*(?<value>\d+)(?<unit>px|rem)\)/gu;
      for (const match of css.matchAll(re)) {
        const { value, unit } = match.groups as { prop: string; value: string; unit: string };
        const number = Number(value);
        const line = css.slice(0, match.index).split('\n').length;
        if (unit === 'px') {
          violations.push(
            `${file.replace(repoRoot + '/', '')}:${line}: container breakpoint must use rem (${number}px)`,
          );
        } else if (!CONTAINER_BREAKPOINTS.includes(number)) {
          violations.push(
            `${file.replace(repoRoot + '/', '')}:${line}: unregistered container breakpoint ${number}rem`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('breakpoint registry is sorted and unique', () => {
    const sortedViewport = [...VIEWPORT_BREAKPOINTS].sort((a, b) => a - b);
    const sortedContainer = [...CONTAINER_BREAKPOINTS].sort((a, b) => a - b);
    expect(VIEWPORT_BREAKPOINTS).toEqual(sortedViewport);
    expect(CONTAINER_BREAKPOINTS).toEqual(sortedContainer);
    expect(new Set(VIEWPORT_BREAKPOINTS).size).toBe(VIEWPORT_BREAKPOINTS.length);
    expect(new Set(CONTAINER_BREAKPOINTS).size).toBe(CONTAINER_BREAKPOINTS.length);
  });
});

describe('style contract: host-connect gate', () => {
  it('skins the gate through the public data-component contract, not a CSS module', () => {
    const css = readFileSync(resolve(repoRoot, 'packages/ui/src/styles/components.css'), 'utf8');
    expect(css).toContain("[data-component='host-connect']");
    expect(css).toContain("[data-component='host-connect'] [data-part='panel']");
    expect(css).toContain("[data-component='host-connect'] [data-part='header']");
    expect(css).toContain("[data-component='host-connect'] [data-part='actions']");
    expect(css).not.toMatch(/\[data-component='host-connect'\][^{]*\{[^}]*#[0-9a-fA-F]{3,8}/u);
  });
});
