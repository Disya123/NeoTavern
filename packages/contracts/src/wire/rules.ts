/**
 * Wire-safe schema enforcement.
 *
 * `checkWireSchema` walks a serialized JSON Schema (a plain object) and
 * reports every construct that is not permitted in the wire contract v1.
 * It never throws: all problems are returned as `WireViolation` entries.
 * The Rust `contracts-generated` checker mirrors the allowed surface, so any
 * schema that passes here is guaranteed decodable on both sides.
 */
import { WIRE_FORMATS } from './formats.js';

/** One rule violation found while walking a wire schema. */
export interface WireViolation {
  /** The schema's `$id` (or the schemaId the walk was started with). */
  schemaId: string;
  /** JSON-pointer-ish path into the schema, e.g. `/properties/name`. */
  path: string;
  /** Stable rule identifier, e.g. `unsupported-construct`. */
  rule: string;
}

type SchemaNode = Record<string, unknown>;

/** JSON Schema keywords that the wire contract v1 does not support at all. */
const UNSUPPORTED_CONSTRUCT_KEYS = [
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$ref',
  '$dynamicRef',
  'patternProperties',
  'dependentSchemas',
  'unevaluatedProperties',
  'prefixItems',
  'contains',
] as const;

const MAX_SAFE = 9_007_199_254_740_991;

/**
 * Regex fragments that are not portable between the JS and Rust regex
 * dialects: lookahead, negative lookahead, lookbehind, negative lookbehind,
 * backreferences `\1`–`\9` and unicode property escapes `\p{...}`.
 */
