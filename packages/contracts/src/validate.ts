/**
 * Runtime validation of unknown input against TypeBox schemas.
 *
 * Used at system boundaries (AGENTS.md §5: `unknown` in, explicit validation).
 * Returns a {@link Result}; on success the value is decoded (defaults applied).
 */
import { FormatRegistry, type TSchema, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AppError, ErrorCodes, ok, err, type Result } from '@neotavern/shared';

// TypeBox ships no format validators, so a `format: 'uri'` schema would reject
// every value with "Unknown format" unless registered. Register the formats the
// contracts actually use so Value.Check/validateSchema work at the boundary.
if (!FormatRegistry.Has('uri')) {
  // Absolute-URI shape per RFC 3986: scheme ":" hier-part, with a network host.
  const URI_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s/$.?#][^\s]*$/i;
  FormatRegistry.Set('uri', (value) => typeof value === 'string' && URI_PATTERN.test(value));
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Validate `input` against `schema`, decoding defaults on success. */
export function validateSchema<S extends TSchema>(schema: S, input: unknown): Result<Static<S>> {
  if (Value.Check(schema, input)) {
    return ok(Value.Decode(schema, input) as Static<S>);
  }
  const issues: ValidationIssue[] = [...Value.Errors(schema, input)]
    .slice(0, 20)
    .map((e) => ({ path: e.path || '/', message: e.message }));
  return err(
    new AppError({
      code: ErrorCodes.VALIDATION,
      params: { issues },
      message: 'Validation failed',
    }),
  );
}

/** True when `input` satisfies `schema`. */
export function isValid<S extends TSchema>(schema: S, input: unknown): input is Static<S> {
  return Value.Check(schema, input);
}
