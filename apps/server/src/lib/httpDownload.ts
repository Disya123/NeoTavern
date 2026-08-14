/**
 * Bounded HTTPS download to disk, shared by the Git plugin source and the
 * dependency installer. Writes atomically (temp file + rename, mode 0o600),
 * enforces a byte cap, refuses non-HTTPS URLs and honors cancellation.
 *
 * SEC-03 (legacy contour): fetch-based downloads resolve DNS inside the
 * fetch implementation, so SSRF protection is enforced at the URL level —
 * every hop (initial URL and each redirect) must be HTTPS and must not
 * target an always-forbidden destination (loopback, link-local incl. cloud
 * metadata 169.254.169.254, multicast, unspecified, local hostnames).
 * Private ranges stay allowed: self-hosted LAN registries are a supported
 * use case. Resolved-IP verification (DNS rebinding) is performed by the
 * canonical network broker, not by fetch-based legacy downloads.
 *
 * SEC-04 (legacy contour): before streaming to disk the free space on the
 * destination volume is preflighted against the expected size
 * (content-length when known, else the byte cap) with a headroom factor.
 */
import { open, rename, rm, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { randomToken, AppError, ErrorCodes } from '@neotavern/shared';

export interface HttpDownloadOptions {
  maxBytes: number;
  signal?: AbortSignal;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overall deadline; defaults to 120s. */
  timeoutMs?: number;
  /** Free-space headroom factor; defaults to 1.1 (10% above the expected). */
  freeSpaceFactor?: number;
  /** Injectable statfs for tests; defaults to node:fs/promises statfs. */
  statfsImpl?: (path: string) => Promise<{ bavail: number; bsize: number }>;
  /**
   * Extra per-hop trust, ANDed with the HTTPS requirement. Return `true`
   * for an operator-trusted host (e.g. the configured package registry) to
   * exempt that hop from the built-in forbidden-range policy — the trust
   * anchor is the operator's own registry, not the risk. Every redirect
   * re-evaluates the same predicate.
   */
  trustedHop?: (url: URL) => boolean;
}

/** Error factory so callers can attach domain-specific codes/params. */
export type DownloadErrorFactory = (reason: string, cause?: unknown) => AppError;

const defaultError = (reason: string, cause?: unknown): AppError =>
  new AppError({
    code: ErrorCodes.BAD_REQUEST,
    params: { reason },
    message: `Download failed: ${reason}`,
    cause,
  });

/** Minimum margin kept above the factor'd expected size (1 MiB). */
const FREE_SPACE_MIN_MARGIN = 1024 * 1024;
/** Redirect hop cap (same as the Git source). */
const MAX_REDIRECTS = 5;

/**
 * SEC-03 destination policy for fetch-based downloads: `true` when `host`
 * must never be a download target (loopback, link-local incl. cloud
 * metadata, multicast, unspecified, and local hostnames). Private ranges
 * (10/8, 172.16/12, 192.168/16, fc00::/7) are allowed for LAN registries.
 */
export function isForbiddenDestinationHost(hostname: string): boolean {
  const lowered = hostname.toLowerCase().replace(/\.$/u, '');
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) return true;
  if (lowered.endsWith('.local')) return true; // mDNS (RFC 6762)
  if (lowered.endsWith('.internal')) return true; // private-use (RFC 6762)

  let ip = lowered;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(ip);
  if (mapped) ip = mapped[1] ?? '';

  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 127) return true; // 127/8 loopback
    if (a === 169 && b === 254) return true; // 169.254/16 link-local (cloud metadata)
    if (a >= 224) return true; // 224/4 multicast
    return false; // private 10/8, 172.16/12, 192.168/16 stay allowed
  }
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::' || v6 === '::1') return true; // unspecified / loopback
    const firstHex = v6.split(':')[0] ?? '';
    if (!/^[0-9a-f]{1,4}$/u.test(firstHex)) return false;
    const head = Number.parseInt(firstHex, 16);
    if (head >= 0xfe80 && head <= 0xfebf) return true; // fe80::/10 link-local
    if (head >= 0xff00) return true; // ff00::/8 multicast
    return false; // fc00::/7 unique-local stays allowed
  }
  // A hostname that is not an IP literal passes the URL-level check; the
  // canonical broker performs resolved-IP verification (see module docs).
  return false;
}

/** Validate one hop: HTTPS, then trust-or-policy. */
function assertAllowedHop(url: URL, trustedHop: ((url: URL) => boolean) | undefined): URL {
  if (url.protocol !== 'https:') throw defaultError('URL_INSECURE');
  if (trustedHop?.(url) === true) return url;
  if (isForbiddenDestinationHost(url.hostname)) throw defaultError('DESTINATION_DENIED');
  return url;
}

