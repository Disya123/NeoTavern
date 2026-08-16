/**
 * SSRF-safe outbound HTTP fetch for the legacy (Rev4) plugin runtime
 * (ТЗ §SEC-03; ARC-11: the compatibility contour may restrict but never
 * extend authority).
 *
 * The vNext broker (§29) already enforces the full resolved-IP policy for
 * `api.network.fetch`; this module closes the same gap for the legacy
 * `network.fetch` RPC (`BackendPluginHost.fetchRpc`), which previously
 * resolved DNS inside the fetch implementation and could be driven to
 * loopback / link-local / cloud-metadata endpoints through a hostname.
 *
 * Policy (fail-closed):
 *
 * 1. Every URL hop (initial URL and each redirect) must pass the scheme
 *    check (http/https) and the host-level checks (permission allowlist is
 *    enforced by the caller before this module).
 * 2. ALL DNS answers are resolved and classified; if ANY answer is
 *    forbidden (loopback, link-local incl. cloud metadata 169.254.169.254,
 *    multicast, unspecified) the hop is refused — a hostname that resolves
 *    to a mix of public and forbidden addresses is rebinding-unsafe.
 * 3. The connection is made to the pre-verified IP; the hostname is kept
 *    only for the `Host` header and TLS `servername` (SNI).
 * 4. After connect the socket `remoteAddress` is re-checked (defense in
 *    depth against a lookup/connect race).
 * 5. Redirects (≤ 5) re-run the full policy on every hop.
 * 6. Response bodies are bounded in BYTES; exceeding the cap tears the
 *    request down instead of buffering further.
 *
 * Private ranges (10/8, 172.16/12, 192.168/16, fc00::/7, CGNAT 100.64/10)
 * stay allowed — self-hosted LAN endpoints are a supported use case, the
 * same stance as the plugin-installer download policy (httpDownload.ts).
 * They require a host-level grant from the caller, exactly like public
 * hosts; they never grant access to the always-forbidden ranges.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AppError, ErrorCodes } from '@neotavern/shared';

/** Destination classification used by the SEC-03 policy. */
export type IpClass = 'public' | 'private' | 'forbidden';

/** Redirect hop cap (same as the plugin-installer downloader). */
const MAX_REDIRECTS = 5;

export type LookupFn = (hostname: string) => Promise<string[]>;

export interface SafePluginFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** External cancellation; combined with the timeout. */
  signal?: AbortSignal;
  /** Per-request deadline; defaults to 30s. */
  timeoutMs?: number;
  /** Hard cap on the DECODED response body in bytes (SEC-04). */
  maxBytes: number;
  /** Injectable DNS resolver; defaults to node:dns/promises lookup (all). */
  lookupImpl?: LookupFn;
  /** Injectable http request factory for tests. */
  httpRequestImpl?: typeof httpRequest;
  /** Injectable https request factory for tests. */
  httpsRequestImpl?: typeof httpsRequest;
}

export interface SafePluginFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

const forbidden = (ip: string, hostname?: string): AppError =>
  new AppError({
    code: ErrorCodes.BAD_REQUEST,
    params: { reason: 'DESTINATION_DENIED', ip, ...(hostname ? { hostname } : {}) },
  });

/**
 * Unwrap an IPv4-mapped IPv6 address into its dotted-quad form. Both the
 * dotted (`::ffff:127.0.0.1`) and the hex (`::ffff:7f00:1`) spellings are
 * handled — `URL.hostname` normalizes mapped addresses to the hex form
 * (e.g. `[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`), so a dotted-only regex
 * would let `::ffff:7f00:1` (== 127.0.0.1) through as public (SEC-03).
 * Returns `null` when the address is not in the `::ffff:0:0/96` range.
 */
