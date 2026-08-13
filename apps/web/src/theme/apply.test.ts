import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledTheme } from '@neotavern/contracts';
import {
  THEME_APPLY_FAILED_EVENT,
  applyInstalledTheme,
  clearThemeOverrides,
  setInterfacePreferences,
} from './apply.js';

function installedTheme(
  id: string,
  manifest: Record<string, unknown>,
  componentsCssUrl: string | null = null,
  shellCssUrl: string | null = null,
): InstalledTheme {
  return {
    id,
    name: id,
    version: '1.0.0',
    enabled: false,
    installedAt: 1,
    manifest: { id, name: id, version: '1.0.0', ...manifest },
    componentsCssUrl,
    shellCssUrl,
    previewUrl: null,
  };
}

afterEach(() => {
  clearThemeOverrides();
  delete document.documentElement.dataset.uiDensity;
  delete document.documentElement.dataset.uiScale;
  delete document.documentElement.dataset.uiContrast;
  delete document.documentElement.dataset.uiFont;
  delete document.documentElement.dataset.uiMotion;
  delete document.documentElement.dataset.chatStyle;
  delete document.documentElement.dataset.chatAvatarStyle;
  delete document.documentElement.dataset.userMessagePosition;
  delete document.documentElement.dataset.characterMessagePosition;
});

describe('interface preference application', () => {
  it('publishes chat and avatar presets through stable root data attributes', () => {
    setInterfacePreferences({
      density: 'compact',
      scale: 'large',
      contrast: 'high',
      fontProfile: 'dyslexia',
      motion: 'reduced',
      chatStyle: 'cards',
      chatAvatarStyle: 'banner',
      userMessagePosition: 'left',
      characterMessagePosition: 'right',
    });

    expect(document.documentElement.dataset).toMatchObject({
      uiDensity: 'compact',
      uiScale: 'large',
      uiContrast: 'high',
      uiFont: 'dyslexia',
      uiMotion: 'reduced',
      chatStyle: 'cards',
      chatAvatarStyle: 'banner',
      userMessagePosition: 'left',
      characterMessagePosition: 'right',
    });
  });
});

describe('installed theme application', () => {
  it('applies inherited tokens and package styles in root-first order', () => {
    const parent = installedTheme(
      'test.parent',
      { tokens: { dark: { 'color-accent': '#112233' } } },
      '/api/v2/themes/test.parent/assets/components.css',
    );
    const active = installedTheme(
      'test.child',
      {
        extends: 'test.parent',
        tokens: { dark: { 'color-danger': '#cc0000' } },
      },
      '/api/v2/themes/test.child/assets/components.css',
      '/api/v2/themes/test.child/assets/shell.css',
    );

    applyInstalledTheme(active, [parent], 'dark');

    expect(document.documentElement.dataset.themeId).toBe('test.child');
    expect(document.documentElement.style.getPropertyValue('--st-color-accent')).toBe('#112233');
    expect(document.documentElement.style.getPropertyValue('--st-color-danger')).toBe('#cc0000');
    expect(
      [...document.querySelectorAll<HTMLLinkElement>('link[data-neotavern-theme-style]')].map(
        (link) => link.getAttribute('href'),
      ),
    ).toEqual([
      '/api/v2/themes/test.parent/assets/components.css?v=1.0.0-1',
      '/api/v2/themes/test.child/assets/components.css?v=1.0.0-1',
      '/api/v2/themes/test.child/assets/shell.css?v=1.0.0-1',
    ]);
  });

  it('changes package style URLs when the same theme id is reinstalled', () => {
    const active = installedTheme(
      'test.updated',
      { tokens: { dark: { 'color-accent': '#abcdef' } } },
      '/api/v2/themes/test.updated/assets/components.css',
    );

    applyInstalledTheme(active, [], 'dark');
    const firstHref = document
      .querySelector<HTMLLinkElement>('link[data-neotavern-theme-style]')
      ?.getAttribute('href');
    applyInstalledTheme({ ...active, installedAt: 2 }, [], 'dark');
    const updatedHref = document
      .querySelector<HTMLLinkElement>('link[data-neotavern-theme-style]')
      ?.getAttribute('href');

    expect(firstHref).toBe('/api/v2/themes/test.updated/assets/components.css?v=1.0.0-1');
    expect(updatedHref).toBe('/api/v2/themes/test.updated/assets/components.css?v=1.0.0-2');
  });

  it('fully removes package styles and token overrides for recovery', () => {
    const active = installedTheme(
      'test.recovery',
      { tokens: { dark: { 'color-accent': '#abcdef' } } },
      '/api/v2/themes/test.recovery/assets/components.css',
    );
    applyInstalledTheme(active, [], 'dark');
    clearThemeOverrides();

    expect(document.documentElement).not.toHaveAttribute('data-theme-id');
    expect(document.documentElement.style.getPropertyValue('--st-color-accent')).toBe('');
    expect(document.querySelector('link[data-neotavern-theme-style]')).toBeNull();
  });

  it('preserves user-resized navigation panel width across theme re-apply', () => {
    document.documentElement.style.setProperty('--st-shell-panel-width', '520px');
    const active = installedTheme(
      'test.panel-width',
      { tokens: { dark: { 'color-accent': '#abcdef' } } },
      '/api/v2/themes/test.panel-width/assets/components.css',
    );

    applyInstalledTheme(active, [], 'dark');

    expect(document.documentElement.style.getPropertyValue('--st-shell-panel-width')).toBe('520px');
  });
});

