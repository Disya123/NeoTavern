/**
 * Server-side greeting selection for chat creation. Pure greeting collection
 * and index clamping live in @neotavern/shared (DUP-27); here we only build the
 * message content + swipe metadata.
 */
import type { Character } from '@neotavern/contracts';
import { clampSwipeIndex, collectCharacterGreetings } from '@neotavern/shared';

export function resolveGreetingSelection(
  character: Character,
  greetingIndex?: number,
): { content: string; meta: Record<string, unknown> } | undefined {
  const swipes = collectCharacterGreetings(character);
  if (swipes.length === 0) return undefined;
  const swipeId = clampSwipeIndex(greetingIndex ?? Number.NaN, swipes.length);
  return {
    content: swipes[swipeId]!,
    meta: {
      greeting: true,
      swipes,
      swipeId,
    },
  };
}
