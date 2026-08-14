/**
 * Host-side socket handles (ТЗ v3.2 §29 Stage E: websocket / tcp / listen /
 * udp). The plugin never touches raw Node sockets: every operation goes
 * through the Capability Broker, and this module keeps the trusted sockets
 * on the host side of the boundary.
 *
 * Design:
 * - Handles are opaque ids bound to the owning plugin; the plugin talks to
 *   them through `network.*` broker methods only.
 * - Every receive stream is a bounded message ring (§17): fixed message
 *   count + byte budget per handle; excess drops the oldest message. No
 *   unbounded host-side queue can grow behind a slow plugin.
 * - All outbound destinations pass the same §29.1 SSRF scope policy as
 *   `network.http.fetch` (injected `checkDestination`); `network.listen`
 *   binds loopback by default (§29.1.4) and a non-loopback bind host is
 *   rejected by the injected `bindPolicy` unless the plugin holds
 *   `network.listen.public`.
 * - Handles are closed on revoke of the owning network capability and on
 *   executor shutdown.
 */
import { connect as netConnect, createServer, Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';
import { createSocket, Socket as DgramSocket } from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import {
  NETWORK_MAX_BODY_BYTES,
  NETWORK_MAX_SOCKET_BUFFER_BYTES,
  NETWORK_MAX_SOCKET_HANDLES,
  NETWORK_MAX_SOCKET_MESSAGES,
} from '@neotavern/contracts';
import { BrokerCallError } from '../broker/capabilityBroker.js';
import { assertApprovedRemote } from './netPolicy.js';

export interface SocketRegistryDeps {
  /**
   * §29.1 SSRF scope policy for outbound destinations. Throws on deny and
   * returns the policy-approved address list, so a caller can verify the
   * address a connection actually landed on (ТЗ §SEC-03: "после connect
   * проверяется remoteAddress").
   */
  checkDestination(host: string, pluginId: string): Promise<string[]>;
  /** §29.1.4 bind policy: throws unless the plugin may bind the host. */
  checkBind(host: string, pluginId: string): void;
}

interface RingHandle {
  id: string;
  pluginId: string;
  kind: 'websocket' | 'tcp' | 'udp';
  messages: string[];
  /** Total buffered message bytes (byte budget eviction, §17). */
  bufferedBytes: number;
  /** Remote endpoint hosts for udp receives (parallel to `messages`). */
  remoteHosts: string[];
  remotePorts: number[];
  closed: boolean;
  waiters: Array<() => void>;
  /** Per-kind runtime resource (socket / server / dgram handle). */
  resource: unknown;
}

/** Bounded string ring with a byte budget (evict-oldest, §17). */
function pushRing(
  handle: RingHandle,
  data: string,
  remoteHost?: string,
  remotePort?: number,
): void {
  const bytes = Buffer.byteLength(data, 'utf8');
  handle.messages.push(data);
  handle.bufferedBytes += bytes;
  if (remoteHost !== undefined) handle.remoteHosts.push(remoteHost);
  if (remotePort !== undefined) handle.remotePorts.push(remotePort);
  while (
    handle.messages.length > NETWORK_MAX_SOCKET_MESSAGES ||
    handle.bufferedBytes > NETWORK_MAX_SOCKET_BUFFER_BYTES
  ) {
    const dropped = handle.messages.shift();
    if (dropped !== undefined) handle.bufferedBytes -= Buffer.byteLength(dropped, 'utf8');
    handle.remoteHosts.shift();
    handle.remotePorts.shift();
  }
  const waiter = handle.waiters.shift();
  waiter?.();
}

function drainRing(
  handle: RingHandle,
  limit: number,
): {
  messages: string[];
  remoteHosts: string[];
  remotePorts: number[];
} {
  const take = Math.min(limit, handle.messages.length);
  const messages = handle.messages.splice(0, take);
  const remoteHosts = handle.remoteHosts.splice(0, take);
  const remotePorts = handle.remotePorts.splice(0, take);
  for (const message of messages) {
    handle.bufferedBytes -= Buffer.byteLength(message, 'utf8');
  }
  return { messages, remoteHosts, remotePorts };
}

function closeResource(resource: unknown): void {
  if (resource instanceof Socket || resource instanceof TLSSocket) {
    resource.destroy();
  } else if (resource instanceof DgramSocket) {
    resource.close();
  } else if (
    resource !== null &&
    typeof resource === 'object' &&
    typeof (resource as { close?: unknown }).close === 'function'
  ) {
    // net.Server: stop accepting and destroy accepted connections.
    (resource as { close(): void }).close();
  }
}

/**
 * §SEC-03 WebSocket handshake + RFC 6455 framing implemented over the raw
 * socket. undici's WebSocket does not expose the connected socket, so a
 * post-connect `remoteAddress` verification was impossible; this client owns
 * the socket end to end: it connects to the policy-approved IP (hostname only
 * in Host/SNI), verifies `remoteAddress` after connect, then performs the
 * HTTP Upgrade handshake itself. The plugin still only sees opaque handle ids.
 */

/** RFC 6455 §1.3 fixed GUID used to compute Sec-WebSocket-Accept. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Server-side Sec-WebSocket-Accept for a client's Sec-WebSocket-Key. */
export function wsAcceptHeader(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/**
 * Build one client→server frame (RFC 6455 §5): FIN set, text opcode 0x1 by
 * default, payload masked with a fresh 4-byte key (clients MUST mask).
 */
export function wsClientFrame(payload: string | Buffer, opcode = 0x1): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.byteLength;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = (data[i] ?? 0) ^ (mask[i & 3] ?? 0);
  return Buffer.concat([header, mask, masked]);
}

/** A parsed server→client frame (RFC 6455 §5.2; servers do NOT mask). */
export interface WsServerFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/**
 * SEC-04 bound for a single WebSocket frame payload (and for the accumulated
 * fragmented text between FINs). A server-declared length above this bound is
 * a protocol violation: the frame is refused before it can accumulate in
 * memory — the client never buffers a huge declared frame to full length.
 */
export const WS_MAX_FRAME_BYTES = NETWORK_MAX_BODY_BYTES;

export type WsParseResult = { frame: WsServerFrame; rest: Buffer } | { tooLarge: true } | null;

/**
 * Parse one complete frame off the front of `buffer`, returning the frame and
 * the remainder, or null when the buffer holds only a partial frame (caller
 * keeps accumulating). Server frames must not be masked; a masked frame is a
 * protocol violation and returns null after consuming nothing. When the
 * declared payload length exceeds `maxPayload` the result is `{ tooLarge:
 * true }` (the caller must fail the connection, never keep buffering).
 */
export function wsParseFrame(buffer: Buffer, maxPayload?: number): WsParseResult {
  if (buffer.byteLength < 2) return null;
  const first = buffer[0];
  if (first === undefined) return null;
  const b0 = first;
  const second = buffer[1];
  if (second === undefined) return null;
  const b1 = second;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.byteLength < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.byteLength < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    len = Number(big);
    offset = 10;
  }
  if (masked) return null; // server frames are unmasked (RFC 6455 §5.1)
  if (maxPayload !== undefined && len > maxPayload) return { tooLarge: true };
  if (buffer.byteLength < offset + len) return null;
  return {
    frame: { fin, opcode, payload: buffer.subarray(offset, offset + len) },
    rest: buffer.subarray(offset + len),
  };
}