function parseHttpsUrl(raw: string, trustedHop?: (url: URL) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw defaultError('URL_MALFORMED');
  }
  return assertAllowedHop(url, trustedHop);
}

/**
 * Persist an already-obtained response body to `destination` (atomic temp +
 * rename). Runs the optional `verify` hook on the temp file before renaming,
 * so callers can reject bad content without ever exposing the final path.
 * SEC-04: the destination volume's free space is preflighted first.
 */
export async function writeResponseToDisk(
  response: Response,
  destination: string,
  options: Pick<HttpDownloadOptions, 'maxBytes' | 'signal' | 'freeSpaceFactor' | 'statfsImpl'>,
  makeError: DownloadErrorFactory = defaultError,
  verify?: (tempPath: string) => Promise<void>,
): Promise<void> {
  if (!response.ok) throw makeError(`HTTP_${response.status}`);
  if (!response.body) throw makeError('EMPTY_RESPONSE');

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
    throw makeError('TOO_LARGE');
  }
  await assertFreeSpace(
    dirname(destination),
    Number.isFinite(contentLength) ? contentLength : options.maxBytes,
    options,
    makeError,
  );

  const signal = options.signal ?? AbortSignal.timeout(120_000);
  const temporary = `${destination}.partial-${randomToken(8)}`;
  try {
    await streamBodyToFile(response.body, temporary, options.maxBytes, signal, makeError);
    if (verify) await verify(temporary);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** SEC-04 free-space preflight: expected * factor + margin must fit. */
async function assertFreeSpace(
  directory: string,
  expectedBytes: number,
  options: Pick<HttpDownloadOptions, 'freeSpaceFactor' | 'statfsImpl'>,
  makeError: DownloadErrorFactory,
): Promise<void> {
  const factor = options.freeSpaceFactor ?? 1.1;
  const required = Math.ceil(expectedBytes * factor) + FREE_SPACE_MIN_MARGIN;
  let info: { bavail: number; bsize: number };
  try {
    info = options.statfsImpl ? await options.statfsImpl(directory) : await statfs(directory);
  } catch {
    // Best-effort: an unavailable statfs must not block the download itself.
    return;
  }
  const free = info.bavail * info.bsize;
  if (free < required) throw makeError('DISK_SPACE');
}

/**
 * Download `url` straight to `destination`. Every hop (the initial URL and
 * each redirect) must be HTTPS and pass the SEC-03 destination policy;
 * redirects are followed manually (≤5) so each one is re-validated.
 */
export async function downloadToFile(
  url: string,
  destination: string,
  options: HttpDownloadOptions,
  makeError: DownloadErrorFactory = defaultError,
): Promise<void> {
  let current = parseHttpsUrl(url, options.trustedHop);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 120_000);

  let response: Response | null = null;
  for (let hop = 0; ; hop += 1) {
    let hopResponse: Response;
    try {
      hopResponse = await fetchImpl(current.toString(), { redirect: 'manual', signal });
    } catch (cause) {
      if (signal.aborted) throw new AppError({ code: ErrorCodes.ABORTED });
      throw makeError('FETCH_FAILED', cause);
    }
    if (hopResponse.status < 300 || hopResponse.status >= 400) {
      response = hopResponse;
      break;
    }
    // Redirect: the next hop re-passes the full policy (§SEC-03) and the hop
    // count is capped.
    const location = hopResponse.headers.get('location');
    await hopResponse.body?.cancel().catch(() => undefined);
    if (!location) throw makeError('REDIRECT_MISSING_LOCATION');
    if (hop >= MAX_REDIRECTS) throw makeError('TOO_MANY_REDIRECTS');
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw makeError('URL_MALFORMED');
    }
    current = assertAllowedHop(next, options.trustedHop);
  }
  if (response === null) throw makeError('FETCH_FAILED');

  await writeResponseToDisk(
    response,
    destination,
    {
      maxBytes: options.maxBytes,
      signal,
      freeSpaceFactor: options.freeSpaceFactor,
      statfsImpl: options.statfsImpl,
    },
    makeError,
  );
}

async function streamBodyToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  makeError: DownloadErrorFactory,
): Promise<void> {
  const reader = body.getReader();
  const handle = await open(path, 'wx', 0o600);
  let received = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new AppError({ code: ErrorCodes.ABORTED });
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw makeError('TOO_LARGE');
      await handle.write(value);
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }
}
