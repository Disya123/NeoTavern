/**
 * Extension runtime availability (ТЗ §60/§61/§92): the Node plugin runtime is
 * unavailable in desktop kernel mode (`isTauriRuntime`); the web host always
 * renders themes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExtensionAvailability, useExtensionAvailability } from '../src/plugins/availability.js';
import { renderWithProviders } from './helpers.js';

vi.mock('../src/api/tauriTransport.js', () => ({
  isTauriRuntime: vi.fn(),
}));

import { isTauriRuntime } from '../src/api/tauriTransport.js';

const mockedTauri = vi.mocked(isTauriRuntime);

afterEach(() => {
  mockedTauri.mockReset();
});

describe('getExtensionAvailability', () => {
  it('reports themes and nodeRuntime available in a plain browser', () => {
    mockedTauri.mockReturnValue(false);
    expect(getExtensionAvailability()).toEqual({
      themes: 'available',
      nodeRuntime: 'available',
    });
  });

  it('reports nodeRuntime unavailable in desktop kernel mode with a reason', () => {
    mockedTauri.mockReturnValue(true);
    expect(getExtensionAvailability()).toEqual({
      themes: 'available',
      nodeRuntime: 'unavailable',
      reason: 'node-runtime-desktop-kernel-mode',
    });
  });
});

describe('useExtensionAvailability', () => {
  it('mirrors the pure probe (isTauriRuntime -> nodeRuntime unavailable)', async () => {
    mockedTauri.mockReturnValue(true);
    let captured: ReturnType<typeof getExtensionAvailability> | null = null;
    function Probe() {
      captured = useExtensionAvailability();
      return null;
    }
    await renderWithProviders(<Probe />);
    expect(captured?.nodeRuntime).toBe('unavailable');
    expect(captured?.themes).toBe('available');
  });
});
