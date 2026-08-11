/**
 * Script-aware token estimation.
 *
 * A flat "characters per token" rate cannot match modern BPE tokenizers: the
 * real density varies per script (measured against the DeepSeek V3/V4 and
 * tiktoken o200k tokenizers): Latin ~5.1 chars/token, Cyrillic ~4.0,
 * CJK ~1.7, digits ~2.0, punctuation/space ~3.0, emoji ~1.1. This estimator
 * contributes 1/rate per character, keeping the approximate fallback within a
 * few percent of the exact tokenizer for mixed text.
 *
 * Isomorphic (no `node:` imports) so both the server and the web app share
 * one source of truth for fallback counting.
 */

const SCRIPT_RATES = [1.1, 1.7, 4.0, 2.0, 4.6, 3.0, 4.0] as const;
const FALLBACK_RATE = 4.0;

// Group order = SCRIPT_RATES order; alternation makes the classes disjoint:
// 1 emoji (also \p{S}), 2 CJK (also \p{L}), 3 Cyrillic (also \p{L}),
// 4 digits, 5 other letters + marks, 6 punctuation/space/symbols,
// 7 everything else (control chars, newlines, unassigned code points).
// The catch-all is [\s\S] on purpose: `.` does not match line terminators,
// which would silently drop newlines from the estimate.
const SCRIPT_RATE_RE =
  /([\p{Extended_Pictographic}])|([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])|([\p{Script=Cyrillic}])|([\p{N}])|([\p{L}\p{M}])|([\p{P}\p{S}\p{Z}])|([\s\S])/gu;

/** Rough token estimate for a single piece of text. Exact tokenizer profiles
 * registered for the active model always take precedence over this. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let tokens = 0;
  for (const match of text.matchAll(SCRIPT_RATE_RE)) {
    for (let group = 1; group <= SCRIPT_RATES.length; group += 1) {
      if (match[group] !== undefined) {
        tokens += 1 / (SCRIPT_RATES[group - 1] ?? FALLBACK_RATE);
        break;
      }
    }
  }
  return Math.max(1, Math.round(tokens));
}
