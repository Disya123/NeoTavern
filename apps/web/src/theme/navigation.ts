import type { ThemeListResponse } from '@neotavern/contracts';
import {
  resolveThemeShellLayout,
  validateThemeManifest,
  type ResolvedNavigationRailLayout,
  type ResolvedThemeShellLayout,
  type ThemeManifest,
} from '@neotavern/theme-sdk';

/**
 * Resolve the active installed theme's host-controlled shell layout. Any
 * invalid or incomplete inheritance chain falls back to the built-in safe
 * layout.
 */
export function resolveInstalledThemeShellLayout(
  themes: ThemeListResponse | undefined,
  safeMode: boolean,
): ResolvedThemeShellLayout {
  if (safeMode || !themes?.activeThemeId) return resolveThemeShellLayout();

  const active = themes.items.find((item) => item.id === themes.activeThemeId);
  if (!active) return resolveThemeShellLayout();

  const byId = new Map(themes.items.map((item) => [item.id, item]));
  const chain = [active];
  const seen = new Set<string>([active.id]);
  let parentId =
    typeof active.manifest['extends'] === 'string' ? active.manifest['extends'] : undefined;

  while (parentId) {
    if (seen.has(parentId)) return resolveThemeShellLayout();
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return resolveThemeShellLayout();
    chain.unshift(parent);
    parentId =
      typeof parent.manifest['extends'] === 'string' ? parent.manifest['extends'] : undefined;
  }

  const manifests: ThemeManifest[] = [];
  for (const item of chain) {
    const result = validateThemeManifest(item.manifest);
    if (!result.ok) return resolveThemeShellLayout();
    manifests.push(result.value);
  }

  const manifest = manifests.at(-1);
  return manifest
    ? resolveThemeShellLayout(manifest, manifests.slice(0, -1))
    : resolveThemeShellLayout();
}

/** Backwards-compatible focused helper for navigation-rail consumers. */
export function resolveInstalledNavigationRailLayout(
  themes: ThemeListResponse | undefined,
  safeMode: boolean,
): ResolvedNavigationRailLayout {
  return resolveInstalledThemeShellLayout(themes, safeMode).navigationRail;
}
