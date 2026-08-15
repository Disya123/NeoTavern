/**
 * ProfilesPanel tests (Этап 4 slice 5 remainder, M5): Configuration profiles
 * UI over the NeoBackend facade. The backend is mocked so no Tauri/HTTP
 * transport runs; every assertion exercises the panel's TanStack Query +
 * mutation wiring (server state belongs in the query layer, AGENTS.md §13).
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileDto, ProfileExportResultDto } from '@neotavern/contracts';
import { renderWithProviders } from '../../test/helpers.js';
import { ProfilesPanel } from './ProfilesPanel.js';

const PROFILE_A: ProfileDto = {
  id: 'aaaaaaa4-4444-4444-8444-444444444444',
  name: 'Main',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const PROFILE_B: ProfileDto = {
  id: 'bbbbbbb4-4444-4444-8444-444444444444',
  name: 'Friends',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
};

const EXPORT_RESULT: ProfileExportResultDto = {
  containerPath: 'exports/profile-aaaaaaa4-4444-4444-8444-444444444444.ndjson.zip',
  formatVersion: 1,
  createdAt: '2026-03-01T00:00:00.000Z',
  records: { characters: 2, chats: 3, messages: 5, lorebooks: 1, presets: 1 },
  assets: 1,
  sizeBytes: 2048,
  manifestSha256: 'f'.repeat(64),
  profileId: PROFILE_A.id,
};

vi.mock('../api/backend.js', () => ({
  backend: {
    profiles: {
      list: vi.fn(async () => ({ items: [PROFILE_A, PROFILE_B] })),
      create: vi.fn(async (req: { name: string }) => ({
        profile: { ...PROFILE_B, name: req.name },
      })),
      rename: vi.fn(async (req: { id: string; name: string }) => ({
        ...PROFILE_A,
        id: req.id,
        name: req.name,
      })),
      del: vi.fn(async () => ({})),
      export: vi.fn(async () => EXPORT_RESULT),
    },
  },
}));

import { backend } from '../api/backend.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProfilesPanel', () => {
  it('lists profiles and renders the export action', async () => {
    await renderWithProviders(<ProfilesPanel />);

    await waitFor(() => expect(screen.getByText('Main')).toBeTruthy());
    expect(screen.getByText('Friends')).toBeTruthy();
    const exportButtons = screen.getAllByRole('button', { name: 'Export' });
    expect(exportButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('creates a profile through the facade', async () => {
    await renderWithProviders(<ProfilesPanel />);

    const input = (await screen.findByLabelText('New profile name')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Book club' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(backend.profiles.create).toHaveBeenCalledWith({ name: 'Book club' }),
    );
  });

  it('exports a scoped container through the facade', async () => {
    await renderWithProviders(<ProfilesPanel />);

    const exportButtons = await screen.findAllByRole('button', { name: 'Export' });
    fireEvent.click(exportButtons[0]!);

    await waitFor(() =>
      expect(backend.profiles.export).toHaveBeenCalledWith({ profileId: PROFILE_A.id }),
    );
    await waitFor(() => {
      expect(screen.getByText('Exported "Main": 2 characters, 3 chats, 5 messages.')).toBeTruthy();
    });
  });

  it('deletes a profile after confirmation', async () => {
    await renderWithProviders(<ProfilesPanel />);

    const deleteButtons = await screen.findAllByRole('button', { name: 'Delete' });
    fireEvent.click(deleteButtons[0]!);

    await waitFor(() => expect(screen.getByText('Delete profile?')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(backend.profiles.del).toHaveBeenCalledWith(PROFILE_A.id));
  });
});
