/**
 * Property-based fuzzing of the wire registry (review follow-up: "your
 * negative tests are greenhouse cases — generate insane JSON instead").
 *
 * Two layers, both deterministic:
 *
 * 1. fast-check chaos: random deeply-nested, wrong-typed, unicode-heavy
 *    JSON trees are thrown at EVERY registered wire schema. The invariant
 *    is total-fn behavior: `Value.Check` must never throw — it returns a
 *    boolean — and a value that passes must survive cast + JSON round-trip.
 * 2. Hand-crafted pathology: the classic parser killers — an array of
 *    100_000 nulls, a 1 MiB string, 1000-deep nesting, a 50k-key object,
 *    NaN/Infinity scalars — are driven through every schema.
 *
 * Any throw here is a wire-contract bug (the checker must be total), so the
 * suite fails loudly instead of masking the payload.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { WIRE_SCHEMAS } from '../src/wire/dto.js';
import { assertPayloadSpecCap } from './_budget.js';
import '../src/wire/index.js'; // registers the wire formats as a side effect

const SEED = 20260815;
const SCHEMA_IDS = Object.keys(WIRE_SCHEMAS);

/** Every schema: `Value.Check` is total (boolean, never a throw). */
function expectTotalCheck(schema: unknown, value: unknown, label: string): void {
  let verdict: unknown;
  expect(() => {
    verdict = Value.Check(schema as never, value as never);
  }, `Value.Check threw for ${label}`).not.toThrow();
  // A checked value must survive cast + JSON serialization without throwing.
  if (verdict === true) {
    expect(() => {
      const cast = Value.Cast(schema as never, value as never);
      JSON.stringify(cast);
    }, `cast/serialize threw for ${label} (accepted by Check)`).not.toThrow();
  }
}

describe('wire registry fuzz (fast-check)', () => {
  it('survives random deep JSON trees on every schema (seeded)', () => {
    fc.assert(
      fc.property(
        fc.jsonValue({ maxDepth: 40, maxKeys: 60 }),
        fc.constantFrom(...SCHEMA_IDS),
        (tree, schemaId) => {
          expectTotalCheck(WIRE_SCHEMAS[schemaId], tree, `schema ${schemaId}`);
        },
      ),
      { numRuns: 150, seed: SEED },
    );
  });

  it('survives random strings/numbers/arrays injected as raw payloads', () => {
    const hostileString = fc
      .array(fc.constantFrom('\u0000', '\u0001', '\uFFFF', '\uD800', '\\', '"'), {
        minLength: 0,
        maxLength: 500,
      })
      .map((chars) => chars.join(''));
    const scalarArb = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
      fc.double(),
      fc.string({ maxLength: 2_000 }),
      hostileString,
    );
    const containerArb = fc.oneof(
      fc.array(scalarArb, { maxLength: 200 }),
      fc.array(fc.array(scalarArb, { maxLength: 50 }), { maxLength: 50 }),
      fc.dictionary(fc.string({ maxLength: 40 }), scalarArb, { maxKeys: 50 }),
    );
    fc.assert(
      fc.property(
        fc.oneof(scalarArb, containerArb),
        fc.constantFrom(...SCHEMA_IDS),
        (payload, schemaId) => {
          expectTotalCheck(WIRE_SCHEMAS[schemaId], payload, `schema ${schemaId}`);
        },
      ),
      { numRuns: 150, seed: SEED },
    );
  });

  it('treats a value that is not JSON-safe like any other payload', () => {
    const hostile = [NaN, Infinity, -Infinity, undefined, () => 1, Symbol('x'), 0n];
    for (const schemaId of SCHEMA_IDS) {
      for (const value of hostile) {
        expectTotalCheck(WIRE_SCHEMAS[schemaId], value, `schema ${schemaId}`);
      }
    }
  });
});

describe('wire registry fuzz (pathological payloads)', () => {
  /**
   * Spec-first builders (plan rev 2.2 Layer B): the guard checks the
   * DECLARED size/cardinality before any `.repeat()`/`Array.from()` runs,
   * so a future edit that grows a payload fails fast instead of allocating.
   */
  interface PathSpec {
    bytes: number;
    depth?: number;
    arrayItems?: number;
    objectKeys?: number;
    make: () => unknown;
  }
  const pathological: Array<[string, PathSpec]> = [
    [
      'array of 100_000 nulls',
      { bytes: 300_000, arrayItems: 100_000, make: () => new Array(100_000).fill(null) },
    ],
    [
      'array of 100_000 wrong-typed elements',
      {
        bytes: 500_000,
        arrayItems: 100_000,
        make: () =>
          new Array(100_000).fill(0).map((_, i) => (i % 3 === 0 ? {} : i % 3 === 1 ? [] : 'x')),
      },
    ],
    ['1 MiB string', { bytes: 1024 * 1024, make: () => 'x'.repeat(1024 * 1024) }],
    [
      '1000-deep nested objects',
      {
        bytes: 8_000,
        depth: 1000,
        make: () => {
          let v: unknown = 'leaf';
          for (let i = 0; i < 1000; i += 1) v = { a: v };
          return v;
        },
      },
    ],
    [
      '1000-deep nested arrays',
      {
        bytes: 4_000,
        depth: 1000,
        make: () => {
          let v: unknown = 'leaf';
          for (let i = 0; i < 1000; i += 1) v = [v];
          return v;
        },
      },
    ],
    [
      'object with 50_000 keys',
      {
        bytes: 2_500_000,
        objectKeys: 50_000,
        make: () => {
          const o: Record<string, unknown> = {};
          for (let i = 0; i < 50_000; i += 1) o[`key-${i}-${'x'.repeat(20)}`] = { n: i };
          return o;
        },
      },
    ],
    [
      'deep object of arrays of objects',
      {
        bytes: 100_000,
        depth: 60,
        make: () => {
          const depth = 60;
          let v: unknown = { end: true };
          for (let i = 0; i < depth; i += 1) v = { level: i, children: [v, v, { x: [v] }] };
          return v;
        },
      },
    ],
  ];

  for (const [name, spec] of pathological) {
    it(`every schema survives ${name}`, () => {
      // Hard spec check BEFORE allocation (Layer D: bench/fuzz must use the
      // shared budget helper).
      assertPayloadSpecCap({
        bytes: spec.bytes,
        depth: spec.depth,
        arrayItems: spec.arrayItems,
        objectKeys: spec.objectKeys,
        iterations: 1,
      });
      const payload = spec.make();
      for (const schemaId of SCHEMA_IDS) {
        expectTotalCheck(WIRE_SCHEMAS[schemaId], payload, `schema ${schemaId}`);
      }
    });
  }
});
