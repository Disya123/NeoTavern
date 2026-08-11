/**
 * Classic SillyTavern "Additional Parameters", stored on a provider config's
 * `settings` as structured JSON (see ADR-0008 — JSON instead of YAML):
 *
 * - `customIncludeBody`    — object merged into the outgoing request body.
 * - `customExcludeBody`    — body keys removed after the merge.
 * - `customIncludeHeaders` — extra request headers.
 *
 * Shapes are validated server-side at write time; the guards here make the
 * adapter robust to settings persisted before validation. Forbidden headers
 * (`Authorization`, `Content-Type`, `Content-Length`) can never be overridden,
 * so a custom value cannot replace the adapter-controlled credential or content
 * negotiation. Reserved body keys (`stream`, `model`, `messages`, …) are
 * likewise skipped so a custom value can never desynchronize the wire format
 * from what the adapter parses or falsify the audited model.
 */
import { FORBIDDEN_CUSTOM_HEADERS, RESERVED_CUSTOM_BODY_KEYS } from '@neotavern/contracts';

const FORBIDDEN_HEADER_SET = new Set(FORBIDDEN_CUSTOM_HEADERS.map((name) => name.toLowerCase()));
const RESERVED_BODY_KEY_SET = new Set<string>(RESERVED_CUSTOM_BODY_KEYS);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Merge `customIncludeBody` into a copy of `body`, then drop every
 * `customExcludeBody` key. Returns a new object; the input is not mutated.
 * Adapter-owned keys ({@link RESERVED_CUSTOM_BODY_KEYS}) are never merged or
 * removed: overriding `stream` would make the provider answer in a format the
 * adapter does not parse (silent empty generations), and overriding `model`
 * would break prompt-context audit integrity.
 */
export function applyCustomBody(
  body: Record<string, unknown>,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...body };
  const include = asRecord(settings['customIncludeBody']);
  if (include) {
    for (const [key, value] of Object.entries(include)) {
      if (RESERVED_BODY_KEY_SET.has(key)) continue;
      result[key] = value;
    }
  }
  for (const key of asStringArray(settings['customExcludeBody'])) {
    if (RESERVED_BODY_KEY_SET.has(key)) continue;
    delete result[key];
  }
  return result;
}

/**
 * Merge `customIncludeHeaders` into a copy of `headers`, skipping forbidden
 * header names (case-insensitive). Returns a new object; input is not mutated.
 */
export function applyCustomHeaders(
  headers: Record<string, string>,
  settings: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = { ...headers };
  const include = asRecord(settings['customIncludeHeaders']);
  if (!include) return result;
  for (const [name, value] of Object.entries(include)) {
    if (typeof value !== 'string') continue;
    if (FORBIDDEN_HEADER_SET.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}
