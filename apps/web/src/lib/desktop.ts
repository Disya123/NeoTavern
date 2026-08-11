/**
 * Minimal Tauri bridge for the desktop shell (ТЗ §15/§19).
 *
 * The same bundle also runs in a plain browser, so the bridge is
 * feature-detected at runtime and talks to Tauri through its injected
 * internals — no hard `@tauri-apps/api` dependency in the web bundle.
 * The core updater commands are app-defined Rust commands
 * (`check_core_update` / `install_core_update`), which Tauri exposes without
 * capability permissions.
 */

export interface CoreUpdateStatus {
  /** False when the build has no update endpoint/key baked in. */
  configured: boolean;
  currentVersion: string;
  availableVersion: string | null;
}

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

function tauriInternals(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__;
  return internals && typeof internals.invoke === 'function' ? internals : null;
}

/** True when running inside the Tauri desktop shell. */
export function isDesktopShell(): boolean {
  return tauriInternals() !== null;
}

/** Query the desktop core updater. Null outside the desktop shell. */
export async function checkCoreUpdate(): Promise<CoreUpdateStatus | null> {
  const internals = tauriInternals();
  if (!internals) return null;
  return internals.invoke<CoreUpdateStatus>('check_core_update');
}

/**
 * Download, install and restart into the update. Returns false when nothing
 * was pending. Throws with the updater error string otherwise.
 */
export async function installCoreUpdate(): Promise<boolean> {
  const internals = tauriInternals();
  if (!internals) return false;
  return internals.invoke<boolean>('install_core_update');
}
