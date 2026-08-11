/**
 * Provider configuration and generation contracts.
 *
 * API keys are NEVER part of a response schema. Config responses expose only
 * `hasApiKey`; creation/update accept an opaque `apiKey` that the server stores
 * separately and redacts from logs (AGENTS.md §4).
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';
import { MessageRoleSchema } from './message.js';
import { PromptTriggerIdSchema } from './promptTemplate.js';

/**
 * Provider kind. Kept as an open string because plugins may register new
 * provider kinds via the Provider SDK; built-in kinds are listed in
 * {@link BuiltinProviderKinds}.
 */
export const BuiltinProviderKinds = [
  'openai-compatible',
  'anthropic',
  'text-completion',
  'novelai',
  'ai-horde',
  'koboldai',
  'echo',
] as const;
export const ProviderKindSchema = Type.String({ minLength: 1 });
export type ProviderKind = Static<typeof ProviderKindSchema>;

export const ProviderSourceIds = [
  'nanogpt',
  'openai',
  'openai-compatible',
  'anthropic',
  'deepseek',
  'google-ai-studio',
  'groq',
  'fireworks-ai',
  'cohere',
  'mistralai',
  'chutes',
  'electron-hub',
  // Text-completion backends (classic SillyTavern "Text Completion" API).
  'text-completion',
  'ooba',
  'koboldcpp',
  'vllm',
  'ollama',
  // Standalone classic SillyTavern backends.
  'novelai',
  'ai-horde',
  'koboldai',
] as const;
export const ProviderSourceIdSchema = Type.Union(
  ProviderSourceIds.map((source) => Type.Literal(source)),
);
export type ProviderSourceId = Static<typeof ProviderSourceIdSchema>;

/**
 * Adapter kinds that consume a serialized text prompt rather than a chat
 * message array (the pipeline forces `serializeAsText` for them; see
 * docs/prompt-pipeline). This is the single classifier — the previous
 * source-id twin (`TextCompletionSourceIds`) had drifted out of sync and was
 * unused (PROV-33 L6).
 */
export const TextAdapterKinds = ['text-completion', 'novelai', 'ai-horde', 'koboldai'] as const;
export type TextAdapterKind = (typeof TextAdapterKinds)[number];

export const GenerationParameterIds = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'seed',
  'reasoning',
  'reasoningEffort',
  'topK',
  'minP',
  'topA',
  'repetitionPenalty',
] as const;
export const GenerationParameterIdSchema = Type.Union(
  GenerationParameterIds.map((parameter) => Type.Literal(parameter)),
);
export type GenerationParameterId = Static<typeof GenerationParameterIdSchema>;

/**
 * Provider-neutral superset of reasoning effort values.
 *
 * Individual models support only a subset. Keeping the complete set in the
 * shared request contract lets OpenAI-compatible providers expose new model
 * levels without requiring an unsafe custom-body override.
 */
export const ReasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const ReasoningEffortSchema = Type.Union(
  ReasoningEfforts.map((effort) => Type.Literal(effort)),
);
export type ReasoningEffort = Static<typeof ReasoningEffortSchema>;

/** Public capabilities and safe defaults for a connection source. */
export const ProviderCatalogEntrySchema = Type.Object(
  {
    id: ProviderSourceIdSchema,
    adapterKind: Type.Union([
      Type.Literal('openai-compatible'),
      Type.Literal('anthropic'),
      Type.Literal('text-completion'),
      Type.Literal('novelai'),
      Type.Literal('ai-horde'),
      Type.Literal('koboldai'),
    ]),
    defaultBaseUrl: Type.Union([Type.String({ format: 'uri' }), Type.Null()]),
    apiKeyRequired: Type.Boolean(),
    baseUrlEditable: Type.Boolean(),
    samplerSupport: Type.Array(GenerationParameterIdSchema, { uniqueItems: true }),
    /** Provider-level accepted reasoning effort values; models may expose a subset. */
    reasoningEfforts: Type.Optional(Type.Array(ReasoningEffortSchema, { uniqueItems: true })),
  },
  { additionalProperties: false },
);
export type ProviderCatalogEntry = Static<typeof ProviderCatalogEntrySchema>;

