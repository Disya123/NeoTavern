import type { ThemeManifest } from './manifest.js';

/** Stable ids accepted by `theme.json#shellLayout.navigationRail`. */
export const NAVIGATION_RAIL_ITEM_IDS = [
  'chats',
  'characters',
  'personas',
  'lorebooks',
  'backgrounds',
  'ai-settings',
  'plugins',
  'settings',
  'menu-toggle',
] as const;

export type NavigationRailItemId = (typeof NAVIGATION_RAIL_ITEM_IDS)[number];

export const NAVIGATION_RAIL_PANEL_ITEM_IDS = [
  'chats',
  'characters',
  'personas',
  'lorebooks',
  'backgrounds',
  'ai-settings',
  'plugins',
  'settings',
] as const satisfies readonly NavigationRailItemId[];

export type NavigationRailPanelItemId = (typeof NAVIGATION_RAIL_PANEL_ITEM_IDS)[number];

/**
 * Declarative navigation-rail groups. `main` follows normal document flow;
 * `bottom` is pinned to the logical block end by the host shell.
 */
export interface NavigationRailLayout {
  main?: NavigationRailItemId[];
  bottom?: NavigationRailItemId[];
}

/**
 * Placement of the full-height Personas/Characters tab control. When pinned,
 * the list and active menu share a desktop ScrollArea. When pinned, the list
 * stays sticky at its inset top edge; otherwise it scrolls away with the menu.
 * Mobile placement remains controlled by the shell breakpoint.
 */
export interface ManagementTabsLayout {
  pinned?: boolean;
}

/** Declarative, non-executable shell layout options exposed by Theme SDK v1. */
export interface ThemeShellLayout {
  navigationRail?: NavigationRailLayout;
  managementTabs?: ManagementTabsLayout;
}

export interface ResolvedNavigationRailLayout {
  main: NavigationRailItemId[];
  bottom: NavigationRailItemId[];
}

export interface ResolvedManagementTabsLayout {
  pinned: boolean;
}

export interface ResolvedThemeShellLayout {
  navigationRail: ResolvedNavigationRailLayout;
  managementTabs: ResolvedManagementTabsLayout;
}

/** Built-in layout used without an installed theme and by safe mode. */
export const DEFAULT_NAVIGATION_RAIL_LAYOUT: Readonly<ResolvedNavigationRailLayout> = {
  main: ['menu-toggle', ...NAVIGATION_RAIL_PANEL_ITEM_IDS],
  bottom: [],
};

/** The base shell lets desktop management tabs scroll away with their menu. */
export const DEFAULT_MANAGEMENT_TABS_LAYOUT: Readonly<ResolvedManagementTabsLayout> = {
  pinned: false,
};

function applyRailOverride(
  current: ResolvedNavigationRailLayout,
  override: NavigationRailLayout | undefined,
): void {
  if (!override) return;

  if (override.main !== undefined) {
    const movedToMain = new Set(override.main);
    current.main = [...override.main];
    current.bottom = current.bottom.filter((item) => !movedToMain.has(item));
  }

  if (override.bottom !== undefined) {
    const movedToBottom = new Set(override.bottom);
    current.bottom = [...override.bottom];
    current.main = current.main.filter((item) => !movedToBottom.has(item));
  }
}

/**
 * Resolves navigation ordering through the theme inheritance chain. Array
 * fields replace the inherited group and relocate ids declared in the other
 * group. Core destinations omitted by a theme are appended to `main` so a
 * broken theme cannot hide recovery/settings surfaces. `menu-toggle` is the
 * only optional item and disappears when neither resolved group contains it.
 */
export function resolveNavigationRailLayout(
  theme?: ThemeManifest,
  parents: readonly ThemeManifest[] = [],
): ResolvedNavigationRailLayout {
  const resolved: ResolvedNavigationRailLayout = {
    main: [...DEFAULT_NAVIGATION_RAIL_LAYOUT.main],
    bottom: [...DEFAULT_NAVIGATION_RAIL_LAYOUT.bottom],
  };

  for (const entry of theme ? [...parents, theme] : []) {
    applyRailOverride(resolved, entry.shellLayout?.navigationRail);
  }

  const placed = new Set([...resolved.main, ...resolved.bottom]);
  for (const item of NAVIGATION_RAIL_PANEL_ITEM_IDS) {
    if (!placed.has(item)) resolved.main.push(item);
  }

  return resolved;
}

/** Resolve the inherited management-tab placement, with the child winning. */
export function resolveManagementTabsLayout(
  theme?: ThemeManifest,
  parents: readonly ThemeManifest[] = [],
): ResolvedManagementTabsLayout {
  let pinned = DEFAULT_MANAGEMENT_TABS_LAYOUT.pinned;
  for (const entry of theme ? [...parents, theme] : []) {
    const override = entry.shellLayout?.managementTabs?.pinned;
    if (override !== undefined) pinned = override;
  }
  return { pinned };
}

/** Resolve every host-controlled shell option through one inheritance chain. */
export function resolveThemeShellLayout(
  theme?: ThemeManifest,
  parents: readonly ThemeManifest[] = [],
): ResolvedThemeShellLayout {
  return {
    navigationRail: resolveNavigationRailLayout(theme, parents),
    managementTabs: resolveManagementTabsLayout(theme, parents),
  };
}
