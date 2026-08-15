/**
 * Backend wiring tests: the desktop shell gets LocalBackend over Tauri IPC,
 * a plain browser gets LegacyBackend; unmigrated legacy routes fail with a
 * typed UnsupportedError in local kernel mode (ТЗ §15).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH } from '@neotavern/contracts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('backend routing', () => {
  it('uses LocalBackend inside the Tauri desktop runtime', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.resetModules();
    const [{ LocalBackend, UnsupportedError }, { backend, legacyRaw }] = await Promise.all([
      import('@neotavern/neobackend'),
      import('./backend.js'),
    ]);
    expect(backend).toBeInstanceOf(LocalBackend);
    // Unmigrated legacy routes degrade with a controlled error in kernel mode.
    expect(() => legacyRaw().request('GET', '/characters')).toThrow(UnsupportedError);
    expect(() => legacyRaw().sseUrl('/events')).toThrow(UnsupportedError);
  });

  it('keeps LegacyBackend in a plain browser', async () => {
    vi.resetModules();
    const [{ LocalBackend }, { backend, legacyRaw }] = await Promise.all([
      import('@neotavern/neobackend'),
      import('./backend.js'),
    ]);
    expect(backend).not.toBeInstanceOf(LocalBackend);
    // The legacy passthrough is backed by the HTTP transport (no throw here
    // would require a fetch; the getter itself is reachable).
    expect(typeof legacyRaw().request).toBe('function');
  });

  it('normalizes /api/v2 paths through the same-origin transport (no double prefix)', async () => {
    vi.resetModules();
    const requested: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      requested.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'm1', chatId: 'c1', role: 'assistant', content: 'x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const [{ backend }] = await Promise.all([import('./backend.js')]);
    // `LegacyBackend` passes `/api/v2/...` paths; the transport strips the
    // prefix before `client.ts` prepends its own BASE (regression guard for
    // the `/api/v2/api/v2/...` 404 that broke message edits in browser mode).
    await backend.chats.updateMessage({ chatId: 'c1', messageId: 'm1', content: 'x' });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(/\/api\/v2\/chats\/c1\/messages\/m1$/u);
    expect(requested[0]).not.toMatch(/\/api\/v2\/api\/v2/u);
  });

  it('routes a mobile-shell local profile to LocalBackend over the WebView bridge', async () => {
    vi.stubGlobal('__neotavernMobile', {
      handshake: () =>
        JSON.stringify({
          ffiAbiVersion: 1,
          schemaHash: WIRE_SCHEMA_HASH,
          wireProtocol: { major: WIRE_PROTOCOL.major, minor: WIRE_PROTOCOL.minor },
          appVersion: '0.1.0',
        }),
      call: () => undefined,
      cancelStream: () => undefined,
    });
    vi.resetModules();
    const [{ LocalBackend }, { createBackendForProfile }] = await Promise.all([
      import('@neotavern/neobackend'),
      import('./backend.js'),
    ]);
    const mobileBackend = createBackendForProfile({
      id: 'mobile',
      kind: 'local',
      label: 'Mobile',
    });
    expect(mobileBackend).toBeInstanceOf(LocalBackend);
  });
});
