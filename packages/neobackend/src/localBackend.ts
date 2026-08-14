/**
 * LocalBackend — NeoBackend over the in-process kernel transport (ТЗ §15.1).
 *
 * No HTTP, no sockets: the kernel transport is a same-process adapter
 * (`LocalTransport`) provided by the caller. Every outbound request payload,
 * every response value and every stream event payload is validated against the
 * canonical wire schemas before it crosses the transport boundary; product
 * rules are intentionally not enforced here (ТЗ §15.1).
 */
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import {
  WIRE_SCHEMA_HASH,
  buildProductWireRegistry,
  type CompiledOperation,
  type ProductErrorDto,
  type BackupDto,
  type CharacterDto,
  type ChatDto,
  type EmptyResultDto,
  type GenerationRunDto,
  type ListToolsResultDto,
  type WireGenerationEvent,
  type ListBackupsResultDto,
  type ListLorebookEntriesResultDto,
  type ListLorebooksResultDto,
  type ListPersonasResultDto,
  type ListPresetsResultDto,
  type ListProvidersResultDto,
  type ListProviderConfigsResultDto,
  type LorebookDto,
  type LorebookEntryDto,
  type PersonaDto,
  type ProviderConfigDto,
  type MessageDto,
  type MetaDto,
  type PagedCharactersDto,
  type PagedChatsDto,
  type PagedGenerationEventsDto,
  type PagedMessagesDto,
} from '@neotavern/contracts';
import { ProductError, type StreamEvent } from '@neotavern/client-sdk';
import type {
  BackendCallOptions,
  BackupsApi,
  CharactersApi,
  ChatsApi,
  GenerationApi,
  LorebooksApi,
  NeoBackend,
  PersonasApi,
  PresetsApi,
  ProvidersApi,
} from './neobackend.js';

/** A single schema validation issue (JSON pointer path + human message). */
export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * Thrown when the kernel's wire schema hash differs from the expected one —
 * the local kernel speaks a different contract than this build of the client.
 */
export class ContractMismatchError extends Error {
  readonly expectedSchemaHash: string;
  readonly actualSchemaHash: string;

  constructor(details: { expectedSchemaHash: string; actualSchemaHash: string }) {
    super(
      `Wire schema hash mismatch: expected ${details.expectedSchemaHash}, kernel provides ${details.actualSchemaHash}`,
    );
    this.name = 'ContractMismatchError';
    this.expectedSchemaHash = details.expectedSchemaHash;
    this.actualSchemaHash = details.actualSchemaHash;
  }
}

/** Thrown when an outbound request payload fails wire schema validation. */
export class ValidationError extends Error {
  readonly schemaId: string;
  readonly issues: readonly SchemaIssue[];

  constructor(schemaId: string, issues: readonly SchemaIssue[]) {
    super(
      `Validation failed for ${schemaId}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
    this.name = 'ValidationError';
    this.schemaId = schemaId;
    this.issues = issues;
  }
}

/**
 * Thrown when the kernel returns a response or stream event that violates its
 * declared wire schema (inbound direction; the kernel broke the contract).
 */
export class ContractViolationError extends Error {
  readonly schemaId: string;
  readonly issues: readonly SchemaIssue[];

  constructor(schemaId: string, issues: readonly SchemaIssue[]) {
    super(
      `Contract violation for ${schemaId}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
    this.name = 'ContractViolationError';
    this.schemaId = schemaId;
    this.issues = issues;
  }
}

/** Result of a local kernel call; product errors are carried, not thrown. */
export type LocalCallResult = { ok: true; value: unknown } | { ok: false; error: ProductErrorDto };

/**
 * Same-process kernel transport. Implementations must not perform network I/O.
 */
export interface LocalTransport {
  /** Execute one wire operation; resolve with the kernel result. */
  call(
    operationId: string,
    payload: unknown,
    opts: { signal?: AbortSignal },
  ): Promise<LocalCallResult>;
  /** Open a wire event stream for a workflow operation. */
  stream(
    operationId: string,
    payload: unknown,
    opts: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent>;
}

/** LocalBackend constructor options. */
export interface LocalBackendOptions {
  /** Same-process kernel transport. */
  transport: LocalTransport;
  /**
   * Expected wire schema hash; defaults to `WIRE_SCHEMA_HASH`. A mismatch
   * throws `ContractMismatchError` at construction time.
   */
  expectedSchemaHash?: string;
}

type ProductRegistry = ReturnType<typeof buildProductWireRegistry>;

let productRegistry: ProductRegistry | undefined;

/** Lazily built product wire registry (pure; safe to share across instances). */
function productWireRegistry(): ProductRegistry {
  productRegistry ??= buildProductWireRegistry();
  return productRegistry;
}

function requireSchema(schemas: ReadonlyMap<string, TSchema>, schemaId: string): TSchema {
  const schema = schemas.get(schemaId);
  if (schema === undefined) {
    throw new Error(`Wire schema not found: ${schemaId}`);
  }
  return schema;
}

/**
 * Validate `value` against `schema` and return the decoded value. Outbound
 * request failures throw `ValidationError`; inbound response/event failures
 * throw `ContractViolationError`.
 */
function decodeChecked(
  schema: TSchema,
  value: unknown,
  schemaId: string,
  kind: 'request' | 'response' | 'event',
): unknown {
  if (!Value.Check(schema, value)) {
    const issues: SchemaIssue[] = [...Value.Errors(schema, value)].map((error) => ({
      path: error.path,
      message: error.message,
    }));
    if (kind === 'request') {
      throw new ValidationError(schemaId, issues);
    }
    throw new ContractViolationError(schemaId, issues);
  }
  return Value.Decode(schema, value);
}

/**
 * NeoBackend over a same-process kernel transport. Validates every payload
 * crossing the transport boundary against the canonical wire schemas; does not
 * use localhost/HTTP (ТЗ §15.1).
 */
export class LocalBackend implements NeoBackend {
  readonly characters: CharactersApi;
  readonly chats: ChatsApi;
  readonly lorebooks: LorebooksApi;
  readonly personas: PersonasApi;
  readonly presets: PresetsApi;
  readonly providers: ProvidersApi;
  readonly generation: GenerationApi;
  readonly backups: BackupsApi;

