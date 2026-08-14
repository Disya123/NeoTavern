/**
 * Socket registry tests (ТЗ v3.2 §29 Stage E): tcp round-trip, udp
 * round-trip, listen with loopback default + per-connection handles,
 * SSRF destination policy, bind policy (§29.1.4), bounded ring eviction,
 * revoke closing handles, and the handle-count cap.
 */
import { describe, expect, it } from 'vitest';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import {
  createSocketRegistry,
  type SocketRegistry,
  wsAcceptHeader,
  wsParseFrame,
  WS_MAX_FRAME_BYTES,
  WS_MAX_HANDSHAKE_BYTES,
} from './socketHandles.js';

function registry(): SocketRegistry {
  return createSocketRegistry({
    checkDestination: async (host) => {
      // Loopback-only test policy: 127.0.0.1 / localhost pass, the rest deny.
      // Returns the approved address list (ТЗ §SEC-03 post-connect check).
      if (host !== '127.0.0.1' && host !== 'localhost') {
        const error = new Error('destination denied') as Error & { code?: string };
        error.code = 'NETWORK_DESTINATION_DENIED';
        throw error;
      }
      return ['127.0.0.1'];
    },
    checkBind: (host) => {
      if (host !== '127.0.0.1' && host !== 'localhost') {
        const error = new Error('bind denied') as Error & { code?: string };
        error.code = 'POLICY_DENIED';
        throw error;
      }
    },
  });
}

function abortSignal(): AbortSignal {
  const controller = new AbortController();
  return controller.signal;
}

