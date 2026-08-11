import { describe, expect, it } from 'vitest';
import type { ThemeListResponse } from '@neotavern/contracts';
import {
  resolveInstalledNavigationRailLayout,
  resolveInstalledThemeShellLayout,
} from './navigation.js';

const ACTIVE_THEMES: ThemeListResponse = {
  activeThemeId: 'child',
  items: [
    {
      id: 'parent',
      name: 'Parent',
      version: '1.0.0',
      enabled: false,
      manifest: {
        id: 'parent',
        name: 'Parent',
        version: '1.0.0',
        shellLayout: {
          navigationRail: { main: ['personas', 'chats'] },
          managementTabs: { pinned: false },
        },
      },
      installedAt: 1,
      componentsCssUrl: null,
      shellCssUrl: null,
      previewUrl: null,
    },
    {
      id: 'child',
      name: 'Child',
      version: '1.0.0',
      enabled: true,
      manifest: {
        id: 'child',
        name: 'Child',
        version: '1.0.0',
        extends: 'parent',
        shellLayout: { navigationRail: { bottom: ['settings', 'menu-toggle'] } },
      },
      installedAt: 2,
      componentsCssUrl: null,
      shellCssUrl: null,
      previewUrl: null,
    },
  ],
};

describe('resolveInstalledNavigationRailLayout', () => {
  it('applies active theme inheritance and relocates bottom items', () => {
    expect(resolveInstalledNavigationRailLayout(ACTIVE_THEMES, false)).toEqual({
      main: [
        'personas',
        'chats',
        'characters',
        'lorebooks',
        'backgrounds',
        'ai-settings',
        'plugins',
      ],
      bottom: ['settings', 'menu-toggle'],
    });
    expect(resolveInstalledThemeShellLayout(ACTIVE_THEMES, false).managementTabs).toEqual({
      pinned: false,
    });
  });

  it('lets the active child override inherited management-tab pinning', () => {
    const childOverride: ThemeListResponse = {
      ...ACTIVE_THEMES,
      items: ACTIVE_THEMES.items.map((item) =>
        item.id === 'child'
          ? {
              ...item,
              manifest: {
                id: 'child',
                name: 'Child',
                version: '1.0.0',
                extends: 'parent',
                shellLayout: {
                  navigationRail: { bottom: ['settings', 'menu-toggle'] },
                  managementTabs: { pinned: true },
                },
              },
            }
          : item,
      ),
    };

    expect(resolveInstalledThemeShellLayout(childOverride, false).managementTabs).toEqual({
      pinned: true,
    });
  });

  it('uses the built-in layout in safe mode or for a broken chain', () => {
    const builtIn = {
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
    };
    expect(resolveInstalledNavigationRailLayout(ACTIVE_THEMES, true)).toEqual(builtIn);
    expect(
      resolveInstalledNavigationRailLayout(
        {
          ...ACTIVE_THEMES,
          items: ACTIVE_THEMES.items.filter((item) => item.id !== 'parent'),
        },
        false,
      ),
    ).toEqual(builtIn);
    expect(resolveInstalledThemeShellLayout(ACTIVE_THEMES, true).managementTabs).toEqual({
      pinned: false,
    });
  });
});
