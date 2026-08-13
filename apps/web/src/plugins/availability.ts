/**
 * Explicit extension runtime availability (ТЗ §60/§61/§92).
 *
 * The web host always renders themes; the Node plugin runtime is unavailable
 * in desktop kernel mode (no HTTP server, no plugin host — the SPA talks to
 * the Rust kernel over Tauri IPC only). `reduced` is reserved for future
 * degraded modes (e.g. sandboxed iframes unavailable); the web host never
 * reports it today.
 */
import { isTauriRuntime } from '../api/tauriTransport.js';

export type ExtensionAvailabilityState = 'available' | 'unavailable' | 'reduced';

/** Machine-readable reasons for non-available extension surfaces. */
export const ExtensionAvailabilityReason = {
  /** Desktop kernel mode has no plugin host (no HTTP server). */
  NODE_RUNTIME_DESKTOP_KERNEL_MODE: 'node-runtime-desktop-kernel-mode',
} as const;

export interface ExtensionAvailability {
  /** Theme rendering availability in the web host (always available). */
  themes: 'available' | 'unavailable';
  /** Node plugin runtime availability (desktop kernel mode has no host). */
  nodeRuntime: ExtensionAvailabilityState;
  /** Machine-readable reason when a surface is not fully available. */
  reason?: string;
}

/** Pure availability probe; stable for the lifetime of the window. */
export function getExtensionAvailability(): ExtensionAvailability {
  if (isTauriRuntime()) {
    return {
      themes: 'available',
      nodeRuntime: 'unavailable',
      reason: ExtensionAvailabilityReason.NODE_RUNTIME_DESKTOP_KERNEL_MODE,
    };
  }
  return { themes: 'available', nodeRuntime: 'available' };
}

/** React hook mirroring {@link getExtensionAvailability}. */
export function useExtensionAvailability(): ExtensionAvailability {
  return getExtensionAvailability();
}
