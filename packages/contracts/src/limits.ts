/**
 * Numeric bounds shared by schemas and the UI so a single source of truth
 * governs validation and slider/input ranges (AGENTS.md §5, §27).
 *
 * The *schema* maximum is the absolute ceiling the backend will accept
 * (`CONTEXT_TOKEN_UNLOCKED_MAX`). The *locked* default maximum
 * (`CONTEXT_TOKEN_DEFAULT_MAX`) is a UI concept: the context-size slider is
 * capped there until the user explicitly unlocks it, mirroring SillyTavern's
 * "Unlocked Context Size" toggle. Keeping both here prevents the schema and
 * the UI from drifting apart.
 */

/** Minimum context window, in tokens. */
export const CONTEXT_TOKEN_MIN = 256;

/** Default context window for new installations (SillyTavern legacy value). */
export const CONTEXT_TOKEN_DEFAULT = 16_032;

/** Default slider ceiling for the context size, in tokens (200k). */
export const CONTEXT_TOKEN_DEFAULT_MAX = 200_000;

/** Absolute ceiling when the context size is unlocked, in tokens (10M). */
export const CONTEXT_TOKEN_UNLOCKED_MAX = 10_000_000;
