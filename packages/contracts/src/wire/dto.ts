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

/** Character DTO (`wire.character.dto`). `profileId` (optional) binds the
 * character to a Configuration profile (ADR-0047 waiver 4, Этап 4 slice 5
 * remainder part 2): a scoped `profile.export` carries only the characters
 * of one profile (chats/messages follow transitively). */
export const CharacterDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    avatarAssetId: Type.Optional(Type.String({ format: 'uuid' })),
    tags: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
    profileId: Type.Optional(Type.String({ format: 'uuid' })),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.character.dto', additionalProperties: false },
);
export type CharacterDto = Static<typeof CharacterDtoSchema>;

/**
 * Character-card import request (`wire.request.imports.character.card`) —
 * imports a SillyTavern-compatible character card (V2 JSON, or PNG with the
 * `chara` tEXt chunk) that was staged first through `assets.put` (kind
 * `card`). The kernel parses the card, deduplicates by content sha256, and
 * creates the character (Этап 4.5).
 */
export const CharacterCardImportRequestDtoSchema = Type.Object(
  {
    assetId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.imports.character.card', additionalProperties: false },
);
export type CharacterCardImportRequestDto = Static<typeof CharacterCardImportRequestDtoSchema>;

/** Character-card import result (`wire.result.imports.character.card`).
 * `created` is false when the same card bytes were already imported
 * (re-running an import must not create duplicates, AGENTS.md §11).
 * `sourceHash` is the sha256 of the original card file. */
export const CharacterCardImportResultDtoSchema = Type.Object(
  {
    character: CharacterDtoSchema,
    created: Type.Boolean(),
    sourceHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
  },
  { $id: 'wire.result.imports.character.card', additionalProperties: false },
);
export type CharacterCardImportResultDto = Static<typeof CharacterCardImportResultDtoSchema>;

/**
 * Character-card export format (`wire.card.export.format`): a SillyTavern
 * card container in plain JSON or a PNG whose `chara` tEXt chunk carries
 * base64-encoded JSON — the same container shapes `imports.character.card`
 * accepts, so an exported card re-imports verbatim (Этап 4.5 round trip).
 */
export const WireCardExportFormat = Type.Union([Type.Literal('json'), Type.Literal('png')], {
  $id: 'wire.card.export.format',
  'x-wire-unknown-behavior': 'reject',
});
export type WireCardExportFormat = Static<typeof WireCardExportFormat>;

/** Character-card export request (`wire.request.characters.export.card`). */
export const CharacterCardExportRequestDtoSchema = Type.Object(
  {
    characterId: Type.String({ format: 'uuid' }),
    format: WireCardExportFormat,
  },
  { $id: 'wire.request.characters.export.card', additionalProperties: false },
);
export type CharacterCardExportRequestDto = Static<typeof CharacterCardExportRequestDtoSchema>;

/**
 * Character-card export result (`wire.result.characters.export.card`): the
 * SillyTavern card container base64-encoded so the UI can download it without
 * a second transport hop. The JSON payload is the original card object when
 * it was preserved under `ext_json._card` (import round trip); a character
 * created without a card container is rebuilt from the canonical columns and
 * the `warnings` array says so honestly.
 */
export const CharacterCardExportResultDtoSchema = Type.Object(
  {
    filename: Type.String({ pattern: '^[^/\\\\]{1,255}\\.(json|png)$' }),
    contentType: Type.String({ minLength: 1, maxLength: 128 }),
    contentBase64: Type.String({
      pattern: '^[A-Za-z0-9+/]*={0,2}$',
      minLength: 1,
    }),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
  },
  { $id: 'wire.result.characters.export.card', additionalProperties: false },
);
export type CharacterCardExportResultDto = Static<typeof CharacterCardExportResultDtoSchema>;

/** Chat export request (`wire.request.chats.export`). */
export const ChatsExportRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.chats.export', additionalProperties: false },
);
export type ChatsExportRequestDto = Static<typeof ChatsExportRequestDtoSchema>;

/**
 * Chat export result (`wire.result.chats.export`): the `neotavern-chat-export`
 * v2 container (chat + character name + full message/variant/revision dump)
 * base64-encoded for download. Response limit is 4 MiB (same as
 * `assets.content`) because a long chat with variants and revisions can
 * legitimately exceed the 256 KiB default cap; an over-limit chat surfaces as
 * a transport error, never a silent truncation.
 */
export const ChatsExportResultDtoSchema = Type.Object(
  {
    filename: Type.String({ pattern: '^[^/\\\\]{1,255}\\.json$' }),
    contentType: Type.String({ minLength: 1, maxLength: 128 }),
    contentBase64: Type.String({
      pattern: '^[A-Za-z0-9+/]*={0,2}$',
      minLength: 1,
    }),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
  },
  { $id: 'wire.result.chats.export', additionalProperties: false },
);
export type ChatsExportResultDto = Static<typeof ChatsExportResultDtoSchema>;

/** Snapshot origin (`wire.snapshot.origin`): checkpoint or branch. */
export const WireSnapshotOrigin = Type.Union([Type.Literal('checkpoint'), Type.Literal('branch')], {
  $id: 'wire.snapshot.origin',
  'x-wire-unknown-behavior': 'reject',
});
export type WireSnapshotOrigin = Static<typeof WireSnapshotOrigin>;

/** Chat DTO (`wire.chat.dto`). `personaId` (optional) is the user persona
 * applied by the prompt pipeline (ADR-0047 waiver 5, Этап 4 slice 3); the
 * snapshot trio (`parentChatId`/`origin`/`sourceMessageId`) marks child chats
 * created by `chats.snapshots.create`. */
export const ChatDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    characterId: Type.String({ format: 'uuid' }),
    personaId: Type.Optional(Type.String({ format: 'uuid' })),
    messageCount: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
    /** Parent chat id when this chat is a snapshot (checkpoint/branch) child. */
    parentChatId: Type.Optional(Type.String({ format: 'uuid' })),
    /** Snapshot origin (`checkpoint` or `branch`) when this chat is a child. */
    origin: Type.Optional(WireSnapshotOrigin),
    /** Source message the snapshot was taken from (child chats only). */
    sourceMessageId: Type.Optional(Type.String({ format: 'uuid' })),
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

/** Free-form JSON object (`wire.free-object`) — values of arbitrary JSON shape. */
export const WireFreeObjectSchema = Type.Object(
  {},
  { additionalProperties: true, $id: 'wire.free-object' },
);
export type WireFreeObject = Static<typeof WireFreeObjectSchema>;

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
    /** Extension metadata (tool calls, manual exclusion, swipe bookmarks). */
    meta: WireFreeObjectSchema,
    /** Child chat id when this message is a checkpoint source (snapshots). */
    checkpointChatId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.message.dto', additionalProperties: false },
);
export type MessageDto = Static<typeof MessageDtoSchema>;

/** Message variant (swipe) DTO (`wire.message.variant.dto`). */
export const MessageVariantDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
    content: Type.String({ minLength: 0, maxLength: 1000000 }),
    position: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.message.variant.dto', additionalProperties: false },
);
export type MessageVariantDto = Static<typeof MessageVariantDtoSchema>;

/** Immutable manual content revision DTO (`wire.message.revision.dto`). */
export const MessageRevisionDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
    content: Type.String({ minLength: 0, maxLength: 1000000 }),
    position: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.message.revision.dto', additionalProperties: false },
);
export type MessageRevisionDto = Static<typeof MessageRevisionDtoSchema>;

/** Server-side message draft DTO (`wire.message.draft.dto`). */
export const MessageDraftDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    chatId: Type.String({ format: 'uuid' }),
    role: WireMessageRole,
    content: Type.String({ minLength: 0, maxLength: 1000000 }),
    sequence: Type.Integer({ minimum: 0 }),
    revision: Type.Integer({ minimum: 1 }),
    committedMessageId: Type.Optional(Type.String({ format: 'uuid' })),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.message.draft.dto', additionalProperties: false },
);
export type MessageDraftDto = Static<typeof MessageDraftDtoSchema>;

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

/** Lorebook DTO (`wire.lorebook.dto`). `characterId` (optional) binds the
 * book to one character (legacy `character_lorebooks` link, ТЗ §8.1 Library
 * context, ADR-0047 waiver 2): absent means a shared-library book scanned
 * for every chat; present means the book belongs to that character only. */
export const LorebookDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    entryCount: Type.Integer({ minimum: 0 }),
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.lorebook.dto', additionalProperties: false },
);
export type LorebookDto = Static<typeof LorebookDtoSchema>;

/** Preset DTO (`wire.preset.dto`). `kind` partitions presets; `data` is the
 * free-form JSON payload the consumer of that kind validates. */
export const PresetDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    kind: Type.String({ minLength: 1, maxLength: 50, pattern: '^[a-z0-9][a-z0-9-]*$' }),
    name: Type.String({ minLength: 1, maxLength: 500 }),
    data: Type.Object({}, { additionalProperties: true }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.preset.dto', additionalProperties: false },
);
export type PresetDto = Static<typeof PresetDtoSchema>;

/** Memory scope union (`wire.memory.scope`). Closed enum: unknown scopes are
 * rejected on the wire. */
export const WireMemoryScope = Type.Union([Type.Literal('global'), Type.Literal('character')], {
  $id: 'wire.memory.scope',
  'x-wire-unknown-behavior': 'reject',
});
export type WireMemoryScope = Static<typeof WireMemoryScope>;

/** Memory DTO (`wire.memory.dto`). Long-lived knowledge fragments the prompt
 * pipeline injects, activated by keyword match (legacy `MemorySchema`). */
export const MemoryDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    scope: WireMemoryScope,
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
    keys: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100 }),
    content: Type.String({ minLength: 1, maxLength: 100000 }),
    enabled: Type.Boolean(),
    position: Type.Integer({ minimum: 0, maximum: 1000000 }),
    metadata: Type.Object({}, { additionalProperties: true }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.memory.dto', additionalProperties: false },
);
export type MemoryDto = Static<typeof MemoryDtoSchema>;