function unwrapV4Mapped(ip6: string): string | null {
  const lowered = ip6.toLowerCase();
  const match = /^::ffff:(.+)$/u.exec(lowered);
  if (!match) return null;
  const tail = match[1] ?? '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(tail)) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2) return null;
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return null;
  const value = Number.parseInt(groups.map((group) => group.padStart(4, '0')).join(''), 16);
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

/**
 * Classify one IP address against the SEC-03 policy. IPv4-mapped IPv6
 * (`::ffff:a.b.c.d` or the URL-normalized hex `::ffff:xxxx:xxxx`) is
 * unwrapped first so it cannot bypass the v4 rules.
 */
export function classifyIpAddress(ip: string): IpClass {
  const lowered = ip.toLowerCase();
  const mapped = unwrapV4Mapped(lowered);
  if (mapped !== null) return classifyIpAddress(mapped);

  if (isIP(lowered) === 4) {
    const parts = lowered.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0) return 'forbidden'; // 0.0.0.0/8 unspecified
    if (a === 127) return 'forbidden'; // 127/8 loopback
    if (a === 169 && b === 254) return 'forbidden'; // 169.254/16 link-local (cloud metadata)
    if (a >= 224) return 'forbidden'; // 224/4 multicast (incl. 240/4 reserved)
    if (a === 10) return 'private'; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16/12
    if (a === 192 && b === 168) return 'private'; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64/10 CGNAT
    return 'public';
  }

  if (isIP(lowered) === 6) {
    if (lowered === '::' || lowered === '::1') return 'forbidden'; // unspecified / loopback
    const head = Number.parseInt(lowered.split(':')[0] ?? '0', 16);
    if (head >= 0xfe80 && head <= 0xfebf) return 'forbidden'; // fe80::/10 link-local
    if (head >= 0xff00) return 'forbidden'; // ff00::/8 multicast
    if (head >= 0xfc00 && head <= 0xfdff) return 'private'; // fc00::/7 unique-local
    return 'public';
  }

  // A hostname or unparseable value reaching the classifier is a policy
  // failure: fail closed rather than guessing.
  return 'forbidden';
}

/**
 * Resolve `hostname` to the set of IPs the SEC-03 policy admits. IP
 * literals (including bracketed IPv6 from a URL) are classified directly;
 * hostnames are resolved via ALL DNS answers and refused if ANY answer is
 * forbidden (DNS-rebinding safe).
 */
export async function resolveVerifiedAddresses(
  hostname: string,
  lookupImpl: LookupFn,
): Promise<string[]> {
  const bare = hostname.replace(/^\[|\]$/gu, '');
  if (isIP(bare) === 4 || isIP(bare) === 6) {
    if (classifyIpAddress(bare) === 'forbidden') throw forbidden(bare);
    return [bare];
  }
  let answers: string[];
  try {
    answers = await lookupImpl(bare);
  } catch (cause) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'DNS_FAILED', hostname: bare },
      cause,
    });
  }
  if (answers.length === 0) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'DNS_EMPTY', hostname: bare },
    });
  }
  for (const address of answers) {
    if (classifyIpAddress(address) === 'forbidden') throw forbidden(address, bare);
  }
  return answers;
}