  private readonly transport: LocalTransport;
  private readonly operations: ReadonlyMap<string, CompiledOperation>;
  private readonly schemas: ReadonlyMap<string, TSchema>;

  constructor(options: LocalBackendOptions) {
    const expectedSchemaHash = options.expectedSchemaHash ?? WIRE_SCHEMA_HASH;
    if (expectedSchemaHash !== WIRE_SCHEMA_HASH) {
      throw new ContractMismatchError({
        expectedSchemaHash,
        actualSchemaHash: WIRE_SCHEMA_HASH,
      });
    }
    const registry = productWireRegistry();
    this.transport = options.transport;
    this.operations = new Map(
      registry.operations.map((operation) => [operation.operationId, operation] as const),
    );
    this.schemas = registry.schemas;

    this.characters = {
      list: (req, opts) => this.invoke<PagedCharactersDto>('characters.list', req, opts),
      get: (characterId, opts) =>
        this.invoke<CharacterDto>('characters.get', { characterId }, opts),
      create: (req, opts) => this.invoke<CharacterDto>('characters.create', req, opts),
      update: (req, opts) => this.invoke<CharacterDto>('characters.update', req, opts),
      del: (characterId, opts) =>
        this.invoke<EmptyResultDto>('characters.delete', { characterId }, opts),
    };
    this.chats = {
      list: (req, opts) => this.invoke<PagedChatsDto>('chats.list', req, opts),
      get: (chatId, opts) => this.invoke<ChatDto>('chats.get', { chatId }, opts),
      create: (req, opts) => this.invoke<ChatDto>('chats.create', req, opts),
      update: (req, opts) => this.invoke<ChatDto>('chats.update', req, opts),
      del: (chatId, opts) => this.invoke<EmptyResultDto>('chats.delete', { chatId }, opts),
      listMessages: (req, opts) => this.invoke<PagedMessagesDto>('chats.messages.list', req, opts),
      createMessage: (req, opts) => this.invoke<MessageDto>('chats.messages.create', req, opts),
      updateMessage: (req, opts) => this.invoke<MessageDto>('chats.messages.update', req, opts),
      delMessage: (req, opts) => this.invoke<EmptyResultDto>('chats.messages.delete', req, opts),
    };
    this.generation = {
      start: (req, opts) => this.stream('generation.start', req, opts),
      cancel: (workflowId) =>
        this.invoke<EmptyResultDto>('generation.cancel', { workflowId }, undefined),
      get: (workflowId, opts) =>
        this.invoke<GenerationRunDto>('generation.get', { workflowId }, opts),
      events: (req, opts) => this.invoke<PagedGenerationEventsDto>('generation.events', req, opts),
      retry: (sourceRunId, opts) => this.stream('generation.retry', { sourceRunId }, opts),
      keep: (workflowId, opts) =>
        this.invoke<GenerationRunDto>('generation.keep', { workflowId }, opts),
      discard: (workflowId, opts) =>
        this.invoke<GenerationRunDto>('generation.discard', { workflowId }, opts),
      tools: {
        list: (opts) => this.invoke<ListToolsResultDto>('generation.tools.list', {}, opts),
        result: (req, opts) =>
          this.invoke<GenerationRunDto>('generation.tool.result', req, opts),
      },
    };
    this.backups = {
      create: () => this.invoke<BackupDto>('backups.create', {}, undefined),
      list: () => this.invoke<ListBackupsResultDto>('backups.list', {}, undefined),
    };
    this.lorebooks = {
      list: () => this.invoke<ListLorebooksResultDto>('lorebooks.list', {}, undefined),
      get: (lorebookId, opts) =>
        this.invoke<LorebookDto>('lorebooks.get', { lorebookId }, opts),
      create: (req, opts) => this.invoke<LorebookDto>('lorebooks.create', req, opts),
      update: (req, opts) => this.invoke<LorebookDto>('lorebooks.update', req, opts),
      del: (lorebookId, opts) =>
        this.invoke<EmptyResultDto>('lorebooks.delete', { lorebookId }, opts),
      listEntries: (lorebookId, opts) =>
        this.invoke<ListLorebookEntriesResultDto>('lorebooks.entries.list', { lorebookId }, opts),
      createEntry: (req, opts) =>
        this.invoke<LorebookEntryDto>('lorebooks.entries.create', req, opts),
      updateEntry: (req, opts) =>
        this.invoke<LorebookEntryDto>('lorebooks.entries.update', req, opts),
      deleteEntry: (lorebookId, entryId, opts) =>
        this.invoke<EmptyResultDto>('lorebooks.entries.delete', { lorebookId, entryId }, opts),
    };
    this.personas = {
      list: () => this.invoke<ListPersonasResultDto>('personas.list', {}, undefined),
      get: (personaId, opts) => this.invoke<PersonaDto>('personas.get', { personaId }, opts),
      create: (req, opts) => this.invoke<PersonaDto>('personas.create', req, opts),
      update: (req, opts) => this.invoke<PersonaDto>('personas.update', req, opts),
      del: (personaId, opts) => this.invoke<EmptyResultDto>('personas.delete', { personaId }, opts),
    };
    this.presets = {
      list: () => this.invoke<ListPresetsResultDto>('presets.list', {}, undefined),
    };
    this.providers = {
      list: () => this.invoke<ListProvidersResultDto>('providers.list', {}, undefined),
      config: {
        set: (req, opts) => this.invoke<ProviderConfigDto>('providers.config.set', req, opts),
        get: (provider, name, opts) =>
          this.invoke<ProviderConfigDto>('providers.config.get', { provider, name }, opts),
        list: (req, opts) =>
          this.invoke<ListProviderConfigsResultDto>('providers.config.list', req, opts),
        del: (provider, name, opts) =>
          this.invoke<EmptyResultDto>('providers.config.delete', { provider, name }, opts),
      },
    };
  }