/**
 * Persona DTO (`wire.persona.dto`). The "user" identity injected into the
 * prompt pipeline as `{{user}}` (legacy `PersonaSchema`). `isDefault` marks
 * the fallback persona the prompt pipeline resolves when neither the chat nor
 * the app selects one explicitly. `avatar` is an optional free-form reference
 * (legacy avatar id/path); asset linkage is a later Этап 4 slice.
 */
export const PersonaDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    avatar: Type.Optional(Type.String({ minLength: 0, maxLength: 512 })),
    isDefault: Type.Boolean(),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.persona.dto', additionalProperties: false },
);
export type PersonaDto = Static<typeof PersonaDtoSchema>;

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
 * Generation run/step model DTOs (`wire.generation.step`, `wire.tool.*`,
 * ТЗ §8.3, Этап 2.7): the durable `GenerationStep` journal of one run and
 * the normalized tool-call contract — the kernel validates and records each
 * provider turn, tool call and tool result as an immutable step, never
 * executes tools itself, and resumes a run from the durable `waiting_for_tool`
 * state when the host submits the result.
 */

/** Step type union (`wire.generation.step.type`). */
export const WireGenerationStepType = Type.Union(
  [
    Type.Literal('provider_turn'),
    Type.Literal('tool_call'),
    Type.Literal('tool_result'),
    Type.Literal('final_commit'),
  ],
  { $id: 'wire.generation.step.type', 'x-wire-unknown-behavior': 'reject' },
);
export type WireGenerationStepType = Static<typeof WireGenerationStepType>;

/** Step status union (`wire.generation.step.status`). */
export const WireGenerationStepStatus = Type.Union(
  [
    Type.Literal('running'),
    Type.Literal('waiting'),
    Type.Literal('completed'),
    Type.Literal('failed'),
  ],
  { $id: 'wire.generation.step.status', 'x-wire-unknown-behavior': 'reject' },
);
export type WireGenerationStepStatus = Static<typeof WireGenerationStepStatus>;

/**
 * One durable generation step (`wire.generation.step`, ТЗ §8.3): an
 * immutable journal row with a monotonic per-run `sequence`, its `type` and
 * `status`, the attempt number, an `idempotencyKey` for replay safety and
 * bounded JSON `input`/`output` (tool arguments/results; large payloads are
 * referenced, never copied). `error` mirrors the terminal error DTO.
 */
export const GenerationStepDtoSchema = Type.Object(
  {
    stepId: Type.String({ format: 'uuid' }),
    runId: Type.String({ format: 'uuid' }),
    sequence: Type.Integer({ minimum: 0 }),
    type: WireGenerationStepType,
    status: WireGenerationStepStatus,
    attempt: Type.Integer({ minimum: 1 }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
    input: Type.Optional(Type.Object({}, { additionalProperties: true })),
    output: Type.Optional(Type.Object({}, { additionalProperties: true })),
    error: Type.Optional(ProductErrorDtoSchema),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.generation.step', additionalProperties: false },
);
export type GenerationStepDto = Static<typeof GenerationStepDtoSchema>;

/**
 * Declared tool contract (`wire.tool.spec`, ТЗ §8.3): what the host exposes
 * to the kernel's tool registry. `inputSchema` is a JSON-Schema document the
 * kernel validates each call's arguments against before the run may wait on
 * the tool result (schema/capability check, §8.3).
 */
export const ToolSpecDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ minLength: 0, maxLength: 512 }),
    inputSchema: Type.Object({}, { additionalProperties: true }),
  },
  { $id: 'wire.tool.spec', additionalProperties: false },
);
export type ToolSpecDto = Static<typeof ToolSpecDtoSchema>;

/** List tools result DTO (`wire.result.list-tools`). */
export const ListToolsResultDtoSchema = Type.Object(
  {
    items: Type.Array(ToolSpecDtoSchema),
  },
  { $id: 'wire.result.list-tools', additionalProperties: false },
);
export type ListToolsResultDto = Static<typeof ListToolsResultDtoSchema>;

/**
 * Normalized tool request (`wire.tool.call`, ТЗ §9.3): what the provider
 * adapter emits and the kernel records. The kernel never executes tools
 * itself; the host performs the effect and submits the result via
 * `generation.tool.result`.
 */
export const ToolCallDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    arguments: Type.Object({}, { additionalProperties: true }),
  },
  { $id: 'wire.tool.call', additionalProperties: false },
);
export type ToolCallDto = Static<typeof ToolCallDtoSchema>;

/** Submit tool result request DTO (`wire.request.generation-tool-result`). */
export const GenerationToolResultRequestDtoSchema = Type.Object(
  {
    runId: Type.String({ format: 'uuid' }),
    toolCallId: Type.String({ format: 'uuid' }),
    result: Type.Object({}, { additionalProperties: true }),
  },
  { $id: 'wire.request.generation-tool-result', additionalProperties: false },
);
export type GenerationToolResultRequestDto = Static<typeof GenerationToolResultRequestDtoSchema>;

/**
 * Generation event union (`wire.generation.event`): discriminated on `type`.
 * Streamed by `generation.start` until a terminal member
 * (`generation.completed` / `generation.failed` / `generation.cancelled`);
 * `generation.step` announces each durable step commit (provider turns, tool
 * calls and results), so the UI can distinguish streaming from tool
 * execution and waiting-for-tool (§13.2).
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
        type: Type.Literal('generation.step'),
        step: GenerationStepDtoSchema,
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

/**
 * Create character request DTO (`wire.request.create-character`).
 * `avatarAssetId` (optional) links the character to an asset published
 * through `assets.put`; the kernel verifies the asset exists.
 */
export const CreateCharacterRequestDtoSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
    avatarAssetId: Type.Optional(Type.String({ format: 'uuid' })),
    profileId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.request.create-character', additionalProperties: false },
);
export type CreateCharacterRequestDto = Static<typeof CreateCharacterRequestDtoSchema>;

/**
 * Update character request DTO (`wire.request.update-character`).
 * `avatarAssetId` (optional) links the character to an asset published
 * through `assets.put`; the kernel verifies the asset exists. `profileId`
 * (optional) rebinds the character to a Configuration profile (waiver 4).
 */
export const UpdateCharacterRequestDtoSchema = Type.Object(
  {
    characterId: Type.String({ format: 'uuid' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
    avatarAssetId: Type.Optional(Type.String({ format: 'uuid' })),
    profileId: Type.Optional(Type.String({ format: 'uuid' })),
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

/**
 * Lorebook entry payload for create/update (`wire.lorebook.entry.input`).
 * Mirrors the runtime `entries_json` object shape the prompt pipeline reads
 * (`crates/runtime-kernel/src/prompt.rs`): `keys`/`secondaryKeys` activation
 * keywords, `constant`/`selective` rules and `enabled`. Unknown entry fields
 * are preserved untouched by the kernel (AGENTS.md §11) — the wire input only
 * names the fields the product owns.
 */
export const LorebookEntryInputSchema = Type.Object(
  {
    keys: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 100,
    }),
    secondaryKeys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
    ),
    content: Type.String({ minLength: 1, maxLength: 20_000 }),
    enabled: Type.Optional(Type.Boolean()),
    constant: Type.Optional(Type.Boolean()),
    selective: Type.Optional(Type.Boolean()),
  },
  { $id: 'wire.lorebook.entry.input', additionalProperties: false },
);
export type LorebookEntryInput = Static<typeof LorebookEntryInputSchema>;

/** Get lorebook request DTO (`wire.request.get-lorebook`). */
export const GetLorebookRequestDtoSchema = Type.Object(
  {
    lorebookId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.get-lorebook', additionalProperties: false },
);
export type GetLorebookRequestDto = Static<typeof GetLorebookRequestDtoSchema>;

/** Create lorebook request DTO (`wire.request.create-lorebook`). Optional
 * `characterId` binds the new book to one character (character↔lorebook
 * scoping, ADR-0047 waiver 2); the kernel validates the character exists. */
export const CreateLorebookRequestDtoSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    entries: Type.Optional(Type.Array(LorebookEntryInputSchema, { maxItems: 1000 })),
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.request.create-lorebook', additionalProperties: false },
);
export type CreateLorebookRequestDto = Static<typeof CreateLorebookRequestDtoSchema>;

/** Update lorebook request DTO (`wire.request.update-lorebook`). Optional
 * `characterId` moves/creates the character↔lorebook link (`null` is not
 * expressible yet — clearing the scope is a follow-up wire extension). */
export const UpdateLorebookRequestDtoSchema = Type.Object(
  {
    lorebookId: Type.String({ format: 'uuid' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    entries: Type.Optional(Type.Array(LorebookEntryInputSchema, { maxItems: 1000 })),
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.request.update-lorebook', additionalProperties: false },
);
export type UpdateLorebookRequestDto = Static<typeof UpdateLorebookRequestDtoSchema>;

/** Delete lorebook request DTO (`wire.request.delete-lorebook`). */
export const DeleteLorebookRequestDtoSchema = Type.Object(
  {
    lorebookId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.delete-lorebook', additionalProperties: false },
);
export type DeleteLorebookRequestDto = Static<typeof DeleteLorebookRequestDtoSchema>;

/** List memories request DTO (`wire.request.list-memories`). Optional filters;
 * `characterId` absent means no character filter (pass `null` scope instead
 * for the global list). */
export const ListMemoriesRequestDtoSchema = Type.Object(
  {
    scope: Type.Optional(WireMemoryScope),
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
    enabled: Type.Optional(Type.Boolean()),
  },
  { $id: 'wire.request.list-memories', additionalProperties: false },
);
export type ListMemoriesRequestDto = Static<typeof ListMemoriesRequestDtoSchema>;

/** Create memory request DTO (`wire.request.create-memory`). */
export const CreateMemoryRequestDtoSchema = Type.Object(
  {
    scope: Type.Optional(WireMemoryScope),
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
    keys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100 }),
    ),
    content: Type.String({ minLength: 1, maxLength: 100000 }),
    enabled: Type.Optional(Type.Boolean()),
    position: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
    metadata: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'wire.request.create-memory', additionalProperties: false },
);
export type CreateMemoryRequestDto = Static<typeof CreateMemoryRequestDtoSchema>;

/** Update memory request DTO (`wire.request.update-memory`). */
export const UpdateMemoryRequestDtoSchema = Type.Object(
  {
    memoryId: Type.String({ format: 'uuid' }),
    scope: Type.Optional(WireMemoryScope),
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
    keys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100 }),
    ),
    content: Type.Optional(Type.String({ minLength: 1, maxLength: 100000 })),
    enabled: Type.Optional(Type.Boolean()),
    position: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
    metadata: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'wire.request.update-memory', additionalProperties: false },
);
export type UpdateMemoryRequestDto = Static<typeof UpdateMemoryRequestDtoSchema>;

