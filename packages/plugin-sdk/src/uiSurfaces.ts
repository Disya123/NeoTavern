/**
 * UI surface resolution (ADR-0066 D4).
 *
 * A plugin declares what it wants to render into; the host decides what it is allowed
 * to render into. This module is that decision, in one place, without a DOM: the same
 * function answers for the web client, the desktop shell and any future surface.
 *
 * Rules:
 *
 * - no declaration means no surface (`none`) — silence is not permission;
 * - a panel or an overlay needs the matching grant (`ui.panel`, `ui.overlay`);
 * - replacing the whole shell needs `ui.shell.replace`, and is refused without it,
 *   because the host keeps the only way back;
 * - an unknown surface is refused rather than downgraded: a plugin that asked for
 *   something the host does not implement must learn that, not get a silent panel.
 */
import type { PluginRuntimeDeclaration, PluginUiSurface } from './manifest.js';

/** What the host will actually render. `none` means "declared but not granted". */
export type ResolvedUiSurface = PluginUiSurface;

/** Capability each surface requires, if any. */
const SURFACE_CAPABILITY: Partial<Record<PluginUiSurface, string>> = {
  panel: 'ui.panel',
  overlay: 'ui.overlay',
  shell: 'ui.shell.replace',
};

/** Why a surface was refused, for the diagnostics panel. */
export interface UiSurfaceDecision {
  surface: ResolvedUiSurface;
  /** Capability that would have been needed, when the answer is a refusal. */
  missing?: string;
}

/**
 * Resolves the surface a plugin may use.
 *
 * `granted` is the capability list recorded at install — the same list the kernel
 * checks, not a second opinion.
 */
export function resolveUiSurface(
  runtime: PluginRuntimeDeclaration | undefined,
  granted: readonly string[],
): UiSurfaceDecision {
  const requested = runtime?.ui ?? 'none';
  if (requested === 'none') return { surface: 'none' };

  const required = SURFACE_CAPABILITY[requested];
  if (required && !granted.includes(required)) {
    return { surface: 'none', missing: required };
  }
  return { surface: requested };
}
