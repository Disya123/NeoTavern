import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  TOKEN_NAMES,
  validateThemeManifest,
  resolveTokens,
  resolveThemeResponsive,
  tokensToCssVariables,
  buildThemeVariables,
  getSafeModeFromSearch,
  dataHook,
  resolveManagementTabsLayout,
  resolveNavigationRailLayout,
  resolveThemeShellLayout,
  type ThemeManifest,
} from '../src/index.js';

describe('tokens', () => {
  it('provides every canonical token in both modes', () => {
    for (const name of TOKEN_NAMES) {
      expect(DEFAULT_LIGHT_TOKENS[name], `light:${name}`).toBeTruthy();
      expect(DEFAULT_DARK_TOKENS[name], `dark:${name}`).toBeTruthy();
    }
  });
});

describe('manifest validation', () => {
  it('accepts a valid manifest', () => {
    const result = validateThemeManifest({
      id: 'author.cool-theme',
      name: 'Cool',
      version: '1.0.0',
      tokens: { dark: { 'color-accent': '#ff00aa' } },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects invalid input', () => {
    expect(validateThemeManifest({ id: 'bad id!', name: '', version: 'x' }).ok).toBe(false);
    expect(validateThemeManifest(null).ok).toBe(false);
  });

  it('rejects traversal paths, future APIs and unsafe token definitions', () => {
    const base = { id: 'author.theme', name: 'Theme', version: '1.0.0' };
    expect(validateThemeManifest({ ...base, componentsCss: '../outside.css' }).ok).toBe(false);
    expect(validateThemeManifest({ ...base, apiVersion: 99 }).ok).toBe(false);
    expect(
      validateThemeManifest({
        ...base,
        tokens: { light: { 'unknown-token': '#fff' } },
      }).ok,
    ).toBe(false);
    expect(
      validateThemeManifest({
        ...base,
        tokens: { light: { 'color-accent': 'red; background: black' } },
      }).ok,
    ).toBe(false);
    expect(validateThemeManifest({ ...base, shell: 'shell.ts' }).ok).toBe(false);
    expect(
      validateThemeManifest({ ...base, componentsCss: 'skin.css', shell: 'shell.css' }).ok,
    ).toBe(true);
    expect(validateThemeManifest({ ...base, extends: '../parent' }).ok).toBe(false);
    expect(
      validateThemeManifest({
        ...base,
        tokens: { light: { 'image-background': 'url(https://tracker.example/pixel)' } },
      }).ok,
    ).toBe(false);
    expect(validateThemeManifest({ ...base, settings: { density: 'compact' } }).ok).toBe(false);
    expect(
      validateThemeManifest({
        ...base,
        settings: {
          density: { type: 'select', label: 'Density', options: ['compact', 'comfortable'] },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateThemeManifest({
        ...base,
        shellLayout: {
          navigationRail: {
            main: ['settings', 'chats', 'menu-toggle'],
            bottom: ['characters'],
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateThemeManifest({
        ...base,
        shellLayout: { navigationRail: { main: ['unknown'] } },
      }).ok,
    ).toBe(false);
    expect(
      validateThemeManifest({
        ...base,
        shellLayout: {
          navigationRail: { main: ['menu-toggle'], bottom: ['menu-toggle'] },
        },
      }).ok,
    ).toBe(false);
    const managementTabsResult = validateThemeManifest({
      ...base,
      shellLayout: { managementTabs: { pinned: true } },
    });
    expect(managementTabsResult.ok).toBe(true);
    expect(managementTabsResult.value?.shellLayout?.managementTabs).toEqual({ pinned: true });
    expect(
      validateThemeManifest({
        ...base,
        shellLayout: { managementTabs: { pinned: 'yes' } },
      }).ok,
    ).toBe(false);
    expect(validateThemeManifest({ ...base, shellLayout: { managementTabs: true } }).ok).toBe(
      false,
    );
  });
});

describe('navigation rail layout', () => {
  const base: ThemeManifest = { id: 'base', name: 'Base', version: '1.0.0' };

  it('uses the built-in order and keeps the menu toggle first', () => {
    expect(resolveNavigationRailLayout()).toEqual({
      main: [
        'menu-toggle',
        'chats',
        'characters',
        'personas',
        'lorebooks',
        'backgrounds',
        'ai-settings',
        'plugins',
        'settings',
      ],
      bottom: [],
    });
  });

  it('reorders destinations, relocates the toggle and preserves omitted core items', () => {
    const resolved = resolveNavigationRailLayout({
      ...base,
      shellLayout: {
        navigationRail: { main: ['menu-toggle', 'settings', 'chats'] },
      },
    });

    expect(resolved).toEqual({
      main: [
        'menu-toggle',
        'settings',
        'chats',
        'characters',
        'personas',
        'lorebooks',
        'backgrounds',
        'ai-settings',
        'plugins',
      ],
      bottom: [],
    });
  });

  it('preserves an explicit order for every icon across main and bottom', () => {
    const resolved = resolveNavigationRailLayout({
      ...base,
      shellLayout: {
        navigationRail: {
          main: ['settings', 'menu-toggle', 'personas'],
          bottom: ['plugins', 'chats', 'ai-settings', 'characters'],
        },
      },
    });

    expect(resolved).toEqual({
      main: ['settings', 'menu-toggle', 'personas', 'lorebooks', 'backgrounds'],
      bottom: ['plugins', 'chats', 'ai-settings', 'characters'],
    });
  });

  it('inherits groups field-by-field and lets a child hide the optional toggle', () => {
    const parent: ThemeManifest = {
      ...base,
      shellLayout: { navigationRail: { main: ['personas', 'chats'] } },
    };
    const child: ThemeManifest = {
      id: 'child',
      name: 'Child',
      version: '1.0.0',
      extends: 'base',
      shellLayout: { navigationRail: { bottom: [] } },
    };

    expect(resolveNavigationRailLayout(child, [parent])).toEqual({
      main: [
        'personas',
        'chats',
        'characters',
        'lorebooks',
        'backgrounds',
        'ai-settings',
        'plugins',
        'settings',
      ],
      bottom: [],
    });
  });
});

describe('management tabs layout', () => {
  const base: ThemeManifest = { id: 'base', name: 'Base', version: '1.0.0' };

  it('lets desktop management tabs scroll away by default', () => {
    expect(resolveManagementTabsLayout()).toEqual({ pinned: false });
  });

  it('inherits the setting and lets the child override it', () => {
    const parent: ThemeManifest = {
      ...base,
      shellLayout: { managementTabs: { pinned: false } },
    };
    const child: ThemeManifest = {
      id: 'child',
      name: 'Child',
      version: '1.0.0',
      extends: 'base',
      shellLayout: { managementTabs: { pinned: true } },
    };
    const inheritedChild: ThemeManifest = {
      id: 'inherited-child',
      name: 'Inherited child',
      version: '1.0.0',
      extends: 'base',
    };

    expect(resolveManagementTabsLayout(undefined)).toEqual({ pinned: false });
    expect(resolveManagementTabsLayout(inheritedChild, [parent])).toEqual({ pinned: false });
    expect(resolveManagementTabsLayout(child, [parent])).toEqual({ pinned: true });
    expect(resolveThemeShellLayout(inheritedChild, [parent]).managementTabs).toEqual({
      pinned: false,
    });
  });
});

describe('responsive semantics', () => {
  const base = { id: 'author.responsive', name: 'Responsive', version: '1.0.0' };

  it('accepts a valid responsive object', () => {
    const result = validateThemeManifest({
      ...base,
      responsive: { density: 'compact', motion: 'reduced' },
    });
    expect(result.ok).toBe(true);
    expect(result.value?.responsive).toEqual({ density: 'compact', motion: 'reduced' });
  });

  it('rejects unknown density and motion values with a stable error code', () => {
    for (const responsive of [
      { density: 'huge' },
      { motion: 'smooth' },
      { density: 'compact', motion: 'every-frame' },
      'compact',
      null,
    ]) {
      const result = validateThemeManifest({ ...base, responsive });
      expect(result.ok, JSON.stringify(responsive)).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('THEME_INVALID');
        const issues = result.error.params?.issues ?? [];
        // Object-valued responsive payloads produce field-prefixed issues
        // (`responsive.density` / `responsive.motion`); non-object payloads
        // fail with a single shape issue mentioning the field path.
        if (responsive !== null && typeof responsive === 'object') {
          expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(/^responsive\./u)]));
        } else {
          expect(issues.some((issue) => String(issue).includes('responsive'))).toBe(true);
        }
      }
    }
  });

  it('resolves omitted responsive fields to the host defaults', () => {
    const densityOnly = validateThemeManifest({ ...base, responsive: { density: 'compact' } });
    expect(densityOnly.ok).toBe(true);
    expect(densityOnly.value?.responsive).toEqual({ density: 'compact' });
    const resolved = resolveThemeResponsive(
      densityOnly.value ?? { id: 'x', name: 'X', version: '1.0.0' },
    );
    expect(resolved).toEqual({ density: 'compact', motion: 'standard' });

    // No responsive object at all → both defaults.
    expect(resolveThemeResponsive({ id: 'plain', name: 'Plain', version: '1.0.0' })).toEqual({
      density: 'comfortable',
      motion: 'standard',
    });
  });

  it('rejects responsive on a non-object value', () => {
    expect(validateThemeManifest({ ...base, responsive: [] }).ok).toBe(false);
  });
});

describe('resolveTokens', () => {
  const base: ThemeManifest = { id: 'base', name: 'Base', version: '1.0.0' };

  it('falls back to defaults', () => {
    const resolved = resolveTokens(base, 'light');
    expect(resolved['color-accent']).toBe(DEFAULT_LIGHT_TOKENS['color-accent']);
  });

  it('fills every canonical token a theme omits from the built-in defaults (§83)', () => {
    const theme: ThemeManifest = {
      ...base,
      tokens: { light: { 'color-accent': '#123456' } },
    };
    const light = resolveTokens(theme, 'light');
    // The omitted canonical tokens resolve to the DEFAULT_LIGHT values.
    expect(light['color-text-primary']).toBe(DEFAULT_LIGHT_TOKENS['color-text-primary']);
    expect(light['color-danger']).toBe(DEFAULT_LIGHT_TOKENS['color-danger']);
    expect(light['motion-duration-normal']).toBe(DEFAULT_LIGHT_TOKENS['motion-duration-normal']);
    // The overridden token wins.
    expect(light['color-accent']).toBe('#123456');
    // Dark mode: same omission contract against DEFAULT_DARK, with the light
    // override inherited (dark falls back to the theme's light tokens).
    const dark = resolveTokens(theme, 'dark');
    expect(dark['color-text-primary']).toBe(DEFAULT_DARK_TOKENS['color-text-primary']);
    expect(dark['color-accent']).toBe('#123456');
  });

  it('applies theme overrides', () => {
    const theme: ThemeManifest = {
      ...base,
      tokens: { light: { 'color-accent': '#123456' } },
    };
    expect(resolveTokens(theme, 'light')['color-accent']).toBe('#123456');
  });

  it('inherits from parents with child winning', () => {
    const parent: ThemeManifest = {
      id: 'parent',
      name: 'Parent',
      version: '1.0.0',
      tokens: { light: { 'color-accent': '#aaaaaa', 'color-danger': '#bb0000' } },
    };
    const child: ThemeManifest = {
      id: 'child',
      name: 'Child',
      version: '1.0.0',
      extends: 'parent',
      tokens: { light: { 'color-accent': '#cccccc' } },
    };
    const resolved = resolveTokens(child, 'light', [parent]);
    expect(resolved['color-accent']).toBe('#cccccc'); // child override
    expect(resolved['color-danger']).toBe('#bb0000'); // inherited from parent
  });

  it('dark mode falls back to the theme light tokens', () => {
    const theme: ThemeManifest = {
      ...base,
      tokens: { light: { 'color-accent': '#00ff00' } },
    };
    // No dark override → uses light token over dark default.
    expect(resolveTokens(theme, 'dark')['color-accent']).toBe('#00ff00');
  });
});

describe('css variables', () => {
  it('prefixes token names with --st-', () => {
    const vars = tokensToCssVariables({ 'color-accent': '#fff' } as never);
    expect(vars['--st-color-accent']).toBe('#fff');
  });

  it('builds variables for a theme', () => {
    const theme: ThemeManifest = { id: 't', name: 'T', version: '1.0.0' };
    const vars = buildThemeVariables(theme, 'dark');
    expect(Object.keys(vars).length).toBeGreaterThanOrEqual(TOKEN_NAMES.length);
    expect(vars['--st-color-surface-primary']).toBe(DEFAULT_DARK_TOKENS['color-surface-primary']);
  });
});

describe('safe mode', () => {
  it('detects ?safe=1', () => {
    expect(getSafeModeFromSearch('?safe=1')).toBe(true);
    expect(getSafeModeFromSearch('?foo=bar&safe=1')).toBe(true);
    expect(getSafeModeFromSearch('?safe=0')).toBe(false);
    expect(getSafeModeFromSearch('')).toBe(false);
  });
});

describe('data hooks', () => {
  it('builds stable data attributes', () => {
    expect(
      dataHook('chat-message', { part: 'container', role: 'assistant', state: 'streaming' }),
    ).toEqual({
      'data-component': 'chat-message',
      'data-part': 'container',
      'data-role': 'assistant',
      'data-state': 'streaming',
    });
  });
});
