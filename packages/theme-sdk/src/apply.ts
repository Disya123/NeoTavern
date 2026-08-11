/**
 * Pure helpers for applying a theme. Producing CSS custom properties is done
 * here (framework-agnostic); the actual DOM application (setting them on
 * `document.documentElement`) lives in the web app.
 */
import { TOKEN_PREFIX, type ResolvedTokenSet } from './tokens.js';
import type { ThemeManifest, ThemeMode } from './manifest.js';
import { resolveTokens } from './resolve.js';

/** Convert a resolved token set to `--st-*` CSS custom property entries. */
export function tokensToCssVariables(tokens: ResolvedTokenSet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    const name = key.startsWith('--') ? key : `${TOKEN_PREFIX}${key}`;
    out[name] = value;
  }
  return out;
}

/** Build the CSS variables for a theme in a mode, resolving inheritance. */
export function buildThemeVariables(
  theme: ThemeManifest,
  mode: ThemeMode,
  parents: readonly ThemeManifest[] = [],
): Record<string, string> {
  return tokensToCssVariables(resolveTokens(theme, mode, parents));
}

/**
 * Safe mode from a URL search string (`?safe=1`). In safe mode third-party
 * themes/plugins are disabled (ТЗ §6.6). Pure so it is unit-testable.
 */
export function getSafeModeFromSearch(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get('safe') === '1';
}

/**
 * Stable styling hooks for themes (ТЗ §6.4). Themes target these attributes —
 * never generated CSS-module class names. The contract is versioned.
 */
export interface DataHookAttributes {
  'data-component': string;
  'data-part'?: string;
  'data-role'?: string;
  'data-state'?: string;
}

/** Build a data-hook attribute object for a component. */
export function dataHook(
  component: string,
  extra: { part?: string; role?: string; state?: string } = {},
): DataHookAttributes {
  const attrs: DataHookAttributes = { 'data-component': component };
  if (extra.part !== undefined) attrs['data-part'] = extra.part;
  if (extra.role !== undefined) attrs['data-role'] = extra.role;
  if (extra.state !== undefined) attrs['data-state'] = extra.state;
  return attrs;
}
