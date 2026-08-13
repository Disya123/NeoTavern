/**
 * Theme application (the DOM side of @neotavern/theme-sdk, which stays pure).
 * Sets `data-theme-mode` so the token stylesheet switches light/dark, and can
 * apply a full theme manifest's variables without a restart (ТЗ §6.5).
 */
import {
  buildThemeVariables,
  getSafeModeFromSearch,
  resolveThemeResponsive,
  validateThemeManifest,
  type ThemeManifest,
  type ThemeMode,
} from '@neotavern/theme-sdk';
import type { InstalledTheme } from '@neotavern/contracts';
import type { InterfacePreferences, ThemeMode as UiThemeMode } from '../state/ui.js';

export function setThemeMode(mode: UiThemeMode): void {
  const el = document.documentElement;
  if (mode === 'system') delete el.dataset.themeMode;
  else el.dataset.themeMode = mode;
}

/** Applies user-level presentation preferences above any shell theme. */
export function setInterfacePreferences(preferences: InterfacePreferences): void {
  const root = document.documentElement;
  root.dataset.uiDensity = preferences.density;
  root.dataset.uiScale = preferences.scale;
  root.dataset.uiContrast = preferences.contrast;
  root.dataset.uiFont = preferences.fontProfile;
  root.dataset.uiMotion = preferences.motion;
  root.dataset.chatStyle = preferences.chatStyle;
  root.dataset.chatAvatarStyle = preferences.chatAvatarStyle;
  root.dataset.userMessagePosition = preferences.userMessagePosition;
  root.dataset.characterMessagePosition = preferences.characterMessagePosition;

  const opacity = preferences.uiOpacity ?? 70;
  const blur = preferences.uiGlassBlur ?? 16;
  root.style.setProperty('--st-custom-ui-opacity', `${opacity}%`);
  root.style.setProperty('--st-custom-glass-blur', `${blur}px`);
  root.style.setProperty('--st-effect-glass-blur', `${blur}px`);

  const overlayAlpha = ((opacity / 100) * 0.45).toFixed(2);
  root.style.setProperty('--st-custom-wallpaper-overlay-alpha', overlayAlpha);
}

/** Resolve the effective light/dark mode given the user's preference. */
export function effectiveMode(mode: UiThemeMode): ThemeMode {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return prefersDarkColorScheme() ? 'dark' : 'light';
}

export function prefersDarkColorScheme(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * OS-level reduced-motion wins over theme defaults: the inline tokens applied
 * below would otherwise beat the prefers-reduced-motion media query in
 * tokens.css, leaving a user with an active installed theme fully animated
 * (THEME-42). 1ms matches the tokens.css threshold.
 */
const REDUCED_MOTION_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ['--st-motion-duration-fast', '1ms'],
  ['--st-motion-duration-normal', '1ms'],
  ['--st-motion-duration-slow', '1ms'],
  ['--st-scrollbar-fade-duration', '1ms'],
  ['--st-scrollbar-hide-delay', '0ms'],
];

/** Apply a theme manifest's resolved variables to the document root. */
export function applyTheme(
  theme: ThemeManifest,
  mode: UiThemeMode,
  parents: ThemeManifest[] = [],
): void {
  const vars = buildThemeVariables(theme, effectiveMode(mode), parents);
  const el = document.documentElement;
  for (const [name, value] of Object.entries(vars)) {
    el.style.setProperty(name, value);
  }
  if (prefersReducedMotion()) {
    for (const [name, value] of REDUCED_MOTION_OVERRIDES) el.style.setProperty(name, value);
  }
}

/** Theme-setting variables currently applied to the document root. */
let appliedSettingVariables: string[] = [];

/** User-controlled shell layout variables that must survive theme re-apply. */
const PRESERVED_SHELL_LAYOUT_VARIABLES = ['--st-shell-panel-width'] as const;

/** Remove inline theme variables (revert to stylesheet defaults). */
export function clearThemeOverrides(): void {
  const el = document.documentElement;
  const preserved = new Map<string, string>();
  for (const variable of PRESERVED_SHELL_LAYOUT_VARIABLES) {
    const value = el.style.getPropertyValue(variable).trim();
    if (value.length > 0) preserved.set(variable, value);
  }
  const properties = Array.from({ length: el.style.length }, (_, index) => el.style.item(index));
  for (const key of properties) {
    if (key.startsWith('--st-')) el.style.removeProperty(key);
  }
  for (const [variable, value] of preserved) {
    el.style.setProperty(variable, value);
  }
  for (const variable of appliedSettingVariables) el.style.removeProperty(variable);
  appliedSettingVariables = [];
  delete el.dataset.themeId;
  delete el.dataset.themeDensity;
  delete el.dataset.themeMotion;
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    'link[data-neotavern-theme-style]',
  )) {
    link.remove();
  }
}

