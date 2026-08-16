/**
 * Pairing-link parser for Headless / Desktop Remote Access (M6).
 *
 * A pairing link is an `http(s)` URL. An optional `token` (or `access_token`)
 * query parameter carries the one-time bearer issued at pairing time. The
 * token is never written to localStorage — callers keep it in memory or
 * sessionStorage (AGENTS.md § secrets).
 *
 * The `neotavern:` scheme is accepted as a wrapper:
 * `neotavern://connect?url=<http-url>&token=<token>`.
 */
export interface PairingTarget {
  /** Wire base URL with no trailing slash and no query/hash. */
  baseUrl: string;
  /** Optional pairing bearer (not a CSRF cookie). */
  token?: string;
}

/**
 * Parse a pasted URL, a QR payload, or a `neotavern:` wrapper into a wire
 * target. Returns `null` when the input is empty or not an http(s) address.
 */
export function parsePairingLink(input: string): PairingTarget | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol === 'neotavern:') {
    const inner = url.searchParams.get('url');
    const wrapperToken = url.searchParams.get('token') ?? undefined;
    if (inner === null) return null;
    const parsed = parsePairingLink(inner);
    if (parsed === null) return null;
    return wrapperToken === undefined
      ? parsed
      : { baseUrl: parsed.baseUrl, token: wrapperToken };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const token =
    url.searchParams.get('token') ?? url.searchParams.get('access_token') ?? undefined;
  url.search = '';
  url.hash = '';
  const baseUrl = url.toString().replace(/\/+$/u, '');
  if (token === null || token === undefined || token.length === 0) {
    return { baseUrl };
  }
  return { baseUrl, token };
}

/** Build a pairing link the Android/Web Client QR scanner can read. */
export function formatPairingLink(baseUrl: string, token?: string): string {
  const url = new URL(baseUrl);
  if (token !== undefined && token.length > 0) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}