  /** Wire metadata via the `meta.get` operation. */
  async meta(): Promise<MetaDto> {
    return this.invoke<MetaDto>('meta.get', {}, undefined);
  }

  private operation(operationId: string): CompiledOperation {
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      throw new Error(`Unknown wire operation: ${operationId}`);
    }
    return operation;
  }

  private async invoke<T>(
    operationId: string,
    payload: unknown,
    opts: BackendCallOptions | undefined,
  ): Promise<T> {
    const operation = this.operation(operationId);
    const request = decodeChecked(
      requireSchema(this.schemas, operation.requestSchemaId),
      payload,
      operation.requestSchemaId,
      'request',
    );
    const result = await this.transport.call(operationId, request, { signal: opts?.signal });
    if (!result.ok) {
      throw new ProductError(result.error);
    }
    const responseSchemaId = operation.responseSchemaId;
    if (responseSchemaId === undefined) {
      throw new Error(`Wire operation ${operationId} has no response schema`);
    }
    const value = decodeChecked(
      requireSchema(this.schemas, responseSchemaId),
      result.value,
      responseSchemaId,
      'response',
    );
    return value as T;
  }

  private async *stream(
    operationId: string,
    payload: unknown,
    opts: BackendCallOptions | undefined,
  ) {
    const operation = this.operation(operationId);
    const request = decodeChecked(
      requireSchema(this.schemas, operation.requestSchemaId),
      payload,
      operation.requestSchemaId,
      'request',
    );
    const eventSchemaId = operation.eventSchemaId;
    if (eventSchemaId === undefined) {
      throw new Error(`Wire operation ${operationId} has no event schema`);
    }
    const eventSchema = requireSchema(this.schemas, eventSchemaId);
    for await (const event of this.transport.stream(operationId, request, {
      signal: opts?.signal,
    })) {
      const value = decodeChecked(eventSchema, event.payload, eventSchemaId, 'event');
      yield value as WireGenerationEvent;
    }
  }
}
