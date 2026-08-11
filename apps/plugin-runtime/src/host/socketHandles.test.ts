/**
 * Socket registry tests (ТЗ v3.2 §29 Stage E): tcp round-trip, udp
 * round-trip, listen with loopback default + per-connection handles,
 * SSRF destination policy, bind policy (§29.1.4), bounded ring eviction,
 * revoke closing handles, and the handle-count cap.
 */
import { describe, expect, it } from 'vitest';
import { connect as netConnect, createServer, type Server } from 'node:net';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { createSocketRegistry, type SocketRegistry } from './socketHandles.js';

function registry(): SocketRegistry {
  return createSocketRegistry({
    checkDestination: async (host) => {
      // Loopback-only test policy: 127.0.0.1 / localhost pass, the rest deny.
      if (host !== '127.0.0.1' && host !== 'localhost') {
        const error = new Error('destination denied') as Error & { code?: string };
        error.code = 'NETWORK_DESTINATION_DENIED';
        throw error;
      }
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
});
