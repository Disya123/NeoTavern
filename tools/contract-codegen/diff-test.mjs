#!/usr/bin/env node
/**
 * contract-diff — plain-assertion test harness (no test runner, no dependencies).
 *
 * Run: node tools/contract-codegen/diff-test.mjs
 * Prints OK/FAIL per case and exits 0 only when every case passes.
 *
 * Cases (crafted mini-bundles, ТЗ §6.7):
 *   1. all-additive change            -> compatible
 *   2. removed field                  -> breaking
 *   3. optional -> required field     -> breaking
 *   4. narrowed string range          -> breaking
 *   5. widened enum (preserve)        -> additive (compatible)
 *   6. new operation                  -> additive (compatible)
 */
import { semanticDiff } from './diff.mjs';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`OK ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Mini-bundle with one object schema `t.user` (id + name, id required). */
function bundle(schemas, operations) {
  return { schemas, operations };
}

function userSchema(extraProps = {}, extraRequired = []) {
  return {
    $id: 't.user',
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, ...extraProps },
    required: ['id', ...extraRequired],
  };
}

function op(operationId, overrides = {}) {
  return {
    operationId,
    requestSchemaId: 't.req',
    responseSchemaId: 't.user',
    allowedErrorCodes: ['INTERNAL'],
    ...overrides,
  };
}

const GET = op('t.get');

// 1. All-additive: new optional field, new schema, new operation, added error code.
check('1. all-additive -> compatible', () => {
  const prev = bundle([userSchema()], [GET]);
  const curr = bundle(
    [
      userSchema({ email: { type: 'string', format: 'email' } }),
      { $id: 't.admin', type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] },
    ],
    [GET, op('t.list', { responseSchemaId: 't.admin', allowedErrorCodes: ['INTERNAL', 'VALIDATION'] })],
  );
  const result = semanticDiff(prev, curr);
  assert(result.compatible === true, `expected compatible, got ${JSON.stringify(result)}`);
  assert(result.changes.every((c) => c.kind !== 'breaking'), 'expected no breaking changes');
  assert(result.changes.some((c) => c.path === '/schemas/t.user/properties/email'), 'expected added-optional-field entry for email');
  assert(result.changes.some((c) => c.path === '/operations/t.list'), 'expected added-operation entry');
});

// 2. Removed field -> breaking.
check('2. removed field -> breaking', () => {
  const prev = bundle([userSchema()], [GET]);
  const currSchema = {
    $id: 't.user',
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id'],
  };
  const curr = bundle([currSchema], [GET]);
  const result = semanticDiff(prev, curr);
  assert(result.compatible === false, 'expected incompatible');
  const entry = result.changes.find((c) => c.path === '/schemas/t.user/properties/name');
  assert(entry && entry.kind === 'breaking', `expected breaking entry for removed field name, got ${JSON.stringify(result.changes)}`);
});

// 3. Optional -> required -> breaking.
check('3. optional -> required -> breaking', () => {
  const prev = bundle([userSchema()], [GET]);
  const curr = bundle([userSchema({}, ['name'])], [GET]);
  const result = semanticDiff(prev, curr);
  assert(result.compatible === false, 'expected incompatible');
  const entry = result.changes.find((c) => c.path === '/schemas/t.user/properties/name' && c.kind === 'breaking');
  assert(entry && /required/.test(entry.reason), `expected breaking entry for name becoming required, got ${JSON.stringify(result.changes)}`);
});

// 4. Narrowed range (maxLength 200 -> 50) -> breaking.
check('4. narrowed range -> breaking', () => {
  const note = (maxLength) => ({
    $id: 't.note',
    type: 'object',
    additionalProperties: false,
    properties: { body: { type: 'string', minLength: 1, maxLength } },
    required: ['body'],
  });
  const prev = bundle([note(200)], [GET]);
  const curr = bundle([note(50)], [GET]);
  const result = semanticDiff(prev, curr);
  assert(result.compatible === false, 'expected incompatible');
  const entry = result.changes.find((c) => c.path === '/schemas/t.note/properties/body/maxLength');
  assert(entry && entry.kind === 'breaking', `expected breaking entry for maxLength, got ${JSON.stringify(result.changes)}`);
});

// 5. Widened enum with x-wire-unknown-behavior 'preserve' -> additive (compatible).
check('5. widened enum (preserve) -> additive', () => {
  const roleEnum = (values) => ({
    $id: 't.role',
    anyOf: values.map((value) => ({ const: value, type: 'string' })),
    'x-wire-unknown-behavior': 'preserve',
  });
  const prev = bundle([roleEnum(['admin', 'user'])], [GET]);
  const curr = bundle([roleEnum(['admin', 'user', 'moderator'])], [GET]);
  const result = semanticDiff(prev, curr);
  assert(result.compatible === true, `expected compatible, got ${JSON.stringify(result)}`);
  const entry = result.changes.find((c) => c.path === '/schemas/t.role/anyOf' && c.kind === 'additive');
  assert(entry && /moderator/.test(entry.reason), `expected additive entry mentioning moderator, got ${JSON.stringify(result.changes)}`);
});

// 6. New operation -> additive (compatible).
check('6. new operation -> additive', () => {
  const prev = bundle([userSchema()], [GET]);
  const curr = bundle([userSchema()], [GET, op('t.create', { responseSchemaId: 't.user' })]);
  const result = semanticDiff(prev, curr);
  assert(result.compatible === true, `expected compatible, got ${JSON.stringify(result)}`);
  const entry = result.changes.find((c) => c.path === '/operations/t.create' && c.kind === 'additive');
  assert(entry, `expected additive entry for t.create, got ${JSON.stringify(result.changes)}`);
});

// 7. Identical bundles (same file parsed twice) -> unchanged, compatible.
// Regression: protocol-level constants must be compared by value, not reference.
check('7. identical bundle -> unchanged', () => {
  const base = bundle([userSchema()], [GET]);
  const copy = JSON.parse(JSON.stringify(base));
  const result = semanticDiff(base, copy);
  assert(result.compatible === true, `expected compatible, got ${JSON.stringify(result)}`);
  assert(
    result.changes.length === 1 && result.changes[0].kind === 'unchanged',
    `expected single unchanged entry, got ${JSON.stringify(result.changes)}`
  );
});

// 8. wireProtocol value change -> breaking (protocol constant guards every peer).
check('8. wireProtocol change -> breaking', () => {
  const prev = { ...bundle([userSchema()], [GET]), wireProtocol: { major: 1, minor: 0 } };
  const curr = { ...bundle([userSchema()], [GET]), wireProtocol: { major: 2, minor: 0 } };
  const result = semanticDiff(prev, curr);
  assert(result.compatible === false, `expected breaking, got ${JSON.stringify(result)}`);
  const entry = result.changes.find((c) => c.path === '/wireProtocol' && c.kind === 'breaking');
  assert(entry, `expected breaking entry for /wireProtocol, got ${JSON.stringify(result.changes)}`);
});

if (failures > 0) {
  console.error(`${failures} case(s) FAILED`);
  process.exit(1);
}
console.log('all diff-test cases passed');
process.exit(0);
