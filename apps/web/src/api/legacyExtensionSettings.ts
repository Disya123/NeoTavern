/**
 * Transport for the documented `window.extension_settings` plugin contour
 * (ТЗ §14 legacy compatibility, AGENTS.md §18).
 *
 * The bridge components never call the legacy surface themselves (ARC-03):
 * the extension-settings read/write go through this module, exactly like the
 * other transport helpers in `wireBridge.ts`.
 *
 * **Kernel plane**: the kernel has no legacy extension-settings store — that
 * keyspace (`legacy.extension-settings` in the legacy `app.db`, served on
 * the legacy surface's extension-settings routes) belongs to the legacy
 * contour, which is feature-frozen (ADR-0038). The honest kernel behavior is
 * an empty settings map with no persistence: plugins keep their settings for
 * the session through the bridge's in-memory state, and nothing here opens a
 * legacy call from kernel mode (ARC-02). The legacy contour (sidecar /
 * remote Web Client) keeps the real store.
 */
import type {
  LegacyExtensionSettings,
  LegacyExtensionSettingsResponse,
} from '@neotavern/contracts';
import { isKernelMode, legacyRaw } from './backend.js';

/** Read the full extension-settings map (legacy store; empty on kernel). */
export async function loadLegacyExtensionSettings(): Promise<LegacyExtensionSettingsResponse> {
  if (isKernelMode()) {
    return { items: {} };
  }
  // Tracked transport site (ui-legacy-surface.md; M4: sidecar removal). The
  // no-legacy-api-surface rule is off for this shim (eslint.config.js
  // exemptions) — the ui:api:check scanner gate covers it.
  return legacyRaw().request<LegacyExtensionSettingsResponse>('GET', '/legacy/extension-settings');
}

/** Persist one namespace of extension settings (no-op on kernel). */
export async function saveLegacyExtensionSettings(
  namespace: string,
  settings: LegacyExtensionSettings,
): Promise<void> {
  if (isKernelMode()) {
    return;
  }
  // Tracked transport site (ui-legacy-surface.md; M4: sidecar removal).
  await legacyRaw().request(
    'PATCH',
    `/legacy/extension-settings/${encodeURIComponent(namespace)}`,
    { settings },
  );
}
