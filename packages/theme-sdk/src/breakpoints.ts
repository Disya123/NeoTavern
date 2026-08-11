/**
 * Breakpoint registry — the single source of truth for layout breakpoints
 * used by the built-in UI and enforced by the style-contract test.
 *
 * Themes may register additional breakpoints through the theme contract,
 * but the built-in viewport and container queries must use this registry.
 *
 * Rules:
 * - Viewport media queries are expressed in px, width breakpoints only.
 * - Container queries are expressed in rem.
 * - Feature queries (`prefers-reduced-motion`, `pointer`, `forced-colors`,
 *   `prefers-color-scheme`, `prefers-contrast`) are not layout breakpoints
 *   and never belong to the registry.
 */

/** Viewport width breakpoints in px, from smallest to largest. */
export const VIEWPORT_BREAKPOINTS: readonly number[] = [480, 600, 620, 760, 980, 1080] as const;

/** Container (size-query) breakpoints in rem, from smallest to largest. */
export const CONTAINER_BREAKPOINTS: readonly number[] = [20, 28, 32, 35, 36, 42, 44] as const;