const NON_PORTABLE_PATTERN = /(?:\(\?=)|(?:\(\?!)|(?:\(\?<=)|(?:\(\?<!)|(?:\\[1-9])|(?:\\p\{)/;

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True for `{ const: <string>, type: 'string' }` (either key order) — the
 * shape TypeBox emits for `Type.Literal(...)`.
 */
function isStringLiteralConst(member: unknown): boolean {
  return isRecord(member) && member['type'] === 'string' && typeof member['const'] === 'string';
}

/**
 * True when `node` is a primitive schema node (string/integer/number/boolean
 * carrying only `type` plus constraints) — the only shape allowed as a map
 * `additionalProperties` value.
 */
function isPrimitiveSchemaNode(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const type = node['type'];
  if (type !== 'string' && type !== 'integer' && type !== 'number' && type !== 'boolean') {
    return false;
  }
  const allowed: ReadonlySet<string> =
    type === 'string'
      ? new Set(['type', 'minLength', 'maxLength', 'pattern', 'format'])
      : type === 'integer' || type === 'number'
        ? new Set(['type', 'minimum', 'maximum'])
        : new Set(['type']);
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/** True when `member` is an object whose `properties[discriminator]` is a string literal const. */
function memberHasConstAt(member: unknown, discriminator: string): boolean {
  if (!isRecord(member)) return false;
  const properties = member['properties'];
  if (!isRecord(properties)) return false;
  return isStringLiteralConst(properties[discriminator]);
}

function walk(node: unknown, path: string, schemaId: string, out: WireViolation[]): void {
  if (!isRecord(node)) {
    // Boolean schemas (`true`/`false`) and other non-object nodes are valid
    // JSON Schema but are not allowed in the wire contract.
    out.push({ schemaId, path, rule: 'unsupported-construct' });
    return;
  }

  if (node['default'] !== undefined) {
    out.push({ schemaId, path, rule: 'implicit-default' });
  }
  for (const key of UNSUPPORTED_CONSTRUCT_KEYS) {
    if (key in node) {
      out.push({ schemaId, path, rule: 'unsupported-construct' });
    }
  }
  if ('enum' in node) {
    out.push({ schemaId, path, rule: 'use-anyof-literals' });
  }

  const format = node['format'];
  if (typeof format === 'string' && !(WIRE_FORMATS as readonly string[]).includes(format)) {
    out.push({ schemaId, path, rule: 'unregistered-format' });
  }
  const pattern = node['pattern'];
  if (typeof pattern === 'string' && NON_PORTABLE_PATTERN.test(pattern)) {
    out.push({ schemaId, path, rule: 'pattern-not-portable' });
  }

  const anyOf = node['anyOf'];
  if (Array.isArray(anyOf)) {
    const allStringLiterals = anyOf.length > 0 && anyOf.every(isStringLiteralConst);
    if (allStringLiterals) {
      if (node['x-wire-unknown-behavior'] !== 'reject') {
        out.push({ schemaId, path, rule: 'missing-x-wire-unknown-behavior' });
      }
    } else {
      const discriminator = node['x-wire-discriminator'];
      const wellFormed =
        typeof discriminator === 'string' &&
        discriminator.length > 0 &&
        anyOf.every((member) => memberHasConstAt(member, discriminator));
      if (!wellFormed) {
        out.push({ schemaId, path, rule: 'ambiguous-union' });
      }
    }
    for (const [index, member] of anyOf.entries()) {
      walk(member, `${path}/anyOf/${index}`, schemaId, out);
    }
  }

  const type = node['type'];
  if (typeof type === 'string') {
    if (type === 'any' || type === 'unknown') {
      out.push({ schemaId, path, rule: 'unsafe-type' });
    } else if (type === 'integer' || type === 'number') {
      if (
        node['multipleOf'] !== undefined ||
        node['exclusiveMinimum'] !== undefined ||
        node['exclusiveMaximum'] !== undefined
      ) {
        out.push({ schemaId, path, rule: 'unsupported-numeric-constraint' });
      }
      const minimum = node['minimum'];
      const maximum = node['maximum'];
      if (
        (typeof minimum === 'number' && (minimum < -MAX_SAFE || minimum > MAX_SAFE)) ||
        (typeof maximum === 'number' && (maximum < -MAX_SAFE || maximum > MAX_SAFE))
      ) {
        out.push({ schemaId, path, rule: 'unsafe-integer-range' });
      }
    } else if (type === 'object') {
      const additionalProperties = node['additionalProperties'];
      if (additionalProperties !== undefined && typeof additionalProperties !== 'boolean') {
        if (!isPrimitiveSchemaNode(additionalProperties)) {
          out.push({ schemaId, path, rule: 'unsupported-construct' });
        }
      }
      const required = node['required'];
      const properties = node['properties'];
      if (required !== undefined) {
        const known = isRecord(properties) ? properties : {};
        const validRequired =
          Array.isArray(required) &&
          required.every((key) => typeof key === 'string' && key in known);
        if (!validRequired) {
          out.push({ schemaId, path, rule: 'invalid-required' });
        }
      }
      if (isRecord(properties)) {
        for (const [key, value] of Object.entries(properties)) {
          walk(value, `${path}/${key}`, schemaId, out);
        }
      }
      if (additionalProperties !== undefined && !(typeof additionalProperties === 'boolean')) {
        walk(additionalProperties, `${path}/additionalProperties`, schemaId, out);
      }
    } else if (type === 'array') {
      const items = node['items'];
      if (Array.isArray(items)) {
        // Tuple form is not supported in v1.
        out.push({ schemaId, path, rule: 'unsupported-construct' });
      } else if (items !== undefined) {
        walk(items, `${path}/items`, schemaId, out);
      }
    }
  }

  // Catch bare/unsafe nodes (e.g. `Type.Unsafe({...})` with no recognized
  // keyword): a node must carry `type`, `anyOf`, `const` or `$id`.
  if (
    node['type'] === undefined &&
    node['anyOf'] === undefined &&
    node['const'] === undefined &&
    node['$id'] === undefined
  ) {
    out.push({ schemaId, path, rule: 'unsupported-construct' });
  }
}

/**
 * Walks a serialized JSON Schema (a plain object — pass TypeBox schemas as
 * they are; symbol metadata is ignored) and returns every wire-contract
 * violation found. Never throws; `$id` references are not followed (the wire
 * contract v1 has no `$ref` support).
 */
export function checkWireSchema(schema: unknown, schemaId: string): WireViolation[] {
  const violations: WireViolation[] = [];
  walk(schema, '', schemaId, violations);
  return violations;
}
