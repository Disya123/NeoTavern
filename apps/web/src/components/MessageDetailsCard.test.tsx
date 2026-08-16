/**
 * MessageDetailsCard tests (C3): the mobile message details card —
 * meta rows (Sent/Model/Generation), the horizontal action panel, the pinned
 * Copy / Exclude-Include / Edit footer, the pencil (initialMode='edit') and
 * details flows, save success/rejection, Escape dismissal, focus trapping.
 * PluginMessageActions is passed as a prop and therefore not imported.
 *
 * The Radix Dialog portals its content into document.body, so all card
 * queries target the document, not the render container.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@neotavern/contracts';
import { renderWithProviders } from '../../test/helpers.js';
import { MessageDetailsCard, type MessageDetailsCardProps } from './MessageDetailsCardV2.js';
import type { BuiltinMessageActionId } from './messageActions.js';

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

/** Complete typed generation meta — the safe parser is strict (C1). */
const GENERATION_META = {
  generationId: 'gen-1',
  providerConfigId: 'provider-1',
  providerKind: 'echo',
  providerSource: 'server',
  model: 'echo',
  durationMs: 2500,
  usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
};

const ALL_ACTIONS: readonly BuiltinMessageActionId[] = [
  'context',
  'edit',
  'copy',
  'regenerate',
  'history',
  'checkpoint',
  'branch',
  'delete-checkpoint',
  'delete',
];

/** English labels matching the `en` i18n instance used by renderWithProviders. */
const LABELS: Record<BuiltinMessageActionId, string> = {
  context: 'Exclude from prompt context',
  edit: 'Edit message',
  copy: 'Copy message',
  regenerate: 'Regenerate',
  history: 'Revision history',
  checkpoint: 'Checkpoint',
  branch: 'Branch',
  'delete-checkpoint': 'Remove checkpoint',
  delete: 'Delete message',
  prompt: 'View prompt plan',
};

interface Handlers {
  onClose: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onToggleContext: () => void;
  onHistory: () => void;
  onBuiltinAction: (id: BuiltinMessageActionId) => void;
  onSaveEdit: (content: string) => Promise<void>;
  onViewPromptPlan: (message: Message) => void;
}

function makeHandlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    onClose: vi.fn(() => undefined),
    onEdit: vi.fn(() => undefined),
    onCopy: vi.fn(() => undefined),
    onToggleContext: vi.fn(() => undefined),
    onHistory: vi.fn(() => undefined),
    onBuiltinAction: vi.fn(() => undefined),
    onSaveEdit: vi.fn(async () => undefined),
    onViewPromptPlan: vi.fn(() => undefined),
    ...overrides,
  };
}

async function renderCard(
  overrides: Partial<MessageDetailsCardProps> = {},
  handlers: Handlers = makeHandlers(),
) {
  const rendered = await renderWithProviders(
    <MessageDetailsCard
      open
      initialMode="details"
      message={makeMessage()}
      assistantIdentity={{ name: 'Assistant', avatar: null }}
      canRegenerate
      busy={false}
      actions={ALL_ACTIONS}
      labels={LABELS}
      {...handlers}
      {...overrides}
    />,
  );
  return { rendered, handlers };
}

/** The card renders inside the Radix portal (document.body). */
function cardRoot(): HTMLElement {
  const root = document.body.querySelector('[data-component="message-details-card"]');
  if (!root) throw new Error('message-details-card not found');
  return root as HTMLElement;
}

