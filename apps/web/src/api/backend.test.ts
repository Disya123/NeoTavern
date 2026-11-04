/**
 * Backend wiring tests: the desktop shell gets LocalBackend over Tauri IPC, a
 * saved remote session gets RemoteBackend, and a bare browser page gets a closed
 * backend whose every call is a typed UnsupportedError (ТЗ §15).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH } from '@neotavern/contracts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
});

describe('backend routing', () => {
  it('uses LocalBackend inside the Tauri desktop runtime', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.resetModules();
    const [{ LocalBackend }, { backend }] = await Promise.all([
      import('@neotavern/neobackend'),
      import('./backend.js'),
    ]);
    expect(backend).toBeInstanceOf(LocalBackend);
  });

  it('uses RemoteBackend in a browser with a saved remote host session', async () => {
    localStorage.setItem(
      'neotavern.hostSession',
      JSON.stringify({ kind: 'remote', url: 'http://127.0.0.1:18080' }),
    );
    vi.resetModules();
    const [{ RemoteBackend }, { backend, isKernelMode }] = await Promise.all([
      import('@neotavern/neobackend'),
      import('./backend.js'),
    ]);
    expect(backend).toBeInstanceOf(RemoteBackend);
    expect(isKernelMode()).toBe(true);
  });

  it('constructs a closed backend in a plain browser and rejects every call', async () => {
    vi.resetModules();
    const [{ LocalBackend, UnsupportedError }, { backend }] = await Promise.all([
      import('@neotavern/neobackend'),
      import('./backend.js'),
    ]);
    // The UI must render without a host; the failure is deferred to the call.
    expect(backend).not.toBeInstanceOf(LocalBackend);
    await expect(backend.chats.get('c1')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(backend.chats.get('c1')).rejects.toMatchObject({
      feature: expect.stringContaining('chats.get'),
    });
  });

  it('uses LocalBackend inside the Android mobile shell by default', async () => {
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
    const [{ LocalBackend }, { backend, isKernelMode }] = await Promise.all([
      import('@neotavern/neobackend'),
      import('./backend.js'),
    ]);
    expect(backend).toBeInstanceOf(LocalBackend);
    expect(isKernelMode()).toBe(true);
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

  it('treats a switched-in RemoteBackend as product-wire mode', async () => {
    vi.resetModules();
    const [{ RemoteBackend }, { createBackendForProfile, isKernelMode, setActiveBackend }] =
      await Promise.all([import('@neotavern/neobackend'), import('./backend.js')]);
    const remote = createBackendForProfile({
      id: 'remote',
      kind: 'remote',
      label: 'Headless',
      remoteUrl: 'http://127.0.0.1:8080',
    });
    expect(remote).toBeInstanceOf(RemoteBackend);
    setActiveBackend(remote);
    expect(isKernelMode()).toBe(true);
  });
});
