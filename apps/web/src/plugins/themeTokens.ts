/**
 * Design tokens mirrored into sandboxed plugin UI (`api.ui.modelMenu` and
 * any future SDK widgets).
 *
 * The plugin sandbox is an opaque-origin iframe: its document cannot read the
 * host stylesheets, so the host snapshots the allow-listed token values and
 * ships them as resolved strings ('rgb(…)'/px/rem — no CSS custom properties
 * cross the frame boundary) in the kernel handshake (`HostHandshake`), then
 * pushes updates whenever the theme changes via `neotavern.plugin.tokens`. Widgets
 * fall back to their built-in palette when no snapshot is available (e.g. an
 * old host that does not send the field).
 */
export const PLUGIN_UI_TOKENS = [
  '--st-color-text-primary',
  '--st-color-text-muted',
  '--st-color-surface-elevated',
  '--st-color-surface-overlay',
  '--st-color-surface-tertiary',
  '--st-color-accent',
  '--st-color-accent-soft',
  '--st-color-accent-soft-text',
  '--st-color-border',
  '--st-color-danger',
  '--st-radius-control',
  '--st-control-height',
  '--st-space-xs',
  '--st-space-sm',
  '--st-space-md',
  '--st-font-size-sm',
  '--st-font-size-md',
  '--st-font-weight-semibold',
  '--st-size-content-max-height',
  '--st-shadow-focus',
  '--st-shadow-overlay',
  '--st-layer-dropdown',
] as const;

export type PluginUiToken = (typeof PLUGIN_UI_TOKENS)[number];

/** Snapshot the allow-listed tokens as resolved values from the given root. */
export function snapshotPluginUiTokens(
  root: HTMLElement = document.documentElement,
): Partial<Record<PluginUiToken, string>> {
  const styles = getComputedStyle(root);
  const tokens: Partial<Record<PluginUiToken, string>> = {};
  for (const name of PLUGIN_UI_TOKENS) {
    const value = resolveTokenValue(name, styles);
    if (value.length > 0) tokens[name] = value;
  }
  return tokens;
}

/**
 * Read one custom property and unwrap `var()` references (themes may alias
 * tokens: `--st-color-x: var(--st-color-y)`). The sandbox cannot resolve an
 * aliased value on its own — the referenced property is not defined inside
 * the opaque iframe — so the host ships a plain literal.
 */
function resolveTokenValue(name: string, styles: CSSStyleDeclaration, depth = 0): string {
  const raw = styles.getPropertyValue(name).trim();
  if (raw.length === 0 || depth > 8) return raw;
  const match = /^var\(\s*(--[^,\s)]+)(?:\s*,\s*([^)]*))?\)$/.exec(raw);
  if (!match) return raw;
  const referenced = styles.getPropertyValue(match[1] ?? '').trim();
  if (referenced.length > 0) return resolveTokenValue(match[1] ?? '', styles, depth + 1);
  return (match[2] ?? '').trim();
}
