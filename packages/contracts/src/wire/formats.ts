/**
 * Wire format registry.
 *
 * The three formats below are the ONLY string formats permitted in wire
 * schemas (enforced by `checkWireSchema`). Patterns are canonical: the Rust
 * `contracts-generated` crate mirrors them verbatim, so they must never be
 * changed on one side only.
 */
import { FormatRegistry } from '@sinclair/typebox';

/** Names of the formats registered with TypeBox's `FormatRegistry`. */
export const WIRE_FORMATS = ['uuid', 'rfc3339', 'decimal-string'] as const;

/** Union of wire-safe string format names. */
export type WireFormat = (typeof WIRE_FORMATS)[number];

/**
 * Canonical regex patterns for each wire format. The Rust side mirrors these
 * patterns verbatim — do not change them without updating both sides.
 */
export const WIRE_FORMAT_PATTERNS: Record<WireFormat, string> = {
  uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  rfc3339: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$',
  'decimal-string': '^[0-9]+$',
};

const WIRE_FORMAT_REGEXPS: Record<WireFormat, RegExp> = {
  uuid: new RegExp(WIRE_FORMAT_PATTERNS.uuid),
  rfc3339: new RegExp(WIRE_FORMAT_PATTERNS.rfc3339),
  'decimal-string': new RegExp(WIRE_FORMAT_PATTERNS['decimal-string']),
};

let registered = false;

/**
 * Registers the wire formats with TypeBox's `FormatRegistry` so that
 * `Value.Check` validates `format: 'uuid'` / `format: 'rfc3339'` /
 * `format: 'decimal-string'` constraints. Idempotent: safe to call from
 * `wire/index.ts`, `buildProductWireRegistry()` and tests.
 */
export function registerWireFormats(): void {
  if (registered) return;
  for (const name of WIRE_FORMATS) {
    const pattern = WIRE_FORMAT_REGEXPS[name];
    FormatRegistry.Set(name, (value) => typeof value === 'string' && pattern.test(value));
  }
  registered = true;
}
