/**
 * Canonical wire DTO schemas (Phase 0 product wire contract).
 *
 * Every DTO carries a stable `$id` (its schemaId) and objects are strict
 * (`additionalProperties: false`) unless the design marks them tolerant by
 * schema (envelope `payload`/`result`, `ProductErrorDto.params`). Timestamps
 * use `format: 'rfc3339'`, ids use `format: 'uuid'` — both are registered in
 * `formats.ts`. The Rust `contracts-generated` crate mirrors every schema.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ProductErrorDtoSchema } from './errors.js';
import { EventEnvelopeSchema, RequestEnvelopeSchema, ResponseEnvelopeSchema } from './envelope.js';

export { ProductErrorDtoSchema };

/**
 * Meta DTO (`wire.meta.dto`): app/API/wire protocol versions plus the
 * feature map (feature name → minimum supported version).
 */
export const MetaDtoSchema = Type.Object(
  {
    appVersion: Type.String({ minLength: 1, maxLength: 64 }),
    api: Type.Object({
      major: Type.Integer({ minimum: 1 }),
      minor: Type.Integer({ minimum: 0 }),
    }),
    productWire: Type.Object({
      major: Type.Integer({ minimum: 1 }),
      minor: Type.Integer({ minimum: 0 }),
    }),
    minimumClientVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    features: Type.Object({}, { additionalProperties: Type.Integer({ minimum: 0 }) }),
  },
  { $id: 'wire.meta.dto', additionalProperties: false },
);
export type MetaDto = Static<typeof MetaDtoSchema>;

/** Character DTO (`wire.character.dto`). */
export const CharacterDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    avatarAssetId: Type.Optional(Type.String({ format: 'uuid' })),
    tags: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.character.dto', additionalProperties: false },
);
export type CharacterDto = Static<typeof CharacterDtoSchema>;

/** Chat DTO (`wire.chat.dto`). */
export const ChatDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    characterId: Type.String({ format: 'uuid' }),
    messageCount: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.chat.dto', additionalProperties: false },
);
export type ChatDto = Static<typeof ChatDtoSchema>;

/**
 * Message role union (`wire.message.role`). Closed string enum: unknown
 * roles are rejected on the wire. Prefixed `Wire` to avoid colliding with the
 * legacy `MessageRole` export from `message.js` at the package root.
 */
export const WireMessageRole = Type.Union(
  [Type.Literal('system'), Type.Literal('user'), Type.Literal('assistant'), Type.Literal('tool')],
  { $id: 'wire.message.role', 'x-wire-unknown-behavior': 'reject' },
);
export type WireMessageRole = Static<typeof WireMessageRole>;

/** Message DTO (`wire.message.dto`). */
export const MessageDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    chatId: Type.String({ format: 'uuid' }),
    role: WireMessageRole,
    content: Type.String({ minLength: 0, maxLength: 1000000 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    sequence: Type.Integer({ minimum: 0 }),
    generationRunId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.message.dto', additionalProperties: false },
);
export type MessageDto = Static<typeof MessageDtoSchema>;

/** Backup DTO (`wire.backup.dto`). */
export const BackupDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    createdAt: Type.String({ format: 'rfc3339' }),
    formatVersion: Type.Literal(1),
    sizeBytes: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
    checksumSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    status: Type.Union(
      [Type.Literal('completed'), Type.Literal('in_progress'), Type.Literal('failed')],
      { 'x-wire-unknown-behavior': 'reject' },
    ),
  },
  { $id: 'wire.backup.dto', additionalProperties: false },
);
export type BackupDto = Static<typeof BackupDtoSchema>;

/** Lorebook DTO (`wire.lorebook.dto`). */
export const LorebookDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    entryCount: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.lorebook.dto', additionalProperties: false },
);
export type LorebookDto = Static<typeof LorebookDtoSchema>;

/** Preset DTO (`wire.preset.dto`). */
export const PresetDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.preset.dto', additionalProperties: false },
);
export type PresetDto = Static<typeof PresetDtoSchema>;

