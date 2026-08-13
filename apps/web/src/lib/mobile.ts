/**
 * Mobile shell detection (ТЗ §7.2 Phase 5).
 *
 * The Android host injects `window.__neotavernMobile` into the WebView; its
 * presence selects `MobileBridgeTransport` in the profile backend resolver.
 * Feature-detected at runtime — the same bundle also runs in a plain browser
 * and the Tauri desktop shell.
 */
export function isMobileShell(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { __neotavernMobile?: unknown }).__neotavernMobile !== undefined
  );
}
