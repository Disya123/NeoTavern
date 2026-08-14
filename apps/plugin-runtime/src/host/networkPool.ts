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
 * The pool never follows redirects (the executor's §29.1.3 policy loop does)
 * and never decodes bodies (it returns a buffered `Response`; producer-side
 * streaming of bodies is a documented follow-up). Both limits are enforced
 * while streaming: a response body over the cap destroys the connection
 * immediately and returns the truncated prefix (ТЗ §SEC-04 — never accumulate
 * a body that will be discarded).
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
   * request (ТЗ §SEC-03): when present, the pool connects to the approved IP
   * (no DNS in the stack), keeps the hostname only in Host/SNI, verifies the
   * connected `remoteAddress` against the set, and bypasses keep-alive reuse.
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
      resolve(
        new Response(body, {
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers,
        }),
      );
    };
    res.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - total;
      if (chunk.length > room) {
        // §SEC-04: bound compressed AND decompressed bytes before the body is
        // accumulated; destroy the response immediately once the cap is
        // exceeded instead of downloading a body that will be discarded.
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
    res.on('error', (error) => {
      // After an intentional cap-destroy the truncated prefix is the answer;
      // any other error fails the fetch.
      if (truncated) buildResponse();
      else reject(error);
    });
    res.on('end', buildResponse);
    // 'close' fires without 'end' after `res.destroy()` (cap exceeded).
    res.on('close', buildResponse);
  });
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
      const req = lib(requestInit, (res) => resolve(readResponse(res, NETWORK_MAX_BODY_BYTES)));
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
  function proxyAbsoluteForm(target: URL, init: RequestInit): Promise<Response> {
    const proxyPort =
      proxyUrl?.port !== '' && proxyUrl?.port !== undefined ? Number(proxyUrl.port) : 80;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: proxyUrl?.hostname,
          port: proxyPort,
          method: init.method ?? 'GET',
          path: target.toString(),
          headers: { ...toPlainHeaders(init.headers), host: target.host },
          signal: init.signal ?? undefined,
        },
        (res) => resolve(readResponse(res, NETWORK_MAX_BODY_BYTES)),
      );
      req.on('error', reject);
      req.setTimeout(connectTimeoutMs, () => req.destroy(new Error('proxy connect timeout')));
      if (init.body !== undefined && init.body !== null) req.write(String(init.body));
      req.end();
    });
  }

  /** HTTPS target through the proxy: CONNECT tunnel, then TLS over it. */
  function proxyConnectTunnel(target: URL, init: RequestInit): Promise<Response> {
    const proxyPort =
      proxyUrl?.port !== '' && proxyUrl?.port !== undefined ? Number(proxyUrl.port) : 80;
    return new Promise((resolve, reject) => {
      // CONNECT requires an authority with an explicit port (RFC 7231 §4.3.6).
      const authority = `${target.hostname}:${target.port === '' ? '443' : target.port}`;
      const connectReq = httpRequest(
        {
          host: proxyUrl?.hostname,
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
            headers: toPlainHeaders(init.headers),
            signal: init.signal ?? undefined,
            createConnection: () => tls,
          },
          (res2) => {
            readResponse(res2, NETWORK_MAX_BODY_BYTES).then((result) => {
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
          ? proxyConnectTunnel(target, requestInit)
          : proxyAbsoluteForm(target, requestInit);
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