function footer(): HTMLElement {
  const element = document.body.querySelector('[data-part="details-footer"]');
  if (!element) throw new Error('details-footer not found');
  return element as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe('MessageDetailsCard details mode', () => {
  it('shows Sent/Model/Generation time rows when the meta exists, omits absent rows', async () => {
    const message = makeMessage({
      createdAt: Date.UTC(2026, 4, 12, 14, 30),
      meta: { generation: GENERATION_META, model: 'echo' },
    });
    await renderCard({ message });
    const root = cardRoot();
    expect(root).toHaveAttribute('data-component', 'message-details-card');
    expect(root).toHaveAttribute('data-state', 'details');
    expect(root.querySelector('[data-part="drag-handle"]')).toHaveAttribute(
      'aria-label',
      'Drag down to close',
    );

    const rows = root.querySelectorAll('[data-part="details-meta-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Sent');
    expect(rows[0]!.textContent?.length).toBeGreaterThan('Sent'.length);
    expect(rows[1]).toHaveTextContent('Model');
    expect(rows[1]).toHaveTextContent('echo');
    expect(rows[2]).toHaveTextContent('Generation time');
    expect(rows[2]).toHaveTextContent('2.5s');

    // Header: avatar fallback + author name.
    expect(root.querySelector('[data-part="details-header"]')).not.toBeNull();
    expect(root.querySelector('[data-part="details-avatar"]')).toHaveAttribute(
      'data-state',
      'fallback',
    );
    expect(root.querySelector('[data-part="details-author"]')).toHaveTextContent('Assistant');

    // Rendered content (macro-expanded display text) is shown.
    expect(root.querySelector('[data-part="details-content"]')).toHaveTextContent('A reply.');
  });

  it('hides all meta rows when neither generation nor legacy meta exists', async () => {
    await renderCard({ message: makeMessage({ createdAt: 0, meta: {} }) });
    expect(cardRoot().querySelectorAll('[data-part="details-meta-row"]')).toHaveLength(0);
  });

  it('falls back to the legacy meta.model when meta.generation is absent', async () => {
    await renderCard({ message: makeMessage({ createdAt: 0, meta: { model: 'legacy-model' } }) });
    const rows = cardRoot().querySelectorAll('[data-part="details-meta-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Model');
    expect(rows[0]).toHaveTextContent('legacy-model');
  });

  it('shows the prompt-plan footer action only for messages with a generation run', async () => {
    const onViewPromptPlan = vi.fn(() => undefined);
    // No run id → no prompt action.
    await renderCard({ message: makeMessage({ meta: {} }) }, makeHandlers({ onViewPromptPlan }));
    expect(footer().querySelector('[data-action="prompt"]')).toBeNull();

    cleanup();

    // Run id present → prompt action opens the plan viewer with the message.
    const message = makeMessage({
      meta: { generationRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    await renderCard({ message }, makeHandlers({ onViewPromptPlan }));
    const promptAction = footer().querySelector('[data-action="prompt"]');
    expect(promptAction).not.toBeNull();
    expect(promptAction).toHaveAttribute('aria-label', 'View prompt plan');
    await userEvent.click(promptAction as HTMLElement);
    expect(onViewPromptPlan).toHaveBeenCalledWith(message);
  });

  it('renders the action panel with every available action id and label', async () => {
    await renderCard();
    const panel = document.body.querySelector('[data-part="details-actions"]');
    expect(panel).not.toBeNull();
    const buttons = panel?.querySelectorAll('[data-action]') ?? [];
    const horizontalActions = ALL_ACTIONS.filter((id) => id !== 'copy' && id !== 'edit');
    expect(buttons).toHaveLength(horizontalActions.length);
    for (const id of horizontalActions) {
      const button = panel?.querySelector(`[data-action="${id}"]`);
      expect(button, `missing action ${id}`).not.toBeNull();
      expect(button).toHaveAttribute('aria-label', LABELS[id]);
      expect(button?.querySelector('svg'), `missing icon for ${id}`).not.toBeNull();
    }
    // The panel wraps in message order (C2), not sorted by label.
    const first = panel?.querySelector('[data-action]');
    expect(first).toHaveAttribute('data-action', 'context');
  });

  it('does not render disabled placeholder actions when no plugins are registered', async () => {
    await renderCard();
    const panel = document.body.querySelector('[data-part="details-actions"]');
    expect(panel?.querySelector('[data-component="plugin-message-actions"]')).toBeNull();
  });

  it('pins exactly Copy / + / Edit and keeps Exclude/History in the horizontal row', async () => {
    await renderCard();
    const foot = footer();
    const buttons = foot.querySelectorAll('[data-part="details-footer-action"]') ?? [];
    expect(buttons).toHaveLength(3);
    expect(foot.querySelector('[data-action="copy"]')).toHaveTextContent('Copy');
    expect(foot.querySelector('[data-action="context"]')).toBeNull();
    expect(foot.querySelector('[data-action="history"]')).toBeNull();
    expect(foot.querySelector('[data-action="actions"]')).not.toBeNull();
    expect(foot.querySelector('[data-action="edit"]')).toHaveTextContent('Edit');
    // Never in the footer: delete/regenerate/branch/checkpoint live in the panel.
    for (const id of ['delete', 'regenerate', 'branch', 'checkpoint', 'delete-checkpoint']) {
      expect(foot.querySelector(`[data-action="${id}"]`)).toBeNull();
    }

    // Subset: only the ids present in `actions` render.
    await renderCard({ actions: ['copy', 'edit'] as readonly BuiltinMessageActionId[] });
    const subsetFooter = document.body.querySelectorAll('[data-part="details-footer"]');
    expect(subsetFooter).toHaveLength(2);
    const subset = subsetFooter[1] as HTMLElement;
    expect(subset.querySelectorAll('[data-part="details-footer-action"]')).toHaveLength(3);
    expect(subset.querySelector('[data-action="copy"]')).not.toBeNull();
    expect(subset.querySelector('[data-action="edit"]')).not.toBeNull();
    expect(subset.querySelector('[data-action="context"]')).toBeNull();
  });

  it('reflects excludedFromContext on the horizontal context action', async () => {
    await renderCard();
    const includedButton = document.body.querySelector(
      '[data-part="details-actions"] [data-action="context"]',
    );
    expect(includedButton).toHaveAttribute('aria-pressed', 'false');

    cleanup();
    await renderCard({
      message: makeMessage({ meta: { manualExcluded: true } }),
      // The parent resolves the message-aware label; excluded → include.
      labels: { ...LABELS, context: 'Include in prompt context' },
    });
    const excludedButton = document.body.querySelector(
      '[data-part="details-actions"] [data-action="context"]',
    );
    expect(excludedButton).toHaveAttribute('aria-pressed', 'true');
    expect(excludedButton).toHaveAttribute('aria-label', 'Include in prompt context');
  });

  it('closes the card on Escape', async () => {
    const { handlers } = await renderCard();
    const dialog = screen.getByRole('dialog', { name: 'Message details' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it('closes the sheet after a downward drag on the top handle', async () => {
    const { handlers } = await renderCard();
    const handle = screen.getByRole('button', { name: 'Drag down to close' });
    const down = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(down, {
      button: { value: 0 },
      clientY: { value: 12 },
      pointerId: { value: 1 },
    });
    fireEvent(handle, down);
    const up = new Event('pointerup', { bubbles: true });
    Object.defineProperties(up, { clientY: { value: 92 }, pointerId: { value: 1 } });
    fireEvent(handle, up);
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
});

describe('MessageDetailsCard flows', () => {
  it('opens the grouped action menu from + and returns to details', async () => {
    await renderCard();
    const root = cardRoot();
    await userEvent.click(screen.getByRole('button', { name: 'More message actions' }));
    expect(root).toHaveAttribute('data-state', 'actions');
    expect(root.querySelector('[data-part="details-danger-zone"]')).not.toBeNull();
    expect(root.querySelector('[data-part="details-core-actions"]')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Delete message and all versions' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close message actions' }));
    expect(root).toHaveAttribute('data-state', 'details');
  });

  it('pencil flow: opens in edit mode and Cancel closes the card', async () => {
    const { handlers } = await renderCard({ initialMode: 'edit' });
    const root = cardRoot();
    expect(root).toHaveAttribute('data-state', 'edit');
    expect(root.querySelector('[data-part="details-editor"]')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Edit message' })).toHaveValue('A reply.');
    expect(screen.getByRole('button', { name: 'Confirm edit' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(handlers.onSaveEdit).not.toHaveBeenCalled();
  });

  it('details flow: footer Edit switches to edit mode; Cancel returns to details without closing', async () => {
    const { handlers } = await renderCard();
    await userEvent.click(within(footer()).getByRole('button', { name: 'Edit message' }));
    expect(handlers.onEdit).toHaveBeenCalledOnce();
    const root = cardRoot();
    expect(root).toHaveAttribute('data-state', 'edit');
    expect(root.querySelector('[data-part="details-editor"]')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(root).toHaveAttribute('data-state', 'details');
    expect(root.querySelector('[data-part="details-meta"]')).not.toBeNull();
    expect(root.querySelector('[data-part="details-editor"]')).toBeNull();
  });

  it('confirm edit: saves the trimmed draft and closes the card on success', async () => {
    const { handlers } = await renderCard({ initialMode: 'edit' });
    const textarea = screen.getByRole('textbox', { name: 'Edit message' });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '  New content  ');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm edit' }));
    await waitFor(() => expect(handlers.onSaveEdit).toHaveBeenCalledWith('New content'));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledOnce());
  });

  it('confirm edit: stays open and shows the error when saving rejects', async () => {
    const rejecting = makeHandlers({
      onSaveEdit: vi.fn(async () => {
        throw new Error('MESSAGE_CONFLICT');
      }),
    });
    await renderCard(
      { initialMode: 'edit', editError: 'This message changed elsewhere.' },
      rejecting,
    );
    const textarea = screen.getByRole('textbox', { name: 'Edit message' });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'My draft');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm edit' }));
    await waitFor(() => expect(rejecting.onSaveEdit).toHaveBeenCalledWith('My draft'));
    // Still editing: draft preserved, dialog open, alert visible.
    expect(screen.getByRole('textbox', { name: 'Edit message' })).toHaveValue('My draft');
    expect(rejecting.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('This message changed elsewhere.');
  });

  it('Escape while editing discards the draft and closes the card', async () => {
    const { handlers } = await renderCard({ initialMode: 'edit' });
    const dialog = screen.getByRole('dialog', { name: 'Message details' });
    const textarea = screen.getByRole('textbox', { name: 'Edit message' });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Unsent draft');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(handlers.onSaveEdit).not.toHaveBeenCalled();
  });

  it('resets to initialMode whenever open transitions false → true', async () => {
    const handlers = makeHandlers();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open card
          </button>
          <MessageDetailsCard
            open={open}
            initialMode="details"
            message={makeMessage()}
            canRegenerate
            busy={false}
            actions={ALL_ACTIONS}
            labels={LABELS}
            {...handlers}
            onClose={() => setOpen(false)}
          />
        </>
      );
    }
    await renderWithProviders(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Open card' }));
    expect(screen.getByRole('dialog', { name: 'Message details' })).toBeInTheDocument();

    // Switch to edit mode, close, reopen → back to details.
    await userEvent.click(within(footer()).getByRole('button', { name: 'Edit message' }));
    expect(screen.getByRole('textbox', { name: 'Edit message' })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Message details' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Open card' }));
    expect(screen.getByRole('dialog', { name: 'Message details' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(cardRoot()).toHaveAttribute('data-state', 'details');
  });
});

describe('MessageDetailsCard focus', () => {
  it('keeps Tab focus inside the dialog (Radix focus trap)', async () => {
    await renderCard();
    const dialog = screen.getByRole('dialog', { name: 'Message details' });

    const buttons = [...dialog.querySelectorAll('button')] as HTMLElement[];
    expect(buttons.length).toBeGreaterThan(0);
    buttons[0]?.focus();
    expect(document.activeElement).toBe(buttons[0]);

    // A full cycle of Tab presses must never leave the dialog.
    for (let i = 0; i < buttons.length + 4; i += 1) {
      await userEvent.keyboard('{Tab}');
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
