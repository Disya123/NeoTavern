/**
 * Wire operation registry: operation metadata, the fixture corpus and the
 * `compileWireContract` validator that every schema/operation/fixture must
 * pass. `buildProductWireRegistry()` produces the canonical product registry
 * (currently 101 operations) that codegen, the Rust kernel and the facades
 * consume.
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
// Product wire registry (Phase 0): the canonical product operation table.
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
    'characters.restore',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.get-character',
    'wire.character.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'characters.versions.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-character',
    'wire.result.character-versions',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'characters.versions.restore',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.characters.versions.restore',
    'wire.character.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'characters.gallery.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.characters-gallery-list',
    'wire.result.characters-gallery-list',
    undefined,
    ['INTERNAL', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'characters.gallery.add',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.characters-gallery-add',
    'wire.result.characters-gallery-add',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1_048_576,
    4096,
    undefined,
  ),
  op(
    'characters.gallery.delete',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.characters-gallery-delete',
    'wire.result.characters-gallery-delete',
    undefined,
    ['INTERNAL', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
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
    'characters.card.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.characters.card.get',
    'wire.character.card',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    131072,
    undefined,
  ),
  op(
    'characters.card.update',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.characters.card.update',
    'wire.character.card',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    131072,
    131072,
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
    'chats.reorder',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.chats-reorder',
    'wire.result.chats-reorder',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    262144,
    2048,
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
  // M7 Etap-4 (cluster 15): durable plugin→message block attachments. The
  // list is a batched read for one rendered page (no N+1); attach creates one
  // row per call (non-idempotent), while update/delete address a block by id.
  op(
    'chats.blocks.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.chats.blocks.list',
    'wire.result.chats.blocks.list',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    16384,
    4194304,
    undefined,
  ),
  op(
    'chats.blocks.attach',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.chats.blocks.attach',
    'wire.message-block.item',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    524288,
    1048576,
    undefined,
  ),
  op(
    'blocks.update',
    'transactional',
    'idempotent',
    'safe-with-idempotency-key',
    'app.write',
    'wire.request.blocks.update',
    'wire.message-block.item',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    524288,
    1048576,
    undefined,
  ),
  op(
    'blocks.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.blocks.delete',
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
    'chats.snapshots.rollback',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.snapshots-rollback',
    'wire.result.snapshots-rollback',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.snapshots.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.snapshots-list',
    'wire.result.snapshots-list',
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
    'chats.messages.drafts.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.message-draft-list',
    'wire.result.message-draft-list',
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
  // M7 Etap-4 cluster 18: the app-event log cursor. The canonical plane has a
  // single writer, so a subscriber resumes from the last `sequence` it saw
  // instead of holding an SSE connection open (the push transport is a host
  // concern, not a contract one).
  op(
    'events.poll',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.app-events-poll',
    'wire.result.app-events-page',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
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
    'chats.context.audit',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.get-chat',
    'wire.result.chat-context-audit',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'chats.prompt.preview',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.chat-prompt-preview',
    'wire.result.chat-prompt-preview',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1048576,
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
    'providers.catalog',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.provider-catalog',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'providers.secrets.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.list-provider-secrets',
    'wire.result.provider-secrets',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'providers.secrets.create',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.create-provider-secret',
    'wire.result.provider-secret-created',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'CONFLICT',
      'CAPABILITY_UNAVAILABLE',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    131072,
    2048,
    undefined,
  ),
  op(
    'providers.secrets.update',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.update-provider-secret',
    'wire.provider.secret.dto',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'providers.secrets.delete',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.delete-provider-secret',
    'wire.result.empty',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'providers.secrets.reveal',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.reveal-provider-secret',
    'wire.result.provider-secret-reveal',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'CONFLICT',
      'CAPABILITY_UNAVAILABLE',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    2048,
    262144,
    undefined,
  ),
  op(
    'secrets.exposure',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.secrets-exposure',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
    undefined,
  ),
  op(
    'providers.models',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.provider-models',
    'wire.result.provider-models',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'UNAUTHORIZED',
      'RATE_LIMITED',
      'PROVIDER_ERROR',
      'CAPABILITY_UNAVAILABLE',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    2048,
    262144,
    undefined,
  ),
  op(
    'providers.test',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.provider-test',
    'wire.result.provider-test',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'UNAUTHORIZED',
      'RATE_LIMITED',
      'PROVIDER_ERROR',
      'CAPABILITY_UNAVAILABLE',
      'CANCELLED',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    8192,
    262144,
    undefined,
  ),

  // ADR-0063 media operations: transcription is the first one ported. The
  // audio is an asset id (ADR-0061), the provider is one stored config, and a
  // provider that cannot transcribe answers CAPABILITY_UNAVAILABLE through the
  // adapter's default implementation instead of being handed bytes.
  op(
    'providers.transcribe',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.provider-transcribe',
    'wire.result.provider-transcribe',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'UNAUTHORIZED',
      'RATE_LIMITED',
      'PROVIDER_ERROR',
      'CAPABILITY_UNAVAILABLE',
      'CANCELLED',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    2048,
    262144,
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
    'backups.restore',
    'workflow',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.backups-restore',
    'wire.result.backups-restore',
    undefined,
    ['INTERNAL', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
    undefined,
  ),
  op(
    'backups.delete',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.backups-delete',
    'wire.result.backups-delete',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
    undefined,
  ),
  op(
    'data.activation.status',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.data.activation-status',
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
    'profile.import',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.profile-import',
    'wire.result.profile-import',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
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
  // ADR-0061 chunked upload: the only path that carries a file larger than the
  // `assets.put` cap. Chunks are staged under the data root and published as
  // ONE immutable asset at `finish`, so every consumer keeps addressing an
  // `assetId` and the digest/dedupe rules are unchanged.
  op(
    'assets.upload.begin',
    'transactional',
    'non-idempotent',
    'safe',
    'app.write',
    'wire.request.assets.upload.begin',
    'wire.result.assets.upload.begin',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'CAPABILITY_UNAVAILABLE',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    2048,
    1024,
    undefined,
  ),
  op(
    'assets.upload.append',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.assets.upload.append',
    'wire.result.assets.upload.append',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1048576,
    1024,
    undefined,
  ),
  op(
    'assets.upload.finish',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.assets.upload.finish',
    'wire.result.assets.put',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    4096,
    undefined,
  ),
  op(
    'assets.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.assets-list',
    'wire.result.assets-list',
    undefined,
    ['INTERNAL', 'VALIDATION', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'assets.upload.abort',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.assets.upload.abort',
    'wire.result.assets.upload.abort',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
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
    'assets.thumb',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.assets.thumb',
    'wire.result.assets.thumb',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    3145728,
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
    'imports.fullbackup.analyze',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.imports.fullbackup.analyze',
    'wire.result.imports.fullbackup.analyze',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION'],
    1024,
    262144,
    undefined,
  ),
  op(
    'imports.fullbackup.execute',
    'transactional',
    'non-idempotent',
    'safe',
    'app.write',
    'wire.request.imports.fullbackup.execute',
    'wire.result.imports.fullbackup.execute',
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
  // Plugin state KV (M7 cluster 21 part 1): the canonical counterpart of the
  // legacy `/api/v2/plugins/:id/state` store. Reads are safe; a write is a CAS
  // transition, so a stale `expectedRevision` is CONFLICT rather than a silent
  // overwrite; delete is idempotent (`deleted: false` when nothing was stored).
  op(
    'plugins.state.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.plugins.state.get',
    'wire.result.plugins.state',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'plugins.state.set',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.plugins.state.set',
    'wire.result.plugins.state.set',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    262144,
    2048,
    undefined,
  ),
  op(
    'plugins.state.delete',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.plugins.state.get',
    'wire.result.plugins.state.delete',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  // M7 Etap-4 (cluster 21a): the plugin blob store. The legacy routes
  // (`/plugins/:id/blobs*`) carried up to 8 MiB per blob in one binary body,
  // which no JSON request can honour, so the family is chunked exactly like
  // ADR-0061: `begin|append|finish` stages and publishes content-addressed
  // bytes under the plugin's own namespace, `read` serves bounded 256 KiB
  // ranges (the host loops until `eof` while feeding the sandbox stream), and
  // `list|delete` are the metadata half. Ownership is the `pluginId` plus the
  // `storage.blobs` grant recorded at install — never a shared asset id — so
  // one plugin cannot address another plugin's bytes.
  op(
    'plugins.blobs.begin',
    'transactional',
    'non-idempotent',
    'safe',
    'app.write',
    'wire.request.plugins.blobs.begin',
    'wire.result.plugins.blobs.begin',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'plugins.blobs.append',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.plugins.blobs.append',
    'wire.result.plugins.blobs.append',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1048576,
    1024,
    undefined,
  ),
  op(
    'plugins.blobs.finish',
    'transactional',
    'non-idempotent',
    'none',
    'app.write',
    'wire.request.plugins.blobs.finish',
    'wire.plugin-blob',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    2048,
    undefined,
  ),
  op(
    'plugins.blobs.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.plugins.blobs.list',
    'wire.result.plugins.blobs.list',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    65536,
    undefined,
  ),
  op(
    'plugins.blobs.read',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.plugins.blobs.read',
    'wire.result.plugins.blobs.read',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    524288,
    undefined,
  ),
  op(
    'plugins.blobs.delete',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.plugins.blobs.delete',
    'wire.result.plugins.blobs.delete',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  // M7 Etap-4 (cluster 21 part 2): the plugin's own secret store. Rows carry
  // only the opaque SecretStore reference; `masked` is derived from that
  // reference, and the plaintext crosses the wire through exactly one op
  // (`plugins.secrets.reveal`) under the host exposure policy.
  op(
    'plugins.secrets.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.plugins.secrets.list',
    'wire.result.plugin-secrets',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    262144,
    undefined,
  ),
  op(
    'plugins.secrets.set',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.plugins.secrets.set',
    'wire.plugin-secret',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'CONFLICT',
      'CAPABILITY_UNAVAILABLE',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    131072,
    2048,
    undefined,
  ),
  op(
    'plugins.secrets.delete',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.plugins.secrets.delete',
    'wire.result.plugins.secrets.delete',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    2048,
    1024,
    undefined,
  ),
  op(
    'plugins.secrets.reveal',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.plugins.secrets.reveal',
    'wire.result.plugins.secrets.reveal',
    undefined,
    [
      'INTERNAL',
      'VALIDATION',
      'NOT_FOUND',
      'CONFLICT',
      'CAPABILITY_UNAVAILABLE',
      'CONTRACT_VIOLATION',
      'OUTCOME_UNKNOWN',
    ],
    2048,
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
    'themes.settings.get',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.themes.settings.get',
    'wire.result.themes.settings',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    262144,
    undefined,
  ),
  op(
    'themes.settings.update',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.themes.settings.update',
    'wire.result.themes.settings',
    undefined,
    ['INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    65536,
    262144,
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
    'settings.instructformats.list',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.empty',
    'wire.result.instruct-formats',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    16384,
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
    'diagnostics.cache.clear',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.empty',
    'wire.result.cache-cleanup',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    4096,
    undefined,
  ),
  op(
    'search.query',
    'transactional',
    'idempotent',
    'safe',
    'app.read',
    'wire.request.search.query',
    'wire.result.search',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    4096,
    262144,
    undefined,
  ),
  op(
    'search.rebuild',
    'transactional',
    'idempotent',
    'none',
    'app.write',
    'wire.request.empty',
    'wire.result.search',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'OUTCOME_UNKNOWN'],
    1024,
    2048,
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
    'secrets.lock',
    'transactional',
    'idempotent',
    'safe',
    'app.write',
    'wire.request.empty',
    'wire.result.secrets-lock',
    undefined,
    ['INTERNAL', 'CONTRACT_VIOLATION', 'CAPABILITY_UNAVAILABLE', 'OUTCOME_UNKNOWN'],
    1024,
    1024,
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

const UUID_CHILD_CHAT = 'c2d3e4f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const UUID_CHARACTER = '4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a';
const UUID_CHAT = '7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c';
const UUID_MESSAGE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const UUID_BACKUP = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const UUID_LOREBOOK = '2b3c4d5e-6f7a-4b9c-8d0e-1f2a3b4c5d6e';
const UUID_LOREBOOK_ENTRY = '7e8f9012-3a4b-4c5d-9e0f-1a2b3c4d5e6f';
const UUID_MESSAGE_VARIANT = '8f9a0b1c-2d3e-4f6a-9b0c-1d2e3f4a5b6c';
const UUID_MESSAGE_REVISION = '9a0b1c2d-3e4f-4a7b-8c0d-1e2f3a4b5c6d';
const UUID_MESSAGE_DRAFT = '0b1c2d3e-4f5a-4b8c-9d0e-1f2a3b4c5d6e';
const UUID_BLOCK = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const UUID_PRESET = '3c4d5e6f-7a8b-4c0d-9e1f-2a3b4c5d6e7f';
const UUID_MEMORY = '4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e80';
const UUID_PERSONA = '0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f';
const UUID_WORKFLOW = '9c8b7a6e-5d4c-4b3a-9f8e-7d6c5b4a3f2e';
const UUID_CONFIG = '4d5e6f70-8a9b-4c2d-9e3f-4a5b6c7d8e9f';
const UUID_AVATAR = '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f';
const UUID_GALLERY_ITEM = '5e7f8091-ab2c-4d3e-8f4a-5b6c7d8e9f02';
const UUID_CHARACTER_VERSION = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';
const UUID_ASSET = '6f8091a2-bc3d-4e4f-9a5b-6c7d8e9f0314';
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

const GALLERY_ITEM_VALUE = {
  id: UUID_GALLERY_ITEM,
  characterId: UUID_CHARACTER,
  assetId: UUID_ASSET,
  filename: 'sunset.png',
  createdAt: TIMESTAMP,
  sizeBytes: 5,
  checksumSha256: IMPORT_SHA256,
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

const MESSAGE_BLOCK_VALUE = {
  id: UUID_BLOCK,
  messageId: UUID_MESSAGE,
  pluginId: 'lorebook-searcher',
  blockType: 'meter',
  rendererId: 'blk:meter',
  descriptor: { title: 'Context meter' },
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

/** `backups.restore` response (ТЗ §10.4, М5 slice 39): committed candidate. */
const RESTORE_VALUE = {
  status: 'committed',
};

