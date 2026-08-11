/**
 * SillyTavern-style prompt post-processing (classic "Prompt Post-Processing"
 * setting). Reshapes the structured chat-message array right before provider
 * serialization so backends that require a particular turn shape receive one.
 *
 * Faithful port of SillyTavern's `mergeMessages` / `postProcessPrompt`
 * (`src/prompt-converters.js`), adapted to NeoTavern's `GenerationMessage`
 * (`{ role, content, name? }`, string content). Applies only in chat mode
 * (`serializeAsText=false`); text-completion providers already receive a single
 * rendered instruct prompt, so there is nothing to reshape.
 *
 * Modes (see `PromptPostProcessingModes`):
 * - `merge`        — squash consecutive same-role messages.
 * - `semi`         — `merge` + strict: mid-prompt system messages become user.
 * - `strict`       — `semi` + insert user placeholders so the conversation is
 *                    user-first and alternates cleanly.
 * - `single`       — fold every message into one `user` message.
 * - `*_tools`      — same as the base mode but keep `tool`-role messages
 *                    (the base modes rewrite `tool` → `user`).
 */
import type { GenerationMessage, MessageRole, PromptPostProcessingMode } from '@neotavern/contracts';

/** Display names used to prefix folded message content (group names excluded). */
export interface PromptPostProcessingNames {
  charName?: string;
  userName?: string;
}

/** Fallback user turn inserted by `strict` so a prompt is never role-invalid. */
export const DEFAULT_PROMPT_PLACEHOLDER = "Let's get started.";

interface MergeOptions {
  /** Only one leading system message; mid-prompt system becomes user. */
  strict?: boolean;
  /** In strict mode, insert user placeholders to force a user-first turn order. */
  placeholders?: boolean;
  /** Fold every message into a single `user` message. */
  single?: boolean;
  /** Keep `tool`-role messages; when false they are rewritten to `user`. */
  tools?: boolean;
}

/** Prefix `content` with `"${name}: "` unless it already starts with it. */
function prefixOnce(content: string, name: string | undefined): string {
  if (!name || name.length === 0) return content;
  const prefix = `${name}: `;
  return content.startsWith(prefix) ? content : `${prefix}${content}`;
}

function toMessage(role: MessageRole, content: string): GenerationMessage {
  return { role, content };
}

/**
 * Merge messages with the same consecutive role, folding `name` into content.
 * Mirrors SillyTavern's `mergeMessages`, including the strict-mode recursion
 * that re-squashes after role rewrites.
 */
export function mergeMessages(
  messages: readonly GenerationMessage[],
  names: PromptPostProcessingNames,
  options: MergeOptions = {},
  placeholder: string = DEFAULT_PROMPT_PLACEHOLDER,
): GenerationMessage[] {
  const { strict = false, placeholders = false, single = false, tools = false } = options;

  // Per-message normalization: fold names into content and fix tool/single roles.
  const normalized: GenerationMessage[] = messages.map((source) => {
    let content = source.content ?? '';
    let role = source.role;
    const name = source.name ?? undefined;

    if (role === 'system' && name === 'example_assistant') {
      content = prefixOnce(content, names.charName);
    }
    if (role === 'system' && name === 'example_user') {
      content = prefixOnce(content, names.userName);
    }
    if (name && role !== 'system') {
      content = prefixOnce(content, name);
    }
    if (role === 'tool' && !tools) {
      role = 'user';
    }
    // Plugin narration (rev4 chats) is user-facing content for providers.
    if (role === 'plugin') {
      role = 'user';
    }
    if (single) {
      if (role === 'assistant') content = prefixOnce(content, names.charName);
      if (role === 'user') content = prefixOnce(content, names.userName);
      role = 'user';
    }
    return toMessage(role, content);
  });

  // Squash consecutive same-role messages (never squash tool turns).
  const merged: GenerationMessage[] = [];
  for (const message of normalized) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.role === message.role &&
      message.content.length > 0 &&
      message.role !== 'tool'
    ) {
      last.content += `\n\n${message.content}`;
    } else {
      merged.push(toMessage(message.role, message.content));
    }
  }

  if (merged.length === 0) {
    merged.push(toMessage('user', placeholder));
  }

  if (strict) {
    for (let i = 1; i < merged.length; i++) {
      const message = merged[i];
      if (message && message.role === 'system') {
        merged[i] = toMessage('user', message.content);
      }
    }
    if (placeholders && merged.length > 0) {
      const first = merged[0];
      const second = merged[1];
      if (
        first &&
        first.role === 'system' &&
        (merged.length === 1 || (second && second.role !== 'user'))
      ) {
        merged.splice(1, 0, toMessage('user', placeholder));
      } else if (first && first.role !== 'system' && first.role !== 'user') {
        merged.unshift(toMessage('user', placeholder));
      }
    }
    // Re-squash after the role rewrites above.
    return mergeMessages(
      merged,
      names,
      { strict: false, placeholders, single: false, tools },
      placeholder,
    );
  }

  return merged;
}

/**
 * Apply a post-processing mode to the message array. Unknown or empty modes
 * return the messages unchanged (the `NONE` behaviour).
 */
export function postProcessMessages(
  messages: readonly GenerationMessage[],
  mode: PromptPostProcessingMode | undefined,
  names: PromptPostProcessingNames = {},
  placeholder: string = DEFAULT_PROMPT_PLACEHOLDER,
): GenerationMessage[] {
  switch (mode) {
    case 'merge':
      return mergeMessages(
        messages,
        names,
        { strict: false, placeholders: false, single: false, tools: false },
        placeholder,
      );
    case 'merge_tools':
      return mergeMessages(
        messages,
        names,
        { strict: false, placeholders: false, single: false, tools: true },
        placeholder,
      );
    case 'semi':
      return mergeMessages(
        messages,
        names,
        { strict: true, placeholders: false, single: false, tools: false },
        placeholder,
      );
    case 'semi_tools':
      return mergeMessages(
        messages,
        names,
        { strict: true, placeholders: false, single: false, tools: true },
        placeholder,
      );
    case 'strict':
      return mergeMessages(
        messages,
        names,
        { strict: true, placeholders: true, single: false, tools: false },
        placeholder,
      );
    case 'strict_tools':
      return mergeMessages(
        messages,
        names,
        { strict: true, placeholders: true, single: false, tools: true },
        placeholder,
      );
    case 'single':
      return mergeMessages(
        messages,
        names,
        { strict: true, placeholders: false, single: true, tools: false },
        placeholder,
      );
    default:
      return messages.map((message) => toMessage(message.role, message.content ?? ''));
  }
}
