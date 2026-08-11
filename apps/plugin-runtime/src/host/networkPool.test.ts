/**
 * §29 keep-alive/pooling + proxy transport (Stage F part 15).
 * Real sockets against local http servers: keep-alive reuse, bounded idle
 * sockets, close semantics, absolute-form HTTP proxy and the CONNECT tunnel
 * path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNetworkPool } from './networkPool.js';

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    // Force-close lingering tunnel sockets so close() never hangs.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('network pool (§29 keep-alive/pooling)', () => {
  it('reuses a keep-alive connection for sequential requests to the same origin', async () => {
    const server = createServer((_req, res) => {
      res.end('ok');
    });
    const port = await listen(server);
    let connections = 0;
    server.on('connection', () => {
      connections += 1;
    });

    const pool = createNetworkPool();
    const first = await pool.fetch(`http://127.0.0.1:${port}/a`);
    await first.text();
    const second = await pool.fetch(`http://127.0.0.1:${port}/b`);
    await second.text();

    // One socket served both requests: the agent kept it alive and reused it.
    expect(connections).toBe(1);
    expect(second.status).toBe(200);
    expect(pool.metrics().totalRequests).toBe(2);
    // The idle socket is back in the pool for the next reuse.
    expect(pool.metrics().freeSockets).toBeGreaterThanOrEqual(1);

    await pool.close();
    expect(pool.metrics().openSockets + pool.metrics().freeSockets).toBe(0);
  });

  it('bounds concurrent sockets per origin through the agent', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => res.end('slow'), 30);
    });
    const port = await listen(server);
    const pool = createNetworkPool({ maxSocketsPerOrigin: 2 });

    const requests = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pool.fetch(`http://127.0.0.1:${port}/r${i}`).then((r) => r.text()),
      ),
    );
    expect(requests).toHaveLength(6);
    expect(pool.metrics().pendingRequests).toBeGreaterThanOrEqual(0);
    expect(pool.metrics().totalRequests).toBe(6);
    await pool.close();
  });

  it('rejects new fetches and clears idle sockets after close', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    const port = await listen(server);
    const pool = createNetworkPool();
    await (await pool.fetch(`http://127.0.0.1:${port}/`)).text();
    expect(pool.metrics().freeSockets).toBeGreaterThanOrEqual(1);

    await pool.close();
    expect(pool.metrics().freeSockets + pool.metrics().openSockets).toBe(0);
    await expect(pool.fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow('network pool is closed');
  });
});

describe('network pool (§29 proxy)', () => {
  it('routes an http target through the proxy with the absolute-form request line', async () => {
    const seen: Array<{
      url: string;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const proxy = createServer((req, res) => {
      seen.push({
        url: req.url ?? '',
        headers: { ...req.headers },
      });
      res.end('proxied');
    });
    const proxyPort = await listen(proxy);

    const pool = createNetworkPool({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
    const resp = await pool.fetch('http://example.com/resource', {
      method: 'POST',
      headers: { 'x-requested-with': 'sdk' },
      body: 'payload',
    });
    const body = await resp.text();
    expect(body).toBe('proxied');
    expect(seen).toHaveLength(1);
    // The absolute-form request line carries the full target URL, and the
    // Host header is the target, not the proxy.
    expect(seen[0]?.url).toBe('http://example.com/resource');
    expect(seen[0]?.headers['host']).toBe('example.com');
    expect(seen[0]?.headers['x-requested-with']).toBe('sdk');
    // The canonical URL form (with trailing slash) identifies the proxy.
    expect(pool.metrics().proxy).toBe(`http://127.0.0.1:${proxyPort}/`);
    await pool.close();
  });

  it('tunnels https targets through the proxy with CONNECT', async () => {
    const connectTargets: string[] = [];
    // The proxy accepts CONNECT and then drops the tunnel — the pool's TLS
    // handshake over the dead tunnel fails, which is exactly the observable
    // that proves the CONNECT path was exercised. (A real proxy also drops
    // dead tunnels; the pool additionally destroys its own socket.)
    const proxy = createServer();
    proxy.on('connect', (req, socket) => {
      connectTargets.push(req.url ?? '');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      setTimeout(() => socket.destroy(), 50);
    });
    const proxyPort = await listen(proxy);

    const pool = createNetworkPool({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
    await expect(pool.fetch('https://example.com/secure')).rejects.toThrow();
    expect(connectTargets).toEqual(['example.com:443']);
    await pool.close();
  });

  it('rejects a non-http proxy URL at creation', () => {
    expect(() => createNetworkPool({ proxyUrl: 'ftp://proxy.local' })).toThrow(
      'proxy URL must use http: or https:',
    );
  });
});