/** Start an echo server on an ephemeral loopback port. */
async function echoServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('socket registry (§29)', () => {
  it('round-trips data over a tcp connection to an echo server', async () => {
    const { server: _server, port, close } = await echoServer();
    try {
      const sockets = registry();
      const id = await sockets.tcpConnect('plugin-a', '127.0.0.1', port, false);
      await sockets.tcpSend('plugin-a', id, 'ping');
      const received = await sockets.tcpReceive('plugin-a', id, 1, 2000, abortSignal());
      expect(received.messages).toEqual(['ping']);
      expect(received.closed).toBe(false);
      await sockets.tcpClose('plugin-a', id);
      expect(sockets.size()).toBe(0);
    } finally {
      await close();
    }
  });

  it('connects to the verified IP, never resolving the hostname (§SEC-03)', async () => {
    // The echo server binds 127.0.0.1 ONLY. On hosts where 'localhost'
    // resolves to ::1 first, a connect-by-hostname would fail; the registry
    // must connect to the policy-approved 127.0.0.1 instead.
    const { server: _server, port, close } = await echoServer();
    try {
      const sockets = registry(); // checkDestination('localhost') -> ['127.0.0.1']
      const id = await sockets.tcpConnect('plugin-a', 'localhost', port, false);
      await sockets.tcpSend('plugin-a', id, 'verified-ip');
      const received = await sockets.tcpReceive('plugin-a', id, 1, 2000, abortSignal());
      expect(received.messages).toEqual(['verified-ip']);
      await sockets.tcpClose('plugin-a', id);
    } finally {
      await close();
    }
  });

  it('rejects tcp destinations outside the SSRF policy', async () => {
    const sockets = registry();
    await expect(sockets.tcpConnect('plugin-a', '192.168.1.1', 80, false)).rejects.toMatchObject({
      code: 'NETWORK_DESTINATION_DENIED',
    });
  });

  it('listens on loopback by default and accepts per-connection handles', async () => {
    const sockets = registry();
    const { id, port } = await sockets.listenOpen('plugin-a', undefined, 0);
    expect(port).toBeGreaterThan(0);
    const client = netConnect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.write('hello');
    const connectionId = await sockets.listenAccept('plugin-a', id, 2000, abortSignal());
    expect(connectionId).not.toBeNull();
    const received = await sockets.tcpReceive('plugin-a', connectionId!, 1, 2000, abortSignal());
    expect(received.messages).toEqual(['hello']);
    await sockets.tcpSend('plugin-a', connectionId!, 'back');
    const reply = await new Promise<string>((resolve) => {
      client.once('data', (chunk) => resolve(chunk.toString('utf8')));
    });
    expect(reply).toBe('back');
    client.destroy();
    await sockets.listenClose('plugin-a', id);
    // The connection close event removes the accepted handle asynchronously.
    await expect.poll(() => sockets.size()).toBe(0);
  });

  it('rejects non-loopback and unspecified bind hosts (§29.1.4)', async () => {
    const sockets = registry();
    await expect(sockets.listenOpen('plugin-a', '0.0.0.0', 0)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await expect(sockets.listenOpen('plugin-a', '192.168.1.5', 0)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('round-trips udp datagrams with remote endpoint info', async () => {
    const sockets = registry();
    const { id, port } = await sockets.udpOpen('plugin-a', undefined, 0);
    const peer = createSocket('udp4');
    await new Promise<void>((resolve) => peer.bind(0, '127.0.0.1', resolve));
    const peerPort = (peer.address() as AddressInfo).port;
    try {
      peer.on('message', (message, rinfo) => {
        peer.send(`echo:${message.toString('utf8')}`, rinfo.port, rinfo.address);
      });
      await sockets.udpSend('plugin-a', id, 'datagram', '127.0.0.1', peerPort);
      const received = await sockets.udpReceive('plugin-a', id, 2000, abortSignal());
      expect(received.data).toBe('echo:datagram');
      expect(received.host).toBe('127.0.0.1');
      expect(received.port).toBe(peerPort);
      void port;
    } finally {
      peer.close();
      await sockets.udpClose('plugin-a', id);
    }
  });

  it('sends udp to the verified IP, never resolving the hostname (§SEC-03)', async () => {
    const sockets = registry();
    const { id } = await sockets.udpOpen('plugin-a', undefined, 0);
    const peer = createSocket('udp4');
    await new Promise<void>((resolve) => peer.bind(0, '127.0.0.1', resolve));
    const peerPort = (peer.address() as AddressInfo).port;
    try {
      peer.on('message', (message, rinfo) => {
        peer.send(`echo:${message.toString('utf8')}`, rinfo.port, rinfo.address);
      });
      // 'localhost' must be sent to the policy-approved 127.0.0.1 — the dgram
      // socket itself resolves no DNS for the hostname.
      await sockets.udpSend('plugin-a', id, 'verified-udp', 'localhost', peerPort);
      const received = await sockets.udpReceive('plugin-a', id, 2000, abortSignal());
      expect(received.data).toBe('echo:verified-udp');
    } finally {
      peer.close();
      await sockets.udpClose('plugin-a', id);
    }
  });

  it('evicts the oldest messages when the ring budget is exceeded (§17)', async () => {
    const { server: _server, port, close } = await echoServer();
    try {
      const sockets = registry();
      const id = await sockets.tcpConnect('plugin-a', '127.0.0.1', port, false);
      // 200 small messages × 4 bytes each: the 128-message ring cap applies.
      for (let i = 0; i < 200; i += 1) {
        await sockets.tcpSend('plugin-a', id, 'xxxx');
      }
      // Give the server time to echo everything back.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const received = await sockets.tcpReceive('plugin-a', id, 200, 0, abortSignal());
      expect(received.messages.length).toBeLessThanOrEqual(128);
      await sockets.tcpClose('plugin-a', id);
    } finally {
      await close();
    }
  });

  it('closes all plugin handles on closePlugin (revoke, §10.2)', async () => {
    const { server: _server, port, close } = await echoServer();
    try {
      const sockets = registry();
      const id = await sockets.tcpConnect('plugin-a', '127.0.0.1', port, false);
      await sockets.tcpConnect('plugin-b', '127.0.0.1', port, false);
      expect(sockets.size()).toBe(2);
      await sockets.closePlugin('plugin-a');
      expect(sockets.size()).toBe(1);
      await expect(sockets.tcpSend('plugin-a', id, 'x')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await sockets.closeAll();
    } finally {
      await close();
    }
  });

  it('caps the live handles per plugin', async () => {
    const { server: _server, port, close } = await echoServer();
    try {
      const sockets = registry();
      for (let i = 0; i < 32; i += 1) {
        await sockets.tcpConnect('plugin-a', '127.0.0.1', port, false);
      }
      await expect(sockets.tcpConnect('plugin-a', '127.0.0.1', port, false)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
      expect(sockets.size()).toBe(32);
      await sockets.closeAll();
    } finally {
      await close();
    }
  });

  it('returns closed:true once the stream ended', async () => {
    const server = createServer((socket) => {
      socket.write('bye');
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const sockets = registry();
      const id = await sockets.tcpConnect('plugin-a', '127.0.0.1', port, false);
      const received = await sockets.tcpReceive('plugin-a', id, 1, 2000, abortSignal());
      expect(received.messages).toEqual(['bye']);
      // The peer ended: the close event removes the handle asynchronously.
      await expect.poll(() => sockets.size()).toBe(0);
      await expect(sockets.tcpReceive('plugin-a', id, 1, 0, abortSignal())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('websocket round-trips over the verified IP, handshake + RFC 6455 frames (§SEC-03)', async () => {
    // Minimal RFC 6455 echo server on a raw net socket: accepts the Upgrade,
    // then replies to every masked client text frame with an unmasked frame.
    // Client frames are masked (RFC 6455 §5.1) — the server-side parser here
    // unmasks them (socketHandles.wsParseFrame only decodes server frames).
    const parseClientFrame = (
      buffer: Buffer,
    ): { opcode: number; payload: Buffer; rest: Buffer } | null => {
      if (buffer.byteLength < 2) return null;
      const first = buffer[0];
      if (first === undefined) return null;
      const opcode = first & 0x0f;
      const second = buffer[1];
      if (second === undefined) return null;
      const b1 = second;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.byteLength < 4) return null;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.byteLength < 10) return null;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.byteLength < offset + 4 + len) return null;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) {
        payload[i] = (buffer[offset + 4 + i] ?? 0) ^ (mask[i & 3] ?? 0);
      }
      return { opcode, payload, rest: buffer.subarray(offset + 4 + len) };
    };
    const server = createServer((socket: Socket) => {
      let buffer: Buffer = Buffer.alloc(0);
      let upgraded = false;
      socket.on('error', () => undefined); // peer close races are expected here
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const headEnd = buffer.indexOf('\r\n\r\n');
          if (headEnd === -1) return;
          const head = buffer.subarray(0, headEnd).toString('utf8');
          buffer = buffer.subarray(headEnd + 4);
          const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(head)?.[1] ?? '';
          const accept = wsAcceptHeader(key);
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          upgraded = true;
        }
        for (;;) {
          const parsed = parseClientFrame(buffer);
          if (parsed === null) break;
          buffer = parsed.rest;
          const { opcode, payload } = parsed;
          if (opcode === 0x8) {
            // Close handshake: reply with a close frame and end the socket.
            socket.write(Buffer.from([0x80 | 0x8, 0x02, 0x03, 0xe8]));
            socket.end();
            return;
          }
          if (opcode !== 0x1) continue; // only text frames are echoed
          const data = payload;
          let header: Buffer;
          if (data.byteLength < 126) {
            header = Buffer.from([0x80 | 0x1, data.byteLength]);
          } else {
            header = Buffer.alloc(4);
            header[0] = 0x80 | 0x1;
            header[1] = 126;
            header.writeUInt16BE(data.byteLength, 2);
          }
          socket.write(Buffer.concat([header, data]));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const sockets = registry();
      // 'localhost' is approved to 127.0.0.1; the WS client must connect to
      // the verified IP and verify remoteAddress after connect (§SEC-03).
      const id = await sockets.websocketOpen('plugin-a', `ws://localhost:${port}/echo`, undefined);
      await sockets.websocketSend('plugin-a', id, 'hello-ws');
      const received = await sockets.websocketReceive('plugin-a', id, 1, 2000, abortSignal());
      expect(received.messages).toEqual(['hello-ws']);
      expect(received.closed).toBe(false);
      await sockets.websocketClose('plugin-a', id);
      await expect.poll(() => sockets.size()).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses a declared frame length above the SEC-04 bound without buffering', async () => {
    // A 127-bit declared length: wsParseFrame must answer tooLarge from the
    // header alone (2 + 8 bytes), never wait for the full declared payload.
    const huge = Buffer.alloc(10);
    huge[0] = 0x80 | 0x1; // FIN + text
    huge[1] = 127; // 64-bit length follows
    huge.writeBigUInt64BE(BigInt(WS_MAX_FRAME_BYTES) + 1n, 2);
    const parsed = wsParseFrame(huge, WS_MAX_FRAME_BYTES);
    expect(parsed).not.toBeNull();
    expect(parsed && 'tooLarge' in parsed).toBe(true);
  });

  it('accepts a declared frame length at the SEC-04 bound once the payload arrives', async () => {
    const header = Buffer.alloc(10);
    header[0] = 0x80 | 0x1;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(WS_MAX_FRAME_BYTES), 2);
    // Only the header present: still partial (payload not yet arrived).
    expect(wsParseFrame(header, WS_MAX_FRAME_BYTES)).toBeNull();
    // Header + payload of exactly the bound: complete frame.
    const full = Buffer.concat([header, Buffer.alloc(WS_MAX_FRAME_BYTES, 0x61)]);
    const parsed = wsParseFrame(full, WS_MAX_FRAME_BYTES);
    expect(parsed).not.toBeNull();
    expect(parsed && 'frame' in parsed && parsed.frame.payload.byteLength).toBe(WS_MAX_FRAME_BYTES);
  });

  it('tears down a websocket whose peer declares an oversized frame (SEC-04)', async () => {
    // After the upgrade the server immediately writes a text frame that
    // declares 2^31 bytes. The client must refuse it from the header and
    // close the handle instead of buffering toward the declared length.
    const server = createServer((socket: Socket) => {
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('Sec-WebSocket-Key:')) {
          const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(chunk.toString('utf8'))?.[1] ?? '';
          const accept = wsAcceptHeader(key);
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          const huge = Buffer.alloc(10);
          huge[0] = 0x80 | 0x1;
          huge[1] = 127;
          huge.writeBigUInt64BE(0x80000000n, 2); // declared 2 GiB payload
          socket.write(huge);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const sockets = registry();
      const id = await sockets.websocketOpen('plugin-a', `ws://localhost:${port}/huge`, undefined);
      // The oversized declaration closes the handle asynchronously.
      await expect.poll(() => sockets.size()).toBe(0);
      await expect(
        sockets.websocketReceive('plugin-a', id, 1, 0, abortSignal()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects a websocket whose connected address is outside the approved set (§SEC-03)', async () => {
    // A policy that approves 127.0.0.2 while the server lives on 127.0.0.1:
    // the client connects to 127.0.0.2, the post-connect remoteAddress check
    // (127.0.0.1) must fail the open BEFORE any handshake byte is sent.
    const server = createServer((socket: Socket) => {
      socket.on('error', () => undefined); // client destroys on mismatch
      socket.on('data', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const mismatchRegistry = createSocketRegistry({
      checkDestination: async () => ['127.0.0.2'],
      checkBind: () => undefined,
    });
    try {
      await expect(
        mismatchRegistry.websocketOpen('plugin-a', `ws://127.0.0.1:${port}/`, undefined),
      ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_DENIED' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses a websocket whose upgrade head exceeds the SEC-04 size bound (§SEC-04)', async () => {
    // A peer that streams an incomplete handshake (no `\r\n\r\n`) past
    // WS_MAX_HANDSHAKE_BYTES must be torn down instead of letting the client
    // accumulate an unbounded response head.
    const server = createServer((socket: Socket) => {
      socket.on('error', () => undefined);
      socket.on('data', () => {
        // Stream one large chunk that never terminates the header. The write
        // is capped below the socket high-water mark so it lands in one or a
        // few 'data' events — the client must still refuse on the size bound.
        socket.write(Buffer.alloc(WS_MAX_HANDSHAKE_BYTES + 1024, 0x41));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const sockets = registry();
      await expect(
        sockets.websocketOpen('plugin-a', `ws://localhost:${port}/head`, undefined),
      ).rejects.toMatchObject({
        code: 'NETWORK_DESTINATION_DENIED',
        message: 'websocket upgrade head too large',
      });
      // The handle slot was released — no leak behind the failed open.
      await expect.poll(() => sockets.size()).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('times out a websocket whose peer never completes the upgrade head (§SEC-04)', async () => {
    // The TCP peer accepts the connection and reads the upgrade request but
    // never writes a response: the handshake must fail after the configured
    // wall-clock bound and release the handle.
    const server = createServer((socket: Socket) => {
      socket.on('error', () => undefined);
      socket.on('data', () => undefined); // swallow the upgrade request
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const timeoutRegistry = createSocketRegistry({
        checkDestination: async (host) => {
          if (host !== 'localhost' && host !== '127.0.0.1') throw new Error('denied');
          return ['127.0.0.1'];
        },
        checkBind: () => undefined,
        wsHandshakeTimeoutMs: 150,
      });
      const started = Date.now();
      await expect(
        timeoutRegistry.websocketOpen('plugin-a', `ws://localhost:${port}/slow`, undefined),
      ).rejects.toMatchObject({
        code: 'NETWORK_DESTINATION_DENIED',
        message: 'websocket upgrade timed out',
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(120);
      await expect.poll(() => timeoutRegistry.size()).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
