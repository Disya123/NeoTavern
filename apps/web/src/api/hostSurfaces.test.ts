/**
 * The host-surface boundary must stay declarative and fail-closed.
 *
 * Two properties are asserted, both of which can silently regress:
 * 1. the registry is complete and self-describing — every entry names its route,
 *    says why it is host-owned and what stage 6 must replace it with;
 * 2. every exported function refuses on the kernel plane with the registry id as
 *    the `UnsupportedError` code, so the UI can map the error back to one row
 *    (ARC-02: no silent legacy request from kernel mode).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isKernelMode: vi.fn(() => false) }));
vi.mock('./backend.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, isKernelMode: mocks.isKernelMode };
});

import { UnsupportedError } from '@neotavern/neobackend';
import {
  HOST_SURFACES,
  connectPluginAuth,
  enterPluginSafeMode,
  exitPluginSafeMode,
  hostSurface,
  hostSurfaceFetch,
  installPlugin,
  installPluginFromGit,
  readPluginAuthConnections,
  revokePluginAuth,
} from './hostSurfaces.js';

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

beforeEach(() => {
  // A fresh Response per call: a single instance cannot be body-read twice.
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
  vi.stubGlobal('fetch', fetchMock);
  mocks.isKernelMode.mockReturnValue(false);
});

describe('host surface registry', () => {
  it('declares every surface with a legacy route, a rationale and a removal plan', () => {
    expect(HOST_SURFACES.length).toBeGreaterThan(0);
    for (const surface of HOST_SURFACES) {
      expect(surface.route.startsWith('/plugins/')).toBe(true);
      expect(surface.kernelMode).toBe('unsupported');
      expect(surface.why.length).toBeGreaterThan(30);
      expect(surface.removal.length).toBeGreaterThan(20);
    }
  });

  it('has unique ids and a lookup that fails loudly on an unknown id', () => {
    const ids = HOST_SURFACES.map((surface) => surface.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(hostSurface('plugins.auth.connect').route).toBe('/plugins/:id/auth/connect');
    expect(() => hostSurface('plugins.nope' as never)).toThrow(/unknown host surface/u);
  });

  it('covers every exported host call (no function without a registry row)', () => {
    // The union of ids used by the functions below; a new export must add an id.
    expect(new Set(HOST_SURFACES.map((surface) => surface.id))).toEqual(
      new Set([
        'plugins.install.host-verify',
        'plugins.install.git.host-verify',
        'plugins.safe-mode.enter',
        'plugins.safe-mode.exit',
        'plugins.auth.connections',
        'plugins.auth.connect',
        'plugins.auth.revoke',
        'plugins.auth.sandbox-session',
        'plugins.auth.fetch-proxy',
      ]),
    );
  });
});

describe('host surfaces fail closed on the kernel plane', () => {
  beforeEach(() => {
    mocks.isKernelMode.mockReturnValue(true);
    fetchMock.mockClear();
  });

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['plugins.install.host-verify', () => installPlugin(new File(['x'], 'p.zip'))],
    [
      'plugins.install.git.host-verify',
      () => installPluginFromGit({ url: 'https://example.test/p' }),
    ],
    ['plugins.safe-mode.enter', () => enterPluginSafeMode()],
    ['plugins.safe-mode.exit', () => exitPluginSafeMode()],
    ['plugins.auth.connections', () => readPluginAuthConnections('author.p')],
    ['plugins.auth.connect', () => connectPluginAuth('author.p', { serviceId: 'idp' })],
    ['plugins.auth.revoke', () => revokePluginAuth('author.p', { connectionId: 'conn-1' })],
    [
      'plugins.auth.sandbox-session',
      () => hostSurfaceFetch('plugins.auth.sandbox-session', 'author.p', '/status'),
    ],
    [
      'plugins.auth.fetch-proxy',
      () =>
        hostSurfaceFetch('plugins.auth.fetch-proxy', 'author.p', '', {
          method: 'POST',
          body: '{}',
        }),
    ],
  ];

  for (const [id, call] of cases) {
    it(`${id} rejects with its own UnsupportedError code and no network call`, async () => {
      await expect(call()).rejects.toBeInstanceOf(UnsupportedError);
      // `UnsupportedError` carries a stable `code` plus the surface id in
      // `feature`, so the UI can map the failure back to one registry row.
      await expect(call()).rejects.toMatchObject({ code: 'UNSUPPORTED', feature: id });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

describe('host surfaces keep the legacy routes on the legacy plane', () => {
  it('install posts the package', async () => {
    await installPlugin(new File(['x'], 'p.zip'));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method?: string }];
    expect(url).toBe('/api/v2/plugins/install');
    expect(init.method).toBe('POST');
  });

  it('git install posts the repository reference', async () => {
    await installPluginFromGit({ url: 'https://example.test/p' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/plugins/install-git');
  });

  it('safe mode uses POST to enter and DELETE to leave', async () => {
    await enterPluginSafeMode();
    await exitPluginSafeMode();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/plugins/runtime/safe-mode');
    expect((fetchMock.mock.calls[0]?.[1] as { method?: string }).method).toBe('POST');
    expect((fetchMock.mock.calls[1]?.[1] as { method?: string }).method).toBe('DELETE');
  });

  it('auth connections encode the plugin id', async () => {
    await readPluginAuthConnections('author.p');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/plugins/author.p/auth/connections');
  });

  it('connect and revoke post to the per-plugin routes', async () => {
    await connectPluginAuth('author.p', { serviceId: 'idp' });
    await revokePluginAuth('author.p', { connectionId: 'conn-1' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/plugins/author.p/auth/connect');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/v2/plugins/author.p/auth/revoke');
  });
});

describe('sandbox host adapter keeps the declared routes on the legacy plane', () => {
  it('sandbox auth metadata resolves under /api/v2/plugins/:id/auth', async () => {
    await hostSurfaceFetch('plugins.auth.sandbox-session', 'author.p', '/connections');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v2/plugins/author.p/auth/connections');
  });

  it('the authenticated fetch proxy posts json only when a body exists', async () => {
    await hostSurfaceFetch('plugins.auth.fetch-proxy', 'author.p', '', {
      method: 'POST',
      body: '{"url":"https://example.test"}',
    });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string>; body?: string },
    ];
    expect(url).toBe('/api/v2/plugins/author.p/auth/fetch');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toBe('{"url":"https://example.test"}');

    fetchMock.mockClear();
    await hostSurfaceFetch('plugins.auth.fetch-proxy', 'author.p', '', { method: 'POST' });
    const [, plain] = fetchMock.mock.calls[0] as [string, { headers?: unknown }];
    expect(plain.headers).toBeUndefined();
  });
});