export const ProviderCatalogResponseSchema = Type.Object(
  {
    items: Type.Array(ProviderCatalogEntrySchema),
  },
  { additionalProperties: false },
);
export type ProviderCatalogResponse = Static<typeof ProviderCatalogResponseSchema>;

/** Public provider configuration (no secret material). */
export const ProviderConfigSchema = Type.Object({
  id: IdSchema,
  kind: ProviderKindSchema,
  name: Type.String(),
  baseUrl: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  enabled: Type.Boolean(),
  /** True when a secret key is configured; the value itself is never exposed. */
  hasApiKey: Type.Boolean(),
  settings: Type.Record(Type.String(), Type.Unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ProviderConfig = Static<typeof ProviderConfigSchema>;

export const ProviderConfigCreateSchema = Type.Object({
  kind: ProviderKindSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  baseUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  enabled: Type.Optional(Type.Boolean()),
  /** Secret — accepted on write only, never returned. */
  apiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ProviderConfigCreate = Static<typeof ProviderConfigCreateSchema>;

export const ProviderConfigUpdateSchema = Type.Partial(ProviderConfigCreateSchema);
export type ProviderConfigUpdate = Static<typeof ProviderConfigUpdateSchema>;

export const ModelInfoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  contextLimit: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type ModelInfo = Static<typeof ModelInfoSchema>;

/** A single message in a generation request (clean message array). */
export const GenerationMessageSchema = Type.Object({
  role: MessageRoleSchema,
  content: Type.String(),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type GenerationMessage = Static<typeof GenerationMessageSchema>;

/** Parameters for a generation request to a provider adapter. */
export const GenerationRequestSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  messages: Type.Array(GenerationMessageSchema),
  maxTokens: Type.Integer({ minimum: 1, maximum: 200000, default: 1024 }),
  temperature: Type.Number({ minimum: 0, maximum: 2, default: 1 }),
  topP: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  topK: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
  minP: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  topA: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  repetitionPenalty: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  frequencyPenalty: Type.Optional(Type.Number({ minimum: -2, maximum: 2 })),
  presencePenalty: Type.Optional(Type.Number({ minimum: -2, maximum: 2 })),
  seed: Type.Optional(Type.Integer({ minimum: -1, maximum: 2147483647 })),
  reasoning: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  stop: Type.Optional(Type.Array(Type.String())),
  /**
   * Provider-neutral assistant prefill. Adapters serialize it as the beginning
   * of the assistant turn; the host prepends it to the streamed/saved reply.
   * Plugin adapters must explicitly opt in before a connection profile using
   * this field can be applied.
   */
  assistantPrefill: Type.Optional(Type.String({ maxLength: 2048 })),
  stream: Type.Boolean({ default: true }),
});
export type GenerationRequest = Static<typeof GenerationRequestSchema>;

/**
 * Numeric bounds for generation parameters (DUP-21): the schema above and the
 * UI sliders/inputs must share ONE table, or a changed ceiling silently
 * desynchronizes client validation from server rejection.
 */
export interface GenerationParameterBound {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export const GENERATION_PARAMETER_BOUNDS = [
  { id: 'maxTokens', min: 1, max: 200_000, step: 1 },
  { id: 'temperature', min: 0, max: 2, step: 0.01 },
  { id: 'topP', min: 0, max: 1, step: 0.01 },
  { id: 'topK', min: 0, max: 100_000, step: 1 },
  { id: 'minP', min: 0, max: 1, step: 0.01 },
  { id: 'topA', min: 0, max: 1, step: 0.01 },
  { id: 'repetitionPenalty', min: 0, max: 2, step: 0.01 },
  { id: 'frequencyPenalty', min: -2, max: 2, step: 0.01 },
  { id: 'presencePenalty', min: -2, max: 2, step: 0.01 },
  { id: 'seed', min: -1, max: 2_147_483_647, step: 1 },
] as const satisfies readonly GenerationParameterBound[];

/** Saved generation values cannot replace the provider model or pipeline messages. */
export const GenerationDefaultsSchema = Type.Partial(
  Type.Omit(GenerationRequestSchema, ['model', 'messages', 'assistantPrefill']),
);
export type GenerationDefaults = Static<typeof GenerationDefaultsSchema>;

/**
 * Additional request parameters stored on a provider config's `settings`
 * (classic SillyTavern "Additional Parameters"). Unlike ST1 these are stored as
 * **structured JSON** rather than YAML: `customIncludeBody` is merged into the
 * request body, `customExcludeBody` lists body keys to drop, and
 * `customIncludeHeaders` adds request headers. The transform is applied by the
 * provider adapters; the server validates shapes here so a malformed value is
 * rejected at write time instead of at generation time.
 */
export const CustomIncludeBodySchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 256 }),
  Type.Unknown(),
);
export type CustomIncludeBody = Static<typeof CustomIncludeBodySchema>;

export const CustomExcludeBodySchema = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
  maxItems: 128,
});
export type CustomExcludeBody = Static<typeof CustomExcludeBodySchema>;

export const CustomIncludeHeadersSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 256 }),
  Type.String({ maxLength: 4096 }),
);
export type CustomIncludeHeaders = Static<typeof CustomIncludeHeadersSchema>;

