/**
 * Token contract integrity tests (AGENTS.md §14, §27).
 *
 * Guarantees a single source of truth for the `--st-*` theming contract:
 *  1. Every `var(--st-...)` referenced anywhere in the UI source tree exists
 *     in TOKEN_NAMES — components must not silently reference undefined
 *     tokens.
 *  2. The runtime default stylesheet (packages/ui tokens.css) declares exactly
 *     the canonical token set with the same light-mode default values.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import {
  TOKEN_NAMES,
  DEFAULT_LIGHT_TOKENS,
  DEFAULT_DARK_TOKENS,
  TOKEN_PREFIX,
} from '../src/index.js';
import { SCAN_DIRS, collectSourceFiles, repoRoot } from './helpers.js';

const tokenSet = new Set(TOKEN_NAMES);

const SCAN_EXTENSIONS = new Set(['.css', '.ts', '.tsx', '.js', '.jsx']);
const TOKENS_CSS_PATH = resolve(repoRoot, 'packages/ui/src/styles/tokens.css');

const CSS_VAR_REFERENCE = /var\(\s*(--st-[\w-]+)/gu;
const CSS_VAR_DEFINITION = /(--st-[\w-]+)\s*:/gu;

const isScannedSource = (fileName: string): boolean => SCAN_EXTENSIONS.has(extname(fileName));

// Test/spec fixtures may use fake token names on purpose (e.g. themeTokens
// tests alias `var(--st-color-accent-base)`); they are not runtime references.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/u;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//gu;
const LINE_COMMENT = /\/\/[^\n]*/gu;

function collectReferencedTokenNames(): string[] {
  const names = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const file of collectSourceFiles(dir, isScannedSource)) {
      if (TEST_FILE.test(file)) continue;
      // Doc comments may mention `var(--st-...)` as prose (e.g. aliasing
      // examples); they are not runtime references either.
      const content = readFileSync(file, 'utf8')
        .replace(BLOCK_COMMENT, '')
        .replace(LINE_COMMENT, '');
      for (const match of content.matchAll(CSS_VAR_REFERENCE)) {
        names.add(match[1]!.slice(TOKEN_PREFIX.length));
      }
    }
  }
  return [...names];
}

/** Parse a named CSS block into its `--st-*` variable definitions. */
function parseBlockVariables(block: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of block.matchAll(CSS_VAR_DEFINITION)) {
    const start = match.index! + match[0].length;
    const lineEnd = block.indexOf('\n', start);
    const value = block
      .slice(start, lineEnd === -1 ? undefined : lineEnd)
      .trim()
      .replace(/;$/u, '');
    vars.set(match[1]!, value);
  }
  return vars;
}

function extractBlock(content: string, selector: string): string {
  const marker = `${selector} {`;
  const start = content.indexOf(marker);
  expect(start, `${selector} block must exist in tokens.css`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = content.indexOf('}', bodyStart);
  return content.slice(bodyStart, end);
}

describe('token contract: source usage', () => {
  it('every var(--st-*) used in the UI source is a canonical token', () => {
    const undefinedTokens = collectReferencedTokenNames()
      .filter((name) => !tokenSet.has(name))
      .sort();
    expect(undefinedTokens).toEqual([]);
  });
});

describe('token contract: stylesheet defaults', () => {
  const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
  const rootVars = parseBlockVariables(extractBlock(css, ':root'));
  const darkVars = parseBlockVariables(extractBlock(css, ":root[data-theme-mode='dark']"));
  const mediaDarkVars = parseBlockVariables(
    extractBlock(css, ":root:not([data-theme-mode='light'])"),
  );

  it('declares exactly the canonical token set in :root', () => {
    const declared = [...rootVars.keys()].sort();
    const canonical = TOKEN_NAMES.map((name) => `${TOKEN_PREFIX}${name}`).sort();
    expect(declared).toEqual(canonical);
  });

  it('dark-mode overrides only reference canonical tokens', () => {
    for (const name of darkVars.keys()) {
      expect(tokenSet.has(name.slice(TOKEN_PREFIX.length)), name).toBe(true);
    }
  });

  it('light-mode defaults match the SDK default token values', () => {
    for (const name of TOKEN_NAMES) {
      const cssValue = rootVars.get(`${TOKEN_PREFIX}${name}`);
      expect(cssValue, name).toBeDefined();
      const sdkValue = DEFAULT_LIGHT_TOKENS[name];
      const normalized = stripOuterQuotes(sdkValue.trim());
      expect(cssValue, name).toBe(normalized);
    }
  });

  it('dark-mode overrides match the SDK dark token values exactly', () => {
    for (const name of TOKEN_NAMES) {
      const darkValue = DEFAULT_DARK_TOKENS[name];
      const lightValue = DEFAULT_LIGHT_TOKENS[name];
      const cssValue = darkVars.get(`${TOKEN_PREFIX}${name}`);
      if (darkValue === lightValue) {
        // Tokens unchanged in dark mode must not be redeclared (drift bait).
        expect(cssValue, `${name} redeclared without a dark difference`).toBeUndefined();
      } else {
        expect(cssValue, name).toBeDefined();
        expect(cssValue, name).toBe(stripOuterQuotes(darkValue.trim()));
      }
    }
  });

  it('the prefers-color-scheme dark block mirrors the dark-mode attribute block', () => {
    expect([...mediaDarkVars.entries()].sort()).toEqual([...darkVars.entries()].sort());
  });
});

/** Remove a wrapping quote pair only when the whole value is quoted. */
function stripOuterQuotes(value: string): string {
  const first = value[0];
  if ((first === "'" || first === '"') && value.endsWith(first) && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}
