import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';
import { MessageRoleSchema } from './message.js';
import { GenerationMessageSchema, TokenUsageSchema } from './provider.js';

export const PromptContextExclusionReasonSchema = Type.Union([
  Type.Literal('disabled'),
  Type.Literal('empty'),
  Type.Literal('manual'),
  Type.Literal('context-shift'),
  Type.Literal('final-budget'),
  Type.Literal('interceptor'),
  Type.Literal('model-mismatch'),
  Type.Literal('none'),
]);
export type PromptContextExclusionReason = Static<typeof PromptContextExclusionReasonSchema>;

export const PromptContextAuditEntrySchema = Type.Object(
  {
    identifier: Type.String({ minLength: 1, maxLength: 512 }),
    name: Type.Optional(Type.String({ maxLength: 512 })),
    role: MessageRoleSchema,
    source: Type.String({ minLength: 1, maxLength: 128 }),
    content: Type.String(),
    tokens: Type.Integer({ minimum: 0 }),
    included: Type.Boolean(),
    exclusionReason: PromptContextExclusionReasonSchema,
    order: Type.Integer({ minimum: 0, maximum: 499 }),
  },
  { additionalProperties: false },
);
export type PromptContextAuditEntry = Static<typeof PromptContextAuditEntrySchema>;

export const PromptContextAuditStatusSchema = Type.Union([
  Type.Literal('prepared'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);
export type PromptContextAuditStatus = Static<typeof PromptContextAuditStatusSchema>;

export const PromptContextAuditSchema = Type.Object(
  {
    generationId: IdSchema,
    chatId: IdSchema,
    providerConfigId: Type.Union([IdSchema, Type.Null()]),
    providerKind: Type.String({ minLength: 1, maxLength: 128 }),
    providerSource: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
    model: Type.String({ minLength: 1, maxLength: 1000 }),
    createdAt: TimestampSchema,
    status: PromptContextAuditStatusSchema,
    errorCode: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    chatTemplateId: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
    promptTemplateId: Type.Union([IdSchema, Type.Null()]),
    promptTemplateMode: Type.Union([Type.Literal('chat'), Type.Literal('text')]),
    tokenizer: Type.Object(
      {
        profile: Type.String({ minLength: 1, maxLength: 512 }),
        approximate: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    budget: Type.Object(
      {
        contextLimit: Type.Integer({ minimum: 1 }),
        reservedForReply: Type.Integer({ minimum: 0 }),
        promptTokens: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    contextStrategy: Type.String({ minLength: 1, maxLength: 128 }),
    entries: Type.Array(PromptContextAuditEntrySchema, { maxItems: 500 }),
    providerMessages: Type.Array(GenerationMessageSchema, { maxItems: 500 }),
    diagnostics: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 500 }),
    usage: Type.Union([TokenUsageSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type PromptContextAudit = Static<typeof PromptContextAuditSchema>;

export const PromptContextAuditResponseSchema = Type.Object(
  { audit: Type.Union([PromptContextAuditSchema, Type.Null()]) },
  { additionalProperties: false },
);
export type PromptContextAuditResponse = Static<typeof PromptContextAuditResponseSchema>;

const NewChatPromptContextPreviewRequestSchema = Type.Object(
  {
    characterId: IdSchema,
    userMessage: Type.String({ maxLength: 2_000_000 }),
    providerConfigId: Type.Optional(IdSchema),
    /** Chat-level persona override, mirroring real generation (ARCH-13). */
    personaId: Type.Optional(IdSchema),
  },
  { additionalProperties: false },
);

const ExistingChatPromptContextPreviewRequestSchema = Type.Object(
  {
    chatId: IdSchema,
    userMessage: Type.String({ maxLength: 2_000_000 }),
    providerConfigId: Type.Optional(IdSchema),
  },
  { additionalProperties: false },
);

/** Input for a side-effect-free preview of a new or existing conversation. */
export const PromptContextPreviewRequestSchema = Type.Union([
  NewChatPromptContextPreviewRequestSchema,
  ExistingChatPromptContextPreviewRequestSchema,
]);
export type PromptContextPreviewRequest = Static<typeof PromptContextPreviewRequestSchema>;

/**
 * Pipeline output needed by context meters. Unlike an audit, a preview has no
 * generation/chat identity because it is never persisted or sent upstream.
 */
export const PromptContextPreviewSchema = Type.Pick(PromptContextAuditSchema, [
  'providerConfigId',
  'providerKind',
  'providerSource',
  'model',
  'chatTemplateId',
  'promptTemplateId',
  'promptTemplateMode',
  'tokenizer',
  'budget',
  'contextStrategy',
  'entries',
  'providerMessages',
  'diagnostics',
]);
export type PromptContextPreview = Static<typeof PromptContextPreviewSchema>;

export const PromptContextPreviewResponseSchema = Type.Object(
  { preview: PromptContextPreviewSchema },
  { additionalProperties: false },
);
export type PromptContextPreviewResponse = Static<typeof PromptContextPreviewResponseSchema>;
