/**
 * §29 keep-alive/pooling + proxy transport (Stage F part 15).
 *
 * The Main Host's network transport, owned by the reference host executor.
 * Direct requests run through bounded `http.Agent`/`https.Agent` pools with
 * keep-alive (idle sockets are reused per origin); when a proxy is configured
 * (executor-level, never plugin-controlled — a plugin-set proxy would be a
 * local pivoting hole), requests route through it: HTTP targets use the
 * absolute-form request line, HTTPS targets use a CONNECT tunnel with TLS
 * over the tunneled socket.
 *
 * The pool never follows redirects (the executor's §29.1.3 policy loop does).
 * Response bodies with a `content-encoding` of gzip/deflate/br are decoded
 * through a bounded streaming decoder: the compressed wire bytes AND the
 * decompressed result are both capped at the same budget, so a "zip bomb"
 * cannot bypass the in-flight byte limits by claiming an enormous expansion
 * (ТЗ §SEC-04). Both limits are enforced while streaming: a response body
 * over the cap destroys the connection immediately and returns the truncated
 * prefix (never accumulate a body that will be discarded).
 *
 * Verified connections (ТЗ §SEC-03): when the caller passes the policy-approved
 * address list, the pool connects straight to the approved IP (no DNS in the
 * stack), preserves the hostname only in `Host` / TLS `servername`, and after
 * connect verifies the socket's `remoteAddress` is in the approved set. Such
 * connections bypass the keep-alive agents on purpose — socket reuse across
 * different approved IPs would make the post-connect check unsound.
 */
