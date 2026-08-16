/**
 * ActivationStatusPanel tests (ТЗ §10.2–§10.3, М5 slice 38): the Settings
 * Data-tab section renders the honest data-root activation state — layout
 * version, active root, the durable journal and the pending warning — and
 * surfaces errors without fabricating data. `useDataActivationStatus` is
 * mocked so no wire transport runs.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataActivationStatusResultDto } from '@neotavern/contracts';
import { renderWithProviders } from '../../test/helpers.js';
import { ActivationStatusPanel } from './ActivationStatusPanel.js';

const STATUS: DataActivationStatusResultDto = {
  layoutVersion: 2,
  activeRootId: 'a1b2c3d4',
  activeRoot: '/data/neotavern/roots/root-a1b2c3d4',
  journalFormat: 'neotavern-activation-journal',
  journalFormatVersion: 2,
  entries: [
    {
      id: '1f2e3d4c-5b6a-4a98-8765-4321fedcba98',
      kind: 'restore',
      status: 'committed',
      fromRoot: '/data/neotavern/roots/root-old',
      toRoot: '/data/neotavern/roots/root-a1b2c3d4',
      createdAt: '2026-08-13T10:00:00Z',
      updatedAt: '2026-08-13T10:00:00Z',
    },
  ],
};

const mockUseDataActivationStatus = vi.hoisted(() => vi.fn());
vi.mock('../api/hooks.js', () => ({
  useDataActivationStatus: mockUseDataActivationStatus,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ActivationStatusPanel', () => {
  it('renders the layout, active root and journal entries', async () => {
    mockUseDataActivationStatus.mockReturnValue({
      data: STATUS,
      isError: false,
      isSuccess: true,
      error: null,
    });
    await renderWithProviders(<ActivationStatusPanel />);
    await waitFor(() => expect(screen.getByText('Data root activation')).toBeTruthy());
    expect(screen.getByText('v2 versioned roots')).toBeTruthy();
    expect(screen.getByText('a1b2c3d4')).toBeTruthy();
    expect(screen.getByText('/data/neotavern/roots/root-a1b2c3d4')).toBeTruthy();
    expect(screen.getByText('restore')).toBeTruthy();
    expect(screen.getByText('committed')).toBeTruthy();
    expect(
      screen.getByText(
        (content) => content.includes('root-old') && content.includes('root-a1b2c3d4'),
      ),
    ).toBeTruthy();
    // No pending warning.
    expect(screen.queryByText(/Activation pending/)).toBeNull();
  });

  it('shows the pending warning when an activation is pending', async () => {
    mockUseDataActivationStatus.mockReturnValue({
      data: {
        ...STATUS,
        pending: {
          kind: 'restore',
          entryId: '1f2e3d4c-5b6a-4a98-8765-4321fedcba98',
          createdAt: '2026-08-13T10:00:00Z',
        },
      },
      isError: false,
      isSuccess: true,
      error: null,
    });
    await renderWithProviders(<ActivationStatusPanel />);
    await waitFor(() => expect(screen.getByText(/Activation pending/)).toBeTruthy());
  });

  it('shows the honest empty state when no activation journal exists', async () => {
    mockUseDataActivationStatus.mockReturnValue({
      data: null,
      isError: false,
      isSuccess: false,
      error: null,
    });
    await renderWithProviders(<ActivationStatusPanel />);
    await waitFor(() =>
      expect(
        screen.getByText('The activation journal is not available on this plane.'),
      ).toBeTruthy(),
    );
  });

  it('surfaces a read error without fabricating data', async () => {
    mockUseDataActivationStatus.mockReturnValue({
      data: undefined,
      isError: true,
      isSuccess: false,
      error: new Error('boom'),
    });
    await renderWithProviders(<ActivationStatusPanel />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