/**
 * Header names that custom include-headers may never override. Protects the
 * authorization credential and the content negotiation the adapters control.
 */
export const FORBIDDEN_CUSTOM_HEADERS = [
  'authorization',
  'content-type',
  'content-length',
] as const;

/**
 * Request-body keys owned by the adapters. Overriding them via
 * `customIncludeBody` (or dropping them via `customExcludeBody`) would
 * silently desynchronize the wire format from what the adapter parses — e.g.
 * `stream: false` makes the provider answer with JSON while the adapter keeps
 * parsing SSE, producing an empty generation reported as success — and would
 * falsify the model recorded in the prompt-context audit.
 */
export const RESERVED_CUSTOM_BODY_KEYS = [
  'stream',
  'stream_options',
  'model',
  'messages',
  'prompt',
  'input',
] as const;

/** Machine-readable reason for an additional-parameters validation failure. */
export type AdditionalParamIssueCode =
  | 'bodyNotObject'
  | 'excludeNotStringArray'
  | 'headersNotObject'
  | 'headerValueNotString'
  | 'forbiddenHeader'
  | 'reservedBodyKey'
  | 'reservedExcludeKey';

export interface AdditionalParamIssue {
  /** Dotted path inside the provider config, e.g. `settings.customIncludeBody`. */
  path: string;
  code: AdditionalParamIssueCode;
  /** Human-readable English description (server error envelope / logs). */
  message: string;
  /** Structured details, e.g. `{ name: 'Authorization' }` or `{ key: 'stream' }`. */
  params?: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the SillyTavern-style "Additional Parameters" found on a provider
 * config's `settings`. Single source of truth shared by the server (write-time
 * rejection) and the web editor (fast local feedback) — see ADR-0008. Shapes
 * are enforced so a malformed value fails at write time, not at generation
 * time; forbidden headers protect the credential, reserved body keys protect
 * the adapter-owned wire format.
 */