const ACTIVATION_STATUS_VALUE = {
  layoutVersion: 2,
  activeRootId: 'a1b2c3d4',
  activeRoot: '/data/neotavern/roots/root-a1b2c3d4',
  journalFormat: 'neotavern-activation-journal',
  journalFormatVersion: 2,
  entries: [
    {
      id: '1f2e3d4c-5b6a-4a98-8765-4321fedcba98',
      kind: 'restore',
      status: 'committed',
      fromRoot: '/data/neotavern/roots/root-old',
      toRoot: '/data/neotavern/roots/root-a1b2c3d4',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
  ],
  pending: {
    kind: 'restore',
    entryId: '1f2e3d4c-5b6a-4a98-8765-4321fedcba98',
    createdAt: TIMESTAMP,
  },
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

const PROFILE_IMPORT_REQUEST_VALUE = {
  containerPath: 'imports/profile-import-2c2c/',
  policy: 'reject',
};

const PROFILE_IMPORT_RESULT_VALUE = {
  inserted: 5,
  updated: 0,
  skipped: 1,
  formatVersion: 1,
  appliedAt: TIMESTAMP,
  orphans: ['chat 99999999-9999-4999-8999-999999999999: references missing character'],
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

const UUID_PROVIDER_SECRET = '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b';

const PROVIDER_SECRET_VALUE = {
  id: UUID_PROVIDER_SECRET,
  providerId: UUID_CONFIG,
  label: 'primary',
  active: true,
  masked: '••••••aB9z',
  createdAt: TIMESTAMP,
};

const PROVIDER_CATALOG_VALUE = {
  items: [
    {
      id: 'openai',
      adapterKind: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      apiKeyRequired: true,
      baseUrlEditable: true,
      samplerSupport: [],
    },
    {
      id: 'openai-compatible',
      adapterKind: 'openai-compatible',
      apiKeyRequired: false,
      baseUrlEditable: true,
      samplerSupport: [],
    },
    {
      id: 'fake',
      adapterKind: 'fake',
      apiKeyRequired: false,
      baseUrlEditable: false,
      samplerSupport: [],
    },
  ],
};

const SETTINGS_VALUE = {
  items: [
    { key: 'ui.theme', value: { theme: 'dark' }, updatedAt: TIMESTAMP },
    { key: 'app.language', value: { locale: 'en' }, updatedAt: TIMESTAMP },
  ],
};

const INSTRUCT_FORMATS_VALUE = {
  formats: [
    { id: 'chatml', version: 1, stopStrings: ['<|im_end|>'] },
    { id: 'llama3', version: 1, stopStrings: ['<|eot_id|>'] },
    { id: 'alpaca', version: 1, stopStrings: ['###'] },
    { id: 'mistral', version: 1, stopStrings: ['</s>'] },
    { id: 'command-r', version: 1, stopStrings: ['<|END_OF_TURN_TOKEN|>'] },
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

/** Manifest-merged theme settings values (ТЗ §6.5; cluster 14). */
const THEME_SETTINGS_VALUE = {
  accent: '#7c4dff',
  compact: false,
  density: 'comfortable',
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

/**
 * `wire.prompt.preview` is the plan shape without the run identity: a preview
 * is not a generation run. Derived from the plan fixture so the two can never
 * drift.
 */
const { runId: _previewPlanRunId, ...PROMPT_PREVIEW_VALUE } = PROMPT_PLAN_VALUE;

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
  fx('characters-delete-purge-request', 'characters.delete', 'request', true, {
    characterId: UUID_CHARACTER,
    purge: true,
  }),
  fx('characters-restore-request', 'characters.restore', 'request', true, {
    characterId: UUID_CHARACTER,
  }),
  fx('characters-versions-list-request', 'characters.versions.list', 'request', true, {
    characterId: UUID_CHARACTER,
  }),
  fx('characters-versions-restore-request', 'characters.versions.restore', 'request', true, {
    characterId: UUID_CHARACTER,
    versionId: UUID_CHARACTER_VERSION,
  }),
  fx(
    'neg-characters-versions-restore-missing-version',
    'characters.versions.restore',
    'request',
    false,
    {
      characterId: UUID_CHARACTER,
    },
  ),
  fx('neg-characters-restore-bad-id', 'characters.restore', 'request', false, {
    characterId: 'not-a-uuid',
  }),
  fx('neg-characters-delete-bad-purge', 'characters.delete', 'request', false, {
    characterId: UUID_CHARACTER,
    purge: 'yes',
  }),
  fx('characters-gallery-list-request', 'characters.gallery.list', 'request', true, {
    characterId: UUID_CHARACTER,
    sort: 'oldest',
  }),
  fx('characters-gallery-add-request', 'characters.gallery.add', 'request', true, {
    characterId: UUID_CHARACTER,
    filename: 'sunset.png',
    contentType: 'image/png',
    contentBase64: 'aGVsbG8=',
  }),
  fx('characters-gallery-delete-request', 'characters.gallery.delete', 'request', true, {
    characterId: UUID_CHARACTER,
    imageId: UUID_GALLERY_ITEM,
  }),
  fx('characters-export-card-request', 'characters.export.card', 'request', true, {
    characterId: UUID_CHARACTER,
    format: 'json',
  }),
  fx('characters-export-card-png-request', 'characters.export.card', 'request', true, {
    characterId: UUID_CHARACTER,
    format: 'png',
  }),
  fx('characters-card-get-request', 'characters.card.get', 'request', true, {
    characterId: UUID_CHARACTER,
  }),
  fx('characters-card-get-response', 'characters.card.get', 'response', true, {
    characterId: UUID_CHARACTER,
    card: {
      name: 'Ada Lovelace',
      description: 'First programmer',
      first_mes: '*Ada looks up from her notes.* How may I assist you?',
      creator_notes: 'Analytical engine pioneer.',
      alternate_greetings: ['*Ada smiles.* Good evening.'],
      extensions: { neo_tavern: { imported: true } },
    },
  }),
  fx('characters-card-get-response-empty', 'characters.card.get', 'response', true, {
    characterId: UUID_CHARACTER,
    card: {},
  }),
  fx('characters-card-update-request', 'characters.card.update', 'request', true, {
    characterId: UUID_CHARACTER,
    card: {
      name: 'Ada Lovelace',
      description: 'First programmer',
      first_mes: '*Ada looks up from her notes.* How may I assist you today?',
      creator_notes: 'Analytical engine pioneer.',
      alternate_greetings: ['*Ada smiles.* Good evening.', '*Ada nods.* Welcome back.'],
      extensions: { neo_tavern: { imported: true } },
    },
  }),
  fx('characters-card-update-response', 'characters.card.update', 'response', true, {
    characterId: UUID_CHARACTER,
    card: {
      name: 'Ada Lovelace',
      first_mes: '*Ada looks up from her notes.* How may I assist you today?',
    },
  }),
  fx('neg-characters-card-update-card-not-object', 'characters.card.update', 'request', false, {
    characterId: UUID_CHARACTER,
    card: 'not-an-object',
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
  fx('chats-list-request-manual', 'chats.list', 'request', true, {
    characterId: UUID_CHARACTER,
    sort: 'manual',
    limit: 50,
  }),
  fx('chats-reorder-request', 'chats.reorder', 'request', true, {
    characterId: UUID_CHARACTER,
    order: [UUID_CHAT, '018f0000-0000-4000-8000-00000000c402'],
  }),
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
  // --- message block attachments (M7 cluster 15).
  fx('chats-blocks-list-request', 'chats.blocks.list', 'request', true, {
    chatId: UUID_CHAT,
    messageIds: [UUID_MESSAGE],
  }),
  fx('chats-blocks-attach-request', 'chats.blocks.attach', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    blockType: 'meter',
    rendererId: 'blk:meter',
    pluginId: 'lorebook-searcher',
    descriptor: { title: 'Context meter' },
  }),
  fx('blocks-update-request', 'blocks.update', 'request', true, {
    blockId: UUID_BLOCK,
    serializedState: { count: 9 },
  }),
  fx('blocks-update-clear-request', 'blocks.update', 'request', true, {
    blockId: UUID_BLOCK,
    clearSerializedState: true,
  }),
  fx('blocks-delete-request', 'blocks.delete', 'request', true, { blockId: UUID_BLOCK }),
  fx('chats-snapshots-create-request', 'chats.snapshots.create', 'request', true, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    kind: 'checkpoint',
  }),
  fx('chats-snapshots-create-response', 'chats.snapshots.create', 'response', true, {
    chat: CHAT_VALUE,
    copiedMessages: 2,
  }),
  fx('chats-snapshots-rollback-request', 'chats.snapshots.rollback', 'request', true, {
    chatId: UUID_CHAT,
    toMessageId: UUID_MESSAGE,
  }),
  fx('chats-snapshots-rollback-response', 'chats.snapshots.rollback', 'response', true, {
    deleted: 3,
    checkpointChatId: UUID_CHILD_CHAT,
  }),
  fx('neg-chats-snapshots-rollback-missing-field', 'chats.snapshots.rollback', 'request', false, {
    chatId: UUID_CHAT,
  }),
  fx('chats-snapshots-list-request', 'chats.snapshots.list', 'request', true, {
    chatId: UUID_CHAT,
  }),
  fx('chats-snapshots-list-response', 'chats.snapshots.list', 'response', true, {
    items: [
      {
        id: UUID_CHILD_CHAT,
        title: 'Chat — checkpoint',
        characterId: UUID_CHARACTER,
        messageCount: 2,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        parentChatId: UUID_CHAT,
        origin: 'checkpoint',
        sourceMessageId: UUID_MESSAGE,
      },
    ],
  }),
  fx('neg-chats-snapshots-list-missing-field', 'chats.snapshots.list', 'request', false, {}),
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
  fx('events-poll-request', 'events.poll', 'request', true, {
    afterSequence: 17,
    limit: 50,
  }),
  fx('events-poll-request-from-start', 'events.poll', 'request', true, {}),
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
  fx('backups-restore-request', 'backups.restore', 'request', true, { backupId: UUID_BACKUP }),
  fx('backups-delete-request', 'backups.delete', 'request', true, { backupId: UUID_BACKUP }),
  fx('data-activation-status-request', 'data.activation.status', 'request', true, {}),
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
  fx('profile-import-request', 'profile.import', 'request', true, PROFILE_IMPORT_REQUEST_VALUE),
  fx('profile-import-request-remap', 'profile.import', 'request', true, {
    containerPath: 'imports/profile-import-2c2c/',
    policy: 'remap',
  }),
  fx('assets-list-request', 'assets.list', 'request', true, {
    kind: 'background',
    limit: 50,
  }),
  fx('assets-put-request', 'assets.put', 'request', true, ASSETS_PUT_REQUEST),
  fx('assets-upload-begin-request', 'assets.upload.begin', 'request', true, {
    kind: 'background',
    filename: 'wallpaper.png',
    contentType: 'image/png',
    totalBytes: 3145728,
  }),
  fx('assets-upload-append-request', 'assets.upload.append', 'request', true, {
    uploadId: UUID_AVATAR,
    index: 0,
    contentBase64: 'aGVsbG8=',
  }),
  fx('assets-upload-finish-request', 'assets.upload.finish', 'request', true, {
    uploadId: UUID_AVATAR,
  }),
  fx('assets-upload-abort-request', 'assets.upload.abort', 'request', true, {
    uploadId: UUID_AVATAR,
  }),
  fx('assets-get-request', 'assets.get', 'request', true, { assetId: UUID_AVATAR }),
  fx('assets-content-request', 'assets.content', 'request', true, { assetId: UUID_AVATAR }),
  fx('assets-thumb-request', 'assets.thumb', 'request', true, {
    assetId: UUID_AVATAR,
    maxPx: 192,
  }),
  fx('assets-delete-request', 'assets.delete', 'request', true, { assetId: UUID_AVATAR }),
  fx('plugins-list-request', 'plugins.list', 'request', true, {}),
  fx('plugins-install-request', 'plugins.install', 'request', true, PLUGIN_INSTALL_REQUEST),
  fx('plugins-uninstall-request', 'plugins.uninstall', 'request', true, {
    id: 'lorebook-searcher',
  }),
  fx('plugins-enable-request', 'plugins.enable', 'request', true, { id: 'lorebook-searcher' }),
  fx('plugins-disable-request', 'plugins.disable', 'request', true, { id: 'lorebook-searcher' }),
  fx('plugins-state-get-request', 'plugins.state.get', 'request', true, {
    pluginId: 'lorebook-searcher',
    scope: 'installation',
  }),
  fx('plugins-state-get-chat-request', 'plugins.state.get', 'request', true, {
    pluginId: 'lorebook-searcher',
    scope: 'chat',
    ownerId: 'chat-42',
  }),
  fx('plugins-state-set-request', 'plugins.state.set', 'request', true, {
    pluginId: 'lorebook-searcher',
    scope: 'user',
    data: { lastQuery: 'dragons', createdAt: 1767225600000 },
    expectedRevision: 3,
  }),
  fx('plugins-state-delete-request', 'plugins.state.delete', 'request', true, {
    pluginId: 'lorebook-searcher',
    scope: 'workspace',
  }),
  fx('plugins-blobs-begin-request', 'plugins.blobs.begin', 'request', true, {
    pluginId: 'lorebook-searcher',
    name: 'index.bin',
    contentType: 'application/octet-stream',
    totalBytes: 1024,
  }),
  fx('plugins-blobs-append-request', 'plugins.blobs.append', 'request', true, {
    pluginId: 'lorebook-searcher',
    uploadId: UUID_AVATAR,
    index: 0,
    contentBase64: 'aGVsbG8=',
  }),
  fx('plugins-blobs-finish-request', 'plugins.blobs.finish', 'request', true, {
    pluginId: 'lorebook-searcher',
    uploadId: UUID_AVATAR,
  }),
  fx('plugins-blobs-list-request', 'plugins.blobs.list', 'request', true, {
    pluginId: 'lorebook-searcher',
  }),
  fx('plugins-blobs-read-request', 'plugins.blobs.read', 'request', true, {
    pluginId: 'lorebook-searcher',
    blobId: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    offset: 0,
    length: 1024,
  }),
  fx('plugins-blobs-delete-request', 'plugins.blobs.delete', 'request', true, {
    pluginId: 'lorebook-searcher',
    blobId: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  }),
  fx('themes-list-request', 'themes.list', 'request', true, {}),
  fx('themes-install-request', 'themes.install', 'request', true, THEME_INSTALL_REQUEST),
  fx('themes-uninstall-request', 'themes.uninstall', 'request', true, { id: 'wii-u-dark' }),
  fx('themes-activate-request', 'themes.activate', 'request', true, { id: 'wii-u-dark' }),
  fx('themes-deactivate-request', 'themes.deactivate', 'request', true, {}),
  fx('themes-settings-get-request', 'themes.settings.get', 'request', true, { id: 'wii-u-dark' }),
  fx('themes-settings-update-request', 'themes.settings.update', 'request', true, {
    id: 'wii-u-dark',
    values: { accent: '#00c853' },
  }),
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
  fx('settings-instruct-formats-request', 'settings.instructformats.list', 'request', true, {}),
  fx('diagnostics-export-request', 'diagnostics.export', 'request', true, {}),
  fx('diagnostics-cache-clear-request', 'diagnostics.cache.clear', 'request', true, {}),
  fx('search-query-request', 'search.query', 'request', true, {
    q: 'forest guardian',
    scope: 'characters',
    sort: 'relevance',
    limit: 50,
  }),
  fx('search-rebuild-request', 'search.rebuild', 'request', true, {}),
  fx('secrets-status-request', 'secrets.status', 'request', true, {}),
  fx('providers-catalog-request', 'providers.catalog', 'request', true, {}),
  fx('providers-secrets-list-request', 'providers.secrets.list', 'request', true, {
    providerId: UUID_CONFIG,
  }),
  fx('providers-secrets-create-request', 'providers.secrets.create', 'request', true, {
    providerId: UUID_CONFIG,
    value: 'sk-fixture-second-key',
    label: 'backup',
  }),
  fx('providers-secrets-update-request', 'providers.secrets.update', 'request', true, {
    providerId: UUID_CONFIG,
    secretId: UUID_PROVIDER_SECRET,
    label: 'renamed',
    active: true,
  }),
  fx('providers-secrets-delete-request', 'providers.secrets.delete', 'request', true, {
    providerId: UUID_CONFIG,
    secretId: UUID_PROVIDER_SECRET,
  }),
  fx('providers-secrets-reveal-request', 'providers.secrets.reveal', 'request', true, {
    providerId: UUID_CONFIG,
    secretId: UUID_PROVIDER_SECRET,
  }),
  fx('secrets-exposure-request', 'secrets.exposure', 'request', true, {}),
  fx('provider-transcribe-request', 'providers.transcribe', 'request', true, {
    providerId: UUID_AVATAR,
    audioAssetId: UUID_PRESET,
    language: 'en',
  }),
  fx('providers-models-request', 'providers.models', 'request', true, {
    providerId: UUID_CONFIG,
  }),
  fx('providers-test-request', 'providers.test', 'request', true, {
    providerId: UUID_CONFIG,
    message: 'ping',
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
  fx('characters-restore-response', 'characters.restore', 'response', true, CHARACTER_VALUE),
  fx('characters-versions-list-response', 'characters.versions.list', 'response', true, {
    items: [
      {
        id: UUID_CHARACTER_VERSION,
        characterId: UUID_CHARACTER,
        version: 2,
        createdAt: '2026-08-13T00:00:00Z',
      },
    ],
    truncated: false,
  }),
  fx(
    'characters-versions-restore-response',
    'characters.versions.restore',
    'response',
    true,
    CHARACTER_VALUE,
  ),
  fx('neg-characters-versions-list-truncated-flag', 'characters.versions.list', 'response', false, {
    items: [],
    truncated: 'no',
  }),
  fx('characters-gallery-list-response', 'characters.gallery.list', 'response', true, {
    items: [GALLERY_ITEM_VALUE],
  }),
  fx('characters-gallery-add-response', 'characters.gallery.add', 'response', true, {
    item: GALLERY_ITEM_VALUE,
    deduplicated: false,
  }),
  fx('characters-gallery-delete-response', 'characters.gallery.delete', 'response', true, {
    deleted: true,
  }),
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
  fx('chats-reorder-response', 'chats.reorder', 'response', true, { reordered: 2 }),
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
  fx('chats-blocks-list-response', 'chats.blocks.list', 'response', true, {
    items: [MESSAGE_BLOCK_VALUE],
  }),
  fx('chats-blocks-list-empty-response', 'chats.blocks.list', 'response', true, { items: [] }),
  fx('chats-blocks-attach-response', 'chats.blocks.attach', 'response', true, MESSAGE_BLOCK_VALUE),
  fx('blocks-update-response', 'blocks.update', 'response', true, {
    ...MESSAGE_BLOCK_VALUE,
    serializedState: { count: 9 },
  }),
  fx('blocks-delete-response', 'blocks.delete', 'response', true, {}),
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
  fx('message-draft-list-request', 'chats.messages.drafts.list', 'request', true, {
    chatId: UUID_CHAT,
  }),
  fx('message-draft-list-response', 'chats.messages.drafts.list', 'response', true, {
    items: [MESSAGE_DRAFT_VALUE],
  }),
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
  fx('neg-message-draft-list-bad-chat', 'chats.messages.drafts.list', 'request', false, {
    chatId: 42,
  }),
  fx('generation-cancel-response', 'generation.cancel', 'response', true, {}),
  fx('generation-get-response', 'generation.get', 'response', true, GENERATION_RUN_VALUE),
  fx('generation-events-response', 'generation.events', 'response', true, {
    items: [GENERATION_EVENT_ENVELOPE_VALUE],
    hasMore: false,
  }),
  fx('events-poll-response', 'events.poll', 'response', true, {
    items: [
      {
        sequence: 18,
        event: 'chat.message.created',
        payload: { chatId: UUID_CHAT, messageId: UUID_MESSAGE },
        createdAt: TIMESTAMP,
      },
      {
        sequence: 19,
        event: 'plugin.activated',
        payload: { pluginId: 'clockwork' },
        createdAt: TIMESTAMP,
      },
    ],
    hasMore: false,
    truncated: false,
  }),
  fx('neg-events-poll-response-missing-truncated', 'events.poll', 'response', false, {
    items: [],
    hasMore: false,
  }),
  fx('neg-events-poll-response-unknown-field', 'events.poll', 'response', false, {
    items: [],
    hasMore: false,
    truncated: false,
    nextPageToken: 'nope',
  }),
  fx('neg-events-poll-negative-cursor', 'events.poll', 'request', false, {
    afterSequence: -5,
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
  fx('chats-context-audit-request', 'chats.context.audit', 'request', true, {
    chatId: UUID_CHAT,
  }),
  fx('chats-context-audit-response', 'chats.context.audit', 'response', true, {
    plan: PROMPT_PLAN_VALUE,
  }),
  fx('chats-context-audit-response-empty', 'chats.context.audit', 'response', true, {}),
  fx('chats-prompt-preview-request', 'chats.prompt.preview', 'request', true, {
    chatId: UUID_CHAT,
    userMessage: 'Hello there',
  }),
  fx('chats-prompt-preview-request-empty-message', 'chats.prompt.preview', 'request', true, {
    chatId: UUID_CHAT,
    userMessage: '',
  }),
  fx('chats-prompt-preview-response', 'chats.prompt.preview', 'response', true, {
    plan: PROMPT_PREVIEW_VALUE,
  }),
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
  fx('backups-restore-response', 'backups.restore', 'response', true, RESTORE_VALUE),
  fx('backups-delete-response', 'backups.delete', 'response', true, { deleted: true }),
  fx('data-activation-status-response', 'data.activation.status', 'response', true, {
    ...ACTIVATION_STATUS_VALUE,
    pending: undefined,
  }),
  fx(
    'data-activation-status-response-pending',
    'data.activation.status',
    'response',
    true,
    ACTIVATION_STATUS_VALUE,
  ),
  fx('profile-export-response', 'profile.export', 'response', true, PROFILE_EXPORT_VALUE),
  fx(
    'profile-export-response-scoped',
    'profile.export',
    'response',
    true,
    PROFILE_EXPORT_SCOPED_VALUE,
  ),
  fx('assets-list-response', 'assets.list', 'response', true, {
    items: [ASSET_VALUE],
    nextCursor: 'MjAyNi0wNi0wMVQxMjowMDowMC4wMDBafGFzc2V0LTE=',
  }),
  fx('neg-assets-list-bad-kind', 'assets.list', 'request', false, {
    kind: 'Background',
  }),
  fx('assets-put-response', 'assets.put', 'response', true, ASSETS_PUT_VALUE),
  fx('assets-upload-begin-response', 'assets.upload.begin', 'response', true, {
    uploadId: UUID_AVATAR,
    chunkSizeBytes: 524288,
    expiresAt: '2026-06-01T12:00:00.000Z',
  }),
  fx('assets-upload-append-response', 'assets.upload.append', 'response', true, {
    uploadId: UUID_AVATAR,
    receivedBytes: 5,
    nextIndex: 1,
  }),
  fx('assets-upload-finish-response', 'assets.upload.finish', 'response', true, ASSETS_PUT_VALUE),
  fx('assets-upload-abort-response', 'assets.upload.abort', 'response', true, {
    deleted: true,
  }),
  fx('neg-assets-upload-append-bad-index', 'assets.upload.append', 'request', false, {
    uploadId: UUID_AVATAR,
    index: -1,
    contentBase64: 'aGVsbG8=',
  }),
  fx('assets-get-response', 'assets.get', 'response', true, { asset: ASSET_VALUE }),
  fx('assets-content-response', 'assets.content', 'response', true, ASSETS_CONTENT_VALUE),
  fx('assets-thumb-response', 'assets.thumb', 'response', true, {
    assetId: UUID_AVATAR,
    format: 'jpeg',
    width: 192,
    height: 192,
    contentBase64: 'aGVsbG8=',
  }),
  fx('assets-delete-response', 'assets.delete', 'response', true, {}),
  fx('profile-import-response', 'profile.import', 'response', true, PROFILE_IMPORT_RESULT_VALUE),
  fx('neg-profile-import-bad-policy', 'profile.import', 'request', false, {
    containerPath: 'imports/profile-import-2c2c/',
    policy: 'upsert',
  }),
  fx('imports-character-card-request', 'imports.character.card', 'request', true, {
    assetId: UUID_AVATAR,
  }),

  fx('imports-fullbackup-analyze-request', 'imports.fullbackup.analyze', 'request', true, {
    assetId: UUID_AVATAR,
  }),
  fx('imports-fullbackup-analyze-response', 'imports.fullbackup.analyze', 'response', true, {
    sourceHash: IMPORT_SHA256,
    totalCompressedBytes: 4096,
    totalExpandedBytes: 65536,
    categories: [
      { id: 'characters', discovered: 3, dependentRecords: 0, invalid: 0, sizeBytes: 2048 },
      { id: 'chats', discovered: 2, dependentRecords: 41, invalid: 1, sizeBytes: 16384 },
      { id: 'personas', discovered: 1, dependentRecords: 0, invalid: 0, sizeBytes: 512 },
      { id: 'lorebooks', discovered: 1, dependentRecords: 12, invalid: 0, sizeBytes: 8192 },
      { id: 'presets', discovered: 0, dependentRecords: 0, invalid: 0, sizeBytes: 0 },
      { id: 'groups', discovered: 1, dependentRecords: 7, invalid: 0, sizeBytes: 1024 },
      { id: 'backgrounds', discovered: 2, dependentRecords: 0, invalid: 0, sizeBytes: 32768 },
      { id: 'extensionSettings', discovered: 4, dependentRecords: 0, invalid: 0, sizeBytes: 256 },
      { id: 'apiSettings', discovered: 1, dependentRecords: 0, invalid: 0, sizeBytes: 128 },
      { id: 'legacyExtensions', discovered: 1, dependentRecords: 0, invalid: 0, sizeBytes: 4096 },
      { id: 'themes', discovered: 2, dependentRecords: 0, invalid: 0, sizeBytes: 2048 },
    ],
    warningCount: 2,
    warnings: [
      { code: 'SECRETS_SKIPPED', path: 'backup/default-user/secrets.json' },
      { code: 'LEGACY_EXTENSIONS_SKIPPED', path: 'backup/default-user/extensions' },
    ],
  }),
  fx('neg-imports-fullbackup-missing-asset', 'imports.fullbackup.analyze', 'request', false, {}),
  fx('neg-imports-fullbackup-bad-category', 'imports.fullbackup.analyze', 'response', false, {
    sourceHash: IMPORT_SHA256,
    totalCompressedBytes: 4096,
    totalExpandedBytes: 65536,
    categories: [
      { id: 'silverware', discovered: 1, dependentRecords: 0, invalid: 0, sizeBytes: 1 },
    ],
    warningCount: 0,
    warnings: [],
  }),
  fx(
    'neg-imports-fullbackup-short-category-list',
    'imports.fullbackup.analyze',
    'response',
    false,
    {
      sourceHash: IMPORT_SHA256,
      totalCompressedBytes: 4096,
      totalExpandedBytes: 65536,
      categories: [
        { id: 'characters', discovered: 1, dependentRecords: 0, invalid: 0, sizeBytes: 1 },
      ],
      warningCount: 0,
      warnings: [],
    },
  ),
  fx('imports-fullbackup-execute-request', 'imports.fullbackup.execute', 'request', true, {
    assetId: UUID_AVATAR,
    categories: ['characters', 'chats', 'lorebooks'],
    conflictPolicy: 'skip',
  }),
  fx('imports-fullbackup-execute-response', 'imports.fullbackup.execute', 'response', true, {
    runId: UUID_AVATAR,
    sourceHash: IMPORT_SHA256,
    conflictPolicy: 'skip',
    archiveAlreadyImported: false,
    categories: [
      {
        id: 'characters',
        imported: 3,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      {
        id: 'chats',
        imported: 2,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 1,
        dependentImported: 41,
      },
      {
        id: 'personas',
        imported: 1,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      {
        id: 'lorebooks',
        imported: 1,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 12,
      },
      {
        id: 'presets',
        imported: 0,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      {
        id: 'groups',
        imported: 1,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      {
        id: 'backgrounds',
        imported: 2,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      {
        id: 'extensionSettings',
        imported: 4,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      {
        id: 'apiSettings',
        imported: 1,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      {
        id: 'legacyExtensions',
        imported: 0,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
      {
        id: 'themes',
        imported: 2,
        reused: 0,
        skipped: 0,
        conflicted: 0,
        invalid: 0,
        dependentImported: 0,
      },
    ],
    totals: { imported: 17, reused: 0, skipped: 0, conflicted: 0, invalid: 1 },
    warningCount: 2,
    warnings: [
      { code: 'SECRETS_SKIPPED', path: 'backup/default-user/secrets.json' },
      { code: 'GROUPS_PRESERVED_NOT_MODELED', path: 'backup/default-user/groups' },
    ],
  }),
  fx(
    'neg-imports-fullbackup-execute-missing-policy',
    'imports.fullbackup.execute',
    'request',
    false,
    {
      assetId: UUID_AVATAR,
    },
  ),
  fx('neg-imports-fullbackup-execute-bad-policy', 'imports.fullbackup.execute', 'request', false, {
    assetId: UUID_AVATAR,
    conflictPolicy: 'overwrite',
  }),
  fx(
    'neg-imports-fullbackup-execute-short-category-list',
    'imports.fullbackup.execute',
    'response',
    false,
    {
      runId: UUID_AVATAR,
      sourceHash: IMPORT_SHA256,
      conflictPolicy: 'merge',
      archiveAlreadyImported: true,
      categories: [
        {
          id: 'characters',
          imported: 0,
          reused: 1,
          skipped: 0,
          conflicted: 0,
          invalid: 0,
          dependentImported: 0,
        },
      ],
      totals: { imported: 0, reused: 1, skipped: 0, conflicted: 0, invalid: 0 },
      warningCount: 0,
      warnings: [],
    },
  ),
  fx(
    'neg-imports-fullbackup-execute-negative-count',
    'imports.fullbackup.execute',
    'response',
    false,
    {
      runId: UUID_AVATAR,
      sourceHash: IMPORT_SHA256,
      conflictPolicy: 'replace',
      archiveAlreadyImported: false,
      categories: [
        {
          id: 'characters',
          imported: -1,
          reused: 0,
          skipped: 0,
          conflicted: 0,
          invalid: 0,
          dependentImported: 0,
        },
      ],
      totals: { imported: 0, reused: 0, skipped: 0, conflicted: 0, invalid: 0 },
      warningCount: 0,
      warnings: [],
    },
  ),
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
  fx('plugins-state-get-response', 'plugins.state.get', 'response', true, {
    pluginId: 'lorebook-searcher',
    scope: 'installation',
    ownerId: '',
    revision: 3,
    schemaVersion: 1,
    data: { lastQuery: 'dragons', createdAt: 1767225600000 },
    updatedAt: '2026-08-13T10:00:00.000Z',
  }),
  fx('plugins-state-set-response', 'plugins.state.set', 'response', true, {
    revision: 4,
    updatedAt: '2026-08-13T10:05:00.000Z',
  }),
  fx('plugins-state-delete-response', 'plugins.state.delete', 'response', true, {
    deleted: true,
  }),
  fx('plugins-blobs-begin-response', 'plugins.blobs.begin', 'response', true, {
    uploadId: UUID_AVATAR,
    chunkSizeBytes: 524288,
    expiresAt: '2026-11-04T00:00:00Z',
  }),
  fx('plugins-blobs-append-response', 'plugins.blobs.append', 'response', true, {
    uploadId: UUID_AVATAR,
    receivedBytes: 5,
    nextIndex: 1,
  }),
  fx('plugins-blobs-finish-response', 'plugins.blobs.finish', 'response', true, {
    blobId: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    name: 'index.bin',
    contentType: 'application/octet-stream',
    sizeBytes: 5,
    createdAt: '2026-11-04T00:00:00Z',
  }),
  fx('plugins-blobs-list-response', 'plugins.blobs.list', 'response', true, {
    items: [
      {
        blobId: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        name: 'index.bin',
        contentType: 'application/octet-stream',
        sizeBytes: 5,
        createdAt: '2026-11-04T00:00:00Z',
      },
    ],
  }),
  fx('plugins-blobs-read-response', 'plugins.blobs.read', 'response', true, {
    blobId: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    contentType: 'application/octet-stream',
    sizeBytes: 5,
    offset: 0,
    dataBase64: 'aGVsbG8=',
    eof: true,
  }),
  fx('plugins-blobs-delete-response', 'plugins.blobs.delete', 'response', true, {
    deleted: true,
  }),
  fx('plugins-secrets-list-request', 'plugins.secrets.list', 'request', true, {
    pluginId: 'lorebook-searcher',
    scope: 'user',
  }),
  fx('plugins-secrets-set-request', 'plugins.secrets.set', 'request', true, {
    pluginId: 'lorebook-searcher',
    scope: 'chat',
    ownerId: 'chat-42',
    key: 'apiKey',
    value: 'sk-live-123456',
  }),
  fx('plugins-secrets-delete-request', 'plugins.secrets.delete', 'request', true, {
    pluginId: 'lorebook-searcher',
    scope: 'user',
    key: 'apiKey',
  }),
  // Masked projections are ASCII in the fixtures ("********1234"): the kernel
  // derives the real hint from the opaque store reference (bullets plus the
  // last visible characters), but a corpus fixture only has to be a valid
  // `wire.plugin-secret` value.
  fx('plugins-secrets-list-response', 'plugins.secrets.list', 'response', true, {
    items: [
      {
        key: 'apiKey',
        scope: 'user',
        masked: '********1234',
        createdAt: '2026-06-01T12:00:00.000Z',
        updatedAt: '2026-06-01T12:00:00.000Z',
      },
    ],
  }),
  fx('plugins-secrets-set-response', 'plugins.secrets.set', 'response', true, {
    key: 'apiKey',
    scope: 'chat',
    masked: '********3456',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:05:00.000Z',
  }),
  fx('plugins-secrets-delete-response', 'plugins.secrets.delete', 'response', true, {
    deleted: true,
  }),
  fx('plugins-secrets-reveal-response', 'plugins.secrets.reveal', 'response', true, {
    value: 'sk-live-123456',
  }),
  fx('plugins-secrets-reveal-request', 'plugins.secrets.reveal', 'request', true, {
    pluginId: 'lorebook-searcher',
    scope: 'user',
    key: 'apiKey',
  }),
  fx('neg-plugins-secrets-set-empty-key', 'plugins.secrets.set', 'request', false, {
    pluginId: 'lorebook-searcher',
    scope: 'user',
    key: '',
    value: 'sk-live-123456',
  }),
  fx('neg-plugins-state-get-unknown-scope', 'plugins.state.get', 'request', false, {
    pluginId: 'lorebook-searcher',
    scope: 'global',
  }),
  fx('neg-plugins-state-get-bad-plugin-id', 'plugins.state.get', 'request', false, {
    pluginId: 'Lorebook Searcher',
    scope: 'user',
  }),
  fx('neg-provider-transcribe-bad-asset', 'providers.transcribe', 'request', false, {
    providerId: UUID_AVATAR,
    audioAssetId: 'not-a-uuid',
  }),
  fx('neg-provider-transcribe-empty-model', 'providers.transcribe', 'response', false, {
    text: 'hello from the audio',
    model: '',
  }),
  fx('neg-plugins-blobs-begin-bad-plugin-id', 'plugins.blobs.begin', 'request', false, {
    pluginId: 'Lorebook Searcher',
    name: 'index.bin',
    contentType: 'application/octet-stream',
    totalBytes: 1024,
  }),
  fx('neg-plugins-blobs-begin-over-cap', 'plugins.blobs.begin', 'request', false, {
    pluginId: 'lorebook-searcher',
    name: 'huge.bin',
    contentType: 'application/octet-stream',
    totalBytes: 8388609,
  }),
  fx('neg-plugins-blobs-append-bad-chunk', 'plugins.blobs.append', 'request', false, {
    pluginId: 'lorebook-searcher',
    uploadId: UUID_AVATAR,
    index: 0,
    contentBase64: 'not base64!',
  }),
  fx('neg-plugins-blobs-read-bad-blob-id', 'plugins.blobs.read', 'request', false, {
    pluginId: 'lorebook-searcher',
    blobId: 'index.bin',
    offset: 0,
    length: 1024,
  }),
  fx('neg-plugins-blobs-read-over-chunk', 'plugins.blobs.read', 'request', false, {
    pluginId: 'lorebook-searcher',
    blobId: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    offset: 0,
    length: 262145,
  }),
  fx('neg-plugins-blobs-finish-missing-upload', 'plugins.blobs.finish', 'response', false, {
    blobId: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  }),
  fx('themes-list-response', 'themes.list', 'response', true, { items: [THEME_VALUE] }),
  fx('themes-install-response', 'themes.install', 'response', true, { theme: THEME_VALUE }),
  fx('themes-uninstall-response', 'themes.uninstall', 'response', true, {}),
  fx('themes-activate-response', 'themes.activate', 'response', true, {
    ...THEME_VALUE,
    active: true,
  }),
  fx('themes-settings-get-response', 'themes.settings.get', 'response', true, {
    values: THEME_SETTINGS_VALUE,
  }),
  fx('themes-settings-update-response', 'themes.settings.update', 'response', true, {
    values: { ...THEME_SETTINGS_VALUE, accent: '#00c853' },
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
  fx(
    'settings-instruct-formats-response',
    'settings.instructformats.list',
    'response',
    true,
    INSTRUCT_FORMATS_VALUE,
  ),
  fx('diagnostics-export-response', 'diagnostics.export', 'response', true, DIAGNOSTICS_VALUE),
  fx('diagnostics-cache-clear-response', 'diagnostics.cache.clear', 'response', true, {
    removedFiles: 12,
    removedBytes: 524288,
    metadataRowsRemoved: 0,
  }),
  fx('search-query-response', 'search.query', 'response', true, {
    query: 'forest guardian',
    items: [
      {
        scope: 'characters',
        id: UUID_CHARACTER,
        title: 'Seraphina',
        snippet: 'Forest guardian of the woodland cottage…',
        score: 1.25,
        timestamp: 1780315200000,
      },
    ],
  }),
  fx('search-rebuild-response', 'search.rebuild', 'response', true, { query: '', items: [] }),
  fx('secrets-status-response', 'secrets.status', 'response', true, SECRETS_STATUS_VALUE),
  fx('secrets-lock-request', 'secrets.lock', 'request', true, {}),
  fx('secrets-lock-response', 'secrets.lock', 'response', true, { locked: true }),
  fx('providers-catalog-response', 'providers.catalog', 'response', true, PROVIDER_CATALOG_VALUE),
  fx('providers-secrets-list-response', 'providers.secrets.list', 'response', true, {
    items: [PROVIDER_SECRET_VALUE],
  }),
  fx('providers-secrets-created-response', 'providers.secrets.create', 'response', true, {
    id: UUID_PROVIDER_SECRET,
  }),
  fx(
    'providers-secrets-update-response',
    'providers.secrets.update',
    'response',
    true,
    PROVIDER_SECRET_VALUE,
  ),
  fx('providers-secrets-delete-response', 'providers.secrets.delete', 'response', true, {}),
  fx('providers-secrets-reveal-response', 'providers.secrets.reveal', 'response', true, {
    value: 'sk-fixture-revealed',
  }),
  fx('secrets-exposure-response', 'secrets.exposure', 'response', true, {
    allowSecretsExposure: false,
  }),
  fx('provider-transcribe-response', 'providers.transcribe', 'response', true, {
    text: 'hello from the audio',
    model: 'fake-1',
    language: 'en',
    durationMs: 1200,
  }),
  fx('providers-models-response', 'providers.models', 'response', true, {
    models: [
      { id: 'fake-1', name: 'Fake 1', contextLimit: 8192 },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
    ],
  }),
  fx('providers-test-response', 'providers.test', 'response', true, {
    text: 'pong',
    usage: { steps: 1, outputChars: 4 },
  }),

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
  fx('neg-diagnostics-cache-clear-negative-bytes', 'diagnostics.cache.clear', 'response', false, {
    removedFiles: 1,
    removedBytes: -1,
    metadataRowsRemoved: 0,
  }),
  fx('neg-diagnostics-export-bad-redaction', 'diagnostics.export', 'response', false, {
    ...DIAGNOSTICS_VALUE,
    redaction: 'everything',
  }),
  fx('neg-secrets-status-empty-kind', 'secrets.status', 'response', false, {
    ...SECRETS_STATUS_VALUE,
    kind: '',
  }),
  fx('neg-search-query-empty-q', 'search.query', 'request', false, { q: '' }),
  fx('neg-search-query-bad-sort', 'search.query', 'request', false, { q: 'x', sort: 'random' }),
  fx('neg-search-response-bad-scope', 'search.query', 'response', false, {
    query: 'x',
    items: [
      {
        scope: 'plugins',
        id: 'hit-1',
        title: 't',
        snippet: 's',
        score: 1,
        timestamp: 1,
      },
    ],
  }),
  fx('neg-providers-secrets-create-empty-value', 'providers.secrets.create', 'request', false, {
    providerId: UUID_CONFIG,
    value: '',
  }),
  fx('neg-providers-catalog-bad-entry', 'providers.catalog', 'response', false, {
    items: [
      {
        id: 'openai',
        adapterKind: 'openai',
        apiKeyRequired: 'yes',
        baseUrlEditable: true,
        samplerSupport: [],
      },
    ],
  }),
  fx('neg-secrets-exposure-missing-flag', 'secrets.exposure', 'response', false, {}),
  fx('neg-providers-models-unknown-field', 'providers.models', 'request', false, {
    providerId: UUID_CONFIG,
    refresh: true,
  }),
  fx('neg-providers-test-empty-message', 'providers.test', 'request', false, {
    providerId: UUID_CONFIG,
    message: '',
  }),
  fx('neg-providers-models-bad-usage', 'providers.test', 'response', false, {
    text: 'pong',
    usage: { steps: -1, outputChars: 4 },
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
  fx(
    'neg-characters-export-card-response-missing-base64',
    'characters.export.card',
    'response',
    false,
    {
      filename: 'ada.json',
      contentType: 'application/json',
      warnings: [],
    },
  ),
  fx('neg-chats-export-missing-field', 'chats.export', 'request', false, {}),
  fx('neg-chats-reorder-missing-field', 'chats.reorder', 'request', false, {
    characterId: UUID_CHARACTER,
  }),
  fx('neg-chats-list-bad-sort', 'chats.list', 'request', false, { sort: 'newest' }),
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
  fx('neg-chats-context-audit-wrong-plan-type', 'chats.context.audit', 'response', false, {
    plan: 42,
  }),
  fx('neg-chats-prompt-preview-bad-chat-id', 'chats.prompt.preview', 'request', false, {
    chatId: 'not-a-uuid',
    userMessage: 'hello',
  }),
  fx('neg-chats-prompt-preview-extra-field', 'chats.prompt.preview', 'request', false, {
    chatId: UUID_CHAT,
    userMessage: 'hello',
    persist: true,
  }),
  // A preview must never masquerade as a run: the run identity is not part
  // of `wire.prompt.preview`.
  fx('neg-chats-prompt-preview-response-with-run-id', 'chats.prompt.preview', 'response', false, {
    plan: PROMPT_PLAN_VALUE,
  }),
  fx(
    'neg-chats-prompt-preview-response-missing-messages',
    'chats.prompt.preview',
    'response',
    false,
    { plan: { ...PROMPT_PREVIEW_VALUE, messages: undefined } },
  ),
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
  fx('neg-blocks-list-empty-ids', 'chats.blocks.list', 'request', false, {
    chatId: UUID_CHAT,
    messageIds: [],
  }),
  fx('neg-blocks-attach-bad-descriptor', 'chats.blocks.attach', 'request', false, {
    chatId: UUID_CHAT,
    messageId: UUID_MESSAGE,
    blockType: 'meter',
    rendererId: 'blk:meter',
    pluginId: 'lorebook-searcher',
    descriptor: 'not-an-object',
  }),
  fx('neg-blocks-update-bad-clear', 'blocks.update', 'request', false, {
    blockId: UUID_BLOCK,
    clearSerializedState: 'yes',
  }),
  fx('neg-block-response-bad-timestamp', 'chats.blocks.list', 'response', false, {
    items: [{ ...MESSAGE_BLOCK_VALUE, createdAt: 1 }],
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
  fx('neg-backup-delete-bad-result', 'backups.delete', 'response', false, {
    deleted: 'yes',
  }),
  fx('neg-backup-delete-bad-request', 'backups.delete', 'request', false, {
    backupId: 'not-a-uuid',
  }),
  fx('neg-gallery-item-bad-checksum', 'characters.gallery.list', 'response', false, {
    items: [{ ...GALLERY_ITEM_VALUE, checksumSha256: 'xyz' }],
  }),
  fx('neg-gallery-add-bad-base64', 'characters.gallery.add', 'request', false, {
    characterId: UUID_CHARACTER,
    filename: 'img.png',
    contentBase64: 'not base64!!',
  }),
  fx('neg-gallery-delete-bad-request', 'characters.gallery.delete', 'request', false, {
    characterId: UUID_CHARACTER,
  }),
  fx('neg-instruct-formats-bad-stop', 'settings.instructformats.list', 'response', false, {
    formats: [{ id: 'chatml', version: 1, stopStrings: [] }],
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
  fx('neg-themes-settings-values-not-object', 'themes.settings.update', 'request', false, {
    id: 'wii-u-dark',
    values: 'dark',
  }),
  fx('neg-themes-settings-get-bad-id', 'themes.settings.get', 'request', false, {
    id: 'Wii U Dark',
  }),
  fx('neg-themes-settings-response-scalar', 'themes.settings.get', 'response', false, {
    values: 42,
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
 * Builds the canonical product wire registry: compiles the registered
 * operations and the fixture corpus against `WIRE_SCHEMAS` (registering the
 * wire formats
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
