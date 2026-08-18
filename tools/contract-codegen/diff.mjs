#!/usr/bin/env node
/**
 * contract-diff — semantic compatibility diff for the NeoTavern wire contract (ТЗ §6.7).
 *
 * Compares two canonical contract bundles (as produced by `codegen.mjs` →
 * `packages/contracts/generated/contract.bundle.json`) and classifies every difference
 * as `breaking` (old wire peers cannot interoperate), `additive` (safe extension), or
 * `unchanged`. Schemas are matched by `$id`, operations by `operationId`.
 *
 * CLI:
 *   node tools/contract-codegen/diff.mjs <prev-bundle.json> <curr-bundle.json> [--json]
 *
 * Exit codes: 0 = compatible, 1 = breaking change, 2 = usage/input error.
 */
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------
// Reuse the canonicalizer exported by codegen.mjs so the diff shares the exact
// definition of "canonical" used to emit the bundle bytes. A small local fallback
// (identical semantics: recursively key-sorted, arrays keep order, no whitespace)
// keeps this tool standalone if that export ever disappears.
let canonicalString;
try {
  ({ canonicalString } = await import('./codegen.mjs'));
} catch {
  canonicalString = null;
}
if (typeof canonicalString !== 'function') {
  canonicalString = defaultCanonicalString;
}

