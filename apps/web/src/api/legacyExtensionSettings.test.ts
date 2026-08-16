/**
 * Tests for the extension-settings transport (slice 16): the legacy contour
 * reads/writes the legacy store; the kernel plane is an honest empty no-op —
 * never a legacy call from kernel mode (ARC-02).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadLegacyExtensionSettings,
  saveLegacyExtensionSettings,
} from './legacyExtensionSettings.js';

const mocks = vi.hoisted(() => ({
  isKernelMode: vi.fn(() => false),
  legacyRaw: vi.fn(),
}));
vi.mock('./backend.js', () => ({
  isKernelMode: mocks.isKernelMode,
  legacyRaw: mocks.legacyRaw,
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.isKernelMode.mockReturnValue(false);
});

describe('loadLegacyExtensionSettings', () => {
  it('reads the legacy store on the legacy contour', async () => {
    const items = { 'legacy.alpha': { enabled: true } };
    mocks.legacyRaw.mockReturnValue({
      request: vi.fn().mockResolvedValue({ items }),
    });
    await expect(loadLegacyExtensionSettings()).resolves.toEqual({ items });
    expect(mocks.legacyRaw).toHaveBeenCalledOnce();
    expect(mocks.legacyRaw.mock.results[0]?.value.request).toHaveBeenCalledWith(
      'GET',
      '/legacy/extension-settings',
    );
  });

  it('returns an empty map on the kernel plane without touching legacy', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    await expect(loadLegacyExtensionSettings()).resolves.toEqual({ items: {} });
    expect(mocks.legacyRaw).not.toHaveBeenCalled();
  });
});

describe('saveLegacyExtensionSettings', () => {
  it('PATCHes one namespace on the legacy contour', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    mocks.legacyRaw.mockReturnValue({ request });
    await saveLegacyExtensionSettings('legacy.beta', { theme: 'dark' });
    expect(request).toHaveBeenCalledWith('PATCH', '/legacy/extension-settings/legacy.beta', {
      settings: { theme: 'dark' },
    });
  });

  it('encodes the namespace', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    mocks.legacyRaw.mockReturnValue({ request });
    await saveLegacyExtensionSettings('legacy.a b', {});
    expect(request).toHaveBeenCalledWith('PATCH', '/legacy/extension-settings/legacy.a%20b', {
      settings: {},
    });
  });

  it('is a no-op on the kernel plane without touching legacy', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    await expect(saveLegacyExtensionSettings('legacy.gamma', { x: 1 })).resolves.toBeUndefined();
    expect(mocks.legacyRaw).not.toHaveBeenCalled();
  });
});
