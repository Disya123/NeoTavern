/**
 * Wire contract tests (Phase 0): registry compilation, wire-safe rule
 * enforcement and the self-checking fixture corpus. Determinism and the
 * manifest/schema-hash are covered by the codegen tool test, not here.
 */
import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  WIRE_SCHEMAS,
  checkWireSchema,
  compileWireContract,
  buildProductWireRegistry,
  resolveFixtureSchemaId,
  ContractCompileError,
  PRODUCT_WIRE_FIXTURES,
  type WireOperation,
} from '../src/wire/index.js';

const VALID_META_OP: WireOperation = {
  operationId: 'meta.get',
  feature: 'core',
  version: '1.0',
  executionClass: 'transactional',
  idempotency: 'idempotent',
  retryPolicy: 'safe',
  authScope: 'none',
  requestSchemaId: 'wire.request.empty',
  responseSchemaId: 'wire.meta.dto',
  allowedErrorCodes: ['INTERNAL'],
  requestLimitBytes: 1024,
  responseLimitBytes: 16384,
  unknownFields: 'strict',
};

describe('product wire registry', () => {
  it('compiles the canonical registry with zero violations', () => {
    const registry = buildProductWireRegistry();
    // The Phase 0 registry (21 ops) grew to the full M2 registry (34 ops),
    // then to the M4 registry (47 ops): lorebooks get/create/update/delete +
    // lorebooks.entries.* CRUD + personas.* CRUD joined lorebooks.list and
    // presets.list. Этап 4 slice 2 (message variants/revisions/drafts) adds
    // 9 ops (56 total): variants list/create/delete/activate, revisions
    // list, drafts get/save/commit/discard. Этап 4 slice 3 (memories and
    // presets) adds 8 ops (64 total): presets get/create/update/delete and
    // memories list/create/update/delete. Этап 4 slice 5 (profile export)
    // adds profile.export (65 total). Этап 4 slice 7 (diagnostics/settings)
    // adds settings.get/settings.update/diagnostics.export (68 total);
    // secrets.status (SEC-01.1 value-free backend surface) makes 69;
    // Этап 4 slice 5 remainder (assets) adds assets.put/get/content/delete
    // (73 total); Этап 4 slice 6 (extensions registry) adds
    // plugins.list/install/uninstall/enable/disable (78 total) and
    // themes.list/install/uninstall/activate (82 total); slice 5 remainder
    // part 2 (canonical Configuration profiles) adds
    // profiles.list/create/rename/delete (86 total). The exact operation
    // set is asserted so a registry edit that drops or renames an op fails
    // loudly.
    expect(registry.operations).toHaveLength(86);
    expect(registry.operations.map((op) => op.operationId)).toEqual([
      'meta.get',
      'characters.list',
      'characters.get',
      'characters.create',
      'characters.update',
      'characters.delete',
      'chats.list',
      'chats.get',
      'chats.messages.list',
      'chats.create',
      'chats.update',
      'chats.delete',
      'chats.messages.create',
      'chats.messages.update',
      'chats.messages.delete',
      'chats.messages.variants.list',
      'chats.messages.variants.create',
      'chats.messages.variants.delete',
      'chats.messages.variants.activate',
      'chats.messages.revisions.list',
      'chats.messages.drafts.get',
      'chats.messages.drafts.save',
      'chats.messages.drafts.commit',
      'chats.messages.drafts.discard',
      'generation.start',
      'generation.cancel',
      'generation.get',
      'generation.events',
      'generation.retry',
      'generation.keep',
      'generation.discard',
      'generation.prompt.plan',
      'generation.tools.list',
      'generation.tool.result',
      'providers.list',
      'providers.config.set',
      'providers.config.get',
      'providers.config.list',
      'providers.config.delete',
      'backups.create',
      'backups.list',
      'profile.export',
      'assets.put',
      'assets.get',
      'assets.content',
      'assets.delete',
      'plugins.list',
      'plugins.install',
      'plugins.uninstall',
      'plugins.enable',
      'plugins.disable',
      'themes.list',
      'themes.install',
      'themes.uninstall',
      'themes.activate',
      'profiles.list',
      'profiles.create',
      'profiles.rename',
      'profiles.delete',
      'settings.get',
      'settings.update',
      'diagnostics.export',
      'secrets.status',
      'lorebooks.list',
      'lorebooks.get',
      'lorebooks.create',
      'lorebooks.update',
      'lorebooks.delete',
      'lorebooks.entries.list',
      'lorebooks.entries.create',
      'lorebooks.entries.update',
      'lorebooks.entries.delete',
      'presets.list',
      'presets.get',
      'presets.create',
      'presets.update',
      'presets.delete',
      'memories.list',
      'memories.create',
      'memories.update',
      'memories.delete',
      'personas.list',
      'personas.get',
      'personas.create',
      'personas.update',
      'personas.delete',
    ]);
  });

  it('every registry schema passes checkWireSchema with zero violations', () => {
    const registry = buildProductWireRegistry();
    for (const [schemaId, schema] of registry.schemas) {
      expect(checkWireSchema(schema, schemaId), schemaId).toEqual([]);
    }
  });

  it('rejects a duplicate operationId', () => {
    const schemas = new Map(Object.entries(WIRE_SCHEMAS));
    const operations = [VALID_META_OP, { ...VALID_META_OP, operationId: 'meta.get' }];
    expect(() => compileWireContract({ operations, fixtures: [] }, schemas)).toThrow(
      ContractCompileError,
    );
  });

  it('rejects a missing request schema', () => {
    const schemas = new Map(Object.entries(WIRE_SCHEMAS));
    const operations = [{ ...VALID_META_OP, requestSchemaId: 'wire.request.nope' }];
    expect(() => compileWireContract({ operations, fixtures: [] }, schemas)).toThrow(
      ContractCompileError,
    );
  });

  it('rejects unknown allowedErrorCodes', () => {
    const schemas = new Map(Object.entries(WIRE_SCHEMAS));
    const operations = [{ ...VALID_META_OP, allowedErrorCodes: ['INTERNAL', 'NOPE'] }];
    expect(() => compileWireContract({ operations, fixtures: [] }, schemas)).toThrow(
      ContractCompileError,
    );
  });

  it('rejects a fixture whose verdict contradicts the corpus flag', () => {
    const schemas = new Map(Object.entries(WIRE_SCHEMAS));
    const fixtures = [
      { id: 'bad-fixture', operationId: 'meta.get', kind: 'response', valid: true, value: {} },
    ];
    expect(() => compileWireContract({ operations: [VALID_META_OP], fixtures }, schemas)).toThrow(
      ContractCompileError,
    );
  });
});

