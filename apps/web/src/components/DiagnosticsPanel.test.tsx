/**
 * DiagnosticsPanel local-kernel section tests (Phase 3 slice): inside the
 * Tauri desktop shell the panel renders kernel metadata via the NeoBackend
 * facade (React → LocalBackend → Tauri IPC → Runtime Kernel); in a plain
 * browser the section is absent (no kernel transport, ТЗ §60 availability).
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '../../test/helpers.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';

const KERNEL_META = {
  appVersion: '0.1.0',
  api: { major: 1, minor: 0 },
  productWire: { major: 1, minor: 0 },
  minimumClientVersion: undefined,
  features: { generation: 1, backups: 1 },
};

vi.mock('../api/backend.js', () => ({
  backend: {
    meta: vi.fn(async () => KERNEL_META),
    backups: {
      list: vi.fn(async () => ({ items: [{ id: 'b1' }, { id: 'b2' }] })),
    },
  },
}));

vi.mock('../lib/desktop.js', () => ({
  isDesktopShell: vi.fn(),
  checkCoreUpdate: vi.fn(async () => null),
  installCoreUpdate: vi.fn(async () => false),
}));

import { isDesktopShell } from '../lib/desktop.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DiagnosticsPanel kernel section', () => {
  it('renders kernel metadata inside the Tauri desktop shell', async () => {
    vi.mocked(isDesktopShell).mockReturnValue(true);
    // Legacy server diagnostics are unreachable in kernel mode; the panel
    // still renders with a typed error for that block.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND' } }, { status: 404 })),
    );

    await renderWithProviders(<DiagnosticsPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText('Local kernel')).toBeTruthy();
    });
    expect(screen.getByText('0.1.0')).toBeTruthy();
    expect(screen.getByText('1.0')).toBeTruthy();
    // Two features declared in the kernel meta.
    expect(screen.getByText('2 features')).toBeTruthy();
    // Two backups listed through the kernel backups.list operation.
    expect(screen.getByText('2 backups')).toBeTruthy();
  });

  it('hides the kernel section in a plain browser', async () => {
    vi.mocked(isDesktopShell).mockReturnValue(false);
    // Legacy diagnostics unreachable keeps the snapshot block empty too.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND' } }, { status: 404 })),
    );

    await renderWithProviders(<DiagnosticsPanel />);

    expect(screen.queryByLabelText('Local kernel')).toBeNull();
    expect(screen.queryByText('0.1.0')).toBeNull();
  });
});
