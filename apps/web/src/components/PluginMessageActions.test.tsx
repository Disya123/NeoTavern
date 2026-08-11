/**
 * PluginMessageActions placement tests (C5): 'primary' and 'overflow' keep
 * their historical grouping; 'all' merges primary + overflow + legacy
 * context-menu items into one row sorted by (order, registrationId) — the
 * surface the desktop message action bar renders since it has no overflow
 * menu anymore.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { PluginUiRegistration } from '../plugins/runtime.js';
import { frontendPluginRuntime } from '../plugins/runtime.js';
import { renderWithProviders } from '../../test/helpers.js';
import { PluginMessageActions } from './PluginMessageActions.js';

function register(
  kind: 'messageActions' | 'contextMenuItems',
  patch: { registrationId: string; definition?: Record<string, unknown> },
): void {
  frontendPluginRuntime.kernelAddRegistration({
    pluginId: 'test.plugin-actions',
    pluginName: 'Plugin Actions',
    registrationId: `reg-${patch.registrationId}`,
    kind,
    definition: {
      id: patch.registrationId,
      title: 'Action',
      ...patch.definition,
    } as PluginUiRegistration['definition'],
  });
}

function messageAction(registrationId: string, definition: Record<string, unknown>): void {
  register('messageActions', {
    registrationId,
    definition: { id: registrationId, title: registrationId, ...definition },
  });
}

function contextMenuItem(registrationId: string, definition: Record<string, unknown>): void {
  register('contextMenuItems', {
    registrationId,
    definition: { id: registrationId, title: registrationId, context: 'message', ...definition },
  });
}

function buttonNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-component="plugin-message-actions"] button')].map(
    (button) => button.getAttribute('aria-label') ?? '',
  );
}

afterEach(() => {
  cleanup();
  // `clear()` only tears down frames; test registrations have no frame, so
  // drop them individually to keep tests isolated.
  for (const registration of frontendPluginRuntime.getSnapshot()) {
    frontendPluginRuntime.kernelRemoveRegistration(registration.registrationId);
  }
});

describe('PluginMessageActions placements', () => {
  it("'primary' renders only primary-placed actions", async () => {
    messageAction('p-one', { placement: 'primary', order: 5 });
    messageAction('o-one', { placement: 'overflow', order: 1 });
    const rendered = await renderWithProviders(
      <PluginMessageActions
        message={{
          id: 'msg-1',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'Hi',
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
        branchId="branch-1"
        placement="primary"
      />,
    );
    expect(buttonNames(rendered.container)).toEqual(['p-one']);
  });

  it("'overflow' renders overflow actions plus legacy context-menu items", async () => {
    messageAction('p-one', { placement: 'primary', order: 5 });
    messageAction('o-one', { placement: 'overflow', order: 1 });
    contextMenuItem('legacy-one', { order: 2 });
    const rendered = await renderWithProviders(
      <PluginMessageActions
        message={{
          id: 'msg-1',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'Hi',
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
        branchId="branch-1"
        placement="overflow"
      />,
    );
    expect(buttonNames(rendered.container)).toEqual(['o-one', 'legacy-one']);
  });

  it("'all' merges primary, overflow and legacy items into one row sorted by (order, registrationId)", async () => {
    // Same order value → registrationId decides; primary/overflow interleave.
    messageAction('p-alpha', { placement: 'primary', order: 10 });
    messageAction('o-beta', { placement: 'overflow', order: 10 });
    contextMenuItem('legacy-gamma', { order: 10 });
    messageAction('p-zero', { placement: 'primary', order: 1 });
    const rendered = await renderWithProviders(
      <PluginMessageActions
        message={{
          id: 'msg-1',
          chatId: 'chat-1',
          branchId: 'branch-1',
          parentId: null,
          role: 'assistant',
          content: 'Hi',
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
        branchId="branch-1"
        placement="all"
      />,
    );
    const rows = rendered.container.querySelectorAll('[data-component="plugin-message-actions"]');
    expect(rows).toHaveLength(1);
    expect(buttonNames(rendered.container)).toEqual([
      'p-zero',
      'legacy-gamma',
      'o-beta',
      'p-alpha',
    ]);
  });

  it('renders inline, circle and list host variants without changing registrations', async () => {
    messageAction('shape-action', { placement: 'primary', title: 'Shape action' });
    const actionMessage = {
      id: 'msg-shape',
      chatId: 'chat-1',
      branchId: 'branch-1',
      parentId: null,
      role: 'assistant' as const,
      content: 'Hi',
      name: null,
      meta: {},
      createdAt: 0,
      revision: 1,
      updatedAt: null,
      variantCount: 0,
      activeVariantPosition: null,
      contentRevisionCount: 0,
      checkpointChatId: null,
    };

    const rendered = await renderWithProviders(
      <div>
        <PluginMessageActions message={actionMessage} branchId="branch-1" placement="all" />
        <PluginMessageActions
          message={actionMessage}
          branchId="branch-1"
          placement="all"
          variant="circle"
        />
        <PluginMessageActions
          message={actionMessage}
          branchId="branch-1"
          placement="all"
          variant="list"
        />
      </div>,
    );

    expect(
      [...rendered.container.querySelectorAll('[data-component="plugin-message-actions"]')].map(
        (row) => row.getAttribute('data-variant'),
      ),
    ).toEqual(['inline', 'circle', 'list']);
    expect(rendered.getByText('Shape action')).toBeInTheDocument();
  });
});