describe('checkWireSchema rules', () => {
  it('rejects unsafe types and unsupported constructs', () => {
    const cases: Array<{ schema: unknown; rule: string }> = [
      // TypeBox serializes Type.Any()/Type.Unknown() to `{}` (no `type`
      // key), which the walker catches via the final catch-all.
      { schema: Type.Any(), rule: 'unsupported-construct' },
      { schema: Type.Unknown(), rule: 'unsupported-construct' },
      // A hand-written `type: 'any'` triggers the dedicated rule.
      { schema: { type: 'any' }, rule: 'unsafe-type' },
      { schema: Type.Unsafe({ kind: 'custom' }), rule: 'unsupported-construct' },
      { schema: Type.Record(Type.String(), Type.Integer()), rule: 'unsupported-construct' },
      { schema: { oneOf: [Type.String(), Type.Integer()] }, rule: 'unsupported-construct' },
      { schema: Type.Integer({ multipleOf: 2 }), rule: 'unsupported-numeric-constraint' },
      { schema: Type.Integer({ minimum: 9_007_199_254_740_992 }), rule: 'unsafe-integer-range' },
    ];
    for (const { schema, rule } of cases) {
      const violations = checkWireSchema(schema, 'test.schema');
      expect(
        violations.map((v) => v.rule),
        JSON.stringify(schema),
      ).toContain(rule);
    }
  });

  it('rejects unions without the required wire annotations', () => {
    const noBehavior = Type.Union([Type.Literal('a'), Type.Literal('b')]);
    expect(checkWireSchema(noBehavior, 'test.schema').map((v) => v.rule)).toContain(
      'missing-x-wire-unknown-behavior',
    );

    const noDiscriminator = Type.Union([
      Type.Object({ kind: Type.Literal('a') }),
      Type.Object({ kind: Type.Literal('b') }),
    ]);
    expect(checkWireSchema(noDiscriminator, 'test.schema').map((v) => v.rule)).toContain(
      'ambiguous-union',
    );
  });

  it('rejects default, unregistered format and non-portable patterns', () => {
    const withDefault = Type.Object({ x: Type.String({ default: 'v' }) });
    expect(checkWireSchema(withDefault, 'test.schema').map((v) => v.rule)).toContain(
      'implicit-default',
    );

    const badFormat = Type.String({ format: 'date-time' });
    expect(checkWireSchema(badFormat, 'test.schema').map((v) => v.rule)).toContain(
      'unregistered-format',
    );

    const lookaheadPattern = Type.String({ pattern: '(?=.*\\d).*' });
    expect(checkWireSchema(lookaheadPattern, 'test.schema').map((v) => v.rule)).toContain(
      'pattern-not-portable',
    );
  });

  it('accepts the closed string enum with x-wire-unknown-behavior: reject', () => {
    const closed = Type.Union([Type.Literal('a'), Type.Literal('b')], {
      'x-wire-unknown-behavior': 'reject',
    });
    expect(checkWireSchema(closed, 'test.schema')).toEqual([]);
  });

  it('accepts a discriminated union with a string-literal discriminator', () => {
    const tagged = Type.Union(
      [
        Type.Object({ type: Type.Literal('a'), value: Type.Integer() }),
        Type.Object({ type: Type.Literal('b') }),
      ],
      { 'x-wire-discriminator': 'type' },
    );
    expect(checkWireSchema(tagged, 'test.schema')).toEqual([]);
  });
});

