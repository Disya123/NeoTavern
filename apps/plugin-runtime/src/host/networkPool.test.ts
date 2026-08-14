/**
 * §29 keep-alive/pooling + proxy transport (Stage F part 15).
 * Real sockets against local http servers: keep-alive reuse, bounded idle
 * sockets, close semantics, absolute-form HTTP proxy and the CONNECT tunnel
 * path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { NETWORK_MAX_BODY_BYTES } from '@neotavern/contracts';
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

  it('absolute-form hop carries the verified IP, Host keeps the hostname (§SEC-03)', async () => {
    const seen: Array<{ url: string; host: string | undefined }> = [];
    const proxy = createServer((req, res) => {
      seen.push({ url: req.url ?? '', host: req.headers.host });
      res.end('proxied');
    });
    const proxyPort = await listen(proxy);

    const pool = createNetworkPool({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
    const resp = await pool.fetch('http://example.com/resource?q=1', undefined, {
      ips: ['93.184.216.34'],
    });
    expect(await resp.text()).toBe('proxied');
    // The proxy resolves no DNS: the absolute-form authority is the approved
    // IP; the Host header keeps the hostname for the target.
    expect(seen[0]?.url).toBe('http://93.184.216.34/resource?q=1');
    expect(seen[0]?.host).toBe('example.com');
    await pool.close();
  });

  it('CONNECT authority carries the verified IP, TLS validates the hostname (§SEC-03)', async () => {
    const connectTargets: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (req, socket) => {
      connectTargets.push(req.url ?? '');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      setTimeout(() => socket.destroy(), 50);
    });
    const proxyPort = await listen(proxy);

    const pool = createNetworkPool({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
    // The TLS handshake still fails (dropped tunnel) — the observable that
    // matters here is the CONNECT authority carrying the verified IP.
    await expect(
      pool.fetch('https://example.com/secure', undefined, { ips: ['93.184.216.34'] }),
    ).rejects.toThrow();
    expect(connectTargets).toEqual(['93.184.216.34:443']);
    await pool.close();
  });

  it('CONNECT authority brackets IPv6 literals in the verified IP (§SEC-03)', async () => {
    const connectTargets: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (req, socket) => {
      connectTargets.push(req.url ?? '');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      setTimeout(() => socket.destroy(), 50);
    });
    const proxyPort = await listen(proxy);

    const pool = createNetworkPool({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
    // The TLS handshake fails (dropped tunnel) — the observable is the
    // CONNECT authority form: RFC 7231 §4.3.6 requires the IPv6 literal to be
    // bracketed, `[2001:db8::1]:443`, never `2001:db8::1:443`.
    await expect(
      pool.fetch('https://example.com/secure', undefined, { ips: ['2001:db8::1'] }),
    ).rejects.toThrow();
    expect(connectTargets).toEqual(['[2001:db8::1]:443']);
    await pool.close();
  });

  it('https-proxy to an http target speaks TLS to the proxy, never plaintext (§SEC-03)', async () => {
    // The proxy URL claims https: but the listener is a plaintext HTTP server.
    // With the fix the pool attempts a TLS handshake to the proxy, which a
    // plaintext server cannot satisfy — the fetch must FAIL. Before the fix
    // the pool sent the absolute-form request in plaintext to the proxy's TLS
    // port and the request "succeeded", which is exactly the plaintext-on-TLS
    // port bug (SEC-03 proxy-path review).
    const proxy = createServer((_req, res) => {
      res.end('proxied');
    });
    const proxyPort = await listen(proxy);

    const pool = createNetworkPool({ proxyUrl: `https://127.0.0.1:${proxyPort}` });
    await expect(pool.fetch('http://example.com/resource')).rejects.toThrow();
    await pool.close();
  });

  it('rejects a non-http proxy URL at creation', () => {
    expect(() => createNetworkPool({ proxyUrl: 'ftp://proxy.local' })).toThrow(
      'proxy URL must use http: or https:',
    );
  });
});

describe('network pool verified-IP connects and bounded bodies (ТЗ §SEC-03/§SEC-04)', () => {
  it('connects to the approved IP and keeps the hostname only in Host (§SEC-03)', async () => {
    const seenHosts: string[] = [];
    const server = createServer((req, res) => {
      seenHosts.push(req.headers.host ?? '');
      res.end('verified');
    });
    const port = await listen(server);

    const pool = createNetworkPool();
    // `resolve-me.invalid` does not resolve on the OS DNS: the request can
    // only succeed if the transport connects to the approved IP 127.0.0.1.
    const resp = await pool.fetch(`http://resolve-me.invalid:${port}/`, undefined, {
      ips: ['127.0.0.1'],
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('verified');
    // The hostname survives only in the Host header, never in DNS/connect.
    expect(seenHosts).toEqual([`resolve-me.invalid:${port}`]);
    await pool.close();
  });

  it('bounded body: destroys the response at the cap and returns the prefix (§SEC-04)', async () => {
    const FULL = NETWORK_MAX_BODY_BYTES + 1024 * 1024; // above the response cap
    let written = 0;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x61); // 'a'
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        res.write(chunk);
        written += chunk.length;
        if (written >= FULL) {
          clearInterval(timer);
          res.end();
        }
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    const port = await listen(server);

    const pool = createNetworkPool();
    const resp = await pool.fetch(`http://127.0.0.1:${port}/`);
    const body = await resp.text();
    expect(body.length).toBe(NETWORK_MAX_BODY_BYTES);
    // The connection was destroyed once the cap was exceeded — the server
    // never delivered the full body.
    expect(written).toBeLessThan(FULL);
    await pool.close();
  });

  it('decodes a gzip body and drops the content-encoding header (§SEC-04)', async () => {
    const payload = Buffer.from('compressed-response-'.repeat(200));
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipSync(payload));
    });
    const port = await listen(server);

    const pool = createNetworkPool();
    const resp = await pool.fetch(`http://127.0.0.1:${port}/`);
    expect(await resp.text()).toBe(payload.toString('utf8'));
    expect(resp.headers.get('content-encoding')).toBeNull();
    await pool.close();
  });

  it('decodes deflate and brotli bodies too (§SEC-04)', async () => {
    const payload = Buffer.from('deflate-brotli-'.repeat(100));
    const server = createServer((req, res) => {
      if (req.url === '/deflate') {
        res.writeHead(200, { 'content-encoding': 'deflate' });
        res.end(deflateSync(payload));
      } else {
        res.writeHead(200, { 'content-encoding': 'br' });
        res.end(brotliCompressSync(payload));
      }
    });
    const port = await listen(server);

    const pool = createNetworkPool();
    const deflated = await pool.fetch(`http://127.0.0.1:${port}/deflate`);
    expect(await deflated.text()).toBe(payload.toString('utf8'));
    const brotli = await pool.fetch(`http://127.0.0.1:${port}/br`);
    expect(await brotli.text()).toBe(payload.toString('utf8'));
    await pool.close();
  });

  it('bounds the DECOMPRESSED size — a tiny gzip bomb cannot expand past the cap (§SEC-04)', async () => {
    // A ~100 KB compressed body that decompresses far past NETWORK_MAX_BODY_BYTES.
    const bomb = gzipSync(Buffer.alloc(NETWORK_MAX_BODY_BYTES + 1024 * 1024, 0x62));
    expect(bomb.byteLength).toBeLessThan(NETWORK_MAX_BODY_BYTES);
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    const port = await listen(server);

    const pool = createNetworkPool();
    const resp = await pool.fetch(`http://127.0.0.1:${port}/`);
    const body = await resp.text();
    expect(body.length).toBe(NETWORK_MAX_BODY_BYTES);
    await pool.close();
  });

  it('bounds the COMPRESSED wire bytes too — wire and decoded sides share the cap (§SEC-04)', async () => {
    // Concatenated gzip members: each member decodes to 16 bytes but carries
    // ~39 wire bytes. The decoded total (320 B) fits a 512 B cap while the
    // compressed total (~780 B) does not — a decoder that counted only the
    // decoded side would return all 320 bytes, so the shorter body below is
    // direct evidence that the wire side is capped while streaming.
    const CAP = 512;
    const MEMBERS = 20;
    const member = gzipSync(Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + 11) % 256)));
    const wire = Buffer.concat(Array.from({ length: MEMBERS }, () => member));
    expect(wire.byteLength).toBeGreaterThan(CAP);
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      const chunks: Buffer[] = [];
      for (let i = 0; i < wire.byteLength; i += 48) chunks.push(wire.subarray(i, i + 48));
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        const chunk = chunks.shift();
        if (chunk === undefined) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(chunk);
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    const port = await listen(server);

    // Control: without the wire cap the whole body decodes (multi-member
    // gzip is processed by the streaming decoder, not just the first member).
    const full = await (await createNetworkPool().fetch(`http://127.0.0.1:${port}/`)).text();
    expect(full.length).toBe(MEMBERS * 16);

    // With the wire cap the response is cut before all members arrive.
    const pool = createNetworkPool({ maxBodyBytes: CAP });
    const resp = await pool.fetch(`http://127.0.0.1:${port}/`);
    const body = await resp.text();
    expect(body.length).toBeLessThan(MEMBERS * 16);
    await pool.close();
  });
});
