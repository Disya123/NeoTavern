/**
 * Minimal semver engine for plugin dependency resolution.
 *
 * Deliberately dependency-free (the server must not require npm or any
 * install-time packages, AGENTS.md §4/§21). Supports the range subset that
 * npm `dependencies` realistically use: exact, `x`/`*` partials, `^`, `~`,
 * comparison operators, hyphen ranges and `||` unions. Build metadata is
 * ignored; prerelease precedence follows the semver 2.0.0 spec, including
 * the "prereleases only match comparators with a prerelease on the same
 * major.minor.patch tuple" rule.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<string | number>;
}

interface PartialVersion {
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: ReadonlyArray<string | number>;
}

type Operator = '<' | '<=' | '=' | '>=' | '>';

interface Comparator {
  operator: Operator;
  version: ParsedVersion;
}

/** One `||` branch: a conjunction of comparators, or "any version". */
interface ComparatorSet {
  any: boolean;
  comparators: Comparator[];
}

// Numeric identifiers must not contain leading zeroes (semver §2).
const FULL_VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/u;
const PARTIAL_COMPONENT_PATTERN = /^(0|[1-9]\d*|[xX*])$/u;
const MAX_SAFE_COMPONENT = Number.MAX_SAFE_INTEGER;

/** Parse a full `major.minor.patch[-prerelease][+build]` version string. */
export function parseVersion(input: string): ParsedVersion | null {
  const match = FULL_VERSION_PATTERN.exec(input.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > MAX_SAFE_COMPONENT || minor > MAX_SAFE_COMPONENT || patch > MAX_SAFE_COMPONENT) {
    return null;
  }
  const prerelease = parsePrerelease(match[4]);
  // `parsePrerelease` returns [] both for "no tag" and "invalid tag"; the
  // regex only captures non-empty tags, so [] here means invalid identifiers.
  if (match[4] !== undefined && prerelease.length === 0) return null;
  return { major, minor, patch, prerelease };
}

function parsePrerelease(raw: string | undefined): ReadonlyArray<string | number> {
  if (!raw) return [];
  const identifiers: Array<string | number> = [];
  for (const identifier of raw.split('.')) {
    if (identifier.length === 0) return [];
    if (/^\d+$/u.test(identifier)) {
      if (identifier.length > 1 && identifier.startsWith('0')) return [];
      const numeric = Number(identifier);
      if (numeric > MAX_SAFE_COMPONENT) return [];
      identifiers.push(numeric);
    } else {
      identifiers.push(identifier);
    }
  }
  return identifiers;
}

/** semver 2.0.0 precedence comparison. Build metadata is not part of input. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const [left, right] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    if (left !== right) return left < right ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(
  a: ReadonlyArray<string | number>,
  b: ReadonlyArray<string | number>,
): number {
  if (a.length === 0 && b.length === 0) return 0;
  // A release outranks any of its prereleases.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    const result = compareIdentifier(left, right);
    if (result !== 0) return result;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareIdentifier(a: string | number, b: string | number): number {
  const aNumeric = typeof a === 'number';
  const bNumeric = typeof b === 'number';
  if (aNumeric && bNumeric) return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Parse a (possibly partial) version token used inside ranges. */
function parsePartialVersion(input: string): PartialVersion | null {
  const trimmed = input.trim().replace(/^v/iu, '');
  if (trimmed === '' || trimmed === '*' || /^[xX]$/u.test(trimmed)) {
    return { major: null, minor: null, patch: null, prerelease: [] };
  }
  const [core, prereleaseRaw] = splitPrerelease(trimmed);
  const components = core.split('.');
  if (components.length > 3) return null;
  const values: Array<number | null> = [];
  for (const component of components) {
    const match = PARTIAL_COMPONENT_PATTERN.exec(component);
    if (!match) return null;
    const raw = match[1] ?? '';
    if (/^[xX*]$/u.test(raw)) values.push(null);
    else {
      const numeric = Number(raw);
      if (numeric > MAX_SAFE_COMPONENT) return null;
      values.push(numeric);
    }
  }
  // `1.x.2`-style mixing of wildcards and digits is not a valid range token.
  let seenWildcard = false;
  for (const value of values) {
    if (value === null) seenWildcard = true;
    else if (seenWildcard) return null;
  }
  const prerelease = parsePrerelease(prereleaseRaw);
  if (prereleaseRaw !== undefined && prerelease.length === 0) return null;
  return {
    major: values[0] ?? null,
    minor: values.length > 1 ? (values[1] ?? null) : null,
    patch: values.length > 2 ? (values[2] ?? null) : null,
    prerelease,
  };
}