/**
 * Emit theme setting values as CSS custom properties (ТЗ §6.5 «тема может
 * иметь собственные настройки»). Only settings that declare a `variable` are
 * emitted; values are coerced/sanitized per setting type.
 */
export function applyThemeSettings(
  manifest: ThemeManifest,
  values: Record<string, unknown> | undefined,
): void {
  const el = document.documentElement;
  for (const [settingId, definition] of Object.entries(manifest.settings ?? {})) {
    if (!definition.variable) continue;
    const css = settingValueToCss(definition, values?.[settingId] ?? definition.default);
    if (css === null) continue;
    el.style.setProperty(definition.variable, css);
    appliedSettingVariables.push(definition.variable);
  }
}

/** Mirrors the server-side UNSAFE_SETTING_VALUE_RE (themes.ts). */
const UNSAFE_SETTING_VALUE_RE = /[;{}<>]|url\s*\(|expression\s*\(|javascript:/iu;

function settingValueToCss(
  definition: { type: string; options?: string[] },
  value: unknown,
): string | null {
  switch (definition.type) {
    case 'color':
      return typeof value === 'string' &&
        value.length <= 100 &&
        !UNSAFE_SETTING_VALUE_RE.test(value)
        ? value
        : null;
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
    case 'select':
      return typeof value === 'string' &&
        (definition.options ?? []).includes(value) &&
        !UNSAFE_SETTING_VALUE_RE.test(value)
        ? value
        : null;
    default:
      return null;
  }
}

/** Whether safe mode is active via ?safe=1 (disables third-party themes). */
export function isSafeMode(): boolean {
  return getSafeModeFromSearch(window.location.search);
}

/**
 * Dispatched (on `window`) when applying an installed theme fails — either a
 * synchronous apply error (invalid manifest) or a package stylesheet that
 * fails to load. Hosts listen and revert to the last working theme.
 */
export const THEME_APPLY_FAILED_EVENT = 'neotavern-theme-apply-failed';

function dispatchThemeApplyFailed(themeId: string): void {
  globalThis.dispatchEvent?.(new CustomEvent(THEME_APPLY_FAILED_EVENT, { detail: { themeId } }));
}

/**
 * Apply validated package CSS in inheritance order, followed by token values
 * and the theme's responsive behavior hints (`data-theme-density` /
 * `data-theme-motion`, filled with the host defaults when the manifest omits
 * them). Returns true when the theme applied; on failure the document is
 * reverted to built-in defaults and a {@link THEME_APPLY_FAILED_EVENT} is
 * dispatched so the UI can fall back to the last working theme.
 */
export function applyInstalledTheme(
  active: InstalledTheme,
  parents: readonly InstalledTheme[],
  mode: UiThemeMode,
): boolean {
  const el = document.documentElement;
  const preservedShellLayout = new Map<string, string>();
  for (const variable of PRESERVED_SHELL_LAYOUT_VARIABLES) {
    const value = el.style.getPropertyValue(variable).trim();
    if (value.length > 0) preservedShellLayout.set(variable, value);
  }
  clearThemeOverrides();
  try {
    const manifests = [...parents, active].map((item) => {
      const result = validateInstalledManifest(item);
      return result;
    });
    const activeManifest = manifests.at(-1);
    if (!activeManifest) throw new Error('Active theme manifest is missing');
    applyTheme(activeManifest, mode, manifests.slice(0, -1));
    for (const [variable, value] of preservedShellLayout) {
      el.style.setProperty(variable, value);
    }
    const responsive = resolveThemeResponsive(activeManifest);
    el.dataset.themeDensity = responsive.density;
    el.dataset.themeMotion = responsive.motion;

    for (const item of [...parents, active]) {
      for (const href of [item.componentsCssUrl, item.shellCssUrl]) {
        if (!href) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        const separator = href.includes('?') ? '&' : '?';
        const cacheBuster = encodeURIComponent(`${item.version}-${item.installedAt}`);
        link.href = `${href}${separator}v=${cacheBuster}`;
        link.dataset.neotavernThemeStyle = item.id;
        // A stylesheet that fails to load leaves the theme half-painted:
        // notify the host so it can revert. Failures from links of a
        // previously applied theme are ignored once a newer apply won.
        link.addEventListener(
          'error',
          () => {
            if (document.documentElement.dataset.themeId !== active.id) return;
            dispatchThemeApplyFailed(active.id);
          },
          { once: true },
        );
        document.head.append(link);
      }
    }
    document.documentElement.dataset.themeId = active.id;
    return true;
  } catch {
    clearThemeOverrides();
    dispatchThemeApplyFailed(active.id);
    return false;
  }
}

function validateInstalledManifest(theme: InstalledTheme): ThemeManifest {
  const result = validateThemeManifest(theme.manifest);
  if (!result.ok) throw result.error;
  return result.value;
}
