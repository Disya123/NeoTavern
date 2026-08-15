import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { Message, MessageContentRevision } from '@neotavern/contracts';
import { ErrorCodes } from '@neotavern/shared';
import { renderWithProviders } from '../../test/helpers.js';
import { ApiError } from '../api/client.js';
import { useMessageRevisions, useRestoreMessageRevision } from '../api/hooks.js';
import { MessageRevisionHistoryCard } from './MessageRevisionHistoryCard.js';

vi.mock('../api/hooks.js', () => ({
  useMessageRevisions: vi.fn(),
  useRestoreMessageRevision: vi.fn(),
}));

const message: Message = {
  id: 'message-1',
  chatId: 'chat-1',
  branchId: 'branch-1',
  parentId: null,
  role: 'assistant',
  content: 'Current content',
  name: 'Character',
  meta: {},
  createdAt: 1_000,
  updatedAt: 2_000,
  revision: 3,
  variantCount: 1,
  activeVariantPosition: 0,
  contentRevisionCount: 1,
  checkpointChatId: null,
};

const revision: MessageContentRevision = {
  id: 'revision-1',
  messageId: message.id,
  position: 0,
  content: 'Previous content',
  createdAt: 1_500,
};

const fetchNextPage = vi.fn();
const mutateAsync = vi.fn();

function mockHistory(items: MessageContentRevision[], hasNextPage = false): void {
  vi.mocked(useMessageRevisions).mockReturnValue({
    data: { pages: [{ items, nextCursor: hasNextPage ? 'next' : null }], pageParams: [undefined] },
    isPending: false,
    isError: false,
    error: null,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage,
  } as never);
  vi.mocked(useRestoreMessageRevision).mockReturnValue({
    mutateAsync,
    isPending: false,
    variables: undefined,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHistory([]);
});

afterEach(cleanup);

describe('MessageRevisionHistoryCard', () => {
  it('shows the current version and the empty history state', async () => {
    await renderWithProviders(
      <MessageRevisionHistoryCard open message={message} onClose={vi.fn()} />,
    );

    expect(screen.getByText('Current version')).toBeInTheDocument();
    expect(screen.getByText('Current content')).toBeInTheDocument();
    expect(screen.getByText('No previous edits yet.')).toBeInTheDocument();
  });

  it('loads another page and restores a selected revision with CAS', async () => {
    mockHistory([revision], true);
    await renderWithProviders(
      <MessageRevisionHistoryCard open message={message} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier versions' }));
    expect(fetchNextPage).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(mutateAsync).toHaveBeenCalledWith({
      chatId: message.chatId,
      messageId: message.id,
      revisionId: revision.id,
      content: revision.content,
      expectedRevision: message.revision,
    });
  });

  it('shows an inline conflict without removing the selected revision', async () => {
    mockHistory([revision]);
    mutateAsync.mockRejectedValueOnce(
      new ApiError({ code: ErrorCodes.MESSAGE_CONFLICT, params: { currentRevision: 4 } }),
    );
    await renderWithProviders(
      <MessageRevisionHistoryCard open message={message} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(
      await screen.findByText('This message changed elsewhere. Reload the history and try again.'),
    ).toHaveAttribute('role', 'alert');
    expect(screen.getByText('Previous content')).toBeInTheDocument();
  });
});