export interface SocketRegistry {
  websocketOpen(pluginId: string, url: string, protocols: string[] | undefined): Promise<string>;
  websocketSend(pluginId: string, id: string, data: string): Promise<void>;
  websocketReceive(
    pluginId: string,
    id: string,
    limit: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ messages: string[]; closed: boolean }>;
  websocketClose(pluginId: string, id: string): Promise<void>;
  tcpConnect(pluginId: string, host: string, port: number, tls: boolean): Promise<string>;
  tcpSend(pluginId: string, id: string, data: string): Promise<void>;
  tcpReceive(
    pluginId: string,
    id: string,
    limit: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ messages: string[]; closed: boolean }>;
  tcpClose(pluginId: string, id: string): Promise<void>;
  listenOpen(
    pluginId: string,
    host: string | undefined,
    port: number,
  ): Promise<{ id: string; port: number }>;
  listenAccept(
    pluginId: string,
    id: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<string | null>;
  listenClose(pluginId: string, id: string): Promise<void>;
  udpOpen(
    pluginId: string,
    bindHost: string | undefined,
    bindPort: number,
  ): Promise<{ id: string; port: number }>;
  udpSend(pluginId: string, id: string, data: string, host: string, port: number): Promise<void>;
  udpReceive(
    pluginId: string,
    id: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ data: string | null; host: string | null; port: number | null }>;
  udpClose(pluginId: string, id: string): Promise<void>;
  /** Close every handle owned by one plugin (revoke, §10.2). */
  closePlugin(pluginId: string): Promise<void>;
  /** Close every handle (executor shutdown). */
  closeAll(): Promise<void>;
  /** Live handle count (diagnostics). */
  size(): number;
}

export function createSocketRegistry(deps: SocketRegistryDeps): SocketRegistry {
  const handles = new Map<string, RingHandle>();
  /** listener id → pending accepted connections (accept queue). */
  const pendingConnections = new Map<string, RingHandle[]>();
  let nextId = 0;

  function allocate(pluginId: string, kind: RingHandle['kind']): RingHandle {
    const owned = [...handles.values()].filter((handle) => handle.pluginId === pluginId).length;
    if (owned >= NETWORK_MAX_SOCKET_HANDLES) {
      throw new BrokerCallError('SERVICE_UNAVAILABLE', {
        message: 'too many live socket handles',
        details: { pluginId, limit: NETWORK_MAX_SOCKET_HANDLES },
      });
    }
    const id = `sock-${pluginId.slice(0, 24)}-${++nextId}-${randomBytes(3).toString('hex')}`;
    const handle: RingHandle = {
      id,
      pluginId,
      kind,
      messages: [],
      bufferedBytes: 0,
      remoteHosts: [],
      remotePorts: [],
      closed: false,
      waiters: [],
      resource: undefined,
    };
    handles.set(id, handle);
    return handle;
  }

  function requireHandle(pluginId: string, id: string): RingHandle {
    const handle = handles.get(id);
    if (handle === undefined || handle.pluginId !== pluginId) {
      throw new BrokerCallError('NOT_FOUND', {
        message: 'unknown socket handle',
        details: { id },
      });
    }
    return handle;
  }

  async function closeHandle(id: string): Promise<void> {
    const handle = handles.get(id);
    if (handle === undefined) return;
    handles.delete(id);
    handle.closed = true;
    const waiter = handle.waiters.shift();
    waiter?.();
    // A listener owns its accepted connections: close them too (§10.2).
    const pending = pendingConnections.get(id);
    if (pending !== undefined) {
      pendingConnections.delete(id);
      for (const conn of pending) {
        void closeHandle(conn.id);
      }
    }
    closeResource(handle.resource);
  }

  /** Wait for data/closure or deadline; resolves true when data arrived. */
  function waitFor(handle: RingHandle, waitMs: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (handle.messages.length > 0 || handle.closed) {
        resolve(true);
        return;
      }
      const wake = (): void => {
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(wake, Math.max(0, waitMs));
      const onAbort = (): void => {
        cleanup();
        resolve(false);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const index = handle.waiters.indexOf(wake);
        if (index >= 0) handle.waiters.splice(index, 1);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      handle.waiters.push(wake);
    });
  }

  return {
    async websocketOpen(pluginId, url, protocols) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new BrokerCallError('VALIDATION_FAILED', { message: 'invalid websocket url' });
      }
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        throw new BrokerCallError('VALIDATION_FAILED', { message: 'websocket url must be ws/wss' });
      }
      // §SEC-03: the approved set is the same resolution the policy check
      // admitted; the client connects to a policy-approved IP (no DNS for the
      // hostname in the stack), keeps the hostname only in Host/SNI, and
      // verifies the connected remoteAddress BEFORE the HTTP Upgrade.
      const approved = await deps.checkDestination(parsed.hostname, pluginId);
      const isTls = parsed.protocol === 'wss:';
      const connectHost = approved[0] ?? parsed.hostname;
      const port = parsed.port === '' ? (isTls ? 443 : 80) : Number(parsed.port);
      const handle = allocate(pluginId, 'websocket');
      const socket: Socket = isTls
        ? tlsConnect({ host: connectHost, port, servername: parsed.hostname })
        : netConnect({ host: connectHost, port });
      handle.resource = socket;
      socket.setNoDelay(true);
      // Post-connect verification (§SEC-03) before the handshake bytes leave.
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          cleanup();
          const mismatch = assertApprovedRemote(approved, socket.remoteAddress);
          if (mismatch !== null) {
            socket.destroy();
            void closeHandle(handle.id);
            reject(
              new BrokerCallError('NETWORK_DESTINATION_DENIED', {
                message: 'connected address not in the approved set',
                details: { host: parsed.hostname, remoteAddress: socket.remoteAddress },
              }),
            );
            return;
          }
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          socket.destroy();
          void closeHandle(handle.id);
          reject(
            new BrokerCallError('NETWORK_DESTINATION_DENIED', {
              message: 'websocket connect failed',
              details: { host: parsed.hostname, port, cause: error.message },
            }),
          );
        };
        const cleanup = (): void => {
          socket.removeListener('connect', onConnect);
          socket.removeListener('error', onError);
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
      });
      // HTTP Upgrade (RFC 6455 §4): Sec-WebSocket-Key -> Accept must match.
      const key = randomBytes(16).toString('base64');
      const path = `${parsed.pathname === '' ? '/' : parsed.pathname}${parsed.search}`;
      const protocolHeader =
        protocols !== undefined && protocols.length > 0
          ? `Sec-WebSocket-Protocol: ${protocols.join(', ')}\r\n`
          : '';
      const upgrade =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${parsed.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        protocolHeader +
        '\r\n';
      const expectedAccept = wsAcceptHeader(key);
      let upgradeRemainder = Buffer.alloc(0);
      await new Promise<void>((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
          buffer = Buffer.concat([buffer, chunk]);
          const headEnd = buffer.indexOf('\r\n\r\n');
          if (headEnd === -1) return; // response head still incomplete
          cleanup();
          upgradeRemainder = buffer.subarray(headEnd + 4);
          const head = buffer.subarray(0, headEnd).toString('utf8');
          const statusLine = head.split('\r\n')[0] ?? '';
          const headers = new Map(
            head
              .split('\r\n')
              .slice(1)
              .map((line) => {
                const idx = line.indexOf(':');
                return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];
              }),
          );
          socket.removeListener('data', onData);
          if (!statusLine.includes(' 101 ') || headers.get('upgrade') !== 'websocket') {
            socket.destroy();
            void closeHandle(handle.id);
            reject(
              new BrokerCallError('NETWORK_DESTINATION_DENIED', {
                message: 'websocket upgrade rejected',
                details: { status: statusLine },
              }),
            );
            return;
          }
          const accept = headers.get('sec-websocket-accept');
          if (accept !== expectedAccept) {
            socket.destroy();
            void closeHandle(handle.id);
            reject(
              new BrokerCallError('NETWORK_DESTINATION_DENIED', {
                message: 'websocket accept mismatch',
              }),
            );
            return;
          }
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          socket.destroy();
          void closeHandle(handle.id);
          reject(
            new BrokerCallError('NETWORK_DESTINATION_DENIED', {
              message: 'websocket upgrade failed',
              details: { cause: error.message },
            }),
          );
        };
        const cleanup = (): void => {
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
        };
        socket.on('data', onData);
        socket.once('error', onError);
        socket.write(upgrade);
      });
      // RFC 6455 §5 frame loop: text frames land in the ring, ping is
      // answered with pong, close tears the handle down. Bytes that arrived
      // in the same segment as the handshake head are drained first. SEC-04:
      // a frame whose declared length exceeds WS_MAX_FRAME_BYTES is refused
      // before it can accumulate — the client never buffers a huge declared
      // frame to full length, and fragmented text is bounded too.
      let frameBuffer: Buffer = Buffer.alloc(0);
      let textFragment = '';
      const failConnection = (): void => {
        socket.destroy();
        void closeHandle(handle.id);
      };
      const consumeFrames = (chunk: Buffer): void => {
        if (frameBuffer.byteLength + chunk.byteLength > WS_MAX_FRAME_BYTES) {
          failConnection();
          return;
        }
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
        for (;;) {
          const parsedFrame = wsParseFrame(frameBuffer, WS_MAX_FRAME_BYTES);
          if (parsedFrame === null) break;
          if ('tooLarge' in parsedFrame) {
            // Declared length above the bound: refuse the connection rather
            // than buffer the frame to its full declared size.
            failConnection();
            return;
          }
          frameBuffer = parsedFrame.rest;
          const { fin, opcode, payload } = parsedFrame.frame;
          if (opcode === 0x1) {
            // Text frame (possibly fragmented: FIN=0 then continuation 0x0).
            const nextFragment = fin
              ? payload.toString('utf8')
              : textFragment + payload.toString('utf8');
            if (nextFragment.length > WS_MAX_FRAME_BYTES) {
              failConnection();
              return;
            }
            textFragment = nextFragment;
            if (fin) {
              pushRing(handle, textFragment);
              textFragment = '';
            }
          } else if (opcode === 0x0) {
            const nextFragment = textFragment + payload.toString('utf8');
            if (nextFragment.length > WS_MAX_FRAME_BYTES) {
              failConnection();
              return;
            }
            textFragment = nextFragment;
            if (fin) {
              pushRing(handle, textFragment);
              textFragment = '';
            }
          } else if (opcode === 0x9) {
            // Ping: echo the payload back as a pong.
            if (!socket.destroyed) socket.write(wsClientFrame(payload, 0xa));
          } else if (opcode === 0x8) {
            // Close: mirror close, then release the handle.
            if (!socket.destroyed) socket.write(wsClientFrame(Buffer.from([0x03, 0xe8]), 0x8));
            socket.destroy();
            void closeHandle(handle.id);
            return;
          }
          // 0x2 (binary) and 0xa (pong) are intentionally ignored (v1 scope).
        }
      };
      // The handshake reader already removed itself; drain any frame bytes
      // that arrived with it, then stream the rest.
      const firstBytes = upgradeRemainder;
      upgradeRemainder = Buffer.alloc(0);
      if (firstBytes.byteLength > 0) consumeFrames(firstBytes);
      socket.on('data', consumeFrames);
      socket.on('close', () => {
        if (!handle.closed) void closeHandle(handle.id);
      });
      socket.on('error', () => {
        if (!handle.closed) void closeHandle(handle.id);
      });
      return handle.id;
    },
    async websocketSend(pluginId, id, data) {
      const handle = requireHandle(pluginId, id);
      const socket = handle.resource;
      if (!(socket instanceof Socket) || socket.destroyed || handle.closed) {
        throw new BrokerCallError('STREAM_ABORTED', { message: 'websocket not open' });
      }
      socket.write(wsClientFrame(data));
    },
    async websocketReceive(pluginId, id, limit, waitMs, signal) {
      const handle = requireHandle(pluginId, id);
      await waitFor(handle, waitMs, signal);
      const { messages } = drainRing(handle, limit);
      return { messages, closed: handle.closed };
    },
    async websocketClose(pluginId, id) {
      const handle = requireHandle(pluginId, id);
      const socket = handle.resource;
      if (socket instanceof Socket && !socket.destroyed) {
        socket.write(wsClientFrame(Buffer.from([0x03, 0xe8]), 0x8));
      }
      await closeHandle(id);
    },
    async tcpConnect(pluginId, host, port, tls) {
      // The approved set is the same resolution the policy check admitted;
      // after connect the socket's remoteAddress must be in it (ТЗ §SEC-03).
      const approved = await deps.checkDestination(host, pluginId);
      const handle = allocate(pluginId, 'tcp');
      // §SEC-03: connect to a policy-approved IP — the Node stack performs no
      // DNS for the hostname (every answer was already classified + checked
      // by the policy). The hostname survives only in TLS servername/SNI.
      const connectHost = approved[0] ?? host;
      const socket = tls
        ? tlsConnect({ host: connectHost, port, servername: host })
        : netConnect({ host: connectHost, port });
      handle.resource = socket;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => {
        pushRing(handle, chunk.toString('utf8'));
      });
      socket.on('close', () => {
        if (!handle.closed) void closeHandle(handle.id);
      });
      socket.on('error', () => {
        if (!handle.closed) void closeHandle(handle.id);
      });
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          const mismatch = assertApprovedRemote(approved, socket.remoteAddress);
          if (mismatch !== null) {
            cleanup();
            socket.destroy();
            void closeHandle(handle.id);
            reject(
              new BrokerCallError('NETWORK_DESTINATION_DENIED', {
                message: 'connected address not in the approved set',
                details: { host, port, remoteAddress: socket.remoteAddress },
              }),
            );
            return;
          }
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          void closeHandle(handle.id);
          reject(
            new BrokerCallError('NETWORK_DESTINATION_DENIED', {
              message: 'tcp connect failed',
              details: { host, port, cause: error.message },
            }),
          );
        };
        const cleanup = (): void => {
          socket.removeListener('connect', onConnect);
          socket.removeListener('error', onError);
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
      });
      return handle.id;
    },
    async tcpSend(pluginId, id, data) {
      const handle = requireHandle(pluginId, id);
      const socket = handle.resource;
      if (!(socket instanceof Socket)) {
        throw new BrokerCallError('STREAM_ABORTED', { message: 'tcp handle not writable' });
      }
      socket.write(data);
    },
    async tcpReceive(pluginId, id, limit, waitMs, signal) {
      const handle = requireHandle(pluginId, id);
      await waitFor(handle, waitMs, signal);
      const { messages } = drainRing(handle, limit);
      return { messages, closed: handle.closed };
    },
    async tcpClose(pluginId, id) {
      requireHandle(pluginId, id);
      await closeHandle(id);
    },
    async listenOpen(pluginId, host, port) {
      const bindHost = host ?? '127.0.0.1'; // §29.1.4: loopback by default
      deps.checkBind(bindHost, pluginId);
      const listener = allocate(pluginId, 'tcp');
      const pending: RingHandle[] = [];
      pendingConnections.set(listener.id, pending);
      const server = createServer((connection) => {
        const conn = allocate(pluginId, 'tcp');
        conn.resource = connection;
        connection.setNoDelay(true);
        connection.on('data', (chunk) => {
          pushRing(conn, chunk.toString('utf8'));
        });
        connection.on('close', () => {
          if (!conn.closed) void closeHandle(conn.id);
        });
        connection.on('error', () => {
          if (!conn.closed) void closeHandle(conn.id);
        });
        pending.push(conn);
        const waiter = listener.waiters.shift();
        waiter?.();
      });
      listener.resource = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error) => {
          void closeHandle(listener.id);
          reject(
            new BrokerCallError('NETWORK_DESTINATION_DENIED', {
              message: 'listen failed',
              details: { host: bindHost, port, cause: error.message },
            }),
          );
        });
        server.listen(port, bindHost, () => resolve());
      });
      const address = server.address();
      const boundPort = address !== null && typeof address === 'object' ? address.port : port;
      return { id: listener.id, port: boundPort };
    },
    async listenAccept(pluginId, id, waitMs, signal) {
      const listener = requireHandle(pluginId, id);
      const pending = pendingConnections.get(id) ?? [];
      if (pending.length === 0) {
        await waitFor(listener, waitMs, signal);
      }
      const conn = pending.shift();
      return conn === undefined ? null : conn.id;
    },
    async listenClose(pluginId, id) {
      requireHandle(pluginId, id);
      await closeHandle(id);
    },
    async udpOpen(pluginId, bindHost, bindPort) {
      const host = bindHost ?? '127.0.0.1'; // §29.1.4: loopback by default
      deps.checkBind(host, pluginId);
      const handle = allocate(pluginId, 'udp');
      const socket = createSocket('udp4');
      handle.resource = socket;
      socket.on('message', (message, rinfo) => {
        pushRing(handle, message.toString('utf8'), rinfo.address, rinfo.port);
      });
      socket.on('error', () => {
        void closeHandle(handle.id);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('error', (error) => {
          void closeHandle(handle.id);
          reject(
            new BrokerCallError('NETWORK_DESTINATION_DENIED', {
              message: 'udp bind failed',
              details: { host, port: bindPort, cause: error.message },
            }),
          );
        });
        socket.bind(bindPort, host, () => resolve());
      });
      const address = socket.address();
      return { id: handle.id, port: typeof address === 'object' ? address.port : bindPort };
    },
    async udpSend(pluginId, id, data, host, port) {
      const handle = requireHandle(pluginId, id);
      // §SEC-03: policy classifies every DNS answer; the datagram is sent to
      // the approved address (the socket itself performs no DNS for `host`).
      const approved = await deps.checkDestination(host, pluginId);
      const socket = handle.resource;
      if (!(socket instanceof DgramSocket)) {
        throw new BrokerCallError('STREAM_ABORTED', { message: 'udp handle not writable' });
      }
      await new Promise<void>((resolve, reject) => {
        socket.send(Buffer.from(data, 'utf8'), port, approved[0] ?? host, (error) => {
          if (error) {
            reject(
              new BrokerCallError('NETWORK_DESTINATION_DENIED', {
                message: 'udp send failed',
                details: { host, port },
              }),
            );
            return;
          }
          resolve();
        });
      });
    },
    async udpReceive(pluginId, id, waitMs, signal) {
      const handle = requireHandle(pluginId, id);
      await waitFor(handle, waitMs, signal);
      const { messages, remoteHosts, remotePorts } = drainRing(handle, 1);
      const data = messages[0] ?? null;
      const host = remoteHosts[0] ?? null;
      const port = remotePorts[0] ?? null;
      return { data, host, port };
    },
    async udpClose(pluginId, id) {
      requireHandle(pluginId, id);
      await closeHandle(id);
    },
    async closePlugin(pluginId) {
      for (const id of [...handles.keys()]) {
        const handle = handles.get(id);
        if (handle !== undefined && handle.pluginId === pluginId) {
          await closeHandle(id);
        }
      }
    },
    async closeAll() {
      for (const id of [...handles.keys()]) {
        await closeHandle(id);
      }
    },
    size() {
      return handles.size;
    },
  };
}
