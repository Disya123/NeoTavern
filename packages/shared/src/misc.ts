/**
 * Small general-purpose utilities shared across packages.
 */

/** Clamp a number into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Exhaustiveness guard for discriminated unions / switch statements. If a case
 * is unhandled, TypeScript reports a compile error here.
 */
export function assertNever(value: never, message = 'Unhandled discriminated union member'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

/** Type guard for a plain object (not null, not array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge plain objects (right wins). Arrays and non-plain values are
 * replaced, not merged. Returns a new object; inputs are not mutated.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Serialize a value to a stable JSON string (keys sorted) for hashing/caching. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}
