/**
 * SecretsPanel tests (SEC-01.1, Этап 4 slice 7 remainder + M5 slice 40): the
 * panel renders the honest value-free store mode from the NeoBackend facade
 * (secrets.status) and the manual lock (secrets.lock) only for an available
 * portable store. The backend is mocked so no kernel transport runs; the
 * tests prove the four SEC-01.1 mode framings, that no reveal operation
 * exists, and that locking flips the panel to the honest locked state.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretsStatusResultDto } from '@neotavern/contracts';
import { renderWithProviders } from '../../test/helpers.js';
import { SecretsPanel } from './SecretsPanel.js';

const PORTABLE_STATUS: SecretsStatusResultDto = {
  kind: 'portable',
  persistent: true,
  writable: true,
  available: true,
  recordCount: 3,
  formatVersion: 2,
};

const LOCKED_PORTABLE_STATUS: SecretsStatusResultDto = {
  kind: 'portable',
  persistent: true,
  writable: true,
  available: false,
  recordCount: 0,
  formatVersion: 2,
};

const UNAVAILABLE_STATUS: SecretsStatusResultDto = {
  kind: 'unavailable',
  persistent: false,
  writable: false,
  available: false,
  recordCount: 0,
};

vi.mock('../api/backend.js', () => ({
  backend: {
    secrets: {
      status: vi.fn(async () => PORTABLE_STATUS),
      lock: vi.fn(async () => ({ locked: true })),
    },
  },
}));

import { backend } from '../api/backend.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SecretsPanel', () => {
  it('renders the portable encrypted mode with flags and the lock action', async () => {
    await renderWithProviders(<SecretsPanel />);

    await waitFor(() => expect(screen.getByText('Portable encrypted')).toBeTruthy());
    expect(screen.getByText('Persistent')).toBeTruthy();
    expect(screen.getByText('Writable')).toBeTruthy();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getAllByText('Yes').length).toBe(3);
    expect(
      screen.getByText(
        'There is no reveal operation: values never leave the store, so there is nothing to display here.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lock now' })).toBeTruthy();
  });

  it('lock invokes secrets.lock and the panel flips to the honest locked state', async () => {
    vi.mocked(backend.secrets.status)
      .mockResolvedValueOnce(PORTABLE_STATUS)
      .mockResolvedValueOnce(LOCKED_PORTABLE_STATUS);
    await renderWithProviders(<SecretsPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Lock now' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Lock now' }));
    await waitFor(() => expect(backend.secrets.lock).toHaveBeenCalledOnce());

    // After the invalidation the status query re-runs and reports the locked
    // store: the button disappears and the locked hint appears.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Lock now' })).toBeNull());
    expect(screen.getByText(/The store is locked: derived key material was dropped/)).toBeTruthy();
  });

  it('does not offer lock when the store is already locked', async () => {
    vi.mocked(backend.secrets.status).mockResolvedValueOnce(LOCKED_PORTABLE_STATUS);
    await renderWithProviders(<SecretsPanel />);

    await waitFor(() => expect(screen.getByText('Portable encrypted')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Lock now' })).toBeNull();
    expect(screen.getByText(/The store is locked: derived key material was dropped/)).toBeTruthy();
  });

  it('renders the fail-closed unavailable state', async () => {
    vi.mocked(backend.secrets.status).mockResolvedValueOnce(UNAVAILABLE_STATUS);
    await renderWithProviders(<SecretsPanel />);

    await waitFor(() => expect(screen.getByText('Secret storage unavailable')).toBeTruthy());
    expect(screen.getAllByText('No').length).toBe(3);
    expect(screen.queryByRole('button', { name: 'Lock now' })).toBeNull();
  });
});