function splitPrerelease(input: string): [string, string | undefined] {
  const index = input.indexOf('-');
  if (index === -1) return [input, undefined];
  return [input.slice(0, index), input.slice(index + 1)];
}

function complete(partial: PartialVersion): ParsedVersion {
  return {
    major: partial.major ?? 0,
    minor: partial.minor ?? 0,
    patch: partial.patch ?? 0,
    prerelease: partial.prerelease,
  };
}

function increment(partial: PartialVersion, level: 'major' | 'minor' | 'patch'): ParsedVersion {
  const major = partial.major ?? 0;
  const minor = partial.minor ?? 0;
  const patch = partial.patch ?? 0;
  if (level === 'major') return { major: major + 1, minor: 0, patch: 0, prerelease: ['0'] };
  if (level === 'minor') return { major, minor: minor + 1, patch: 0, prerelease: ['0'] };
  return { major, minor, patch: patch + 1, prerelease: ['0'] };
}

/**
 * Compile a range expression into comparator sets. Returns null when the
 * expression is not part of the supported grammar.
 */
export function compileRange(input: string): ComparatorSet[] | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const sets: ComparatorSet[] = [];
  for (const branch of trimmed.split('||')) {
    const set = compileComparatorSet(branch.trim());
    if (!set) return null;
    sets.push(set);
  }
  return sets.length > 0 ? sets : null;
}

function compileComparatorSet(branch: string): ComparatorSet | null {
  if (branch === '' || branch === '*' || /^[xX]$/u.test(branch)) {
    return { any: true, comparators: [] };
  }

  // Hyphen range: `A - B` (whitespace around the dash is mandatory, which is
  // what lets prerelease dashes inside versions stay unambiguous).
  const tokens = branch.split(/\s+/u).filter((token) => token.length > 0);
  const dashIndex = tokens.indexOf('-');
  if (dashIndex > 0) {
    if (dashIndex !== 1 || tokens.length !== 3) return null;
    const lower = parsePartialVersion(tokens[0] ?? '');
    const upper = parsePartialVersion(tokens[2] ?? '');
    if (!lower || !upper) return null;
    const comparators: Comparator[] = [{ operator: '>=', version: complete(lower) }];
    comparators.push(...upperBound(upper));
    return { any: false, comparators };
  }

  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const compiled = compileToken(token);
    if (!compiled) return null;
    comparators.push(...compiled);
  }
  return comparators.length > 0 ? { any: false, comparators } : { any: true, comparators: [] };
}

function compileToken(token: string): Comparator[] | null {
  const operatorMatch = /^(>=|<=|>|<|=|\^|~)?(.*)$/u.exec(token);
  if (!operatorMatch) return null;
  const operator = operatorMatch[1];
  const rawVersion = operatorMatch[2] ?? '';
  const partial = parsePartialVersion(rawVersion);
  if (!partial) return null;
  // `^`, `~` or a comparison operator without a version is not a range.
  if (rawVersion.trim() === '' && operator !== undefined) return null;
  // A bare `*` contributes no constraint to an intersecting set.
  if (operator === undefined && partial.major === null) return [];

  if (operator === '^') return caretRange(partial);
  if (operator === '~') return tildeRange(partial);

  const hasWildcard = partial.major === null || partial.minor === null || partial.patch === null;

  switch (operator) {
    case '>':
    case '>=':
    case '<':
    case '<=':
      if (hasWildcard) return null;
      return [{ operator, version: complete(partial) }];
    case '=':
    case undefined:
      if (!hasWildcard) return [{ operator: '=', version: complete(partial) }];
      // Bare partial: `1` → >=1.0.0 <2.0.0-0, `1.2` → >=1.2.0 <1.3.0-0.
      return [{ operator: '>=', version: complete(partial) }, ...upperBound(partial)];
    default:
      return null;
  }
}

