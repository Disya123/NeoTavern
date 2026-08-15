/** Applies the persisted theme mode and language to the document. Renders
 * nothing; kept as a component so it lives inside the provider tree. */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { validateThemeManifest } from '@neotavern/theme-sdk';
import type { InstalledTheme } from '@neotavern/contracts';
import { useUiStore, type InterfacePreferences } from '../state/ui.js';
import { useThemes } from '../api/hooks.js';
import { readThemeSettings, userCssUrl } from '../api/wireBridge.js';
import {
  THEME_APPLY_FAILED_EVENT,
  applyInstalledTheme,
  applyThemeSettings,
  clearThemeOverrides,
  isSafeMode,
  prefersDarkColorScheme,
  prefersReducedMotion,
  setInterfacePreferences,
  setThemeMode,
} from '../theme/apply.js';
import { setDocumentLanguage } from '../lib/lang.js';
import { frontendPluginRuntime } from '../plugins/runtime.js';

/**
 * Build the resolved parent chain for a theme (root first, closest last).
 * Returns null when the chain is broken (cycle or missing parent) so callers
 * can fall back to built-in defaults.
 */
function buildParentChain(
  theme: InstalledTheme,
  items: readonly InstalledTheme[],
): InstalledTheme[] | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  const parents: InstalledTheme[] = [];
  const seen = new Set<string>([theme.id]);
  let parentId =
    typeof theme.manifest['extends'] === 'string' ? theme.manifest['extends'] : undefined;
  while (parentId) {
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return null;
    parents.unshift(parent);
    parentId =
      typeof parent.manifest['extends'] === 'string' ? parent.manifest['extends'] : undefined;
  }
  return parents;
}

/** Snapshot the current user-level interface preferences from the store. */
function snapshotInterfacePreferences(): InterfacePreferences {
  const {
    density,
    scale,
    contrast,
    fontProfile,
    motion,
    chatStyle,
    chatAvatarStyle,
    userMessagePosition,
    characterMessagePosition,
    uiOpacity,
    uiGlassBlur,
  } = useUiStore.getState();
  return {
    density,
    scale,
    contrast,
    fontProfile,
    motion,
    chatStyle,
    chatAvatarStyle,
    userMessagePosition,
    characterMessagePosition,
    uiOpacity,
    uiGlassBlur,
  };
}

