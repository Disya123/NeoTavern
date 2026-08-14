/**
 * Wire operation registry: operation metadata, the fixture corpus and the
 * `compileWireContract` validator that every schema/operation/fixture must
 * pass. `buildProductWireRegistry()` produces the canonical product registry
 * (21 operations) that codegen, the Rust kernel and the facades consume.
 */
import { type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { WIRE_ERROR_CODES, ContractCompileError, type ContractViolationGroup } from './errors.js';
import { checkWireSchema, type WireViolation } from './rules.js';
import { registerWireFormats } from './formats.js';
import { WIRE_SCHEMAS } from './dto.js';

/** Execution class of an operation. */
export type ExecutionClass = 'transactional' | 'workflow' | 'maintenance' | 'host-service';
/** Idempotency policy of an operation. */
export type IdempotencyPolicy = 'idempotent' | 'non-idempotent';
/** Retry policy of an operation. */
export type RetryPolicy = 'none' | 'safe' | 'safe-with-idempotency-key';
/** Unknown-fields policy for an operation's DTOs. */
export type UnknownFieldsPolicy = 'strict' | 'tolerant';

/** Full metadata of one wire operation. */
export interface WireOperation {
  operationId: string;
  /** Feature the operation belongs to (all product operations are `core`). */
  feature: string;
  /** Feature version, e.g. `1.0`. */
  version: string;
  executionClass: ExecutionClass;
  idempotency: IdempotencyPolicy;
  retryPolicy: RetryPolicy;
  /** Required auth scope (`none`, `app.read`, `app.write`, …). */
  authScope: string;
  requestSchemaId: string;
  responseSchemaId?: string;
  eventSchemaId?: string;
  /** Canonical `WireErrorCode`s the operation may return. */
  allowedErrorCodes: string[];
  requestLimitBytes: number;
  responseLimitBytes: number;
  eventLimitBytes?: number;
  unknownFields: UnknownFieldsPolicy;
}

/** One entry of the self-checking fixture corpus. */
export interface WireFixture {
  id: string;
  operationId: string;
  kind: 'request' | 'response' | 'event';
  valid: boolean;
  value: unknown;
  /**
   * Explicit schemaId for the fixture. When absent it resolves from the
   * operation kind: request → `requestSchemaId`, response →
   * `responseSchemaId`, event → `eventSchemaId`.
   */
  schemaId?: string;
}

/** A `WireOperation` after successful compilation. */
export interface CompiledOperation extends WireOperation {
  requestSchemaId: string;
}

/** Input to `compileWireContract`. */
export interface WireContractInput {
  operations: WireOperation[];
  fixtures: WireFixture[];
}

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9.]{1,127}$/;
const FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Resolves the schemaId a fixture validates against: an explicit
 * `fixture.schemaId` wins; otherwise it is derived from the operation kind
 * (request → requestSchemaId, response → responseSchemaId, event →
 * eventSchemaId). Returns `undefined` when the operation is unknown or the
 * kind has no schema (e.g. a response fixture for a streaming-only op).
 */
export function resolveFixtureSchemaId(
  fixture: WireFixture,
  operations: ReadonlyArray<WireOperation>,
): string | undefined {
  if (fixture.schemaId !== undefined) return fixture.schemaId;
  const operation = operations.find((candidate) => candidate.operationId === fixture.operationId);
  if (operation === undefined) return undefined;
  switch (fixture.kind) {
    case 'request':
      return operation.requestSchemaId;
    case 'response':
      return operation.responseSchemaId;
    case 'event':
      return operation.eventSchemaId;
  }
}

/**
 * Compiles a wire contract. Throws `ContractCompileError` aggregating EVERY
 * violation found across the schema map, the operations and the fixture
 * corpus (including the self-check that valid fixtures validate and invalid
 * fixtures fail). Returns the operations unchanged when compilation succeeds.
 */
