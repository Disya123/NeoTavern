/** Frontend component tests (jsdom + Testing Library). */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { Button, ErrorBoundary, Switch } from '@neotavern/ui';
import { renderWithProviders } from '../../test/helpers.js';
import type { kernel } from '@neotavern/plugin-sdk';
import { attachBlocks } from '../plugins/kernel/blocks.js';
import type { KernelHostContext } from '../plugins/kernel/types.js';
import { MessageBubble } from './MessageBubble.js';
import { DataMigrationPanel } from './DataMigrationPanel.js';
import { AuthGate } from './AuthGate.js';
import { CharacterManagementPanel } from './CharacterManagementPanel.js';
import { ChatComposer } from './ChatComposer.js';
import { setCsrfToken } from '../api/client.js';
import { useUiStore } from '../state/ui.js';

// The action bar delegates plugin actions to the merged 'all' placement and
// the mobile card is a sibling deliverable; both are inert for these tests.
vi.mock('./PluginMessageActions.js', () => ({
  PluginMessageActions: () => <div data-testid="plugin-message-actions" />,
}));
vi.mock('./MessageDetailsCardV2.js', () => ({
  MessageDetailsCard: () => null,
}));

function Boom(): ReactElement {
  throw new Error('boom');
}

describe('Button', () => {
  it('exposes variant via a data hook', () => {
    render(<Button variant="primary">Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).toHaveAttribute('data-component', 'button');
    expect(button).toHaveAttribute('data-variant', 'primary');
  });

  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Tap</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Tap' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('ChatComposer', () => {
  it('keeps compact toolbar and submit actions named when visible labels are hidden', async () => {
    const rendered = await renderWithProviders(
      <ChatComposer
        textareaId="composer-test"
        value=""
        placeholder="Write"
        inputRef={{ current: null }}
        onChange={() => undefined}
        onKeyDown={() => undefined}
        onOpenSettings={() => undefined}
        onReset={() => undefined}
        contextPanelId="context-test"
        contextOpen={false}
        contextTriggerTitle="Context"
        contextTriggerLabel="0 tokens"
        onToggleContext={() => undefined}
        onSubmit={() => undefined}
        submitDisabled
      />,
    );

    const settingsButtons = screen.getAllByRole('button', { name: 'Settings' });
    expect(settingsButtons).toHaveLength(2);
    expect(settingsButtons[0]).toHaveAttribute('aria-label', 'Settings');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-label', 'Send');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('data-action', 'send');
    expect(
      rendered.container.querySelector(
        '[data-slot="chat.composer"] [data-part="field"] [data-component="textarea"]',
      ),
    ).not.toBeNull();
    expect(
      rendered.container.querySelector('[data-slot="chat.composer"] [data-part="toolbar"]'),
    ).not.toBeNull();
  });
});

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary name="test">
        <div>all good</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('renders a fallback when a child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary name="test" fallback={(error) => <div>caught: {error.message}</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('caught: boom')).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('Switch', () => {
  it('toggles checked state', async () => {
    const onChange = vi.fn();
    render(<Switch aria-label="toggle" onCheckedChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'toggle' });
    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('MessageBubble', () => {
  it('renders the assistant identity as part of the message', async () => {
    await renderWithProviders(
      <MessageBubble
        message={{
          id: 'message-greeting',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'Welcome to Eldoria.',
          name: null,
          meta: { greeting: true },
          createdAt: 0,
          revision: 1,
          updatedAt: null,
          variantCount: 0,
          activeVariantPosition: null,
          contentRevisionCount: 0,
          checkpointChatId: null,
        }}
        assistantIdentity={{
          name: 'Seraphina',
          avatar: '/avatars/seraphina.png',
        }}
      />,
    );

    const message = screen.getByRole('article', { name: 'Seraphina' });
    expect(within(message).getByText('Seraphina')).toBeInTheDocument();
    expect(message.querySelectorAll('img')).toHaveLength(2);
    expect(message.querySelector('[data-part="message-avatar"] img')).toHaveAttribute(
      'src',
      '/avatars/seraphina.png',
    );
    expect(message.querySelector('[data-part="message-art"] img')).toHaveAttribute(
      'src',
      '/avatars/seraphina.png',
    );
    expect(message.querySelector('[data-part="message-frame"]')).toBeInTheDocument();
    const header = message.querySelector('[data-part="message-header"]');
    const content = message.querySelector('[data-part="message-content"]');
    expect(header).toBeInTheDocument();
    expect(content).toBeInTheDocument();
    if (!header || !content) throw new Error('Expected message header and content');
    expect(header.compareDocumentPosition(content)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(message).getByText('Welcome to Eldoria.')).toBeInTheDocument();
  });

  it('renders a localized timestamp in the stable message header', async () => {
    await renderWithProviders(
      <MessageBubble
        message={{
          id: 'message-dated',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'A dated reply.',
          name: 'Seraphina',
          meta: {},
          createdAt: Date.UTC(2026, 6, 30, 12, 5),
          revision: 1,
          updatedAt: null,
          variantCount: 0,
          activeVariantPosition: null,
          contentRevisionCount: 0,
          checkpointChatId: null,
        }}
      />,
    );

    const timestamp = screen.getByText(/Jul.*30.*2026/u);
    expect(timestamp.tagName).toBe('TIME');
    expect(timestamp).toHaveAttribute('data-part', 'message-timestamp');
    expect(timestamp).toHaveAttribute('dateTime', '2026-07-30T12:05:00.000Z');
  });

  it('highlights chat-search matches inside a message', async () => {
    const rendered = await renderWithProviders(
      <MessageBubble
        message={{
          id: 'message-search',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'Forest paths lead deeper into the forest.',
          name: null,
          meta: {},
          createdAt: 0,
          revision: 1,
          updatedAt: null,
          variantCount: 0,
          activeVariantPosition: null,
          contentRevisionCount: 0,
          checkpointChatId: null,
        }}
        searchQuery="forest"
      />,
    );

    expect(rendered.container.querySelectorAll('mark')).toHaveLength(2);
  });

  it('toggles manual prompt-context exclusion accessibly', async () => {
    const onToggleContext = vi.fn(async () => undefined);
    await renderWithProviders(
      <MessageBubble
        message={{
          id: 'message-1',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'user',
          content: 'Remember this',
          name: null,
          meta: {},
          createdAt: 0,
          revision: 1,
          updatedAt: null,
          variantCount: 0,
          activeVariantPosition: null,
          contentRevisionCount: 0,
          checkpointChatId: null,
        }}
        onToggleContext={onToggleContext}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Exclude from prompt context' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(onToggleContext).toHaveBeenCalledOnce();
  });

  it('confirms before deleting a message (inline delete button)', async () => {
    const onDelete = vi.fn(async () => undefined);
    const rendered = await renderWithProviders(
      <MessageBubble
        message={{
          id: 'message-2',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'A reply',
          name: null,
          meta: {},
          createdAt: 0,
          revision: 1,
          updatedAt: null,
          variantCount: 0,
          activeVariantPosition: null,
          contentRevisionCount: 0,
          checkpointChatId: null,
        }}
        onDelete={onDelete}
      />,
    );
    await userEvent.click(
      within(rendered.container).getByRole('button', { name: 'Delete message' }),
    );
    expect(screen.getByRole('dialog', { name: 'Delete message' })).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('renders the plugin-blocks slot only when blocks are attached', async () => {
    await renderWithProviders(
      <MessageBubble
        message={{
          id: 'message-no-blocks',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'No blocks here.',
          name: null,
          meta: {},
          createdAt: 0,
          revision: 1,
          updatedAt: null,
          variantCount: 0,
          activeVariantPosition: null,
          contentRevisionCount: 0,
          checkpointChatId: null,
        }}
      />,
    );
    expect(document.querySelector('[data-part="plugin-blocks"]')).toBeNull();
  });

  it('mounts attached plugin blocks inside the message', async () => {
    const handlers = new Map<string, (ctx: { params: unknown }) => unknown>();
    const fakeSession = {
      handle: (method: string, handler: (ctx: { params: unknown }) => unknown) => {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
      call: async () => ({}),
      isDisposed: false,
      scope: { track: () => undefined },
    };
    const ctx: KernelHostContext = {
      pluginId: 'plugin.ui',
      frame: { plugin: { name: 'UI Plugin' } } as unknown as KernelHostContext['frame'],
      session: fakeSession as unknown as kernel.KernelSession,
      runtime: {
        kernelAddRegistration: () => undefined,
        kernelRemoveRegistration: () => undefined,
        mountPage: () => () => undefined,
        onAppEvent: () => () => undefined,
      } as unknown as KernelHostContext['runtime'],
      hasCapability: () => true,
      currentChatId: () => 'chat-1',
      currentProviderId: () => null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body =
        init?.body != null ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (url.startsWith('/api/v2/chats/chat-1/messages/')) {
        return new Response(
          JSON.stringify({
            id: 'blk-attached',
            messageId: body?.['messageId'] ?? '',
            pluginId: 'plugin.ui',
            blockType: String(body?.['blockType']),
            rendererId: String(body?.['rendererId']),
            descriptor: body?.['descriptor'] ?? {},
            createdAt: 1,
            updatedAt: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/v2/chats/chat-1/blocks')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    attachBlocks(ctx);
    const invoke = (method: string, params: unknown): unknown =>
      (handlers.get(method) as (ctx: { params: unknown }) => unknown)({ params });
    await invoke('blocks.registerRenderer', { blockType: 'uiMeter', title: 'Meter' });
    await invoke('blocks.attach', {
      messageId: 'message-with-blocks',
      blockType: 'uiMeter',
      descriptor: { value: 1 },
    });

    const rendered = await renderWithProviders(
      <MessageBubble
        message={{
          id: 'message-with-blocks',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'With blocks.',
          name: null,
          meta: {},
          createdAt: 0,
          revision: 1,
          updatedAt: null,
          variantCount: 0,
          activeVariantPosition: null,
          contentRevisionCount: 0,
          checkpointChatId: null,
        }}
      />,
    );
    const part = rendered.container.querySelector('[data-part="plugin-blocks"]');
    expect(part).not.toBeNull();
    await waitFor(() => expect(part?.querySelector('[data-part="plugin-block"]')).not.toBeNull());
    rendered.unmount();
  });
});

describe('CharacterManagementPanel', () => {
  it('edits ST1 character fields and exposes the real gallery section', async () => {
    // full-suite parallel load); the default 5 s budget is routinely blown. // Heavy component test (list + viewer + gallery + edit flows under
    const character = {
      id: '018f0000-0000-7000-8000-000000000401',
      name: 'Seraphina',
      avatar: null,
      description: 'Forest guardian',
      personality: 'Caring',
      scenario: 'A woodland cottage',
      firstMessage: 'You wake with a start.',
      exampleDialogues: '',
      systemPrompt: null,
      postHistoryInstructions: null,
      creator: 'Fixture',
      creatorNotes:
        '<style>.authored-card { color: teal; }</style><article class="authored-card">Authored card</article><script>alert(1)</script>',
      tags: ['fantasy'],
      ext: {
        alternateGreetings: ['Welcome back.'],
        characterVersion: '1.0',
      },
      createdAt: 1,
      updatedAt: 2,
      lastUsedAt: null,
      deletedAt: null,
    };
    let patchBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v2/characters?')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: character.id,
                name: character.name,
                avatar: character.avatar,
                description: character.description,
                tags: character.tags,
                createdAt: character.createdAt,
                updatedAt: character.updatedAt,
              },
            ],
            nextCursor: null,
            hasMore: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith(`/api/v2/characters/${character.id}/gallery?sort=oldest`)) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith(`/api/v2/characters/${character.id}`) && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...character, ...patchBody, updatedAt: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith(`/api/v2/characters/${character.id}`)) {
        return new Response(JSON.stringify(character), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      useUiStore.setState({ pinnedCharacterId: null });
      const rendered = await renderWithProviders(
        <CharacterManagementPanel onClose={() => undefined} />,
      );
      const panel = within(rendered.container);
      expect(panel.getByText('Character Management')).toBeInTheDocument();
      expect(panel.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'Cards',
        'Edit',
        'Advanced',
        'Gallery',
      ]);

      const seraphinaCard = await panel.findByRole('button', { name: /Seraphina/ });
      expect(seraphinaCard).toHaveAttribute('data-part', 'character-card');
      expect(seraphinaCard).toHaveAttribute('data-name', 'Seraphina');
      await userEvent.click(seraphinaCard);
      const viewer = await panel.findByTitle('Read-only card for Seraphina');
      expect(viewer).toHaveAttribute('sandbox', 'allow-same-origin');
      expect(viewer).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(viewer.getAttribute('srcdoc')).toContain('Authored card');
      expect(viewer.getAttribute('srcdoc')).not.toContain('<script');
      expect(panel.queryByLabelText('Name')).not.toBeInTheDocument();
      expect(
        rendered.container.querySelector('[data-part="character-viewer-identity"]'),
      ).not.toBeNull();
      expect(panel.getByText('fantasy', { exact: true })).toBeInTheDocument();
      const description = rendered.container.querySelector(
        '[data-part="character-viewer-description"]',
      );
      expect(description).not.toHaveAttribute('open');
      await userEvent.click(panel.getByText('Description', { exact: true }));
      expect(panel.getByText('Forest guardian')).toBeInTheDocument();
      const greetings = rendered.container.querySelector(
        '[data-part="character-viewer-greetings"]',
      );
      expect(greetings).not.toHaveAttribute('open');
      await userEvent.click(panel.getByText('Greetings', { exact: true }));
      expect(panel.getByText('First message', { exact: true })).toBeInTheDocument();
      expect(panel.getByText('Alternate Greeting 1', { exact: true })).toBeInTheDocument();
      const firstGreeting = rendered.container.querySelector(
        '[data-part="character-viewer-greeting"]',
      );
      expect(firstGreeting).not.toHaveAttribute('open');
      await userEvent.click(panel.getByText('First message', { exact: true }));
      expect(panel.getByText('You wake with a start.')).toBeInTheDocument();
      const greetingItems = rendered.container.querySelectorAll(
        '[data-part="character-viewer-greeting"]',
      );
      expect(greetingItems[1]).not.toHaveAttribute('open');
      await userEvent.click(panel.getByText('Alternate Greeting 1', { exact: true }));
      expect(greetingItems[1]).toHaveAttribute('open');
      expect(panel.getByText('Welcome back.')).toBeInTheDocument();
      await userEvent.click(panel.getByRole('button', { name: 'Edit character card' }));
      expect(await panel.findByLabelText('Name')).toHaveValue('Seraphina');
      await userEvent.click(panel.getByRole('button', { name: /Greeting 1/ }));
      expect(await panel.findByLabelText(/^Greeting 1/)).toHaveValue('Welcome back.');
      expect(panel.getByRole('button', { name: /Greeting 1.*tokens/ })).toHaveTextContent(
        '≈ 4 tokens',
      );
      expect(panel.queryByText('Empty greeting')).not.toBeInTheDocument();
      await userEvent.click(panel.getByRole('button', { name: 'Add' }));
      await userEvent.type(await panel.findByLabelText(/^Greeting 2/), 'A second welcome.');
      expect(panel.queryByLabelText(/^Greeting 1/)).not.toBeInTheDocument();
      expect(panel.getAllByRole('button', { name: 'Delete character' })).toHaveLength(1);

      const tagInput = panel.getByLabelText('New tag');
      await userEvent.type(tagInput, 'healing{Enter}');
      expect(tagInput).toHaveValue('');
      expect(panel.getByText('healing')).toBeInTheDocument();

      await userEvent.click(panel.getByLabelText('Export character card'));
      expect(await screen.findByRole('menuitem', { name: /PNG/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /JSON/ })).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menuitem', { name: /PNG/ })).not.toBeInTheDocument();

      await userEvent.click(panel.getByRole('tab', { name: 'Advanced' }));
      await userEvent.click(panel.getByText('Prompt Overrides'));
      await userEvent.type(panel.getByLabelText(/^System prompt/), 'Stay in character.');

      await waitFor(() => {
        expect(patchBody).toMatchObject({
          name: 'Seraphina',
          systemPrompt: 'Stay in character.',
          tags: ['fantasy', 'healing'],
          ext: {
            alternateGreetings: ['Welcome back.', 'A second welcome.'],
            characterVersion: '1.0',
            depthPrompt: { prompt: '', depth: 4, role: 'system' },
            talkativeness: 0.5,
          },
        });
      });

      await userEvent.click(panel.getByRole('tab', { name: 'Gallery' }));
      const galleryHeading = panel.getByRole('heading', { name: 'Image Gallery' });
      const galleryControls = rendered.container.querySelector('[data-part="gallery-controls"]');
      expect(galleryControls).not.toBeNull();
      expect(
        galleryHeading.compareDocumentPosition(galleryControls as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect((await panel.findAllByRole('button', { name: 'Add image' })).length).toBeGreaterThan(
        0,
      );
      const columnSelect = panel.getByLabelText('Gallery columns');
      expect(columnSelect).toHaveValue('3');
      await userEvent.selectOptions(columnSelect, '2');
      expect(columnSelect).toHaveValue('2');
      expect(panel.getByText('No gallery images')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it('selects a ZIP through a labelled control before analysis', async () => {
    await renderWithProviders(<DataMigrationPanel />);

    const input = screen.getByLabelText('Choose ZIP');
    const archive = new File(['PK\u0003\u0004'], 'sillytavern-data.zip', {
      type: 'application/zip',
    });
    await userEvent.upload(input, archive);

    expect(screen.getByText('sillytavern-data.zip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze archive' })).toBeEnabled();
  });

  it('reviews categories and sends an explicit conflict policy before import', async () => {
    const categories = ['characters', 'chats', 'personas', 'lorebooks', 'presets'].map(
      (id, index) => ({
        id,
        discovered: index === 0 ? 1 : 0,
        dependentRecords: 0,
        invalid: 0,
        conflicts: index === 0 ? 1 : 0,
        sizeBytes: index === 0 ? 1024 : 0,
      }),
    );
    const counts = Object.fromEntries(
      [
        'characters',
        'chats',
        'messages',
        'personas',
        'lorebooks',
        'loreEntries',
        'presets',
        'groups',
        'backgrounds',
        'extensionSettings',
        'apiSettings',
        'legacyExtensions',
        'themes',
      ].map((key) => [key, { imported: key === 'characters' ? 1 : 0, reused: 0, skipped: 0 }]),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/imports/sillytavern/analyze')) {
        return new Response(
          JSON.stringify({
            analysisId: '018f0000-0000-7000-8000-000000000301',
            sourceHash: 'a'.repeat(64),
            sourceName: 'review.zip',
            expiresAt: Date.now() + 60_000,
            archiveAlreadyImported: false,
            totalCompressedBytes: 2048,
            totalExpandedBytes: 4096,
            categories,
            conflictCount: 1,
            conflicts: [],
            warningCount: 0,
            warnings: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        categories: ['characters'],
        conflictPolicy: 'copy',
      });
      return new Response(
        JSON.stringify({
          jobId: '018f0000-0000-7000-8000-000000000302',
          sourceHash: 'a'.repeat(64),
          sourceName: 'review.zip',
          safetyBackupId: 'pre-import-test',
          reusedArchive: false,
          selectedCategories: ['characters'],
          conflictPolicy: 'copy',
          counts,
          warningCount: 0,
          warnings: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const rendered = await renderWithProviders(<DataMigrationPanel />);
      const panel = within(rendered.container);
      await userEvent.upload(
        panel.getByLabelText('Choose ZIP'),
        new File(['PK\u0003\u0004'], 'review.zip', { type: 'application/zip' }),
      );
      await userEvent.click(panel.getByRole('button', { name: 'Analyze archive' }));
      expect(await panel.findByText('Archive analysis is ready')).toBeInTheDocument();
      expect(panel.getByRole('checkbox', { name: /Characters/ })).toBeChecked();
      expect(panel.getByRole('checkbox', { name: /Solo chats/ })).toBeDisabled();
      await userEvent.click(panel.getByRole('radio', { name: /Create copies/ }));
      await userEvent.click(panel.getByRole('button', { name: 'Back up and import' }));
      expect(await panel.findByText('Migration complete')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AuthGate', () => {
  it('shows local mode immediately after the public session check', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ required: false, authenticated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      setCsrfToken(null);
      const rendered = await renderWithProviders(
        <AuthGate>
          <div>Private application</div>
        </AuthGate>,
      );
      expect(
        await within(rendered.container).findByText('Private application'),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps only the app shell visible when the session check fails offline', async () => {
    const onlineSpy = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new TypeError('Offline')),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const rendered = await renderWithProviders(
        <AuthGate>
          <div>Cached application shell</div>
        </AuthGate>,
      );
      const gate = within(rendered.container);
      expect(await gate.findByText('Offline · app shell only')).toHaveAttribute('role', 'status');
      expect(gate.getByText('Cached application shell')).toBeInTheDocument();
      expect(
        gate.queryByRole('heading', { name: 'Enter your access token' }),
      ).not.toBeInTheDocument();
      const mutating = fetchMock.mock.calls.filter(([, init]) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        return method !== 'GET' && method !== 'HEAD';
      });
      expect(mutating).toEqual([]);
    } finally {
      onlineSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('exchanges a remote token for an in-memory CSRF session without web storage', async () => {
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return new Response(JSON.stringify({ required: true, authenticated: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(JSON.parse(String(init.body))).toEqual({ token: 'remote-secret' });
      return new Response(
        JSON.stringify({
          required: true,
          authenticated: true,
          expiresAt: Date.now() + 60_000,
          csrfToken: 'c'.repeat(43),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      setCsrfToken(null);
      const rendered = await renderWithProviders(
        <AuthGate>
          <div>Authenticated application</div>
        </AuthGate>,
      );
      const gate = within(rendered.container);
      expect(await gate.findByRole('heading', { name: 'Enter your access token' })).toBeVisible();
      await userEvent.type(gate.getByLabelText('Access token'), 'remote-secret');
      await userEvent.click(gate.getByRole('button', { name: 'Open NeoTavern' }));
      expect(await gate.findByText('Authenticated application')).toBeInTheDocument();
      expect(storageSpy).not.toHaveBeenCalled();
    } finally {
      storageSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