/** Delete memory request DTO (`wire.request.delete-memory`). */
export const DeleteMemoryRequestDtoSchema = Type.Object(
  {
    memoryId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.delete-memory', additionalProperties: false },
);
export type DeleteMemoryRequestDto = Static<typeof DeleteMemoryRequestDtoSchema>;

/** List presets request DTO (`wire.request.list-presets`). */
export const ListPresetsRequestDtoSchema = Type.Object(
  {
    kind: Type.Optional(
      Type.String({ minLength: 1, maxLength: 50, pattern: '^[a-z0-9][a-z0-9-]*$' }),
    ),
  },
  { $id: 'wire.request.list-presets', additionalProperties: false },
);
export type ListPresetsRequestDto = Static<typeof ListPresetsRequestDtoSchema>;

/** Get preset request DTO (`wire.request.get-preset`). */
export const GetPresetRequestDtoSchema = Type.Object(
  {
    presetId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.get-preset', additionalProperties: false },
);
export type GetPresetRequestDto = Static<typeof GetPresetRequestDtoSchema>;

/** Create preset request DTO (`wire.request.create-preset`). */
export const CreatePresetRequestDtoSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1, maxLength: 50, pattern: '^[a-z0-9][a-z0-9-]*$' }),
    name: Type.String({ minLength: 1, maxLength: 500 }),
    data: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'wire.request.create-preset', additionalProperties: false },
);
export type CreatePresetRequestDto = Static<typeof CreatePresetRequestDtoSchema>;

/** Update preset request DTO (`wire.request.update-preset`). */
export const UpdatePresetRequestDtoSchema = Type.Object(
  {
    presetId: Type.String({ format: 'uuid' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    data: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'wire.request.update-preset', additionalProperties: false },
);
export type UpdatePresetRequestDto = Static<typeof UpdatePresetRequestDtoSchema>;

/** Delete preset request DTO (`wire.request.delete-preset`). */
export const DeletePresetRequestDtoSchema = Type.Object(
  {
    presetId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.delete-preset', additionalProperties: false },
);
export type DeletePresetRequestDto = Static<typeof DeletePresetRequestDtoSchema>;

/** Get persona request DTO (`wire.request.get-persona`). */
export const GetPersonaRequestDtoSchema = Type.Object(
  {
    personaId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.get-persona', additionalProperties: false },
);
export type GetPersonaRequestDto = Static<typeof GetPersonaRequestDtoSchema>;

/** Create persona request DTO (`wire.request.create-persona`). */
export const CreatePersonaRequestDtoSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    avatar: Type.Optional(Type.String({ minLength: 0, maxLength: 512 })),
    isDefault: Type.Optional(Type.Boolean()),
  },
  { $id: 'wire.request.create-persona', additionalProperties: false },
);
export type CreatePersonaRequestDto = Static<typeof CreatePersonaRequestDtoSchema>;

/** Update persona request DTO (`wire.request.update-persona`). */
export const UpdatePersonaRequestDtoSchema = Type.Object(
  {
    personaId: Type.String({ format: 'uuid' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    description: Type.Optional(Type.String({ minLength: 0, maxLength: 10000 })),
    avatar: Type.Optional(Type.String({ minLength: 0, maxLength: 512 })),
    isDefault: Type.Optional(Type.Boolean()),
  },
  { $id: 'wire.request.update-persona', additionalProperties: false },
);
export type UpdatePersonaRequestDto = Static<typeof UpdatePersonaRequestDtoSchema>;

/** Delete persona request DTO (`wire.request.delete-persona`). */
export const DeletePersonaRequestDtoSchema = Type.Object(
  {
    personaId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.delete-persona', additionalProperties: false },
);
export type DeletePersonaRequestDto = Static<typeof DeletePersonaRequestDtoSchema>;

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
    /**
     * Page order (Этап 2.10). `asc` (default) walks the durable sequence
     * forward from the oldest message; `desc` walks it backward from the
     * newest, matching the UI's message history loading (`order: 'desc'`
     * plus cursor → older pages). Both directions share the opaque
     * `(sequence, id)` cursor encoding.
     */
    order: Type.Optional(
      Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
        'x-wire-unknown-behavior': 'reject',
      }),
    ),
  },
  { $id: 'wire.request.list-messages', additionalProperties: false },
);
export type ListMessagesRequestDto = Static<typeof ListMessagesRequestDtoSchema>;

/** Create chat request DTO (`wire.request.create-chat`). Optional `personaId`
 * links the chat to a user persona (ADR-0047 waiver 5). */
export const CreateChatRequestDtoSchema = Type.Object(
  {
    characterId: Type.String({ format: 'uuid' }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    personaId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.request.create-chat', additionalProperties: false },
);
export type CreateChatRequestDto = Static<typeof CreateChatRequestDtoSchema>;

/** Update chat request DTO (`wire.request.update-chat`). At least one of the
 * optional fields must be present (kernel no-op guards); `personaId` sets or
 * changes the user persona, `title` renames. */
export const UpdateChatRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    personaId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.request.update-chat', additionalProperties: false },
);
export type UpdateChatRequestDto = Static<typeof UpdateChatRequestDtoSchema>;

/** Delete chat request DTO (`wire.request.delete-chat`). */
export const DeleteChatRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.delete-chat', additionalProperties: false },
);
export type DeleteChatRequestDto = Static<typeof DeleteChatRequestDtoSchema>;

/** Create message request DTO (`wire.request.create-message`). */
export const CreateMessageRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    role: WireMessageRole,
    content: Type.String({ minLength: 0, maxLength: 1000000 }),
    generationRunId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.request.create-message', additionalProperties: false },
);
export type CreateMessageRequestDto = Static<typeof CreateMessageRequestDtoSchema>;

/** Update message request DTO (`wire.request.update-message`). */
export const UpdateMessageRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
    /** New content; omitted keeps the current text (meta-only edits). */
    content: Type.Optional(Type.String({ minLength: 0, maxLength: 1000000 })),
    /** Replace the extension metadata object; omitted keeps it unchanged. */
    meta: Type.Optional(WireFreeObjectSchema),
    /** Clear the snapshot checkpoint link (delete-checkpoint). Wire has no
     * nullable field for `checkpointChatId`; an explicit boolean is honest
     * about the mutation (legacy `null` patches map here). */
    clearCheckpointChatId: Type.Optional(Type.Boolean()),
  },
  { $id: 'wire.request.update-message', additionalProperties: false },
);
export type UpdateMessageRequestDto = Static<typeof UpdateMessageRequestDtoSchema>;

/** Delete message request DTO (`wire.request.delete-message`). */
export const DeleteMessageRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.delete-message', additionalProperties: false },
);
export type DeleteMessageRequestDto = Static<typeof DeleteMessageRequestDtoSchema>;

/** Create chat snapshot request DTO (`wire.request.create-chat-snapshot`). */
export const CreateChatSnapshotRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    /** Last message of the frozen prefix (the snapshot copies up to and
     * including this message). */
    messageId: Type.String({ format: 'uuid' }),
    kind: WireSnapshotOrigin,
    /** Optional child chat title; defaults to "<parent title> — <kind>". */
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { $id: 'wire.request.create-chat-snapshot', additionalProperties: false },
);
export type CreateChatSnapshotRequestDto = Static<typeof CreateChatSnapshotRequestDtoSchema>;

/** Create chat snapshot result DTO (`wire.result.chat-snapshot`). */
export const ChatSnapshotResultDtoSchema = Type.Object(
  {
    chat: ChatDtoSchema,
    /** Number of messages copied into the child chat (prefix up to and
     * including the source message). */
    copiedMessages: Type.Integer({ minimum: 0 }),
  },
  { $id: 'wire.result.chat-snapshot', additionalProperties: false },
);
export type ChatSnapshotResultDto = Static<typeof ChatSnapshotResultDtoSchema>;

/** List message variants request DTO (`wire.request.message-variants-list`). */
export const ListMessageVariantsRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.message-variants-list', additionalProperties: false },
);
export type ListMessageVariantsRequestDto = Static<typeof ListMessageVariantsRequestDtoSchema>;

/** Create message variant request DTO (`wire.request.message-variant-create`). */
export const CreateMessageVariantRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
    content: Type.String({ minLength: 0, maxLength: 1000000 }),
  },
  { $id: 'wire.request.message-variant-create', additionalProperties: false },
);
export type CreateMessageVariantRequestDto = Static<typeof CreateMessageVariantRequestDtoSchema>;

/** Delete message variant request DTO (`wire.request.message-variant-delete`). */
export const DeleteMessageVariantRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
    variantId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.message-variant-delete', additionalProperties: false },
);
export type DeleteMessageVariantRequestDto = Static<typeof DeleteMessageVariantRequestDtoSchema>;

/** Activate message variant request DTO (`wire.request.message-variant-activate`). */
export const ActivateMessageVariantRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
    variantId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.message-variant-activate', additionalProperties: false },
);
export type ActivateMessageVariantRequestDto = Static<
  typeof ActivateMessageVariantRequestDtoSchema