export function compileWireContract(
  input: WireContractInput,
  schemas: ReadonlyMap<string, TSchema>,
): { operations: CompiledOperation[] } {
  registerWireFormats();
  const groups: ContractViolationGroup[] = [];

  // --- schema map integrity: every value must carry a unique `$id`.
  const schemaIds = new Set<string>();
  for (const [key, schema] of schemas) {
    const id = schema['$id'];
    if (typeof id !== 'string' || id === '') {
      groups.push({
        message: `schema map entry '${key}' has no $id`,
        violations: [{ schemaId: key, path: '', rule: 'missing-schema-id' }],
      });
      continue;
    }
    if (schemaIds.has(id)) {
      groups.push({
        message: `duplicate schema $id '${id}' in schema map`,
        violations: [{ schemaId: id, path: '', rule: 'duplicate-schema-id' }],
      });
    }
    schemaIds.add(id);
  }

  // --- operations.
  const seenOperationIds = new Set<string>();
  const opByOperationId = new Map<string, WireOperation>();
  const referencedSchemaIds = new Set<string>();
  for (const operation of input.operations) {
    const violations: WireViolation[] = [];
    const push = (path: string, rule: string): void => {
      violations.push({ schemaId: operation.operationId, path, rule });
    };

    if (operation.operationId === '') {
      push('', 'empty-operation-id');
    } else if (!OPERATION_ID_PATTERN.test(operation.operationId)) {
      push('', 'invalid-operation-id');
    }
    if (seenOperationIds.has(operation.operationId)) {
      push('', 'duplicate-operation-id');
    }
    seenOperationIds.add(operation.operationId);
    opByOperationId.set(operation.operationId, operation);

    if (!schemas.has(operation.requestSchemaId)) {
      push('/requestSchemaId', 'missing-schema');
    } else {
      referencedSchemaIds.add(operation.requestSchemaId);
    }
    if (operation.responseSchemaId !== undefined) {
      if (!schemas.has(operation.responseSchemaId)) {
        push('/responseSchemaId', 'missing-schema');
      } else {
        referencedSchemaIds.add(operation.responseSchemaId);
      }
    }
    if (operation.eventSchemaId !== undefined) {
      if (!schemas.has(operation.eventSchemaId)) {
        push('/eventSchemaId', 'missing-schema');
      } else {
        referencedSchemaIds.add(operation.eventSchemaId);
      }
    }

    const needsResultSchema =
      (operation.executionClass === 'workflow' || operation.executionClass === 'maintenance') &&
      operation.eventSchemaId === undefined &&
      operation.responseSchemaId === undefined;
    if (needsResultSchema) {
      push('/executionClass', 'workflow-requires-result-schema');
    }
    if (operation.eventSchemaId !== undefined && operation.responseSchemaId !== undefined) {
      push('/eventSchemaId', 'streaming-response-conflict');
    }

    if (operation.allowedErrorCodes.length === 0) {
      push('/allowedErrorCodes', 'empty-error-codes');
    }
    for (const code of operation.allowedErrorCodes) {
      if (!(WIRE_ERROR_CODES as readonly string[]).includes(code)) {
        push(`/allowedErrorCodes/${code}`, 'unknown-error-code');
      }
    }

    if (!isPositiveInt(operation.requestLimitBytes) || operation.requestLimitBytes > 1_048_576) {
      push('/requestLimitBytes', 'invalid-size-limit');
    }
    if (!isPositiveInt(operation.responseLimitBytes) || operation.responseLimitBytes > 16_777_216) {
      push('/responseLimitBytes', 'invalid-size-limit');
    }
    if (
      operation.eventLimitBytes !== undefined &&
      (!isPositiveInt(operation.eventLimitBytes) || operation.eventLimitBytes > 1_048_576)
    ) {
      push('/eventLimitBytes', 'invalid-size-limit');
    }

    if (violations.length > 0) {
      groups.push({ message: `operation '${operation.operationId}' is invalid`, violations });
    }
  }

  // --- fixtures: every fixture resolves to a schema and its verdict must
  // match the `valid` flag (self-checking corpus).
  const seenFixtureIds = new Set<string>();
  for (const fixture of input.fixtures) {
    const violations: WireViolation[] = [];
    const push = (path: string, rule: string): void => {
      violations.push({ schemaId: fixture.id, path, rule });
    };

    if (fixture.id === '' || !FIXTURE_ID_PATTERN.test(fixture.id)) {
      push('', 'invalid-fixture-id');
    }
    if (seenFixtureIds.has(fixture.id)) {
      push('', 'duplicate-fixture-id');
    }
    seenFixtureIds.add(fixture.id);

    const operation = opByOperationId.get(fixture.operationId);
    if (operation === undefined) {
      push('/operationId', 'unknown-operation');
    } else {
      const schemaId = resolveFixtureSchemaId(fixture, input.operations);
      if (schemaId === undefined) {
        push(`/${fixture.kind}`, 'missing-fixture-schema');
      } else if (!schemas.has(schemaId)) {
        push(`/${fixture.kind}`, 'missing-fixture-schema');
      } else {
        referencedSchemaIds.add(schemaId);
        const schema = schemas.get(schemaId);
        if (schema !== undefined) {
          const verdict = Value.Check(schema, fixture.value);
          if (verdict !== fixture.valid) {
            push(
              '/value',
              fixture.valid ? 'fixture-fails-validation' : 'fixture-passes-validation',
            );
          }
        }
      }
    }

    if (violations.length > 0) {
      groups.push({ message: `fixture '${fixture.id}' is invalid`, violations });
    }
  }

  // --- wire-safety of every referenced schema.
  for (const schemaId of referencedSchemaIds) {
    const schema = schemas.get(schemaId);
    if (schema === undefined) continue;
    const violations = checkWireSchema(schema, schemaId);
    if (violations.length > 0) {
      groups.push({ message: `schema '${schemaId}' is not wire-safe`, violations });
    }
  }

  if (groups.length > 0) {
    throw new ContractCompileError(groups);
  }
  return { operations: input.operations };
}

