/**
 * NeoBackend singleton for the web UI (ТЗ §15).
 *
 * Every API call in the web app routes through the `NeoBackend` facade.
 *
 * - Inside the Tauri desktop shell (Phase 3 local kernel mode) the backend is
 *   `LocalBackend` over `TauriTransport`: React → LocalBackend → Tauri IPC →
 *   Runtime Kernel, with no HTTP server (§11.1).
 * - Anywhere else (web dev server, remote host) `LegacyBackend` stays the
 *   transport: it serves the typed wire operations it maps and the temporary
 *   `raw` passthrough covers the unmigrated routes (tracked in the migration
 *   routing table, `docs/architecture/operations-inventory.md`).
 */
import {
  LegacyBackend,
  LocalBackend,
  UnsupportedError,
  type LegacyRawApi,
  type NeoBackend,
} from '@neotavern/neobackend';
import { request, sseUrl, upload } from './client.js';
import { resolveBackend, type Profile } from './profiles.js';
import { isTauriRuntime, TauriTransport } from './tauriTransport.js';

function createBackend(): NeoBackend {
  if (isTauriRuntime()) {
    return new LocalBackend({ transport: new TauriTransport() });
  }
  return new LegacyBackend({
    baseUrl: window.location.origin,
    transport: {
      request: (method, path, body, signal) => request(method, path, body, signal),
      upload: (path, file, signal) => upload(path, file, signal),
      sseUrl,
    },
  });
}

export const backend: NeoBackend = createBackend();

/**
 * Backend for an explicit profile (ТЗ §7.2 Phase 5). Local profiles resolve
 * to `LocalBackend` over the shell transport — the mobile WebView bridge in
 * the Android shell, Tauri IPC on desktop; remote profiles are Phase 9 scope
 * and throw `UnsupportedError`. The default `createBackend()` singleton above
 * is unchanged: profiles add an explicit override layer on top of it.
 */
export function createBackendForProfile(profile: Profile): NeoBackend {
  return resolveBackend(profile).backend;
}

/**
 * Raw legacy passthrough for unmigrated routes.
 *
 * Temporary: each Phase 3 feature cutover deletes its calls from this path.
 * In local kernel mode (desktop, HTTP off) the legacy `/api/v2` surface is
 * not reachable — every call fails with a typed `UnsupportedError` so
 * unmigrated features degrade with a controlled error instead of a raw
 * TypeError (the migration routing table tracks the cutover surface).
 */
export function legacyRaw(): LegacyRawApi {
  if (isTauriRuntime()) {
    return {
      request: () => {
        throw new UnsupportedError('legacy.raw');
      },
      upload: () => {
        throw new UnsupportedError('legacy.raw.upload');
      },
      sseUrl: () => {
        throw new UnsupportedError('legacy.raw.sseUrl');
      },
    };
  }
  return (backend as LegacyBackend).raw;
}

export { isTauriRuntime };
export type { NeoBackend };
