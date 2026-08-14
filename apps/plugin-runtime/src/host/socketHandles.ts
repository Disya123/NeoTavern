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
import { randomBytes } from 'node:crypto';
import {
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
  if (resource instanceof WebSocket) {
    resource.close();
  } else if (resource instanceof Socket || resource instanceof TLSSocket) {
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
      // The pre-connect policy check applies (§29.1); post-connect
      // remoteAddress verification is a documented follow-up for WebSocket —
      // undici's WebSocket does not expose the connected socket.
      await deps.checkDestination(parsed.hostname, pluginId);
      const handle = allocate(pluginId, 'websocket');
      const socket = new WebSocket(url, protocols);
      handle.resource = socket;
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return; // binary frames: out of v1 scope
        pushRing(handle, event.data);
      });
      socket.addEventListener('close', () => {
        void closeHandle(handle.id);
      });
      socket.addEventListener('error', () => {
        void closeHandle(handle.id);
      });
      return handle.id;
    },
    async websocketSend(pluginId, id, data) {
      const handle = requireHandle(pluginId, id);
      const socket = handle.resource;
      if (!(socket instanceof WebSocket) || socket.readyState !== WebSocket.OPEN) {
        throw new BrokerCallError('STREAM_ABORTED', { message: 'websocket not open' });
      }
      socket.send(data);
    },
    async websocketReceive(pluginId, id, limit, waitMs, signal) {
      const handle = requireHandle(pluginId, id);
      await waitFor(handle, waitMs, signal);
      const { messages } = drainRing(handle, limit);
      return { messages, closed: handle.closed };
    },
    async websocketClose(pluginId, id) {
      requireHandle(pluginId, id);
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
