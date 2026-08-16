/**
 * Profile store + backend resolver tests (ТЗ §7.2 Phase 5): profile
 * registration/selection, shell-appropriate transport for local profiles,
 * remote Product Wire HTTP, and the unchanged default backend path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend, RemoteBackend, UnsupportedError } from '@neotavern/neobackend';
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH } from '@neotavern/contracts';
import { MobileBridgeTransport } from './mobileTransport.js';
import { TauriTransport } from './tauriTransport.js';
import { resolveBackend, useProfileStore } from './profiles.js';

const localProfile = { id: 'mobile', kind: 'local', label: 'Local' } as const;

function fakeBridge(): unknown {
  return {
    handshake: () =>
      JSON.stringify({
        ffiAbiVersion: 1,
        schemaHash: WIRE_SCHEMA_HASH,
        wireProtocol: { major: WIRE_PROTOCOL.major, minor: WIRE_PROTOCOL.minor },
        appVersion: '0.1.0',
      }),
    call: () => undefined,
    cancelStream: () => undefined,
  };
}

beforeEach(() => {
  useProfileStore.setState({ profiles: [], activeProfileId: '' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('profile store', () => {
  it('registers profiles and switches the active profile', () => {
    useProfileStore.getState().registerProfile({ ...localProfile, id: 'local-1' });
    useProfileStore.getState().registerProfile({
      id: 'remote-1',
      kind: 'remote',
      label: 'Remote',
      remoteUrl: 'https://example.com',
    });
    expect(useProfileStore.getState().profiles).toHaveLength(2);

    useProfileStore.getState().setActiveProfile('remote-1');
    expect(useProfileStore.getState().activeProfileId).toBe('remote-1');
  });

  it('re-registering a profile id replaces the entry instead of duplicating', () => {
    useProfileStore.getState().registerProfile({ ...localProfile, id: 'local-1' });
    useProfileStore.getState().registerProfile({
      ...localProfile,
      id: 'local-1',
      label: 'Local (updated)',
    });
    const { profiles } = useProfileStore.getState();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.label).toBe('Local (updated)');
  });
});

describe('resolveBackend', () => {
  it('resolves a local profile to LocalBackend over the mobile bridge in the mobile shell', async () => {
    vi.stubGlobal('__neotavernMobile', fakeBridge());
    const callSpy = vi.spyOn(MobileBridgeTransport.prototype, 'call');

    const { backend } = resolveBackend({ ...localProfile, id: 'mobile-local' });
    expect(backend).toBeInstanceOf(LocalBackend);

    void backend.meta().catch(() => undefined);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(callSpy).toHaveBeenCalledWith('meta.get', {}, { signal: undefined });
  });

  it('resolves a local profile to LocalBackend over Tauri IPC in the tauri shell', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const callSpy = vi.spyOn(TauriTransport.prototype, 'call');

    const { backend } = resolveBackend({ ...localProfile, id: 'desktop-local' });
    expect(backend).toBeInstanceOf(LocalBackend);

    void backend.meta().catch(() => undefined);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(callSpy).toHaveBeenCalledWith('meta.get', {}, { signal: undefined });
  });

  it('resolves a remote profile to RemoteBackend over the product-wire HTTP transport', () => {
    const { backend } = resolveBackend({
      id: 'remote-1',
      kind: 'remote',
      label: 'Remote',
      remoteUrl: 'https://example.com',
    });
    expect(backend).toBeInstanceOf(RemoteBackend);
  });

  it('throws UnsupportedError when a remote profile has no URL', () => {
    let caught: unknown;
    try {
      resolveBackend({
        id: 'remote-1',
        kind: 'remote',
        label: 'Remote',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedError);
    if (caught instanceof UnsupportedError) {
      expect(caught.feature).toBe('profile.remote.url');
    }
  });
});

describe('default backend', () => {
  it('keeps the default createBackend on LegacyBackend in a plain browser', async () => {
    vi.resetModules();
    const [{ LocalBackend: LocalBackendClass }, { backend }] = await Promise.all([
      import('@neotavern/neobackend'),
      import('./backend.js'),
    ]);
    // The exported singleton IS the default createBackend() result; in a
    // plain browser it must stay on LegacyBackend, untouched by profiles.
    expect(backend).not.toBeInstanceOf(LocalBackendClass);
  });
});
