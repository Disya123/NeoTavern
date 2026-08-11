import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { DEFAULT_PROVIDER_TIMEOUTS, ProviderRegistry } from '@neotavern/provider-sdk';
import { createLogger } from '@neotavern/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ensureDataDirs, resolveDataPaths } from '../src/lib/paths.js';
import { ContextStrategyRegistry } from '../src/pipeline/contextShift.js';
import { PostProcessorRegistry } from '../src/pipeline/postProcess.js';
import type { TypedApp } from '../src/types.js';

const TOKEN = 'correct-horse-battery-staple-remote-token';
const ORIGIN = 'http://neotavern.test';
const apps: TypedApp[] = [];
const databases: AppDatabase[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) database.close();
});

// Kept on a hand-rolled buildApp (not createTestApp from ./helpers.js): the
// helper hardcodes remoteAccess: false, publicOrigin, corsOrigin,
// remoteTokenHash and secureSessionCookies, all of which this suite must
// control per test.
async function remoteApp(options: { origin?: string; secure?: boolean } = {}): Promise<TypedApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'neotavern-remote-auth-'));
  const origin = options.origin ?? ORIGIN;
  const paths = resolveDataPaths(dataDir);
  ensureDataDirs(paths);
  const database = createAppDatabase(':memory:');
  databases.push(database);
  const app = await buildApp({
    database,
    providers: new ProviderRegistry(),
    contextStrategies: new ContextStrategyRegistry(),
    postProcessors: new PostProcessorRegistry(),
    logger: createLogger({ level: 'error' }),
    paths,
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webDir: null,
      logLevel: 'error',
      corsOrigin: origin,
      remoteAccess: true,
      publicOrigin: origin,
      remoteTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
      secureSessionCookies: options.secure ?? false,
      safeMode: false,
      pluginNodePath: process.execPath,
      pluginWorkerPath: null,
      pluginLoaderPath: null,
      providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS,
    },
  });
  apps.push(app);
  return app;
}

describe('remote access configuration', () => {
  it('refuses accidental non-loopback binding and weak or insecure remote setup', () => {
    expect(() => loadConfig({ NEOTA_HOST: '0.0.0.0' })).toThrow('NEOTA_REMOTE_ACCESS=true');
    expect(() =>
      loadConfig({
        NEOTA_HOST: '0.0.0.0',
        NEOTA_REMOTE_ACCESS: 'true',
        NEOTA_REMOTE_TOKEN: 'short',
        NEOTA_PUBLIC_ORIGIN: 'https://neotavern.test',
        NEOTA_CORS_ORIGIN: 'https://neotavern.test',
      }),
    ).toThrow('at least 32 characters');
    expect(() =>
      loadConfig({
        NEOTA_HOST: '0.0.0.0',
        NEOTA_REMOTE_ACCESS: 'true',
        NEOTA_REMOTE_TOKEN: TOKEN,
        NEOTA_PUBLIC_ORIGIN: ORIGIN,
        NEOTA_CORS_ORIGIN: ORIGIN,
      }),
    ).toThrow('requires an HTTPS');
  });

  it('stores only the bootstrap token hash in runtime config', () => {
    const config = loadConfig({
      NEOTA_HOST: '0.0.0.0',
      NEOTA_REMOTE_ACCESS: 'true',
      NEOTA_REMOTE_TOKEN: TOKEN,
      NEOTA_PUBLIC_ORIGIN: 'https://neotavern.test',
      NEOTA_CORS_ORIGIN: 'https://neotavern.test',
    });
    expect(config.remoteTokenHash).toBe(createHash('sha256').update(TOKEN).digest('hex'));
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(config.secureSessionCookies).toBe(true);
  });
});

describe('remote session authentication', () => {
  it('requires auth, trusted Origin and CSRF while allowing explicit bearer clients', async () => {
    const app = await remoteApp();

    const health = await app.inject({ method: 'GET', url: '/api/v2/health' });
    expect(health.statusCode).toBe(200);
    const anonymous = await app.inject({ method: 'GET', url: '/api/v2/characters' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({
      code: 'UNAUTHORIZED',
      params: { reason: 'AUTHENTICATION_REQUIRED' },
    });

    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/session',
      payload: { token: TOKEN },
    });
    expect(noOrigin.statusCode).toBe(403);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/session',
      headers: { origin: ORIGIN },
      payload: { token: 'incorrect-token' },
    });
    expect(invalid.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/session',
      headers: { origin: ORIGIN },
      payload: { token: TOKEN },
    });
    expect(login.statusCode, login.payload).toBe(200);
    expect(login.json()).toMatchObject({ required: true, authenticated: true });
    expect(login.json().csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    const setCookie = login.headers['set-cookie'];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Secure');
    const cookie = String(setCookie).split(';', 1)[0] as string;

    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/v2/characters',
      headers: { cookie },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.headers['cache-control']).toBe('no-store');

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      headers: { cookie, origin: ORIGIN },
      payload: { name: 'Blocked mutation' },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({
      code: 'FORBIDDEN',
      params: { reason: 'CSRF_TOKEN_INVALID' },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      headers: {
        cookie,
        origin: ORIGIN,
        'x-csrf-token': login.json().csrfToken as string,
      },
      payload: { name: 'Authenticated mutation' },
    });
    expect(created.statusCode, created.payload).toBe(200);

    const bearer = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name: 'CLI mutation' },
    });
    expect(bearer.statusCode, bearer.payload).toBe(200);

    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/v2/auth/session',
      headers: {
        cookie,
        origin: ORIGIN,
        'x-csrf-token': login.json().csrfToken as string,
      },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['clear-site-data']).toContain('cookies');
    const expired = await app.inject({
      method: 'GET',
      url: '/api/v2/characters',
      headers: { cookie },
    });
    expect(expired.statusCode).toBe(401);
  });

  it('rate-limits repeated invalid bootstrap tokens', async () => {
    const app = await remoteApp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/session',
        headers: { origin: ORIGIN },
        payload: { token: `wrong-${attempt}` },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/session',
      headers: { origin: ORIGIN },
      payload: { token: TOKEN },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
  });

  it('uses a Secure __Host cookie for an HTTPS public origin', async () => {
    const origin = 'https://neotavern.test';
    const app = await remoteApp({ origin, secure: true });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/session',
      headers: { origin },
      payload: { token: TOKEN },
    });
    expect(login.statusCode, login.payload).toBe(200);
    expect(login.headers['set-cookie']).toContain('__Host-neotavern_session=');
    expect(login.headers['set-cookie']).toContain('Secure');
    expect(login.headers['set-cookie']).not.toContain('Domain=');
  });

  it('allows equivalent loopback origins (localhost vs 127.0.0.1)', async () => {
    const app = await remoteApp({ origin: 'http://127.0.0.1:5173' });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/session',
      headers: { origin: 'http://localhost:5173' },
      payload: { token: TOKEN },
    });
    expect(login.statusCode, login.payload).toBe(200);
  });
});
