/**
 * Theme inheritance resolution. Tokens resolve in this order (later wins):
 * built-in defaults for the mode → parent theme chain (root → closest) →
 * the theme itself. Dark mode falls back to a theme's light tokens when it
 * defines no dark override.
 */
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  type ResolvedTokenSet,
  type TokenSet,
} from './tokens.js';
import type { ThemeManifest, ThemeMode } from './manifest.js';

function tokenSetToRecord(set: TokenSet | undefined): Record<string, string> {
  if (!set) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(set)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Resolve the final token set for a theme in a given mode.
 *
 * @param theme   The theme being applied.
 * @param mode    light/dark.
 * @param parents The resolved parent chain, ordered root-first (closest last).
 */
export function resolveTokens(
  theme: ThemeManifest,
  mode: ThemeMode,
  parents: readonly ThemeManifest[] = [],
): ResolvedTokenSet {
  const base: Record<string, string> =
    mode === 'dark' ? { ...DEFAULT_DARK_TOKENS } : { ...DEFAULT_LIGHT_TOKENS };

  const chain = [...parents, theme];
  let merged = base;
  for (const entry of chain) {
    const modeTokens = entry.tokens?.[mode] ?? (mode === 'dark' ? entry.tokens?.light : undefined);
    merged = { ...merged, ...tokenSetToRecord(modeTokens) };
  }

  return merged as ResolvedTokenSet;
}
