/**
 * Backend wiring tests: the desktop shell gets LocalBackend over Tauri IPC,
 * a plain browser gets LegacyBackend; unmigrated legacy routes fail with a
 * typed UnsupportedError in local kernel mode (ТЗ §15).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