>;

/** List message revisions request DTO (`wire.request.message-revisions-list`). */
export const ListMessageRevisionsRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    messageId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.message-revisions-list', additionalProperties: false },
);
export type ListMessageRevisionsRequestDto = Static<typeof ListMessageRevisionsRequestDtoSchema>;

/** Get message draft request DTO (`wire.request.message-draft-get`). */
export const GetMessageDraftRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    draftId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.message-draft-get', additionalProperties: false },
);
export type GetMessageDraftRequestDto = Static<typeof GetMessageDraftRequestDtoSchema>;

/** Save message draft request DTO (`wire.request.message-draft-save`). */
export const SaveMessageDraftRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    draftId: Type.Optional(Type.String({ format: 'uuid' })),
    role: WireMessageRole,
    content: Type.String({ minLength: 0, maxLength: 1000000 }),
    sequence: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { $id: 'wire.request.message-draft-save', additionalProperties: false },
);
export type SaveMessageDraftRequestDto = Static<typeof SaveMessageDraftRequestDtoSchema>;

/** Commit message draft request DTO (`wire.request.message-draft-commit`). */
export const CommitMessageDraftRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    draftId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.message-draft-commit', additionalProperties: false },
);
export type CommitMessageDraftRequestDto = Static<typeof CommitMessageDraftRequestDtoSchema>;

/** Discard message draft request DTO (`wire.request.message-draft-discard`). */
export const DiscardMessageDraftRequestDtoSchema = Type.Object(
  {
    chatId: Type.String({ format: 'uuid' }),
    draftId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.message-draft-discard', additionalProperties: false },
);
export type DiscardMessageDraftRequestDto = Static<typeof DiscardMessageDraftRequestDtoSchema>;

/** List message variants result DTO (`wire.result.message-variant-list`). */
export const ListMessageVariantsResultDtoSchema = Type.Object(
  {
    items: Type.Array(MessageVariantDtoSchema),
  },
  { $id: 'wire.result.message-variant-list', additionalProperties: false },
);
export type ListMessageVariantsResultDto = Static<typeof ListMessageVariantsResultDtoSchema>;

/** List message revisions result DTO (`wire.result.message-revision-list`). */
export const ListMessageRevisionsResultDtoSchema = Type.Object(
  {
    items: Type.Array(MessageRevisionDtoSchema),
  },
  { $id: 'wire.result.message-revision-list', additionalProperties: false },
);
export type ListMessageRevisionsResultDto = Static<typeof ListMessageRevisionsResultDtoSchema>;

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
    Type.Literal('waiting_for_tool'),
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

/**
 * Prompt plan DTOs (`wire.prompt.*`, ТЗ §9.2, Этап 2.6): the kernel's
 * immutable record of what context entered a generation run's provider
 * request — system blocks (character/persona/lorebook), the selected
 * history, the user message, token counts and every excluded message — so
 * the user can inspect what was included or cut.
 */

/** One rendered prompt message (`wire.prompt.message`). */
export const PromptMessageDtoSchema = Type.Object(
  {
    role: WireMessageRole,
    content: Type.String({ minLength: 0, maxLength: 1000000 }),
  },
  { $id: 'wire.prompt.message', additionalProperties: false },
);
export type PromptMessageDto = Static<typeof PromptMessageDtoSchema>;

/** One system block source shown to the user (`wire.prompt.block`). */
export const PromptBlockDtoSchema = Type.Object(
  {
    source: Type.Union(
      [
        Type.Literal('character'),
        Type.Literal('persona'),
        Type.Literal('lorebook'),
        Type.Literal('memory'),
        Type.Literal('instruct'),
      ],
      { 'x-wire-unknown-behavior': 'reject' },
    ),
    text: Type.String({ minLength: 0, maxLength: 1000000 }),
  },
  { $id: 'wire.prompt.block', additionalProperties: false },
);
export type PromptBlockDto = Static<typeof PromptBlockDtoSchema>;

/** One message excluded from the plan (`wire.prompt.excluded`). */
export const PromptExcludedDtoSchema = Type.Object(
  {
    messageId: Type.String({ format: 'uuid' }),
    reason: Type.Union([Type.Literal('token_budget')], { 'x-wire-unknown-behavior': 'reject' }),
  },
  { $id: 'wire.prompt.excluded', additionalProperties: false },
);
export type PromptExcludedDto = Static<typeof PromptExcludedDtoSchema>;

/**
 * Prompt plan DTO (`wire.prompt.plan`): the durable plan of one generation
 * run. `approximateTokens: true` means the tokenizer is a local heuristic
 * (no model-specific tokenizer yet). `overBudget` means the plan still
 * exceeds the available window after dropping all unpinned history.
 */
export const PromptPlanDtoSchema = Type.Object(
  {
    runId: Type.String({ format: 'uuid' }),
    chatId: Type.String({ format: 'uuid' }),
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 0, maxLength: 128 }),
    instructFormat: Type.String({ minLength: 1, maxLength: 128 }),
    tokenizerProfile: Type.String({ minLength: 1, maxLength: 128 }),
    approximateTokens: Type.Boolean(),
    contextLimit: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
    responseReserved: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
    inputTokens: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
    overBudget: Type.Boolean(),
    userName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    systemBlocks: Type.Array(PromptBlockDtoSchema),
    messages: Type.Array(PromptMessageDtoSchema),
    excluded: Type.Array(PromptExcludedDtoSchema),
    createdAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.prompt.plan', additionalProperties: false },
);
export type PromptPlanDto = Static<typeof PromptPlanDtoSchema>;

/** Get prompt plan request DTO (`wire.request.get-prompt-plan`). */
export const GetPromptPlanRequestDtoSchema = Type.Object(
  {
    runId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.get-prompt-plan', additionalProperties: false },
);
export type GetPromptPlanRequestDto = Static<typeof GetPromptPlanRequestDtoSchema>;

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

/**
 * Provider capability declaration (`wire.provider.capabilities`) — ТЗ §9.3.
 * The kernel negotiates BEFORE any network request: a capability the run
 * needs but the adapter does not declare surfaces as
 * `CAPABILITY_UNAVAILABLE`, never as a silent semantic downgrade.
 */
export const ProviderCapabilitiesDtoSchema = Type.Object(
  {
    tools: Type.Boolean(),
    vision: Type.Boolean(),
    thinking: Type.Boolean(),
    jsonMode: Type.Boolean(),
    streaming: Type.Boolean(),
  },
  { $id: 'wire.provider.capabilities', additionalProperties: false },
);
export type ProviderCapabilitiesDto = Static<typeof ProviderCapabilitiesDtoSchema>;

/** Provider DTO (`wire.provider.dto`) — ТЗ §55/§60 normalized surface. */
export const ProviderDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    builtin: Type.Boolean(),
    availability: ProviderAvailabilitySchema,
    capabilities: ProviderCapabilitiesDtoSchema,
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

/**
 * Provider config DTO (`wire.provider.config.dto`) — a stored provider
 * instance. `config` holds non-secret settings only; the secret (e.g. API
 * key) is stored in the SecretStore and is **never** part of any DTO —
 * `hasApiKey` is the only observable signal.
 */
export const ProviderConfigDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    provider: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    name: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    config: Type.Object({}, { additionalProperties: true }),
    hasApiKey: Type.Boolean(),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.provider.config.dto', additionalProperties: false },
);
export type ProviderConfigDto = Static<typeof ProviderConfigDtoSchema>;

/** List provider configs result DTO (`wire.result.list-provider-configs`). */
export const ListProviderConfigsResultDtoSchema = Type.Object(
  {
    items: Type.Array(ProviderConfigDtoSchema),
  },
  { $id: 'wire.result.list-provider-configs', additionalProperties: false },
);
export type ListProviderConfigsResultDto = Static<typeof ListProviderConfigsResultDtoSchema>;

/** Set provider config request DTO (`wire.request.set-provider-config`). */
export const SetProviderConfigRequestDtoSchema = Type.Object(
  {
    provider: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    name: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    config: Type.Optional(Type.Object({}, { additionalProperties: true })),
    apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 100000 })),
  },
  { $id: 'wire.request.set-provider-config', additionalProperties: false },
);
export type SetProviderConfigRequestDto = Static<typeof SetProviderConfigRequestDtoSchema>;

/** Get provider config request DTO (`wire.request.get-provider-config`). */
export const GetProviderConfigRequestDtoSchema = Type.Object(
  {
    provider: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    name: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
  },
  { $id: 'wire.request.get-provider-config', additionalProperties: false },
);
export type GetProviderConfigRequestDto = Static<typeof GetProviderConfigRequestDtoSchema>;

/** List provider configs request DTO (`wire.request.list-provider-configs`). */
export const ListProviderConfigsRequestDtoSchema = Type.Object(
  {
    provider: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' })),
  },
  { $id: 'wire.request.list-provider-configs', additionalProperties: false },
);
export type ListProviderConfigsRequestDto = Static<typeof ListProviderConfigsRequestDtoSchema>;

/** Delete provider config request DTO (`wire.request.delete-provider-config`). */
export const DeleteProviderConfigRequestDtoSchema = Type.Object(
  {
    provider: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    name: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
  },
  { $id: 'wire.request.delete-provider-config', additionalProperties: false },
);
export type DeleteProviderConfigRequestDto = Static<typeof DeleteProviderConfigRequestDtoSchema>;

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

/** One durable activation-journal entry (ТЗ §10.3, `wire.data.activation-entry`).
 * Statuses mirror the storage journal: `prepared`, `validated`,
 * `activation_pending`, `committed`, `rolled_back`. Root references are
 * reported as absolute paths (diagnostics; the journal itself stores
 * portable relative references). */