const defaultLookup: LookupFn = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map((record) => record.address);

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** One policy-checked HTTP hop; returns the response plus a redirect target. */
function fetchOnce(
  url: URL,
  options: SafePluginFetchOptions,
  signal: AbortSignal,
): Promise<{ status: number; body: string; location: string | null }> {
  return new Promise((resolve, reject) => {
    void resolveVerifiedAddresses(url.hostname, options.lookupImpl ?? defaultLookup)
      .then((addresses) => {
        const address = addresses[0] ?? '';
        const isHttps = url.protocol === 'https:';
        const requestImpl = isHttps
          ? (options.httpsRequestImpl ?? httpsRequest)
          : (options.httpRequestImpl ?? httpRequest);
        const method = (options.method ?? 'GET').toUpperCase();
        const body = options.body;
        const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';

        const requestOptions: RequestOptions = {
          protocol: url.protocol,
          // Connection goes to the PRE-VERIFIED IP (ТЗ §SEC-03): the DNS
          // result cannot be re-resolved by the transport.
          hostname: address,
          port: url.port !== '' ? Number(url.port) : isHttps ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            // The original hostname is preserved only for Host (and TLS SNI
            // below) — never for the connection target.
            host: url.host,
            ...(hasBody ? { 'content-length': Buffer.byteLength(body ?? '') } : {}),
            ...options.headers,
          },
          lookup: (_hostname, _lookupOptions, callback) => callback(null, address, isIP(address)),
          ...(isHttps && isIP(url.hostname.replace(/^\[|\]$/gu, '')) === 0
            ? { servername: url.hostname.replace(/^\[|\]$/gu, '') }
            : {}),
        };

        const request = requestImpl(requestOptions, (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let tooLarge = false;
          response.on('data', (chunk: Buffer) => {
            if (tooLarge) return;
            received += chunk.length;
            if (received > options.maxBytes) {
              tooLarge = true;
              request.destroy(
                new AppError({
                  code: ErrorCodes.FILE_TOO_LARGE,
                  params: { limitBytes: options.maxBytes },
                }),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (tooLarge) return;
            const location = response.headers['location'];
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              location: typeof location === 'string' ? location : null,
            });
          });
          response.on('error', (error: Error) => reject(error));
        });

        // Defense in depth: the connected socket must be one of the verified
        // addresses; a forbidden remoteAddress destroys the request even if
        // the lookup was raced between resolution and connect.
        request.on('socket', (socket) => {
          socket.on('connect', () => {
            const remote = socket.remoteAddress;
            if (remote !== undefined && classifyIpAddress(remote) === 'forbidden') {
              request.destroy(forbidden(remote, url.hostname));
            }
          });
        });

        const finishWithError = (error: unknown): void => {
          if (signal.aborted) {
            reject(new AppError({ code: ErrorCodes.ABORTED }));
          } else if (error instanceof AppError) {
            reject(error);
          } else if (error instanceof Error && error.name === 'TimeoutError') {
            reject(
              new AppError({
                code: ErrorCodes.TIMEOUT,
                params: { reason: 'FETCH_TIMEOUT', hostname: url.hostname },
              }),
            );
          } else {
            reject(
              new AppError({
                code: ErrorCodes.BAD_REQUEST,
                params: { reason: 'FETCH_FAILED', hostname: url.hostname },
                cause: error,
              }),
            );
          }
        };
        request.on('error', finishWithError);
        signal.addEventListener(
          'abort',
          () => {
            request.destroy(new AppError({ code: ErrorCodes.ABORTED }));
          },
          { once: true },
        );

        if (hasBody) request.write(body);
        request.end();
      })
      .catch(reject);
  });
}

/**
 * SSRF-safe fetch with per-hop policy, verified-IP connection, post-connect
 * remoteAddress check, redirect re-policing (≤ 5) and bounded bodies.
 */
export async function safePluginFetch(
  url: URL,
  options: SafePluginFetchOptions,
): Promise<SafePluginFetchResult> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'URL_SCHEME_NOT_ALLOWED' },
    });
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let current = url;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchOnce(current, options, signal);
    if (!isRedirect(response.status)) {
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        body: response.body,
      };
    }
    if (hop >= MAX_REDIRECTS) {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'TOO_MANY_REDIRECTS' },
      });
    }
    if (response.location === null || response.location.length === 0) {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'REDIRECT_MISSING_LOCATION' },
      });
    }
    let next: URL;
    try {
      next = new URL(response.location, current);
    } catch {
      throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'URL_MALFORMED' } });
    }
    if (next.protocol !== 'https:' && next.protocol !== 'http:') {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'URL_SCHEME_NOT_ALLOWED' },
      });
    }
    // Every redirect hop re-runs the full policy inside fetchOnce.
    current = next;
  }
}
