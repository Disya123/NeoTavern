/**
 * MessageBubble action-bar tests (ST1 message actions): always-visible bar,
 * editor shortcuts + CAS conflict, copy feedback, direct inline actions
 * (no «Ещё» overflow menu), checkpoint flag semantics, the mobile compact
 * header (pencil + ellipsis) wired to the real MessageDetailsCard and the
 * variant pager. PluginMessageActions is mocked so this suite stays
 * decoupled from the sibling SDK work.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@neotavern/contracts';
import { renderWithProviders } from '../../test/helpers.js';
import { MessageBubble } from './MessageBubble.js';

vi.mock('./PluginMessageActions.js', () => ({
  PluginMessageActions: ({ placement }: { placement: string }) => (
    <div data-testid="plugin-message-actions" data-placement={placement} />
  ),
}));

/**
 * Control the `(max-width: 600px)` query the bubble uses to pick the
 * desktop inline row vs the mobile compact header. Default (unstubbed)
 * jsdom matchMedia reports `matches: false` → desktop.
 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    branchId: 'branch-1',
    parentId: null,
    role: 'assistant',
    content: 'A reply.',
    name: null,
    meta: {},
    createdAt: 0,
    revision: 1,
    updatedAt: null,
    variantCount: 1,
    activeVariantPosition: 0,
    contentRevisionCount: 0,
    checkpointChatId: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MessageBubble action bar', () => {
  it('keeps core actions in the header and History/Regenerate in bottom version controls', async () => {
    const onSaveEdit = vi.fn(async () => undefined);
    const onToggleContext = vi.fn(async () => undefined);
    const onCopy = vi.fn(async () => undefined);
    const onRegenerate = vi.fn();
    const onCreateCheckpoint = vi.fn();
    const onDelete = vi.fn(async () => undefined);
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage()}
        onSaveEdit={onSaveEdit}
        onToggleContext={onToggleContext}
        onCopy={onCopy}
        onRegenerate={onRegenerate}
        canRegenerate
        onCreateCheckpoint={onCreateCheckpoint}
        onDelete={onDelete}
      />,
    );
    const bar = rendered.container.querySelector('[data-component="message-action-bar"]');
    const header = rendered.container.querySelector('[data-part="message-header"]');
    expect(bar).not.toBeNull();
    expect(header?.querySelector('[data-component="message-action-bar"]')).toBe(bar);
    // Every available built-in is a direct button in the one inline row.
    for (const id of ['context', 'edit', 'copy', 'checkpoint', 'branch', 'delete']) {
      expect(bar?.querySelector(`[data-action="${id}"]`), `data-action="${id}"`).not.toBeNull();
    }
    expect(bar?.querySelector('[data-action="history"]')).toBeNull();
    expect(bar?.querySelector('[data-action="regenerate"]')).toBeNull();
    const versions = rendered.container.querySelector(
      '[data-component="message-version-controls"]',
    );
    expect(versions?.querySelector('[data-action="history"]')).not.toBeNull();
    expect(versions?.querySelector('[data-action="regenerate"]')).not.toBeNull();
    // No overflow menu anywhere.
    expect(bar?.querySelector('[data-action="more"]')).toBeNull();
    expect(rendered.container.querySelector('[data-part="overflow-menu"]')).toBeNull();
    expect(rendered.container.querySelector('[data-part="message-actions-overflow"]')).toBeNull();
    expect(bar).toHaveAttribute('data-part', 'message-actions-inline');
    // Plugin slot rendered in the single row with the merged 'all' placement.
    const pluginSlot = rendered.container.querySelector('[data-testid="plugin-message-actions"]');
    expect(pluginSlot).toHaveAttribute('data-placement', 'all');
  });

  it('omits the regenerate action when canRegenerate is false', async () => {
    const rendered = await renderWithProviders(
      <MessageBubble message={makeMessage()} onRegenerate={vi.fn()} canRegenerate={false} />,
    );
    expect(
      rendered.container.querySelector(
        '[data-component="message-version-controls"] [data-action="regenerate"]',
      ),
    ).toBeNull();
  });

  it('pending user messages suppress the action bar and carry data-state="pending"', async () => {
    const onSaveEdit = vi.fn(async () => undefined);
    const onDelete = vi.fn(async () => undefined);
    const onCopy = vi.fn(async () => undefined);
    const onToggleContext = vi.fn(async () => undefined);
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage({ role: 'user', content: 'Optimistic text.' })}
        pending
        onSaveEdit={onSaveEdit}
        onDelete={onDelete}
        onCopy={onCopy}
        onToggleContext={onToggleContext}
      />,
    );
    const bubble = rendered.container.querySelector('[data-component="chat-message"]');
    expect(bubble).toHaveAttribute('data-state', 'pending');
    expect(rendered.container.querySelector('[data-component="message-action-bar"]')).toBeNull();
  });

  it('the same user fixture without pending shows the action bar and data-state="done"', async () => {
    const onSaveEdit = vi.fn(async () => undefined);
    const onDelete = vi.fn(async () => undefined);
    const onCopy = vi.fn(async () => undefined);
    const onToggleContext = vi.fn(async () => undefined);
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage({ role: 'user', content: 'Confirmed text.' })}
        onSaveEdit={onSaveEdit}
        onDelete={onDelete}
        onCopy={onCopy}
        onToggleContext={onToggleContext}
      />,
    );
    const bubble = rendered.container.querySelector('[data-component="chat-message"]');
    expect(bubble).toHaveAttribute('data-state', 'done');
    expect(
      rendered.container.querySelector('[data-component="message-action-bar"]'),
    ).not.toBeNull();
    expect(rendered.container.querySelector('[data-action="history"]')).toBeNull();
    expect(
      rendered.container.querySelector('[data-component="message-version-controls"]'),
    ).toBeNull();
  });

  it('renders the checkpoint flag when a checkpoint chat exists', async () => {
    const onOpenCheckpoint = vi.fn();
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage({ checkpointChatId: 'chat-child' })}
        onOpenCheckpoint={onOpenCheckpoint}
        onDeleteCheckpoint={vi.fn(async () => undefined)}
      />,
    );
    expect(
      rendered.container.querySelector(
        '[data-component="message-action-bar"] [data-action="checkpoint"]',
      ),
    ).not.toBeNull();
    expect(
      rendered.container.querySelector(
        '[data-component="message-action-bar"] [data-action="delete-checkpoint"]',
      ),
    ).not.toBeNull();
  });

  it('hides the action bar and streams in place while streaming', async () => {
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage()}
        streaming
        streamingContent="Streaming text"
        onCopy={vi.fn()}
      />,
    );
    expect(rendered.container.querySelector('[data-component="message-action-bar"]')).toBeNull();
    expect(screen.getByText('Streaming text')).toBeInTheDocument();
    const article = rendered.container.querySelector('[data-component="chat-message"]');
    expect(article).toHaveAttribute('data-state', 'streaming');
  });
});

describe('MessageBubble editor', () => {
  it('expands the inline editor to the full message height', async () => {
    await renderWithProviders(<MessageBubble message={makeMessage()} onSaveEdit={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const textarea = screen.getByRole('textbox', { name: 'Edit message' });
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 240 });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Expanded message text');
    await waitFor(() => expect(textarea).toHaveStyle({ height: '240px' }));
  });

  it('saves the edit on Ctrl+Enter', async () => {
    const onSaveEdit = vi.fn(async () => undefined);
    await renderWithProviders(<MessageBubble message={makeMessage()} onSaveEdit={onSaveEdit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const textarea = screen.getByRole('textbox', { name: 'Edit message' });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Edited text');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSaveEdit).toHaveBeenCalledWith('msg-1', 'Edited text'));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull());
  });

  it('cancels the edit on Escape and restores the original content', async () => {
    const onSaveEdit = vi.fn(async () => undefined);
    await renderWithProviders(
      <MessageBubble message={makeMessage({ content: 'Original' })} onSaveEdit={onSaveEdit} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const textarea = screen.getByRole('textbox', { name: 'Edit message' });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Draft');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onSaveEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    expect(screen.getByText('Original')).toBeInTheDocument();
  });

  it('keeps the draft open and shows the conflict text when saving rejects', async () => {
    const onSaveEdit = vi.fn(async () => {
      throw new Error('MESSAGE_CONFLICT');
    });
    const conflictText =
      'This message changed elsewhere. Your draft is kept — review and save again.';
    await renderWithProviders(
      <MessageBubble
        message={makeMessage({ content: 'Original' })}
        onSaveEdit={onSaveEdit}
        editError={conflictText}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const textarea = screen.getByRole('textbox', { name: 'Edit message' });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'My draft');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSaveEdit).toHaveBeenCalled());
    // Still editing, draft preserved, inline error visible.
    expect(screen.getByRole('textbox', { name: 'Edit message' })).toHaveValue('My draft');
    expect(screen.getByText(conflictText)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(conflictText);
  });
});

describe('MessageBubble copy', () => {
  it('invokes onCopy and shows transient copied feedback', async () => {
    const message = makeMessage();
    const onCopy = vi.fn(async () => undefined);
    await renderWithProviders(<MessageBubble message={message} onCopy={onCopy} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(message));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});

describe('MessageBubble inline actions', () => {
  it('runs branch, checkpoint-create and delete as direct buttons (no More menu)', async () => {
    const onCreateCheckpoint = vi.fn();
    const onDelete = vi.fn(async () => undefined);
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage()}
        onCreateCheckpoint={onCreateCheckpoint}
        onDelete={onDelete}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Branch' }));
    expect(onCreateCheckpoint).toHaveBeenCalledWith(makeMessage(), 'branch', false);

    await userEvent.click(screen.getByRole('button', { name: 'Checkpoint' }));
    expect(onCreateCheckpoint).toHaveBeenCalledWith(makeMessage(), 'checkpoint', false);

    await userEvent.click(screen.getByRole('button', { name: 'Delete message' }));
    expect(screen.getByRole('dialog', { name: 'Delete message' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('msg-1'));

    // The single inline plugin slot carries the merged 'all' placement.
    const pluginSlots = rendered.container.querySelectorAll(
      '[data-testid="plugin-message-actions"]',
    );
    expect(pluginSlots).toHaveLength(1);
    expect(pluginSlots[0]).toHaveAttribute('data-placement', 'all');
    expect(rendered.container.querySelector('[data-part="overflow-menu"]')).toBeNull();
  });

  it('removes the checkpoint link through a confirmed dialog from the inline button', async () => {
    const onDeleteCheckpoint = vi.fn(async () => undefined);
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage({ checkpointChatId: 'chat-child' })}
        onDeleteCheckpoint={onDeleteCheckpoint}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove checkpoint' }));
    expect(screen.getByRole('dialog', { name: 'Remove checkpoint' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleteCheckpoint).toHaveBeenCalled());
    expect(rendered.container.querySelector('[data-part="overflow-menu"]')).toBeNull();
  });

  it('rolls the chat back to this message only after the confirm dialog (М5 slice 44)', async () => {
    const onRollbackTo = vi.fn(async () => undefined);
    const rendered = await renderWithProviders(
      <MessageBubble message={makeMessage()} onRollbackTo={onRollbackTo} />,
    );

    const rollbackButton = screen.getByRole('button', { name: 'Roll back to this message' });
    await userEvent.click(rollbackButton);
    expect(screen.getByRole('dialog', { name: 'Roll back to this message' })).toBeInTheDocument();
    expect(onRollbackTo).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Roll back chat' }));
    await waitFor(() => expect(onRollbackTo).toHaveBeenCalledWith(makeMessage()));
    expect(rendered.container.querySelector('[data-part="overflow-menu"]')).toBeNull();
  });
});

describe('MessageBubble checkpoint flag', () => {
  it('opens the checkpoint on plain click and replaces on shift+click', async () => {
    const onOpenCheckpoint = vi.fn();
    const onReplaceCheckpoint = vi.fn();
    const message = makeMessage({ checkpointChatId: 'chat-child' });
    await renderWithProviders(
      <MessageBubble
        message={message}
        onOpenCheckpoint={onOpenCheckpoint}
        onReplaceCheckpoint={onReplaceCheckpoint}
      />,
    );
    const flag = screen.getByRole('button', { name: 'Open checkpoint' });
    await userEvent.click(flag);
    expect(onOpenCheckpoint).toHaveBeenCalledWith(message);
    fireEvent.click(flag, { shiftKey: true });
    expect(onReplaceCheckpoint).toHaveBeenCalledWith(message);
  });
});

describe('MessageBubble mobile compact header', () => {
  it('shows only pencil + ellipsis (no other action buttons) at ≤600px', async () => {
    stubMatchMedia(true);
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage()}
        onSaveEdit={vi.fn(async () => undefined)}
        onToggleContext={vi.fn(async () => undefined)}
        onCopy={vi.fn(async () => undefined)}
        onRegenerate={vi.fn()}
        canRegenerate
        onCreateCheckpoint={vi.fn()}
        onDelete={vi.fn(async () => undefined)}
      />,
    );
    const bar = rendered.container.querySelector('[data-component="message-action-bar"]');
    expect(bar).toHaveAttribute('data-part', 'message-actions-compact');
    expect(screen.getByRole('button', { name: 'Edit message' })).toHaveAttribute(
      'data-action',
      'edit',
    );
    expect(screen.getByRole('button', { name: 'Message details' })).toHaveAttribute(
      'data-action',
      'details',
    );
    for (const id of ['context', 'copy', 'regenerate', 'checkpoint', 'branch', 'delete']) {
      expect(bar?.querySelector(`[data-action="${id}"]`), `data-action="${id}"`).toBeNull();
    }
    expect(rendered.container.querySelector('[data-testid="plugin-message-actions"]')).toBeNull();
    expect(rendered.container.querySelector('[data-part="overflow-menu"]')).toBeNull();
  });

  it('opens the details card from the ellipsis and closes on Escape', async () => {
    stubMatchMedia(true);
    await renderWithProviders(
      <MessageBubble
        message={makeMessage()}
        onDelete={vi.fn(async () => undefined)}
        onCopy={vi.fn(async () => undefined)}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Message details' }));
    const dialog = screen.getByRole('dialog', { name: 'Message details' });
    const card = dialog.querySelector('[data-component="message-details-card"]');
    expect(card).toHaveAttribute('data-state', 'details');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Message details' })).toBeNull();
  });

  it('opens the card in edit mode from the pencil', async () => {
    stubMatchMedia(true);
    await renderWithProviders(
      <MessageBubble message={makeMessage()} onSaveEdit={vi.fn(async () => undefined)} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const dialog = screen.getByRole('dialog', { name: 'Message details' });
    expect(dialog.querySelector('[data-component="message-details-card"]')).toHaveAttribute(
      'data-state',
      'edit',
    );
  });
});

describe('MessageBubble variant pager', () => {
  it('keeps the N/M counter and arrows without the Variants button', async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const rendered = await renderWithProviders(
      <MessageBubble
        message={makeMessage({ content: 'New reply', variantCount: 3, activeVariantPosition: 1 })}
        swipe={{ current: 2, total: 3, onPrevious, onNext }}
      />,
    );

    expect(screen.getByText('2/3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Variants' })).toBeNull();
    expect(
      rendered.container.querySelector('[data-component="message-variant-picker"]'),
    ).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Previous greeting' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next greeting' }));
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });
});
