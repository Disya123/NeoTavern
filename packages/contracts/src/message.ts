/**
 * Chat message schemas.
 *
 * Messages live in a chat and belong to a branch (for branching conversations).
 * `parentId` forms the message tree within a branch.
 */
import { Type, type Static } from '@sinclair/typebox';
import { CursorPageQuerySchema, IdSchema, TimestampSchema } from './common.js';

export const MessageRoleSchema = Type.Union([
  Type.Literal('system'),
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('tool'),
  Type.Literal('plugin'),
]);
export type MessageRole = Static<typeof MessageRoleSchema>;

/** Enumerable form of {@link MessageRole} (DUP-21: no hand-rewritten unions). */
export const MessageRoles = ['system', 'user', 'assistant', 'tool', 'plugin'] as const;

/**
 * Roles user-authored prompt content can use. `tool` is pipeline-owned and
 * deliberately excluded (DUP-22): editors offering a role picker use this
 * named subset instead of rewriting unions by hand.
 */
export const PromptAuthoringRoles = ['system', 'user', 'assistant'] as const;
export type PromptAuthoringRole = (typeof PromptAuthoringRoles)[number];

/**
 * Idempotency key for chat writes (rev4 stage 3, outbox). Callers retrying a
 * request after a network failure reuse the key; the server returns the
 * original result instead of duplicating the message.
 */
export const IdempotencyKeySchema = Type.String({ minLength: 1, maxLength: 128 });
export type IdempotencyKey = Static<typeof IdempotencyKeySchema>;

export const MessageSchema = Type.Object({
  id: IdSchema,
  chatId: IdSchema,
  branchId: IdSchema,
  parentId: Type.Union([IdSchema, Type.Null()]),
  role: MessageRoleSchema,
  content: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  /** Extension metadata / tool-call data / variant info. */
  meta: Type.Record(Type.String(), Type.Unknown()),
  createdAt: TimestampSchema,
  /**
   * Compare-and-swap version (rev4 stage 3). Every successful update bumps
   * it; writers that pass `expectedRevision` get `MESSAGE_CONFLICT` instead
   * of silently clobbering a concurrent edit.
   */
  revision: Type.Integer({ minimum: 1 }),
  /** Milliseconds since epoch of the last update (null when never updated). */
  updatedAt: Type.Union([TimestampSchema, Type.Null()]),
  /**
   * Total number of stored variants including the active content
   * (`variantCount >= 1` once the migration backfill has run). The active
   * content lives in `content`; the remaining `variantCount - 1` variants
   * are archived in `message_variants`.
   */
  variantCount: Type.Integer({ minimum: 0, default: 0 }),
  /**
   * Position of the active content within the variant permutation
   * (0-based). Null before the swipe-history migration backfilled it.
   */
  activeVariantPosition: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /** Number of archived manual content revisions; the active text is the next position. */
  contentRevisionCount: Type.Integer({ minimum: 0, default: 0 }),
  /** Child chat created as a checkpoint of this message (null when unset). */
  checkpointChatId: Type.Union([IdSchema, Type.Null()]),
});
export type Message = Static<typeof MessageSchema>;

export const MessageCreateSchema = Type.Object({
  role: MessageRoleSchema,
  content: Type.String(),
  parentId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** Deduplication key: a retried create with the same key returns the original message. */
  idempotencyKey: Type.Optional(IdempotencyKeySchema),
});
export type MessageCreate = Static<typeof MessageCreateSchema>;

export const MessageUpdateSchema = Type.Object({
  content: Type.Optional(Type.String()),
  role: Type.Optional(MessageRoleSchema),
  meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /**
   * CAS guard: when present the update only applies if the stored revision
   * still matches; otherwise the server answers `MESSAGE_CONFLICT` with the
   * current revision.
   */
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Unlink the checkpoint flag (`null`) or repoint it to another child chat. */
  checkpointChatId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
});
export type MessageUpdate = Static<typeof MessageUpdateSchema>;

