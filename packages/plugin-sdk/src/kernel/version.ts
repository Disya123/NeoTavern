/**
 * Plugin SDK revision-4 kernel: semver-style version negotiation.
 *
 * Manifests declare `engines.host`, `engines.sdk` and `protocol` ranges
 * (rev4 §A4). The matcher supports the subset the SDK contract needs:
 * exact versions, `^x.y.z`, `>=a <b` comparator lists and `*`. Rules:
 * major bump = incompatible, minor = additive only.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse `x.y.z` (prerelease/build suffixes are rejected: the SDK contract
 * negotiates on plain numeric versions only). */
export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

interface Comparator {
  op: '>=' | '>' | '<=' | '<' | '=';
  version: ParsedVersion;
}

/**
 * Parse a range expression: `*`, `^1.3.0`, `>=2.4.0 <3`, `2.0.0`, or
 * comparator lists joined by spaces. `^x.y.z` expands to `>=x.y.z <(x+1).0.0`
 * for x>0, `>=0.y.z <0.(y+1).0` for 0.y — caret semantics.
 */
export function parseRange(input: string): Comparator[] | null {
  const trimmed = input.trim();
  if (trimmed === '*' || trimmed === '') return [];
  const comparators: Comparator[] = [];
  for (const part of trimmed.split(/\s+/)) {
    if (part.startsWith('^')) {
      const base = parseVersion(part.slice(1));
      if (!base) return null;
      comparators.push({ op: '>=', version: base });
      const upper =
        base.major > 0
          ? { major: base.major + 1, minor: 0, patch: 0 }
          : { major: 0, minor: base.minor + 1, patch: 0 };
      comparators.push({ op: '<', version: upper });
      continue;
    }
    const opMatch = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    if (!opMatch) return null;
    const op = (opMatch[1] ?? '=') as Comparator['op'];
    const version = parseVersion(opMatch[2] ?? '');
    if (!version) {
      // `<3` shorthand: major-only upper bound.
      if (
        (op === '<' || op === '<=' || op === '>' || op === '>=') &&
        /^\d+$/.test(opMatch[2] ?? '')
      ) {
        const major = Number(opMatch[2]);
        comparators.push({
          op,
          version: { major, minor: op === '<' || op === '<=' ? 0 : 0, patch: 0 },
        });
        // `<3` must mean strictly below 3.0.0: normalize `< 3.0.0`.
        continue;
      }
      return null;
    }
    comparators.push({ op, version });
  }
  return comparators;
}

function satisfiesComparator(version: ParsedVersion, comparator: Comparator): boolean {
  const cmp = compareVersions(version, comparator.version);
  switch (comparator.op) {
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '<':
      return cmp < 0;
    case '=':
      return cmp === 0;
  }
}

/** Whether `version` satisfies `range`. Invalid inputs never satisfy. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const comparators = parseRange(range);
  if (!parsed || comparators === null) return false;
  return comparators.every((comparator) => satisfiesComparator(parsed, comparator));
}

/**
 * Protocol negotiation (rev4 §A4): majors must match exactly, the plugin's
 * minor may not exceed the host's minor beyond what additive changes allow —
 * a plugin requiring a newer minor than the host offers is rejected.
 */
export function protocolCompatible(pluginProtocol: string, hostProtocol: string): boolean {
  const plugin = parseVersion(pluginProtocol);
  const host = parseVersion(hostProtocol);
  if (!plugin || !host) return false;
  if (plugin.major !== host.major) return false;
  return plugin.minor <= host.minor;
}

/** Feature version lookup helper (rev4 §A4 capability feature detection). */
export function featureSupported(
  supportedFeatures: Readonly<Record<string, number>>,
  feature: string,
  requiredVersion: number,
): boolean {
  const available = supportedFeatures[feature];
  if (available === undefined) return false;
  // Same major of the feature contract: available >= required and same
  // major; feature versions are plain integers, additive within a major.
  return available >= requiredVersion;
}