// ---------------------------------------------------------------------------
// Product wire registry (Phase 0): the canonical 21-operation table.
// ---------------------------------------------------------------------------

function op(
  operationId: string,
  executionClass: ExecutionClass,
  idempotency: IdempotencyPolicy,
  retryPolicy: RetryPolicy,
  authScope: string,
  requestSchemaId: string,
  responseSchemaId: string | undefined,
  eventSchemaId: string | undefined,
  allowedErrorCodes: readonly string[],
  requestLimitBytes: number,
  responseLimitBytes: number,
  eventLimitBytes: number | undefined,
): WireOperation {
  return {
    operationId,
    feature: 'core',
    version: '1.0',
    executionClass,
    idempotency,
    retryPolicy,
    authScope,
    requestSchemaId,
    ...(responseSchemaId !== undefined ? { responseSchemaId } : {}),
    ...(eventSchemaId !== undefined ? { eventSchemaId } : {}),
    allowedErrorCodes: [...allowedErrorCodes],
    requestLimitBytes,
    responseLimitBytes,
    ...(eventLimitBytes !== undefined ? { eventLimitBytes } : {}),
    unknownFields: 'strict',
  };
}

/** The canonical product wire operations (feature `core`, version `1.0`). */
export const PRODUCT_WIRE_OPERATIONS: readonly WireOperation[] = [
  op(
    'meta.get',
    'transactional',
    'idempotent',
    'safe',
    'none',
    'wire.request.empty',
    'wire.meta.dto',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    16384,
    undefined,
  ),
  op(
    'characters.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.list-characters',
    'wire.paged.characters',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'characters.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-character',
    'wire.character.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'characters.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-character',
    'wire.character.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'characters.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.update-character',
    'wire.character.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'characters.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-character',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'chats.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.list-chats',
    'wire.paged.chats',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'chats.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-chat',
    'wire.chat.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.messages.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.list-messages',
    'wire.paged.messages',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'chats.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-chat',
    'wire.chat.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'chats.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.update-chat',
    'wire.chat.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-chat',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'chats.messages.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-message',
    'wire.message.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1048576,
    262144,
    undefined,
  ),
  op(
    'chats.messages.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.update-message',
    'wire.message.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1048576,
    262144,
    undefined,
  ),
  op(
    'chats.messages.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-message',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'generation.start',
    'workflow',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.start-generation',
    undefined,
    'wire.generation.event',
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'PROVIDER_ERROR',
      'CANCELLED',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    131072,
    1024,
    65536,
  ),
  op(
    'generation.cancel',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.cancel-generation',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'generation.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-generation-run',
    'wire.generation.run',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    65536,
    undefined,
  ),
  op(
    'generation.events',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.list-generation-events',
    'wire.paged.generation-events',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'generation.retry',
    'workflow',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.retry-generation',
    undefined,
    'wire.generation.event',
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'CONFLICT',
      'PROVIDER_ERROR',
      'CANCELLED',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    2048,
    1024,
    65536,
  ),
  op(
    'generation.keep',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.keep-partial-generation',
    'wire.generation.run',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    65536,
    undefined,
  ),
  op(
    'generation.discard',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.discard-generation',
    'wire.generation.run',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    65536,
    undefined,
  ),
  op(
    'generation.prompt.plan',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-prompt-plan',
    'wire.prompt.plan',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'generation.tools.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.list-tools',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    65536,
    undefined,
  ),
  op(
    'generation.tool.result',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.generation-tool-result',
    'wire.generation.run',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'CONFLICT',
      'PROVIDER_ERROR',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    2048,
    65536,
    undefined,
  ),
  op(
    'providers.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.list-providers',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'providers.config.set',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.set-provider-config',
    'wire.provider.config.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    131072,
    262144,
    undefined,
  ),
  op(
    'providers.config.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-provider-config',
    'wire.provider.config.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'providers.config.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.list-provider-configs',
    'wire.result.list-provider-configs',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'providers.config.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-provider-config',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'backups.create',
    'workflow',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.empty',
    'wire.backup.dto',
    undefined,
    ['INTERNAL', 'QUOTA_EXCEEDED', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'backups.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.list-backups',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'lorebooks.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.list-lorebooks',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'lorebooks.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-lorebook',
    'wire.lorebook.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'lorebooks.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-lorebook',
    'wire.lorebook.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'lorebooks.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.update-lorebook',
    'wire.lorebook.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'lorebooks.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-lorebook',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'presets.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.list-presets',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
];

// ---------------------------------------------------------------------------
// Fixture corpus (self-checked by `compileWireContract`).
// ---------------------------------------------------------------------------

const UUID_CHARACTER = '4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a';
const UUID_CHAT = '7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c';
const UUID_MESSAGE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const UUID_BACKUP = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const UUID_LOREBOOK = '2b3c4d5e-6f7a-4b9c-8d0e-1f2a3b4c5d6e';
const UUID_PRESET = '3c4d5e6f-7a8b-4c0d-9e1f-2a3b4c5d6e7f';
const UUID_WORKFLOW = '9c8b7a6e-5d4c-4b3a-9f8e-7d6c5b4a3f2e';
const UUID_CONFIG = '4d5e6f70-8a9b-4c2d-9e3f-4a5b6c7d8e9f';
const UUID_AVATAR = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f';
const UUID_RUN = '6e7f8091-ab2c-4d3e-9f4a-5b6c7d8e9f01';
const UUID_STEP = 'a1a2a3a4-b5c6-4d7e-8f90-1a2b3c4d5e6f';
const UUID_TOOL_CALL = 'b1b2b3b4-c5d6-4e7f-8a90-2b3c4d5e6f70';
const UUID_REQUEST = '8f901a2b-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const TIMESTAMP = '2026-08-12T10:00:00Z';

const META_VALUE = {
  appVersion: '0.1.0',
  api: { major: 1, minor: 0 },
  productWire: { major: 1, minor: 0 },
  minimumClientVersion: '0.1.0',
  features: { core: 1 },
};

const CHARACTER_VALUE = {
  id: UUID_CHARACTER,
  name: 'Ada Lovelace',
  description: 'First programmer',
  avatarAssetId: UUID_AVATAR,
  tags: ['analytical', 'historical'],
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const CHAT_VALUE = {
  id: UUID_CHAT,
  title: 'First chat',
  characterId: UUID_CHARACTER,
  messageCount: 2,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const MESSAGE_VALUE = {
  id: UUID_MESSAGE,
  chatId: UUID_CHAT,
  role: 'user',
  content: 'Hello there',
  createdAt: TIMESTAMP,
  sequence: 0,
  generationRunId: UUID_RUN,
};

const BACKUP_VALUE = {
  id: UUID_BACKUP,
  createdAt: TIMESTAMP,
  formatVersion: 1,
  sizeBytes: 2048,
  checksumSha256: 'a'.repeat(64),
  status: 'completed',
};

const LOREBOOK_VALUE = {
  id: UUID_LOREBOOK,
  name: 'World lore',
  description: 'Setting notes',
  entryCount: 12,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PRESET_VALUE = {
  id: UUID_PRESET,
  name: 'Balanced',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const GENERATION_RUN_VALUE = {
  runId: UUID_RUN,
  chatId: UUID_CHAT,
  attempt: 1,
  status: 'completed',
  provider: 'fake',
  model: 'steps=4',
  revision: 12,
  lastEventSequence: 9,
  partialTextLength: 0,
  partialTruncated: false,
  messageId: UUID_MESSAGE,
  startedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const GENERATION_EVENT_ENVELOPE_VALUE = {
  streamId: UUID_RUN,
  sequence: 0,
  type: 'generation.delta',
  payload: { type: 'generation.delta', text: 'Hello' },
};

const TOOL_CALL_VALUE = {
  id: UUID_TOOL_CALL,
  name: 'lookup_weather',
  arguments: { city: 'Kyiv' },
};

const GENERATION_STEP_VALUE = {
  stepId: UUID_STEP,
  runId: UUID_RUN,
  sequence: 1,
  type: 'tool_call',
  status: 'waiting',
  attempt: 1,
  idempotencyKey: UUID_STEP,
  input: { toolCall: TOOL_CALL_VALUE },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const TOOL_SPEC_VALUE = {
  id: 'lookup-weather',
  name: 'lookup_weather',
  description: 'Look up current weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
};

const PROVIDER_VALUE = {
  id: 'fake',
  name: 'Fake Provider',
  builtin: true,
  availability: { status: 'available' },
  models: [{ id: 'fake-1', name: 'Fake 1', contextLimit: 8192 }],
};

const PROVIDER_CONFIG_VALUE = {
  id: UUID_CONFIG,
  provider: 'fake',
  name: 'local',
  config: { temperature: 0.7, maxTokens: 2048 },
  hasApiKey: true,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PROMPT_PLAN_VALUE = {
  runId: UUID_RUN,
  chatId: UUID_CHAT,
  provider: 'fake',
  model: 'fake-1',
  instructFormat: 'plain-messages-v1',
  tokenizerProfile: 'heuristic-v1',
  approximateTokens: true,
  contextLimit: 8192,
  responseReserved: 2048,
  inputTokens: 96,
  overBudget: false,
  systemBlocks: [{ source: 'character', text: 'Aria is a cheerful guide.' }],
  messages: [
    { role: 'system', content: 'Aria is a cheerful guide.' },
    { role: 'user', content: 'Earlier message' },
    { role: 'user', content: 'Hello there' },
  ],
  excluded: [{ messageId: UUID_MESSAGE, reason: 'token_budget' }],
  createdAt: TIMESTAMP,
};

function fx(
  id: string,
  operationId: string,
  kind: WireFixture['kind'],
  valid: boolean,
  value: unknown,
  schemaId?: string,
): WireFixture {
  return { id, operationId, kind, valid, value, ...(schemaId !== undefined ? { schemaId } : {}) };
}

/**
 * The canonical fixture corpus: one valid request + one valid response per
 * operation (`generation.start` gets a valid `generation.completed` event
 * instead of a response) plus ten negative fixtures covering one rule family
 * each. `compileWireContract` self-checks every entry.
 */
export const PRODUCT_WIRE_FIXTURES: readonly WireFixture[] = [
  // --- valid request fixtures.
  fx('meta-get-request', 'meta.get', 'request', true, {}),
  fx('characters-list-request', 'characters.list', 'request', true, {}),
  fx('characters-get-request', 'characters.get', 'request', true, { characterId: UUID_CHARACTER }),
  fx('characters-create-request', 'characters.create', 'request', true, {
    name: 'Ada Lovelace',
    description: 'First programmer',
    tags: ['analytical'],
  }),
  fx('characters-update-request', 'characters.update', 'request', true, {
    characterId: UUID_CHARACTER,
    name: 'Grace Hopper',
  }),
  fx('characters-delete-request', 'characters.delete', 'request', true, {
    characterId: UUID_CHARACTER,
  }),
  fx('lorebooks-get-request', 'lorebooks.get', 'request', true, {
    lorebookId: UUID_LOREBOOK,
  }),
  fx('lorebooks-create-request', 'lorebooks.create', 'request', true, {
    name: 'World lore',
    description: 'Shared world facts',
    entries: [
      {
        keys: ['castle', 'fortress'],
        secondaryKeys: ['stone'],
        content: 'The castle is carved from living stone.',
        enabled: true,
        constant: false,
        selective: true,
      },
    ],
  }),
  fx('lorebooks-update-request', 'lorebooks.update', 'request', true, {
    lorebookId: UUID_LOREBOOK,
    name: 'World lore v2',
    entries: [{ keys: ['harbor'], content: 'The harbor never freezes.' }],
  }),
  fx('lorebooks-delete-request', 'lorebooks.delete', 'request', true, {
    lorebookId: UUID_LOREBOOK,
  }),
  fx('chats-list-request', 'chats.list', 'request', true, {}),
  fx('chats-get-request', 'chats.get', 'request', true, { chatId: UUID_CHAT }),
  fx('chats-create-request', 'chats.create', 'request', true, {
    characterId: UUID_CHARACTER,
    title: 'New conversation',
  }),
  fx('chats-update-request', 'chats.update', 'request', true, {
    chatId: UUID_CHAT,
    title: 'Renamed conversation',
  }),
  fx('chats-delete-request', 'chats.delete', 'request', true, { chatId: UUID_CHAT }),
  fx('chats-messages-list-request', 'chats.messages.list', 'request', true, {
    chatId: UUID_CHAT,
    order: 'desc',
  }),
  fx('chats-messages-create-request', 'chats.messages.create', 'request', true, {
    chatId: UUID_CHAT,
    role: 'user',
    content: 'Hello there',
  }),
  fx('chats-messages-update-request', 'chats.messages.update', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    content: 'Edited message',
  }),
  fx('chats-messages-delete-request', 'chats.messages.delete', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
  }),
  fx('generation-start-request', 'generation.start', 'request', true, {
    chatId: UUID_CHAT,
    message: 'Hello there',
  }),
  fx('generation-cancel-request', 'generation.cancel', 'request', true, {
    workflowId: UUID_WORKFLOW,
  }),
  fx('generation-get-request', 'generation.get', 'request', true, {
    workflowId: UUID_WORKFLOW,
  }),
  fx('generation-events-request', 'generation.events', 'request', true, {
    workflowId: UUID_WORKFLOW,
    afterSequence: -1,
    limit: 50,
  }),
  fx('generation-retry-request', 'generation.retry', 'request', true, {
    sourceRunId: UUID_RUN,
  }),
  fx('generation-keep-partial-request', 'generation.keep', 'request', true, {
    workflowId: UUID_WORKFLOW,
  }),
  fx('generation-discard-request', 'generation.discard', 'request', true, {
    workflowId: UUID_WORKFLOW,
  }),
  fx('generation-prompt-plan-request', 'generation.prompt.plan', 'request', true, {
    runId: UUID_RUN,
  }),
  fx('generation-tools-list-request', 'generation.tools.list', 'request', true, {}),
  fx('generation-tool-result-request', 'generation.tool.result', 'request', true, {
    runId: UUID_RUN,
    toolCallId: UUID_TOOL_CALL,
    result: { temperature: 21, condition: 'sunny' },
  }),
  fx('backups-create-request', 'backups.create', 'request', true, {}),
  fx('backups-list-request', 'backups.list', 'request', true, {}),
  fx('lorebooks-list-request', 'lorebooks.list', 'request', true, {}),
  fx('presets-list-request', 'presets.list', 'request', true, {}),
  fx('providers-list-request', 'providers.list', 'request', true, {}),
  fx('providers-config-set-request', 'providers.config.set', 'request', true, {
    provider: 'fake',
    name: 'local',
    config: { temperature: 0.7 },
    apiKey: 'sk-fixture-secret',
  }),
  fx('providers-config-get-request', 'providers.config.get', 'request', true, {
    provider: 'fake',
    name: 'local',
  }),
  fx('providers-config-list-request', 'providers.config.list', 'request', true, {}),
  fx('providers-config-delete-request', 'providers.config.delete', 'request', true, {
    provider: 'fake',
    name: 'local',
  }),

  // --- valid response fixtures.
  fx('meta-get-response', 'meta.get', 'response', true, META_VALUE),
  fx('characters-list-response', 'characters.list', 'response', true, {
    items: [CHARACTER_VALUE],
    nextCursor: 'next-page',
  }),
  fx('characters-get-response', 'characters.get', 'response', true, CHARACTER_VALUE),
  fx('characters-create-response', 'characters.create', 'response', true, CHARACTER_VALUE),
  fx('characters-update-response', 'characters.update', 'response', true, CHARACTER_VALUE),
  fx('characters-delete-response', 'characters.delete', 'response', true, {}),
  fx('chats-list-response', 'chats.list', 'response', true, { items: [CHAT_VALUE] }),
  fx('chats-get-response', 'chats.get', 'response', true, CHAT_VALUE),
  fx('chats-create-response', 'chats.create', 'response', true, CHAT_VALUE),
  fx('chats-update-response', 'chats.update', 'response', true, CHAT_VALUE),
  fx('chats-delete-response', 'chats.delete', 'response', true, {}),
  fx('chats-messages-list-response', 'chats.messages.list', 'response', true, {
    items: [MESSAGE_VALUE],
  }),
  fx('chats-messages-create-response', 'chats.messages.create', 'response', true, MESSAGE_VALUE),
  fx('chats-messages-update-response', 'chats.messages.update', 'response', true, MESSAGE_VALUE),
  fx('chats-messages-delete-response', 'chats.messages.delete', 'response', true, {}),
  fx('generation-cancel-response', 'generation.cancel', 'response', true, {}),
  fx('generation-get-response', 'generation.get', 'response', true, GENERATION_RUN_VALUE),
  fx('generation-events-response', 'generation.events', 'response', true, {
    items: [GENERATION_EVENT_ENVELOPE_VALUE],
    hasMore: false,
  }),
  fx('generation-retry-event', 'generation.retry', 'event', true, {
    type: 'generation.completed',
    finalMessage: MESSAGE_VALUE,
  }),
  fx('generation-keep-partial-response', 'generation.keep', 'response', true, {
    ...GENERATION_RUN_VALUE,
    status: 'failed',
    messageId: UUID_MESSAGE,
  }),
  fx('generation-discard-response', 'generation.discard', 'response', true, {
    ...GENERATION_RUN_VALUE,
    status: 'interrupted',
  }),
  fx(
    'generation-prompt-plan-response',
    'generation.prompt.plan',
    'response',
    true,
    PROMPT_PLAN_VALUE,
  ),
  fx('generation-tools-list-response', 'generation.tools.list', 'response', true, {
    items: [TOOL_SPEC_VALUE],
  }),
  fx('generation-tool-result-response', 'generation.tool.result', 'response', true, {
    ...GENERATION_RUN_VALUE,
    status: 'waiting_for_tool',
  }),
  fx('generation-step-event', 'generation.start', 'event', true, {
    type: 'generation.step',
    step: GENERATION_STEP_VALUE,
  }),
  fx('backups-create-response', 'backups.create', 'response', true, BACKUP_VALUE),
  fx('backups-list-response', 'backups.list', 'response', true, { items: [BACKUP_VALUE] }),
  fx('lorebooks-list-response', 'lorebooks.list', 'response', true, { items: [LOREBOOK_VALUE] }),
  fx('presets-list-response', 'presets.list', 'response', true, { items: [PRESET_VALUE] }),
  fx('providers-list-response', 'providers.list', 'response', true, { items: [PROVIDER_VALUE] }),
  fx(
    'providers-config-set-response',
    'providers.config.set',
    'response',
    true,
    PROVIDER_CONFIG_VALUE,
  ),
  fx(
    'providers-config-get-response',
    'providers.config.get',
    'response',
    true,
    PROVIDER_CONFIG_VALUE,
  ),
  fx('providers-config-list-response', 'providers.config.list', 'response', true, {
    items: [PROVIDER_CONFIG_VALUE],
  }),
  fx('providers-config-delete-response', 'providers.config.delete', 'response', true, {}),

  // --- valid event fixture (generation.start streams events, no response).
  fx('generation-start-event', 'generation.start', 'event', true, {
    type: 'generation.completed',
    finalMessage: MESSAGE_VALUE,
  }),
  fx('neg-generation-run-bad-status', 'generation.get', 'response', false, {
    ...GENERATION_RUN_VALUE,
    status: 'running-fast',
  }),
  fx('neg-generation-events-bad-envelope', 'generation.events', 'response', false, {
    items: [{ streamId: UUID_RUN, sequence: -3, type: 'generation.delta', payload: {} }],
    hasMore: false,
  }),
  fx('neg-provider-bad-availability', 'providers.list', 'response', false, {
    items: [
      {
        ...PROVIDER_VALUE,
        availability: { status: 'half-available' },
      },
    ],
  }),

  // --- negative fixtures (one per rule family).
  fx('neg-characters-get-missing-field', 'characters.get', 'request', false, {}),
  fx('neg-characters-get-wrong-type', 'characters.get', 'request', false, { characterId: 42 }),
  fx('neg-generate-event-unknown-discriminator', 'generation.start', 'event', false, {
    type: 'generation.unknown',
  }),
  fx('neg-characters-list-range', 'characters.list', 'request', false, { limit: 0 }),
  fx('neg-character-create-extra-field', 'characters.create', 'request', false, {
    name: 'Mallory',
    hacked: true,
  }),
  fx('neg-lorebook-get-missing-field', 'lorebooks.get', 'request', false, {}),
  fx('neg-lorebook-get-wrong-type', 'lorebooks.get', 'request', false, { lorebookId: 42 }),
  fx('neg-lorebook-create-extra-field', 'lorebooks.create', 'request', false, {
    name: 'World lore',
    hacked: true,
  }),
  fx('neg-lorebook-create-empty-name', 'lorebooks.create', 'request', false, {
    name: '',
  }),
  fx('neg-lorebook-create-bad-entry', 'lorebooks.create', 'request', false, {
    name: 'World lore',
    entries: [{ keys: ['castle'], content: '' }],
  }),
  fx('neg-lorebook-delete-missing-field', 'lorebooks.delete', 'request', false, {}),
  fx('neg-messages-list-bad-order', 'chats.messages.list', 'request', false, {
    chatId: UUID_CHAT,
    order: 'sideways',
  }),
  fx('neg-message-bad-role', 'chats.messages.list', 'response', false, {
    items: [
      {
        id: UUID_MESSAGE,
        chatId: UUID_CHAT,
        role: 'admin',
        content: 'x',
        createdAt: TIMESTAMP,
        sequence: 0,
      },
    ],
  }),
  fx('neg-backup-bad-status', 'backups.create', 'response', false, {
    ...BACKUP_VALUE,
    status: 'pending',
  }),
  fx('neg-backup-bad-checksum', 'backups.create', 'response', false, {
    ...BACKUP_VALUE,
    checksumSha256: 'xyz',
  }),
  fx('neg-meta-bad-timestamp', 'characters.create', 'response', false, {
    ...CHARACTER_VALUE,
    createdAt: 'yesterday',
  }),
  fx(
    'neg-response-envelope-bad-kind',
    'meta.get',
    'response',
    false,
    {
      kind: 'maybe',
      requestId: UUID_REQUEST,
      result: {},
    },
    'wire.response.envelope',
  ),
];

const WIRE_SCHEMA_MAP: ReadonlyMap<string, TSchema> = new Map(Object.entries(WIRE_SCHEMAS));

/**
 * Builds the canonical product wire registry: compiles the 21 operations and
 * the fixture corpus against `WIRE_SCHEMAS` (registering the wire formats
 * first). Throws `ContractCompileError` on any violation — a broken registry
 * is a build-time failure, never a runtime surprise.
 */
export function buildProductWireRegistry(): {
  operations: CompiledOperation[];
  schemas: ReadonlyMap<string, TSchema>;
} {
  registerWireFormats();
  const { operations } = compileWireContract(
    { operations: [...PRODUCT_WIRE_OPERATIONS], fixtures: [...PRODUCT_WIRE_FIXTURES] },
    WIRE_SCHEMA_MAP,
  );
  return { operations, schemas: WIRE_SCHEMA_MAP };
}