export const DataActivationEntryDtoSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    kind: Type.Union(
      [
        Type.Literal('restore'),
        Type.Literal('migration'),
        Type.Literal('import'),
        Type.Literal('rollback'),
      ],
      { 'x-wire-unknown-behavior': 'reject' },
    ),
    status: Type.Union(
      [
        Type.Literal('prepared'),
        Type.Literal('validated'),
        Type.Literal('activation_pending'),
        Type.Literal('committed'),
        Type.Literal('rolled_back'),
      ],
      { 'x-wire-unknown-behavior': 'reject' },
    ),
    fromRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    toRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
    error: Type.Optional(Type.String({ maxLength: 4096 })),
  },
  { $id: 'wire.data.activation-entry', additionalProperties: false },
);
export type DataActivationEntryDto = Static<typeof DataActivationEntryDtoSchema>;

/** A pending (not yet committed) activation, `wire.data.activation-pending`.
 * `activation_pending` in the journal is the recovery source of truth
 * (Windows restart-to-complete, ТЗ §10.3.1); the v1 flat layout reports a
 * restore candidate marker instead. */
export const DataActivationPendingDtoSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('restore'), Type.Literal('migration')], {
      'x-wire-unknown-behavior': 'reject',
    }),
    entryId: Type.String({ minLength: 1, maxLength: 64 }),
    createdAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.data.activation-pending', additionalProperties: false },
);
export type DataActivationPendingDto = Static<typeof DataActivationPendingDtoSchema>;

/** Data-root activation status (`wire.result.data.activation-status`,
 * ТЗ §10.2–§10.3): which layout version the data root uses, which root is
 * active, the full durable journal and whether an activation is pending.
 * Strictly read-only — the UI renders the honest state, never mutates. */
export const DataActivationStatusResultDtoSchema = Type.Object(
  {
    layoutVersion: Type.Integer({ minimum: 1, maximum: 2 }),
    activeRootId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    activeRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    journalFormat: Type.String({ minLength: 1, maxLength: 64 }),
    journalFormatVersion: Type.Integer({ minimum: 1 }),
    entries: Type.Array(DataActivationEntryDtoSchema),
    pending: Type.Optional(DataActivationPendingDtoSchema),
  },
  { $id: 'wire.result.data.activation-status', additionalProperties: false },
);
export type DataActivationStatusResultDto = Static<typeof DataActivationStatusResultDtoSchema>;

/** List lorebooks request DTO (`wire.request.list-lorebooks`). Optional
 * `characterId` filters to the books bound to one character
 * (character↔lorebook scoping, ADR-0047 waiver 2); absent means all books
 * (the shared library). */
export const ListLorebooksRequestDtoSchema = Type.Object(
  {
    characterId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.request.list-lorebooks', additionalProperties: false },
);
export type ListLorebooksRequestDto = Static<typeof ListLorebooksRequestDtoSchema>;

/** List lorebooks result DTO (`wire.result.list-lorebooks`). */
export const ListLorebooksResultDtoSchema = Type.Object(
  {
    items: Type.Array(LorebookDtoSchema),
  },
  { $id: 'wire.result.list-lorebooks', additionalProperties: false },
);
export type ListLorebooksResultDto = Static<typeof ListLorebooksResultDtoSchema>;

/**
 * Lorebook entry DTO (`wire.lorebook.entry.dto`). One entry of a book, as the
 * wire exposes it: the stable `id` plus the product-owned fields
 * (keys/secondaryKeys/content/enabled/constant/selective). Position and
 * metadata stay inside the stored `entries_json` and are not wire fields yet
 * (Этап 4 follow-up), so the UI receives only what the contract owns.
 */
export const LorebookEntryDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    keys: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 100,
    }),
    secondaryKeys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
    ),
    content: Type.String({ minLength: 1, maxLength: 20_000 }),
    enabled: Type.Boolean(),
    constant: Type.Boolean(),
    selective: Type.Boolean(),
  },
  { $id: 'wire.lorebook.entry.dto', additionalProperties: false },
);
export type LorebookEntryDto = Static<typeof LorebookEntryDtoSchema>;

/**
 * Lorebook entry partial-update payload (`wire.lorebook.entry.patch`). Every
 * field is optional; only the provided ones are replaced. The entry `id` is
 * in the request path, not here.
 */
export const LorebookEntryPatchSchema = Type.Object(
  {
    keys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
    ),
    secondaryKeys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
    ),
    content: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
    enabled: Type.Optional(Type.Boolean()),
    constant: Type.Optional(Type.Boolean()),
    selective: Type.Optional(Type.Boolean()),
  },
  { $id: 'wire.lorebook.entry.patch', additionalProperties: false },
);
export type LorebookEntryPatch = Static<typeof LorebookEntryPatchSchema>;

