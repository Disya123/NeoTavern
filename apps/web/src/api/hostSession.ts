/**
 * Host-connect session (M6). Local UI state only: which backend the shell
 * talks to. Pairing tokens never enter localStorage (sessionStorage at most).
 */
import { isMobileShell } from '../lib/mobile.js';
import { isPackagedWebView } from '../lib/routing.js';
import { isTauriRuntime } from './tauriTransport.js';

const SESSION_KEY = 'neotavern.hostSession';
const TOKEN_KEY = 'neotavern.remoteToken';

/** Dispatched to reopen the themed HostConnect gate without clearing the session. */
export const HOST_CONNECT_EVENT = 'neotavern-host-connect';

export type HostSession = { kind: 'local' } | { kind: 'remote'; url: string };

function isHostSession(value: unknown): value is HostSession {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { kind?: unknown; url?: unknown };
  if (record.kind === 'local') return true;
  return record.kind === 'remote' && typeof record.url === 'string' && record.url.length > 0;
}

export function readHostSession(): HostSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isHostSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeHostSession(session: HostSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearHostSession(): void {
  localStorage.removeItem(SESSION_KEY);
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // sessionStorage may be unavailable (privacy mode).
  }
}

export function readRemoteToken(): string | undefined {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    return token === null || token.length === 0 ? undefined : token;
  } catch {
    return undefined;
  }
}

export function writeRemoteToken(token: string | undefined): void {
  try {
    if (token === undefined || token.length === 0) {
      sessionStorage.removeItem(TOKEN_KEY);
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // sessionStorage may be unavailable; the in-memory HttpTransport still holds the token.
  }
}

/** `?connect=<url>` on the document or inside the hash (HashRouter). */
export function readConnectQuery(): string | null {
  if (typeof window === 'undefined') return null;
  const fromSearch = new URLSearchParams(window.location.search).get('connect');
  if (fromSearch !== null && fromSearch.length > 0) return fromSearch;
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return null;
  const fromHash = new URLSearchParams(hash.slice(queryIndex)).get('connect');
  return fromHash !== null && fromHash.length > 0 ? fromHash : null;
}

/**
 * Whether the themed host-connect gate must run before AuthGate.
 *
 * - Tauri desktop: already on LocalBackend — skip.
 * - Android / packaged WebView: skip only after the user picked local or remote.
 * - Browser with `?connect=`: show (and auto-fill) so Playwright can drive
 *   the Headless remote flow.
 * - Plain browser / Vite+sidecar: same-origin LegacyBackend — skip.
 */
export function needsHostConnect(): boolean {
  if (typeof window === 'undefined') return false;
  if (isTauriRuntime()) return false;
  if (readConnectQuery() !== null) return true;
  if (isMobileShell() || isPackagedWebView()) {
    return readHostSession() === null;
  }
  return false;
}

/**
 * Android / packaged WebView can pick local kernel vs a pairing link.
 * Desktop Tauri already owns LocalBackend; the browser Web Client uses
 * `?connect=` / same-origin instead of this gate.
 */
export function canChangeHost(): boolean {
  if (typeof window === 'undefined') return false;
  if (isTauriRuntime()) return false;
  return isMobileShell() || isPackagedWebView();
}

/** Reopen HostConnect. The current session stays until a new Connect succeeds. */
export function openHostConnect(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(HOST_CONNECT_EVENT));
}
