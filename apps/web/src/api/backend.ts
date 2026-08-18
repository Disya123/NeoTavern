/**
 * NeoBackend singleton for the web UI (ТЗ §15).
 *
 * Every API call in the web app routes through the `NeoBackend` facade.
 *
 * - Inside the Tauri desktop shell the backend is `LocalBackend` over
 *   `TauriTransport`: React → LocalBackend → Tauri IPC → Runtime Kernel.
 * - Inside the Android shell the default is `LocalBackend` over
 *   `MobileBridgeTransport` (JNI). The themed HostConnect gate can switch
 *   the singleton to `RemoteBackend` over Headless / Desktop Remote Access.
 * - A saved remote `hostSession` (browser Web Client or Android after a
 *   pairing link) uses `RemoteBackend` over Product Wire.
 * - Anywhere else (Vite + sidecar, same-origin Web Client) `LegacyBackend`
 *   stays the transport until M7 removes it.
 *
 * The exported `backend` object is a proxy over the active instance so
 * HostConnect can swap Local/Remote without re-importing every module.
 */
import {
  LegacyBackend,
  LocalBackend,
  RemoteBackend,
  UnsupportedError,
  type LegacyRawApi,
  type NeoBackend,
} from '@neotavern/neobackend';
import { request, sseUrl, upload } from './client.js';
import { readHostSession, readRemoteToken } from './hostSession.js';
import { isMobileShell } from '../lib/mobile.js';
import { MobileBridgeTransport } from './mobileTransport.js';
import { resolveBackend, type Profile } from './profiles.js';
import { createRemoteBackend } from './remoteWire.js';
import { isTauriRuntime, TauriTransport } from './tauriTransport.js';

function createLegacyBackend(): LegacyBackend {
  return new LegacyBackend({
    baseUrl: window.location.origin,
    transport: {
      // `LegacyBackend` passes full `/api/v2/...` paths (its contract —
      // parity tests fetch `${baseUrl}${path}`); the same-origin transport
      // (`client.ts`) prepends its own `/api/v2` BASE, so the prefix must be
      // stripped here or every typed legacy call double-prefixes and 404s
      // (`/api/v2/api/v2/...`). `legacyRaw` paths are already BASE-relative.
      request: (method, path, body, signal) =>
        request(
          method,
          path.startsWith('/api/v2') ? path.slice('/api/v2'.length) : path,
          body,
          signal,
        ),
      upload: (path, file, signal) => upload(path, file, signal),
      sseUrl,
    },
  });
}

function createBackend(): NeoBackend {
  if (isTauriRuntime()) {
    return new LocalBackend({ transport: new TauriTransport() });
  }
  const saved = readHostSession();
  if (saved?.kind === 'remote') {
    return createRemoteBackend(saved.url, readRemoteToken());
  }
  if (isMobileShell()) {
    return new LocalBackend({ transport: new MobileBridgeTransport() });
  }
  return createLegacyBackend();
}

let currentBackend: NeoBackend = createBackend();

export function setActiveBackend(next: NeoBackend): void {
  currentBackend = next;
}

export const backend: NeoBackend = new Proxy({} as NeoBackend, {
  get(_target, prop) {
    const value = Reflect.get(currentBackend as object, prop, currentBackend) as unknown;
    if (typeof value === 'function') {
      return (value as (...args: never[]) => unknown).bind(currentBackend);
    }
    return value;
  },
  getPrototypeOf() {
    return Object.getPrototypeOf(currentBackend);
  },
  has(_target, prop) {
    return Reflect.has(currentBackend as object, prop);
  },
});

/**
 * Whether the active backend speaks the Product Wire (in-process kernel or
 * remote Headless), i.e. there is no `/api/v2` surface. API-layer capability
 * gate: React components never branch on the backend kind (ТЗ §13.1) — only
 * transport modules like `generate.ts` consult it.
 */
export function isKernelMode(): boolean {
  return currentBackend instanceof LocalBackend || currentBackend instanceof RemoteBackend;
}

/**
 * Backend for an explicit profile (ТЗ §7.2). Local profiles resolve to
 * `LocalBackend` over the shell transport; remote profiles resolve to
 * `RemoteBackend` over `HttpTransport` (`/rpc` + `/rpc/stream`).
 */
export function createBackendForProfile(profile: Profile): NeoBackend {
  return resolveBackend(profile).backend;
}

/**
 * Raw legacy passthrough for unmigrated routes.
 *
 * Temporary: each feature cutover deletes its calls from this path.
 * On the Product Wire plane (desktop kernel, Android JNI, remote Headless)
 * the legacy `/api/v2` surface is not reachable — every call fails with a
 * typed `UnsupportedError`.
 */
export function legacyRaw(): LegacyRawApi {
  if (isKernelMode()) {
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
  return (currentBackend as LegacyBackend).raw;
}

export { isTauriRuntime };
export type { NeoBackend };
