import { Type, type Static } from '@sinclair/typebox';
import { MessageRoleSchema } from './message.js';

export const PromptTemplateModeSchema = Type.Union([Type.Literal('chat'), Type.Literal('text')]);
export type PromptTemplateMode = Static<typeof PromptTemplateModeSchema>;

/** Enumerable form of {@link PromptTemplateMode}. */
export const PromptTemplateModes = ['chat', 'text'] as const;

/** Stable ids for host-owned prompt sources. Custom prompts use a `custom-*` id. */
export const PromptBlockIds = [
  'main-prompt',
  'world-info-before',
  'persona',
  'character-description',
  'character-personality',
  'scenario',
  'world-info-after',
  'dialogue-examples',
  'memory',
  'authors-note',
  'chat-history',
  'post-history-instructions',
] as const;
export type CorePromptBlockId = (typeof PromptBlockIds)[number];

/** Host anchors that always terminate a text-completion prompt, in semantic order. */
export const TerminalPromptBlockIds = ['chat-history', 'post-history-instructions'] as const;
export type TerminalPromptBlockId = (typeof TerminalPromptBlockIds)[number];

export const CustomPromptBlockIdSchema = Type.String({
  minLength: 8,
  maxLength: 127,
  pattern: '^custom-[A-Za-z0-9][A-Za-z0-9._-]*$',
});
export type CustomPromptBlockId = `custom-${string}`;

export const PromptBlockIdSchema = Type.Union([
  ...PromptBlockIds.map((id) => Type.Literal(id)),
  CustomPromptBlockIdSchema,
]);
export type PromptBlockId = Static<typeof PromptBlockIdSchema>;

export const PromptInjectionPositionSchema = Type.Union([
  Type.Literal('relative'),
  Type.Literal('in-chat'),
]);
export type PromptInjectionPosition = Static<typeof PromptInjectionPositionSchema>;

export const PromptTriggerIds = [
  'normal',
  'continue',
  'impersonate',
  'swipe',
  'regenerate',
  'quiet',
] as const;
export const PromptTriggerIdSchema = Type.Union(
  PromptTriggerIds.map((trigger) => Type.Literal(trigger)),
);
export type PromptTriggerId = Static<typeof PromptTriggerIdSchema>;

export const PromptBlockSettingsSchema = Type.Object(
  {
    id: PromptBlockIdSchema,
    enabled: Type.Boolean(),
    /** Optional display-name override. Host block names otherwise come from i18n. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    /** Message role for editable and injected prompt content. */
    role: Type.Optional(MessageRoleSchema),
    /** Static prompt content. Dynamic host sources intentionally omit this field. */
    content: Type.Optional(Type.String({ maxLength: 32768 })),
    /** Relative list placement or an insertion inside chat history. */
    injectionPosition: Type.Optional(PromptInjectionPositionSchema),
    /** 0 inserts after the newest chat message, 1 before it, and so on. */
    injectionDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999 })),
    /** Tie-breaker for multiple prompts inserted at the same chat depth. */
    injectionOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999 })),
    /** Generation kinds that activate this prompt. An omitted list means every kind. */
    triggers: Type.Optional(Type.Array(PromptTriggerIdSchema, { maxItems: 6, uniqueItems: true })),
    /**
     * Bind the block to one model id (free text allowed, same rules as the
     * provider model field). An omitted/empty value applies the block to every
     * model; a mismatch with the active model excludes the block.
     */
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    /** Prevent a character-card system prompt from replacing the main prompt. */
    forbidOverrides: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type PromptBlockSettings = Static<typeof PromptBlockSettingsSchema>;

export const PromptTemplateSchema = Type.Object(
  {
    mode: PromptTemplateModeSchema,
    blocks: Type.Array(PromptBlockSettingsSchema, {
      minItems: PromptBlockIds.length,
      maxItems: 128,
    }),
    postHistoryInstructions: Type.String({ maxLength: 32768 }),
  },
  { additionalProperties: false },
);
export type PromptTemplate = Static<typeof PromptTemplateSchema>;

/** Persisted defaults for the text-completion prompt builder. */
export const DEFAULT_PROMPT_TEMPLATE: PromptTemplate = {
  mode: 'chat',
  blocks: PromptBlockIds.map((id) =>
    id === 'main-prompt'
      ? {
          id,
          enabled: true,
          role: 'system',
          content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
          injectionPosition: 'relative',
          triggers: [...PromptTriggerIds],
          forbidOverrides: false,
        }
      : { id, enabled: true },
  ),
  postHistoryInstructions:
    'Keep the roleplay engaging. Drive the story forward proactively while staying in character.',
};

/** Return whether an id names one of the host-owned prompt sources. */
export function isCorePromptBlockId(id: string): id is CorePromptBlockId {
  return (PromptBlockIds as readonly string[]).includes(id);
}

/** Return whether a block is a fixed terminal prompt anchor. */
export function isTerminalPromptBlockId(id: string): id is TerminalPromptBlockId {
  return (TerminalPromptBlockIds as readonly string[]).includes(id);
}

/** Ensure every host block occurs once and every custom prompt id is unique. */
export function hasRequiredPromptBlocks(template: Pick<PromptTemplate, 'blocks'>): boolean {
  if (template.blocks.length < PromptBlockIds.length) return false;
  const ids = new Set(template.blocks.map((block) => block.id));
  return ids.size === template.blocks.length && PromptBlockIds.every((id) => ids.has(id));
}

/** Place Chat History penultimate and Post-History Instructions last. */
export function normalizePromptBlockOrder<T extends PromptBlockSettings>(
  blocks: readonly T[],
): T[] {
  const movable = blocks.filter((block) => !isTerminalPromptBlockId(block.id));
  const terminal = TerminalPromptBlockIds.flatMap((id) => {
    const block = blocks.find((candidate) => candidate.id === id);
    return block ? [block] : [];
  });
  return [...movable, ...terminal];
}

/** Validate required blocks, uniqueness, and the two semantic terminal anchors. */
export function hasCompletePromptBlockOrder(template: Pick<PromptTemplate, 'blocks'>): boolean {
  if (!hasRequiredPromptBlocks(template)) return false;
  const terminal = template.blocks.slice(-TerminalPromptBlockIds.length);
  return TerminalPromptBlockIds.every((id, index) => terminal[index]?.id === id);
}