/** Inclusive upper bound of a partial version expressed as `< next`. */
function upperBound(partial: PartialVersion): Comparator[] {
  if (partial.major === null) return [];
  if (partial.minor === null) return [{ operator: '<', version: increment(partial, 'major') }];
  if (partial.patch === null) return [{ operator: '<', version: increment(partial, 'minor') }];
  // Fully specified: the hyphen upper end is inclusive.
  return [{ operator: '<=', version: complete(partial) }];
}

function caretRange(partial: PartialVersion): Comparator[] | null {
  if (partial.major === null) return [];
  const lower: Comparator = { operator: '>=', version: complete(partial) };
  const major = partial.major;
  if (major > 0 || partial.minor === null) {
    return [lower, { operator: '<', version: increment(partial, 'major') }];
  }
  const minor = partial.minor;
  if (minor > 0 || partial.patch === null) {
    return [lower, { operator: '<', version: increment(partial, 'minor') }];
  }
  return [lower, { operator: '<', version: increment(partial, 'patch') }];
}

function tildeRange(partial: PartialVersion): Comparator[] | null {
  if (partial.major === null) return [];
  const lower: Comparator = { operator: '>=', version: complete(partial) };
  if (partial.minor === null) {
    return [lower, { operator: '<', version: increment(partial, 'major') }];
  }
  return [lower, { operator: '<', version: increment(partial, 'minor') }];
}

function matchesComparator(version: ParsedVersion, comparator: Comparator): boolean {
  const result = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case '=':
      return result === 0;
    case '>':
      return result > 0;
    case '>=':
      return result >= 0;
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
    default:
      return false;
  }
}

/**
 * True when `version` satisfies `range`. Prerelease versions only satisfy a
 * comparator set when one of its comparators carries a prerelease on the same
 * major.minor.patch tuple (mirrors npm semver semantics).
 */
export function satisfiesRange(versionInput: string, rangeInput: string): boolean {
  const version = parseVersion(versionInput);
  const sets = compileRange(rangeInput);
  if (!version || !sets) return false;
  return sets.some((set) => matchesSet(version, set));
}

function matchesSet(version: ParsedVersion, set: ComparatorSet): boolean {
  if (version.prerelease.length > 0 && !setAllowsPrerelease(version, set)) return false;
  if (set.any) return version.prerelease.length === 0;
  return set.comparators.every((comparator) => matchesComparator(version, comparator));
}

function setAllowsPrerelease(version: ParsedVersion, set: ComparatorSet): boolean {
  return set.comparators.some(
    (comparator) =>
      comparator.version.prerelease.length > 0 &&
      comparator.version.major === version.major &&
      comparator.version.minor === version.minor &&
      comparator.version.patch === version.patch,
  );
}

/** Highest version from `candidates` that satisfies `range`, if any. */
export function maxSatisfying(candidates: readonly string[], rangeInput: string): string | null {
  let best: ParsedVersion | null = null;
  let bestRaw: string | null = null;
  for (const candidate of candidates) {
    const parsed = parseVersion(candidate);
    if (!parsed || !satisfiesRange(candidate, rangeInput)) continue;
    if (!best || compareVersions(parsed, best) > 0) {
      best = parsed;
      bestRaw = candidate;
    }
  }
  return bestRaw;
}

/** Validate a range expression (used to fail fast before any download). */
export function isValidRange(rangeInput: string): boolean {
  return compileRange(rangeInput) !== null;
}