describe('responsive behavior attributes', () => {
  it('publishes the manifest responsive hints as root data attributes', () => {
    const active = installedTheme('test.responsive', {
      responsive: { density: 'compact', motion: 'reduced' },
    });

    applyInstalledTheme(active, [], 'light');

    expect(document.documentElement.dataset.themeDensity).toBe('compact');
    expect(document.documentElement.dataset.themeMotion).toBe('reduced');
  });

  it('falls back to the host defaults when the manifest omits responsive fields', () => {
    const active = installedTheme('test.responsive-defaults', {});

    applyInstalledTheme(active, [], 'light');

    expect(document.documentElement.dataset.themeDensity).toBe('comfortable');
    expect(document.documentElement.dataset.themeMotion).toBe('standard');
  });

  it('removes responsive attributes when overrides are cleared', () => {
    const active = installedTheme('test.responsive-clear', {
      responsive: { density: 'spacious', motion: 'standard' },
    });
    applyInstalledTheme(active, [], 'light');
    clearThemeOverrides();

    expect(document.documentElement).not.toHaveAttribute('data-theme-density');
    expect(document.documentElement).not.toHaveAttribute('data-theme-motion');
  });
});

describe('theme apply failure', () => {
  it('returns false, reverts to defaults and emits an event for an invalid active manifest', () => {
    const failedThemeIds: string[] = [];
    const onApplyFailed = (event: Event): void => {
      failedThemeIds.push((event as CustomEvent<{ themeId?: unknown }>).detail?.themeId as string);
    };
    window.addEventListener(THEME_APPLY_FAILED_EVENT, onApplyFailed);
    try {
      const active = installedTheme('test.broken', {
        tokens: { light: { 'not-a-token': '#fff' } },
      });

      const applied = applyInstalledTheme(active, [], 'dark');

      expect(applied).toBe(false);
      expect(document.documentElement).not.toHaveAttribute('data-theme-id');
      expect(document.documentElement.style.getPropertyValue('--st-color-accent')).toBe('');
      expect(failedThemeIds).toEqual(['test.broken']);
    } finally {
      window.removeEventListener(THEME_APPLY_FAILED_EVENT, onApplyFailed);
    }
  });

  it('emits an event when a package stylesheet fails to load', () => {
    const failedThemeIds: string[] = [];
    const onApplyFailed = (event: Event): void => {
      failedThemeIds.push((event as CustomEvent<{ themeId?: unknown }>).detail?.themeId as string);
    };
    window.addEventListener(THEME_APPLY_FAILED_EVENT, onApplyFailed);
    try {
      const active = installedTheme(
        'test.link-error',
        {},
        '/api/v2/themes/test.link-error/assets/components.css',
      );

      expect(applyInstalledTheme(active, [], 'dark')).toBe(true);
      const link = document.querySelector<HTMLLinkElement>('link[data-neotavern-theme-style]');
      expect(link).not.toBeNull();
      link?.dispatchEvent(new Event('error'));

      expect(failedThemeIds).toEqual(['test.link-error']);
    } finally {
      window.removeEventListener(THEME_APPLY_FAILED_EVENT, onApplyFailed);
    }
  });
});