describe('fixture corpus', () => {
  it('contains one valid request and response per operation plus the negative corpus', () => {
    const registry = buildProductWireRegistry();
    const valid = PRODUCT_WIRE_FIXTURES.filter((fixture) => fixture.valid);
    const invalid = PRODUCT_WIRE_FIXTURES.filter((fixture) => !fixture.valid);
    // The negative corpus is hand-authored and stays stable as operations
    // grow; the valid corpus must cover every operation with at least one
    // request and one response fixture (counts drift with the registry, so
    // the coverage is asserted structurally instead of by a fixed number).
    // The invalid count is likewise derived: every negative fixture must
    // actually fail its schema validation (asserted in the loop below).
    expect(invalid.length).toBeGreaterThan(0);
    const counts = new Map<string, { request: number; response: number }>();
    for (const fixture of valid) {
      const entry = counts.get(fixture.operationId) ?? { request: 0, response: 0 };
      if (fixture.kind === 'request') entry.request += 1;
      if (fixture.kind === 'response') entry.response += 1;
      counts.set(fixture.operationId, entry);
    }
    for (const operation of registry.operations) {
      const entry = counts.get(operation.operationId);
      if (entry === undefined) {
        throw new Error(`no valid fixtures for operation ${operation.operationId}`);
      }
      expect(entry.request, `${operation.operationId} request fixture`).toBeGreaterThanOrEqual(1);
      // Streaming operations have no unary response schema (events carry the
      // response); only transactional ops must have a response fixture.
      if (operation.responseSchemaId !== undefined) {
        expect(entry.response, `${operation.operationId} response fixture`).toBeGreaterThanOrEqual(
          1,
        );
      }
    }
  });

  it('every fixture verdict matches Value.Check against its resolved schemaId', () => {
    const registry = buildProductWireRegistry();
    for (const fixture of PRODUCT_WIRE_FIXTURES) {
      const schemaId = resolveFixtureSchemaId(fixture, registry.operations);
      if (schemaId === undefined) {
        throw new Error(`fixture '${fixture.id}' did not resolve a schemaId`);
      }
      const schema = WIRE_SCHEMAS[schemaId];
      if (schema === undefined) {
        throw new Error(`fixture '${fixture.id}' references unknown schema '${schemaId}'`);
      }
      expect(Value.Check(schema, fixture.value), `${fixture.id} (${schemaId})`).toBe(fixture.valid);
    }
  });

  it('resolveFixtureSchemaId honors an explicit schemaId', () => {
    const registry = buildProductWireRegistry();
    const fixture = PRODUCT_WIRE_FIXTURES.find((f) => f.id === 'neg-response-envelope-bad-kind');
    if (fixture === undefined) {
      throw new Error('missing neg-response-envelope-bad-kind fixture');
    }
    expect(fixture.schemaId).toBe('wire.response.envelope');
    expect(resolveFixtureSchemaId(fixture, registry.operations)).toBe('wire.response.envelope');
  });

  it('valid fixtures are JSON round-trip safe', () => {
    for (const fixture of PRODUCT_WIRE_FIXTURES) {
      if (!fixture.valid) continue;
      expect(JSON.parse(JSON.stringify(fixture.value)), fixture.id).toEqual(fixture.value);
    }
  });
});