// ── Generation metadata (stored under `meta.generation`) ───────────────────
//
// Generation runs persist their terminal bookkeeping as a typed object inside
// the open `meta` record, so no schema/DB migration is needed: old messages
// simply lack `meta.generation`, and the safe parser below returns null for
// them. The legacy top-level `meta.model` stays in place for compatibility
// with messages written before generation metadata existed.

/** Token usage of a single generation run (same shape as `TokenUsage`). */
export const MessageGenerationUsageSchema = Type.Object({
  promptTokens: Type.Integer({ minimum: 0 }),
  completionTokens: Type.Integer({ minimum: 0 }),
  totalTokens: Type.Integer({ minimum: 0 }),
});
export type MessageGenerationUsage = Static<typeof MessageGenerationUsageSchema>;

/**
 * Terminal generation bookkeeping persisted on the assistant message under
 * `meta.generation`. `providerConfigId`/`providerKind` are null when the
 * built-in echo fallback produced the reply (no configured provider);
 * `providerSource` mirrors the audit's resolution of `settings.source`
 * (string or null); `usage` is null when the provider reported none.
 */
export const MessageGenerationMetaSchema = Type.Object({
  generationId: Type.String({ minLength: 1, maxLength: 128 }),
  providerConfigId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  providerKind: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  providerSource: Type.Union([Type.String(), Type.Null()]),
  model: Type.String({ minLength: 1 }),
  durationMs: Type.Integer({ minimum: 0 }),
  usage: Type.Union([MessageGenerationUsageSchema, Type.Null()]),
});
export type MessageGenerationMeta = Static<typeof MessageGenerationMetaSchema>;

/**
 * Safe parser: null for missing/malformed values, never throws.
 *
 * Strict on every known field (wrong types, missing fields, or a partial
 * `usage` object all yield null), but lenient about unknown extra keys at the
 * top level: `meta` is an open `Record`, so a future field inside
 * `meta.generation` must not break readers of messages written today.
 */
export function parseMessageGenerationMeta(value: unknown): MessageGenerationMeta | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const generationId = record['generationId'];
  if (typeof generationId !== 'string' || generationId.length < 1 || generationId.length > 128) {
    return null;
  }
  const providerConfigId = record['providerConfigId'];
  if (
    providerConfigId !== null &&
    (typeof providerConfigId !== 'string' || providerConfigId.length < 1)
  ) {
    return null;
  }
  const providerKind = record['providerKind'];
  if (providerKind !== null && (typeof providerKind !== 'string' || providerKind.length < 1)) {
    return null;
  }
  const providerSource = record['providerSource'];
  if (providerSource !== null && typeof providerSource !== 'string') {
    return null;
  }
  const model = record['model'];
  if (typeof model !== 'string' || model.length < 1) return null;
  const durationMs = record['durationMs'];
  if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs < 0) {
    return null;
  }

  let usage: MessageGenerationUsage | null = null;
  if (record['usage'] !== null) {
    const usageValue = record['usage'];
    if (typeof usageValue !== 'object' || usageValue === null || Array.isArray(usageValue)) {
      return null;
    }
    const usageRecord = usageValue as Record<string, unknown>;
    const promptTokens = usageRecord['promptTokens'];
    const completionTokens = usageRecord['completionTokens'];
    const totalTokens = usageRecord['totalTokens'];
    if (
      typeof promptTokens !== 'number' ||
      !Number.isInteger(promptTokens) ||
      promptTokens < 0 ||
      typeof completionTokens !== 'number' ||
      !Number.isInteger(completionTokens) ||
      completionTokens < 0 ||
      typeof totalTokens !== 'number' ||
      !Number.isInteger(totalTokens) ||
      totalTokens < 0
    ) {
      return null;
    }
    usage = { promptTokens, completionTokens, totalTokens };
  }

  return {
    generationId,
    providerConfigId,
    providerKind,
    providerSource,
    model,
    durationMs,
    usage,
  };
}

