/**
 * Application settings schema. Sensitive values (API keys) are never stored
 * here — they live in provider configs. Settings are keyed strings mapped to
 * JSON values; {@link AppSettingsSchema} is the typed projection.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema } from './common.js';
import { CONTEXT_TOKEN_MIN, CONTEXT_TOKEN_UNLOCKED_MAX } from './limits.js';
import { GenerationDefaultsSchema } from './provider.js';
import { PromptTemplateSchema } from './promptTemplate.js';

export const ContextStrategyIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z0-9][a-z0-9._-]*$',
});
export type ContextStrategyId = Static<typeof ContextStrategyIdSchema>;

/**
 * Prompt post-processing modes (mirrors the classic SillyTavern
 * `custom_prompt_post_processing` select). Each mode reshapes the clean message
 * array right before instruct rendering / provider serialization. The `_tools`
 * variants keep tool-call/tool-result pairs intact; the plain variants drop
 * tool messages. `''` (empty) means no post-processing. The transform itself
 * lives in the server prompt pipeline (AGENTS §8); this enum only names the
 * user-selectable strategies.
 */
export const PromptPostProcessingModes = [
  '',
  'merge',
  'merge_tools',
  'semi',
  'semi_tools',
  'strict',
  'strict_tools',
  'single',
] as const;
export const PromptPostProcessingModeSchema = Type.Union(
  PromptPostProcessingModes.map((mode) => Type.Literal(mode)),
);
export type PromptPostProcessingMode = Static<typeof PromptPostProcessingModeSchema>;

/**
 * The connection the user last confirmed via the "Connect" action. Persisted so
 * the app can optionally re-validate and restore it on next launch
 * ({@link AppSettingsSchema.autoConnect}). It references a provider config and
 * caches the source/model the user connected with for display purposes only.
 */
export const LastServerSchema = Type.Object(
  {
    providerConfigId: IdSchema,
    source: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type LastServer = Static<typeof LastServerSchema>;

export const CustomInstructFormatSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.Integer({ minimum: 1, maximum: 1000 }),
    system: Type.String({ maxLength: 32768 }),
    user: Type.String({ maxLength: 32768 }),
    assistant: Type.String({ maxLength: 32768 }),
    tool: Type.String({ maxLength: 32768 }),
    promptSuffix: Type.String({ maxLength: 32768 }),
    stopStrings: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type CustomInstructFormat = Static<typeof CustomInstructFormatSchema>;

/**
 * Roles an instruct format defines templates for (DUP-22). `plugin` messages
 * fall back to the `user` template at render time, so editors never offer a
 * plugin template field.
 */
export const InstructTemplateRoles = ['system', 'user', 'assistant', 'tool'] as const;
export type InstructTemplateRole = (typeof InstructTemplateRoles)[number];

export const AppSettingsSchema = Type.Object({
  language: Type.String({ default: 'en' }),
  themeId: Type.Union([Type.String(), Type.Null()]),
  activeProviderConfigId: Type.Union([IdSchema, Type.Null()]),
  activePersonaId: Type.Union([IdSchema, Type.Null()]),
  contextStrategy: ContextStrategyIdSchema,
  maxContextTokens: Type.Integer({
    minimum: CONTEXT_TOKEN_MIN,
    maximum: CONTEXT_TOKEN_UNLOCKED_MAX,
  }),
  generationDefaults: GenerationDefaultsSchema,
  activeGenerationPresetId: Type.Union([IdSchema, Type.Null()]),
  activePromptTemplatePresetId: Type.Union([IdSchema, Type.Null()]),
  promptTemplate: PromptTemplateSchema,
  instructFormat: Type.Union([CustomInstructFormatSchema, Type.Null()]),
  /**
   * Built-in instruct format id (chatml/llama3/alpaca/mistral/command-r).
   * A user-authored `instructFormat`, when set, takes precedence.
   */
  instructFormatId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  /**
   * When true, the client re-validates and restores {@link lastServer} on launch
   * (the classic SillyTavern "Auto-connect to Last Server" toggle). Optional and
   * UI-driven; absent means the feature is off. This is application behaviour,
   * not layout, so it lives here rather than in `ui`.
   */
  autoConnect: Type.Optional(Type.Boolean()),
  /** The last connection confirmed via "Connect"; see {@link LastServerSchema}. */
  lastServer: Type.Optional(Type.Union([LastServerSchema, Type.Null()])),
  /** User-defined prompt macros, resolved as {{name}} (ТЗ §4.4). */
  macroVariables: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.String({ maxLength: 2048 })),
  ),
  /** Free-form, UI-owned settings (panel layout, etc.). */
  ui: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type AppSettings = Static<typeof AppSettingsSchema>;

/** Where the active persona's description is placed in the prompt (ТЗ §6). */
export const PersonaPlacements = [
  'persona',
  'authors-note-top',
  'authors-note-bottom',
  'in-chat',
] as const;
export type PersonaPlacementId = (typeof PersonaPlacements)[number];

/**
 * Typed view of the UI-owned `settings.ui.personas` bag (ARCH-13): server and
 * web used to parse the untyped record independently, byte-identical copies
 * drifting apart. Both sides now share this schema and {@link parsePersonasUi}.
 */
export const PersonasUiSettingsSchema = Type.Object({
  showSwitchNotifications: Type.Optional(Type.Boolean()),
  allowMultipleConnections: Type.Optional(Type.Boolean()),
  autoLockToChat: Type.Optional(Type.Boolean()),
  placement: Type.Optional(
    Type.Union([
      Type.Literal('persona'),
      Type.Literal('authors-note-top'),
      Type.Literal('authors-note-bottom'),
      Type.Literal('in-chat'),
    ]),
  ),
});
export type PersonasUiSettings = Static<typeof PersonasUiSettingsSchema>;

/** Lenient reader for `settings.ui` → typed personas settings. */
export function parsePersonasUi(ui: unknown): PersonasUiSettings {
  if (typeof ui !== 'object' || ui === null || Array.isArray(ui)) return {};
  const personas = (ui as Record<string, unknown>)['personas'];
  if (typeof personas !== 'object' || personas === null || Array.isArray(personas)) return {};
  const record = personas as Record<string, unknown>;
  const placement = record['placement'];
  return {
    showSwitchNotifications:
      typeof record['showSwitchNotifications'] === 'boolean'
        ? record['showSwitchNotifications']
        : undefined,
    allowMultipleConnections:
      typeof record['allowMultipleConnections'] === 'boolean'
        ? record['allowMultipleConnections']
        : undefined,
    autoLockToChat:
      typeof record['autoLockToChat'] === 'boolean' ? record['autoLockToChat'] : undefined,
    placement:
      typeof placement === 'string' && (PersonaPlacements as readonly string[]).includes(placement)
        ? (placement as PersonaPlacementId)
        : undefined,
  };
}

/** Partial update to settings. */
export const AppSettingsUpdateSchema = Type.Partial(AppSettingsSchema);
export type AppSettingsUpdate = Static<typeof AppSettingsUpdateSchema>;
