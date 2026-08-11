/**
 * Integration tests for the plugin OAuth connection API (rev4 §K5):
 * PKCE connect flow, one-shot state callback, server-side token storage,
 * the authenticated fetch proxy and revocation.
 *
 * The IdP token endpoint is mocked at the global fetch level: the manifest
 * only accepts https endpoints, so no real HTTP server is involved. The
 * proxy route's outgoing request is intercepted the same way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TypedApp } from '../src/types.js';
import { createTestApp } from './helpers.js';
import type { AppDatabase } from '@neotavern/db';

const PLUGIN_ID = 'test.auth-flow';

const TOKEN_RESPONSE = {
  access_token: 'at-secret-value',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt-secret-value',
};

function manifestWithAuthClient() {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_ID,
    version: '1.0.0',
    apiVersion: 2,
    authClients: [
      {
        serviceId: 'com.example.api',
        name: 'Example API',
        authorizationUrl: 'https://accounts.example.com/authorize',
        tokenUrl: 'https://accounts.example.com/token',
        clientId: 'neotavern-test-client',
        scopes: ['profile', 'read'],
      },
    ],
  };
}

let app: TypedApp;
let database: AppDatabase;

beforeEach(async () => {
  ({ app, database } = await createTestApp());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function installPlugin(
  extraCapabilities: readonly string[] = ['auth.connections'],
): Promise<void> {
  database.repos.plugins.install({
    id: PLUGIN_ID,
    name: PLUGIN_ID,
    version: '1.0.0',
    manifest: manifestWithAuthClient(),
    requestedPermissions: [...extraCapabilities],
  });
  database.repos.plugins.grantAndEnable(PLUGIN_ID, [...extraCapabilities]);
  // Issue runtime grants the way the host consent UI does (rev4 §B2).
  for (const name of extraCapabilities) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name },
    });
    expect(response.statusCode).toBe(200);
  }
}

interface TokenExchangeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function mockTokenEndpoint(fn?: (call: TokenExchangeCall) => Response | Promise<Response>) {
  const calls: TokenExchangeCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const call: TokenExchangeCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === 'string' ? init.body : '',
      };
      calls.push(call);
      if (fn) return fn(call);
      if (call.url.startsWith('https://accounts.example.com/token')) {
        return new Response(JSON.stringify(TOKEN_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return calls;
}

async function startFlow(): Promise<{ connectionId: string; authorizationUrl: string }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v2/plugins/${PLUGIN_ID}/auth/connect`,
    payload: { serviceId: 'com.example.api' },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    connectionId: string;
    status: string;
    authorizationUrl: string;
  };
  expect(body.status).toBe('pending');
  expect(body.authorizationUrl).toMatch(/^https:\/\/accounts\.example\.com\/authorize\?/);
  return { connectionId: body.connectionId, authorizationUrl: body.authorizationUrl };
}

async function finishFlow(state: string, code = 'auth-code-1') {
  return app.inject({
    method: 'GET',
    url: `/api/v2/plugins/${PLUGIN_ID}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
  });
}

describe('plugin OAuth connections (rev4 §K5)', () => {
  it('connect creates a pending connection with a PKCE challenge and no token', async () => {
    await installPlugin();
    const { authorizationUrl } = await startFlow();

    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('neotavern-test-client');
    expect(url.searchParams.get('redirect_uri')).toContain(
      `/api/v2/plugins/${PLUGIN_ID}/auth/callback`,
    );
    expect(url.searchParams.get('scope')).toBe('profile read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
    const state = url.searchParams.get('state');
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/connections`,
    });
    const items = listed.json().items as Array<{ status: string; serviceId: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ serviceId: 'com.example.api', status: 'pending' });
  });

  it('callback exchanges the code with PKCE verifier and stores the token server-side', async () => {
    await installPlugin();
    const { authorizationUrl } = await startFlow();
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('state missing');
    const calls = mockTokenEndpoint();

    const response = await finishFlow(state);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('#/plugin-auth-result');
    expect(response.headers.location).toContain('status=connected');

    expect(calls).toHaveLength(1);
    const exchange = calls[0];
    expect(exchange.url).toBe('https://accounts.example.com/token');
    const params = new URLSearchParams(exchange.body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code-1');
    expect(params.get('client_id')).toBe('neotavern-test-client');
    expect(params.get('code_verifier')).toMatch(/^[0-9a-f]{64}$/);

    // Token is persisted, never exposed: list returns metadata only.
    const row = database.sqlite
      .prepare(
        `SELECT status, token_json FROM plugin_auth_connections
         WHERE plugin_id = ? AND service_id = ?`,
      )
      .get(PLUGIN_ID, 'com.example.api') as { status: string; token_json: string };
    expect(row.status).toBe('connected');
    expect(JSON.parse(row.token_json)).toMatchObject({ accessToken: 'at-secret-value' });

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/connections`,
    });
    const serialized = JSON.stringify(listed.json());
    expect(serialized).not.toContain('at-secret-value');
    expect(serialized).not.toContain('rt-secret-value');
  });

  it('a replayed callback fails: the state is one-shot', async () => {
    await installPlugin();
    const { authorizationUrl } = await startFlow();
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('state missing');
    mockTokenEndpoint();

    const first = await finishFlow(state);
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toContain('status=connected');

    const second = await finishFlow(state);
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toContain('status=error');
    expect(second.headers.location).toContain('reason=STATE_EXPIRED');
  });

  it('an unknown state is refused', async () => {
    await installPlugin();
    const response = await finishFlow('deadbeef', 'code-x');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('reason=STATE_EXPIRED');
  });

  it('connect is idempotent: an active connection is reused', async () => {
    await installPlugin();
    const first = await startFlow();
    const second = await startFlow();
    expect(second.connectionId).toBe(first.connectionId);
  });

  it('revoke deletes the token, flips status and rejects authenticated use', async () => {
    await installPlugin(['auth.connections', 'network:https://api.example.com']);
    const { authorizationUrl, connectionId } = await startFlow();
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('state missing');
    mockTokenEndpoint();
    await finishFlow(state);

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/revoke`,
      payload: { connectionId },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().ok).toBe(true);

    const row = database.sqlite
      .prepare(
        `SELECT status, token_json FROM plugin_auth_connections
         WHERE plugin_id = ? AND service_id = ?`,
      )
      .get(PLUGIN_ID, 'com.example.api') as { status: string; token_json: string | null };
    expect(row.status).toBe('revoked');
    expect(row.token_json).toBeNull();
  });

  it('the authenticated fetch proxy injects the stored token', async () => {
    await installPlugin(['auth.connections', 'network:https://api.example.com']);
    const { authorizationUrl, connectionId } = await startFlow();
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('state missing');
    const calls = mockTokenEndpoint();
    await finishFlow(state);

    const proxy = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/fetch`,
      payload: {
        url: 'https://api.example.com/me',
        connectionId,
        method: 'GET',
      },
    });
    expect(proxy.statusCode).toBe(200);
    expect(proxy.json()).toMatchObject({ status: 200 });

    // The outgoing request carried the Authorization header; the sandbox
    // never sees the token (the proxy response contains no such header).
    const outgoing = calls.find((call) => call.url === 'https://api.example.com/me');
    expect(outgoing?.headers['Authorization']).toBe('Bearer at-secret-value');
    expect(JSON.stringify(proxy.json())).not.toContain('at-secret-value');
  });

  it('an expired token flips the connection and fails authenticated use with AUTH_EXPIRED', async () => {
    await installPlugin(['auth.connections', 'network:https://api.example.com']);
    const { authorizationUrl, connectionId } = await startFlow();
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('state missing');
    mockTokenEndpoint();
    await finishFlow(state);

    // Backdate the stored token.
    database.sqlite
      .prepare('UPDATE plugin_auth_connections SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 100_000, connectionId);
    const token = JSON.parse(
      (
        database.sqlite
          .prepare('SELECT token_json FROM plugin_auth_connections WHERE id = ?')
          .get(connectionId) as { token_json: string }
      ).token_json,
    ) as { expiresAt: number };
    token.expiresAt = Date.now() - 1000;
    database.sqlite
      .prepare('UPDATE plugin_auth_connections SET token_json = ? WHERE id = ?')
      .run(JSON.stringify(token), connectionId);

    const proxy = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/fetch`,
      payload: { url: 'https://api.example.com/me', connectionId },
    });
    expect(proxy.statusCode).toBe(400);
    expect(proxy.json().params.reason).toBe('AUTH_EXPIRED');

    const row = database.sqlite
      .prepare('SELECT status FROM plugin_auth_connections WHERE id = ?')
      .get(connectionId) as { status: string };
    expect(row.status).toBe('expired');
  });

  it('refuses connect without the auth.connections grant (403)', async () => {
    installPlugin([]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/connect`,
      payload: { serviceId: 'com.example.api' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses all auth routes for disabled plugins (404)', async () => {
    await installPlugin();
    database.repos.plugins.disable(PLUGIN_ID);
    const connect = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/connect`,
      payload: { serviceId: 'com.example.api' },
    });
    expect(connect.statusCode).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/connections`,
    });
    expect(list.statusCode).toBe(404);
  });

  it('rejects an undeclared service id', async () => {
    await installPlugin();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/connect`,
      payload: { serviceId: 'com.other.api' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('the proxy refuses URLs outside the network allowlist', async () => {
    await installPlugin(['auth.connections', 'network:https://api.example.com']);
    const { authorizationUrl, connectionId } = await startFlow();
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('state missing');
    mockTokenEndpoint();
    await finishFlow(state);

    const proxy = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/auth/fetch`,
      payload: { url: 'https://blocked.example.com/x', connectionId },
    });
    expect(proxy.statusCode).toBe(403);
  });
});
