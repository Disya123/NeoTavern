/**
 * Shared prompt serialization for text-completion-style adapters.
 *
 * Chat adapters (`openai-compatible`, `anthropic`) send a structured message
 * array. Text adapters send a single rendered prompt string: the prompt
 * pipeline collapses the instruct-rendered context into one `user` message when
 * `serializeAsText` is active (see docs/prompt-pipeline), so flattening message
 * contents reproduces that prompt. When several messages are present (a
 * fallback path), their contents are joined with newlines.
 */
import type { GenerationMessage } from '@neotavern/contracts';

/** Flatten a generation message array into a raw completion prompt. */
export function promptFromMessages(
  messages: ReadonlyArray<Pick<GenerationMessage, 'content'>>,
): string {
  return messages
    .map((message) => message.content)
    .filter((content) => content.length > 0)
    .join('\n');
}