export function additionalParamIssues(settings: Record<string, unknown>): AdditionalParamIssue[] {
  const issues: AdditionalParamIssue[] = [];

  const includeBody = settings['customIncludeBody'];
  if (includeBody !== undefined) {
    if (!isPlainRecord(includeBody)) {
      issues.push({
        path: 'settings.customIncludeBody',
        code: 'bodyNotObject',
        message: 'must be a JSON object',
      });
    } else {
      for (const key of Object.keys(includeBody)) {
        if ((RESERVED_CUSTOM_BODY_KEYS as readonly string[]).includes(key)) {
          issues.push({
            path: 'settings.customIncludeBody',
            code: 'reservedBodyKey',
            message: `body key "${key}" is controlled by the adapter and cannot be overridden`,
            params: { key },
          });
        }
      }
    }
  }

  const excludeBody = settings['customExcludeBody'];
  if (excludeBody !== undefined) {
    if (!Array.isArray(excludeBody) || excludeBody.some((key) => typeof key !== 'string')) {
      issues.push({
        path: 'settings.customExcludeBody',
        code: 'excludeNotStringArray',
        message: 'must be an array of strings',
      });
    } else {
      for (const key of excludeBody) {
        if ((RESERVED_CUSTOM_BODY_KEYS as readonly string[]).includes(key)) {
          issues.push({
            path: 'settings.customExcludeBody',
            code: 'reservedExcludeKey',
            message: `body key "${key}" is controlled by the adapter and cannot be removed`,
            params: { key },
          });
        }
      }
    }
  }

  const includeHeaders = settings['customIncludeHeaders'];
  if (includeHeaders !== undefined) {
    if (!isPlainRecord(includeHeaders)) {
      issues.push({
        path: 'settings.customIncludeHeaders',
        code: 'headersNotObject',
        message: 'must be a JSON object of strings',
      });
    } else {
      for (const [name, value] of Object.entries(includeHeaders)) {
        if (typeof value !== 'string') {
          issues.push({
            path: 'settings.customIncludeHeaders',
            code: 'headerValueNotString',
            message: 'header values must be strings',
          });
          break;
        }
        if (
          FORBIDDEN_CUSTOM_HEADERS.includes(
            name.toLowerCase() as (typeof FORBIDDEN_CUSTOM_HEADERS)[number],
          )
        ) {
          issues.push({
            path: 'settings.customIncludeHeaders',
            code: 'forbiddenHeader',
            message: `header "${name}" cannot be overridden`,
            params: { name },
          });
        }
      }
    }
  }

  return issues;
}

export const TokenUsageSchema = Type.Object({
  promptTokens: Type.Integer({ minimum: 0 }),
  completionTokens: Type.Integer({ minimum: 0 }),
  totalTokens: Type.Integer({ minimum: 0 }),
});
export type TokenUsage = Static<typeof TokenUsageSchema>;

export const ProviderTestRequestSchema = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type ProviderTestRequest = Static<typeof ProviderTestRequestSchema>;

export const ProviderTestResponseSchema = Type.Object(
  {
    text: Type.String(),
    usage: Type.Optional(TokenUsageSchema),
  },
  { additionalProperties: false },
);
export type ProviderTestResponse = Static<typeof ProviderTestResponseSchema>;

/**
 * Unified streaming generation events (ТЗ §4.3). Every provider adapter emits
 * this sequence: `start` → zero or more `delta` → exactly one `done` or
 * `error`.
 */
export const GenerationEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal('plugin_intercept'),
    requestId: Type.String(),
    responseToken: Type.String(),
    chatId: IdSchema,
    messages: Type.Array(GenerationMessageSchema),
    meta: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({ type: Type.Literal('start'), requestId: Type.String() }),
  Type.Object({ type: Type.Literal('delta'), text: Type.String() }),
  Type.Object({
    type: Type.Literal('done'),
    text: Type.String(),
    usage: Type.Optional(TokenUsageSchema),
  }),
  Type.Object({ type: Type.Literal('error'), code: Type.String(), message: Type.String() }),
]);
export type GenerationEvent = Static<typeof GenerationEventSchema>;

/**
 * Provider modalities (ТЗ §4.3: «каждый LLM, TTS, STT или image-provider
 * реализует общий интерфейс»). Text generation is the base capability; the
 * others are optional adapter methods with their own request/event contracts
 * below.
 */
export const ProviderModalitySchema = Type.Union([
  Type.Literal('text'),
  Type.Literal('speech'),
  Type.Literal('transcription'),
  Type.Literal('image'),
]);
export type ProviderModality = Static<typeof ProviderModalitySchema>;

