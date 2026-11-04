/**
 * Opening a plugin that replaces the whole window (ADR-0066 D4).
 *
 * Two conditions have to hold before the shell changes hands: the plugin declares
 * `runtime.ui: 'shell'`, and the user actually granted `ui.shell.replace`. A manifest
 * cannot grant itself anything, so the second check is the one that matters — and it is
 * read from what the kernel recorded, not from what the plugin says about itself.
 */
import { resolveUiSurface, type PluginRuntimeDeclaration } from '@neotavern/plugin-sdk';
import { shellMode } from './shellMode.js';

export interface ShellCandidate {
  id: string;
  manifest?: Record<string, unknown> | null;
  grantedPermissions: readonly string[];
}

/** True when this plugin may take over the window right now. */
export function canReplaceShell(plugin: ShellCandidate): boolean {
  const runtime = plugin.manifest?.['runtime'];
  const surface = resolveUiSurface(
    typeof runtime === 'object' && runtime !== null
      ? (runtime as PluginRuntimeDeclaration)
      : undefined,
    plugin.grantedPermissions,
  );
  return surface.surface === 'shell';
}

/**
 * Hands the shell over, or reports why it cannot.
 *
 * Returns false rather than throwing: a hidden button is a UI detail, but a wrong
 * transition would leave the user staring at a frame they cannot leave.
 */
export function launchShell(plugin: ShellCandidate): boolean {
  if (!canReplaceShell(plugin)) return false;
  shellMode.replace(plugin.id);
  return true;
}
