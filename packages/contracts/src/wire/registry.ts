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
    'characters.export.card',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.characters.export.card',
    'wire.result.characters.export.card',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
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
    'chats.export',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.chats.export',
    'wire.result.chats.export',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    4194304,
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
    'chats.snapshots.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-chat-snapshot',
    'wire.result.chat-snapshot',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.messages.variants.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.message-variants-list',
    'wire.result.message-variant-list',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.messages.variants.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.message-variant-create',
    'wire.message.variant.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1048576,
    262144,
    undefined,
  ),
  op(
    'chats.messages.variants.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.message-variant-delete',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'chats.messages.variants.activate',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.message-variant-activate',
    'wire.message.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.messages.revisions.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.message-revisions-list',
    'wire.result.message-revision-list',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.messages.drafts.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.message-draft-get',
    'wire.message.draft.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.messages.drafts.save',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.message-draft-save',
    'wire.message.draft.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1048576,
    262144,
    undefined,
  ),
  op(
    'chats.messages.drafts.commit',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.message-draft-commit',
    'wire.message.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.messages.drafts.discard',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.message-draft-discard',
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
      'CAPABILITY_UNAVAILABLE',
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
      'CAPABILITY_UNAVAILABLE',
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
      'CAPABILITY_UNAVAILABLE',
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
    'profile.export',
    'workflow',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.profile-export',
    'wire.result.profile-export',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'assets.put',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.assets.put',
    'wire.result.assets.put',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1048576,
    262144,
    undefined,
  ),
  op(
    'assets.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.assets.get',
    'wire.result.assets.get',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'assets.content',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.assets.content',
    'wire.result.assets.content',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    4194304,
    undefined,
  ),
  op(
    'assets.delete',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.assets.delete',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
    undefined,
  ),
  op(
    'imports.character.card',
    'transactional',
    'non-idempotent',
    'safe',
    'app.write',
    'wire.request.imports.character.card',
    'wire.result.imports.character.card',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'plugins.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.plugins.list',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'plugins.install',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.plugins.install',
    'wire.result.plugins.install',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'plugins.uninstall',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.plugins.uninstall',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
    undefined,
  ),
  op(
    'plugins.enable',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.plugins.enable',
    'wire.plugins.item',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'plugins.disable',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.plugins.disable',
    'wire.plugins.item',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'themes.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.themes.list',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'themes.install',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.themes.install',
    'wire.result.themes.install',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'themes.uninstall',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.themes.uninstall',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
    undefined,
  ),
  op(
    'themes.activate',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.themes.activate',
    'wire.themes.item',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'themes.deactivate',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.empty',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
    undefined,
  ),
  op(
    'profiles.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.profiles.list',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'profiles.create',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.profiles.create',
    'wire.result.profiles.create',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'profiles.rename',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.profiles.rename',
    'wire.profiles.item',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'profiles.delete',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.profiles.delete',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
    undefined,
  ),
  op(
    'settings.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.settings.get',
    'wire.result.settings',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'settings.update',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.settings.update',
    'wire.result.settings',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'diagnostics.export',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.diagnostics-export',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'secrets.status',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.secrets-status',
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
    'wire.request.list-lorebooks',
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
    'lorebooks.entries.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.list-lorebook-entries',
    'wire.result.list-lorebook-entries',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    65536,
    undefined,
  ),
  op(
    'lorebooks.entries.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-lorebook-entry',
    'wire.lorebook.entry.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'lorebooks.entries.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.update-lorebook-entry',
    'wire.lorebook.entry.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'lorebooks.entries.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-lorebook-entry',
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
    'wire.request.list-presets',
    'wire.result.list-presets',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'presets.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-preset',
    'wire.preset.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'presets.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-preset',
    'wire.preset.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'presets.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.update-preset',
    'wire.preset.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'presets.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-preset',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'memories.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.list-memories',
    'wire.result.list-memories',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'memories.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-memory',
    'wire.memory.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'memories.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.update-memory',
    'wire.memory.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'memories.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-memory',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'personas.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.list-personas',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'personas.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-persona',
    'wire.persona.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'personas.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-persona',
    'wire.persona.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'personas.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.update-persona',
    'wire.persona.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
    undefined,
  ),
  op(
    'personas.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-persona',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
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
const UUID_LOREBOOK_ENTRY = '7e8f9012-3a4b-4c5d-9e0f-1a2b3c4d5e6f';
const UUID_MESSAGE_VARIANT = '8f9a0b1c-2d3e-4f6a-9b0c-1d2e3f4a5b6c';
const UUID_MESSAGE_REVISION = '9a0b1c2d-3e4f-4a7b-8c0d-1e2f3a4b5c6d';
const UUID_MESSAGE_DRAFT = '0b1c2d3e-4f5a-4b8c-9d0e-1f2a3b4c5d6e';
const UUID_PRESET = '3c4d5e6f-7a8b-4c0d-9e1f-2a3b4c5d6e7f';
const UUID_MEMORY = '4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e80';
const UUID_PERSONA = '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f';
const UUID_WORKFLOW = '9c8b7a6e-5d4c-4b3a-9f8e-7d6c5b4a3f2e';
const UUID_CONFIG = '4d5e6f70-8a9b-4c2d-9e3f-4a5b6c7d8e9f';
const UUID_AVATAR = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f';
const UUID_RUN = '6e7f8091-ab2c-4d3e-9f4a-5b6c7d8e9f01';
const UUID_STEP = 'a1a2a3a4-b5c6-4d7e-8f90-1a2b3c4d5e6f';
const UUID_TOOL_CALL = 'b1b2b3b4-c5d6-4e7f-8a90-2b3c4d5e6f70';
const UUID_REQUEST = '8f901a2b-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const TIMESTAMP = '2026-08-12T10:00:00Z';
/** Lowercase sha256 hex of an imported character-card file (fixture value). */
const IMPORT_SHA256 = 'abababababababababababababababababababababababababababababababab';

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
  profileId: UUID_PRESET,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const CHAT_VALUE = {
  id: UUID_CHAT,
  title: 'First chat',
  characterId: UUID_CHARACTER,
  personaId: UUID_PERSONA,
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
  meta: { manualExcluded: false },
};

const MESSAGE_VARIANT_VALUE = {
  id: UUID_MESSAGE_VARIANT,
  messageId: UUID_MESSAGE,
  content: 'Hello there (swipe)',
  position: 0,
  createdAt: TIMESTAMP,
};

const MESSAGE_REVISION_VALUE = {
  id: UUID_MESSAGE_REVISION,
  messageId: UUID_MESSAGE,
  content: 'Earlier draft text',
  position: 0,
  createdAt: TIMESTAMP,
};

const MESSAGE_DRAFT_VALUE = {
  id: UUID_MESSAGE_DRAFT,
  chatId: UUID_CHAT,
  role: 'assistant',
  content: 'Streaming partial…',
  sequence: 1,
  revision: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const BACKUP_VALUE = {
  id: UUID_BACKUP,
  createdAt: TIMESTAMP,
  formatVersion: 1,
  sizeBytes: 2048,
  checksumSha256: 'a'.repeat(64),
  status: 'completed',
};

const PROFILE_EXPORT_VALUE = {
  containerPath: 'exports/profile-export-0c0a/',
  formatVersion: 1,
  createdAt: TIMESTAMP,
  records: { characters: 1, chats: 1, messages: 2, lorebooks: 1, presets: 0 },
  assets: 0,
  sizeBytes: 4096,
  manifestSha256: 'b'.repeat(64),
};

const PROFILE_EXPORT_SCOPED_VALUE = {
  ...PROFILE_EXPORT_VALUE,
  containerPath: 'exports/profile-export-1b1b/',
  profileId: UUID_PRESET,
};

const LOREBOOK_VALUE = {
  id: UUID_LOREBOOK,
  name: 'World lore',
  description: 'Setting notes',
  entryCount: 12,
  characterId: UUID_CHARACTER,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PRESET_VALUE = {
  id: UUID_PRESET,
  kind: 'generation',
  name: 'Balanced',
  data: {
    maxContextTokens: 8192,
    generationDefaults: { temperature: 0.8 },
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const MEMORY_VALUE = {
  id: UUID_MEMORY,
  scope: 'character',
  characterId: UUID_CHARACTER,
  keys: ['aria', 'clockwork'],
  content: 'Aria guards the clockwork orchard.',
  enabled: true,
  position: 0,
  metadata: { source: 'legacy' },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PERSONA_VALUE = {
  id: UUID_PERSONA,
  name: 'Aria',
  description: 'Curious scholar',
  avatar: 'portraits/aria.png',
  isDefault: true,
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
  capabilities: {
    tools: false,
    vision: false,
    thinking: false,
    jsonMode: false,
    streaming: true,
  },
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

const SETTINGS_VALUE = {
  items: [
    { key: 'ui.theme', value: { theme: 'dark' }, updatedAt: TIMESTAMP },
    { key: 'app.language', value: { locale: 'en' }, updatedAt: TIMESTAMP },
  ],
};

const DIAGNOSTICS_VALUE = {
  generatedAt: TIMESTAMP,
  traceId: UUID_RUN,
  schemaHash: 'a'.repeat(64),
  schemaRevision: 12,
  storageFormat: 1,
  sqliteVersion: '3.49.0',
  appVersion: '0.1.0',
  wireVersion: { major: 1, minor: 0 },
  redaction: 'allowlist',
  sections: ['meta', 'storage', 'settings', 'generation'],
  settings: { count: 2 },
  generationRuns: { total: 1, completed: 1, failed: 0, waiting: 0 },
};

const SECRETS_STATUS_VALUE = {
  kind: 'portable',
  persistent: true,
  writable: true,
  available: true,
  recordCount: 2,
  formatVersion: 1,
};

const ASSET_VALUE = {
  id: UUID_AVATAR,
  kind: 'avatar',
  relativeKey: 'avatar/9f2c7a1b3d5e8f0a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a7c9e2b4d6f8a',
  checksumSha256: '9f2c7a1b3d5e8f0a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a7c9e2b4d6f8a',
  sizeBytes: 5,
  createdAt: TIMESTAMP,
};

const ASSETS_PUT_VALUE = {
  asset: ASSET_VALUE,
  deduplicated: false,
};

const ASSETS_CONTENT_VALUE = {
  assetId: UUID_AVATAR,
  contentType: 'image/png',
  contentBase64: 'aGVsbG8=',
};

const ASSETS_PUT_REQUEST = {
  kind: 'avatar',
  filename: 'a.png',
  contentType: 'image/png',
  contentBase64: 'aGVsbG8=',
};

const PLUGIN_VALUE = {
  id: 'lorebook-searcher',
  name: 'Lorebook Searcher',
  version: '1.2.0',
  enabled: false,
  trustState: 'verified-publisher',
  publisherKeyId: 'fp-9f2c7a1b',
  permissions: ['plugin.storage', 'lorebooks.list'],
  installedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  manifest: { id: 'lorebook-searcher', main: 'dist/index.js' },
};

const PLUGIN_INSTALL_REQUEST = {
  id: 'lorebook-searcher',
  name: 'Lorebook Searcher',
  version: '1.2.0',
  trustState: 'verified-publisher',
  publisherKeyId: 'fp-9f2c7a1b',
  permissions: ['plugin.storage', 'lorebooks.list'],
  manifest: { id: 'lorebook-searcher', main: 'dist/index.js' },
};

const THEME_VALUE = {
  id: 'wii-u-dark',
  name: 'Wii U Dark',
  version: '2.0.1',
  active: false,
  trustState: 'verified-publisher',
  publisherKeyId: 'fp-9f2c7a1b',
  cssAssetId: UUID_AVATAR,
  installedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  manifest: { id: 'wii-u-dark', level: 'shell' },
};

const THEME_INSTALL_REQUEST = {
  id: 'wii-u-dark',
  name: 'Wii U Dark',
  version: '2.0.1',
  trustState: 'verified-publisher',
  publisherKeyId: 'fp-9f2c7a1b',
  cssAssetId: UUID_AVATAR,
  manifest: { id: 'wii-u-dark', level: 'shell' },
};

const PROFILE_VALUE = {
  id: UUID_PRESET,
  name: 'Main',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PROFILE_CREATE_REQUEST = { name: 'Main' };

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
  userName: 'Aria',
  systemBlocks: [
    { source: 'character', text: 'Aria is a cheerful guide.' },
    { source: 'lorebook', text: 'Sword lore.' },
    { source: 'memory', text: 'The city sleeps.' },
  ],
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
  fx('characters-create-request-with-profile', 'characters.create', 'request', true, {
    name: 'Ada Lovelace',
    profileId: UUID_PRESET,
  }),
  fx('characters-update-request', 'characters.update', 'request', true, {
    characterId: UUID_CHARACTER,
    name: 'Grace Hopper',
  }),
  fx('characters-delete-request', 'characters.delete', 'request', true, {
    characterId: UUID_CHARACTER,
  }),
  fx('characters-export-card-request', 'characters.export.card', 'request', true, {
    characterId: UUID_CHARACTER,
    format: 'json',
  }),
  fx('characters-export-card-png-request', 'characters.export.card', 'request', true, {
    characterId: UUID_CHARACTER,
    format: 'png',
  }),
  fx('chats-export-request', 'chats.export', 'request', true, { chatId: UUID_CHAT }),
  fx('lorebooks-get-request', 'lorebooks.get', 'request', true, {
    lorebookId: UUID_LOREBOOK,
  }),
  fx('lorebooks-create-request', 'lorebooks.create', 'request', true, {
    name: 'World lore',
    description: 'Shared world facts',
    characterId: UUID_CHARACTER,
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
  fx('lorebooks-entries-list-request', 'lorebooks.entries.list', 'request', true, {
    lorebookId: UUID_LOREBOOK,
  }),
  fx('lorebooks-entries-create-request', 'lorebooks.entries.create', 'request', true, {
    lorebookId: UUID_LOREBOOK,
    entry: {
      keys: ['castle', 'fortress'],
      secondaryKeys: ['stone'],
      content: 'The castle is carved from living stone.',
      enabled: true,
      constant: false,
      selective: true,
    },
  }),
  fx('lorebooks-entries-update-request', 'lorebooks.entries.update', 'request', true, {
    lorebookId: UUID_LOREBOOK,
    entryId: UUID_LOREBOOK_ENTRY,
    patch: { content: 'The harbor never freezes.' },
  }),
  fx('lorebooks-entries-delete-request', 'lorebooks.entries.delete', 'request', true, {
    lorebookId: UUID_LOREBOOK,
    entryId: UUID_LOREBOOK_ENTRY,
  }),
  fx('personas-get-request', 'personas.get', 'request', true, {
    personaId: UUID_PERSONA,
  }),
  fx('personas-create-request', 'personas.create', 'request', true, {
    name: 'Aria',
    description: 'Curious scholar',
    isDefault: true,
  }),
  fx('personas-update-request', 'personas.update', 'request', true, {
    personaId: UUID_PERSONA,
    name: 'Aria the Voyager',
    avatar: 'portraits/aria.png',
  }),
  fx('personas-delete-request', 'personas.delete', 'request', true, {
    personaId: UUID_PERSONA,
  }),
  fx('chats-list-request', 'chats.list', 'request', true, {}),
  fx('chats-get-request', 'chats.get', 'request', true, { chatId: UUID_CHAT }),
  fx('chats-create-request', 'chats.create', 'request', true, {
    characterId: UUID_CHARACTER,
    title: 'New conversation',
    personaId: UUID_PERSONA,
  }),
  fx('chats-update-request', 'chats.update', 'request', true, {
    chatId: UUID_CHAT,
    title: 'Renamed conversation',
    personaId: UUID_PERSONA,
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
  fx('chats-snapshots-create-request', 'chats.snapshots.create', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    kind: 'checkpoint',
  }),
  fx('chats-snapshots-create-response', 'chats.snapshots.create', 'response', true, {
    chat: CHAT_VALUE,
    copiedMessages: 2,
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
  fx('lorebooks-list-request', 'lorebooks.list', 'request', true, { characterId: UUID_CHARACTER }),
  fx('presets-list-request', 'presets.list', 'request', true, { kind: 'generation' }),
  fx('presets-get-request', 'presets.get', 'request', true, { presetId: UUID_PRESET }),
  fx('presets-create-request', 'presets.create', 'request', true, {
    kind: 'generation',
    name: 'Balanced',
    data: { maxContextTokens: 8192, generationDefaults: { temperature: 0.8 } },
  }),
  fx('presets-update-request', 'presets.update', 'request', true, {
    presetId: UUID_PRESET,
    name: 'Balanced v2',
  }),
  fx('presets-delete-request', 'presets.delete', 'request', true, { presetId: UUID_PRESET }),
  fx('memories-list-request', 'memories.list', 'request', true, { scope: 'character' }),
  fx('memories-create-request', 'memories.create', 'request', true, {
    scope: 'character',
    characterId: UUID_CHARACTER,
    keys: ['aria'],
    content: 'Aria guards the clockwork orchard.',
  }),
  fx('memories-update-request', 'memories.update', 'request', true, {
    memoryId: UUID_MEMORY,
    content: 'Aria guards the clockwork orchard and its brass trees.',
    enabled: true,
  }),
  fx('memories-delete-request', 'memories.delete', 'request', true, { memoryId: UUID_MEMORY }),
  fx('personas-list-request', 'personas.list', 'request', true, {}),
  fx('profile-export-request', 'profile.export', 'request', true, { includeAssets: false }),
  fx('profile-export-request-default', 'profile.export', 'request', true, {}),
  fx('profile-export-request-scoped', 'profile.export', 'request', true, {
    includeAssets: false,
    profileId: UUID_PRESET,
  }),
  fx('assets-put-request', 'assets.put', 'request', true, ASSETS_PUT_REQUEST),
  fx('assets-get-request', 'assets.get', 'request', true, { assetId: UUID_AVATAR }),
  fx('assets-content-request', 'assets.content', 'request', true, { assetId: UUID_AVATAR }),
  fx('assets-delete-request', 'assets.delete', 'request', true, { assetId: UUID_AVATAR }),
  fx('plugins-list-request', 'plugins.list', 'request', true, {}),
  fx('plugins-install-request', 'plugins.install', 'request', true, PLUGIN_INSTALL_REQUEST),
  fx('plugins-uninstall-request', 'plugins.uninstall', 'request', true, {
    id: 'lorebook-searcher',
  }),
  fx('plugins-enable-request', 'plugins.enable', 'request', true, { id: 'lorebook-searcher' }),
  fx('plugins-disable-request', 'plugins.disable', 'request', true, { id: 'lorebook-searcher' }),
  fx('themes-list-request', 'themes.list', 'request', true, {}),
  fx('themes-install-request', 'themes.install', 'request', true, THEME_INSTALL_REQUEST),
  fx('themes-uninstall-request', 'themes.uninstall', 'request', true, { id: 'wii-u-dark' }),
  fx('themes-activate-request', 'themes.activate', 'request', true, { id: 'wii-u-dark' }),
  fx('themes-deactivate-request', 'themes.deactivate', 'request', true, {}),
  fx('themes-deactivate-response', 'themes.deactivate', 'response', true, {}),
  fx('profiles-list-request', 'profiles.list', 'request', true, {}),
  fx('profiles-create-request', 'profiles.create', 'request', true, PROFILE_CREATE_REQUEST),
  fx('profiles-rename-request', 'profiles.rename', 'request', true, {
    id: UUID_PRESET,
    name: 'Main renamed',
  }),
  fx('profiles-delete-request', 'profiles.delete', 'request', true, { id: UUID_PRESET }),
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
  fx('settings-get-request', 'settings.get', 'request', true, {
    keys: ['ui.theme', 'app.language'],
  }),
  fx('settings-get-request-default', 'settings.get', 'request', true, {}),
  fx('settings-update-request', 'settings.update', 'request', true, {
    settings: [
      { key: 'ui.theme', value: { theme: 'dark' } },
      { key: 'app.language', value: { locale: 'en' } },
    ],
  }),
  fx('diagnostics-export-request', 'diagnostics.export', 'request', true, {}),
  fx('secrets-status-request', 'secrets.status', 'request', true, {}),

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
  fx('characters-export-card-response', 'characters.export.card', 'response', true, {
    filename: 'ada-lovelace.json',
    contentType: 'application/json',
    contentBase64: 'eyJuYW1lIjoiQWRhIExvdmVsYWNlIn0=',
    warnings: [],
  }),
  fx('characters-export-card-png-response', 'characters.export.card', 'response', true, {
    filename: 'ada-lovelace.png',
    contentType: 'image/png',
    contentBase64: 'aVBORw0KGgoAAAANSUhEUg==',
    warnings: [],
  }),
  fx('chats-export-response', 'chats.export', 'response', true, {
    filename: 'chat-018f0000-0000-7000-8000-000000000099.json',
    contentType: 'application/json',
    contentBase64: 'eyJraW5kIjoibmVvdGF2ZXJuYS1jaGF0LWV4cG9ydCJ9',
    warnings: [],
  }),
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
  // --- message variants / revisions / drafts (Этап 4, slice 2).
  fx('message-variants-list-request', 'chats.messages.variants.list', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
  }),
  fx('message-variants-list-response', 'chats.messages.variants.list', 'response', true, {
    items: [MESSAGE_VARIANT_VALUE],
  }),
  fx('message-variant-create-request', 'chats.messages.variants.create', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    content: 'Hello there (swipe)',
  }),
  fx('message-variant-create-response', 'chats.messages.variants.create', 'response', true, {
    ...MESSAGE_VARIANT_VALUE,
    id: 'ab0c1d2e-3f4a-4b5c-9d0e-1f2a3b4c5d6e',
    position: 1,
  }),
  fx('message-variant-delete-request', 'chats.messages.variants.delete', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    variantId: UUID_MESSAGE_VARIANT,
  }),
  fx('message-variant-delete-response', 'chats.messages.variants.delete', 'response', true, {}),
  fx('message-variant-activate-request', 'chats.messages.variants.activate', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    variantId: UUID_MESSAGE_VARIANT,
  }),
  fx('message-variant-activate-response', 'chats.messages.variants.activate', 'response', true, {
    ...MESSAGE_VALUE,
    content: 'Hello there (swipe)',
  }),
  fx('message-revisions-list-request', 'chats.messages.revisions.list', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
  }),
  fx('message-revisions-list-response', 'chats.messages.revisions.list', 'response', true, {
    items: [MESSAGE_REVISION_VALUE],
  }),
  fx('message-draft-get-request', 'chats.messages.drafts.get', 'request', true, {
    chatId: UUID_CHAT,
    draftId: UUID_MESSAGE_DRAFT,
  }),
  fx(
    'message-draft-get-response',
    'chats.messages.drafts.get',
    'response',
    true,
    MESSAGE_DRAFT_VALUE,
  ),
  fx('message-draft-save-request', 'chats.messages.drafts.save', 'request', true, {
    chatId: UUID_CHAT,
    role: 'assistant',
    content: 'Streaming partial…',
  }),
  fx(
    'message-draft-save-response',
    'chats.messages.drafts.save',
    'response',
    true,
    MESSAGE_DRAFT_VALUE,
  ),
  fx('message-draft-commit-request', 'chats.messages.drafts.commit', 'request', true, {
    chatId: UUID_CHAT,
    draftId: UUID_MESSAGE_DRAFT,
  }),
  fx(
    'message-draft-commit-response',
    'chats.messages.drafts.commit',
    'response',
    true,
    MESSAGE_VALUE,
  ),
  fx('message-draft-discard-request', 'chats.messages.drafts.discard', 'request', true, {
    chatId: UUID_CHAT,
    draftId: UUID_MESSAGE_DRAFT,
  }),
  fx('message-draft-discard-response', 'chats.messages.drafts.discard', 'response', true, {}),
  // negative corpus for the new ops
  fx('neg-message-variant-create-wrong-type', 'chats.messages.variants.create', 'request', false, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    content: 42,
  }),
  fx('neg-message-draft-save-bad-role', 'chats.messages.drafts.save', 'request', false, {
    chatId: UUID_CHAT,
    role: 'narrator',
    content: 'x',
  }),
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
  fx('profile-export-response', 'profile.export', 'response', true, PROFILE_EXPORT_VALUE),
  fx(
    'profile-export-response-scoped',
    'profile.export',
    'response',
    true,
    PROFILE_EXPORT_SCOPED_VALUE,
  ),
  fx('assets-put-response', 'assets.put', 'response', true, ASSETS_PUT_VALUE),
  fx('assets-get-response', 'assets.get', 'response', true, { asset: ASSET_VALUE }),
  fx('assets-content-response', 'assets.content', 'response', true, ASSETS_CONTENT_VALUE),
  fx('assets-delete-response', 'assets.delete', 'response', true, {}),
  fx('imports-character-card-request', 'imports.character.card', 'request', true, {
    assetId: UUID_AVATAR,
  }),
  fx('imports-character-card-response', 'imports.character.card', 'response', true, {
    character: CHARACTER_VALUE,
    created: true,
    sourceHash: IMPORT_SHA256,
    warnings: [],
  }),
  fx('neg-imports-character-card-missing-asset', 'imports.character.card', 'request', false, {}),
  fx('neg-imports-character-card-bad-hash', 'imports.character.card', 'response', false, {
    character: CHARACTER_VALUE,
    created: true,
    sourceHash: 'not-a-hash',
    warnings: [],
  }),
  fx('plugins-list-response', 'plugins.list', 'response', true, { items: [PLUGIN_VALUE] }),
  fx('plugins-install-response', 'plugins.install', 'response', true, { plugin: PLUGIN_VALUE }),
  fx('plugins-enable-response', 'plugins.enable', 'response', true, {
    ...PLUGIN_VALUE,
    enabled: true,
  }),
  fx('plugins-disable-response', 'plugins.disable', 'response', true, {
    ...PLUGIN_VALUE,
    enabled: false,
  }),
  fx('themes-list-response', 'themes.list', 'response', true, { items: [THEME_VALUE] }),
  fx('themes-install-response', 'themes.install', 'response', true, { theme: THEME_VALUE }),
  fx('themes-uninstall-response', 'themes.uninstall', 'response', true, {}),
  fx('themes-activate-response', 'themes.activate', 'response', true, {
    ...THEME_VALUE,
    active: true,
  }),
  fx('profiles-list-response', 'profiles.list', 'response', true, { items: [PROFILE_VALUE] }),
  fx('profiles-create-response', 'profiles.create', 'response', true, { profile: PROFILE_VALUE }),
  fx('profiles-rename-response', 'profiles.rename', 'response', true, {
    ...PROFILE_VALUE,
    name: 'Main renamed',
  }),
  fx('profiles-delete-response', 'profiles.delete', 'response', true, {}),
  fx('plugins-uninstall-response', 'plugins.uninstall', 'response', true, {}),
  fx('lorebooks-list-response', 'lorebooks.list', 'response', true, { items: [LOREBOOK_VALUE] }),
  fx('lorebooks-get-response', 'lorebooks.get', 'response', true, LOREBOOK_VALUE),
  fx('lorebooks-create-response', 'lorebooks.create', 'response', true, LOREBOOK_VALUE),
  fx('lorebooks-update-response', 'lorebooks.update', 'response', true, LOREBOOK_VALUE),
  fx('lorebooks-delete-response', 'lorebooks.delete', 'response', true, {}),
  fx('lorebooks-entries-list-response', 'lorebooks.entries.list', 'response', true, {
    items: [
      {
        id: UUID_LOREBOOK_ENTRY,
        keys: ['castle', 'fortress'],
        secondaryKeys: ['stone'],
        content: 'The castle is carved from living stone.',
        enabled: true,
        constant: false,
        selective: true,
      },
    ],
  }),
  fx('lorebooks-entries-create-response', 'lorebooks.entries.create', 'response', true, {
    id: UUID_LOREBOOK_ENTRY,
    keys: ['castle', 'fortress'],
    secondaryKeys: ['stone'],
    content: 'The castle is carved from living stone.',
    enabled: true,
    constant: false,
    selective: true,
  }),
  fx('lorebooks-entries-update-response', 'lorebooks.entries.update', 'response', true, {
    id: UUID_LOREBOOK_ENTRY,
    keys: ['harbor'],
    content: 'The harbor never freezes.',
    enabled: true,
    constant: false,
    selective: false,
  }),
  fx('lorebooks-entries-delete-response', 'lorebooks.entries.delete', 'response', true, {}),
  fx('presets-list-response', 'presets.list', 'response', true, { items: [PRESET_VALUE] }),
  fx('presets-get-response', 'presets.get', 'response', true, PRESET_VALUE),
  fx('presets-create-response', 'presets.create', 'response', true, PRESET_VALUE),
  fx('presets-update-response', 'presets.update', 'response', true, {
    ...PRESET_VALUE,
    name: 'Balanced v2',
  }),
  fx('presets-delete-response', 'presets.delete', 'response', true, {}),
  fx('memories-list-response', 'memories.list', 'response', true, { items: [MEMORY_VALUE] }),
  fx('memories-create-response', 'memories.create', 'response', true, MEMORY_VALUE),
  fx('memories-update-response', 'memories.update', 'response', true, {
    ...MEMORY_VALUE,
    content: 'Aria guards the clockwork orchard and its brass trees.',
  }),
  fx('memories-delete-response', 'memories.delete', 'response', true, {}),
  fx('personas-list-response', 'personas.list', 'response', true, { items: [PERSONA_VALUE] }),
  fx('personas-get-response', 'personas.get', 'response', true, PERSONA_VALUE),
  fx('personas-create-response', 'personas.create', 'response', true, PERSONA_VALUE),
  fx('personas-update-response', 'personas.update', 'response', true, PERSONA_VALUE),
  fx('personas-delete-response', 'personas.delete', 'response', true, {}),
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
  fx('settings-get-response', 'settings.get', 'response', true, SETTINGS_VALUE),
  fx('settings-update-response', 'settings.update', 'response', true, SETTINGS_VALUE),
  fx('diagnostics-export-response', 'diagnostics.export', 'response', true, DIAGNOSTICS_VALUE),
  fx('secrets-status-response', 'secrets.status', 'response', true, SECRETS_STATUS_VALUE),

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
  fx('neg-provider-bad-capabilities', 'providers.list', 'response', false, {
    items: [
      {
        ...PROVIDER_VALUE,
        capabilities: {
          tools: 'yes',
          vision: false,
          thinking: false,
          jsonMode: false,
          streaming: true,
        },
      },
    ],
  }),
  fx('neg-settings-get-bad-key', 'settings.get', 'request', false, {
    keys: ['UPPER_CASE'],
  }),
  fx('neg-settings-update-empty', 'settings.update', 'request', false, {
    settings: [],
  }),
  fx('neg-settings-update-bad-key', 'settings.update', 'request', false, {
    settings: [{ key: 'no spaces', value: {} }],
  }),
  fx('neg-diagnostics-export-bad-redaction', 'diagnostics.export', 'response', false, {
    ...DIAGNOSTICS_VALUE,
    redaction: 'everything',
  }),
  fx('neg-secrets-status-empty-kind', 'secrets.status', 'response', false, {
    ...SECRETS_STATUS_VALUE,
    kind: '',
  }),

  // --- negative fixtures (one per rule family).
  fx('neg-characters-get-missing-field', 'characters.get', 'request', false, {}),
  fx('neg-characters-get-wrong-type', 'characters.get', 'request', false, { characterId: 42 }),
  fx('neg-characters-export-card-bad-format', 'characters.export.card', 'request', false, {
    characterId: UUID_CHARACTER,
    format: 'xml',
  }),
  fx('neg-characters-export-card-missing-field', 'characters.export.card', 'request', false, {
    format: 'json',
  }),
  fx('neg-characters-export-card-response-missing-base64', 'characters.export.card', 'response', false, {
    filename: 'ada.json',
    contentType: 'application/json',
    warnings: [],
  }),
  fx('neg-chats-export-missing-field', 'chats.export', 'request', false, {}),
  fx('neg-chats-export-response-bad-extension', 'chats.export', 'response', false, {
    filename: 'chat.txt',
    contentType: 'application/json',
    contentBase64: 'e30=',
    warnings: [],
  }),
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
  // negative corpus for memories/presets
  fx('neg-preset-create-bad-kind', 'presets.create', 'request', false, {
    kind: 'Bad Kind!',
    name: 'Invalid',
  }),
  fx('neg-preset-get-missing-field', 'presets.get', 'request', false, {}),
  fx('neg-memory-create-wrong-type', 'memories.create', 'request', false, {
    content: 42,
  }),
  fx('neg-memory-update-missing-field', 'memories.update', 'request', false, {}),
  fx('neg-lorebook-entries-list-missing-field', 'lorebooks.entries.list', 'request', false, {}),
  fx('neg-lorebook-entries-create-missing-book', 'lorebooks.entries.create', 'request', false, {
    entry: { keys: ['k'], content: 'c' },
  }),
  fx('neg-lorebook-entries-create-missing-payload', 'lorebooks.entries.create', 'request', false, {
    lorebookId: UUID_LOREBOOK,
  }),
  fx('neg-lorebook-entries-update-missing-id', 'lorebooks.entries.update', 'request', false, {
    lorebookId: UUID_LOREBOOK,
    patch: { content: 'x' },
  }),
  fx('neg-lorebook-entries-update-bad-id-type', 'lorebooks.entries.update', 'request', false, {
    lorebookId: UUID_LOREBOOK,
    entryId: 42,
    patch: { content: 'x' },
  }),
  fx('neg-lorebook-entries-delete-missing-id', 'lorebooks.entries.delete', 'request', false, {
    lorebookId: UUID_LOREBOOK,
  }),
  fx('neg-persona-get-missing-field', 'personas.get', 'request', false, {}),
  fx('neg-persona-get-wrong-type', 'personas.get', 'request', false, { personaId: 42 }),
  fx('neg-persona-create-extra-field', 'personas.create', 'request', false, {
    name: 'Aria',
    hacked: true,
  }),
  fx('neg-persona-create-empty-name', 'personas.create', 'request', false, {
    name: '',
  }),
  fx('neg-persona-update-missing-field', 'personas.update', 'request', false, {
    name: 'No id',
  }),
  fx('neg-chat-create-bad-persona', 'chats.create', 'request', false, {
    characterId: UUID_CHARACTER,
    personaId: 'not-a-uuid',
  }),
  fx('neg-chat-response-bad-persona', 'chats.get', 'response', false, {
    ...CHAT_VALUE,
    personaId: 'also-not-a-uuid',
  }),
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
  fx('neg-profile-export-bad-counts', 'profile.export', 'response', false, {
    ...PROFILE_EXPORT_VALUE,
    records: { ...PROFILE_EXPORT_VALUE.records, chats: 'one' },
  }),
  fx('neg-profile-export-bad-request', 'profile.export', 'request', false, {
    includeAssets: 'yes',
  }),
  fx('neg-profile-export-bad-profile', 'profile.export', 'request', false, {
    includeAssets: false,
    profileId: 'not-a-uuid',
  }),
  fx('neg-character-create-bad-profile', 'characters.create', 'request', false, {
    name: 'Ada',
    profileId: 'not-a-uuid',
  }),
  fx('neg-assets-put-bad-base64', 'assets.put', 'request', false, {
    ...ASSETS_PUT_REQUEST,
    contentBase64: '!!!not-base64!!!',
  }),
  fx('neg-assets-put-bad-kind', 'assets.put', 'request', false, {
    ...ASSETS_PUT_REQUEST,
    kind: 'UPPER',
  }),
  fx('neg-assets-get-bad-id', 'assets.get', 'request', false, { assetId: 'nope' }),
  fx('neg-assets-item-bad-checksum', 'assets.get', 'response', false, {
    asset: { ...ASSET_VALUE, checksumSha256: 'zzz' },
  }),
  fx('neg-plugins-install-bad-trust', 'plugins.install', 'request', false, {
    ...PLUGIN_INSTALL_REQUEST,
    trustState: 'super-trusted',
  }),
  fx('neg-plugins-install-bad-id', 'plugins.install', 'request', false, {
    ...PLUGIN_INSTALL_REQUEST,
    id: 'UPPER',
  }),
  fx('neg-plugins-item-bad-version', 'plugins.list', 'response', false, {
    items: [{ ...PLUGIN_VALUE, version: '' }],
  }),
  fx('neg-themes-install-bad-trust', 'themes.install', 'request', false, {
    ...THEME_INSTALL_REQUEST,
    trustState: 'super-trusted',
  }),
  fx('neg-themes-install-bad-css', 'themes.install', 'request', false, {
    ...THEME_INSTALL_REQUEST,
    cssAssetId: 'not-a-uuid',
  }),
  fx('neg-themes-item-bad-active', 'themes.list', 'response', false, {
    items: [{ ...THEME_VALUE, active: 'yes' }],
  }),
  fx('neg-profiles-create-bad-name', 'profiles.create', 'request', false, { name: '' }),
  fx('neg-profiles-rename-bad-id', 'profiles.rename', 'request', false, {
    id: 'nope',
    name: 'Main',
  }),
  fx('neg-profiles-item-bad-name', 'profiles.list', 'response', false, {
    items: [{ ...PROFILE_VALUE, name: '' }],
  }),
  fx('characters-create-request-with-avatar', 'characters.create', 'request', true, {
    name: 'Aveline',
    avatarAssetId: UUID_AVATAR,
  }),
  fx('characters-update-request-with-avatar', 'characters.update', 'request', true, {
    characterId: UUID_CHARACTER,
    avatarAssetId: UUID_AVATAR,
  }),
  fx('neg-characters-update-bad-avatar', 'characters.update', 'request', false, {
    characterId: UUID_CHARACTER,
    avatarAssetId: 'not-a-uuid',
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
  // Over-limit message: one character past the schema maxLength (100000).
  // Documents the size boundary in the corpus; the byte-level gate that
  // rejects this BEFORE the schema check is tested behaviorally in
  // runtime-kernel (kernel_payload_gates) and remote-http (413 tests).
  fx('neg-request-message-too-large', 'generation.start', 'request', false, {
    chatId: UUID_CHAT,
    message: 'x'.repeat(100_001),
  }),
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
