/** Applies the persisted theme mode and language to the document. Renders
 * nothing; kept as a component so it lives inside the provider tree. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { validateThemeManifest } from '@neotavern/theme-sdk';
import { useUiStore } from '../state/ui.js';
import { useThemes } from '../api/hooks.js';
import {
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

  useEffect(() => {
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
    const prefs = {
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
    const byId = new Map(themes.data?.items.map((item) => [item.id, item]) ?? []);
    const parents = [];
    const seen = new Set<string>([active.id]);
    let parentId =
      typeof active.manifest['extends'] === 'string' ? active.manifest['extends'] : undefined;
    while (parentId) {
      if (seen.has(parentId)) {
        clearThemeOverrides();
        setInterfacePreferences(prefs);
        return;
      }
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) {
        clearThemeOverrides();
        setInterfacePreferences(prefs);
        return;
      }
      parents.unshift(parent);
      parentId =
        typeof parent.manifest['extends'] === 'string' ? parent.manifest['extends'] : undefined;
    }
    try {
      applyInstalledTheme(active, parents, themeMode);
      setInterfacePreferences(prefs);
      frontendPluginRuntime.emitEvent('theme.changed', { themeId: active.id });
    } catch {
      clearThemeOverrides();
      setInterfacePreferences(prefs);
    }
  }, [safeMode, themeMode, systemDark, systemReducedMotion, themes.data, activeTheme]);

  // Theme-owned settings (ТЗ §6.5): fetch persisted values and emit them as
  // the manifest-declared CSS custom properties. Depends on everything that
  // re-runs the apply effect above, because that effect clears setting
  // variables along with the theme overrides (THEME-41).
  useEffect(() => {
    if (safeMode || !activeTheme) return;
    const theme = activeTheme;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/v2/themes/${encodeURIComponent(theme.id)}/settings`);
        if (!response.ok || cancelled) return;
        const data = (await response.json()) as { values?: Record<string, unknown> };
        if (cancelled) return;
        const validation = validateThemeManifest(theme.manifest);
        if (!validation.ok) return;
        applyThemeSettings(validation.value, data.values);
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
  // silent 404 the browser ignores.
  useEffect(() => {
    if (safeMode) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/api/v2/user.css';
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