/** List lorebook entries request DTO (`wire.request.list-lorebook-entries`). */
export const ListLorebookEntriesRequestDtoSchema = Type.Object(
  {
    lorebookId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.list-lorebook-entries', additionalProperties: false },
);
export type ListLorebookEntriesRequestDto = Static<typeof ListLorebookEntriesRequestDtoSchema>;

/** Create lorebook entry request DTO (`wire.request.create-lorebook-entry`). */
export const CreateLorebookEntryRequestDtoSchema = Type.Object(
  {
    lorebookId: Type.String({ format: 'uuid' }),
    entry: LorebookEntryInputSchema,
  },
  { $id: 'wire.request.create-lorebook-entry', additionalProperties: false },
);
export type CreateLorebookEntryRequestDto = Static<typeof CreateLorebookEntryRequestDtoSchema>;

/** Update lorebook entry request DTO (`wire.request.update-lorebook-entry`). */
export const UpdateLorebookEntryRequestDtoSchema = Type.Object(
  {
    lorebookId: Type.String({ format: 'uuid' }),
    entryId: Type.String({ format: 'uuid' }),
    patch: LorebookEntryPatchSchema,
  },
  { $id: 'wire.request.update-lorebook-entry', additionalProperties: false },
);
export type UpdateLorebookEntryRequestDto = Static<typeof UpdateLorebookEntryRequestDtoSchema>;

/** Delete lorebook entry request DTO (`wire.request.delete-lorebook-entry`). */
export const DeleteLorebookEntryRequestDtoSchema = Type.Object(
  {
    lorebookId: Type.String({ format: 'uuid' }),
    entryId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.delete-lorebook-entry', additionalProperties: false },
);
export type DeleteLorebookEntryRequestDto = Static<typeof DeleteLorebookEntryRequestDtoSchema>;

/** List lorebook entries result DTO (`wire.result.list-lorebook-entries`). */
export const ListLorebookEntriesResultDtoSchema = Type.Object(
  {
    items: Type.Array(LorebookEntryDtoSchema),
  },
  { $id: 'wire.result.list-lorebook-entries', additionalProperties: false },
);
export type ListLorebookEntriesResultDto = Static<typeof ListLorebookEntriesResultDtoSchema>;

/** List presets result DTO (`wire.result.list-presets`). */
export const ListPresetsResultDtoSchema = Type.Object(
  {
    items: Type.Array(PresetDtoSchema),
  },
  { $id: 'wire.result.list-presets', additionalProperties: false },
);
export type ListPresetsResultDto = Static<typeof ListPresetsResultDtoSchema>;

/** List memories result DTO (`wire.result.list-memories`). */
export const ListMemoriesResultDtoSchema = Type.Object(
  {
    items: Type.Array(MemoryDtoSchema),
  },
  { $id: 'wire.result.list-memories', additionalProperties: false },
);
export type ListMemoriesResultDto = Static<typeof ListMemoriesResultDtoSchema>;

/** List personas result DTO (`wire.result.list-personas`). */
export const ListPersonasResultDtoSchema = Type.Object(
  {
    items: Type.Array(PersonaDtoSchema),
  },
  { $id: 'wire.result.list-personas', additionalProperties: false },
);
export type ListPersonasResultDto = Static<typeof ListPersonasResultDtoSchema>;

/**
 * Profile export request DTO (`wire.request.profile-export`). An export is a
 * logical allowlist container (SEC-02): only product entities are exported,
 * secrets/provider configs/session data are never part of the container.
 * `profileId` (optional) scopes the export to one Configuration profile
 * (ADR-0047 waiver 4): only the profile's characters (and, transitively,
 * their chats and messages) are exported; lorebooks and presets are the
 * shared library and are always included. An unknown profile id is
 * `PROFILE_NOT_FOUND`.
 */
export const ProfileExportRequestDtoSchema = Type.Object(
  {
    includeAssets: Type.Optional(Type.Boolean()),
    profileId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.request.profile-export', additionalProperties: false },
);
export type ProfileExportRequestDto = Static<typeof ProfileExportRequestDtoSchema>;

/** Per-section record counts of a profile export (`wire.result.profile-export`). */
export const ProfileExportCountsDtoSchema = Type.Object(
  {
    characters: Type.Integer({ minimum: 0 }),
    chats: Type.Integer({ minimum: 0 }),
    messages: Type.Integer({ minimum: 0 }),
    lorebooks: Type.Integer({ minimum: 0 }),
    presets: Type.Integer({ minimum: 0 }),
  },
  { $id: 'wire.profile-export.counts', additionalProperties: false },
);
export type ProfileExportCountsDto = Static<typeof ProfileExportCountsDtoSchema>;

/**
 * Profile export result DTO (`wire.result.profile-export`): the verified
 * container's metadata. The container itself is written by the kernel under
 * the data root's `exports/` directory; `containerPath` is relative to the
 * data root so hosts can resolve and stream it without transport-specific
 * knowledge of the archive format. `profileId` echoes the optional request
 * scope (absent = full library export).
 */
export const ProfileExportResultDtoSchema = Type.Object(
  {
    containerPath: Type.String({ minLength: 1, maxLength: 512 }),
    formatVersion: Type.Integer({ minimum: 1 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    records: ProfileExportCountsDtoSchema,
    assets: Type.Integer({ minimum: 0 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    manifestSha256: Type.String({ minLength: 64, maxLength: 64 }),
    profileId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.result.profile-export', additionalProperties: false },
);
export type ProfileExportResultDto = Static<typeof ProfileExportResultDtoSchema>;

/**
 * Settings item DTO (`wire.settings.item`): one non-secret application
 * setting. Values are JSON objects (the wire has no untyped JSON scalar);
 * scalar preferences are wrapped at the UI boundary, e.g.
 * `{ "value": "dark" }`. Secrets NEVER live here — provider keys live in the
 * SecretStore (ТЗ §9.4, SEC-01).
 */
export const SettingsItemDtoSchema = Type.Object(
  {
    key: Type.String({ pattern: '^[a-z][a-z0-9._-]{1,127}$' }),
    value: Type.Object({}, { additionalProperties: true }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.settings.item', additionalProperties: false },
);
export type SettingsItemDto = Static<typeof SettingsItemDtoSchema>;

/** Settings snapshot DTO (`wire.result.settings`). */
export const ResultSettingsDtoSchema = Type.Object(
  {
    items: Type.Array(SettingsItemDtoSchema, { maxItems: 64 }),
  },
  { $id: 'wire.result.settings', additionalProperties: false },
);
export type ResultSettingsDto = Static<typeof ResultSettingsDtoSchema>;

/** `settings.get` request DTO (`wire.request.settings.get`): absent `keys` = all. */
export const GetSettingsRequestDtoSchema = Type.Object(
  {
    keys: Type.Optional(
      Type.Array(Type.String({ pattern: '^[a-z][a-z0-9._-]{1,127}$' }), { maxItems: 64 }),
    ),
  },
  { $id: 'wire.request.settings.get', additionalProperties: false },
);
export type GetSettingsRequestDto = Static<typeof GetSettingsRequestDtoSchema>;

/** `settings.update` request DTO (`wire.request.settings.update`). */
export const UpdateSettingsRequestDtoSchema = Type.Object(
  {
    settings: Type.Array(
      Type.Object(
        {
          key: Type.String({ pattern: '^[a-z][a-z0-9._-]{1,127}$' }),
          value: Type.Object({}, { additionalProperties: true }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 64 },
    ),
  },
  { $id: 'wire.request.settings.update', additionalProperties: false },
);
export type UpdateSettingsRequestDto = Static<typeof UpdateSettingsRequestDtoSchema>;

/**
 * Diagnostics export result DTO (`wire.result.diagnostics-export`) — SEC-07:
 * an ALLOWLIST diagnostic bundle. It carries versions, counts and setting
 * keys/values AFTER central redaction; it never includes provider configs,
 * secret references or message content. `redaction: 'allowlist'` is a
 * contract constant.
 */
export const DiagnosticsExportResultDtoSchema = Type.Object(
  {
    generatedAt: Type.String({ format: 'rfc3339' }),
    traceId: Type.String({ format: 'uuid' }),
    schemaHash: Type.String({ minLength: 64, maxLength: 64 }),
    schemaRevision: Type.Integer({ minimum: 0 }),
    storageFormat: Type.Optional(Type.Integer({ minimum: 0 })),
    sqliteVersion: Type.String({ minLength: 1, maxLength: 64 }),
    appVersion: Type.String({ minLength: 1, maxLength: 64 }),
    wireVersion: Type.Object(
      {
        major: Type.Integer({ minimum: 1 }),
        minor: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    redaction: Type.Literal('allowlist'),
    sections: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 16 }),
    settings: Type.Object(
      {
        count: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    generationRuns: Type.Object(
      {
        total: Type.Integer({ minimum: 0 }),
        completed: Type.Integer({ minimum: 0 }),
        failed: Type.Integer({ minimum: 0 }),
        waiting: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'wire.result.diagnostics-export', additionalProperties: false },
);
export type DiagnosticsExportResultDto = Static<typeof DiagnosticsExportResultDtoSchema>;

/**
 * Secrets status result DTO (`wire.result.secrets-status`) — SEC-01.1: the
 * canonical, VALUE-FREE surface for the secret backend. It reports which
 * explicit mode is active (portable encrypted / machine-bound / session-only
 * / unavailable), whether it persists and is writable, the record count and
 * the portable `secrets.enc` format version. Secret VALUES never cross this
 * DTO — the UI uses it to render the honest mode state and the
 * `SECRET_UNAVAILABLE` / `SECRET_UNAVAILABLE_ON_THIS_DEVICE` flows, never to
 * read secrets.
 */
export const SecretsStatusResultDtoSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1, maxLength: 64 }),
    persistent: Type.Boolean(),
    writable: Type.Boolean(),
    available: Type.Boolean(),
    recordCount: Type.Integer({ minimum: 0 }),
    formatVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: 'wire.result.secrets-status', additionalProperties: false },
);
export type SecretsStatusResultDto = Static<typeof SecretsStatusResultDtoSchema>;

/**
 * Asset DTO (`wire.assets.item`) — metadata of an immutable content-
 * addressed asset published into the canonical data root's `assets/`
 * directory (ТЗ §5.1 AssetStore port, AGENTS.md §12). The `relativeKey` is
 * the managed key `<kind>/<sha256>[.<ext>]`; the bytes are served through
 * `assets.content`. Metadata only — never embeds content.
 */
export const AssetDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    kind: Type.String({ pattern: '^[a-z][a-z0-9.-]*$', minLength: 1, maxLength: 64 }),
    relativeKey: Type.String({ minLength: 1, maxLength: 512 }),
    checksumSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.assets.item', additionalProperties: false },
);
export type AssetDto = Static<typeof AssetDtoSchema>;

/**
 * Asset publish request (`wire.request.assets.put`) — uploads an immutable
 * asset. `kind` matches the storage grammar (`avatar`, `card`, ...),
 * `filename` contributes only its extension to the content-derived managed
 * key, and `contentBase64` is standard base64 of the bytes. Publishing the
 * same bytes under the same `kind` again is an idempotent re-import: the
 * existing record is returned with `deduplicated: true` (AGENTS.md §11:
 * re-running an import must not create duplicates).
 */
export const PutAssetRequestDtoSchema = Type.Object(
  {
    kind: Type.String({ pattern: '^[a-z][a-z0-9.-]*$', minLength: 1, maxLength: 64 }),
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    contentType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    contentBase64: Type.String({
      pattern: '^[A-Za-z0-9+/]*={0,2}$',
      minLength: 1,
    }),
  },
  { $id: 'wire.request.assets.put', additionalProperties: false },
);
export type PutAssetRequestDto = Static<typeof PutAssetRequestDtoSchema>;

/** Asset publish result (`wire.result.assets.put`). */
export const PutAssetResultDtoSchema = Type.Object(
  {
    asset: AssetDtoSchema,
    deduplicated: Type.Boolean(),
    deduplicatedFromId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.result.assets.put', additionalProperties: false },
);
export type PutAssetResultDto = Static<typeof PutAssetResultDtoSchema>;

/** Asset metadata read request (`wire.request.assets.get`). */
export const GetAssetRequestDtoSchema = Type.Object(
  {
    assetId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.assets.get', additionalProperties: false },
);
export type GetAssetRequestDto = Static<typeof GetAssetRequestDtoSchema>;

/** Asset metadata result (`wire.result.assets.get`). */
export const GetAssetResultDtoSchema = Type.Object(
  {
    asset: AssetDtoSchema,
  },
  { $id: 'wire.result.assets.get', additionalProperties: false },
);
export type GetAssetResultDto = Static<typeof GetAssetResultDtoSchema>;

/** Asset content read request (`wire.request.assets.content`). */
export const GetAssetContentRequestDtoSchema = Type.Object(
  {
    assetId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.assets.content', additionalProperties: false },
);
export type GetAssetContentRequestDto = Static<typeof GetAssetContentRequestDtoSchema>;

/**
 * Asset content result (`wire.result.assets.content`). Base64 of the
 * original bytes (AGENTS.md §12: originals are never lossy-compressed). The
 * wire response limit caps the servable size; larger assets are addressed
 * by `relativeKey` through host transports.
 */
export const GetAssetContentResultDtoSchema = Type.Object(
  {
    assetId: Type.String({ format: 'uuid' }),
    contentType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    contentBase64: Type.String({
      pattern: '^[A-Za-z0-9+/]*={0,2}$',
      minLength: 1,
    }),
  },
  { $id: 'wire.result.assets.content', additionalProperties: false },
);
export type GetAssetContentResultDto = Static<typeof GetAssetContentResultDtoSchema>;

/** Asset delete request (`wire.request.assets.delete`). */
export const DeleteAssetRequestDtoSchema = Type.Object(
  {
    assetId: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.assets.delete', additionalProperties: false },
);
export type DeleteAssetRequestDto = Static<typeof DeleteAssetRequestDtoSchema>;

/** Plugin package-trust states (ТЗ §SEC-05, mirrored from `PluginPackageTrust`). */
export const PluginTrustStateSchema = Type.Union(
  [
    Type.Literal('built-in'),
    Type.Literal('verified-publisher'),
    Type.Literal('locally-trusted'),
    Type.Literal('unsigned-untrusted'),
  ],
  { 'x-wire-unknown-behavior': 'reject' },
);
export type PluginTrustState = Static<typeof PluginTrustStateSchema>;

/**
 * Plugin DTO (`wire.plugins.item`) — the DURABLE lifecycle state of one
 * installed plugin (ТЗ §8.1 Extensions, Этап 4 slice 6). Records the
 * version, `enabled` flag, package-trust state and publisher key
 * fingerprint (SEC-05), the GRANTED permission set (the install/update
 * request is the consent moment) and the opaque manifest. It carries NO
 * code, NO secrets and NO runtime handles — execution and cleanup live in
 * the isolated host executor behind the versioned capability protocol.
 */
export const PluginDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    enabled: Type.Boolean(),
    trustState: PluginTrustStateSchema,
    publisherKeyId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    permissions: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64 }),
    lastErrorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    installedAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
    manifest: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'wire.plugins.item', additionalProperties: false },
);
export type PluginDto = Static<typeof PluginDtoSchema>;

/** Plugin list result (`wire.result.plugins.list`). */
export const ListPluginsResultDtoSchema = Type.Object(
  {
    items: Type.Array(PluginDtoSchema, { maxItems: 256 }),
  },
  { $id: 'wire.result.plugins.list', additionalProperties: false },
);
export type ListPluginsResultDto = Static<typeof ListPluginsResultDtoSchema>;

/**
 * Plugin install request (`wire.request.plugins.install`). The host has
 * ALREADY verified the package (publisher signature + per-file digest,
 * ZIP path-traversal/symlink/bomb rejection — SEC-05) before this op runs;
 * the kernel durably records the verified trust state, version and the
 * GRANTED permission set (the install/update request is the consent
 * moment). Re-installing the same id+version is idempotent; a version
 * change that would LOWER the recorded trust rank is rejected (Conflict).
 */
export const InstallPluginRequestDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    trustState: PluginTrustStateSchema,
    publisherKeyId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    permissions: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64 }),
    manifest: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'wire.request.plugins.install', additionalProperties: false },
);
export type InstallPluginRequestDto = Static<typeof InstallPluginRequestDtoSchema>;

/** Plugin install result (`wire.result.plugins.install`). */
export const InstallPluginResultDtoSchema = Type.Object(
  {
    plugin: PluginDtoSchema,
  },
  { $id: 'wire.result.plugins.install', additionalProperties: false },
);
export type InstallPluginResultDto = Static<typeof InstallPluginResultDtoSchema>;

/** Plugin uninstall request (`wire.request.plugins.uninstall`). */
export const UninstallPluginRequestDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
  },
  { $id: 'wire.request.plugins.uninstall', additionalProperties: false },
);
export type UninstallPluginRequestDto = Static<typeof UninstallPluginRequestDtoSchema>;

/** Plugin enable request (`wire.request.plugins.enable`). */
export const EnablePluginRequestDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
  },
  { $id: 'wire.request.plugins.enable', additionalProperties: false },
);
export type EnablePluginRequestDto = Static<typeof EnablePluginRequestDtoSchema>;

/** Plugin disable request (`wire.request.plugins.disable`). */
export const DisablePluginRequestDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
  },
  { $id: 'wire.request.plugins.disable', additionalProperties: false },
);
export type DisablePluginRequestDto = Static<typeof DisablePluginRequestDtoSchema>;

/**
 * Theme DTO (`wire.themes.item`) — the DURABLE lifecycle state of one
 * installed theme (ТЗ §5.2 theme-sdk, §SEC-05, Этап 4 slice 6 part 2). A
 * theme is DATA, never code: the opaque manifest plus a content-addressed
 * CSS asset reference (`cssAssetId` → an asset published through
 * `assets.put` with kind `theme-css`, existence validated by the kernel at
 * install). The single `active` flag names the applied theme; uninstalling
 * the active theme clears it so the shell falls back to the default
 * (AGENTS.md §19: a broken theme must never block the interface reset).
 * SEC-05 trust state is recorded like for plugins; the row holds no CSS
 * bytes, no chats access, no keys (AGENTS.md §19).
 */
export const ThemeDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    active: Type.Boolean(),
    trustState: PluginTrustStateSchema,
    publisherKeyId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    cssAssetId: Type.Optional(Type.String({ format: 'uuid' })),
    installedAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
    manifest: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'wire.themes.item', additionalProperties: false },
);
export type ThemeDto = Static<typeof ThemeDtoSchema>;