/** Recursively sort object keys (arrays keep order), reject non-deterministic values. */
function sortJson(value) {
  if (value === undefined) {
    throw new TypeError('cannot canonicalize undefined');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`cannot canonicalize non-finite number ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortJson(value[key]);
    }
    return out;
  }
  throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
}

/** Canonical JSON string: recursively key-sorted, no whitespace (mirrors codegen.mjs). */
function defaultCanonicalString(value) {
  return JSON.stringify(sortJson(value));
}

// ---------------------------------------------------------------------------
// Change kinds
// ---------------------------------------------------------------------------

const BREAKING = 'breaking';
const ADDITIVE = 'additive';
const UNCHANGED = 'unchanged';

/** Schema keywords whose semantics the walker handles (never reported as unknown). */
const HANDLED_KEYS = new Set([
  '$id',
  'type',
  'format',
  'const',
  'anyOf',
  'oneOf',
  'x-wire-discriminator',
  'x-wire-unknown-behavior',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'pattern',
]);

/** Doc-only keys: never part of the wire shape. */
const DOC_KEYS = new Set(['title', 'description', 'default', 'examples', '$comment']);

/** Operation keys with dedicated handling in diffOperation; everything else is a note. */
const KNOWN_OP_KEYS = new Set([
  'operationId',
  'allowedErrorCodes',
  'requestSchemaId',
  'responseSchemaId',
  'eventSchemaId',
  'requestLimitBytes',
  'responseLimitBytes',
  'eventLimitBytes',
  'unknownFields',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const toSet = (value) => new Set(Array.isArray(value) ? value : []);

const fmt = (value) => (value === undefined ? 'absent' : JSON.stringify(value));

function push(out, kind, path, reason) {
  out.push({ kind, path, reason });
}

function jsonEquals(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return canonicalString(a) === canonicalString(b);
}

function indexSchemas(list) {
  const map = new Map();
  if (Array.isArray(list)) {
    for (const schema of list) {
      if (isRecord(schema) && typeof schema.$id === 'string' && schema.$id !== '') {
        map.set(schema.$id, schema);
      }
    }
  }
  return map;
}

function indexOps(list) {
  const map = new Map();
  if (Array.isArray(list)) {
    for (const op of list) {
      if (isRecord(op) && typeof op.operationId === 'string' && op.operationId !== '') {
        map.set(op.operationId, op);
      }
    }
  }
  return map;
}

/** Closed-enum member: a string literal `{ const, type: 'string' }`. */
function isStringConstMember(member) {
  return (
    isRecord(member) &&
    typeof member.const === 'string' &&
    (member.type === undefined || member.type === 'string')
  );
}

/** `const` value the member pins on the discriminator property, or undefined. */
function memberConstAt(member, discriminator) {
  if (!isRecord(member) || !isRecord(member.properties)) return undefined;
  const pin = member.properties[discriminator];
  return isRecord(pin) ? pin.const : undefined;
}

/**
 * Classify a node as a closed string enum: `anyOf` of string-const members.
 * Returns `{ values, behavior }` or null. `behavior` is the node's
 * `x-wire-unknown-behavior` ('reject' | 'preserve'), undefined when absent (open).
 */
function enumOf(schema) {
  if (!isRecord(schema) || !Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
    return null;
  }
  const values = [];
  for (const member of schema.anyOf) {
    if (!isStringConstMember(member)) return null;
    values.push(member.const);
  }
  return { values, behavior: schema['x-wire-unknown-behavior'] };
}

/**
 * Classify a node as a tagged union: `anyOf` of object members plus a
 * `x-wire-discriminator`, every member pinning a string const on that property.
 * Returns `{ discriminator, members: Map<tag, member> }` or null.
 */
function taggedUnionOf(schema) {
  if (!isRecord(schema) || !Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
    return null;
  }
  const discriminator = schema['x-wire-discriminator'];
  if (typeof discriminator !== 'string' || discriminator.length === 0) return null;
  const members = new Map();
  for (const member of schema.anyOf) {
    if (!isRecord(member)) return null;
    const tag = memberConstAt(member, discriminator);
    if (typeof tag !== 'string') return null;
    if (members.has(tag)) return null; // duplicate tag: not a well-formed union
    members.set(tag, member);
  }
  return { discriminator, members };
}

// ---------------------------------------------------------------------------
// semanticDiff
// ---------------------------------------------------------------------------

/**
 * Classify the semantic difference between two wire contract bundles (ТЗ §6.7).
 *
 * @param {object} prevBundle previous bundle `{ wireProtocol?, schemaDialect?,
 *   schemas: [], operations: [] }` — schemas carry `$id`, operations carry `operationId`.
 * @param {object} currBundle current bundle, same shape.
 * @returns {{ compatible: boolean, changes: Array<{kind: 'breaking'|'additive'|'unchanged',
 *   path: string, reason: string}> }}
 */
export function semanticDiff(prevBundle, currBundle) {
  if (!isRecord(prevBundle) || !isRecord(currBundle)) {
    throw new TypeError('semanticDiff: both bundles must be JSON objects');
  }
  const changes = [];
  const prevSchemas = indexSchemas(prevBundle.schemas);
  const currSchemas = indexSchemas(currBundle.schemas);
  const prevOps = indexOps(prevBundle.operations);
  const currOps = indexOps(currBundle.operations);

  // Protocol-level constants: a change invalidates every wire peer.
  for (const key of ['wireProtocol', 'schemaDialect']) {
    const prev = prevBundle[key];
    const curr = currBundle[key];
    if (prev !== undefined && curr !== undefined && !jsonEquals(prev, curr)) {
      push(changes, BREAKING, `/${key}`, `${key} changed ${fmt(prev)} -> ${fmt(curr)}`);
    }
  }

  // Schemas matched by $id.
  for (const [id, schema] of prevSchemas) {
    if (!currSchemas.has(id)) {
      push(changes, BREAKING, `/schemas/${id}`, `removed schema ${id}`);
    } else {
      diffSchema(schema, currSchemas.get(id), `/schemas/${id}`, changes);
    }
  }
  for (const [id] of currSchemas) {
    if (!prevSchemas.has(id)) {
      push(changes, ADDITIVE, `/schemas/${id}`, `added schema ${id}`);
    }
  }

  // Operations matched by operationId.
  for (const [id, op] of prevOps) {
    if (!currOps.has(id)) {
      push(changes, BREAKING, `/operations/${id}`, `removed operation ${id}`);
    } else {
      diffOperation(op, currOps.get(id), `/operations/${id}`, changes);
    }
  }
  for (const [id] of currOps) {
    if (!prevOps.has(id)) {
      push(changes, ADDITIVE, `/operations/${id}`, `added operation ${id}`);
    }
  }

  if (changes.length === 0) {
    push(changes, UNCHANGED, '/', 'no semantic differences');
  }
  const compatible = changes.every((c) => c.kind !== BREAKING);
  return { compatible, changes };
}

function diffOperation(prev, curr, path, changes) {
  // allowedErrorCodes: removed code -> breaking, added code -> additive.
  const prevCodes = toSet(prev.allowedErrorCodes);
  const currCodes = toSet(curr.allowedErrorCodes);
  for (const code of prevCodes) {
    if (!currCodes.has(code)) {
      push(
        changes,
        BREAKING,
        `${path}/allowedErrorCodes/${code}`,
        `removed allowed error code ${code}`,
      );
    }
  }
  for (const code of currCodes) {
    if (!prevCodes.has(code)) {
      push(
        changes,
        ADDITIVE,
        `${path}/allowedErrorCodes/${code}`,
        `added allowed error code ${code}`,
      );
    }
  }

  // Request/response/event schema binding: swapping the bound schema is a type change.
  for (const key of ['requestSchemaId', 'responseSchemaId', 'eventSchemaId']) {
    const prevValue = prev[key];
    const currValue = curr[key];
    if (prevValue !== undefined && currValue !== undefined && prevValue !== currValue) {
      push(
        changes,
        BREAKING,
        `${path}/${key}`,
        `${key} changed ${fmt(prevValue)} -> ${fmt(currValue)}`,
      );
    }
  }

  // Byte limits are upper bounds on the wire payload: lowering narrows, raising widens.
  for (const key of ['requestLimitBytes', 'responseLimitBytes', 'eventLimitBytes']) {
    const prevValue = prev[key];
    const currValue = curr[key];
    if (typeof prevValue === 'number' && typeof currValue === 'number' && prevValue !== currValue) {
      if (currValue < prevValue) {
        push(
          changes,
          BREAKING,
          `${path}/${key}`,
          `${key} lowered ${prevValue} -> ${currValue} (range narrowed)`,
        );
      } else {
        push(
          changes,
          ADDITIVE,
          `${path}/${key}`,
          `${key} raised ${prevValue} -> ${currValue} (range widened)`,
        );
      }
    }
  }

  // unknownFields: 'allow' accepts a superset of 'strict' (unknown-additions rule).
  if (
    typeof prev.unknownFields === 'string' &&
    typeof curr.unknownFields === 'string' &&
    prev.unknownFields !== curr.unknownFields
  ) {
    if (prev.unknownFields === 'strict' && curr.unknownFields !== 'strict') {
      push(
        changes,
        ADDITIVE,
        `${path}/unknownFields`,
        `unknown fields now allowed (${prev.unknownFields} -> ${curr.unknownFields})`,
      );
    } else if (prev.unknownFields !== 'strict' && curr.unknownFields === 'strict') {
      push(
        changes,
        BREAKING,
        `${path}/unknownFields`,
        `unknown fields now rejected (${prev.unknownFields} -> ${curr.unknownFields})`,
      );
    } else {
      push(
        changes,
        ADDITIVE,
        `${path}/unknownFields`,
        `unknownFields value changed (${prev.unknownFields} -> ${curr.unknownFields}, unclassified note)`,
      );
    }
  }

  // Remaining metadata (authScope, executionClass, idempotency, retryPolicy, feature,
  // version, ...) is outside the §6.7 wire-shape rules: additions/changes are notes.
  for (const [key, value] of Object.entries(curr)) {
    if (KNOWN_OP_KEYS.has(key)) continue;
    if (!Object.hasOwn(prev, key)) {
      push(
        changes,
        ADDITIVE,
        `${path}/${key}`,
        `new operation metadata key ${key} (unclassified note)`,
      );
    } else if (!jsonEquals(prev[key], value)) {
      push(
        changes,
        ADDITIVE,
        `${path}/${key}`,
        `operation metadata ${key} changed (unclassified note)`,
      );
    }
  }
  for (const key of Object.keys(prev)) {
    if (KNOWN_OP_KEYS.has(key) || Object.hasOwn(curr, key)) continue;
    push(
      changes,
      ADDITIVE,
      `${path}/${key}`,
      `operation metadata key ${key} removed (unclassified note)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Schema comparison
// ---------------------------------------------------------------------------

function diffSchema(prev, curr, path, changes) {
  const prevEnum = enumOf(prev);
  const currEnum = enumOf(curr);
  const prevTagged = taggedUnionOf(prev);
  const currTagged = taggedUnionOf(curr);

  if (prevEnum && currEnum) {
    diffEnum(prevEnum, currEnum, path, changes);
    return;
  }
  if (prevTagged && currTagged) {
    diffTagged(prevTagged, currTagged, path, changes);
    return;
  }
  const prevUnion = prevEnum || prevTagged;
  const currUnion = currEnum || currTagged;
  if (prevUnion || currUnion) {
    push(
      changes,
      BREAKING,
      path,
      'union structure changed (enum/tagged-union replaced or removed)',
    );
    return;
  }
  diffPlain(prev, curr, path, changes);
}

function diffEnum(prevEnum, currEnum, path, changes) {
  const prevSet = new Set(prevEnum.values);
  const currSet = new Set(currEnum.values);
  const removed = prevEnum.values.filter((value) => !currSet.has(value));
  const added = currEnum.values.filter((value) => !prevSet.has(value));

  for (const value of removed) {
    push(
      changes,
      BREAKING,
      `${path}/anyOf`,
      `enum value ${fmt(value)} removed (old peers may send it)`,
    );
  }
  if (added.length > 0) {
    if (prevEnum.behavior === 'reject') {
      push(
        changes,
        BREAKING,
        `${path}/anyOf`,
        `enum widened by ${added.map(fmt).join(', ')} with x-wire-unknown-behavior 'reject' (old peers reject the new values)`,
      );
    } else {
      push(
        changes,
        ADDITIVE,
        `${path}/anyOf`,
        `enum widened by ${added.map(fmt).join(', ')} (x-wire-unknown-behavior '${prevEnum.behavior ?? 'preserve'}')`,
      );
    }
  }
  const prevBehavior = prevEnum.behavior ?? 'preserve';
  const currBehavior = currEnum.behavior ?? 'preserve';
  if (prevBehavior !== currBehavior) {
    if (prevBehavior === 'reject') {
      push(
        changes,
        ADDITIVE,
        `${path}/x-wire-unknown-behavior`,
        `x-wire-unknown-behavior changed 'reject' -> '${currBehavior}' (unknown values now forwarded)`,
      );
    } else if (currBehavior === 'reject') {
      push(
        changes,
        BREAKING,
        `${path}/x-wire-unknown-behavior`,
        `x-wire-unknown-behavior changed '${prevBehavior}' -> 'reject' (unknown values now rejected)`,
      );
    } else {
      push(
        changes,
        ADDITIVE,
        `${path}/x-wire-unknown-behavior`,
        `x-wire-unknown-behavior changed '${prevBehavior}' -> '${currBehavior}' (unclassified note)`,
      );
    }
  }
}

function diffTagged(prevTagged, currTagged, path, changes) {
  if (prevTagged.discriminator !== currTagged.discriminator) {
    push(
      changes,
      BREAKING,
      `${path}/x-wire-discriminator`,
      `discriminator changed ${fmt(prevTagged.discriminator)} -> ${fmt(currTagged.discriminator)}`,
    );
  }
  for (const tag of prevTagged.members.keys()) {
    if (!currTagged.members.has(tag)) {
      push(changes, BREAKING, `${path}/anyOf/${tag}`, `removed union member ${tag}`);
    }
  }
  for (const tag of currTagged.members.keys()) {
    if (!prevTagged.members.has(tag)) {
      push(
        changes,
        ADDITIVE,
        `${path}/anyOf/${tag}`,
        `added union member ${tag} (unknown members/events are preserved by wire peers)`,
      );
    }
  }
  for (const [tag, prevMember] of prevTagged.members) {
    const currMember = currTagged.members.get(tag);
    if (currMember) {
      diffSchema(prevMember, currMember, `${path}/anyOf/${tag}`, changes);
    }
  }
}

function diffPlain(prev, curr, path, changes) {
  // Structural type.
  if (prev.type !== curr.type) {
    push(changes, BREAKING, `${path}/type`, `type changed ${fmt(prev.type)} -> ${fmt(curr.type)}`);
  }

  // const: changed -> breaking; added -> narrowing; removed -> widening.
  if (!jsonEquals(prev.const, curr.const)) {
    if (prev.const === undefined) {
      push(changes, BREAKING, `${path}/const`, `const added (narrowed to ${fmt(curr.const)})`);
    } else if (curr.const === undefined) {
      push(changes, ADDITIVE, `${path}/const`, `const removed (widened)`);
    } else {
      push(
        changes,
        BREAKING,
        `${path}/const`,
        `const changed ${fmt(prev.const)} -> ${fmt(curr.const)}`,
      );
    }
  }

  // format / pattern: changed -> breaking; added -> new constraint (breaking); removed -> widened.
  for (const key of ['format', 'pattern']) {
    const prevValue = prev[key];
    const currValue = curr[key];
    if (prevValue === currValue) continue;
    if (prevValue !== undefined && currValue !== undefined) {
      push(
        changes,
        BREAKING,
        `${path}/${key}`,
        `${key} changed ${fmt(prevValue)} -> ${fmt(currValue)}`,
      );
    } else if (currValue !== undefined) {
      push(changes, BREAKING, `${path}/${key}`, `${key} added (new constraint ${fmt(currValue)})`);
    } else {
      push(changes, ADDITIVE, `${path}/${key}`, `${key} removed (constraint relaxed)`);
    }
  }

  // Numeric and length/count bounds: narrowing -> breaking, widening -> additive.
  for (const key of ['minimum', 'minLength', 'minItems']) {
    compareLowerBound(prev[key], curr[key], `${path}/${key}`, key, changes);
  }
  for (const key of ['maximum', 'maxLength', 'maxItems']) {
    compareUpperBound(prev[key], curr[key], `${path}/${key}`, key, changes);
  }

  // items (array element schema).
  if (prev.items !== undefined && curr.items !== undefined) {
    diffSchema(prev.items, curr.items, `${path}/items`, changes);
  } else if (prev.items !== curr.items) {
    push(changes, BREAKING, `${path}/items`, 'items constraint added or removed');
  }

  // Object shape.
  if (prev.type === 'object' || curr.type === 'object') {
    diffObject(prev, curr, path, changes);
  }

  // anyOf/oneOf that is neither an enum nor a tagged union: structural comparison.
  for (const key of ['anyOf', 'oneOf']) {
    const prevValue = prev[key];
    const currValue = curr[key];
    if (prevValue === undefined && currValue === undefined) continue;
    if (!jsonEquals(prevValue, currValue)) {
      push(changes, BREAKING, `${path}/${key}`, `${key} structure changed`);
    }
  }

  // Unclassified keywords: additions/changes/removals are compatibility notes.
  diffUnknownKeys(prev, curr, path, changes);
}

/** Lower bounds (minimum/minLength/minItems): raising narrows, lowering widens. */
function compareLowerBound(prevValue, currValue, path, key, changes) {
  if (prevValue === currValue) return;
  if (typeof prevValue !== 'number' || typeof currValue !== 'number') {
    if (prevValue === undefined && typeof currValue === 'number') {
      push(changes, BREAKING, path, `${key} added (${currValue}, lower bound narrowed)`);
    } else if (typeof prevValue === 'number' && currValue === undefined) {
      push(changes, ADDITIVE, path, `${key} removed (lower bound widened)`);
    }
    return;
  }
  if (currValue > prevValue) {
    push(changes, BREAKING, path, `${key} raised ${prevValue} -> ${currValue} (range narrowed)`);
  } else if (currValue < prevValue) {
    push(changes, ADDITIVE, path, `${key} lowered ${prevValue} -> ${currValue} (range widened)`);
  }
}

/** Upper bounds (maximum/maxLength/maxItems): lowering narrows, raising widens. */
function compareUpperBound(prevValue, currValue, path, key, changes) {
  if (prevValue === currValue) return;
  if (typeof prevValue !== 'number' || typeof currValue !== 'number') {
    if (prevValue === undefined && typeof currValue === 'number') {
      push(changes, BREAKING, path, `${key} added (${currValue}, upper bound narrowed)`);
    } else if (typeof prevValue === 'number' && currValue === undefined) {
      push(changes, ADDITIVE, path, `${key} removed (upper bound widened)`);
    }
    return;
  }
  if (currValue < prevValue) {
    push(changes, BREAKING, path, `${key} lowered ${prevValue} -> ${currValue} (range narrowed)`);
  } else if (currValue > prevValue) {
    push(changes, ADDITIVE, path, `${key} raised ${prevValue} -> ${currValue} (range widened)`);
  }
}

function diffObject(prev, curr, path, changes) {
  const prevProps = isRecord(prev.properties) ? prev.properties : {};
  const currProps = isRecord(curr.properties) ? curr.properties : {};
  const prevRequired = toSet(prev.required);
  const currRequired = toSet(curr.required);

  for (const key of Object.keys(prevProps)) {
    if (!Object.hasOwn(currProps, key)) {
      push(changes, BREAKING, `${path}/properties/${key}`, `removed field ${key}`);
    }
  }
  for (const key of Object.keys(currProps)) {
    if (!Object.hasOwn(prevProps, key)) {
      if (currRequired.has(key)) {
        push(changes, BREAKING, `${path}/properties/${key}`, `new required field ${key}`);
      } else {
        push(changes, ADDITIVE, `${path}/properties/${key}`, `added optional field ${key}`);
      }
    }
  }
  for (const key of Object.keys(prevProps)) {
    if (!Object.hasOwn(currProps, key)) continue;
    diffSchema(prevProps[key], currProps[key], `${path}/properties/${key}`, changes);
    const wasRequired = prevRequired.has(key);
    const isRequired = currRequired.has(key);
    if (!wasRequired && isRequired) {
      push(changes, BREAKING, `${path}/properties/${key}`, `field ${key} became required`);
    } else if (wasRequired && !isRequired) {
      push(changes, ADDITIVE, `${path}/properties/${key}`, `field ${key} became optional`);
    }
  }

  // additionalProperties: false -> true is widening, true -> false is narrowing;
  // a schema value (map) recurses like a property.
  const prevAp = prev.additionalProperties;
  const currAp = curr.additionalProperties;
  if (isRecord(prevAp) && isRecord(currAp)) {
    diffSchema(prevAp, currAp, `${path}/additionalProperties`, changes);
  } else if (isRecord(prevAp) !== isRecord(currAp)) {
    push(
      changes,
      BREAKING,
      `${path}/additionalProperties`,
      'additionalProperties changed between keyword and schema',
    );
  } else if ((prevAp === false) !== (currAp === false)) {
    if (currAp === false) {
      push(
        changes,
        BREAKING,
        `${path}/additionalProperties`,
        'additionalProperties now false (unknown fields rejected)',
      );
    } else {
      push(
        changes,
        ADDITIVE,
        `${path}/additionalProperties`,
        'additionalProperties now allows unknown fields',
      );
    }
  }
}

function diffUnknownKeys(prev, curr, path, changes) {
  for (const key of Object.keys(curr)) {
    if (HANDLED_KEYS.has(key) || DOC_KEYS.has(key)) continue;
    if (!Object.hasOwn(prev, key)) {
      push(changes, ADDITIVE, `${path}/${key}`, `new schema keyword ${key} (unclassified note)`);
    } else if (!jsonEquals(prev[key], curr[key])) {
      push(
        changes,
        ADDITIVE,
        `${path}/${key}`,
        `schema keyword ${key} changed (unclassified note)`,
      );
    }
  }
  for (const key of Object.keys(prev)) {
    if (HANDLED_KEYS.has(key) || DOC_KEYS.has(key) || Object.hasOwn(curr, key)) continue;
    push(
      changes,
      ADDITIVE,
      `${path}/${key}`,
      `schema keyword ${key} removed (constraint relaxed?)`,
    );
  }
}

// ---------------------------------------------------------------------------
// File API + CLI
// ---------------------------------------------------------------------------

/**
 * Diff two bundle files on disk (canonical JSON as produced by codegen.mjs).
 *
 * @param {string} prevPath path to the previous bundle JSON.
 * @param {string} currPath path to the current bundle JSON.
 * @returns {{ compatible: boolean, changes: Array<{kind, path, reason}> }}
 * @throws {Error} on read or parse failures (the CLI maps these to exit code 2).
 */
export function diffBundlesFile(prevPath, currPath) {
  const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
  const curr = JSON.parse(readFileSync(currPath, 'utf8'));
  return semanticDiff(prev, curr);
}

function usage() {
  return [
    'usage: node tools/contract-codegen/diff.mjs <prev-bundle.json> <curr-bundle.json> [--json]',
    '',
    'Compares two wire contract bundles (contract.bundle.json) and reports semantic',
    'compatibility per ТЗ §6.7. Schemas match by $id, operations by operationId.',
    'Exit codes: 0 = compatible, 1 = breaking change, 2 = usage/input error.',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }
  const jsonOut = args.includes('--json');
  const positional = args.filter((arg) => arg !== '--json');
  if (positional.length !== 2) {
    console.error(usage());
    process.exit(2);
  }
  let result;
  try {
    result = diffBundlesFile(positional[0], positional[1]);
  } catch (err) {
    console.error(`[contract-diff] failed to read/parse bundles: ${err.message}`);
    process.exit(2);
  }
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const change of result.changes) {
      process.stdout.write(`[${change.kind}] ${change.path} - ${change.reason}\n`);
    }
    const breaking = result.changes.filter((c) => c.kind === BREAKING).length;
    const additive = result.changes.filter((c) => c.kind === ADDITIVE).length;
    process.stdout.write(
      `\ncompatible: ${result.compatible ? 'yes' : 'no'} (${breaking} breaking, ${additive} additive)\n`,
    );
  }
  process.exit(result.compatible ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[contract-diff] ${err && err.stack ? err.stack : String(err)}`);
    process.exit(2);
  });
}
