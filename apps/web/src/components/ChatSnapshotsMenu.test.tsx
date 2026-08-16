/**
 * ChatSnapshotsMenu (header snapshot listing, М5 slice 46) component tests.
 *
 * The snapshot list is a kernel-plane capability over Product Wire
 * `chats.snapshots.list`; on the legacy plane the honest state is "not
 * available", so the trigger must not render (ARC-02). The component under
 * test is rendered with the real QueryClient/router/i18n provider stack.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/helpers.js';
import { ChatSnapshotsMenu } from './ChatSnapshotsMenu.js';

const mocks = vi.hoisted(() => ({
  isKernelMode: vi.fn(() => true),
  listChatSnapshots: vi.fn(),
}));

vi.mock('../api/backend.js', () => ({
  isKernelMode: mocks.isKernelMode,
}));

vi.mock('../api/wireBridge.js', () => ({
  listChatSnapshots: mocks.listChatSnapshots,
}));

const CHAT_ID = '01234567-89ab-4cde-8f01-23456789abcd';
const CHECKPOINT_ID = 'c2d3e4f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const BRANCH_ID = 'd2d3e4f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

const SNAPSHOTS = [
  {
    id: CHECKPOINT_ID,
    title: 'Chat — checkpoint',
    characterId: '4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a',
    messageCount: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    parentChatId: CHAT_ID,
    origin: 'checkpoint' as const,
    sourceMessageId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  },
  {
    id: BRANCH_ID,
    title: 'Chat — branch',
    characterId: '4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a',
    messageCount: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    parentChatId: CHAT_ID,
    origin: 'branch' as const,
    sourceMessageId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatSnapshotsMenu', () => {
  it('lists the child chats of the active chat and opens one on click', async () => {
    mocks.listChatSnapshots.mockResolvedValue({ items: SNAPSHOTS, nextCursor: null });
    const { container } = await renderWithProviders(<ChatSnapshotsMenu chatId={CHAT_ID} />, {
      initialEntries: [`/chats/${CHAT_ID}`],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Snapshots' }));
    await waitFor(() => {
      expect(mocks.listChatSnapshots).toHaveBeenCalledWith(CHAT_ID);
    });
    const panel = within(container).getByRole('menu');
    await within(panel).findByText('Chat — checkpoint');
    expect(within(panel).getByText('Chat — branch')).toBeTruthy();
    expect(within(panel).getByText('Checkpoint')).toBeTruthy();
    expect(within(panel).getByText('Branch')).toBeTruthy();
    expect(within(panel).getByText('2 messages')).toBeTruthy();
    expect(within(panel).getByText('1 message')).toBeTruthy();
  });

  it('shows the honest empty state when the chat has no snapshots', async () => {
    mocks.listChatSnapshots.mockResolvedValue({ items: [], nextCursor: null });
    await renderWithProviders(<ChatSnapshotsMenu chatId={CHAT_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Snapshots' }));
    await waitFor(() => {
      expect(screen.getByText(/No snapshots yet/)).toBeTruthy();
    });
  });

  it('navigates into a snapshot chat when its row is clicked', async () => {
    mocks.listChatSnapshots.mockResolvedValue({ items: SNAPSHOTS, nextCursor: null });
    const { container } = await renderWithProviders(<ChatSnapshotsMenu chatId={CHAT_ID} />, {
      initialEntries: [`/chats/${CHAT_ID}`],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Snapshots' }));
    const panel = await screen.findByRole('menu');
    await waitFor(() => {
      expect(within(panel).getByText('Chat — checkpoint')).toBeTruthy();
    });
    const row = within(panel).getByText('Chat — checkpoint').closest('button');
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLButtonElement);

    await waitFor(() => {
      expect(within(container).queryByRole('menu')).toBeNull();
    });
  });

  it('hides the trigger entirely on the legacy plane (honest CAPABILITY_UNAVAILABLE)', async () => {
    mocks.isKernelMode.mockReturnValue(false);
    const { container } = await renderWithProviders(<ChatSnapshotsMenu chatId={CHAT_ID} />);
    expect(screen.queryByRole('button', { name: 'Snapshots' })).toBeNull();
    expect(container.querySelector('[data-component="chat-snapshots-menu"]')).toBeNull();
    expect(mocks.listChatSnapshots).not.toHaveBeenCalled();
  });
});