/** Theme list result (`wire.result.themes.list`). */
export const ListThemesResultDtoSchema = Type.Object(
  {
    items: Type.Array(ThemeDtoSchema, { maxItems: 256 }),
  },
  { $id: 'wire.result.themes.list', additionalProperties: false },
);
export type ListThemesResultDto = Static<typeof ListThemesResultDtoSchema>;

/**
 * Theme install request (`wire.request.themes.install`). Like
 * `plugins.install`: the host has ALREADY verified the package (SEC-05)
 * and published the CSS through `assets.put` (kind `theme-css`) before
 * this op runs; the kernel durably records the verified trust state and
 * version. Re-installing the same id+version is idempotent; a version
 * change that would LOWER the recorded trust rank is rejected (Conflict).
 * Install never activates a theme — activation is an explicit separate
 * consent.
 */
export const InstallThemeRequestDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    trustState: PluginTrustStateSchema,
    publisherKeyId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    cssAssetId: Type.Optional(Type.String({ format: 'uuid' })),
    manifest: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'wire.request.themes.install', additionalProperties: false },
);
export type InstallThemeRequestDto = Static<typeof InstallThemeRequestDtoSchema>;

/** Theme install result (`wire.result.themes.install`). */
export const InstallThemeResultDtoSchema = Type.Object(
  {
    theme: ThemeDtoSchema,
  },
  { $id: 'wire.result.themes.install', additionalProperties: false },
);
export type InstallThemeResultDto = Static<typeof InstallThemeResultDtoSchema>;

/** Theme uninstall request (`wire.request.themes.uninstall`). */
export const UninstallThemeRequestDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
  },
  { $id: 'wire.request.themes.uninstall', additionalProperties: false },
);
export type UninstallThemeRequestDto = Static<typeof UninstallThemeRequestDtoSchema>;

/** Theme activate request (`wire.request.themes.activate`). */
export const ActivateThemeRequestDtoSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
  },
  { $id: 'wire.request.themes.activate', additionalProperties: false },
);
export type ActivateThemeRequestDto = Static<typeof ActivateThemeRequestDtoSchema>;

/**
 * Profile DTO (`wire.profiles.item`) — one named user context of the
 * canonical Configuration bounded context (ТЗ §8.1 Configuration, Этап 4
 * slice 5 remainder part 2). Mirrors the legacy minimal shape
 * (`profiles.id/name/created_at`) plus `updated_at` for renames; a profile
 * row is a named context, nothing references it yet. Per-profile FK
 * columns on product tables and SEC-02 export filtering (ADR-0047 waiver
 * 4) are the slice-5 remainder follow-up this model unblocks.
 */
export const ProfileDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    createdAt: Type.String({ format: 'rfc3339' }),
    updatedAt: Type.String({ format: 'rfc3339' }),
  },
  { $id: 'wire.profiles.item', additionalProperties: false },
);
export type ProfileDto = Static<typeof ProfileDtoSchema>;

/** Profile list result (`wire.result.profiles.list`). */
export const ListProfilesResultDtoSchema = Type.Object(
  {
    items: Type.Array(ProfileDtoSchema, { maxItems: 256 }),
  },
  { $id: 'wire.result.profiles.list', additionalProperties: false },
);
export type ListProfilesResultDto = Static<typeof ListProfilesResultDtoSchema>;

/** Profile create request (`wire.request.profiles.create`). */
export const CreateProfileRequestDtoSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { $id: 'wire.request.profiles.create', additionalProperties: false },
);
export type CreateProfileRequestDto = Static<typeof CreateProfileRequestDtoSchema>;

/** Profile create result (`wire.result.profiles.create`). */
export const CreateProfileResultDtoSchema = Type.Object(
  {
    profile: ProfileDtoSchema,
  },
  { $id: 'wire.result.profiles.create', additionalProperties: false },
);
export type CreateProfileResultDto = Static<typeof CreateProfileResultDtoSchema>;

/** Profile rename request (`wire.request.profiles.rename`). */
export const RenameProfileRequestDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { $id: 'wire.request.profiles.rename', additionalProperties: false },
);
export type RenameProfileRequestDto = Static<typeof RenameProfileRequestDtoSchema>;

/** Profile delete request (`wire.request.profiles.delete`). */
export const DeleteProfileRequestDtoSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
  },
  { $id: 'wire.request.profiles.delete', additionalProperties: false },
);
export type DeleteProfileRequestDto = Static<typeof DeleteProfileRequestDtoSchema>;

/**
 * Every wire schema keyed by its `$id` (schemaId): all DTOs plus the error
 * DTO, the message role union and the three envelopes. This is the complete
 * schema registry the codegen tool and `compileWireContract` operate on.
 */