import {
  Agent as HttpAgent,
  request as httpRequest,
  type Agent as HttpAgentLike,
  type IncomingMessage,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import type { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  NETWORK_MAX_BODY_BYTES,
  NETWORK_POOL_CONNECT_TIMEOUT_MS,
  NETWORK_POOL_KEEP_ALIVE_MS,
  NETWORK_POOL_MAX_FREE_SOCKETS,
  NETWORK_POOL_MAX_SOCKETS_PER_ORIGIN,
} from '@neotavern/contracts';
import { assertApprovedRemote, VerifiedIpMismatchError } from './netPolicy.js';

export interface NetworkPoolOptions {
  /** Max concurrent sockets per origin (direct connections). Default 6. */
  maxSocketsPerOrigin?: number;
  /** Max idle keep-alive sockets kept per origin. Default 4. */
  maxFreeSockets?: number;
  /** Idle keep-alive socket TTL. Default 60 s. */
  keepAliveMsecs?: number;
  /** Socket inactivity timeout per request. Default 10 s. */
  connectTimeoutMs?: number;
  /**
   * Per-response body budget (§SEC-04). Both the COMPRESSED wire bytes and
   * the DECOMPRESSED decoder output share this cap. Default
   * `NETWORK_MAX_BODY_BYTES`.
   */
  maxBodyBytes?: number;
  /** Executor-level HTTP(S) proxy URL (http:// or https://). Default none. */
  proxyUrl?: string;
}

export interface NetworkPoolMetrics {
  /** Live sockets (in use + idle) across the http/https agents. */
  openSockets: number;
  /** Idle keep-alive sockets currently pooled (reuse candidates). */
  freeSockets: number;
  /** Requests queued waiting for a socket. */
  pendingRequests: number;
  /** Fetches executed through the pool since creation. */
  totalRequests: number;
  /** Configured proxy URL or null for direct connections. */
  proxy: string | null;
}

export interface NetworkPool {
  /**
   * Fetch one URL. `verified` carries the policy-approved addresses for this
   * request (ТЗ §SEC-03): direct connects go to the approved IP (no DNS in
   * the stack), the hostname is kept only in Host/SNI, the connected
   * `remoteAddress` is verified against the set, and keep-alive reuse is
   * bypassed. Proxy hops honor the same set: the absolute-form URI (HTTP) and
   * the CONNECT authority (HTTPS) carry the verified IP, and the hostname
   * survives only in the Host header / TLS servername.
   */
  fetch(url: string, init?: RequestInit, verified?: { ips: string[] }): Promise<Response>;
  metrics(): NetworkPoolMetrics;
  /**
   * Destroy both agents and their idle sockets; future fetches reject.
   * Resolves after the agents' socket bookkeeping flushes (idle sockets are
   * gone from the metrics by the time the promise settles).
   */
  close(): Promise<void>;
}

function socketCount(map: object | undefined): number {
  if (map === undefined) return 0;
  let total = 0;
  if (map instanceof Map) {
    for (const sockets of map.values()) total += sockets.length;
  } else {
    for (const value of Object.values(map)) {
      if (Array.isArray(value)) total += value.length;
    }
  }
  return total;
}

function toPlainHeaders(headers: RequestInit['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers === undefined) return result;
  if (headers instanceof Headers) {
    for (const [name, value] of headers.entries()) result[name] = value;
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      if (typeof value === 'string') result[name] = value;
    }
    return result;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

function readResponse(res: IncomingMessage, maxBytes: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let settled = false;
    const buildResponse = (): void => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks, Math.min(total, maxBytes));
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, String(value));
        }
      }
      // The body below is DECODED (content-encoding consumed by the streaming
      // decoder); leaving the encoding header would make the caller decode a
      // second time. content-length also no longer matches the body.
      headers.delete('content-encoding');
      headers.delete('content-length');
      resolve(
        new Response(body, {
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers,
        }),
      );
    };
    // Bound the DECOMPRESSED bytes too (§SEC-04): a tiny compressed body may
    // expand enormously, so the decoder output is capped at the same budget.
    const pushOutput = (chunk: Buffer): boolean => {
      const room = maxBytes - total;
      if (chunk.length > room) {
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          total = maxBytes;
        }
        truncated = true;
        return false;
      }
      chunks.push(chunk);
      total += chunk.length;
      return true;
    };
    const fail = (error: Error): void => {
      // After an intentional cap-destroy the truncated prefix is the answer;
      // any other error fails the fetch.
      if (truncated) buildResponse();
      else reject(error);
    };
    const encoding = (res.headers['content-encoding'] ?? '').toLowerCase();
    if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') {
      const decoder: Transform =
        encoding === 'gzip'
          ? createGunzip()
          : encoding === 'deflate'
            ? createInflate()
            : createBrotliDecompress();
      // §SEC-04: BOTH sides of the budget are accounted while streaming — the
      // COMPRESSED wire bytes read from the response and the DECOMPRESSED
      // decoder output each share the same cap. A response whose compressed
      // form alone exceeds the budget (e.g. a flood of concatenated members)
      // is destroyed immediately, and a zip bomb cannot expand past the cap.
      let compressedBytes = 0;
      const destroyAll = (): void => {
        truncated = true;
        res.destroy();
        decoder.destroy();
      };
      decoder.on('data', (chunk: Buffer) => {
        if (!pushOutput(chunk)) {
          // Cap exceeded on the DECODED stream: destroy the response
          // immediately instead of expanding the whole payload.
          destroyAll();
        }
      });
      decoder.on('error', fail);
      decoder.on('end', buildResponse);
      decoder.on('close', () => {
        if (truncated) buildResponse();
      });
      decoder.on('drain', () => {
        // Backpressure: `decoder.write()` below returned false, so the
        // response was paused; resume it once the decoder's queue drains.
        res.resume();
      });
      res.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = maxBytes - compressedBytes;
        if (chunk.length > room) {
          // The compressed wire bytes alone exceed the cap — destroy now,
          // never accumulate a body that will be discarded.
          destroyAll();
          return;
        }
        compressedBytes += chunk.length;
        if (!decoder.write(chunk)) {
          // The decoder's internal queue is full — pause the response until
          // it drains instead of letting the queue grow without bound.
          res.pause();
        }
      });
      res.on('end', () => decoder.end());
      res.on('error', (error) => decoder.destroy(error));
      // The decoder's own end/close/error handlers settle the promise; the
      // truncation path destroys res + decoder explicitly above, so no extra
      // 'close' wiring is needed here (a res 'close' racing the decoder's
      // async flush must NOT destroy the decoder prematurely).
      return;
    }
    res.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - total;
      if (chunk.length > room) {
        // §SEC-04: bound the compressed bytes before the body is accumulated;
        // destroy the response immediately once the cap is exceeded instead
        // of downloading a body that will be discarded.
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          total = maxBytes;
        }
        truncated = true;
        res.destroy();
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    res.on('error', fail);
    res.on('end', buildResponse);
    // 'close' fires without 'end' after `res.destroy()` (cap exceeded).
    res.on('close', buildResponse);
  });
}

/**
 * §SEC-03 absolute-form URI for a proxy hop: the authority host is replaced
 * with the policy-approved IP so the proxy resolves no DNS for the hostname,
 * while everything else (scheme, path, query, explicit port) is preserved.
 * The Host header stays the hostname (set by the caller) for the target.
 */
function absoluteFormWithVerifiedIp(target: URL, ip: string): string {
  const withIp = new URL(target.toString());
  withIp.hostname = ip;
  return withIp.toString();
}

/**
 * RFC 7231 §4.3.6: a CONNECT authority host that is an IPv6 literal must be
 * bracketed (`[2001:db8::1]:443`). Hostnames and IPv4 are returned unchanged.
 */
function formatConnectAuthorityHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function createNetworkPool(options: NetworkPoolOptions = {}): NetworkPool {
  const proxyUrl = options.proxyUrl === undefined ? null : new URL(options.proxyUrl);
  if (proxyUrl !== null && proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    throw new Error('proxy URL must use http: or https:');
  }
  const maxSocketsPerOrigin = options.maxSocketsPerOrigin ?? NETWORK_POOL_MAX_SOCKETS_PER_ORIGIN;
  const maxFreeSockets = options.maxFreeSockets ?? NETWORK_POOL_MAX_FREE_SOCKETS;
  const keepAliveMsecs = options.keepAliveMsecs ?? NETWORK_POOL_KEEP_ALIVE_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? NETWORK_POOL_CONNECT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? NETWORK_MAX_BODY_BYTES;

  const httpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: maxSocketsPerOrigin,
    maxFreeSockets,
    keepAliveMsecs,
  });
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: maxSocketsPerOrigin,
    maxFreeSockets,
    keepAliveMsecs,
  });

  let closed = false;
  let totalRequests = 0;

  function directFetch(
    target: URL,
    init: RequestInit,
    verified?: { ips: string[] },
  ): Promise<Response> {
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? httpsRequest : httpRequest;
    const agent: HttpAgentLike = isHttps ? httpsAgent : httpAgent;
    const common = {
      port: target.port === '' ? (isHttps ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: init.method ?? 'GET',
      signal: init.signal ?? undefined,
    };
    return new Promise((resolve, reject) => {
      const requestInit =
        verified === undefined
          ? { ...common, hostname: target.hostname, agent }
          : {
              ...common,
              // §SEC-03: connect to the policy-approved IP — the Node stack
              // performs no DNS for the hostname. The hostname survives only
              // in the Host header (HTTP) and servername (TLS/SNI + cert
              // verification).
              hostname: verified.ips[0] ?? target.hostname,
              headers: { ...toPlainHeaders(init.headers), host: target.host },
              ...(isHttps ? { servername: target.hostname } : {}),
            };
      const req = lib(requestInit, (res) => resolve(readResponse(res, maxBodyBytes)));
      if (verified !== undefined) {
        // §SEC-03: after connect, the address the connection actually landed
        // on must be in the approved set (DNS rebinding or agent reuse cannot
        // silently change the peer).
        req.on('socket', (socket) => {
          socket.once('connect', () => {
            const remote = (socket as Socket).remoteAddress;
            const mismatch = assertApprovedRemote(verified.ips, remote);
            if (mismatch !== null) req.destroy(new VerifiedIpMismatchError(remote, mismatch));
          });
        });
      }
      req.on('error', reject);
      req.setTimeout(connectTimeoutMs, () => req.destroy(new Error('connect timeout')));
      if (init.body !== undefined && init.body !== null) req.write(String(init.body));
      req.end();
    });
  }

  /** HTTP target through the proxy: absolute-form request line. */
  function proxyAbsoluteForm(
    target: URL,
    init: RequestInit,
    verified?: { ips: string[] },
  ): Promise<Response> {
    if (proxyUrl === null) throw new Error('proxy path used without a proxy URL');
    const proxy = proxyUrl;
    const proxyIsTls = proxy.protocol === 'https:';
    const proxyPort =
      proxy.port !== '' && proxy.port !== undefined ? Number(proxy.port) : proxyIsTls ? 443 : 80;
    return new Promise((resolve, reject) => {
      // §SEC-03: when the policy approved specific addresses, the absolute-form
      // URI carries the verified IP (the proxy resolves no DNS for the
      // hostname) while the Host header keeps the hostname for the target.
      const targetUri =
        verified === undefined
          ? target.toString()
          : absoluteFormWithVerifiedIp(target, verified.ips[0] ?? target.hostname);
      // An https:// proxy requires a TLS hop even when the TARGET is plaintext
      // http — an https-proxy must never receive the absolute-form request in
      // plaintext on its TLS port (SEC-03 proxy-path review fix).
      const tlsSocket = proxyIsTls
        ? tlsConnect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
        : undefined;
      const req = httpRequest(
        {
          host: proxy.hostname,
          port: proxyPort,
          method: init.method ?? 'GET',
          path: targetUri,
          headers: { ...toPlainHeaders(init.headers), host: target.host },
          signal: init.signal ?? undefined,
          ...(tlsSocket !== undefined ? { createConnection: () => tlsSocket } : {}),
        },
        (res) => resolve(readResponse(res, maxBodyBytes)),
      );
      req.on('error', reject);
      req.setTimeout(connectTimeoutMs, () => req.destroy(new Error('proxy connect timeout')));
      if (init.body !== undefined && init.body !== null) req.write(String(init.body));
      req.end();
    });
  }

  /** HTTPS target through the proxy: CONNECT tunnel, then TLS over it. */
  function proxyConnectTunnel(
    target: URL,
    init: RequestInit,
    verified?: { ips: string[] },
  ): Promise<Response> {
    if (proxyUrl === null) throw new Error('proxy path used without a proxy URL');
    const proxy = proxyUrl;
    const proxyPort = proxy.port !== '' && proxy.port !== undefined ? Number(proxy.port) : 80;
    return new Promise((resolve, reject) => {
      // CONNECT requires an authority with an explicit port (RFC 7231 §4.3.6),
      // and IPv6 literals must be bracketed: `[2001:db8::1]:443`, never
      // `2001:db8::1:443` (SEC-03 proxy-path review fix).
      // §SEC-03: the CONNECT authority carries the verified IP — the proxy
      // connects to the policy-approved address, and TLS still validates the
      // certificate against the hostname (servername), never the IP.
      const connectHost = verified?.ips[0] ?? target.hostname;
      const authority = `${formatConnectAuthorityHost(connectHost)}:${target.port === '' ? '443' : target.port}`;
      const connectReq = httpRequest(
        {
          host: proxy.hostname,
          port: proxyPort,
          method: 'CONNECT',
          path: authority,
          headers: { host: authority },
        },
        (res) => {
          // CONNECT responses arrive on the 'connect' event, not here.
          res.resume();
        },
      );
      // Tunnel sockets are not pooled — every exit path must destroy them or
      // the proxy connection lingers (tests catch this as a leaked socket).
      let tunnelSocket: Socket | null = null;
      let tlsSocket: TLSSocket | null = null;
      const fail = (error: unknown): void => {
        tlsSocket?.destroy();
        tunnelSocket?.destroy();
        reject(error);
      };
      connectReq.on('connect', (res, socket) => {
        tunnelSocket = socket;
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`proxy CONNECT failed: ${res.statusCode ?? 'unknown'}`));
          return;
        }
        const tls = tlsConnect({
          socket,
          servername: target.hostname,
        });
        tlsSocket = tls;
        tls.on('error', fail);
        const req = httpsRequest(
          {
            method: init.method ?? 'GET',
            path: `${target.pathname}${target.search}`,
            // The tunneled request must carry the TARGET's host, never the
            // stack default `localhost` (the pool connects via createConnection
            // and would otherwise send Host: localhost — SEC-03 proxy-path
            // review fix, same rule as the absolute-form path above).
            headers: { ...toPlainHeaders(init.headers), host: target.host },
            signal: init.signal ?? undefined,
            createConnection: () => tls,
          },
          (res2) => {
            readResponse(res2, maxBodyBytes).then((result) => {
              tls.destroy();
              socket.destroy();
              resolve(result);
            }, fail);
          },
        );
        req.on('error', fail);
        req.setTimeout(connectTimeoutMs, () => req.destroy(new Error('proxy tunnel timeout')));
        if (init.body !== undefined && init.body !== null) req.write(String(init.body));
        req.end();
      });
      connectReq.on('error', fail);
      connectReq.end();
    });
  }

  return {
    fetch(url, init, verified) {
      if (closed) return Promise.reject(new Error('network pool is closed'));
      totalRequests += 1;
      const target = new URL(url);
      const requestInit: RequestInit = init ?? {};
      if (proxyUrl !== null) {
        return target.protocol === 'https:'
          ? proxyConnectTunnel(target, requestInit, verified)
          : proxyAbsoluteForm(target, requestInit, verified);
      }
      return directFetch(target, requestInit, verified);
    },
    metrics() {
      const http = {
        open: socketCount(httpAgent.sockets),
        free: socketCount(httpAgent.freeSockets),
        pending: socketCount(httpAgent.requests),
      };
      const https = {
        open: socketCount(httpsAgent.sockets),
        free: socketCount(httpsAgent.freeSockets),
        pending: socketCount(httpsAgent.requests),
      };
      return {
        openSockets: http.open + https.open,
        freeSockets: http.free + https.free,
        pendingRequests: http.pending + https.pending,
        totalRequests,
        proxy: proxyUrl?.toString() ?? null,
      };
    },
    async close() {
      closed = true;
      httpAgent.destroy();
      httpsAgent.destroy();
      // The agents destroy their sockets but the map bookkeeping settles a
      // few ticks later; poll (bounded) until `metrics()` reports them gone.
      const deadline = Date.now() + 2_000;
      const remaining = (): number => {
        const http = {
          open: socketCount(httpAgent.sockets),
          free: socketCount(httpAgent.freeSockets),
        };
        const https = {
          open: socketCount(httpsAgent.sockets),
          free: socketCount(httpsAgent.freeSockets),
        };
        return http.open + http.free + https.open + https.free;
      };
      while (remaining() > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  };
}
