/**
 * Single-process web serving (NEOTA_WEB_DIR) regression tests: the built SPA is
 * served by the Fastify process itself, and same-origin asset requests must
 * be trusted even though they carry an Origin header. Vite emits
 * `<script type="module" crossorigin>` tags, whose CORS-mode fetches include
 * Origin on same-origin requests; with the CORS allowlist pinned to the dev
 * Vite origin, every asset 500s with "Not allowed by CORS".
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

const webDirs: string[] = [];

afterEach(() => {
  for (const dir of webDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neotavern-webdir-'));
  webDirs.push(dir);
  return dir;
}

describe('single-process web serving (NEOTA_WEB_DIR)', () => {
  it('serves the SPA and trusts the server own origin for asset requests', async () => {
    const webDir = makeWebDir();
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>neotavern</title>');
    writeFileSync(join(webDir, 'asset.js'), 'console.log("asset")');
    const { app } = await createTestApp({ webDir, corsOrigin: 'http://127.0.0.1:8000' });

    // Plain navigation: no Origin header.
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('neotavern');

    // Asset with the exact own-origin header.
    const asset = await app.inject({
      method: 'GET',
      url: '/asset.js',
      headers: { origin: 'http://127.0.0.1:8000' },
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');

    // Loopback host alias (localhost vs 127.0.0.1) is trusted too.
    const localhostAlias = await app.inject({
      method: 'GET',
      url: '/asset.js',
      headers: { origin: 'http://localhost:8000' },
    });
    expect(localhostAlias.statusCode).toBe(200);

    // SPA fallback for client-side routes.
    const fallback = await app.inject({ method: 'GET', url: '/chat/42' });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toContain('neotavern');
  });

  it('still rejects foreign origins in single-process mode', async () => {
    const webDir = makeWebDir();
    writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
    const { app } = await createTestApp({ webDir, corsOrigin: 'http://127.0.0.1:8000' });

    const foreign = await app.inject({
      method: 'GET',
      url: '/asset.js',
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(500);
  });
});