/** Text-to-speech request. */
export const SpeechRequestSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  input: Type.String({ minLength: 1, maxLength: 20000 }),
  voice: Type.Optional(Type.String({ maxLength: 200 })),
  format: Type.Optional(Type.Union([Type.Literal('wav'), Type.Literal('mp3')])),
});
export type SpeechRequest = Static<typeof SpeechRequestSchema>;

/** Unified TTS streaming events: `start` → `audio`* → `done` | `error`. */
export const SpeechEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('start'), requestId: Type.String() }),
  Type.Object({
    type: Type.Literal('audio'),
    /** Base64-encoded audio chunk. */
    dataBase64: Type.String(),
    mime: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('done'),
    bytes: Type.Integer({ minimum: 0 }),
    mime: Type.String(),
  }),
  Type.Object({ type: Type.Literal('error'), code: Type.String(), message: Type.String() }),
]);
export type SpeechEvent = Static<typeof SpeechEventSchema>;

/** Collected TTS result (non-streaming API shape). */
export const SpeechResultSchema = Type.Object({
  dataBase64: Type.String(),
  mime: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
});
export type SpeechResult = Static<typeof SpeechResultSchema>;

/** Image generation request. */
export const ImageRequestSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1, maxLength: 20000 }),
  width: Type.Optional(Type.Integer({ minimum: 8, maximum: 8192 })),
  height: Type.Optional(Type.Integer({ minimum: 8, maximum: 8192 })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, default: 1 })),
});
export type ImageRequest = Static<typeof ImageRequestSchema>;

/** Unified image generation events: `start` → `image`* → `done` | `error`. */
export const ImageEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('start'), requestId: Type.String() }),
  Type.Object({
    type: Type.Literal('image'),
    dataBase64: Type.String(),
    mime: Type.String(),
  }),
  Type.Object({ type: Type.Literal('done'), count: Type.Integer({ minimum: 0 }) }),
  Type.Object({ type: Type.Literal('error'), code: Type.String(), message: Type.String() }),
]);
export type ImageEvent = Static<typeof ImageEventSchema>;

export const ImageResultSchema = Type.Object({
  images: Type.Array(Type.Object({ dataBase64: Type.String(), mime: Type.String() }), {
    maxItems: 4,
  }),
});
export type ImageResult = Static<typeof ImageResultSchema>;

/** Speech-to-text request (audio uploaded inline as base64). */
export const TranscriptionRequestSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  audioBase64: Type.String({ minLength: 1, maxLength: 30_000_000 }),
  mime: Type.String({ minLength: 1, maxLength: 200 }),
});
export type TranscriptionRequest = Static<typeof TranscriptionRequestSchema>;

export const TranscriptionResultSchema = Type.Object({
  text: Type.String(),
  language: Type.Optional(Type.String()),
});
export type TranscriptionResult = Static<typeof TranscriptionResultSchema>;

/** Body for POST /api/v2/chats/:id/generate (SSE). */
export const ChatGenerateRequestSchema = Type.Object({
  /** Optional user message to append before generating. */
  userMessage: Type.Optional(Type.String()),
  /** Replace the newest assistant response in the active branch before generating. */
  regenerate: Type.Optional(Type.Boolean()),
  /**
   * Regenerate a specific assistant message (the newest in the active
   * branch). Stale ids are rejected with `REGENERATE_TARGET_MOVED`.
   */
  regenerateMessageId: Type.Optional(IdSchema),
  /** Prompt-manager action used to select trigger-filtered prompt entries. */
  generationType: Type.Optional(PromptTriggerIdSchema),
  providerConfigId: Type.Optional(IdSchema),
  /** True when this browser has active prompt.modify frontend interceptors. */
  frontendInterceptors: Type.Optional(Type.Boolean()),
  overrides: Type.Optional(GenerationDefaultsSchema),
});
export type ChatGenerateRequest = Static<typeof ChatGenerateRequestSchema>;