/** Paged characters result (`wire.paged.characters`). */
export const PagedCharactersDtoSchema = Type.Object(
  {
    items: Type.Array(CharacterDtoSchema),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { $id: 'wire.paged.characters', additionalProperties: false },
);
export type PagedCharactersDto = Static<typeof PagedCharactersDtoSchema>;

/** Paged chats result (`wire.paged.chats`). */
export const PagedChatsDtoSchema = Type.Object(
  {
    items: Type.Array(ChatDtoSchema),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { $id: 'wire.paged.chats', additionalProperties: false },
);
export type PagedChatsDto = Static<typeof PagedChatsDtoSchema>;

/** Paged messages result (`wire.paged.messages`). */
export const PagedMessagesDtoSchema = Type.Object(
  {
    items: Type.Array(MessageDtoSchema),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { $id: 'wire.paged.messages', additionalProperties: false },
);
export type PagedMessagesDto = Static<typeof PagedMessagesDtoSchema>;

/**
 * Generation event union (`wire.generation.event`): discriminated on `type`.
 * Streamed by `generation.start` until a terminal member
 * (`generation.completed` / `generation.failed` / `generation.cancelled`).
 */
export const WireGenerationEvent = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal('generation.delta'),
        text: Type.String({ minLength: 0, maxLength: 4096 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('generation.checkpoint'),
        sequence: Type.Integer({ minimum: 0 }),
        partialLength: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('generation.completed'),
        finalMessage: MessageDtoSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('generation.failed'),
        error: ProductErrorDtoSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('generation.cancelled'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('consumer_lagged'),
        dropped: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'wire.generation.event', 'x-wire-discriminator': 'type' },
);
export type WireGenerationEvent = Static<typeof WireGenerationEvent>;

/** Empty request DTO (`wire.request.empty`). */
export const EmptyRequestDtoSchema = Type.Object(
  {},
  { $id: 'wire.request.empty', additionalProperties: false },
);
export type EmptyRequestDto = Static<typeof EmptyRequestDtoSchema>;

/** List characters request DTO (`wire.request.list-characters`). */
export const ListCharactersRequestDtoSchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { $id: 'wire.request.list-characters', additionalProperties: false },
);
export type ListCharactersRequestDto = Static<typeof ListCharactersRequestDtoSchema>;

/** Get character request DTO (`wire.request.get-character`). */
export const GetCharacterRequestDtoSchema = Type.Object(
  {
    characterId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.get-character', additionalProperties: false },
);
export type GetCharacterRequestDto = Static<typeof GetCharacterRequestDtoSchema>;

/** Create character request DTO (`wire.request.create-character`). */
export const CreateCharacterRequestDtoSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
  },
  { $id: 'wire.request.create-character', additionalProperties: false },
);
export type CreateCharacterRequestDto = Static<typeof CreateCharacterRequestDtoSchema>;

/** Update character request DTO (`wire.request.update-character`). */
export const UpdateCharacterRequestDtoSchema = Type.Object(
  {
    characterId: Type.String({ format: 'uuid' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
  },
  { $id: 'wire.request.update-character', additionalProperties: false },
);
export type UpdateCharacterRequestDto = Static<typeof UpdateCharacterRequestDtoSchema>;

/** Delete character request DTO (`wire.request.delete-character`). */
export const DeleteCharacterRequestDtoSchema = Type.Object(
  {
    characterId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.delete-character', additionalProperties: false },
);
export type DeleteCharacterRequestDto = Static<typeof DeleteCharacterRequestDtoSchema>;

/** List chats request DTO (`wire.request.list-chats`). */
export const ListChatsRequestDtoSchema = Type.Object(
  {
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { $id: 'wire.request.list-chats', additionalProperties: false },
);
export type ListChatsRequestDto = Static<typeof ListChatsRequestDtoSchema>;

/** Get chat request DTO (`wire.request.get-chat`). */
export const GetChatRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.get-chat', additionalProperties: false },
);
export type GetChatRequestDto = Static<typeof GetChatRequestDtoSchema>;

/** List messages request DTO (`wire.request.list-messages`). */
export const ListMessagesRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { $id: 'wire.request.list-messages', additionalProperties: false },
);
export type ListMessagesRequestDto = Static<typeof ListMessagesRequestDtoSchema>;

/** Start generation request DTO (`wire.request.start-generation`). */
export const StartGenerationRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    message: Type.String({ minLength: 1, maxLength: 100000 }),
    provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { $id: 'wire.request.start-generation', additionalProperties: false },
);
export type StartGenerationRequestDto = Static<typeof StartGenerationRequestDtoSchema>;

/** Generation run status union (`wire.generation.status`). */
export const WireGenerationStatus = Type.Union(
  [
    Type.Literal('queued'),
    Type.Literal('preparing'),
    Type.Literal('streaming'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('cancelling'),
    Type.Literal('cancelled'),
    Type.Literal('interrupted'),
  ],
  { $id: 'wire.generation.status', 'x-wire-unknown-behavior': 'reject' },
);
export type WireGenerationStatus = Static<typeof WireGenerationStatus>;

/**
 * Generation run DTO (`wire.generation.run`): durable snapshot of one
 * recoverable generation workflow (ТЗ §62). `partialText` is a bounded
 * preview of the partial output; `partialTextLength` is the true length and
 * `partialTruncated` marks that the preview was cut.
 */
export const GenerationRunDtoSchema = Type.Object(
  {
    runId: Type.String({ format: 'uuid' }),
    sourceRunId: Type.Optional(Type.String({ format: 'uuid' })),
    chatId: Type.String({ format: 'uuid' }),
    attempt: Type.Integer({ minimum: 1 }),
    status: WireGenerationStatus,
    provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    revision: Type.Integer({ minimum: 0 }),
    lastEventSequence: Type.Integer({ minimum: -1 }),
    partialTextLength: Type.Integer({ minimum: 0 }),
    partialText: Type.Optional(Type.String({ minLength: 0, maxLength: 4096 })),
    partialTruncated: Type.Boolean(),
    error: Type.Optional(ProductErrorDtoSchema),
    messageId: Type.Optional(Type.String({ format: 'uuid' })),
    leaseExpiresAt: Type.Optional(Type.String({ format: 'rfc3339' })),
    startedAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.generation.run', additionalProperties: false },
);
export type GenerationRunDto = Static<typeof GenerationRunDtoSchema>;

/** Get generation run request DTO (`wire.request.get-generation-run`). */
export const GetGenerationRunRequestDtoSchema = Type.Object(
  {
    workflowId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.get-generation-run', additionalProperties: false },
);
export type GetGenerationRunRequestDto = Static<typeof GetGenerationRunRequestDtoSchema>;

/** Retry generation request DTO (`wire.request.retry-generation`). */
export const RetryGenerationRequestDtoSchema = Type.Object(
  {
    sourceRunId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.retry-generation', additionalProperties: false },
);
export type RetryGenerationRequestDto = Static<typeof RetryGenerationRequestDtoSchema>;

/** Keep partial generation request DTO (`wire.request.keep-partial-generation`). */
export const KeepPartialGenerationRequestDtoSchema = Type.Object(
  {
    workflowId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.keep-partial-generation', additionalProperties: false },
);
export type KeepPartialGenerationRequestDto = Static<typeof KeepPartialGenerationRequestDtoSchema>;

/** Discard generation request DTO (`wire.request.discard-generation`). */
export const DiscardGenerationRequestDtoSchema = Type.Object(
  {
    workflowId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.discard-generation', additionalProperties: false },
);
export type DiscardGenerationRequestDto = Static<typeof DiscardGenerationRequestDtoSchema>;

/** List generation events request DTO (`wire.request.list-generation-events`). */
export const ListGenerationEventsRequestDtoSchema = Type.Object(
  {
    workflowId: Type.String({ format: 'uuid' }),
    afterSequence: Type.Optional(Type.Integer({ minimum: -1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { $id: 'wire.request.list-generation-events', additionalProperties: false },
);
export type ListGenerationEventsRequestDto = Static<typeof ListGenerationEventsRequestDtoSchema>;

/** Paged generation events result (`wire.paged.generation-events`). */
export const PagedGenerationEventsDtoSchema = Type.Object(
  {
    items: Type.Array(EventEnvelopeSchema),
    hasMore: Type.Boolean(),
  },
  { $id: 'wire.paged.generation-events', additionalProperties: false },
);
export type PagedGenerationEventsDto = Static<typeof PagedGenerationEventsDtoSchema>;

/** Cancel generation request DTO (`wire.request.cancel-generation`). */
export const CancelGenerationRequestDtoSchema = Type.Object(
  {
    workflowId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.cancel-generation', additionalProperties: false },
);
export type CancelGenerationRequestDto = Static<typeof CancelGenerationRequestDtoSchema>;

/**
 * Provider availability code wire rule (ТЗ §60): a versioned documented set;
 * receivers implement an explicit unknown-code fallback, so the wire type is
 * an open lowercase identifier (adding a code is additive, §6.7).
 */
const PROVIDER_AVAILABILITY_CODE = Type.String({
  pattern: '^[a-z][a-z0-9_]{0,63}$',
});

/**
 * Provider availability union (`wire.provider.availability`): discriminated on
 * `status` (ТЗ §60). `available` carries nothing; `degraded` / `unavailable`
 * carry a versioned `code` and an optional safe user-facing `detail` that the
 * UI must not use for programmatic branching.
 */
export const ProviderAvailabilitySchema = Type.Union(
  [
    Type.Object({ status: Type.Literal('available') }, { additionalProperties: false }),
    Type.Object(
      {
        status: Type.Literal('degraded'),
        code: PROVIDER_AVAILABILITY_CODE,
        detail: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        status: Type.Literal('unavailable'),
        code: PROVIDER_AVAILABILITY_CODE,
        detail: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'wire.provider.availability', 'x-wire-discriminator': 'status' },
);
export type ProviderAvailability = Static<typeof ProviderAvailabilitySchema>;

/** Provider model DTO (`wire.provider.model`). */
export const ProviderModelDtoSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    contextLimit: Type.Optional(Type.Integer({ minimum: 0 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { $id: 'wire.provider.model', additionalProperties: false },
);
export type ProviderModelDto = Static<typeof ProviderModelDtoSchema>;

/** Provider DTO (`wire.provider.dto`) — ТЗ §55/§60 normalized surface. */
export const ProviderDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    builtin: Type.Boolean(),
    availability: ProviderAvailabilitySchema,
    models: Type.Array(ProviderModelDtoSchema, { maxItems: 64 }),
  },
  { $id: 'wire.provider.dto', additionalProperties: false },
);
export type ProviderDto = Static<typeof ProviderDtoSchema>;

/** List providers result DTO (`wire.result.list-providers`). */
export const ListProvidersResultDtoSchema = Type.Object(
  {
    items: Type.Array(ProviderDtoSchema),
  },
  { $id: 'wire.result.list-providers', additionalProperties: false },
);
export type ListProvidersResultDto = Static<typeof ListProvidersResultDtoSchema>;

/** Empty result DTO (`wire.result.empty`). */
export const EmptyResultDtoSchema = Type.Object(
  {},
  { $id: 'wire.result.empty', additionalProperties: false },
);
export type EmptyResultDto = Static<typeof EmptyResultDtoSchema>;

/** List backups result DTO (`wire.result.list-backups`). */
export const ListBackupsResultDtoSchema = Type.Object(
  {
    items: Type.Array(BackupDtoSchema),
  },
  { $id: 'wire.result.list-backups', additionalProperties: false },
);
export type ListBackupsResultDto = Static<typeof ListBackupsResultDtoSchema>;

/** List lorebooks result DTO (`wire.result.list-lorebooks`). */
export const ListLorebooksResultDtoSchema = Type.Object(
  {
    items: Type.Array(LorebookDtoSchema),
  },
  { $id: 'wire.result.list-lorebooks', additionalProperties: false },
);
export type ListLorebooksResultDto = Static<typeof ListLorebooksResultDtoSchema>;

/** List presets result DTO (`wire.result.list-presets`). */
export const ListPresetsResultDtoSchema = Type.Object(
  {
    items: Type.Array(PresetDtoSchema),
  },
  { $id: 'wire.result.list-presets', additionalProperties: false },
);
export type ListPresetsResultDto = Static<typeof ListPresetsResultDtoSchema>;

/**
 * Every wire schema keyed by its `$id` (schemaId): all DTOs plus the error
 * DTO, the message role union and the three envelopes. This is the complete
 * schema registry the codegen tool and `compileWireContract` operate on.
 */
export const WIRE_SCHEMAS: Record<string, TSchema> = {
  'wire.meta.dto': MetaDtoSchema,
  'wire.character.dto': CharacterDtoSchema,
  'wire.chat.dto': ChatDtoSchema,
  'wire.message.role': WireMessageRole,
  'wire.message.dto': MessageDtoSchema,
  'wire.backup.dto': BackupDtoSchema,
  'wire.lorebook.dto': LorebookDtoSchema,
  'wire.preset.dto': PresetDtoSchema,
  'wire.paged.characters': PagedCharactersDtoSchema,
  'wire.paged.chats': PagedChatsDtoSchema,
  'wire.paged.messages': PagedMessagesDtoSchema,
  'wire.generation.event': WireGenerationEvent,
  'wire.generation.status': WireGenerationStatus,
  'wire.generation.run': GenerationRunDtoSchema,
  'wire.provider.availability': ProviderAvailabilitySchema,
  'wire.provider.model': ProviderModelDtoSchema,
  'wire.provider.dto': ProviderDtoSchema,
  'wire.result.list-providers': ListProvidersResultDtoSchema,
  'wire.error.dto': ProductErrorDtoSchema,
  'wire.request.empty': EmptyRequestDtoSchema,
  'wire.request.list-characters': ListCharactersRequestDtoSchema,
  'wire.request.get-character': GetCharacterRequestDtoSchema,
  'wire.request.create-character': CreateCharacterRequestDtoSchema,
  'wire.request.update-character': UpdateCharacterRequestDtoSchema,
  'wire.request.delete-character': DeleteCharacterRequestDtoSchema,
  'wire.request.list-chats': ListChatsRequestDtoSchema,
  'wire.request.get-chat': GetChatRequestDtoSchema,
  'wire.request.list-messages': ListMessagesRequestDtoSchema,
  'wire.request.start-generation': StartGenerationRequestDtoSchema,
  'wire.request.cancel-generation': CancelGenerationRequestDtoSchema,
  'wire.request.get-generation-run': GetGenerationRunRequestDtoSchema,
  'wire.request.retry-generation': RetryGenerationRequestDtoSchema,
  'wire.request.keep-partial-generation': KeepPartialGenerationRequestDtoSchema,
  'wire.request.discard-generation': DiscardGenerationRequestDtoSchema,
  'wire.request.list-generation-events': ListGenerationEventsRequestDtoSchema,
  'wire.result.empty': EmptyResultDtoSchema,
  'wire.result.list-backups': ListBackupsResultDtoSchema,
  'wire.paged.generation-events': PagedGenerationEventsDtoSchema,
  'wire.result.list-lorebooks': ListLorebooksResultDtoSchema,
  'wire.result.list-presets': ListPresetsResultDtoSchema,
  'wire.request.envelope': RequestEnvelopeSchema,
  'wire.response.envelope': ResponseEnvelopeSchema,
  'wire.event.envelope': EventEnvelopeSchema,
};