// ── Draft / streaming messages (rev4 stage 3) ──────────────────────────────
//
// Streaming writers (plugin drafts) no longer PATCH a committed message row
// up to 10×/s. They write into a server-side draft object instead: the host
// flush rate stays an internal policy, committed messages never exist in a
// half-written state, and a crashed writer leaves a swept draft — never a
// lingering empty message.

/** Server-side streaming draft (role/content/sequence CAS). */
export const MessageDraftSchema = Type.Object({
  id: IdSchema,
  chatId: IdSchema,
  branchId: IdSchema,
  role: MessageRoleSchema,
  content: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  meta: Type.Record(Type.String(), Type.Unknown()),
  /** Monotonic writer sequence; stale PATCHes (≤ stored) are idempotent no-ops. */
  sequence: Type.Integer({ minimum: 0 }),
  /** CAS version; every applied PATCH bumps it. */
  revision: Type.Integer({ minimum: 1 }),
  /** Set once the draft has been committed (commit is retry-safe). */
  committedMessageId: Type.Union([IdSchema, Type.Null()]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type MessageDraft = Static<typeof MessageDraftSchema>;

export const MessageDraftCreateSchema = Type.Object({
  role: Type.Optional(MessageRoleSchema),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type MessageDraftCreate = Static<typeof MessageDraftCreateSchema>;

export const MessageDraftUpdateSchema = Type.Object({
  content: Type.Optional(Type.String()),
  role: Type.Optional(MessageRoleSchema),
  /** Writer sequence; a PATCH with sequence ≤ the stored one is a no-op. */
  sequence: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type MessageDraftUpdate = Static<typeof MessageDraftUpdateSchema>;

export const MessageDraftCommitResultSchema = Type.Object({
  messageId: IdSchema,
  /** True when the commit was already applied (retry after success). */
  alreadyCommitted: Type.Boolean(),
});
export type MessageDraftCommitResult = Static<typeof MessageDraftCommitResultSchema>;

/**
 * An alternative take ("swipe") for a message. Regeneration archives the
 * previous reply as a variant instead of destroying it (ТЗ §10.2).
 */
export const MessageVariantSchema = Type.Object({
  id: IdSchema,
  messageId: IdSchema,
  /** 0-based position in the variant permutation (migration 0020 backfill). */
  position: Type.Integer({ minimum: 0 }),
  content: Type.String(),
  createdAt: TimestampSchema,
});
export type MessageVariant = Static<typeof MessageVariantSchema>;

/**
 * An immutable previous text of a message created by a manual content edit or
 * a non-destructive restore. Swipe variants use MessageVariantSchema instead.
 */
export const MessageContentRevisionSchema = Type.Object({
  id: IdSchema,
  messageId: IdSchema,
  /** 0-based chronological position; active text follows the last archived position. */
  position: Type.Integer({ minimum: 0 }),
  content: Type.String(),
  /** Time at which this text became the active message content. */
  createdAt: TimestampSchema,
});
export type MessageContentRevision = Static<typeof MessageContentRevisionSchema>;

/** Cursor-paginated newest-first history request. */
export const MessageRevisionListQuerySchema = CursorPageQuerySchema;
export type MessageRevisionListQuery = Static<typeof MessageRevisionListQuerySchema>;

/** CAS guard required when restoring an archived text. */
export const MessageRevisionRestoreSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
});
export type MessageRevisionRestore = Static<typeof MessageRevisionRestoreSchema>;

/**
 * Message page query. Old messages are loaded in batches (AGENTS.md §13).
 * Default order is descending (newest first) for efficient "open chat and show
 * the last N messages"; the client reverses for display.
 */
export const MessageListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  branchId: Type.Optional(IdSchema),
  order: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
});
export type MessageListQuery = Static<typeof MessageListQuerySchema>;