export function ThemeSync() {
  const themeMode = useUiStore((s) => s.themeMode);
  const language = useUiStore((s) => s.language);
  const density = useUiStore((s) => s.density);
  const scale = useUiStore((s) => s.scale);
  const contrast = useUiStore((s) => s.contrast);
  const fontProfile = useUiStore((s) => s.fontProfile);
  const motion = useUiStore((s) => s.motion);
  const chatStyle = useUiStore((s) => s.chatStyle);
  const chatAvatarStyle = useUiStore((s) => s.chatAvatarStyle);
  const userMessagePosition = useUiStore((s) => s.userMessagePosition);
  const characterMessagePosition = useUiStore((s) => s.characterMessagePosition);
  const uiOpacity = useUiStore((s) => s.uiOpacity);
  const uiGlassBlur = useUiStore((s) => s.uiGlassBlur);
  const safeMode = isSafeMode();
  const themes = useThemes(!safeMode);
  const { i18n } = useTranslation();
  const activeThemeId = themes.data?.activeThemeId ?? null;
  const activeTheme = themes.data?.items.find((item) => item.id === activeThemeId) ?? undefined;
  /** Theme id of the last successfully applied theme (for revert-on-failure). */
  const lastAppliedThemeId = useRef<string | null>(null);
  /** Guards against re-entrant reverts while a failed re-apply is itself reverting. */
  const revertingRef = useRef(false);

  // OS color scheme / motion as reactive state. The theme is applied inline
  // on :root, which beats stylesheet media queries — so OS preference changes
  // must re-run the apply effect explicitly (THEME-40/THEME-42); listening
  // without re-applying used to be a no-op while a theme was active.
  const [systemDark, setSystemDark] = useState(prefersDarkColorScheme);
  const [systemReducedMotion, setSystemReducedMotion] = useState(prefersReducedMotion);
  useEffect(() => {
    const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
    const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onDark = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    const onMotion = (event: MediaQueryListEvent): void => setSystemReducedMotion(event.matches);
    darkMedia.addEventListener('change', onDark);
    motionMedia.addEventListener('change', onMotion);
    return () => {
      darkMedia.removeEventListener('change', onDark);
      motionMedia.removeEventListener('change', onMotion);
    };
  }, []);

  useEffect(() => {
    setThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    setInterfacePreferences({
      density,
      scale,
      contrast,
      fontProfile,
      motion,
      chatStyle,
      chatAvatarStyle,
      userMessagePosition,
      characterMessagePosition,
      uiOpacity,
      uiGlassBlur,
    });
  }, [
    chatAvatarStyle,
    chatStyle,
    contrast,
    density,
    fontProfile,
    motion,
    scale,
    userMessagePosition,
    characterMessagePosition,
    uiOpacity,
    uiGlassBlur,
  ]);

  useEffect(() => {
    setDocumentLanguage(language);
  }, [language]);

  // A theme that fails to apply (invalid manifest, or a package stylesheet
  // that never loads) reverts to the last successfully applied theme;
  // built-in defaults are the final resort. Stale failures (a link error
  // from a previously applied theme) and re-entrant failures while already
  // reverting are ignored.
  useEffect(() => {
    const onApplyFailed = (event: Event): void => {
      const detail = (event as CustomEvent<{ themeId?: unknown }>).detail;
      const failedThemeId = typeof detail?.themeId === 'string' ? detail.themeId : null;
      if (revertingRef.current || failedThemeId === null || failedThemeId !== activeThemeId) {
        return;
      }
      revertingRef.current = true;
      try {
        const prefs = snapshotInterfacePreferences();
        const previousId = lastAppliedThemeId.current;
        const previous =
          previousId && previousId !== failedThemeId
            ? themes.data?.items.find((item) => item.id === previousId)
            : undefined;
        if (previous) {
          const parents = buildParentChain(previous, themes.data?.items ?? []);
          if (parents) {
            applyInstalledTheme(previous, parents, themeMode);
          } else {
            clearThemeOverrides();
          }
        } else {
          clearThemeOverrides();
        }
        setInterfacePreferences(prefs);
      } finally {
        revertingRef.current = false;
      }
    };
    window.addEventListener(THEME_APPLY_FAILED_EVENT, onApplyFailed);
    return () => window.removeEventListener(THEME_APPLY_FAILED_EVENT, onApplyFailed);
  }, [activeThemeId, themeMode, themes.data]);

  useEffect(() => {
    const prefs = snapshotInterfacePreferences();
    if (safeMode) {
      clearThemeOverrides();
      setInterfacePreferences(prefs);
      return;
    }
    const active = activeTheme;
    if (!active) {
      clearThemeOverrides();
      setInterfacePreferences(prefs);
      return;
    }
    const parents = buildParentChain(active, themes.data?.items ?? []);
    if (!parents) {
      clearThemeOverrides();
      setInterfacePreferences(prefs);
      return;
    }
    try {
      const applied = applyInstalledTheme(active, parents, themeMode);
      setInterfacePreferences(prefs);
      if (applied) {
        lastAppliedThemeId.current = active.id;
        frontendPluginRuntime.emitEvent('theme.changed', { themeId: active.id });
      }
    } catch {
      // Defensive: an unexpected throw still reverts to built-in defaults.
      clearThemeOverrides();
      setInterfacePreferences(prefs);
    }
  }, [safeMode, themeMode, systemDark, systemReducedMotion, themes.data, activeTheme]);

  // Theme-owned settings (ТЗ §6.5): fetch persisted values and emit them as
  // the manifest-declared CSS custom properties. Depends on everything that
  // re-runs the apply effect above, because that effect clears setting
  // variables along with the theme overrides (THEME-41). The transport
  // helper returns `undefined` on the kernel plane (the wire contract does
  // not model theme settings yet) so the theme applies its defaults.
  useEffect(() => {
    if (safeMode || !activeTheme) return;
    const theme = activeTheme;
    let cancelled = false;
    void (async () => {
      try {
        const values = await readThemeSettings(theme.id);
        if (cancelled) return;
        const validation = validateThemeManifest(theme.manifest);
        if (!validation.ok) return;
        applyThemeSettings(validation.value, values);
      } catch {
        // Theme settings are cosmetic; failure must not break the app.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [safeMode, activeTheme, themeMode, systemDark, systemReducedMotion]);

  // Optional local user stylesheet (data/user.css) — documented to load last,
  // above the theme (served wrapped in the `user` cascade layer). Skipped in
  // safe mode like every other third-party style source. A missing file is a
  // silent 404 the browser ignores; on the kernel plane there is no user
  // stylesheet service, so no link is created.
  useEffect(() => {
    if (safeMode) return;
    const href = userCssUrl();
    if (!href) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.neotavernUserStyle = 'user';
    document.head.append(link);
    return () => {
      link.remove();
    };
  }, [safeMode]);

  // Theme translations (ТЗ §9 «тема может переводить название и настройки»):
  // register locale bundles under theme.<id> and drop them on theme change.
  useEffect(() => {
    if (safeMode || !activeTheme) return;
    const theme = activeTheme;
    const urls = theme.localesUrls;
    if (!urls || Object.keys(urls).length === 0) return;
    const namespace = `theme.${theme.id}`;
    let cancelled = false;
    void (async () => {
      for (const [lang, url] of Object.entries(urls)) {
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const resources = (await response.json()) as unknown;
          if (cancelled) return;
          if (resources && typeof resources === 'object' && !Array.isArray(resources)) {
            i18n.addResourceBundle(lang, namespace, resources, true, true);
          }
        } catch {
          continue;
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const lang of Object.keys(urls)) i18n.removeResourceBundle(lang, namespace);
    };
  }, [safeMode, activeTheme, i18n]);

  return null;
}