export const WIRE_SCHEMAS: Record<string, TSchema> = {
  'wire.meta.dto': MetaDtoSchema,
  'wire.free-object': WireFreeObjectSchema,
  'wire.character.dto': CharacterDtoSchema,
  'wire.chat.dto': ChatDtoSchema,
  'wire.message.role': WireMessageRole,
  'wire.message.dto': MessageDtoSchema,
  'wire.backup.dto': BackupDtoSchema,
  'wire.lorebook.dto': LorebookDtoSchema,
  'wire.preset.dto': PresetDtoSchema,
  'wire.memory.scope': WireMemoryScope,
  'wire.memory.dto': MemoryDtoSchema,
  'wire.persona.dto': PersonaDtoSchema,
  'wire.paged.characters': PagedCharactersDtoSchema,
  'wire.paged.chats': PagedChatsDtoSchema,
  'wire.paged.messages': PagedMessagesDtoSchema,
  'wire.generation.event': WireGenerationEvent,
  'wire.generation.status': WireGenerationStatus,
  'wire.generation.run': GenerationRunDtoSchema,
  'wire.provider.availability': ProviderAvailabilitySchema,
  'wire.provider.model': ProviderModelDtoSchema,
  'wire.provider.dto': ProviderDtoSchema,
  'wire.provider.capabilities': ProviderCapabilitiesDtoSchema,
  'wire.result.list-providers': ListProvidersResultDtoSchema,
  'wire.provider.config.dto': ProviderConfigDtoSchema,
  'wire.result.list-provider-configs': ListProviderConfigsResultDtoSchema,
  'wire.request.profile-export': ProfileExportRequestDtoSchema,
  'wire.result.profile-export': ProfileExportResultDtoSchema,
  'wire.profile-export.counts': ProfileExportCountsDtoSchema,
  'wire.settings.item': SettingsItemDtoSchema,
  'wire.result.settings': ResultSettingsDtoSchema,
  'wire.request.settings.get': GetSettingsRequestDtoSchema,
  'wire.request.settings.update': UpdateSettingsRequestDtoSchema,
  'wire.result.diagnostics-export': DiagnosticsExportResultDtoSchema,
  'wire.result.secrets-status': SecretsStatusResultDtoSchema,
  'wire.assets.item': AssetDtoSchema,
  'wire.request.assets.put': PutAssetRequestDtoSchema,
  'wire.result.assets.put': PutAssetResultDtoSchema,
  'wire.request.imports.character.card': CharacterCardImportRequestDtoSchema,
  'wire.card.export.format': WireCardExportFormat,
  'wire.request.characters.export.card': CharacterCardExportRequestDtoSchema,
  'wire.result.characters.export.card': CharacterCardExportResultDtoSchema,
  'wire.request.chats.export': ChatsExportRequestDtoSchema,
  'wire.result.chats.export': ChatsExportResultDtoSchema,
  'wire.result.imports.character.card': CharacterCardImportResultDtoSchema,
  'wire.request.assets.get': GetAssetRequestDtoSchema,
  'wire.result.assets.get': GetAssetResultDtoSchema,
  'wire.request.assets.content': GetAssetContentRequestDtoSchema,
  'wire.result.assets.content': GetAssetContentResultDtoSchema,
  'wire.request.assets.delete': DeleteAssetRequestDtoSchema,
  'wire.plugins.item': PluginDtoSchema,
  'wire.result.plugins.list': ListPluginsResultDtoSchema,
  'wire.request.plugins.install': InstallPluginRequestDtoSchema,
  'wire.result.plugins.install': InstallPluginResultDtoSchema,
  'wire.request.plugins.uninstall': UninstallPluginRequestDtoSchema,
  'wire.request.plugins.enable': EnablePluginRequestDtoSchema,
  'wire.request.plugins.disable': DisablePluginRequestDtoSchema,
  'wire.themes.item': ThemeDtoSchema,
  'wire.result.themes.list': ListThemesResultDtoSchema,
  'wire.request.themes.install': InstallThemeRequestDtoSchema,
  'wire.result.themes.install': InstallThemeResultDtoSchema,
  'wire.request.themes.uninstall': UninstallThemeRequestDtoSchema,
  'wire.request.themes.activate': ActivateThemeRequestDtoSchema,
  'wire.profiles.item': ProfileDtoSchema,
  'wire.result.profiles.list': ListProfilesResultDtoSchema,
  'wire.request.profiles.create': CreateProfileRequestDtoSchema,
  'wire.result.profiles.create': CreateProfileResultDtoSchema,
  'wire.request.profiles.rename': RenameProfileRequestDtoSchema,
  'wire.request.profiles.delete': DeleteProfileRequestDtoSchema,
  'wire.request.set-provider-config': SetProviderConfigRequestDtoSchema,
  'wire.request.get-provider-config': GetProviderConfigRequestDtoSchema,
  'wire.request.list-provider-configs': ListProviderConfigsRequestDtoSchema,
  'wire.request.delete-provider-config': DeleteProviderConfigRequestDtoSchema,
  'wire.error.dto': ProductErrorDtoSchema,
  'wire.request.empty': EmptyRequestDtoSchema,
  'wire.request.list-characters': ListCharactersRequestDtoSchema,
  'wire.request.get-character': GetCharacterRequestDtoSchema,
  'wire.request.create-character': CreateCharacterRequestDtoSchema,
  'wire.request.update-character': UpdateCharacterRequestDtoSchema,
  'wire.request.delete-character': DeleteCharacterRequestDtoSchema,
  'wire.request.get-lorebook': GetLorebookRequestDtoSchema,
  'wire.request.list-lorebooks': ListLorebooksRequestDtoSchema,
  'wire.request.create-lorebook': CreateLorebookRequestDtoSchema,
  'wire.request.update-lorebook': UpdateLorebookRequestDtoSchema,
  'wire.request.delete-lorebook': DeleteLorebookRequestDtoSchema,
  'wire.lorebook.entry.input': LorebookEntryInputSchema,
  'wire.lorebook.entry.dto': LorebookEntryDtoSchema,
  'wire.lorebook.entry.patch': LorebookEntryPatchSchema,
  'wire.request.list-lorebook-entries': ListLorebookEntriesRequestDtoSchema,
  'wire.request.create-lorebook-entry': CreateLorebookEntryRequestDtoSchema,
  'wire.request.update-lorebook-entry': UpdateLorebookEntryRequestDtoSchema,
  'wire.request.delete-lorebook-entry': DeleteLorebookEntryRequestDtoSchema,
  'wire.result.list-lorebook-entries': ListLorebookEntriesResultDtoSchema,
  'wire.request.list-memories': ListMemoriesRequestDtoSchema,
  'wire.request.create-memory': CreateMemoryRequestDtoSchema,
  'wire.request.update-memory': UpdateMemoryRequestDtoSchema,
  'wire.request.delete-memory': DeleteMemoryRequestDtoSchema,
  'wire.request.list-presets': ListPresetsRequestDtoSchema,
  'wire.request.get-preset': GetPresetRequestDtoSchema,
  'wire.request.create-preset': CreatePresetRequestDtoSchema,
  'wire.request.update-preset': UpdatePresetRequestDtoSchema,
  'wire.request.delete-preset': DeletePresetRequestDtoSchema,
  'wire.request.get-persona': GetPersonaRequestDtoSchema,
  'wire.request.create-persona': CreatePersonaRequestDtoSchema,
  'wire.request.update-persona': UpdatePersonaRequestDtoSchema,
  'wire.request.delete-persona': DeletePersonaRequestDtoSchema,
  'wire.request.list-chats': ListChatsRequestDtoSchema,
  'wire.request.get-chat': GetChatRequestDtoSchema,
  'wire.request.create-chat': CreateChatRequestDtoSchema,
  'wire.request.update-chat': UpdateChatRequestDtoSchema,
  'wire.request.delete-chat': DeleteChatRequestDtoSchema,
  'wire.request.list-messages': ListMessagesRequestDtoSchema,
  'wire.request.create-message': CreateMessageRequestDtoSchema,
  'wire.request.update-message': UpdateMessageRequestDtoSchema,
  'wire.request.delete-message': DeleteMessageRequestDtoSchema,
  'wire.snapshot.origin': WireSnapshotOrigin,
  'wire.request.create-chat-snapshot': CreateChatSnapshotRequestDtoSchema,
  'wire.result.chat-snapshot': ChatSnapshotResultDtoSchema,
  'wire.message.variant.dto': MessageVariantDtoSchema,
  'wire.message.revision.dto': MessageRevisionDtoSchema,
  'wire.message.draft.dto': MessageDraftDtoSchema,
  'wire.request.message-variants-list': ListMessageVariantsRequestDtoSchema,
  'wire.request.message-variant-create': CreateMessageVariantRequestDtoSchema,
  'wire.request.message-variant-delete': DeleteMessageVariantRequestDtoSchema,
  'wire.request.message-variant-activate': ActivateMessageVariantRequestDtoSchema,
  'wire.request.message-revisions-list': ListMessageRevisionsRequestDtoSchema,
  'wire.request.message-draft-get': GetMessageDraftRequestDtoSchema,
  'wire.request.message-draft-save': SaveMessageDraftRequestDtoSchema,
  'wire.request.message-draft-commit': CommitMessageDraftRequestDtoSchema,
  'wire.request.message-draft-discard': DiscardMessageDraftRequestDtoSchema,
  'wire.result.message-variant-list': ListMessageVariantsResultDtoSchema,
  'wire.result.message-revision-list': ListMessageRevisionsResultDtoSchema,
  'wire.request.start-generation': StartGenerationRequestDtoSchema,
  'wire.request.cancel-generation': CancelGenerationRequestDtoSchema,
  'wire.request.get-generation-run': GetGenerationRunRequestDtoSchema,
  'wire.request.retry-generation': RetryGenerationRequestDtoSchema,
  'wire.request.keep-partial-generation': KeepPartialGenerationRequestDtoSchema,
  'wire.request.discard-generation': DiscardGenerationRequestDtoSchema,
  'wire.request.list-generation-events': ListGenerationEventsRequestDtoSchema,
  'wire.prompt.message': PromptMessageDtoSchema,
  'wire.prompt.block': PromptBlockDtoSchema,
  'wire.prompt.excluded': PromptExcludedDtoSchema,
  'wire.prompt.plan': PromptPlanDtoSchema,
  'wire.request.get-prompt-plan': GetPromptPlanRequestDtoSchema,
  'wire.generation.step': GenerationStepDtoSchema,
  'wire.generation.step.type': WireGenerationStepType,
  'wire.generation.step.status': WireGenerationStepStatus,
  'wire.tool.spec': ToolSpecDtoSchema,
  'wire.result.list-tools': ListToolsResultDtoSchema,
  'wire.tool.call': ToolCallDtoSchema,
  'wire.request.generation-tool-result': GenerationToolResultRequestDtoSchema,
  'wire.result.empty': EmptyResultDtoSchema,
  'wire.result.list-backups': ListBackupsResultDtoSchema,
  'wire.data.activation-entry': DataActivationEntryDtoSchema,
  'wire.data.activation-pending': DataActivationPendingDtoSchema,
  'wire.result.data.activation-status': DataActivationStatusResultDtoSchema,
  'wire.paged.generation-events': PagedGenerationEventsDtoSchema,
  'wire.result.list-lorebooks': ListLorebooksResultDtoSchema,
  'wire.result.list-presets': ListPresetsResultDtoSchema,
  'wire.result.list-memories': ListMemoriesResultDtoSchema,
  'wire.result.list-personas': ListPersonasResultDtoSchema,
  'wire.request.envelope': RequestEnvelopeSchema,
  'wire.response.envelope': ResponseEnvelopeSchema,
  'wire.event.envelope': EventEnvelopeSchema,
};
