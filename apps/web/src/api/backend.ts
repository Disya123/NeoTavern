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
 * - Anywhere else (a bare Vite page with no host) the backend is *closed*: it
 *   constructs, every call throws `UnsupportedError`, and the UI explains the state.
 *
 * The exported `backend` object is a proxy over the active instance so
 * HostConnect can swap Local/Remote without re-importing every module.
 */
import {
  CLOSED_NODE,
  createClosedBackend,
  LocalBackend,
  RemoteBackend,
  type NeoBackend,
} from '@neotavern/neobackend';
import { readHostSession, readRemoteToken } from './hostSession.js';
import { isMobileShell } from '../lib/mobile.js';
import { MobileBridgeTransport } from './mobileTransport.js';
import { resolveBackend, type Profile } from './profiles.js';
import { createRemoteBackend } from './remoteWire.js';
import { isTauriRuntime, TauriTransport } from './tauriTransport.js';

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
  // No shell, no bridge, no saved remote host: the page renders, and every call
  // rejects with a typed UnsupportedError naming the surface it wanted.
  return createClosedBackend();
}

let currentBackend: NeoBackend = createBackend();

export function setActiveBackend(next: NeoBackend): void {
  currentBackend = next;
}

export const backend: NeoBackend = new Proxy({} as NeoBackend, {
  get(_target, prop) {
    const value = Reflect.get(currentBackend as object, prop, currentBackend) as unknown;
    if (typeof value === 'function') {
      // A closed backend's nodes are callable so the call site rejects with the
      // surface it asked for; binding them would surface `…:chats.bind` instead.
      if ((value as { [CLOSED_NODE]?: boolean })[CLOSED_NODE]) return value;
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
export { isTauriRuntime };
export type { NeoBackend };
