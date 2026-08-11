/**
 * Character greeting helpers (ST1-compatible swipe greetings).
 *
 * Single pure implementation shared by the server (chat creation) and the web
 * app (swipe rendering) — the two apps used to carry byte-identical copies
 * that could drift independently (DUP-27).
 */

/** Structural slice of a character card needed to collect greetings. */
export interface GreetingSource {
  firstMessage: string;
  ext: Record<string, unknown>;
}

/**
 * Collect authored greetings for a character card: `firstMessage` followed by
 * non-empty `ext.alternateGreetings`.
 */
export function collectCharacterGreetings(character: GreetingSource): string[] {
  const greetings: string[] = [];
  if (character.firstMessage.trim().length > 0) {
    greetings.push(character.firstMessage);
  }
  const alternate = character.ext['alternateGreetings'];
  if (Array.isArray(alternate)) {
    for (const item of alternate) {
      if (typeof item === 'string' && item.trim().length > 0) {
        greetings.push(item);
      }
    }
  }
  return greetings;
}

/** Clamp a swipe index into `[0, length)`. */
export function clampSwipeIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), length - 1);
}

/** Read ST1-style greeting swipe metadata from a message. */
export function readGreetingSwipes(meta: Record<string, unknown>): {
  swipes: string[];
  swipeId: number;
} | null {
  if (meta['greeting'] !== true) return null;
  const raw = meta['swipes'];
  if (!Array.isArray(raw)) return null;
  const swipes = raw.filter((item): item is string => typeof item === 'string');
  if (swipes.length === 0) return null;
  const swipeId = clampSwipeIndex(
    typeof meta['swipeId'] === 'number' ? meta['swipeId'] : 0,
    swipes.length,
  );
  return { swipes, swipeId };
}
